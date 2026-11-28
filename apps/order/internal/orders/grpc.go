package orders

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"errors"
	"github.com/Rahmannugar/incident-system/packages/telemetry"
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
type emailKey struct{}
type requestIDKey struct{}

var requestIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
var tokenPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)

type Server struct {
	orderv1.UnimplementedOrderServiceServer
	token    string
	service  *Service
	identity identityv1.IdentityServiceClient
	timeout  time.Duration
	logger   *slog.Logger
}

func NewServer(service *Service, identity identityv1.IdentityServiceClient, timeout time.Duration, logger *slog.Logger, token string) *Server {
	return &Server{token: token, service: service, identity: identity, timeout: timeout, logger: logger}
}

func (s *Server) authenticate(ctx context.Context, requestID string) (uuid.UUID, string, error) {
	incoming, _ := metadata.FromIncomingContext(ctx)
	values := incoming.Get("authorization")
	if len(values) != 1 {
		return uuid.Nil, "", status.Error(codes.Unauthenticated, "A valid session is required")
	}
	parts := strings.Fields(values[0])
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") || !tokenPattern.MatchString(parts[1]) {
		return uuid.Nil, "", status.Error(codes.Unauthenticated, "A valid session is required")
	}
	outgoing := metadata.NewOutgoingContext(ctx, metadata.Pairs("x-request-id", requestID))
	session, err := s.identity.GetSession(outgoing, &identityv1.GetSessionRequest{Token: parts[1]})
	if err != nil {
		code := status.Code(err)
		if code == codes.Unauthenticated {
			return uuid.Nil, "", status.Error(codes.Unauthenticated, "A valid session is required")
		}
		s.logger.WarnContext(ctx, "dependency.failed", "message", "Identity session lookup failed", "service", "order", "dependency", "identity", "request_id", requestID, "code", code.String())
		if code == codes.DeadlineExceeded || errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return uuid.Nil, "", status.Error(codes.DeadlineExceeded, "Identity service timed out")
		}
		return uuid.Nil, "", status.Error(codes.Unavailable, "Identity service is unavailable")
	}
	if session == nil || session.User == nil {
		return uuid.Nil, "", status.Error(codes.Unavailable, "Identity returned an invalid session")
	}
	owner, err := uuid.Parse(session.User.Id)
	if err != nil || owner == uuid.Nil {
		return uuid.Nil, "", status.Error(codes.Unavailable, "Identity returned an invalid session")
	}
	if !validContact(session.User.Email) {
		return uuid.Nil, "", status.Error(codes.Unavailable, "Identity returned an invalid contact")
	}
	return owner, session.User.Email, nil
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
		telemetry.LogRPC(ctx, s.logger, "order", info.FullMethod, requestID, err, start, telemetry.RPCFields(req)...)
	}()
	if info.FullMethod == orderv1.OrderService_PrepareOrderSettlement_FullMethodName || info.FullMethod == orderv1.OrderService_FinalizeOrder_FullMethodName {
		values := incoming.Get("x-service-token")
		if len(values) != 1 || subtle.ConstantTimeCompare([]byte(values[0]), []byte(s.token)) != 1 {
			return nil, status.Error(codes.Unauthenticated, "Internal service authentication required")
		}
	} else if info.FullMethod != orderv1.OrderService_CheckHealth_FullMethodName {
		owner, email, authErr := s.authenticate(ctx, requestID)
		if authErr != nil {
			return nil, authErr
		}
		ctx = context.WithValue(ctx, ownerKey{}, owner)
		ctx = context.WithValue(ctx, emailKey{}, email)
	}
	return handler(ctx, req)
}

func (s *Server) rpcError(ctx context.Context, err error) error {
	switch {
	case errors.Is(err, ErrUnauthorized):
		return status.Error(codes.Unauthenticated, ErrUnauthorized.Error())
	case errors.Is(err, ErrSKU), errors.Is(err, ErrQuantity), errors.Is(err, ErrID), errors.Is(err, ErrSettlement):
		return status.Error(codes.InvalidArgument, err.Error())
	case errors.Is(err, ErrEventConflict):
		return status.Error(codes.AlreadyExists, err.Error())
	case errors.Is(err, ErrTransition):
		return status.Error(codes.FailedPrecondition, err.Error())
	case errors.Is(err, ErrNotFound):
		return status.Error(codes.NotFound, ErrNotFound.Error())
	case errors.Is(ctx.Err(), context.DeadlineExceeded):
		return status.Error(codes.DeadlineExceeded, "Order operation timed out")
	case errors.Is(ctx.Err(), context.Canceled):
		return status.Error(codes.Canceled, "Request cancelled")
	}
	var databaseError *pgconn.PgError
	if errors.As(err, &databaseError) {
		s.logDatabaseFailure(ctx, err)
	}
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
	email, _ := ctx.Value(emailKey{}).(string)
	order, err := s.service.Create(ctx, owner(ctx), email, request.Sku, request.Quantity)
	if err != nil {
		return nil, s.rpcError(ctx, err)
	}
	requestID, _ := ctx.Value(requestIDKey{}).(string)
	s.logger.InfoContext(ctx, "order.created", "service", "order", "order_id", order.ID.String(), "status", order.Status, "sku", order.SKU, "quantity", order.Quantity, "request_id", requestID)
	return &orderv1.CreateOrderResponse{Order: wire(order)}, nil
}

func (s *Server) GetOrder(ctx context.Context, request *orderv1.GetOrderRequest) (*orderv1.GetOrderResponse, error) {
	order, err := s.service.Get(ctx, owner(ctx), request.Id)
	if err != nil {
		return nil, s.rpcError(ctx, err)
	}
	return &orderv1.GetOrderResponse{Order: wire(order)}, nil
}

func (s *Server) CheckHealth(ctx context.Context, _ *orderv1.CheckHealthRequest) (*orderv1.CheckHealthResponse, error) {
	if err := s.service.repository.Health(ctx); err != nil {
		s.logDatabaseFailure(ctx, err)
		return nil, status.Error(codes.Unavailable, "Order database is unavailable")
	}
	health, err := s.identity.CheckHealth(ctx, &identityv1.CheckHealthRequest{})
	if err != nil || !health.GetHealthy() {
		return nil, status.Error(codes.Unavailable, "Identity service is unavailable")
	}
	return &orderv1.CheckHealthResponse{Healthy: true}, nil
}

func (s *Server) PrepareOrderSettlement(ctx context.Context, request *orderv1.PrepareOrderSettlementRequest) (*orderv1.PrepareOrderSettlementResponse, error) {
	id, e1 := uuid.Parse(request.Id)
	event, e2 := uuid.Parse(request.EventId)
	if e1 != nil || e2 != nil {
		return nil, s.rpcError(ctx, ErrSettlement)
	}
	order, err := s.service.Prepare(ctx, Settlement{OrderID: id, EventID: event, PayloadHash: request.PayloadHash})
	if err != nil {
		return nil, s.rpcError(ctx, err)
	}
	paymentID := ""
	if order.PaymentID != uuid.Nil {
		paymentID = order.PaymentID.String()
	}
	return &orderv1.PrepareOrderSettlementResponse{Order: wire(order), PaymentId: paymentID}, nil
}
func (s *Server) FinalizeOrder(ctx context.Context, request *orderv1.FinalizeOrderRequest) (*orderv1.FinalizeOrderResponse, error) {
	id, e1 := uuid.Parse(request.Id)
	event, e2 := uuid.Parse(request.EventId)
	payment, e3 := uuid.Parse(request.PaymentId)
	if e1 != nil || e2 != nil || e3 != nil {
		return nil, s.rpcError(ctx, ErrSettlement)
	}
	requestID, _ := ctx.Value(requestIDKey{}).(string)
	order, err := s.service.Finalize(ctx, Settlement{OrderID: id, EventID: event, PaymentID: payment, PayloadHash: request.PayloadHash, Status: request.Status, RequestID: requestID})
	if err != nil {
		return nil, s.rpcError(ctx, err)
	}
	s.logger.InfoContext(ctx, "order.finalized", "service", "order", "message", "Order finalized and customer notification queued", "order_id", id.String(), "payment_id", payment.String(), "event_id", event.String(), "status", order.Status, "request_id", requestID)
	return &orderv1.FinalizeOrderResponse{Order: wire(order)}, nil
}

func (s *Server) logDatabaseFailure(ctx context.Context, err error) {
	requestID, _ := ctx.Value(requestIDKey{}).(string)
	fields := []interface{}{"service", "order", "message", "Order database operation failed", "dependency", "postgresql", "error_type", "database", "request_id", requestID}
	var databaseError *pgconn.PgError
	if errors.As(err, &databaseError) {
		fields = append(fields, "sqlstate", databaseError.Code)
	}
	s.logger.ErrorContext(ctx, "database.operation_failed", fields...)
}
