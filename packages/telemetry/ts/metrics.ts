import {randomUUID} from 'node:crypto';
import {metrics, type Meter, type Attributes} from '@opentelemetry/api';
import {MeterProvider, PeriodicExportingMetricReader, AggregationType} from '@opentelemetry/sdk-metrics';
import {OTLPMetricExporter} from '@opentelemetry/exporter-metrics-otlp-http';
import {resourceFromAttributes} from '@opentelemetry/resources';

let meter: Meter | undefined;
const boundaries = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const operations = new Set(['auth.signup', 'auth.login', 'auth.logout', 'auth.session', 'check_health', 'payment.initiate', 'payment.get', 'payment.settlement', 'payment.refund', 'POST /webhooks/provider', 'POST /events/order', 'GET /health/live', 'GET /health/ready']);

export function initMetrics(service: string): () => Promise<void> {
  const endpoint = process.env.INCIDENT_SYSTEM_TELEMETRY_METRICS_ENDPOINT;
  if (process.env.INCIDENT_SYSTEM_TELEMETRY_ENABLED === 'false' || !endpoint) return async () => {};
  const url = new URL(endpoint);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/v1/metrics' || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) throw new Error('INCIDENT_SYSTEM_TELEMETRY_METRICS_ENDPOINT must be an HTTPS or loopback /v1/metrics URL');
  const source = process.env.INCIDENT_SYSTEM_TELEMETRY_SOURCE === 'integration' ? 'integration' : 'application';
  const role = process.env.INCIDENT_SYSTEM_PROCESS_ROLE === 'publisher' ? 'publisher' : 'server';
  const provider = new MeterProvider({
    resource: resourceFromAttributes({'service.name': service, 'service.instance.id': randomUUID(), process_role: role, source}),
    views: [{instrumentName: 'incident_system_operation_duration', aggregation: {type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM, options: {boundaries}}, aggregationCardinalityLimit: 1000}],
    readers: [new PeriodicExportingMetricReader({exporter: new OTLPMetricExporter({url: endpoint, timeoutMillis: 2000}), exportIntervalMillis: 5000, exportTimeoutMillis: 3000})],
  });
  metrics.setGlobalMeterProvider(provider);
  meter = provider.getMeter('incident-system');
  meter.createObservableGauge('incident_system_process_heartbeat', {unit: 's', description: 'Unix time of the last live process metric collection'}).addCallback(result => result.observe(Date.now() / 1000));
  return async () => {await provider.shutdown({timeoutMillis: 3000}).catch(() => {});};
}

// Only fixed operation/outcome values enter metric dimensions. IDs and exception
// contents remain in logs/traces, including when a request fails validation.
export function recordOperation(operation: string, protocol: 'http' | 'grpc', outcome: 'success' | 'client_error' | 'server_error', seconds: number) {
  if (!meter) return;
  const attributes: Attributes = {operation: operations.has(operation) ? operation : 'unmatched', protocol, outcome};
  meter.createCounter('incident_system_operations', {description: 'Completed service operations'}).add(1, attributes);
  meter.createHistogram('incident_system_operation_duration', {unit: 's', description: 'Service operation duration'}).record(Math.max(0, seconds), attributes);
}
export function recordRPC(operation: string, code: number, milliseconds: number) {
  const outcome = code === 0 ? 'success' : [2, 4, 8, 13, 14, 15].includes(code) ? 'server_error' : 'client_error';
  recordOperation(operation, 'grpc', outcome, milliseconds / 1000);
}
export function recordHTTP(operation: string, status: number, milliseconds: number) {
  recordOperation(operation, 'http', status >= 500 ? 'server_error' : status >= 400 ? 'client_error' : 'success', milliseconds / 1000);
}
export function outboxAttempt(retry: boolean) {meter?.createCounter('incident_system_outbox_claims', {description: 'Claimed outbox events, including retries'}).add(1, {attempt: retry ? 'retry' : 'first'});}
export function outboxResult(outcome: 'published' | 'retry' | 'exhausted') {meter?.createCounter('incident_system_outbox_results', {description: 'Fenced durable outbox publication results'}).add(1, {outcome});}
export function notificationResult(outcome: 'sent' | 'pending' | 'failed' | 'duplicate') {meter?.createCounter('incident_system_notification_results', {description: 'Committed simulated email delivery results; duplicates counted separately'}).add(1, {outcome});}
export interface OutboxSnapshot {pending: number; exhausted: number; oldest_seconds: number}
export function observeOutbox(read: () => Promise<OutboxSnapshot>) {
  if (!meter) return;
  const pending = meter.createObservableGauge('incident_system_outbox_pending', {description: 'Unpublished, non-exhausted events, including leases and backoff'});
  const exhausted = meter.createObservableGauge('incident_system_outbox_exhausted', {description: 'Unpublished exhausted events requiring attention'});
  const oldest = meter.createObservableGauge('incident_system_outbox_oldest', {unit: 's', description: 'Age of the oldest non-exhausted unpublished event'});
  const healthy = meter.createObservableGauge('incident_system_outbox_collection_success', {description: 'Whether the owned outbox snapshot query succeeded'});
  let collecting = false;
  meter.addBatchObservableCallback(async result => {
    if (collecting) return;
    collecting = true;
    try {
      const snapshot = await read();
      result.observe(pending, snapshot.pending); result.observe(exhausted, snapshot.exhausted);
      result.observe(oldest, Math.max(0, snapshot.oldest_seconds)); result.observe(healthy, 1);
    } catch {result.observe(healthy, 0);} finally {collecting = false;}
  }, [pending, exhausted, oldest, healthy]);
}
