package orders

import (
	"context"
	"errors"
	"net/mail"
	"regexp"

	"github.com/google/uuid"
)

var (
	ErrNotFound      = errors.New("order not found")
	ErrUnauthorized  = errors.New("a valid session is required")
	ErrSKU           = errors.New("SKU must contain 1 to 64 letters, digits, dots, underscores or hyphens, starting with a letter or digit")
	ErrQuantity      = errors.New("quantity must be between 1 and 1000")
	ErrEventConflict = errors.New("event ID was reused with different content")
	ErrTransition    = errors.New("order is already final with a different outcome")
	ErrSettlement    = errors.New("invalid settlement")
	ErrID            = errors.New("a valid order ID is required")
	hashPattern      = regexp.MustCompile(`^[a-f0-9]{64}$`)
	skuPattern       = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)
)

type Service struct{ repository *Repository }

func NewService(repository *Repository) *Service { return &Service{repository: repository} }

func (s *Service) Create(ctx context.Context, owner uuid.UUID, email, sku string, quantity int32) (Order, error) {
	if owner == uuid.Nil {
		return Order{}, ErrUnauthorized
	}
	if !validContact(email) {
		return Order{}, ErrUnauthorized
	}
	if !skuPattern.MatchString(sku) {
		return Order{}, ErrSKU
	}
	if quantity < 1 || quantity > 1000 {
		return Order{}, ErrQuantity
	}
	return s.repository.Create(ctx, owner, email, sku, quantity)
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

type Settlement struct {
	OrderID, EventID, PaymentID    uuid.UUID
	PayloadHash, Status, RequestID string
}

func (s *Service) Prepare(ctx context.Context, input Settlement) (Order, error) {
	if input.OrderID == uuid.Nil || input.EventID == uuid.Nil || !hashPattern.MatchString(input.PayloadHash) {
		return Order{}, ErrSettlement
	}
	return s.repository.Prepare(ctx, input)
}
func (s *Service) Finalize(ctx context.Context, input Settlement) (Order, error) {
	if input.OrderID == uuid.Nil || input.EventID == uuid.Nil || input.PaymentID == uuid.Nil || !hashPattern.MatchString(input.PayloadHash) || !requestIDPattern.MatchString(input.RequestID) || (input.Status != "confirmed" && input.Status != "failed" && input.Status != "refunded") {
		return Order{}, ErrSettlement
	}
	return s.repository.Finalize(ctx, input)
}

func validContact(email string) bool {
	address, err := mail.ParseAddress(email)
	return err == nil && len(email) <= 254 && address.Address == email
}
