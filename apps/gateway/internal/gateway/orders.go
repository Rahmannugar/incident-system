package gateway

import (
	"net/http"
	"time"

	orderv1 "github.com/Rahmannugar/incident-system/packages/contracts/gen/go/incident/order/v1"
	"google.golang.org/grpc/metadata"
)

type orderInput struct {
	SKU      string `json:"sku"`
	Quantity int32  `json:"quantity"`
}

type orderResponse struct {
	ID        string    `json:"id"`
	SKU       string    `json:"sku"`
	Quantity  int32     `json:"quantity"`
	Status    string    `json:"status"`
	CreatedAt time.Time `json:"created_at"`
}

func (a *API) createOrder(w http.ResponseWriter, r *http.Request) {
	if !bearerAuthorization(w, r) {
		return
	}
	var input orderInput
	if !decodeJSON(w, r, &input, "Expected a SKU and integer quantity JSON object") {
		return
	}
	ctx, cancel := a.callContext(r)
	defer cancel()
	// Only the bearer credential crosses the boundary; Order derives ownership through Identity.
	ctx = metadata.AppendToOutgoingContext(ctx, "authorization", r.Header.Get("Authorization"))
	result, err := a.orders.CreateOrder(ctx, &orderv1.CreateOrderRequest{Sku: input.SKU, Quantity: input.Quantity})
	if err != nil {
		a.rpcFailure(w, r, "order.create", err)
		return
	}
	writeOrder(w, result.GetOrder(), http.StatusCreated)
}

func (a *API) getOrder(w http.ResponseWriter, r *http.Request) {
	if !bearerAuthorization(w, r) {
		return
	}
	ctx, cancel := a.callContext(r)
	defer cancel()
	ctx = metadata.AppendToOutgoingContext(ctx, "authorization", r.Header.Get("Authorization"))
	result, err := a.orders.GetOrder(ctx, &orderv1.GetOrderRequest{Id: r.PathValue("id")})
	if err != nil {
		a.rpcFailure(w, r, "order.get", err)
		return
	}
	writeOrder(w, result.GetOrder(), http.StatusOK)
}

func writeOrder(w http.ResponseWriter, input *orderv1.Order, code int) {
	if input == nil || input.Id == "" || input.Sku == "" || input.Quantity < 1 || input.Status != "pending" || input.CreatedAtUnix <= 0 {
		reject(w, 502, "invalid_upstream_response", "Order returned an invalid response")
		return
	}
	write(w, code, orderResponse{ID: input.Id, SKU: input.Sku, Quantity: input.Quantity, Status: input.Status, CreatedAt: time.Unix(input.CreatedAtUnix, 0).UTC()})
}
