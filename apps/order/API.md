# Order gRPC API

Contracts: [order_service.proto](../../packages/contracts/proto/incident/order/v1/order_service.proto).

Create a pending single-item order for the user identified by bearer metadata.
`/incident.order.v1.OrderService/CreateOrder`

Read an order owned by the user identified by bearer metadata.
`/incident.order.v1.OrderService/GetOrder`

Check Order database and Identity availability.
`/incident.order.v1.OrderService/CheckHealth`

Reserve a payment event ID/body hash and read its order using the Order service credential.
`/incident.order.v1.OrderService/PrepareOrderSettlement`

Finalize a prepared settlement and atomically persist receipt completion and the final order event; conflicting final states are rejected. Requires the Order service credential.
`/incident.order.v1.OrderService/FinalizeOrder`
