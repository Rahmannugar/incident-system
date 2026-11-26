ALTER TABLE orders.orders DROP CONSTRAINT orders_status_check;
ALTER TABLE orders.orders ADD CONSTRAINT orders_status_check CHECK (status IN ('pending', 'confirmed', 'failed', 'refunded'));
ALTER TABLE orders.orders ADD COLUMN recipient_email text;
ALTER TABLE orders.orders ADD COLUMN payment_id uuid;
ALTER TABLE orders.orders ADD COLUMN settled_at timestamptz;
ALTER TABLE orders.orders ADD CONSTRAINT orders_settlement_check CHECK (
    (status = 'pending' AND payment_id IS NULL AND settled_at IS NULL)
    OR (status <> 'pending' AND payment_id IS NOT NULL AND settled_at IS NOT NULL)
);
CREATE TABLE orders.inbox (
    event_id uuid PRIMARY KEY,
    order_id uuid NOT NULL REFERENCES orders.orders(id),
    payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
    received_at timestamptz NOT NULL DEFAULT now(),
    processed_at timestamptz
);
CREATE TABLE orders.outbox (
    id uuid PRIMARY KEY,
    order_id uuid NOT NULL UNIQUE REFERENCES orders.orders(id),
    event_type text NOT NULL CHECK (event_type IN ('order.confirmed', 'order.failed', 'order.refunded')),
    payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    created_at timestamptz NOT NULL DEFAULT now()
);

---- create above / drop below ----
DROP TABLE orders.outbox;
DROP TABLE orders.inbox;
ALTER TABLE orders.orders DROP CONSTRAINT orders_settlement_check;
ALTER TABLE orders.orders DROP COLUMN settled_at, DROP COLUMN payment_id, DROP COLUMN recipient_email;
ALTER TABLE orders.orders DROP CONSTRAINT orders_status_check;
UPDATE orders.orders SET status = 'pending';
ALTER TABLE orders.orders ADD CONSTRAINT orders_status_check CHECK (status = 'pending');
