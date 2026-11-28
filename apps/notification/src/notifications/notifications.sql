/* @name InsertDelivery */
INSERT INTO notifications.deliveries (event_id, order_id, payload_hash, recipient_email, order_status, subject, body)
VALUES (:eventId!, :orderId!, :payloadHash!, :recipientEmail, :orderStatus!, :subject!, :body!)
ON CONFLICT DO NOTHING;

/* @name LockDelivery */
SELECT * FROM notifications.deliveries WHERE event_id = :eventId! FOR UPDATE;

/* @name CompleteDelivery */
UPDATE notifications.deliveries
SET status = :status!, attempts = :attempts!, provider_message_id = :providerMessageId,
    error_code = :errorCode,
    completed_at = CASE WHEN :status! = 'pending' THEN NULL ELSE statement_timestamp() END
WHERE event_id = :eventId!
RETURNING status;
