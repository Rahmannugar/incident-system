//go:build integration

package orders

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Rahmannugar/incident-system/apps/order/internal/config"
	orderdb "github.com/Rahmannugar/incident-system/apps/order/internal/orders/generated"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestOutboxRecovery(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
	databaseURL, err := config.DatabaseURL()
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := url.Parse(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	owner := parsed.User.Username()
	parsed.User = url.UserPassword("postgres", os.Getenv("INCIDENT_SYSTEM_DATABASE_ADMIN_PASSWORD"))
	parsed.Path = "/postgres"
	admin, err := pgx.Connect(ctx, parsed.String())
	if err != nil {
		t.Fatal("connect administrative fixture database")
	}
	defer admin.Close(context.Background())
	name := "incident_system_order_test_" + uuid.NewString()[:8]
	if _, err = admin.Exec(ctx, "CREATE DATABASE "+pgx.Identifier{name}.Sanitize()+" OWNER "+pgx.Identifier{owner}.Sanitize()); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if _, err := admin.Exec(context.Background(), "DROP DATABASE "+pgx.Identifier{name}.Sanitize()); err != nil {
			t.Error(err)
		}
	}()
	if _, err = admin.Exec(ctx, "REVOKE ALL ON DATABASE "+pgx.Identifier{name}.Sanitize()+" FROM PUBLIC"); err != nil {
		t.Fatal(err)
	}
	root, err := filepath.Abs("../../../..")
	if err != nil {
		t.Fatal(err)
	}
	command := exec.CommandContext(ctx, filepath.Join(root, "bin/tern"), "migrate", "-c", "apps/order/tern.conf", "-m", "apps/order/internal/orders/migrations")
	command.Dir = root
	command.Env = append(os.Environ(), "INCIDENT_SYSTEM_ORDER_DATABASE_NAME="+name)
	if err = command.Run(); err != nil {
		t.Fatal("migrate Order fixture database", err)
	}
	parsed, _ = url.Parse(databaseURL)
	parsed.Path = "/" + name
	pool, err := pgxpool.New(ctx, parsed.String())
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	q := orderdb.New(pool)
	seed := func(count int) {
		t.Helper()
		for range count {
			orderID, eventID := uuid.New(), uuid.New()
			recipient := "customer@example.test"
			event := finalEvent{ID: eventID.String(), Type: "order.confirmed", Version: 1, OccurredAt: time.Now().UTC().Format(time.RFC3339Nano), RequestID: uuid.NewString(), Data: finalEventData{OrderID: orderID.String(), PaymentID: uuid.NewString(), Status: "confirmed", RecipientEmail: &recipient}}
			payload, err := json.Marshal(event)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = pool.Exec(ctx, "INSERT INTO orders.orders(id,owner_id,sku,quantity) VALUES($1,$2,'publisher-item',1)", orderID, uuid.New()); err != nil {
				t.Fatal(err)
			}
			if err = q.InsertFinalEvent(ctx, orderdb.InsertFinalEventParams{ID: eventID, OrderID: orderID, EventType: event.Type, Payload: payload}); err != nil {
				t.Fatal(err)
			}
		}
	}
	reset := func() {
		t.Helper()
		if _, err := pool.Exec(ctx, "TRUNCATE orders.inbox,orders.outbox,orders.orders"); err != nil {
			t.Fatal(err)
		}
	}
	claim := func(token pgtype.UUID, size int32) []orderdb.ClaimOutboxBatchRow {
		t.Helper()
		rows, err := q.ClaimOutboxBatch(ctx, orderdb.ClaimOutboxBatchParams{ClaimToken: token, BatchSize: size})
		if err != nil {
			t.Fatal(err)
		}
		return rows
	}
	seed(6)
	first := pgtype.UUID{Bytes: uuid.New(), Valid: true}
	second := pgtype.UUID{Bytes: uuid.New(), Valid: true}
	var a, b []orderdb.ClaimOutboxBatchRow
	var e1, e2 error
	var wait sync.WaitGroup
	wait.Add(2)
	go func() {
		defer wait.Done()
		a, e1 = q.ClaimOutboxBatch(ctx, orderdb.ClaimOutboxBatchParams{ClaimToken: first, BatchSize: 3})
	}()
	go func() {
		defer wait.Done()
		b, e2 = q.ClaimOutboxBatch(ctx, orderdb.ClaimOutboxBatchParams{ClaimToken: second, BatchSize: 3})
	}()
	wait.Wait()
	if e1 != nil || e2 != nil || len(a) != 3 || len(b) != 3 {
		t.Fatal("concurrent claims failed")
	}
	ids := map[uuid.UUID]bool{}
	for _, row := range append(a, b...) {
		if ids[row.ID] {
			t.Fatal("claims overlap")
		}
		ids[row.ID] = true
	}
	if _, err = pool.Exec(ctx, "UPDATE orders.outbox SET claim_until=now()-interval '1 second' WHERE claim_token=$1", first); err != nil {
		t.Fatal(err)
	}
	replacement := pgtype.UUID{Bytes: uuid.New(), Valid: true}
	if len(claim(replacement, 3)) != 3 {
		t.Fatal("expired claims not reclaimed")
	}
	messageID := "fixture_message"
	results := []publishResult{}
	for _, row := range a {
		results = append(results, publishResult{ID: row.ID, MessageID: &messageID})
	}
	encoded, _ := json.Marshal(results)
	finished, err := q.FinishOutboxBatch(ctx, orderdb.FinishOutboxBatchParams{ClaimToken: first, Results: encoded})
	if err != nil || len(finished) != 0 {
		t.Fatal("stale lease acknowledged reclaimed rows")
	}
	finished, err = q.FinishOutboxBatch(ctx, orderdb.FinishOutboxBatchParams{ClaimToken: replacement, Results: encoded})
	if err != nil || len(finished) != 3 {
		t.Fatal("replacement acknowledgement failed", err)
	}
	reset()
	seed(2)
	accepted := map[string]string{}
	var requests [][]string
	rejectOne, loseResponse := true, false
	var rejectRequests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v2/batch" || r.Header.Get("Authorization") != "Bearer fixture-order-publisher" {
			w.WriteHeader(401)
			return
		}
		var batch []publishMessage
		if json.NewDecoder(r.Body).Decode(&batch) != nil {
			w.WriteHeader(400)
			return
		}
		if rejectRequests.Load() > 0 {
			rejectRequests.Add(-1)
			w.WriteHeader(503)
			return
		}
		response := make([]batchAcceptance, 0, len(batch))
		batchIDs := []string{}
		for i, message := range batch {
			id := message.Headers["Upstash-Deduplication-Id"]
			batchIDs = append(batchIDs, id)
			if rejectOne && i == 1 {
				response = append(response, batchAcceptance{Error: "fixture_rejected"})
				continue
			}
			value, ok := accepted[id]
			if !ok {
				value = "fixture_" + uuid.NewString()
				accepted[id] = value
			}
			response = append(response, batchAcceptance{MessageID: value})
		}
		requests = append(requests, batchIDs)
		if loseResponse {
			loseResponse = false
			connection, _, err := w.(http.Hijacker).Hijack()
			if err == nil {
				connection.Close()
			}
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if rejectOne {
			w.WriteHeader(400)
		} else {
			w.WriteHeader(201)
		}
		_ = json.NewEncoder(w).Encode(response)
	}))
	defer server.Close()
	publisher := NewOutboxPublisher(pool, server.URL, "fixture-order-publisher", "https://callback.example.test/events/order", slog.New(slog.NewJSONHandler(io.Discard, nil)))
	run := func() {
		t.Helper()
		if _, err := publisher.RunBatch(ctx); err != nil {
			t.Fatal(err)
		}
	}
	run()
	var published int
	if err = pool.QueryRow(ctx, "SELECT count(*) FROM orders.outbox WHERE published_at IS NOT NULL").Scan(&published); err != nil {
		t.Fatal(err)
	}
	if published != 1 || len(requests) != 1 || len(requests[0]) != 2 {
		t.Fatal("partial batch acceptance not persisted")
	}
	var backedOff bool
	if err = pool.QueryRow(ctx, "SELECT available_at>now() FROM orders.outbox WHERE published_at IS NULL").Scan(&backedOff); err != nil || !backedOff {
		t.Fatal("missing backoff")
	}
	rejectOne = false
	if _, err = pool.Exec(ctx, "UPDATE orders.outbox SET available_at=now()"); err != nil {
		t.Fatal(err)
	}
	run()
	if len(accepted) != 2 {
		t.Fatal("failed item not retried")
	}
	reset()
	seed(1)
	accepted = map[string]string{}
	loseResponse = true
	run()
	if err = pool.QueryRow(ctx, "SELECT count(*) FROM orders.outbox WHERE published_at IS NOT NULL").Scan(&published); err != nil || published != 0 {
		t.Fatal("lost response was acknowledged")
	}
	if _, err = pool.Exec(ctx, "UPDATE orders.outbox SET available_at=now()"); err != nil {
		t.Fatal(err)
	}
	run()
	if len(accepted) != 1 {
		t.Fatal("retry changed event identity")
	}
	reset()
	seed(1)
	if _, err = pool.Exec(ctx, "UPDATE orders.outbox SET publish_attempts=8,claim_token=$1,claim_until=now()-interval '1 second'", uuid.New()); err != nil {
		t.Fatal(err)
	}
	run()
	var exhausted bool
	if err = pool.QueryRow(ctx, "SELECT exhausted_at IS NOT NULL AND claim_token IS NULL FROM orders.outbox").Scan(&exhausted); err != nil || !exhausted {
		t.Fatal("interrupted final claim not exhausted")
	}
	reset()
	workerCtx, stopWorker := context.WithCancel(ctx)
	workerDone := make(chan error, 1)
	go func() { workerDone <- publisher.Run(workerCtx) }()
	defer func() {
		stopWorker()
		if err := <-workerDone; err != nil {
			t.Error(err)
		}
	}()
	await := func(check func() bool, timeout time.Duration, message string) {
		t.Helper()
		deadline := time.Now().Add(timeout)
		for time.Now().Before(deadline) {
			if check() {
				return
			}
			time.Sleep(20 * time.Millisecond)
		}
		t.Fatal(message)
	}
	await(func() bool {
		var count int
		_ = pool.QueryRow(ctx, "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND query='LISTEN order_outbox'").Scan(&count)
		return count > 0
	}, 3*time.Second, "worker did not LISTEN")
	rejectRequests.Store(1)
	seed(1)
	if err = q.WakeOrderPublisher(ctx); err != nil {
		t.Fatal(err)
	}
	await(func() bool {
		var count int
		_ = pool.QueryRow(ctx, "SELECT count(*) FROM orders.outbox WHERE last_error_code='publish_unconfirmed'").Scan(&count)
		return count == 1
	}, 3*time.Second, "NOTIFY did not wake publisher")
	// No second NOTIFY: the durable backoff row must recover on polling alone.
	await(func() bool {
		var count int
		_ = pool.QueryRow(ctx, "SELECT count(*) FROM orders.outbox WHERE published_at IS NOT NULL").Scan(&count)
		return count == 1
	}, 8*time.Second, "polling did not recover rejected batch")

}
