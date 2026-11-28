package telemetry

import (
	"context"
	"go.opentelemetry.io/otel/attribute"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	"strings"
	"testing"
	"time"
)

func TestDurableTraceContext(t *testing.T) {
	valid := "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01"
	if !ValidParent(valid) || Traceparent(Parent(context.Background(), valid)) != valid {
		t.Fatal("valid trace context did not round-trip")
	}
	for _, value := range []string{"", "00-00000000000000000000000000000000-0123456789abcdef-01", "00-0123456789abcdef0123456789abcdef-0000000000000000-01", "00-0123456789abcdef0123456789abcdef-0123456789abcdef-ff", valid + "-extra"} {
		if ValidParent(value) {
			t.Fatal("invalid durable parent accepted")
		}
	}
	unsigned := Parent(context.Background(), valid)
	resumed, span := Resume(unsigned, "", "event.process", ConsumerKind())
	defer span.End()
	if Traceparent(resumed) == valid {
		t.Fatal("legacy event inherited unsigned transport context")
	}
}

func TestOperationMetricsAggregateRoutesAndPreserveFailures(t *testing.T) {
	reader := sdkmetric.NewManualReader()
	provider := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))
	previous := metricsMeter
	metricsMeter = provider.Meter("metrics-check")
	defer func() { metricsMeter = previous; _ = provider.Shutdown(context.Background()) }()
	ctx := context.Background()
	RecordHTTP(ctx, "GET /orders/{id}", 200, 25*time.Millisecond)
	RecordHTTP(ctx, "GET /orders/{id}", 503, 50*time.Millisecond)
	RecordHTTP(ctx, "GET /orders/private-order-identifier", 404, time.Millisecond)
	var data metricdata.ResourceMetrics
	if err := reader.Collect(ctx, &data); err != nil {
		t.Fatal(err)
	}
	var total int64
	for _, scope := range data.ScopeMetrics {
		for _, m := range scope.Metrics {
			if m.Name != "incident_system_operations" {
				continue
			}
			sums, ok := m.Data.(metricdata.Sum[int64])
			if !ok {
				t.Fatal("operation counts are not a counter")
			}
			for _, point := range sums.DataPoints {
				total += point.Value
				operation, _ := point.Attributes.Value(attribute.Key("operation"))
				if strings.Contains(operation.AsString(), "private") {
					t.Fatal("raw request path reached metric dimensions")
				}
			}
			if len(sums.DataPoints) != 3 {
				t.Fatal("success, server error and unmatched request did not remain distinct")
			}
		}
	}
	if total != 3 {
		t.Fatalf("expected three observed operations, got %d", total)
	}
}
