import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {test} from 'node:test';
import {tracing, inSpan, traceparent, validTraceparent, SpanKind} from './telemetry.ts';

test('trace context stays isolated across simultaneous async requests', async () => {
  const metricsEndpoint = process.env.INCIDENT_SYSTEM_TELEMETRY_METRICS_ENDPOINT;
  delete process.env.INCIDENT_SYSTEM_TELEMETRY_METRICS_ENDPOINT;
  const endpoint = process.env.INCIDENT_SYSTEM_TELEMETRY_OTLP_ENDPOINT;
  delete process.env.INCIDENT_SYSTEM_TELEMETRY_OTLP_ENDPOINT;
  const shutdown = tracing('telemetry-check');
  try {
    const parents = ['00-0123456789abcdef0123456789abcdef-0123456789abcdef-01', '00-fedcba9876543210fedcba9876543210-0123456789abcdef-01'];
    await Promise.all(parents.map((parent, index) => inSpan('context.check', SpanKind.SERVER, parent, async () => {
      await delay(index ? 5 : 15);
      assert.equal(traceparent()?.split('-')[1], parent.split('-')[1]);
      assert.notEqual(traceparent()?.split('-')[2], parent.split('-')[2]);
    })));
    for (const value of ['', '00-00000000000000000000000000000000-0123456789abcdef-01', parents[0] + '-extra']) assert.equal(validTraceparent(value), false);
    assert.equal(traceparent(), undefined);
  } finally {await shutdown(); if (metricsEndpoint !== undefined) process.env.INCIDENT_SYSTEM_TELEMETRY_METRICS_ENDPOINT = metricsEndpoint; if (endpoint !== undefined) process.env.INCIDENT_SYSTEM_TELEMETRY_OTLP_ENDPOINT = endpoint;}
});
