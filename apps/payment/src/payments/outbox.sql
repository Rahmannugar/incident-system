/* @name ExhaustExpiredClaims */
UPDATE payments.outbox
SET exhausted_at = now(), claim_token = NULL, claim_until = NULL,
    last_error_code = 'publish_attempts_exhausted'
WHERE published_at IS NULL AND exhausted_at IS NULL AND publish_attempts >= 8
    AND (claim_until IS NULL OR claim_until <= now());

/* @name ClaimOutboxBatch */
WITH pending AS (
    SELECT id FROM payments.outbox
    WHERE published_at IS NULL AND exhausted_at IS NULL AND available_at <= now()
        AND publish_attempts < 8 AND (claim_until IS NULL OR claim_until <= now())
    ORDER BY created_at, id
    FOR UPDATE SKIP LOCKED
    LIMIT :batchSize!
)
UPDATE payments.outbox AS o
SET claim_token = :claimToken!, claim_until = now() + interval '30 seconds',
    publish_attempts = publish_attempts + 1
FROM pending WHERE o.id = pending.id
RETURNING o.id, o.payment_id, o.payload, o.publish_attempts;

/* @name FinishOutboxBatch */
WITH results AS (
    SELECT * FROM jsonb_to_recordset(:results!::jsonb)
        AS r(id uuid, message_id text, error_code text)
)
UPDATE payments.outbox AS o
SET published_at = CASE WHEN r.message_id IS NOT NULL THEN now() ELSE NULL END,
    qstash_message_id = r.message_id,
    claim_token = NULL, claim_until = NULL,
    last_error_code = r.error_code,
    available_at = CASE WHEN r.message_id IS NOT NULL THEN available_at
        ELSE now() + (least(300, power(2, publish_attempts)) * interval '1 second') END,
    exhausted_at = CASE WHEN r.message_id IS NULL AND
        (publish_attempts >= 8 OR r.error_code = 'invalid_event') THEN now() ELSE NULL END
FROM results r
WHERE o.id = r.id AND o.claim_token = :claimToken! AND o.published_at IS NULL
RETURNING o.id, o.published_at, o.exhausted_at;

/* @name OutboxMetrics */
SELECT count(*) FILTER (WHERE exhausted_at IS NULL)::bigint AS pending,
       count(*) FILTER (WHERE exhausted_at IS NOT NULL)::bigint AS exhausted,
       coalesce(extract(epoch FROM (now() - min(created_at) FILTER (WHERE exhausted_at IS NULL))), 0)::double precision AS oldest_seconds
FROM payments.outbox WHERE published_at IS NULL;
