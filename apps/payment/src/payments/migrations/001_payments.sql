CREATE SCHEMA payments;

CREATE TABLE payments.attempts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id uuid NOT NULL UNIQUE,
    amount_minor bigint NOT NULL CHECK (amount_minor BETWEEN 1 AND 1000000000000),
    currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed')),
    reservation_expires_at timestamptz NOT NULL,
    request_id text NOT NULL CHECK (request_id ~ '^[A-Za-z0-9_-]{1,64}$'),
    late boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE payments.provider_events (
    event_id uuid PRIMARY KEY,
    payment_id uuid NOT NULL REFERENCES payments.attempts(id),
    payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
    outcome text NOT NULL CHECK (outcome IN ('succeeded', 'failed')),
    applied boolean NOT NULL,
    received_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE payments.outbox (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_id uuid NOT NULL UNIQUE REFERENCES payments.attempts(id),
    event_type text NOT NULL CHECK (event_type IN ('payment.succeeded', 'payment.failed')),
    payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    created_at timestamptz NOT NULL DEFAULT now()
);

---- create above / drop below ----
DROP TABLE payments.outbox;
DROP TABLE payments.provider_events;
DROP TABLE payments.attempts;
DROP SCHEMA payments;
