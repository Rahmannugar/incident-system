# Payment outcome events

Payment records version 1 outcome events in `payments.outbox` in the transaction
that finalizes the attempt. The row ID and payload ID identify the same event.

| Field | Contract |
| --- | --- |
| `id` | Stable event UUID |
| `type` | `payment.succeeded` or `payment.failed` |
| `version` | `1` |
| `occurred_at` | UTC timestamp of the persisted transition |
| `traceparent` | Optional W3C v00 context captured in the signed event body |
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

A simulated full refund is recorded separately from the successful attempt.
It does not rewrite the original outcome or create another payment outcome event.
Settlement reads include its stored completion, full amount and provider reference.

## Outbox publication

The separate Payment publisher claims up to 20 rows with 30-second leases and
fences completion using a claim token. It uses transactional NOTIFY wakeups and
five-second fallback polling. HTTP publication happens outside database locks.

Each batch result is persisted independently. `published_at` and
`qstash_message_id` mean QStash accepted that event; they do not mean a consumer
processed it. Unconfirmed acceptance is retried using the same event ID.

Retries back off, and eight failed/interrupted claims retain an inspectable
`exhausted_at`/`last_error_code`. Invalid stored events are exhausted without
publication. Expired claims can be reclaimed, and stale workers cannot overwrite
the new owner's result.

`INCIDENT_SYSTEM_QSTASH_MODE` selects `local` or `hosted`. Local mode uses the
pinned Upstash development container and its public development credentials;
hosted account credentials remain separate. `INCIDENT_SYSTEM_CALLBACK_BASE_URL`
is required in either mode. Host-running consumers use `http://host.docker.internal:<port>`
as their callback origin in local mode. The development server stores its data in memory.
