# Local logs, traces and metrics

The project runs monolithic Tempo, Loki, OpenTelemetry Collector, Prometheus and Grafana
under the `observability` Compose profile. Each image is pinned by version and
digest. A one-shot initializer assigns the two backend volumes to their non-root
runtime users. It mounts no application/database volume.

Services send SDK spans to the Collector's OTLP/HTTP receiver. A bounded SDK
export queue and two-second timeout isolate application work from export failures.
Console span records remain available as an explicit diagnostic option. The
Collector batches traces to Tempo and tails selected structured application logs
to Loki through its native OTLP endpoint. Trace/span IDs stay in each log body;
only `service.name` becomes an indexed Loki label.

The service launcher captures stdout JSON into Git-ignored `local/runtime/logs`.
Each record includes a readable `message`, stable `event`, severity and process
role. Relevant business IDs, outcomes, durations and safe error categories remain
structured fields. Database failures expose SQLSTATE and a static explanation,
without SQL text, row details or raw exceptions. Verification launches mark records
with `source="integration"`; normal launches use `source="application"`. Captures
exclude span dumps, payloads, raw errors, addresses and arbitrary extra keys. Each launcher rotates at 2 MiB with
three backups. A new launch retains at most three inactive launches for that
service/role, leaving live writers untouched. Capture failure does not prevent
service startup. These bounded local files are evidence buffers, not an audit log.

Collector file offsets and bounded exporter queues use a separate persistent
volume. Loki and Tempo use local filesystem volumes with 72-hour retention;
Grafana persists its configuration state. Stopping containers retains data.
Collector recovery can replay queued records; the pipeline does not promise
exactly-once ingestion or zero loss after queue exhaustion/process interruption.

Grafana provisions Loki/Tempo data sources, a derived trace-ID link from logs,
and a trace-to-logs service mapping. It has no application dashboard. Grafana
requires the configured administrator password; data/query ports are bound to
host loopback for this local environment.

| Host endpoint | Purpose |
| --- | --- |
| `http://localhost:13000` | Grafana; user `admin`, password from `INCIDENT_SYSTEM_GRAFANA_ADMIN_PASSWORD` |
| `http://127.0.0.1:14318/v1/traces` | Collector OTLP trace ingestion |
| `http://127.0.0.1:13133/` | Collector health |
| `http://127.0.0.1:13200` | Tempo trace queries |
| `http://127.0.0.1:13100` | Loki log queries |

`task observability-up` starts the profile and checks all five services.
`task observability-stop` stops them without removing volumes.
`task check-observability` runs a real order flow, queries its trace and
success/failure/retry logs, checks stored evidence for private content and
verifies Grafana's data sources and log-to-trace matcher.

In Grafana Explore, query Loki using:

```logql
{service_name="gateway"} | json | order_id="<order-id>"
```

Expand a log entry and follow its TraceID derived field to Tempo. Service and
trace context come from actual application operations; the verification flow
uses labelled disposable application data and an official local QStash container.

To display the explanation while keeping the structured fields expandable:

```logql
{service_name=~".+"} | json | message!="" | line_format "{{.level}} {{.service}}: {{.message}}"
```

Records written before the message/source contract remain unchanged in local storage.

## Prometheus metrics

Prometheus scrapes the Collector's internal-network `:9464/metrics` endpoint every
five seconds. Services push SDK OTLP metrics through the existing receiver, using
`INCIDENT_SYSTEM_TELEMETRY_METRICS_ENDPOINT`. This needs no new public service route.
The Collector includes only service name, process role and source resource labels,
plus the job/instance identity needed to distinguish cumulative process counters.
Stopped producers expire from its metric endpoint after 20 seconds; historical
samples remain queryable in Prometheus. Collector restart loses its metric cache;
new cumulative exports restore active producers, and counter resets must be
handled with PromQL rate/increase functions.

Prometheus uses a dedicated persistent volume, three-day retention and a 512 MB
block-retention limit (WAL/head storage adds overhead). Its loopback query endpoint
is `http://localhost:19090`. Scrapes have sample/label limits and queries have time
and sample limits. Grafana provisions the `prometheus` data source for Explore.

Useful PromQL queries:

```promql
sum by (service_name, outcome) (rate(incident_system_operations_total[5m]))
```

```promql
histogram_quantile(0.95, sum by (le, service_name) (rate(incident_system_operation_duration_seconds_bucket[5m])))
```

```promql
max by (service_name) (incident_system_outbox_pending)
```

```promql
sum by (service_name, outcome) (increase(incident_system_notification_results_total[5m]))
```

Use `source="application"` or `source="integration"` to select the activity source.
Sparse/short-lived verification runs may lack two samples for a useful rate; an
empty live query after fixture shutdown does not imply historical data was lost.
## Grafana alerts

The Incident System folder provisions two Grafana-managed rules, evaluated every
10 seconds with a 30-second pending period:

- Sustained service errors: more than 20% server errors over one minute, with at
  least five completed non-health operations.
- Old pending outbox events: oldest pending age exceeds 60 seconds while backlog
  is nonzero and the publisher snapshot is healthy.

Both group by service and activity source and require a recent process heartbeat.
No data from stopped local services is OK; query failures remain evaluation errors.
These are local demonstration thresholds. They do not assert consumer completion
or dependency readiness. Notifications are muted all day and use Grafana's empty
receiver; no email or webhook destination is configured.

`task check-alerting` uses the real disposable order flow to observe both rules
firing and returning to normal after service recovery and queue drain. Grafana's
runtime API supplies the observed states. No application dashboard is configured.
