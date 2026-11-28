# Payment delivery

Accept a signed version 1 Payment outcome and complete its order transition.
`POST /events/payment`

The destination is `INCIDENT_SYSTEM_CALLBACK_BASE_URL` plus `/events/payment`.
QStash authentication verifies HS256, the current or next signing key, issuer,
exact destination, expiry, not-before and SHA-256 of the raw body before JSON
parsing. Optional trace context is resumed from the verified body, not unsigned
delivery headers. Local mode uses the official development keys; hosted keys stay separate.
Bodies are limited to 32 KiB with at most 16 deliveries executing concurrently.

Gateway checks the event against Payment's stored outcome and asks Order to
reserve its event ID and body hash. Success commits Inventory before confirming
Order. Failure releases the hold before failing Order. An observed expired or
released hold completes a full simulated refund before Order becomes refunded.
Dependency transport failures remain retryable and cannot trigger compensation.

Order finalization atomically records its state, receipt completion and final
outbox event. HTTP 204 acknowledges that commit. Repeated deliveries reuse the
same Inventory/refund effects and durable Order receipt. Conflicting facts or
reused event IDs return 409; incomplete dependency operations return 503.
