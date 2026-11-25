//go:build integration

package inventory

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/Rahmannugar/incident-system/apps/inventory/internal/config"
	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

func TestHostedReservations(t *testing.T) {
	cfg, err := config.Load()
	if err != nil {
		t.Fatal("Inventory integration settings are required")
	}
	client := redis.NewClient(cfg.Redis)
	prefix := "incident-system:inventory:test-" + uuid.NewString() + ":"
	store := NewStore(client, prefix, 30*time.Second)
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	skus := []string{"race-item", "expiry-item"}
	var leaseIDs []string
	t.Cleanup(func() {
		defer client.Close()
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		ids, _ := client.HKeys(cleanup, store.prefix+"reservations").Result()
		ids = append(ids, leaseIDs...)
		keys := []string{store.prefix + "reservations"}
		for _, id := range ids {
			keys = append(keys, store.prefix+"lease:"+id)
		}
		for _, sku := range skus {
			keys = append(keys, store.prefix+"stock:"+sku, store.prefix+"holds:"+sku, store.prefix+"quantities:"+sku)
		}
		if err := client.Del(cleanup, keys...).Err(); err != nil {
			t.Error("Could not clean isolated Inventory fixture keys")
		}
	})
	run := func(op, sku, id string, quantity, stock int32) Result {
		t.Helper()
		result, err := store.Execute(ctx, op, sku, id, quantity, stock)
		if err != nil {
			t.Fatalf("%s failed: %v", op, err)
		}
		return result
	}
	expectFailure := func(err error, code string) {
		t.Helper()
		var domain *Failure
		if !errors.As(err, &domain) || domain.Code != code {
			t.Fatalf("expected %s, got %v", code, err)
		}
	}
	run("seed", skus[0], "", 0, 7)
	run("seed", skus[1], "", 0, 1)
	var wg sync.WaitGroup
	winners := make(chan string, 20)
	failures := make(chan error, 20)
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			id := uuid.NewString()
			_, err := store.Execute(ctx, "reserve", skus[0], id, 1, 0)
			if err != nil {
				failures <- err
			} else {
				winners <- id
			}
		}()
	}
	wg.Wait()
	close(winners)
	close(failures)
	var held []string
	for id := range winners {
		held = append(held, id)
	}
	if len(held) != 7 {
		t.Fatalf("expected exactly seven held units, got %d", len(held))
	}
	for err := range failures {
		expectFailure(err, "insufficient_stock")
	}
	stock := run("stock", skus[0], "", 0, 0)
	if stock.Remaining != 7 || stock.Available != 0 {
		t.Fatal("concurrent reservations oversold or miscounted stock")
	}
	first := run("reserve", skus[0], held[0], 1, 0)
	if first.Reservation == nil || first.Reservation.State != "held" {
		t.Fatal("duplicate reserve changed state")
	}
	_, err = store.Execute(ctx, "reserve", skus[0], held[0], 2, 0)
	expectFailure(err, "reservation_conflict")
	_, err = store.Execute(ctx, "reserve", skus[1], held[0], 1, 0)
	expectFailure(err, "reservation_conflict")
	wg = sync.WaitGroup{}
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			result, err := store.Execute(ctx, "commit", skus[0], held[0], 0, 0)
			if err != nil || result.Reservation == nil || result.Reservation.State != "committed" {
				t.Error("duplicate commit failed")
			}
		}()
	}
	wg.Wait()
	stock = run("stock", skus[0], "", 0, 0)
	if stock.Remaining != 6 || stock.Available != 0 {
		t.Fatal("commit must decrement stock exactly once")
	}
	_, err = store.Execute(ctx, "release", skus[0], held[0], 0, 0)
	expectFailure(err, "reservation_closed")
	run("release", skus[0], held[1], 0, 0)
	run("release", skus[0], held[1], 0, 0)
	if run("stock", skus[0], "", 0, 0).Available != 1 {
		t.Fatal("release must restore availability exactly once")
	}
	_, err = store.Execute(ctx, "reserve", skus[0], held[1], 1, 0)
	expectFailure(err, "reservation_closed")

	// A lost response may mean the write happened; retrying its stable ID must consume only one hold.
	uncertainID := uuid.NewString()
	deadline, finish := context.WithTimeout(ctx, time.Millisecond)
	_, deadlineErr := store.Execute(deadline, "reserve", skus[0], uncertainID, 1, 0)
	if deadlineErr == nil || !errors.Is(deadline.Err(), context.DeadlineExceeded) {
		finish()
		t.Fatal("Expected a deadline while awaiting hosted Redis")
	}
	finish()
	retried := run("reserve", skus[0], uncertainID, 1, 0)
	if retried.Reservation == nil || retried.Reservation.State != "held" {
		t.Fatal("Timed-out reservation could not be retried")
	}
	stock = run("stock", skus[0], "", 0, 0)
	if stock.Remaining != 6 || stock.Available != 0 {
		t.Fatal("Deadline retry consumed stock twice")
	}

	expiring := NewStore(client, prefix, time.Second)
	oldID, newID := uuid.NewString(), uuid.NewString()
	if _, err = expiring.Execute(ctx, "reserve", skus[1], oldID, 1, 0); err != nil {
		t.Fatal("expiry reservation failed")
	}
	if ttl, err := client.PTTL(ctx, store.prefix+"lease:"+oldID).Result(); err != nil || ttl <= 0 || ttl > time.Second {
		t.Fatal("hold must have a real Redis TTL")
	}
	time.Sleep(1100 * time.Millisecond)
	if run("stock", skus[1], "", 0, 0).Available != 1 {
		t.Fatal("expired hold still consumes stock")
	}
	if _, err = expiring.Execute(ctx, "reserve", skus[1], newID, 1, 0); err != nil {
		t.Fatal("expired stock could not be reserved again")
	}
	_, err = store.Execute(ctx, "commit", skus[1], oldID, 0, 0)
	expectFailure(err, "reservation_closed")
	if run("stock", skus[1], "", 0, 0).Remaining != 1 {
		t.Fatal("late commit consumed stock")
	}
	if run("get", skus[1], oldID, 0, 0).Reservation.State != "expired" {
		t.Fatal("expired reservation state was lost")
	}

	cancelled, stop := context.WithCancel(ctx)
	stop()
	_, err = store.Execute(cancelled, "reserve", skus[0], uuid.NewString(), 1, 0)
	if !errors.Is(err, context.Canceled) {
		t.Fatal("cancelled request must fail without work")
	}
	// A fresh client represents service restart; retained reservation results must survive it.
	nextClient := redis.NewClient(cfg.Redis)
	defer nextClient.Close()
	restarted := NewStore(nextClient, prefix, 30*time.Second)
	result, err := restarted.Execute(ctx, "commit", skus[0], held[0], 0, 0)
	if err != nil || result.Reservation == nil || result.Reservation.State != "committed" {
		t.Fatal("restart lost idempotency state")
	}
	run("seed", skus[0], "", 0, 99)
	if run("stock", skus[0], "", 0, 0).Remaining != 6 {
		t.Fatal("seed overwrote existing stock")
	}
	leaseIDs, _ = client.HKeys(ctx, store.prefix+"reservations").Result()
	run("reset", skus[0], "", 0, 7)
	stock = run("stock", skus[0], "", 0, 0)
	if stock.Remaining != 7 || stock.Available != 7 {
		t.Fatal("SKU reset was not deterministic")
	}
	if run("stock", skus[1], "", 0, 0).Remaining != 1 {
		t.Fatal("reset changed another SKU")
	}
}
