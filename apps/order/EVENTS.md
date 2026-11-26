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
| `request_id` | Correlation ID carried by the payment outcome |
| `data.order_id` | Order UUID |
| `data.payment_id` | Bound payment UUID |
| `data.status` | `confirmed`, `failed` or `refunded` |
| `data.recipient_email` | Authenticated contact captured at creation; null for older orders without a snapshot |

Processed receipts bind an event ID to an order and signed-body hash. Preparation
persists that binding before external effects; incomplete receipts can resume.
Finalization locks the order, rejects conflicting outcomes and commits receipt
completion with state and outbox. Replays cannot create a second final event.
