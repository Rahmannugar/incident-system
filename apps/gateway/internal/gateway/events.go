package gateway

import (
	"bytes"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/Rahmannugar/incident-system/packages/telemetry"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

type EventConfig struct {
	Destination              string
	SigningKeys              [2]string
	OrderToken, PaymentToken string
}
type PaymentEvent struct {
	Traceparent string    `json:"traceparent,omitempty"`
	ID          string    `json:"id"`
	Type        string    `json:"type"`
	Version     int       `json:"version"`
	OccurredAt  time.Time `json:"occurred_at"`
	RequestID   string    `json:"request_id"`
	Data        struct {
		PaymentID            string    `json:"payment_id"`
		OrderID              string    `json:"order_id"`
		AmountMinor          int64     `json:"amount_minor"`
		Currency             string    `json:"currency"`
		ReservationExpiresAt time.Time `json:"reservation_expires_at"`
		Late                 *bool     `json:"late"`
	} `json:"data"`
}
type deliveryClaims struct {
	jwt.RegisteredClaims
	Body string `json:"body"`
}

var currencyPattern = regexp.MustCompile(`^[A-Z]{3}$`)

func eventID(value string) bool {
	id, err := uuid.Parse(value)
	return err == nil && id != uuid.Nil && id.String() == value
}

func verifyDelivery(signature string, body []byte, config EventConfig) bool {
	digest := sha256.Sum256(body)
	for _, key := range config.SigningKeys {
		if key == "" {
			continue
		}
		claims := &deliveryClaims{}
		token, err := jwt.ParseWithClaims(signature, claims, func(*jwt.Token) (interface{}, error) { return []byte(key), nil }, jwt.WithValidMethods([]string{"HS256"}), jwt.WithIssuer("Upstash"), jwt.WithSubject(config.Destination), jwt.WithExpirationRequired())
		if err != nil || !token.Valid || claims.NotBefore == nil {
			continue
		}
		bodyHash, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(claims.Body, "="))
		if err == nil && subtle.ConstantTimeCompare(bodyHash, digest[:]) == 1 {
			return true
		}
	}
	return false
}
func parsePaymentEvent(body []byte) (PaymentEvent, bool) {
	var event PaymentEvent
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&event) != nil {
		return event, false
	}
	var extra interface{}
	if decoder.Decode(&extra) != io.EOF {
		return event, false
	}
	valid := (event.Traceparent == "" || telemetry.ValidParent(event.Traceparent)) && eventID(event.ID) && eventID(event.Data.OrderID) && eventID(event.Data.PaymentID) && event.Version == 1 && (event.Type == "payment.succeeded" || event.Type == "payment.failed") && !event.OccurredAt.IsZero() && validRequestID(event.RequestID) && event.Data.AmountMinor >= 1 && event.Data.AmountMinor <= 1e12 && currencyPattern.MatchString(event.Data.Currency) && !event.Data.ReservationExpiresAt.IsZero() && event.Data.Late != nil
	return event, valid
}
func (a *API) paymentEvent(w http.ResponseWriter, r *http.Request) {
	if a.events.Destination == "" {
		reject(w, 503, "delivery_unconfigured", "Payment event delivery is not configured")
		return
	}
	if r.URL.RawQuery != "" || r.URL.EscapedPath() != "/events/payment" {
		reject(w, 400, "invalid_request", "Invalid event destination")
		return
	}
	media, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || media != "application/json" {
		reject(w, 415, "unsupported_media_type", "Content-Type must be application/json")
		return
	}
	select {
	case a.deliveries <- struct{}{}:
		defer func() { <-a.deliveries }()
	default:
		w.Header().Set("Retry-After", "1")
		reject(w, 503, "delivery_busy", "Payment delivery is busy")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 32768)
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		reject(w, 413, "body_too_large", "Unable to read event body")
		return
	}
	signatures := r.Header.Values("Upstash-Signature")
	if len(signatures) != 1 || len(signatures[0]) > 8192 || !verifyDelivery(signatures[0], raw, a.events) {
		reject(w, 401, "invalid_signature", "A valid QStash signature is required")
		return
	}
	// Authenticate exact bytes before JSON decoding; the hash binds the durable
	// receipt to signed content, not unsigned transport headers.
	event, ok := parsePaymentEvent(raw)
	if !ok {
		reject(w, 400, "invalid_event", "Invalid payment event")
		return
	}
	hash := sha256.Sum256(raw)
	deliveryContext, span := telemetry.Resume(r.Context(), event.Traceparent, "payment.process", telemetry.ConsumerKind())
	defer span.End()
	ctx, cancel := a.callContext(r.WithContext(deliveryContext))
	defer cancel()
	err = a.settlements.Process(ctx, event, hex.EncodeToString(hash[:]))
	if err != nil {
		telemetry.MarkError(span)
		code := 503
		name := "delivery_incomplete"
		switch status.Code(err) {
		case codes.AlreadyExists, codes.FailedPrecondition, codes.InvalidArgument:
			code = 409
			name = "event_conflict"
		}
		a.logger.WarnContext(ctx, "payment.delivery_failed", "message", "Payment event settlement failed; delivery will be retried unless the event conflicts", "payment_id", event.Data.PaymentID, "service", "gateway", "event_id", event.ID, "order_id", event.Data.OrderID, "request_id", event.RequestID, "code", status.Code(err).String())
		reject(w, code, name, "Payment event could not be finalized")
		return
	}
	a.logger.InfoContext(ctx, "payment.delivered", "message", "Payment event settled; inventory acknowledgement and final order state are durable", "payment_id", event.Data.PaymentID, "service", "gateway", "event_id", event.ID, "order_id", event.Data.OrderID, "request_id", event.RequestID)
	w.WriteHeader(http.StatusNoContent)
}
