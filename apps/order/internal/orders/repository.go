package orders

import (
	"context"
	"errors"
	"time"

	orderdb "github.com/Rahmannugar/incident-system/apps/order/internal/orders/generated"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Order struct {
	ID        uuid.UUID
	SKU       string
	Quantity  int32
	Status    string
	CreatedAt time.Time
}

type Repository struct {
	pool    *pgxpool.Pool
	queries *orderdb.Queries
}

func NewRepository(pool *pgxpool.Pool) *Repository {
	return &Repository{pool: pool, queries: orderdb.New(pool)}
}
func fromRow(row orderdb.OrdersOrder) Order {
	return Order{ID: row.ID, SKU: row.Sku, Quantity: row.Quantity, Status: row.Status, CreatedAt: row.CreatedAt.Time.UTC()}
}

func (r *Repository) Create(ctx context.Context, owner uuid.UUID, sku string, quantity int32) (Order, error) {
	// A cancelled blocked insert must not become an autocommitted order after the caller times out.
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return Order{}, err
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = tx.Rollback(cleanup)
	}()
	row, err := r.queries.WithTx(tx).CreateOrder(ctx, orderdb.CreateOrderParams{OwnerID: owner, Sku: sku, Quantity: quantity})
	if err != nil {
		return Order{}, err
	}
	if err := ctx.Err(); err != nil {
		return Order{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Order{}, err
	}
	return fromRow(row), nil
}

func (r *Repository) GetOwned(ctx context.Context, owner, id uuid.UUID) (Order, error) {
	// Ownership is part of the query, so missing and foreign orders have the same result.
	row, err := r.queries.GetOwnedOrder(ctx, orderdb.GetOwnedOrderParams{ID: id, OwnerID: owner})
	if errors.Is(err, pgx.ErrNoRows) {
		return Order{}, ErrNotFound
	}
	return fromRow(row), err
}

func (r *Repository) Health(ctx context.Context) error { return r.pool.Ping(ctx) }
func (r *Repository) CheckSchema(ctx context.Context) error {
	_, err := r.pool.Exec(ctx, "SELECT id FROM orders.orders LIMIT 0")
	return err
}
