import {log} from '../logger.ts';
import {inSpan, SpanKind, traceparent} from '../../../../packages/telemetry/ts/telemetry.ts';
import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {findPayment, insertPayment, lockPayment, findProviderEvent, recordProviderEvent, finalizePayment, insertOutcome, wakePublisher, type IFindPaymentResult, type IInsertPaymentParams} from './payments.queries.js';
import {PaymentFailure, type AssertActive, type ProviderEvent} from './payments.types.ts';
import {findRefund, insertRefund} from './refunds.queries.js';
import {simulateFullRefund} from './refund-provider.ts';

export class PaymentRepository {
  constructor(private readonly pool: Pool) {}
  async find(orderId: string) {const [payment] = await findPayment.run({orderId}, this.pool); return payment;}
  async settlement(orderId: string) {
    const payment = await this.find(orderId);
    if (!payment) throw new PaymentFailure('not_found', 'Payment attempt not found');
    const [refund] = await findRefund.run({paymentId: payment.id}, this.pool);
    return {payment, refund};
  }
  async refund(paymentId: string, orderId: string, active: AssertActive) {
    const client = await this.pool.connect();
    let discard = false;
    try {
      await client.query('BEGIN');
      active();
      // Share the provider-outcome lock so a refund cannot race a pending charge.
      // The payment key, not a delivery ID, deduplicates concurrent refund requests.
      const [payment] = await lockPayment.run({paymentId}, client);
      if (!payment || payment.order_id !== orderId) throw new PaymentFailure('not_found', 'Payment attempt not found');
      if (payment.status !== 'succeeded') throw new PaymentFailure('not_refundable', 'Only a successful payment can be refunded');
      let [refund] = await findRefund.run({paymentId}, client);
      if (!refund) {
        const providerReference = simulateFullRefund(payment);
        await insertRefund.run({paymentId, providerReference}, client);
        [refund] = await findRefund.run({paymentId}, client);
      }
      if (!refund) throw new Error('Refund insertion returned no row');
      active();
      await client.query('COMMIT');
      return refund;
    } catch (error) {
      try {await client.query('ROLLBACK');} catch {discard = true;}
      throw error;
    } finally {client.release(discard);}
  }
  async create(input: IInsertPaymentParams, active: AssertActive): Promise<IFindPaymentResult> {
    const client = await this.pool.connect();
    let discard = false;
    try {
      await client.query('BEGIN');
      active();
      // The unique order key makes initiation safe after a lost response or concurrent retry.
      let [payment] = await insertPayment.run({...input, traceparent: traceparent() ?? null}, client);
      if (!payment) [payment] = await findPayment.run({orderId: input.orderId}, client);
      if (!payment) throw new Error('Payment insertion returned no row');
      active();
      await client.query('COMMIT');
      return payment;
    } catch (error) {
      try {await client.query('ROLLBACK');} catch {discard = true;}
      throw error;
    } finally {client.release(discard);}
  }
  async receive(event: ProviderEvent, payloadHash: string, active: AssertActive): Promise<{applied: boolean; reason: string}> {
    const client = await this.pool.connect();
    let discard = false;
    try {
      await client.query('BEGIN');
      active();
      // Serialise outcomes for one attempt; the first final outcome is immutable.
      const [existing] = await lockPayment.run({paymentId: event.payment_id}, client);
      if (!existing) throw new PaymentFailure('not_found', 'Payment attempt not found');
      // Resume initiation causality after the callback, including process restarts.
      return await inSpan('payment.outcome', SpanKind.PRODUCER, existing.traceparent, async () => {
        const [seen] = await findProviderEvent.run({eventId: event.event_id}, client);
        if (seen) {
          if (seen.payment_id !== event.payment_id || seen.payload_hash !== payloadHash) throw new PaymentFailure('event_conflict', 'Provider event ID was reused with different content');
          await client.query('COMMIT');
          return {applied: false, reason: 'duplicate'};
        }
        const applied = existing.status === 'pending';
        await recordProviderEvent.run({eventId: event.event_id, paymentId: event.payment_id, payloadHash, outcome: event.outcome, applied}, client);
        if (applied) {
          const [payment] = await finalizePayment.run({paymentId: event.payment_id, outcome: event.outcome}, client);
          if (!payment) throw new Error('Payment transition returned no row');
          const eventType = `payment.${event.outcome}`;
          const id = randomUUID();
          const parent = traceparent();
          await insertOutcome.run({id, paymentId: payment.id, eventType, payload: {id, type: eventType, version: 1, ...(parent ? {traceparent: parent} : {}), occurred_at: payment.updated_at.toISOString(), request_id: payment.request_id, data: {payment_id: payment.id, order_id: payment.order_id, amount_minor: Number(payment.amount_minor), currency: payment.currency, reservation_expires_at: payment.reservation_expires_at.toISOString(), late: payment.late}}}, client);
          // NOTIFY is only a wakeup; the outcome and durable outbox row commit together.
          await wakePublisher.run(undefined, client);
        }
        active();
        await client.query('COMMIT');
        log('info', 'payment.outcome_recorded', {message: applied ? 'Payment finalized and asynchronous delivery queued' : 'Payment already finalized; provider outcome recorded without changing it', order_id: existing.order_id, payment_id: existing.id, provider_event_id: event.event_id, outcome: event.outcome, applied});
        return {applied, reason: applied ? 'applied' : existing.status === event.outcome ? 'already_final' : 'terminal_conflict'};
      });
    } catch (error) {
      try {await client.query('ROLLBACK');} catch {discard = true;}
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505' && 'constraint' in error && error.constraint === 'provider_events_pkey') throw new PaymentFailure('event_conflict', 'Provider event ID was reused with different content');
      throw error;
    } finally {client.release(discard);}
  }
}
