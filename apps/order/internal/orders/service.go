package orders

import (
	"context"
	"errors"
	"regexp"

	"github.com/google/uuid"
)

var (
	ErrNotFound     = errors.New("order not found")
	ErrUnauthorized = errors.New("a valid session is required")
	ErrSKU          = errors.New("SKU must contain 1 to 64 letters, digits, dots, underscores or hyphens, starting with a letter or digit")
	ErrQuantity     = errors.New("quantity must be between 1 and 1000")
	ErrID           = errors.New("a valid order ID is required")
	skuPattern      = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)
)

type Service struct{ repository *Repository }

func NewService(repository *Repository) *Service { return &Service{repository: repository} }

func (s *Service) Create(ctx context.Context, owner uuid.UUID, sku string, quantity int32) (Order, error) {
	if owner == uuid.Nil {
		return Order{}, ErrUnauthorized
	}
	if !skuPattern.MatchString(sku) {
		return Order{}, ErrSKU
	}
	if quantity < 1 || quantity > 1000 {
		return Order{}, ErrQuantity
	}
	return s.repository.Create(ctx, owner, sku, quantity)
}

func (s *Service) Get(ctx context.Context, owner uuid.UUID, rawID string) (Order, error) {
	if owner == uuid.Nil {
		return Order{}, ErrUnauthorized
	}
	id, err := uuid.Parse(rawID)
	if err != nil || id == uuid.Nil {
		return Order{}, ErrID
	}
	return s.repository.GetOwned(ctx, owner, id)
}
