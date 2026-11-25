/* @name FindPayment */
SELECT * FROM payments.attempts WHERE order_id = :orderId!;

/* @name InsertPayment */
INSERT INTO payments.attempts (order_id, amount_minor, currency, reservation_expires_at, request_id)
VALUES (:orderId!, :amountMinor!, :currency!, :reservationExpiresAt!, :requestId!)
ON CONFLICT (order_id) DO NOTHING
RETURNING *;

/* @name LockPayment */
SELECT * FROM payments.attempts WHERE id = :paymentId! FOR UPDATE;

/* @name FindProviderEvent */
SELECT payment_id, payload_hash FROM payments.provider_events WHERE event_id = :eventId!;

/* @name RecordProviderEvent */
INSERT INTO payments.provider_events (event_id, payment_id, payload_hash, outcome, applied)
VALUES (:eventId!, :paymentId!, :payloadHash!, :outcome!, :applied!);

/* @name FinalizePayment */
UPDATE payments.attempts
SET status = :outcome!, updated_at = statement_timestamp(), late = reservation_expires_at <= statement_timestamp()
WHERE id = :paymentId! AND status = 'pending'
RETURNING *;

/* @name InsertOutcome */
INSERT INTO payments.outbox (id, payment_id, event_type, payload)
VALUES (:id!, :paymentId!, :eventType!, :payload!::jsonb);

/* @name WakePublisher */
SELECT pg_notify('payment_outbox', '');
