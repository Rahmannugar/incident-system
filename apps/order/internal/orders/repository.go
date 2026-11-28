package orders

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	orderdb "github.com/Rahmannugar/incident-system/apps/order/internal/orders/generated"
	"github.com/Rahmannugar/incident-system/packages/telemetry"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Order struct {
	ID             uuid.UUID
	PaymentID      uuid.UUID
	RecipientEmail string
	SKU            string
	Quantity       int32
	Status         string
	CreatedAt      time.Time
}

type Repository struct {
	pool    *pgxpool.Pool
	queries *orderdb.Queries
}

func NewRepository(pool *pgxpool.Pool) *Repository {
	return &Repository{pool: pool, queries: orderdb.New(pool)}
}
func fromRow(row orderdb.OrdersOrder) Order {
	return Order{ID: row.ID, PaymentID: uuid.UUID(row.PaymentID.Bytes), RecipientEmail: row.RecipientEmail.String, SKU: row.Sku, Quantity: row.Quantity, Status: row.Status, CreatedAt: row.CreatedAt.Time.UTC()}
}

func (r *Repository) Create(ctx context.Context, owner uuid.UUID, email, sku string, quantity int32) (Order, error) {
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
	row, err := r.queries.WithTx(tx).CreateOrder(ctx, orderdb.CreateOrderParams{OwnerID: owner, Sku: sku, Quantity: quantity, RecipientEmail: pgtype.Text{String: email, Valid: true}})
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
	_, err := r.pool.Exec(ctx, "SELECT event_id FROM orders.inbox LIMIT 0")
	return err
}

func (r *Repository) Prepare(ctx context.Context, input Settlement) (Order, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return Order{}, err
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = tx.Rollback(cleanup)
	}()
	q := r.queries.WithTx(tx)
	row, err := q.LockSettlementOrder(ctx, input.OrderID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Order{}, ErrNotFound
	}
	if err != nil {
		return Order{}, err
	}
	// Reserve the event identity before any cross-service effects. This receipt
	// stays unprocessed on failure; retries resume without holding a DB lock.
	if err = q.ClaimSettlementEvent(ctx, orderdb.ClaimSettlementEventParams{EventID: input.EventID, OrderID: input.OrderID, PayloadHash: input.PayloadHash}); err != nil {
		return Order{}, err
	}
	seen, err := q.GetProcessedEvent(ctx, input.EventID)
	if err != nil {
		return Order{}, err
	}
	if seen.OrderID != input.OrderID || seen.PayloadHash != input.PayloadHash {
		return Order{}, ErrEventConflict
	}
	if err = ctx.Err(); err != nil {
		return Order{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Order{}, err
	}
	return fromRow(row), nil
}

func (r *Repository) Finalize(ctx context.Context, input Settlement) (result Order, failure error) {
	ctx, span := telemetry.Start(ctx, "order.outcome", telemetry.ProducerKind())
	defer func() { telemetry.End(span, failure != nil) }()
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return Order{}, err
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = tx.Rollback(cleanup)
	}()
	q := r.queries.WithTx(tx)
	// Lock the order before deduplication. State, receipt completion and final event share one
	// commit; retries after external Inventory/refund effects cannot regress it.
	row, err := q.LockSettlementOrder(ctx, input.OrderID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Order{}, ErrNotFound
	}
	if err != nil {
		return Order{}, err
	}
	seen, seenErr := q.GetProcessedEvent(ctx, input.EventID)
	if errors.Is(seenErr, pgx.ErrNoRows) {
		return Order{}, ErrSettlement
	}
	if seenErr != nil {
		return Order{}, seenErr
	}
	if seen.OrderID != input.OrderID || seen.PayloadHash != input.PayloadHash {
		return Order{}, ErrEventConflict
	}
	if row.Status != "pending" && (row.Status != input.Status || uuid.UUID(row.PaymentID.Bytes) != input.PaymentID) {
		return Order{}, ErrTransition
	}
	if seen.ProcessedAt.Valid {
		return fromRow(row), nil
	}
	if row.Status == "pending" {
		row, err = q.SettleOrder(ctx, orderdb.SettleOrderParams{ID: input.OrderID, Status: input.Status, PaymentID: pgtype.UUID{Bytes: input.PaymentID, Valid: true}})
		if err != nil {
			return Order{}, err
		}
		var recipient *string
		if row.RecipientEmail.Valid {
			recipient = &row.RecipientEmail.String
		}
		id := uuid.New()
		eventType := "order." + input.Status
		payload, marshalErr := json.Marshal(finalEvent{Traceparent: telemetry.Traceparent(ctx), ID: id.String(), Type: eventType, Version: 1, OccurredAt: row.SettledAt.Time.UTC().Format(time.RFC3339Nano), RequestID: input.RequestID, Data: finalEventData{OrderID: input.OrderID.String(), PaymentID: input.PaymentID.String(), Status: input.Status, RecipientEmail: recipient}})
		if marshalErr != nil {
			return Order{}, marshalErr
		}
		if err = q.InsertFinalEvent(ctx, orderdb.InsertFinalEventParams{ID: id, OrderID: input.OrderID, EventType: eventType, Payload: payload}); err != nil {
			return Order{}, err
		}
		if err = q.WakeOrderPublisher(ctx); err != nil {
			return Order{}, err
		}
	}
	if err = q.MarkSettlementProcessed(ctx, input.EventID); err != nil {
		return Order{}, err
	}
	if err = ctx.Err(); err != nil {
		return Order{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Order{}, err
	}
	return fromRow(row), nil
}

type finalEventData struct {
	OrderID        string  `json:"order_id"`
	PaymentID      string  `json:"payment_id"`
	Status         string  `json:"status"`
	RecipientEmail *string `json:"recipient_email"`
}
type finalEvent struct {
	Traceparent string         `json:"traceparent,omitempty"`
	ID          string         `json:"id"`
	Type        string         `json:"type"`
	Version     int            `json:"version"`
	OccurredAt  string         `json:"occurred_at"`
	RequestID   string         `json:"request_id"`
	Data        finalEventData `json:"data"`
}
