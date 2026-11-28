import {recordHTTP, notificationResult} from '../../../../packages/telemetry/ts/metrics.ts';
import {failureFields} from '../../../../packages/telemetry/ts/logging.ts';
import {inSpan, SpanKind, spanError} from '../../../../packages/telemetry/ts/telemetry.ts';
import {createServer, type IncomingMessage} from 'node:http';
import {createHash} from 'node:crypto';
import type {Pool} from 'pg';
import {Receiver} from '@upstash/qstash';
import {DeliveryConflict, finalOrderEvent} from './notifications.types.ts';
import type {NotificationService} from './notifications.service.ts';
import {log} from '../logger.ts';

async function rawBody(request: IncomingMessage) {
  const parts: Buffer[] = []; let size = 0;
  for await (const part of request) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(String(part));
    size += chunk.length; if (size > 32768) throw new RangeError('body_too_large'); parts.push(chunk);
  }
  return new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(parts));
}
export function notificationServer(service: NotificationService, pool: Pool, destination: string, keys: {currentSigningKey: string; nextSigningKey: string}) {
  const receiver = new Receiver({...keys, devMode: false}); let inflight = 0;
  const server = createServer((request, response) => {
    const started = Date.now();
    const operation = request.method === 'POST' && request.url === '/events/order' ? 'POST /events/order' : request.method === 'GET' && request.url === '/health/ready' ? 'GET /health/ready' : request.method === 'GET' && request.url === '/health/live' ? 'GET /health/live' : 'unmatched';
    response.once('finish', () => recordHTTP(operation, response.statusCode, Date.now() - started));
    void (async () => {
      if (request.method === 'GET' && request.url === '/health/live') {response.writeHead(200); response.end(); return;}
      if (request.method === 'GET' && request.url === '/health/ready') {
        try {await pool.query('SELECT 1'); response.writeHead(200);} catch {response.writeHead(503);}
        response.end(); return;
      }
      if (request.method !== 'POST' || request.url !== '/events/order') {response.writeHead(404); response.end(); return;}
      if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {response.writeHead(415); response.end(); return;}
      if (inflight >= 16) {response.setHeader('Retry-After', '1'); response.writeHead(503); response.end(); return;}
      inflight++;
      const deadline = Date.now() + 5000;
      try {
        let body: string;
        try {body = await rawBody(request);} catch (error) {response.writeHead(error instanceof RangeError ? 413 : 400); response.end(); return;}
        const signatures = request.headersDistinct['upstash-signature'];
        if (signatures?.length !== 1 || !signatures[0] || signatures[0].length > 8192) {response.writeHead(401); response.end(); return;}
        try {await receiver.verify({body, signature: signatures[0], url: destination});} catch {response.writeHead(401); response.end(); return;}
        const event = finalOrderEvent(body); if (!event) {response.writeHead(400); response.end(); return;}
        const active = () => {if (request.aborted || response.destroyed || Date.now() >= deadline) throw new Error('delivery_interrupted');};
        await inSpan('order.process', SpanKind.CONSUMER, event.traceparent ?? null, async () => {
          try {
            const result = await service.receive(event, createHash('sha256').update(body).digest('hex'), active);
            notificationResult(result.duplicate ? 'duplicate' : result.status === 'sent' ? 'sent' : result.status === 'pending' ? 'pending' : 'failed');
            spanError(result.status !== 'sent');
            log(result.status === 'sent' ? 'info' : 'warn', 'email.processed', {message: result.duplicate ? 'Order email delivery already completed; duplicate event acknowledged' : result.status === 'sent' ? 'Simulated order email sent and delivery result committed' : result.status === 'pending' ? 'Simulated email provider unavailable; QStash will retry delivery' : 'Order email delivery recorded as failed', event_id: event.id, event_type: event.type, order_id: event.data.order_id, request_id: event.request_id, status: result.status, duplicate: result.duplicate, attempt: result.attempts, provider: 'simulated_email', ...(result.errorCode ? {error_code: result.errorCode} : {}), ...(result.providerMessageId ? {provider_message_id: result.providerMessageId} : {}), retryable: result.status === 'pending'});
            if (result.status === 'pending') response.setHeader('Retry-After', '1');
            response.writeHead(result.status === 'pending' ? 503 : 204); response.end();
          } catch (error) {
            spanError(true);
            log('warn', 'email.delivery_incomplete', {message: error instanceof DeliveryConflict ? 'Order email event conflicts with an existing delivery' : 'Order email could not be processed; delivery will be retried', event_id: event.id, order_id: event.data.order_id, request_id: event.request_id, ...(error instanceof DeliveryConflict ? {error_type: 'conflict'} : failureFields(error)), code: error instanceof DeliveryConflict ? 'event_conflict' : 'processing_failed', retryable: !(error instanceof DeliveryConflict)});
            response.writeHead(error instanceof DeliveryConflict ? 409 : 503); response.end();
          }
        });
      } finally {inflight--;}
    })().catch(() => {if (!response.headersSent) response.writeHead(503); response.end();});
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000; server.timeout = 5000;
  server.maxConnections = 64; server.keepAliveTimeout = 1000;
  return server;
}
