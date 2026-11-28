package inventory

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"errors"
	"github.com/Rahmannugar/incident-system/packages/telemetry"
	"log/slog"
	"net"
	"regexp"
	"time"

	inventoryv1 "github.com/Rahmannugar/incident-system/packages/contracts/gen/go/incident/inventory/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

type requestIDKey struct{}

type Server struct {
	inventoryv1.UnimplementedInventoryServiceServer
	store   *Store
	token   string
	timeout time.Duration
	logger  *slog.Logger
}

func NewServer(store *Store, token string, timeout time.Duration, logger *slog.Logger) *Server {
	return &Server{store: store, token: token, timeout: timeout, logger: logger}
}

var requestIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

func (s *Server) Intercept(ctx context.Context, req interface{}, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (response interface{}, err error) {
	start := time.Now()
	md, _ := metadata.FromIncomingContext(ctx)
	requestID := rand.Text()
	if ids := md.Get("x-request-id"); len(ids) == 1 && requestIDPattern.MatchString(ids[0]) {
		requestID = ids[0]
	}
	ctx, cancel := context.WithTimeout(ctx, s.timeout)
	defer cancel()
	ctx = context.WithValue(ctx, requestIDKey{}, requestID)
	defer func() {
		telemetry.LogRPC(ctx, s.logger, "inventory", info.FullMethod, requestID, err, start, telemetry.RPCFields(req)...)
	}()
	if info.FullMethod != inventoryv1.InventoryService_CheckHealth_FullMethodName {
		// Customer bearer tokens cannot authorise stock commitment; only an internal service credential can.
		values := md.Get("x-service-token")
		if len(values) != 1 || subtle.ConstantTimeCompare([]byte(values[0]), []byte(s.token)) != 1 {
			return nil, status.Error(codes.Unauthenticated, "Internal service authentication required")
		}
	}
	return handler(ctx, req)
}
func failure(ctx context.Context, err error) error {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return status.Error(codes.DeadlineExceeded, "Inventory operation timed out")
	}
	if errors.Is(ctx.Err(), context.Canceled) {
		return status.Error(codes.Canceled, "Request cancelled")
	}
	var timeout net.Error
	if errors.As(err, &timeout) && timeout.Timeout() {
		return status.Error(codes.DeadlineExceeded, "Inventory operation timed out")
	}
	var domain *Failure
	if errors.As(err, &domain) {
		switch domain.Code {
		case "invalid_sku", "invalid_order_id", "invalid_quantity", "invalid_stock":
			return status.Error(codes.InvalidArgument, domain.Code)
		case "sku_not_found", "reservation_not_found":
			return status.Error(codes.NotFound, domain.Code)
		case "insufficient_stock":
			return status.Error(codes.Aborted, domain.Code)
		case "reservation_conflict":
			return status.Error(codes.AlreadyExists, domain.Code)
		case "reservation_closed":
			return status.Error(codes.FailedPrecondition, domain.Code)
		case "inventory_capacity":
			return status.Error(codes.ResourceExhausted, domain.Code)
		default:
			return status.Error(codes.Internal, "Inventory state is invalid")
		}
	}
	return status.Error(codes.Unavailable, "Inventory storage is unavailable")
}
func (s *Server) reservation(ctx context.Context, op, sku, id string, quantity int32) (*inventoryv1.Reservation, error) {
	requestID, _ := ctx.Value(requestIDKey{}).(string)
	result, err := s.store.Execute(ctx, op, sku, id, quantity, 0)
	if err != nil {
		s.logger.WarnContext(ctx, "inventory.operation_failed", "service", "inventory", "message", "Inventory reservation operation failed", "operation", op, "order_id", telemetry.LogID(id), "request_id", requestID, "error_message", status.Convert(failure(ctx, err)).Message(), "code", status.Code(failure(ctx, err)).String())
		return nil, failure(ctx, err)
	}
	r := result.Reservation
	if r == nil {
		return nil, status.Error(codes.Internal, "Inventory returned an invalid reservation")
	}
	s.logger.InfoContext(ctx, "inventory.reservation", "service", "inventory", "message", "Inventory reservation operation succeeded", "operation", op, "request_id", requestID, "order_id", r.OrderID, "sku", r.SKU, "quantity", r.Quantity, "reservation_state", r.State)
	return &inventoryv1.Reservation{OrderId: r.OrderID, Sku: r.SKU, Quantity: r.Quantity, State: r.State, ExpiresAtUnixMs: r.ExpiresAt}, nil
}
func (s *Server) Reserve(ctx context.Context, r *inventoryv1.ReserveRequest) (*inventoryv1.ReserveResponse, error) {
	reservation, err := s.reservation(ctx, "reserve", r.Sku, r.OrderId, r.Quantity)
	if err != nil {
		return nil, err
	}
	return &inventoryv1.ReserveResponse{Reservation: reservation}, nil
}
func (s *Server) GetReservation(ctx context.Context, r *inventoryv1.GetReservationRequest) (*inventoryv1.GetReservationResponse, error) {
	reservation, err := s.reservation(ctx, "get", r.Sku, r.OrderId, 0)
	if err != nil {
		return nil, err
	}
	return &inventoryv1.GetReservationResponse{Reservation: reservation}, nil
}
func (s *Server) Commit(ctx context.Context, r *inventoryv1.CommitRequest) (*inventoryv1.CommitResponse, error) {
	reservation, err := s.reservation(ctx, "commit", r.Sku, r.OrderId, 0)
	if err != nil {
		return nil, err
	}
	return &inventoryv1.CommitResponse{Reservation: reservation}, nil
}
func (s *Server) Release(ctx context.Context, r *inventoryv1.ReleaseRequest) (*inventoryv1.ReleaseResponse, error) {
	reservation, err := s.reservation(ctx, "release", r.Sku, r.OrderId, 0)
	if err != nil {
		return nil, err
	}
	return &inventoryv1.ReleaseResponse{Reservation: reservation}, nil
}
func (s *Server) CheckStock(ctx context.Context, r *inventoryv1.CheckStockRequest) (*inventoryv1.CheckStockResponse, error) {
	result, err := s.store.Execute(ctx, "stock", r.Sku, "", 0, 0)
	if err != nil {
		s.logger.WarnContext(ctx, "inventory.operation_failed", "service", "inventory", "message", "Inventory operation failed", "error_message", status.Convert(failure(ctx, err)).Message(), "code", status.Code(failure(ctx, err)).String())
		return nil, failure(ctx, err)
	}
	return &inventoryv1.CheckStockResponse{Sku: r.Sku, Remaining: result.Remaining, Available: result.Available}, nil
}
func (s *Server) CheckHealth(ctx context.Context, _ *inventoryv1.CheckHealthRequest) (*inventoryv1.CheckHealthResponse, error) {
	if err := s.store.Health(ctx); err != nil {
		s.logger.WarnContext(ctx, "inventory.operation_failed", "service", "inventory", "message", "Inventory operation failed", "error_message", status.Convert(failure(ctx, err)).Message(), "code", status.Code(failure(ctx, err)).String())
		return nil, failure(ctx, err)
	}
	return &inventoryv1.CheckHealthResponse{Healthy: true}, nil
}
