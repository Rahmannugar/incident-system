# Trace context and metrics

The Go and TypeScript adapters use OpenTelemetry SDKs and W3C version 00
`traceparent`. HTTP and gRPC boundaries create server/client spans. Incoming
context affects tracing only and grants no application permission. Baggage and
tracestate are excluded from durable events and process evidence.

Payment snapshots initiation context in its owned database. A later provider
callback resumes that context for the outcome event. Order finalization writes
its current producer context into the final event. Both fields are optional for
older records and covered by the QStash body signature. Consumers authenticate
first and resume the signed body context, never unsigned delivery headers.

Each publisher creates a producer span per event in a batch. The signed event
body stays immutable: publisher attempts and consumer executions are children of
the persisted creation context. Repeated attempts get distinct span IDs in the
same causal trace. Trace context does not change event IDs or deduplication.

Structured logs inside active spans include `trace_id` and `span_id`. With console diagnostics enabled, completed
SDK spans are exported as `trace.completed` JSON process records with service,
operation, kind, parent, status, time window and duration. Only those selected
fields are exported; request bodies, credentials, addresses and SQL are omitted.
Export queues hold at most 2,048 spans and drop telemetry rather than blocking
business processing when full. Graceful shutdown flushes buffered spans.

`INCIDENT_SYSTEM_TELEMETRY_ENABLED` defaults to `true`; `false` disables SDK
recording. `INCIDENT_SYSTEM_TELEMETRY_OTLP_ENDPOINT` enables the HTTP trace exporter, using
an HTTPS or loopback `/v1/traces` URL. The local Collector endpoint is configured
in `.env.example`. `INCIDENT_SYSTEM_TELEMETRY_CONSOLE=true` also emits selected
span records for diagnostics; otherwise OTLP replaces console span output.
Without an OTLP endpoint, process export remains the fallback. Exporting uses
bounded SDK queues and timeouts; telemetry transport failure does not fail a
business request. Collector/storage wiring lives in `infra/observability`.

## Metrics

`INCIDENT_SYSTEM_TELEMETRY_METRICS_ENDPOINT` enables SDK OTLP/HTTP metrics using
an HTTPS or loopback `/v1/metrics` URL. Both languages export cumulative metrics
every five seconds with bounded export timeouts. Metrics use separate providers
from traces; disabling telemetry disables both. No endpoint means no metric export.

Service boundaries record completed operation counts and duration histograms in
seconds. Duration buckets are 5, 10, 25, 50, 100, 250 and 500 milliseconds, then
1, 2.5, 5 and 10 seconds. Fixed route templates/RPC names and three outcomes
(success, client_error, server_error) bound operation dimensions. Capacity,
dependency and deadline failures count as server errors. These count service
operations, including health checks, rather than unique orders or users.

Publishers count claimed attempts (first/retry) and fenced database results
(published/retry/exhausted). Query-backed gauges expose their own database's
unpublished non-exhausted count, exhausted count and oldest pending age. Pending
includes active leases and delayed retries. A failed snapshot emits collection
success=0 and omits backlog/age observations; it never reports a false zero.
The aggregate query runs during collection, outside business transactions.
Concurrent publisher gauges observe the same owned backlog; use max, not sum.

Notification counts committed simulated email outcomes and duplicate deliveries
separately. A duplicate does not increment the sent result. Counters are process
observations, not a durable business ledger; a crash between commit and recording
can lose an observation. Publication acceptance does not imply consumer completion.

Resource identity includes service, process role, source (application/integration)
and a random process-lifetime instance identifier. Instance identity separates
cumulative counters across replicas/restarts; it is the only intentionally
per-process dimension. No order/payment/request/trace IDs, addresses, exception
text or URLs become metric labels. A heartbeat records the latest process
collection time; it is not a dependency-readiness assertion. Collector scrape
health describes collection, not whether every application is running.
