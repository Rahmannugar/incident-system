package gateway

import (
	"context"
	"strings"

	inventoryv1 "github.com/Rahmannugar/incident-system/packages/contracts/gen/go/incident/inventory/v1"
	orderv1 "github.com/Rahmannugar/incident-system/packages/contracts/gen/go/incident/order/v1"
	paymentv1 "github.com/Rahmannugar/incident-system/packages/contracts/gen/go/incident/payment/v1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

type SettlementService struct {
	orders                                   orderv1.OrderServiceClient
	inventory                                inventoryv1.InventoryServiceClient
	payments                                 paymentv1.PaymentServiceClient
	orderToken, paymentToken, inventoryToken string
}

func serviceContext(ctx context.Context, token, requestID string) context.Context {
	return metadata.NewOutgoingContext(ctx, metadata.Pairs("x-service-token", token, "x-request-id", requestID))
}
func invalidDependency() error {
	return status.Error(codes.Unavailable, "Invalid settlement dependency response")
}
func refundComplete(refund *paymentv1.Refund, payment *paymentv1.Payment) bool {
	return refund != nil && refund.PaymentId == payment.Id && refund.AmountMinor == payment.AmountMinor && refund.Currency == payment.Currency && refund.ProviderReference != "" && refund.CompletedAtUnixMs > 0
}
func reservationMatches(reservation *inventoryv1.Reservation, order *orderv1.Order) bool {
	return reservation != nil && reservation.OrderId == order.Id && reservation.Sku == order.Sku && reservation.Quantity == order.Quantity && reservation.ExpiresAtUnixMs > 0
}
func (s *SettlementService) Process(ctx context.Context, event PaymentEvent, payloadHash string) error {
	if event.Data.Late == nil {
		return status.Error(codes.InvalidArgument, "Invalid payment event")
	}
	paymentCtx := serviceContext(ctx, s.paymentToken, event.RequestID)
	canonical, err := s.payments.GetPaymentForSettlement(paymentCtx, &paymentv1.GetPaymentForSettlementRequest{OrderId: event.Data.OrderID})
	if err != nil {
		return err
	}
	payment := canonical.GetPayment()
	// A valid transport signature does not prove a financial fact. Compare all
	// outcome fields with Payment's immutable record before any fulfillment effect.
	if payment == nil {
		return invalidDependency()
	}
	if payment.Id != event.Data.PaymentID || payment.OrderId != event.Data.OrderID || payment.Status != strings.TrimPrefix(event.Type, "payment.") || payment.AmountMinor != event.Data.AmountMinor || payment.Currency != event.Data.Currency || payment.ReservationExpiresAtUnixMs != event.Data.ReservationExpiresAt.UnixMilli() || payment.UpdatedAtUnixMs != event.OccurredAt.UnixMilli() || payment.Late != *event.Data.Late {
		return status.Error(codes.FailedPrecondition, "Payment event does not match the stored outcome")
	}
	if canonical.Refund != nil && (payment.Status != "succeeded" || !refundComplete(canonical.Refund, payment)) {
		return invalidDependency()
	}
	orderCtx := serviceContext(ctx, s.orderToken, event.RequestID)
	prepared, err := s.orders.PrepareOrderSettlement(orderCtx, &orderv1.PrepareOrderSettlementRequest{Id: event.Data.OrderID, EventId: event.ID, PayloadHash: payloadHash})
	if err != nil {
		return err
	}
	order := prepared.GetOrder()
	if order == nil || order.Id != event.Data.OrderID || order.Sku == "" || order.Quantity < 1 || order.Quantity > 1000 {
		return invalidDependency()
	}
	target := "failed"
	if payment.Status == "succeeded" {
		target = "confirmed"
	}
	if canonical.Refund != nil {
		target = "refunded"
	}
	if order.Status == "refunded" && canonical.Refund == nil && payment.Status == "succeeded" {
		// Another delivery may have completed compensation after our first read.
		refreshed, readErr := s.payments.GetPaymentForSettlement(paymentCtx, &paymentv1.GetPaymentForSettlementRequest{OrderId: order.Id})
		if readErr != nil {
			return readErr
		}
		if !refundComplete(refreshed.GetRefund(), payment) {
			return invalidDependency()
		}
		target = "refunded"
	}
	if order.Status != "pending" {
		if prepared.PaymentId != payment.Id || order.Status != target {
			return status.Error(codes.FailedPrecondition, "Conflicting final order")
		}
	} else if canonical.Refund == nil {
		inventoryCtx := serviceContext(ctx, s.inventoryToken, event.RequestID)
		if payment.Status == "failed" {
			released, releaseErr := s.inventory.Release(inventoryCtx, &inventoryv1.ReleaseRequest{OrderId: order.Id, Sku: order.Sku})
			if releaseErr != nil {
				return releaseErr
			}
			if !reservationMatches(released.GetReservation(), order) || (released.Reservation.State != "released" && released.Reservation.State != "expired") {
				return invalidDependency()
			}
		} else {
			committed, commitErr := s.inventory.Commit(inventoryCtx, &inventoryv1.CommitRequest{OrderId: order.Id, Sku: order.Sku})
			if commitErr == nil {
				if !reservationMatches(committed.GetReservation(), order) || committed.Reservation.State != "committed" {
					return invalidDependency()
				}
			} else {
				// Only a positively observed expired/released hold triggers compensation.
				// Transport errors, timeouts and missing/corrupt state remain retryable.
				if status.Code(commitErr) != codes.FailedPrecondition {
					return commitErr
				}
				current, readErr := s.inventory.GetReservation(inventoryCtx, &inventoryv1.GetReservationRequest{OrderId: order.Id, Sku: order.Sku})
				if readErr != nil {
					return readErr
				}
				if !reservationMatches(current.GetReservation(), order) || (current.Reservation.State != "expired" && current.Reservation.State != "released") {
					return invalidDependency()
				}
				refunded, refundErr := s.payments.RefundPayment(paymentCtx, &paymentv1.RefundPaymentRequest{PaymentId: payment.Id, OrderId: order.Id})
				if refundErr != nil {
					return refundErr
				}
				if !refundComplete(refunded.GetRefund(), payment) {
					return invalidDependency()
				}
				target = "refunded"
			}
		}
	}
	finalized, err := s.orders.FinalizeOrder(orderCtx, &orderv1.FinalizeOrderRequest{Id: order.Id, EventId: event.ID, PayloadHash: payloadHash, PaymentId: payment.Id, Status: target})
	if err != nil {
		return err
	}
	if result := finalized.GetOrder(); result == nil || result.Id != order.Id || result.Status != target {
		return invalidDependency()
	}
	return nil
}
