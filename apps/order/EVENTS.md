# Final order events

Order writes one version 1 final event to `orders.outbox` in the transaction that
changes the pending order and marks its prepared receipt processed. The outbox
row ID equals the payload ID. A transactional `order_outbox` notification is a
wakeup; the row is the durable event.

| Field | Contract |
| --- | --- |
| `id` | Stable event UUID |
| `type` | `order.confirmed`, `order.failed` or `order.refunded` |
| `version` | `1` |
| `occurred_at` | Stored finalization time in UTC |
| `traceparent` | Optional W3C v00 creation context in the signed event body |
| `request_id` | Correlation ID carried by the payment outcome |
| `data.order_id` | Order UUID |
| `data.payment_id` | Bound payment UUID |
| `data.status` | `confirmed`, `failed` or `refunded` |
| `data.recipient_email` | Authenticated contact captured at creation; null for older orders without a snapshot |

Processed receipts bind an event ID to an order and signed-body hash. Preparation
persists that binding before external effects; incomplete receipts can resume.
Finalization locks the order, rejects conflicting outcomes and commits receipt
completion with state and outbox. Replays cannot create a second final event.

## Publication

`task run-order-publisher` runs the Go publisher separately from Order gRPC.
It claims at most 20 rows with 30-second leases and publishes a QStash HTTP batch
outside transactions. A fenced per-item update records acceptance; ambiguous
responses retry with the same event IDs. Publication means acceptance, not email
completion. Invalid payloads and eight exhausted claims remain inspectable.

Transactional NOTIFY wakes the publisher. A startup scan, five-second polling
and listener reconnection recover missed notifications. Each publish request has
a ten-second caller deadline. Shutdown interrupts network work and leaves
unacknowledged claims recoverable.

`INCIDENT_SYSTEM_NOTIFICATION_CALLBACK_BASE_URL` selects Notification's origin;
the destination path is `/events/order`. Host-running local receivers use
`host.docker.internal` for Docker QStash reachability. Publisher credentials are
scoped to the Order database and QStash publication; service/signing keys and
Notification database credentials are excluded.
