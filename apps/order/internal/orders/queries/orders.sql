-- name: CreateOrder :one
INSERT INTO orders.orders (owner_id, sku, quantity)
VALUES ($1, $2, $3)
RETURNING id, owner_id, sku, quantity, status, created_at;

-- name: GetOwnedOrder :one
SELECT id, owner_id, sku, quantity, status, created_at
FROM orders.orders
WHERE id = $1 AND owner_id = $2;
