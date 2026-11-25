# Inventory gRPC API

Contracts: [inventory_service.proto](../../packages/contracts/proto/incident/inventory/v1/inventory_service.proto).
All business operations require internal `x-service-token` metadata.

Read unsold stock and availability after active reservations.
`/incident.inventory.v1.InventoryService/CheckStock`

Reserve one SKU for an order; repeated matching requests preserve the original expiry.
`/incident.inventory.v1.InventoryService/Reserve`

Read the reservation state and expiry for an order and SKU.
`/incident.inventory.v1.InventoryService/GetReservation`

Commit an active reservation and decrement unsold stock exactly once.
`/incident.inventory.v1.InventoryService/Commit`

Release an uncommitted reservation; repeated release is safe.
`/incident.inventory.v1.InventoryService/Release`

Check Redis connectivity without business credentials.
`/incident.inventory.v1.InventoryService/CheckHealth`
