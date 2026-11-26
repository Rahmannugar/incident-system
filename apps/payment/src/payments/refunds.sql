/* @name FindRefund */
SELECT r.payment_id, p.amount_minor, p.currency, r.provider_reference, r.completed_at
FROM payments.refunds r
JOIN payments.attempts p ON p.id = r.payment_id
WHERE r.payment_id = :paymentId!;

/* @name InsertRefund */
INSERT INTO payments.refunds (payment_id, provider_reference)
SELECT id, :providerReference! FROM payments.attempts
WHERE id = :paymentId! AND status = 'succeeded'
ON CONFLICT (payment_id) DO NOTHING;
