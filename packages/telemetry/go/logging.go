package telemetry

import (
	"context"
	"log/slog"
	"regexp"
	"strings"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

var logID = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F-]{27}$`)

func LogID(value string) string {
	if logID.MatchString(value) {
		return value
	}
	return ""
}

// RPCFields copies business identifiers only, never the protobuf payload or credentials.
func RPCFields(request interface{}) []interface{} {
	fields := []interface{}{}
	add := func(name, value string) {
		if logID.MatchString(value) {
			fields = append(fields, name, value)
		}
	}
	if value, ok := request.(interface{ GetId() string }); ok {
		add("order_id", value.GetId())
	}
	if value, ok := request.(interface{ GetOrderId() string }); ok {
		add("order_id", value.GetOrderId())
	}
	if value, ok := request.(interface{ GetPaymentId() string }); ok {
		add("payment_id", value.GetPaymentId())
	}
	if value, ok := request.(interface{ GetEventId() string }); ok {
		add("event_id", value.GetEventId())
	}
	return fields
}

func LogRPC(ctx context.Context, logger *slog.Logger, service, operation, requestID string, err error, started time.Time, fields ...interface{}) {
	code := status.Code(err)
	event, message, level := "rpc.succeeded", operation+" succeeded", slog.LevelInfo
	attrs := []interface{}{"service", service, "operation", operation, "request_id", requestID, "code", code.String(), "duration_ms", time.Since(started).Milliseconds()}
	if code != codes.OK {
		event = "rpc.failed"
		reason := "Operation failed"
		switch code {
		case codes.InvalidArgument:
			reason = "Request validation failed"
		case codes.Unauthenticated, codes.PermissionDenied:
			reason = "Request authentication or authorization failed"
		case codes.NotFound:
			reason = "Requested resource was not found"
		case codes.AlreadyExists, codes.Aborted, codes.FailedPrecondition:
			reason = "Request conflicts with the current resource state"
		case codes.Unavailable:
			reason = "A required dependency is unavailable"
		case codes.DeadlineExceeded:
			reason = "Operation exceeded its deadline"
		case codes.Canceled:
			reason = "Request was cancelled"
		case codes.ResourceExhausted:
			reason = "Service capacity limit reached"
		}
		message = operation + " failed: " + reason
		attrs = append(attrs, "error_type", "rpc", "error_message", reason)
		level = slog.LevelWarn
		if code == codes.Internal || code == codes.Unknown {
			level = slog.LevelError
		}
	}
	attrs = append(attrs, "message", message)
	attrs = append(attrs, fields...)
	logger.Log(ctx, level, event, attrs...)
}

func eventMessage(event string) string {
	messages := map[string]string{
		"order.created":               "Pending order created",
		"outbox.batch":                "Finished publishing an outbox batch; item counts describe the results",
		"outbox.batch_unconfirmed":    "Outbox batch could not be confirmed; leased events remain eligible for recovery",
		"outbox.listener_unavailable": "Database notification listener is unavailable; polling will continue",
		"outbox.listening":            "Outbox publisher subscribed to database notifications",
		"outbox.started":              "Outbox publisher started",
		"outbox.stopped":              "Outbox publisher stopped",
		"telemetry.export_failed":     "Telemetry export failed; business requests continue independently",
	}
	if message, ok := messages[event]; ok {
		return message
	}
	return strings.NewReplacer(".", " ", "_", " ").Replace(event)
}
