ALTER TABLE payments.outbox
    ADD COLUMN published_at timestamptz,
    ADD COLUMN qstash_message_id text,
    ADD COLUMN claim_token uuid,
    ADD COLUMN claim_until timestamptz,
    ADD COLUMN publish_attempts integer NOT NULL DEFAULT 0 CHECK (publish_attempts BETWEEN 0 AND 8),
    ADD COLUMN available_at timestamptz NOT NULL DEFAULT now(),
    ADD COLUMN exhausted_at timestamptz,
    ADD COLUMN last_error_code text,
    ADD CONSTRAINT outbox_claim_pair CHECK ((claim_token IS NULL) = (claim_until IS NULL)),
    ADD CONSTRAINT outbox_publish_pair CHECK ((published_at IS NULL) = (qstash_message_id IS NULL)),
    ADD CONSTRAINT outbox_terminal CHECK (published_at IS NULL OR exhausted_at IS NULL);
CREATE INDEX outbox_pending ON payments.outbox (available_at, created_at)
    WHERE published_at IS NULL AND exhausted_at IS NULL;

---- create above / drop below ----
DROP INDEX payments.outbox_pending;
ALTER TABLE payments.outbox
    DROP CONSTRAINT outbox_claim_pair,
    DROP CONSTRAINT outbox_publish_pair,
    DROP CONSTRAINT outbox_terminal,
    DROP COLUMN published_at,
    DROP COLUMN qstash_message_id,
    DROP COLUMN claim_token,
    DROP COLUMN claim_until,
    DROP COLUMN publish_attempts,
    DROP COLUMN available_at,
    DROP COLUMN exhausted_at,
    DROP COLUMN last_error_code;
