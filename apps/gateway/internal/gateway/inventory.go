package gateway

import (
	"net/http"
	"time"

	inventoryv1 "github.com/Rahmannugar/incident-system/packages/contracts/gen/go/incident/inventory/v1"
	orderv1 "github.com/Rahmannugar/incident-system/packages/contracts/gen/go/incident/order/v1"
	"google.golang.org/grpc/metadata"
)

type reservationResponse struct {
	OrderID   string    `json:"order_id"`
	SKU       string    `json:"sku"`
	Quantity  int32     `json:"quantity"`
	State     string    `json:"state"`
	ExpiresAt time.Time `json:"expires_at"`
}

func (a *API) reserveOrder(w http.ResponseWriter, r *http.Request)   { a.orderReservation(w, r, true) }
func (a *API) getReservation(w http.ResponseWriter, r *http.Request) { a.orderReservation(w, r, false) }
func (a *API) orderReservation(w http.ResponseWriter, r *http.Request, create bool) {
	if !bearerAuthorization(w, r) {
		return
	}
	ctx, cancel := a.callContext(r)
	defer cancel()
	orderContext := metadata.AppendToOutgoingContext(ctx, "authorization", r.Header.Get("Authorization"))
	// Retrieve the owned order first; clients cannot substitute another SKU, quantity or owner.
	owned, err := a.orders.GetOrder(orderContext, &orderv1.GetOrderRequest{Id: r.PathValue("id")})
	if err != nil {
		a.rpcFailure(w, r, "order.reservation", err)
		return
	}
	order := owned.GetOrder()
	if order == nil || order.Status != "pending" {
		reject(w, 409, "order_not_pending", "The order is not pending")
		return
	}
	md, _ := metadata.FromOutgoingContext(ctx)
	// The customer bearer is never forwarded as permission to commit Inventory stock.
	inventoryContext := metadata.NewOutgoingContext(ctx, metadata.Pairs("x-service-token", a.inventoryToken))
	if ids := md.Get("x-request-id"); len(ids) == 1 {
		inventoryContext = metadata.AppendToOutgoingContext(inventoryContext, "x-request-id", ids[0])
	}
	var reservation *inventoryv1.Reservation
	if create {
		result, callErr := a.inventory.Reserve(inventoryContext, &inventoryv1.ReserveRequest{OrderId: order.Id, Sku: order.Sku, Quantity: order.Quantity})
		err = callErr
		if result != nil {
			reservation = result.Reservation
		}
	} else {
		result, callErr := a.inventory.GetReservation(inventoryContext, &inventoryv1.GetReservationRequest{OrderId: order.Id, Sku: order.Sku})
		err = callErr
		if result != nil {
			reservation = result.Reservation
		}
	}
	if err != nil {
		a.rpcFailure(w, r, "inventory.reservation", err)
		return
	}
	if reservation == nil || reservation.OrderId != order.Id || reservation.Sku != order.Sku || reservation.Quantity != order.Quantity || reservation.ExpiresAtUnixMs <= 0 {
		reject(w, 502, "invalid_upstream_response", "Inventory returned an invalid reservation")
		return
	}
	write(w, 200, reservationResponse{OrderID: reservation.OrderId, SKU: reservation.Sku, Quantity: reservation.Quantity, State: reservation.State, ExpiresAt: time.UnixMilli(reservation.ExpiresAtUnixMs).UTC()})
}
