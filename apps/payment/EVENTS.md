# Payment outcome events

Payment records version 1 outcome events in `payments.outbox` in the transaction
that finalizes the attempt. The row ID and payload ID identify the same event.

| Field | Contract |
| --- | --- |
| `id` | Stable event UUID |
| `type` | `payment.succeeded` or `payment.failed` |
| `version` | `1` |
| `occurred_at` | UTC timestamp of the persisted transition |
| `request_id` | Correlation ID stored when the attempt was initiated |
| `data.payment_id` | Payment attempt UUID |
| `data.order_id` | Order UUID |
| `data.amount_minor` | Quoted integer amount in minor currency units |
| `data.currency` | Three-letter configured currency |
| `data.reservation_expires_at` | Reservation deadline recorded at initiation |
| `data.late` | Outcome processed after that stored deadline |

An attempt records one final outcome event. Provider retries and new provider
events repeating the same outcome do not create another outbox row. Conflicting
final outcomes are retained as unapplied provider events. Reusing a provider
event ID with different raw content is rejected.

`late` describes the stored deadline, not the current state of Inventory. Payment
success records the simulated provider's result; it does not assert that stock
was committed or the order confirmed.
