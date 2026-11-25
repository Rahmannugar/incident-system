CREATE SCHEMA orders;

CREATE TABLE orders.orders (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid NOT NULL,
    sku text NOT NULL CHECK (sku ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
    quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 1000),
    status text NOT NULL DEFAULT 'created' CHECK (status = 'created'),
    created_at timestamptz NOT NULL DEFAULT now()
);

---- create above / drop below ----

DROP TABLE orders.orders;
DROP SCHEMA orders;
