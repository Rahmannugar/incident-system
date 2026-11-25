package orders

import (
	"context"
	"crypto/rand"
	"errors"
	"log/slog"
	"regexp"
	"strings"
	"time"

	identityv1 "github.com/Rahmannugar/incident-system/packages/contracts/gen/go/incident/identity/v1"
	orderv1 "github.com/Rahmannugar/incident-system/packages/contracts/gen/go/incident/order/v1"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

type ownerKey struct{}
type requestIDKey struct{}

var requestIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
var tokenPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)

type Server struct {
	orderv1.UnimplementedOrderServiceServer
	service  *Service
	identity identityv1.IdentityServiceClient
	timeout  time.Duration
	logger   *slog.Logger
}

func NewServer(service *Service, identity identityv1.IdentityServiceClient, timeout time.Duration, logger *slog.Logger) *Server {
	return &Server{service: service, identity: identity, timeout: timeout, logger: logger}
}

func (s *Server) authenticate(ctx context.Context, requestID string) (uuid.UUID, error) {
	incoming, _ := metadata.FromIncomingContext(ctx)
	values := incoming.Get("authorization")
	if len(values) != 1 {
		return uuid.Nil, status.Error(codes.Unauthenticated, "A valid session is required")
	}
	parts := strings.Fields(values[0])
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") || !tokenPattern.MatchString(parts[1]) {
		return uuid.Nil, status.Error(codes.Unauthenticated, "A valid session is required")
	}
	outgoing := metadata.NewOutgoingContext(ctx, metadata.Pairs("x-request-id", requestID))
	session, err := s.identity.GetSession(outgoing, &identityv1.GetSessionRequest{Token: parts[1]})
	if err != nil {
		code := status.Code(err)
		if code == codes.Unauthenticated {
			return uuid.Nil, status.Error(codes.Unauthenticated, "A valid session is required")
		}
		s.logger.Warn("dependency.failed", "service", "order", "dependency", "identity", "request_id", requestID, "code", code.String())
		if code == codes.DeadlineExceeded || errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return uuid.Nil, status.Error(codes.DeadlineExceeded, "Identity service timed out")
		}
		return uuid.Nil, status.Error(codes.Unavailable, "Identity service is unavailable")
	}
	if session == nil || session.User == nil {
		return uuid.Nil, status.Error(codes.Unavailable, "Identity returned an invalid session")
	}
	owner, err := uuid.Parse(session.User.Id)
	if err != nil || owner == uuid.Nil {
		return uuid.Nil, status.Error(codes.Unavailable, "Identity returned an invalid session")
	}
	return owner, nil
}

func (s *Server) Intercept(ctx context.Context, req interface{}, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (response interface{}, err error) {
	start := time.Now()
	incoming, _ := metadata.FromIncomingContext(ctx)
	requestID := rand.Text()
	if ids := incoming.Get("x-request-id"); len(ids) == 1 && requestIDPattern.MatchString(ids[0]) {
		requestID = ids[0]
	}
	ctx, cancel := context.WithTimeout(ctx, s.timeout)
	defer cancel()
	ctx = context.WithValue(ctx, requestIDKey{}, requestID)
	defer func() {
		code := status.Code(err)
		level := slog.LevelInfo
		if code == codes.Internal {
			level = slog.LevelError
		} else if code == codes.Unavailable || code == codes.DeadlineExceeded {
			level = slog.LevelWarn
		}
		s.logger.Log(ctx, level, "rpc.completed", "service", "order", "operation", info.FullMethod, "request_id", requestID, "code", code.String(), "duration_ms", time.Since(start).Milliseconds())
	}()
	if info.FullMethod != orderv1.OrderService_CheckHealth_FullMethodName {
		owner, authErr := s.authenticate(ctx, requestID)
		if authErr != nil {
			return nil, authErr
		}
		ctx = context.WithValue(ctx, ownerKey{}, owner)
	}
	return handler(ctx, req)
}

func rpcError(ctx context.Context, err error) error {
	switch {
	case errors.Is(err, ErrUnauthorized):
		return status.Error(codes.Unauthenticated, ErrUnauthorized.Error())
	case errors.Is(err, ErrSKU), errors.Is(err, ErrQuantity), errors.Is(err, ErrID):
		return status.Error(codes.InvalidArgument, err.Error())
	case errors.Is(err, ErrNotFound):
		return status.Error(codes.NotFound, ErrNotFound.Error())
	case errors.Is(ctx.Err(), context.DeadlineExceeded):
		return status.Error(codes.DeadlineExceeded, "Order operation timed out")
	case errors.Is(ctx.Err(), context.Canceled):
		return status.Error(codes.Canceled, "Request cancelled")
	}
	var databaseError *pgconn.PgError
	if errors.As(err, &databaseError) && databaseError.Code == "57014" {
		return status.Error(codes.DeadlineExceeded, "Order operation timed out")
	}
	return status.Error(codes.Internal, "Internal service error")
}

func owner(ctx context.Context) uuid.UUID { id, _ := ctx.Value(ownerKey{}).(uuid.UUID); return id }
func wire(order Order) *orderv1.Order {
	return &orderv1.Order{Id: order.ID.String(), Sku: order.SKU, Quantity: order.Quantity, Status: order.Status, CreatedAtUnix: order.CreatedAt.Unix()}
}

func (s *Server) CreateOrder(ctx context.Context, request *orderv1.CreateOrderRequest) (*orderv1.CreateOrderResponse, error) {
	order, err := s.service.Create(ctx, owner(ctx), request.Sku, request.Quantity)
	if err != nil {
		return nil, rpcError(ctx, err)
	}
	requestID, _ := ctx.Value(requestIDKey{}).(string)
	s.logger.Info("order.created", "service", "order", "order_id", order.ID.String(), "request_id", requestID)
	return &orderv1.CreateOrderResponse{Order: wire(order)}, nil
}

func (s *Server) GetOrder(ctx context.Context, request *orderv1.GetOrderRequest) (*orderv1.GetOrderResponse, error) {
	order, err := s.service.Get(ctx, owner(ctx), request.Id)
	if err != nil {
		return nil, rpcError(ctx, err)
	}
	return &orderv1.GetOrderResponse{Order: wire(order)}, nil
}

func (s *Server) CheckHealth(ctx context.Context, _ *orderv1.CheckHealthRequest) (*orderv1.CheckHealthResponse, error) {
	if err := s.service.repository.Health(ctx); err != nil {
		return nil, status.Error(codes.Unavailable, "Order database is unavailable")
	}
	health, err := s.identity.CheckHealth(ctx, &identityv1.CheckHealthRequest{})
	if err != nil || !health.GetHealthy() {
		return nil, status.Error(codes.Unavailable, "Identity service is unavailable")
	}
	return &orderv1.CheckHealthResponse{Healthy: true}, nil
}
