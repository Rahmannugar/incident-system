package gateway

import (
	"net/http"
	"strings"
	"time"

	paymentv1 "github.com/Rahmannugar/incident-system/packages/contracts/gen/go/incident/payment/v1"
	"google.golang.org/grpc/metadata"
)

type paymentResponse struct {
	ID                   string    `json:"id"`
	OrderID              string    `json:"order_id"`
	AmountMinor          int64     `json:"amount_minor"`
	Currency             string    `json:"currency"`
	Status               string    `json:"status"`
	ReservationExpiresAt time.Time `json:"reservation_expires_at"`
	CreatedAt            time.Time `json:"created_at"`
	UpdatedAt            time.Time `json:"updated_at"`
	Late                 bool      `json:"late"`
}

func (a *API) initiatePayment(w http.ResponseWriter, r *http.Request) { a.orderPayment(w, r, true) }
func (a *API) getPayment(w http.ResponseWriter, r *http.Request)      { a.orderPayment(w, r, false) }
func (a *API) orderPayment(w http.ResponseWriter, r *http.Request, initiate bool) {
	if !bearerAuthorization(w, r) {
		return
	}
	ctx, cancel := a.callContext(r)
	defer cancel()
	ctx = metadata.AppendToOutgoingContext(ctx, "authorization", r.Header.Get("Authorization"))
	var payment *paymentv1.Payment
	if initiate {
		response, err := a.payments.InitiatePayment(ctx, &paymentv1.InitiatePaymentRequest{OrderId: r.PathValue("id")})
		if err != nil {
			a.rpcFailure(w, r, "payment.initiate", err)
			return
		}
		payment = response.GetPayment()
	} else {
		response, err := a.payments.GetPayment(ctx, &paymentv1.GetPaymentRequest{OrderId: r.PathValue("id")})
		if err != nil {
			a.rpcFailure(w, r, "payment.get", err)
			return
		}
		payment = response.GetPayment()
	}
	if payment == nil || payment.Id == "" || !strings.EqualFold(payment.OrderId, r.PathValue("id")) || payment.AmountMinor < 1 || len(payment.Currency) != 3 || payment.ReservationExpiresAtUnixMs <= 0 || payment.CreatedAtUnixMs <= 0 || payment.UpdatedAtUnixMs <= 0 || (payment.Status != "pending" && payment.Status != "succeeded" && payment.Status != "failed") {
		reject(w, 502, "invalid_upstream_response", "Payment returned an invalid response")
		return
	}
	write(w, 200, paymentResponse{ID: payment.Id, OrderID: payment.OrderId, AmountMinor: payment.AmountMinor, Currency: payment.Currency, Status: payment.Status, ReservationExpiresAt: time.UnixMilli(payment.ReservationExpiresAtUnixMs).UTC(), CreatedAt: time.UnixMilli(payment.CreatedAtUnixMs).UTC(), UpdatedAt: time.UnixMilli(payment.UpdatedAtUnixMs).UTC(), Late: payment.Late})
}
