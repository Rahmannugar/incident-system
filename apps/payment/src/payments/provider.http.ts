import {createHash, randomUUID} from 'node:crypto';
import {createServer, type IncomingMessage, type ServerResponse} from 'node:http';
import {PaymentRepository} from './payments.repository.ts';
import {PaymentFailure, uuidPattern, type ProviderEvent} from './payments.types.ts';
import {verifyProviderBody} from './provider-signature.ts';
import {log} from '../logger.ts';

class HTTPFailure extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {super(message);}
}
function reply(response: ServerResponse, status: number, body: unknown) {
  if (response.destroyed) return;
  response.writeHead(status, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
  response.end(JSON.stringify(body));
}
function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0, oversized = false;
    request.on('data', (part: Buffer) => {
      if (oversized) return;
      size += part.length;
      if (size > 16384) {oversized = true; reject(new HTTPFailure(413, 'body_too_large', 'Webhook body is too large')); return;}
      chunks.push(part);
    });
    request.once('end', () => {if (!oversized) resolve(Buffer.concat(chunks));});
    request.once('error', reject);
    request.once('aborted', () => reject(new HTTPFailure(400, 'invalid_request', 'Webhook request aborted')));
  });
}
function parseEvent(body: Buffer): ProviderEvent {
  let input: unknown;
  try {input = JSON.parse(body.toString('utf8'));} catch {throw new HTTPFailure(400, 'invalid_request', 'Invalid webhook JSON');}
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new HTTPFailure(400, 'invalid_request', 'Invalid provider event');
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => !['event_id', 'payment_id', 'outcome'].includes(key)) || typeof value.event_id !== 'string' || !uuidPattern.test(value.event_id) || typeof value.payment_id !== 'string' || !uuidPattern.test(value.payment_id) || (value.outcome !== 'succeeded' && value.outcome !== 'failed')) throw new HTTPFailure(400, 'invalid_request', 'Invalid provider event');
  return {event_id: value.event_id.toLowerCase(), payment_id: value.payment_id.toLowerCase(), outcome: value.outcome === 'succeeded' ? 'succeeded' : 'failed'};
}
export function providerServer(repository: PaymentRepository, secret: string, timeoutMs: number) {
  let inFlight = 0;
  const server = createServer({maxHeaderSize: 8192, requestTimeout: 5000, headersTimeout: 5000}, (request, response) => {
    if (request.method !== 'POST' || request.url !== '/webhooks/provider') {reply(response, 404, {error: {code: 'not_found', message: 'Route not found'}}); return;}
    if (inFlight >= 32) {reply(response, 429, {error: {code: 'busy', message: 'Webhook processing is busy'}}); return;}
    inFlight++;
    const requestId = typeof request.headers['x-request-id'] === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(request.headers['x-request-id']) ? request.headers['x-request-id'] : randomUUID();
    const start = Date.now();
    void (async () => {
      let code = 200;
      try {
        if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw new HTTPFailure(415, 'unsupported_media_type', 'Content-Type must be application/json');
        const body = await readBody(request);
        const timestamp = request.headers['x-payment-timestamp'];
        const signature = request.headers['x-payment-signature'];
        // Authenticate exact bytes before parsing. Event IDs persist replay protection beyond the time window.
        if (typeof timestamp !== 'string' || typeof signature !== 'string' || !verifyProviderBody(body, timestamp, signature, secret)) throw new HTTPFailure(401, 'invalid_signature', 'Invalid provider signature');
        const event = parseEvent(body);
        const active = () => {if (request.aborted || response.destroyed || Date.now() - start >= timeoutMs) throw new PaymentFailure('cancelled', 'Webhook processing timed out');};
        const result = await repository.receive(event, createHash('sha256').update(body).digest('hex'), active);
        log(result.reason === 'terminal_conflict' ? 'warn' : 'info', 'provider.outcome', {request_id: requestId, payment_id: event.payment_id, provider_event_id: event.event_id, applied: result.applied, reason: result.reason});
        reply(response, 200, {accepted: true, ...result});
      } catch (error) {
        let name = 'internal_error', message = 'Webhook processing failed';
        code = 500;
        if (error instanceof HTTPFailure) {code = error.status; name = error.code; message = error.message;}
        if (error instanceof PaymentFailure) {code = error.code === 'not_found' ? 404 : error.code === 'event_conflict' ? 409 : error.code === 'cancelled' ? 504 : 400; name = error.code; message = error.message;}
        reply(response, code, {error: {code: name, message}});
      } finally {inFlight--; log(code >= 500 ? 'error' : 'info', 'webhook.completed', {request_id: requestId, status: code, duration_ms: Date.now() - start});}
    })();
  });
  server.maxConnections = 64;
  server.setTimeout(5000, socket => socket.destroy());
  return server;
}
