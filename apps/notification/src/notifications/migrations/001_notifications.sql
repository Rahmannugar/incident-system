CREATE SCHEMA notifications;
CREATE TABLE notifications.deliveries (
    event_id uuid PRIMARY KEY,
    order_id uuid NOT NULL UNIQUE,
    payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
    recipient_email text,
    order_status text NOT NULL CHECK (order_status IN ('confirmed', 'failed', 'refunded')),
    subject text NOT NULL,
    body text NOT NULL,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
    provider_message_id text UNIQUE,
    error_code text,
    created_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    CHECK ((status = 'pending' AND completed_at IS NULL AND provider_message_id IS NULL)
        OR (status = 'sent' AND completed_at IS NOT NULL AND provider_message_id IS NOT NULL AND error_code IS NULL)
        OR (status = 'failed' AND completed_at IS NOT NULL AND provider_message_id IS NULL AND error_code IS NOT NULL))
);

---- create above / drop below ----
DROP TABLE notifications.deliveries;
DROP SCHEMA notifications;
