import {randomUUID} from 'node:crypto';
import type {IClaimOutboxBatchResult} from './outbox.queries.js';
import {OutboxRepository, type PublishResult} from './outbox.repository.ts';
import {uuidPattern} from './payments.types.ts';
import {log} from '../logger.ts';

export interface PublisherConfig {baseURL: string; token: string; destination: string}
function record(value: unknown): value is Record<string, unknown> {return typeof value === 'object' && value !== null && !Array.isArray(value);}
function eventBody(row: IClaimOutboxBatchResult): string | undefined {
  const event: unknown = row.payload;
  if (!record(event) || event.id !== row.id || event.version !== 1 || (event.type !== 'payment.succeeded' && event.type !== 'payment.failed') || typeof event.request_id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(event.request_id) || typeof event.occurred_at !== 'string' || !Number.isFinite(Date.parse(event.occurred_at)) || !record(event.data)) return undefined;
  const data = event.data;
  if (data.payment_id !== row.payment_id || typeof data.order_id !== 'string' || !uuidPattern.test(data.order_id) || typeof data.amount_minor !== 'number' || !Number.isSafeInteger(data.amount_minor) || data.amount_minor < 1 || data.amount_minor > 1e12 || typeof data.currency !== 'string' || !/^[A-Z]{3}$/.test(data.currency) || typeof data.reservation_expires_at !== 'string' || !Number.isFinite(Date.parse(data.reservation_expires_at)) || typeof data.late !== 'boolean') return undefined;
  const body = JSON.stringify(event);
  return Buffer.byteLength(body) <= 32768 ? body : undefined;
}

export class OutboxPublisher {
  constructor(private readonly repository: OutboxRepository, private readonly config: PublisherConfig) {}
  async runBatch(signal: AbortSignal): Promise<number> {
    if (signal.aborted) return 0;
    const token = randomUUID();
    const rows = await this.repository.claim(token);
    if (!rows.length) return 0;
    const results: PublishResult[] = [];
    const messages: {destination: string; body: string; headers: Record<string, string>}[] = [];
    const sent: IClaimOutboxBatchResult[] = [];
    for (const row of rows) {
      const body = eventBody(row);
      if (!body) {results.push({id: row.id, message_id: null, error_code: 'invalid_event'}); continue;}
      messages.push({destination: this.config.destination, body, headers: {'Content-Type': 'application/json', 'Upstash-Deduplication-Id': row.id, 'Upstash-Retries': '2', 'Upstash-Timeout': '10s'}});
      sent.push(row);
    }
    if (sent.length) {
      try {
        // Caller timeout is distinct from QStash's destination timeout; publishing holds no DB transaction.
        const response = await fetch(`${this.config.baseURL}/v2/batch`, {method: 'POST', headers: {Authorization: `Bearer ${this.config.token}`, 'Content-Type': 'application/json'}, body: JSON.stringify(messages), redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(10000)])});
        if (!response.ok && response.status !== 400) throw new Error('qstash_rejected');
        const raw = await response.text();
        if (Buffer.byteLength(raw) > 65536) throw new Error('qstash_invalid_response');
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed) || parsed.length !== sent.length) throw new Error('qstash_invalid_response');
        for (let i = 0; i < sent.length; i++) {
          const row = sent[i]; if (!row) throw new Error('qstash_invalid_response');
          const result: unknown = parsed[i];
          const accepted = record(result) && !result.error && typeof result.messageId === 'string' && result.messageId.length > 0 && result.messageId.length <= 256;
          results.push({id: row.id, message_id: accepted && record(result) ? String(result.messageId) : null, error_code: accepted ? null : 'qstash_rejected'});
        }
      } catch {
        // Any response-loss ambiguity is resolved by the stable event ID and durable consumer deduplication.
        for (const row of sent) if (!results.some(result => result.id === row.id)) results.push({id: row.id, message_id: null, error_code: signal.aborted ? 'publish_interrupted' : 'publish_unconfirmed'});
      }
    }
    const finished = await this.repository.finish(token, results);
    log('info', 'outbox.batch', {claimed: rows.length, acknowledged: finished.length, published: finished.filter(row => row.published_at !== null).length, exhausted: finished.filter(row => row.exhausted_at !== null).length});
    return rows.length;
  }
}
