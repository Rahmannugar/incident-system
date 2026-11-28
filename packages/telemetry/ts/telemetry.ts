import {initMetrics} from './metrics.ts';
import {OTLPTraceExporter} from '@opentelemetry/exporter-trace-otlp-http';
import {resourceFromAttributes} from '@opentelemetry/resources';
import {context, trace, SpanKind, SpanStatusCode, ROOT_CONTEXT, type Context, type Span, isSpanContextValid} from '@opentelemetry/api';
import {W3CTraceContextPropagator, ExportResultCode, type ExportResult} from '@opentelemetry/core';
import {TracerProvider, BatchSpanProcessor, ParentBasedSampler, AlwaysOnSampler, type SpanExporter, type ReadableSpan} from '@opentelemetry/sdk-trace';

import {AsyncLocalStorageContextManager} from '@opentelemetry/context-async-hooks';

const propagation = new W3CTraceContextPropagator();
const setter = {set(carrier: Record<string, string>, key: string, value: string) {carrier[key] = value;}};
const getter = {keys(carrier: Record<string, string>) {return Object.keys(carrier);}, get(carrier: Record<string, string>, key: string) {return carrier[key];}};
class ProcessSpanExporter implements SpanExporter {
  constructor(private readonly service: string) {}
  export(spans: ReadableSpan[], callback: (result: ExportResult) => void) {
    for (const span of spans) console.log(JSON.stringify({time: new Date().toISOString(), service: this.service, level: 'info', event: 'trace.completed', operation: span.name, ...spanFields(span), parent_span_id: span.parentSpanContext?.spanId ?? '0000000000000000', span_kind: ['internal', 'server', 'client', 'producer', 'consumer'][span.kind], status: ['unset', 'ok', 'error'][span.status.code], started_at: new Date(span.startTime[0] * 1000 + span.startTime[1] / 1e6).toISOString(), ended_at: new Date(span.endTime[0] * 1000 + span.endTime[1] / 1e6).toISOString(), duration_ms: span.duration[0] * 1000 + span.duration[1] / 1e6}));
    callback({code: ExportResultCode.SUCCESS});
  }
  async shutdown() {}
}
function spanFields(span: Span | ReadableSpan) {return {trace_id: span.spanContext().traceId, span_id: span.spanContext().spanId};}
export function tracing(service: string) {
  const enabled = process.env.INCIDENT_SYSTEM_TELEMETRY_ENABLED ?? 'true';
  if (enabled !== 'true' && enabled !== 'false') throw new Error('INCIDENT_SYSTEM_TELEMETRY_ENABLED must be true or false');
  if (enabled === 'false') return async () => {};
  const endpoint = process.env.INCIDENT_SYSTEM_TELEMETRY_OTLP_ENDPOINT;
  const consoleExport = process.env.INCIDENT_SYSTEM_TELEMETRY_CONSOLE ?? 'false';
  if (consoleExport !== 'true' && consoleExport !== 'false') throw new Error('INCIDENT_SYSTEM_TELEMETRY_CONSOLE must be true or false');
  const exporters: SpanExporter[] = [];
  if (endpoint) {
    const url = new URL(endpoint);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/v1/traces' || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) throw new Error('INCIDENT_SYSTEM_TELEMETRY_OTLP_ENDPOINT must be an HTTPS or loopback /v1/traces URL');
    exporters.push(new OTLPTraceExporter({url: endpoint, timeoutMillis: 2000}));
  }
  if (!endpoint || consoleExport === 'true') exporters.push(new ProcessSpanExporter(service));
  const provider = new TracerProvider({resource: resourceFromAttributes({'service.name': service}), sampler: new ParentBasedSampler({root: new AlwaysOnSampler()}), spanProcessors: exporters.map(exporter => new BatchSpanProcessor({exporter, maxQueueSize: 2048, maxExportBatchSize: 128, scheduledDelayMillis: 1000, exportTimeoutMillis: 2000}))});

  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  trace.setGlobalTracerProvider(provider);
  const shutdownMetrics = initMetrics(service);
  return async () => {await Promise.all([provider.shutdown(), shutdownMetrics()]);};
}
export function validTraceparent(value: unknown): value is string {
  if (typeof value !== 'string' || !/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/.test(value)) return false;
  const extracted = propagation.extract(ROOT_CONTEXT, {traceparent: value}, getter);
  const span = trace.getSpanContext(extracted); return span !== undefined && isSpanContextValid(span);
}
export function parentContext(parent?: string | null): Context {
  return validTraceparent(parent) ? propagation.extract(ROOT_CONTEXT, {traceparent: parent}, getter) : ROOT_CONTEXT;
}
export function traceparent(): string | undefined {
  const carrier: Record<string, string> = {}; propagation.inject(context.active(), carrier, setter); return carrier.traceparent;
}
export function traceFields() {
  const span = trace.getSpan(context.active()); return span && isSpanContextValid(span.spanContext()) ? spanFields(span) : {};
}
export async function inSpan<T>(name: string, kind: SpanKind, parent: string | null | undefined, work: () => Promise<T>): Promise<T> {
  return trace.getTracer('incident-system').startActiveSpan(name, {kind}, parent === undefined ? context.active() : parentContext(parent), async span => {
    try {return await work();} catch (error) {span.setStatus({code: SpanStatusCode.ERROR, message: 'operation_failed'}); throw error;} finally {span.end();}
  });
}
export function spanError(failed: boolean) {if (failed) trace.getSpan(context.active())?.setStatus({code: SpanStatusCode.ERROR, message: 'operation_failed'});}
export {SpanKind, SpanStatusCode};

export function producerSpan(name: string, parent?: string) {
  return trace.getTracer('incident-system').startSpan(name, {kind: SpanKind.PRODUCER}, parentContext(parent));
}
