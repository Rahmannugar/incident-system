package telemetry

import (
	"context"
	"crypto/rand"
	"errors"
	"net/url"
	"os"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
	"go.opentelemetry.io/otel/metric"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	"google.golang.org/grpc/codes"
)

var metricsMeter metric.Meter

func initMetrics(service string) (func(), error) {
	endpoint := os.Getenv("INCIDENT_SYSTEM_TELEMETRY_METRICS_ENDPOINT")
	if endpoint == "" {
		return func() {}, nil
	}
	u, err := url.Parse(endpoint)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "/v1/metrics" || (u.Scheme != "https" && !(u.Scheme == "http" && (u.Hostname() == "127.0.0.1" || u.Hostname() == "localhost" || u.Hostname() == "::1"))) {
		return nil, errors.New("INCIDENT_SYSTEM_TELEMETRY_METRICS_ENDPOINT must be an HTTPS or loopback /v1/metrics URL")
	}
	exporter, err := otlpmetrichttp.New(context.Background(), otlpmetrichttp.WithEndpointURL(endpoint), otlpmetrichttp.WithTimeout(2*time.Second), otlpmetrichttp.WithRetry(otlpmetrichttp.RetryConfig{Enabled: false}))
	if err != nil {
		return nil, errors.New("initialize metrics exporter")
	}
	source, role := "application", "server"
	if os.Getenv("INCIDENT_SYSTEM_TELEMETRY_SOURCE") == "integration" {
		source = "integration"
	}
	if os.Getenv("INCIDENT_SYSTEM_PROCESS_ROLE") == "publisher" {
		role = "publisher"
	}
	provider := sdkmetric.NewMeterProvider(
		sdkmetric.WithResource(resource.NewWithAttributes("", attribute.String("service.name", service), attribute.String("service.instance.id", rand.Text()), attribute.String("source", source), attribute.String("process_role", role))),
		sdkmetric.WithCardinalityLimit(1000),
		sdkmetric.WithView(sdkmetric.NewView(sdkmetric.Instrument{Name: "incident_system_operation_duration"}, sdkmetric.Stream{Aggregation: sdkmetric.AggregationExplicitBucketHistogram{Boundaries: []float64{.005, .01, .025, .05, .1, .25, .5, 1, 2.5, 5, 10}}})),
		sdkmetric.WithReader(sdkmetric.NewPeriodicReader(exporter, sdkmetric.WithInterval(5*time.Second), sdkmetric.WithTimeout(3*time.Second))),
	)
	otel.SetMeterProvider(provider)
	metricsMeter = provider.Meter("incident-system")
	heartbeat, _ := metricsMeter.Float64ObservableGauge("incident_system_process_heartbeat", metric.WithUnit("s"), metric.WithDescription("Unix time of the last live process metric collection"))
	_, _ = metricsMeter.RegisterCallback(func(ctx context.Context, o metric.Observer) error {
		o.ObserveFloat64(heartbeat, float64(time.Now().UnixMilli())/1000)
		return nil
	}, heartbeat)
	return func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = provider.Shutdown(ctx)
	}, nil
}

func metricOperation(operation string) string {
	allowed := map[string]bool{"POST /events/payment": true, "POST /orders": true, "GET /orders/{id}": true, "POST /orders/{id}/payment": true, "GET /orders/{id}/payment": true, "POST /orders/{id}/reservation": true, "GET /orders/{id}/reservation": true, "POST /auth/signup": true, "POST /auth/login": true, "POST /auth/logout": true, "GET /auth/me": true, "GET /health/live": true, "GET /health/ready": true}
	if allowed[operation] {
		return operation
	}
	methods := map[string]bool{"/incident.order.v1.OrderService/CreateOrder": true, "/incident.order.v1.OrderService/GetOrder": true, "/incident.order.v1.OrderService/PrepareOrderSettlement": true, "/incident.order.v1.OrderService/FinalizeOrder": true, "/incident.order.v1.OrderService/CheckHealth": true, "/incident.inventory.v1.InventoryService/Reserve": true, "/incident.inventory.v1.InventoryService/GetReservation": true, "/incident.inventory.v1.InventoryService/Commit": true, "/incident.inventory.v1.InventoryService/Release": true, "/incident.inventory.v1.InventoryService/CheckStock": true, "/incident.inventory.v1.InventoryService/CheckHealth": true}
	if methods[operation] {
		return operation
	}
	return "unmatched"
}
func RecordOperation(ctx context.Context, operation, protocol, outcome string, duration time.Duration) {
	if metricsMeter == nil {
		return
	}
	attrs := metric.WithAttributes(attribute.String("operation", metricOperation(operation)), attribute.String("protocol", protocol), attribute.String("outcome", outcome))
	count, _ := metricsMeter.Int64Counter("incident_system_operations", metric.WithDescription("Completed service operations"))
	count.Add(ctx, 1, attrs)
	latency, _ := metricsMeter.Float64Histogram("incident_system_operation_duration", metric.WithUnit("s"), metric.WithDescription("Service operation duration"))
	latency.Record(ctx, duration.Seconds(), attrs)
}
func RecordHTTP(ctx context.Context, operation string, status int, duration time.Duration) {
	outcome := "success"
	if status >= 500 {
		outcome = "server_error"
	} else if status >= 400 {
		outcome = "client_error"
	}
	RecordOperation(ctx, operation, "http", outcome, duration)
}
func RecordRPC(ctx context.Context, operation string, code codes.Code, duration time.Duration) {
	outcome := "client_error"
	switch code {
	case codes.OK:
		outcome = "success"
	case codes.Unknown, codes.DeadlineExceeded, codes.ResourceExhausted, codes.Internal, codes.Unavailable, codes.DataLoss:
		outcome = "server_error"
	}
	RecordOperation(ctx, operation, "grpc", outcome, duration)
}
func OutboxAttempt(ctx context.Context, retry bool) {
	if metricsMeter == nil {
		return
	}
	attempt := "first"
	if retry {
		attempt = "retry"
	}
	counter, _ := metricsMeter.Int64Counter("incident_system_outbox_claims", metric.WithDescription("Claimed outbox events, including retries"))
	counter.Add(ctx, 1, metric.WithAttributes(attribute.String("attempt", attempt)))
}
func OutboxResult(ctx context.Context, outcome string) {
	if metricsMeter == nil {
		return
	}
	counter, _ := metricsMeter.Int64Counter("incident_system_outbox_results", metric.WithDescription("Fenced durable outbox publication results"))
	counter.Add(ctx, 1, metric.WithAttributes(attribute.String("outcome", outcome)))
}

type OutboxSnapshot struct {
	Pending, Exhausted int64
	OldestSeconds      float64
}

func ObserveOutbox(read func(context.Context) (OutboxSnapshot, error)) {
	if metricsMeter == nil {
		return
	}
	pending, _ := metricsMeter.Int64ObservableGauge("incident_system_outbox_pending", metric.WithDescription("Unpublished, non-exhausted events, including leases and backoff"))
	exhausted, _ := metricsMeter.Int64ObservableGauge("incident_system_outbox_exhausted", metric.WithDescription("Unpublished exhausted events requiring attention"))
	oldest, _ := metricsMeter.Float64ObservableGauge("incident_system_outbox_oldest", metric.WithUnit("s"), metric.WithDescription("Age of the oldest non-exhausted unpublished event"))
	healthy, _ := metricsMeter.Int64ObservableGauge("incident_system_outbox_collection_success", metric.WithDescription("Whether the owned outbox snapshot query succeeded"))
	_, _ = metricsMeter.RegisterCallback(func(ctx context.Context, o metric.Observer) error {
		ctx, cancel := context.WithTimeout(ctx, time.Second)
		defer cancel()
		snapshot, err := read(ctx)
		if err != nil {
			o.ObserveInt64(healthy, 0)
			return nil
		}
		o.ObserveInt64(pending, snapshot.Pending)
		o.ObserveInt64(exhausted, snapshot.Exhausted)
		o.ObserveFloat64(oldest, snapshot.OldestSeconds)
		o.ObserveInt64(healthy, 1)
		return nil
	}, pending, exhausted, oldest, healthy)
}
