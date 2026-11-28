import type {Pool} from 'pg';
import {claimOutboxBatch, exhaustExpiredClaims, finishOutboxBatch, outboxMetrics} from './outbox.queries.js';

export type PublishResult = {id: string; message_id: string | null; error_code: string | null};
export class OutboxRepository {
  constructor(private readonly pool: Pool) {}
  async metrics() {
    const [row] = await outboxMetrics.run(undefined, this.pool);
    if (!row) throw new Error('Outbox snapshot unavailable');
    return {pending: Number(row.pending), exhausted: Number(row.exhausted), oldest_seconds: row.oldest_seconds ?? 0};
  }
  async claim(token: string, size = 20) {
    if (!Number.isInteger(size) || size < 1 || size > 20) throw new Error('Outbox batch size must be between 1 and 20');
    // Even an interrupted final attempt becomes inspectable after its lease expires.
    await exhaustExpiredClaims.run(undefined, this.pool);
    return claimOutboxBatch.run({claimToken: token, batchSize: size}, this.pool);
  }
  async finish(token: string, results: PublishResult[]) {
    // A stale publisher cannot acknowledge work now owned by another claim token.
    // pg encodes native arrays as PostgreSQL arrays; jsonb_to_recordset needs serialized JSON.
    return finishOutboxBatch.run({claimToken: token, results: JSON.stringify(results)}, this.pool);
  }
}
