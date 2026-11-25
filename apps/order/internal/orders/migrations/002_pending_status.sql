ALTER TABLE orders.orders DROP CONSTRAINT orders_status_check;
ALTER TABLE orders.orders ALTER COLUMN status SET DEFAULT 'pending';
UPDATE orders.orders SET status = 'pending' WHERE status = 'created';
ALTER TABLE orders.orders ADD CONSTRAINT orders_status_check CHECK (status = 'pending');

---- create above / drop below ----

ALTER TABLE orders.orders DROP CONSTRAINT orders_status_check;
ALTER TABLE orders.orders ALTER COLUMN status SET DEFAULT 'created';
UPDATE orders.orders SET status = 'created' WHERE status = 'pending';
ALTER TABLE orders.orders ADD CONSTRAINT orders_status_check CHECK (status = 'created');
