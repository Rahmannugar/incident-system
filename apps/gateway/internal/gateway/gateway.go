package gateway

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"strings"
	"time"

	identityv1 "github.com/Rahmannugar/incident-system/packages/contracts/gen/go/incident/identity/v1"
	orderv1 "github.com/Rahmannugar/incident-system/packages/contracts/gen/go/incident/order/v1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

type API struct {
	client  identityv1.IdentityServiceClient
	orders  orderv1.OrderServiceClient
	timeout time.Duration
	logger  *slog.Logger
}

type credentials struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}
type user struct {
	ID    string `json:"id"`
	Email string `json:"email"`
}
type session struct {
	User      user      `json:"user"`
	Token     string    `json:"token,omitempty"`
	ExpiresAt time.Time `json:"expires_at"`
}
type failure struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func New(client identityv1.IdentityServiceClient, orders orderv1.OrderServiceClient, timeout time.Duration, logger *slog.Logger) http.Handler {
	api := &API{client: client, orders: orders, timeout: timeout, logger: logger}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /orders", api.createOrder)
	mux.HandleFunc("GET /orders/{id}", api.getOrder)
	mux.HandleFunc("POST /auth/signup", api.signup)
	mux.HandleFunc("POST /auth/login", api.login)
	mux.HandleFunc("POST /auth/logout", api.logout)
	mux.HandleFunc("GET /auth/me", api.me)
	mux.HandleFunc("GET /health/live", func(w http.ResponseWriter, r *http.Request) {
		write(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("GET /health/ready", api.ready)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		reject(w, http.StatusNotFound, "not_found", "Route not found")
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestID := r.Header.Get("X-Request-ID")
		if !validRequestID(requestID) {
			requestID = rand.Text()
		}
		w.Header().Set("X-Request-ID", requestID)
		w.Header().Set("Cache-Control", "no-store")
		ctx := metadata.AppendToOutgoingContext(r.Context(), "x-request-id", requestID)
		mux.ServeHTTP(w, r.WithContext(ctx))
	})
}

func validRequestID(value string) bool {
	if len(value) == 0 || len(value) > 64 {
		return false
	}
	for _, c := range value {
		if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '-') {
			return false
		}
	}
	return true
}

func write(w http.ResponseWriter, code int, value interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(value)
}

func reject(w http.ResponseWriter, code int, name, message string) {
	write(w, code, struct {
		Error failure `json:"error"`
	}{Error: failure{name, message}})
}

func decode(w http.ResponseWriter, r *http.Request) (credentials, bool) {
	var input credentials
	ok := decodeJSON(w, r, &input, "Expected an email and password JSON object")
	return input, ok
}

func decodeJSON(w http.ResponseWriter, r *http.Request, input interface{}, message string) bool {
	contentType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || contentType != "application/json" {
		reject(w, 415, "unsupported_media_type", "Content-Type must be application/json")
		return false
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	err = decoder.Decode(input)
	if err == nil {
		var extra interface{}
		if e := decoder.Decode(&extra); e != io.EOF {
			err = errors.New("unexpected trailing data")
		}
	}
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			reject(w, 413, "body_too_large", "Request body is too large")
		} else {
			reject(w, 400, "invalid_request", message)
		}
		return false
	}
	return true
}

func (a *API) callContext(r *http.Request) (context.Context, context.CancelFunc) {
	return context.WithTimeout(r.Context(), a.timeout)
}

func (a *API) rpcFailure(w http.ResponseWriter, r *http.Request, operation string, err error) {
	code, name, message := http.StatusInternalServerError, "internal_error", "An internal error occurred"
	dependency := "Identity"
	if strings.HasPrefix(operation, "order.") {
		dependency = "Order"
	}
	switch status.Code(err) {
	case codes.InvalidArgument:
		code, name, message = 400, "invalid_request", status.Convert(err).Message()
	case codes.NotFound:
		code, name, message = 404, "order_not_found", "Order not found"
	case codes.AlreadyExists:
		code, name, message = 409, "email_exists", "An account with this email already exists"
	case codes.Unauthenticated:
		code, name, message = 401, "unauthorized", "A valid session is required"
		if operation == "auth.login" {
			name, message = "invalid_credentials", "Email or password is incorrect"
		}
	case codes.ResourceExhausted:
		code, name, message = 429, "auth_busy", "Authentication is busy; retry shortly"
	case codes.Unavailable:
		code, name, message = 503, "service_unavailable", dependency+" service is unavailable"
	case codes.DeadlineExceeded:
		code, name, message = 504, "upstream_timeout", dependency+" service timed out"
	case codes.Canceled:
		if r.Context().Err() != nil {
			return
		}
	}
	md, _ := metadata.FromOutgoingContext(r.Context())
	requestID := ""
	if values := md.Get("x-request-id"); len(values) > 0 {
		requestID = values[0]
	}
	level := slog.LevelInfo
	if code == 503 || code == 504 {
		level = slog.LevelWarn
	} else if code >= 500 {
		level = slog.LevelError
	}
	a.logger.Log(r.Context(), level, "request.failed", "service", "gateway", "operation", operation, "request_id", requestID, "status", code, "code", name)
	reject(w, code, name, message)
}

func asUser(input *identityv1.User) (user, bool) {
	if input == nil || input.Id == "" || input.Email == "" {
		return user{}, false
	}
	return user{ID: input.Id, Email: input.Email}, true
}

func (a *API) signup(w http.ResponseWriter, r *http.Request) {
	input, ok := decode(w, r)
	if !ok {
		return
	}
	ctx, cancel := a.callContext(r)
	defer cancel()
	result, err := a.client.SignUp(ctx, &identityv1.SignUpRequest{Email: input.Email, Password: input.Password})
	if err != nil {
		a.rpcFailure(w, r, "auth.signup", err)
		return
	}
	a.writeSession(w, result.User, result.Token, result.ExpiresAtUnix, http.StatusCreated)
}

func (a *API) login(w http.ResponseWriter, r *http.Request) {
	input, ok := decode(w, r)
	if !ok {
		return
	}
	ctx, cancel := a.callContext(r)
	defer cancel()
	result, err := a.client.Login(ctx, &identityv1.LoginRequest{Email: input.Email, Password: input.Password})
	if err != nil {
		a.rpcFailure(w, r, "auth.login", err)
		return
	}
	a.writeSession(w, result.User, result.Token, result.ExpiresAtUnix, http.StatusOK)
}

func (a *API) writeSession(w http.ResponseWriter, input *identityv1.User, token string, expires int64, code int) {
	u, ok := asUser(input)
	if !ok || len(token) != 43 || expires <= time.Now().Unix() {
		reject(w, 502, "invalid_upstream_response", "Identity returned an invalid response")
		return
	}
	write(w, code, session{User: u, Token: token, ExpiresAt: time.Unix(expires, 0).UTC()})
}

func (a *API) me(w http.ResponseWriter, r *http.Request) {
	if !bearerAuthorization(w, r) {
		return
	}
	header := r.Header.Get("Authorization")
	ctx, cancel := a.callContext(r)
	defer cancel()
	result, err := a.client.GetSession(ctx, &identityv1.GetSessionRequest{Token: strings.TrimPrefix(header, "Bearer ")})
	if err != nil {
		a.rpcFailure(w, r, "auth.session", err)
		return
	}
	u, ok := asUser(result.User)
	if !ok {
		reject(w, 502, "invalid_upstream_response", "Identity returned an invalid response")
		return
	}
	write(w, 200, session{User: u, ExpiresAt: time.Unix(result.ExpiresAtUnix, 0).UTC()})
}

func (a *API) ready(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := a.callContext(r)
	defer cancel()
	result, err := a.client.CheckHealth(ctx, &identityv1.CheckHealthRequest{})
	if err != nil {
		a.rpcFailure(w, r, "health.ready", err)
		return
	}
	if !result.Healthy {
		reject(w, 503, "service_unavailable", "Identity service is unavailable")
		return
	}
	orderHealth, err := a.orders.CheckHealth(ctx, &orderv1.CheckHealthRequest{})
	if err != nil {
		a.rpcFailure(w, r, "order.health", err)
		return
	}
	if !orderHealth.GetHealthy() {
		reject(w, 503, "service_unavailable", "Order service is unavailable")
		return
	}
	write(w, 200, map[string]string{"status": "ok"})
}

func bearerAuthorization(w http.ResponseWriter, r *http.Request) bool {
	values := r.Header.Values("Authorization")
	if len(values) != 1 || !strings.HasPrefix(values[0], "Bearer ") || len(values[0]) != 50 {
		reject(w, 401, "unauthorized", "A valid session is required")
		return false
	}
	return true
}

func (a *API) logout(w http.ResponseWriter, r *http.Request) {
	if !bearerAuthorization(w, r) {
		return
	}
	ctx, cancel := a.callContext(r)
	defer cancel()
	_, err := a.client.Logout(ctx, &identityv1.LogoutRequest{Token: strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")})
	if err != nil {
		a.rpcFailure(w, r, "auth.logout", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
