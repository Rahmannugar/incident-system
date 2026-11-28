package telemetry

import (
	"context"
	"errors"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdk "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
	"google.golang.org/grpc"
	"google.golang.org/grpc/metadata"
	grpcstatus "google.golang.org/grpc/status"
)

var propagator = propagation.TraceContext{}

func Init(service string, logger *slog.Logger) (func(), error) {
	enabled := os.Getenv("INCIDENT_SYSTEM_TELEMETRY_ENABLED")
	if enabled != "" && enabled != "true" && enabled != "false" {
		return nil, errors.New("INCIDENT_SYSTEM_TELEMETRY_ENABLED must be true or false")
	}
	if enabled == "false" {
		return func() {}, nil
	}

	exporters := []sdk.SpanExporter{}
	endpoint := os.Getenv("INCIDENT_SYSTEM_TELEMETRY_OTLP_ENDPOINT")
	if endpoint != "" {
		u, err := url.Parse(endpoint)
		if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "/v1/traces" || (u.Scheme != "https" && !(u.Scheme == "http" && (u.Hostname() == "127.0.0.1" || u.Hostname() == "localhost" || u.Hostname() == "::1"))) {
			return nil, errors.New("INCIDENT_SYSTEM_TELEMETRY_OTLP_ENDPOINT must be an HTTPS or loopback /v1/traces URL")
		}
		exporter, err := otlptracehttp.New(context.Background(), otlptracehttp.WithEndpointURL(endpoint), otlptracehttp.WithTimeout(2*time.Second), otlptracehttp.WithRetry(otlptracehttp.RetryConfig{Enabled: false}))
		if err != nil {
			return nil, errors.New("initialize trace exporter")
		}
		exporters = append(exporters, exporter)
	}
	console := os.Getenv("INCIDENT_SYSTEM_TELEMETRY_CONSOLE")
	if console != "" && console != "true" && console != "false" {
		return nil, errors.New("INCIDENT_SYSTEM_TELEMETRY_CONSOLE must be true or false")
	}
	if endpoint == "" || console == "true" {
		exporters = append(exporters, &spanExporter{logger: logger, service: service})
	}
	options := []sdk.TracerProviderOption{sdk.WithResource(resource.NewWithAttributes("", attribute.String("service.name", service))), sdk.WithSampler(sdk.ParentBased(sdk.AlwaysSample()))}
	for _, exporter := range exporters {
		options = append(options, sdk.WithBatcher(exporter, sdk.WithMaxQueueSize(2048), sdk.WithMaxExportBatchSize(128), sdk.WithBatchTimeout(time.Second), sdk.WithExportTimeout(2*time.Second)))
	}
	provider := sdk.NewTracerProvider(options...)
	// Exporter failures are operational signals, not raw transport errors that may
	// contain configured endpoint details. Business requests never await exporting.
	otel.SetErrorHandler(otel.ErrorHandlerFunc(func(error) { logger.Warn("telemetry.export_failed", "service", service) }))

	otel.SetTracerProvider(provider)
	shutdownMetrics, err := initMetrics(service)
	if err != nil {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = provider.Shutdown(ctx)
		return nil, err
	}
	return func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		var exporters sync.WaitGroup
		exporters.Add(1)
		go func() { defer exporters.Done(); shutdownMetrics() }()
		_ = provider.Shutdown(ctx)
		exporters.Wait()
	}, nil
}
func Parent(ctx context.Context, value string) context.Context {
	if !ValidParent(value) {
		return ctx
	}
	return propagator.Extract(ctx, propagation.MapCarrier{"traceparent": value})
}
func ValidParent(value string) bool {
	// Keep durable envelopes to the currently supported W3C v00 format. Baggage
	// and tracestate are deliberately excluded from application events and logs.
	if len(value) != 55 || !strings.HasPrefix(value, "00-") || (value[53:] != "00" && value[53:] != "01") {
		return false
	}
	extracted := propagator.Extract(context.Background(), propagation.MapCarrier{"traceparent": value})
	return trace.SpanContextFromContext(extracted).IsValid()
}
func Traceparent(ctx context.Context) string {
	carrier := propagation.MapCarrier{}
	propagator.Inject(ctx, carrier)
	return carrier.Get("traceparent")
}
func Start(ctx context.Context, name string, kind trace.SpanKind) (context.Context, trace.Span) {
	return otel.Tracer("incident-system").Start(ctx, name, trace.WithSpanKind(kind))
}
func End(span trace.Span, failed bool) {
	if failed {
		span.SetStatus(codes.Error, "operation_failed")
	}
	span.End()
}
func ServerInterceptor(ctx context.Context, req interface{}, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (response interface{}, err error) {
	md, _ := metadata.FromIncomingContext(ctx)
	if values := md.Get("traceparent"); len(values) == 1 {
		ctx = Parent(ctx, values[0])
	}
	ctx, span := Start(ctx, info.FullMethod, trace.SpanKindServer)
	started := time.Now()
	defer func() {
		span.SetAttributes(attribute.Int("rpc.grpc.status_code", int(grpcstatus.Code(err))))
		RecordRPC(ctx, info.FullMethod, grpcstatus.Code(err), time.Since(started))
		End(span, err != nil)
	}()
	return handler(ctx, req)
}
func ClientInterceptor(ctx context.Context, method string, req, reply interface{}, connection *grpc.ClientConn, invoker grpc.UnaryInvoker, options ...grpc.CallOption) error {
	ctx, span := Start(ctx, method, trace.SpanKindClient)
	defer span.End()
	md, _ := metadata.FromOutgoingContext(ctx)
	md = md.Copy()
	if parent := Traceparent(ctx); parent != "" {
		md.Set("traceparent", parent)
	}
	err := invoker(metadata.NewOutgoingContext(ctx, md), method, req, reply, connection, options...)
	span.SetAttributes(attribute.Int("rpc.grpc.status_code", int(grpcstatus.Code(err))))
	if err != nil {
		span.SetStatus(codes.Error, "rpc_failed")
	}
	return err
}
func ProducerKind() trace.SpanKind { return trace.SpanKindProducer }
func ConsumerKind() trace.SpanKind { return trace.SpanKindConsumer }
func ServerKind() trace.SpanKind   { return trace.SpanKindServer }

type spanExporter struct {
	logger  *slog.Logger
	service string
}

func (e *spanExporter) ExportSpans(_ context.Context, spans []sdk.ReadOnlySpan) error {
	for _, span := range spans {
		e.logger.Info("trace.completed", "service", e.service, "operation", span.Name(), "trace_id", span.SpanContext().TraceID().String(), "span_id", span.SpanContext().SpanID().String(), "parent_span_id", span.Parent().SpanID().String(), "span_kind", span.SpanKind().String(), "status", strings.ToLower(span.Status().Code.String()), "started_at", span.StartTime().UTC().Format(time.RFC3339Nano), "ended_at", span.EndTime().UTC().Format(time.RFC3339Nano), "duration_ms", float64(span.EndTime().Sub(span.StartTime()).Microseconds())/1000)
	}
	return nil
}
func (*spanExporter) Shutdown(context.Context) error { return nil }

type Handler struct{ Inner slog.Handler }

func (h Handler) Enabled(ctx context.Context, level slog.Level) bool {
	return h.Inner.Enabled(ctx, level)
}
func (h Handler) Handle(ctx context.Context, record slog.Record) error {
	hasMessage := false
	record.Attrs(func(attr slog.Attr) bool {
		if attr.Key == "message" {
			hasMessage = true
		}
		return true
	})
	if !hasMessage {
		record.AddAttrs(slog.String("message", eventMessage(record.Message)))
	}
	span := trace.SpanContextFromContext(ctx)
	if span.IsValid() {
		record.AddAttrs(slog.String("trace_id", span.TraceID().String()), slog.String("span_id", span.SpanID().String()))
	}
	return h.Inner.Handle(ctx, record)
}
func (h Handler) WithAttrs(attrs []slog.Attr) slog.Handler { return Handler{h.Inner.WithAttrs(attrs)} }
func (h Handler) WithGroup(name string) slog.Handler       { return Handler{h.Inner.WithGroup(name)} }

func Resume(ctx context.Context, parent, name string, kind trace.SpanKind) (context.Context, trace.Span) {
	// Unsigned transport headers cannot supply causality for a signed event.
	ctx = trace.ContextWithSpanContext(ctx, trace.SpanContext{})
	return Start(Parent(ctx, parent), name, kind)
}
func MarkError(span trace.Span) { span.SetStatus(codes.Error, "operation_failed") }

type ResponseWriter struct {
	http.ResponseWriter
	Status int
}

func (w *ResponseWriter) WriteHeader(status int) {
	if w.Status != 0 {
		return
	}
	w.Status = status
	w.ResponseWriter.WriteHeader(status)
}
func (w *ResponseWriter) Write(body []byte) (int, error) {
	if w.Status == 0 {
		w.WriteHeader(http.StatusOK)
	}
	return w.ResponseWriter.Write(body)
}
func (w *ResponseWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }
func FinishHTTP(span trace.Span, pattern string, status int) {
	if pattern == "" {
		pattern = "unmatched"
	}
	if status == 0 {
		status = 200
	}
	span.SetName(pattern)
	span.SetAttributes(attribute.Int("http.response.status_code", status))
	End(span, status >= 400)
}
