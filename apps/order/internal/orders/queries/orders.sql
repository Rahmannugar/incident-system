-- name: CreateOrder :one
INSERT INTO orders.orders (owner_id, sku, quantity, recipient_email)
VALUES ($1, $2, $3, $4)
RETURNING *;

-- name: GetOwnedOrder :one
SELECT *
FROM orders.orders
WHERE id = $1 AND owner_id = $2;

-- name: GetSettlementOrder :one
SELECT * FROM orders.orders WHERE id = $1;

-- name: LockSettlementOrder :one
SELECT * FROM orders.orders WHERE id = $1 FOR UPDATE;

-- name: GetProcessedEvent :one
SELECT order_id, payload_hash, processed_at FROM orders.inbox WHERE event_id = $1;

-- name: ClaimSettlementEvent :exec
INSERT INTO orders.inbox (event_id, order_id, payload_hash) VALUES ($1, $2, $3) ON CONFLICT (event_id) DO NOTHING;

-- name: MarkSettlementProcessed :exec
UPDATE orders.inbox SET processed_at = statement_timestamp() WHERE event_id = $1 AND processed_at IS NULL;

-- name: SettleOrder :one
UPDATE orders.orders SET status = $2, payment_id = $3, settled_at = statement_timestamp()
WHERE id = $1 AND status = 'pending'
RETURNING *;

-- name: InsertFinalEvent :exec
INSERT INTO orders.outbox (id, order_id, event_type, payload) VALUES ($1, $2, $3, $4);

-- name: WakeOrderPublisher :exec
SELECT pg_notify('order_outbox', '');
