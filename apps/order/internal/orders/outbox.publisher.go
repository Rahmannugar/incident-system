package orders

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"go.opentelemetry.io/otel/trace"
	"io"
	"log/slog"
	"net/http"
	"time"

	orderdb "github.com/Rahmannugar/incident-system/apps/order/internal/orders/generated"
	"github.com/Rahmannugar/incident-system/packages/telemetry"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

type OutboxPublisher struct {
	pool                        *pgxpool.Pool
	queries                     *orderdb.Queries
	baseURL, token, destination string
	client                      *http.Client
	logger                      *slog.Logger
}

func NewOutboxPublisher(pool *pgxpool.Pool, baseURL, token, destination string, logger *slog.Logger) *OutboxPublisher {
	return &OutboxPublisher{pool: pool, queries: orderdb.New(pool), baseURL: baseURL, token: token, destination: destination, logger: logger, client: &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}

type publishResult struct {
	ID        uuid.UUID `json:"id"`
	MessageID *string   `json:"message_id"`
	ErrorCode *string   `json:"error_code"`
}
type publishMessage struct {
	Destination string            `json:"destination"`
	Body        string            `json:"body"`
	Headers     map[string]string `json:"headers"`
}

func failedPublish(id uuid.UUID, code string) publishResult {
	return publishResult{ID: id, ErrorCode: &code}
}
func validFinalEvent(row orderdb.ClaimOutboxBatchRow) bool {
	var event finalEvent
	decoder := json.NewDecoder(bytes.NewReader(row.Payload))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&event) != nil {
		return false
	}
	var trailing interface{}
	if decoder.Decode(&trailing) != io.EOF {
		return false
	}
	payment, err := uuid.Parse(event.Data.PaymentID)
	_, timeErr := time.Parse(time.RFC3339Nano, event.OccurredAt)
	status := event.Data.Status
	return (event.Traceparent == "" || telemetry.ValidParent(event.Traceparent)) && len(row.Payload) <= 32768 && event.ID == row.ID.String() && event.Data.OrderID == row.OrderID.String() && err == nil && payment != uuid.Nil && event.Version == 1 && event.Type == "order."+status && (status == "confirmed" || status == "failed" || status == "refunded") && timeErr == nil && requestIDPattern.MatchString(event.RequestID) && (event.Data.RecipientEmail == nil || validContact(*event.Data.RecipientEmail))
}
func (p *OutboxPublisher) RunBatch(ctx context.Context) (int, error) {
	if ctx.Err() != nil {
		return 0, ctx.Err()
	}
	if err := p.queries.ExhaustExpiredClaims(ctx); err != nil {
		return 0, err
	}
	claim := pgtype.UUID{Bytes: uuid.New(), Valid: true}
	rows, err := p.queries.ClaimOutboxBatch(ctx, orderdb.ClaimOutboxBatchParams{ClaimToken: claim, BatchSize: 20})
	if err != nil || len(rows) == 0 {
		return len(rows), err
	}
	spans := map[uuid.UUID]trace.Span{}
	defer func() {
		for _, span := range spans {
			span.End()
		}
	}()
	results := make([]publishResult, 0, len(rows))
	messages := make([]publishMessage, 0, len(rows))
	sent := make([]orderdb.ClaimOutboxBatchRow, 0, len(rows))
	for _, row := range rows {
		telemetry.OutboxAttempt(ctx, row.PublishAttempts > 1)
		if !validFinalEvent(row) {
			results = append(results, failedPublish(row.ID, "invalid_event"))
			continue
		}
		var event finalEvent
		_ = json.Unmarshal(row.Payload, &event)
		_, span := telemetry.Resume(ctx, event.Traceparent, "order.publish", telemetry.ProducerKind())
		spans[row.ID] = span
		messages = append(messages, publishMessage{Destination: p.destination, Body: string(row.Payload), Headers: map[string]string{"Content-Type": "application/json", "Upstash-Deduplication-Id": row.ID.String(), "Upstash-Retries": "2", "Upstash-Timeout": "10s"}})
		sent = append(sent, row)
	}
	if len(sent) > 0 {
		accepted, publishErr := p.publish(ctx, messages)
		for i, row := range sent {
			result := failedPublish(row.ID, "publish_unconfirmed")
			if publishErr == nil {
				if accepted[i].Error == "" && len(accepted[i].MessageID) > 0 && len(accepted[i].MessageID) <= 256 {
					id := accepted[i].MessageID
					result = publishResult{ID: row.ID, MessageID: &id}
				} else {
					result = failedPublish(row.ID, "qstash_rejected")
				}
			}
			if result.MessageID == nil {
				telemetry.MarkError(spans[row.ID])
			}
			results = append(results, result)
		}
	}
	// Publication holds no DB transaction. A fenced completion cannot acknowledge
	// reclaimed work; lost responses retry with the same durable event ID.
	encoded, err := json.Marshal(results)
	if err != nil {
		return len(rows), err
	}
	finish, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	finished, err := p.queries.FinishOutboxBatch(finish, orderdb.FinishOutboxBatchParams{ClaimToken: claim, Results: encoded})
	if err != nil {
		for _, span := range spans {
			telemetry.MarkError(span)
		}
		return len(rows), err
	}
	published, exhausted := 0, 0
	for _, row := range finished {
		outcome := "retry"
		if row.PublishedAt.Valid {
			outcome = "published"
		} else if row.ExhaustedAt.Valid {
			outcome = "exhausted"
		}
		telemetry.OutboxResult(ctx, outcome)
		if row.PublishedAt.Valid {
			published++
		}
		if row.ExhaustedAt.Valid {
			exhausted++
		}
	}
	p.logger.Info("outbox.batch", "service", "order", "claimed", len(rows), "acknowledged", len(finished), "published", published, "exhausted", exhausted)
	return len(rows), nil
}

type batchAcceptance struct {
	MessageID string `json:"messageId"`
	Error     string `json:"error"`
}

func (p *OutboxPublisher) publish(ctx context.Context, messages []publishMessage) ([]batchAcceptance, error) {
	encoded, err := json.Marshal(messages)
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, p.baseURL+"/v2/batch", bytes.NewReader(encoded))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+p.token)
	request.Header.Set("Content-Type", "application/json")
	response, err := p.client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if (response.StatusCode < 200 || response.StatusCode >= 300) && response.StatusCode != 400 {
		return nil, errors.New("QStash rejected batch")
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, 65537))
	if err != nil || len(raw) > 65536 {
		return nil, errors.New("invalid QStash response")
	}
	var accepted []batchAcceptance
	if json.Unmarshal(raw, &accepted) != nil || len(accepted) != len(messages) {
		return nil, errors.New("invalid QStash batch response")
	}
	return accepted, nil
}
func (p *OutboxPublisher) Run(ctx context.Context) error {
	if _, err := p.pool.Exec(ctx, "SELECT published_at, claim_token FROM orders.outbox LIMIT 0"); err != nil {
		return errors.New("Order outbox schema unavailable")
	}
	telemetry.ObserveOutbox(func(ctx context.Context) (telemetry.OutboxSnapshot, error) {
		row, err := p.queries.OutboxMetrics(ctx)
		return telemetry.OutboxSnapshot{Pending: row.Pending, Exhausted: row.Exhausted, OldestSeconds: row.OldestSeconds}, err
	})
	wake := make(chan struct{}, 1)
	listenerCtx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() { defer close(done); p.listen(listenerCtx, wake) }()
	defer func() { cancel(); <-done }()
	p.logger.Info("outbox.started", "service", "order")
	defer p.logger.Info("outbox.stopped", "service", "order")
	for ctx.Err() == nil {
		count, err := p.RunBatch(ctx)
		if err != nil && ctx.Err() == nil {
			p.logger.Warn("outbox.batch_unconfirmed", "service", "order")
		}
		if err == nil && count == 20 {
			continue
		}
		select {
		case <-ctx.Done():
		case <-wake:
		case <-time.After(5 * time.Second):
		}
	}
	return nil
}
func (p *OutboxPublisher) listen(ctx context.Context, wake chan<- struct{}) {
	for ctx.Err() == nil {
		connection, err := p.pool.Acquire(ctx)
		if err == nil {
			_, err = connection.Exec(ctx, "LISTEN order_outbox")
			if err == nil {
				p.logger.Info("outbox.listening", "service", "order")
				for ctx.Err() == nil {
					_, err = connection.Conn().WaitForNotification(ctx)
					if err != nil {
						break
					}
					select {
					case wake <- struct{}{}:
					default:
					}
				}
			}
			// A LISTEN connection has session state; discard it rather than leaking that
			// state to another pooled caller after shutdown or a broken connection.
			closeCtx, cancel := context.WithTimeout(context.Background(), time.Second)
			_ = connection.Conn().Close(closeCtx)
			cancel()
			connection.Release()
		}
		if ctx.Err() == nil {
			p.logger.Warn("outbox.listener_unavailable", "service", "order")
		}
		select {
		case <-ctx.Done():
		case <-time.After(5 * time.Second):
		}
	}
}
