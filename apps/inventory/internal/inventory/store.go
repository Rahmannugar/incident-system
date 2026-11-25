package inventory

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"regexp"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

//go:embed operations.lua
var operations string

var skuPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

type Failure struct{ Code string }

func (e *Failure) Error() string { return e.Code }

type Reservation struct {
	OrderID   string `json:"order_id"`
	SKU       string `json:"sku"`
	Quantity  int32  `json:"quantity"`
	State     string `json:"state"`
	ExpiresAt int64  `json:"expires_at_unix_ms"`
}
type Result struct {
	Error       string       `json:"error"`
	Remaining   int32        `json:"remaining"`
	Available   int32        `json:"available"`
	Reservation *Reservation `json:"reservation"`
}
type Store struct {
	client *redis.Client
	prefix string
	ttl    time.Duration
}

func NewStore(client *redis.Client, prefix string, ttl time.Duration) *Store {
	return &Store{client: client, prefix: prefix + "{inventory}:", ttl: ttl}
}
func (s *Store) Health(ctx context.Context) error { return s.client.Ping(ctx).Err() }
func (s *Store) Execute(ctx context.Context, op, sku, id string, quantity, initial int32) (Result, error) {
	if !skuPattern.MatchString(sku) {
		return Result{}, &Failure{"invalid_sku"}
	}
	switch op {
	case "reserve", "get", "commit", "release":
		parsed, err := uuid.Parse(id)
		if err != nil || parsed == uuid.Nil {
			return Result{}, &Failure{"invalid_order_id"}
		}
		id = parsed.String()
	case "stock", "seed", "reset", "remove":
	default:
		return Result{}, errors.New("invalid inventory operation")
	}
	if op == "reserve" && (quantity < 1 || quantity > 1000) {
		return Result{}, &Failure{"invalid_quantity"}
	}
	if (op == "seed" || op == "reset") && (initial < 0 || initial > 1000000) {
		return Result{}, &Failure{"invalid_stock"}
	}
	keys := []string{s.prefix + "stock:" + sku, s.prefix + "holds:" + sku, s.prefix + "quantities:" + sku, s.prefix + "reservations", s.prefix + "lease:" + id}
	if op == "reset" || op == "remove" {
		// Reset is an explicit maintenance command for a stopped workflow, not a checkout operation.
		records, err := s.client.HGetAll(ctx, s.prefix+"reservations").Result()
		if err != nil {
			return Result{}, err
		}
		for orderID, encoded := range records {
			var reservation Reservation
			if json.Unmarshal([]byte(encoded), &reservation) != nil {
				return Result{}, &Failure{"corrupt_state"}
			}
			if reservation.SKU == sku {
				keys = append(keys, s.prefix+"lease:"+orderID)
			}
		}
	}
	// Do not automatically retry ambiguous writes. Repeating the same order ID is safe explicitly.
	raw, err := s.client.Eval(ctx, operations, keys, op, sku, id, quantity, s.ttl.Milliseconds(), initial).Text()
	if err != nil {
		return Result{}, err
	}
	var result Result
	if err := json.Unmarshal([]byte(raw), &result); err != nil {
		return Result{}, errors.New("invalid inventory response")
	}
	if result.Error != "" {
		return Result{}, &Failure{result.Error}
	}
	return result, nil
}
