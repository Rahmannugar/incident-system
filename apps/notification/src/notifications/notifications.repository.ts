import type {Pool} from 'pg';
import {insertDelivery, lockDelivery, completeDelivery, type ILockDeliveryResult} from './notifications.queries.js';
import {DeliveryConflict, type FinalOrderEvent} from './notifications.types.ts';
import type {EmailOutcome} from './email-provider.ts';

export class NotificationRepository {
  constructor(private readonly pool: Pool) {}
  async receive(event: FinalOrderEvent, payloadHash: string, content: {subject: string; body: string}, active: () => void, process: (delivery: ILockDeliveryResult) => EmailOutcome & {attempts: number}) {
    const client = await this.pool.connect(); let discard = false;
    try {
      await client.query('BEGIN'); active();
      // Both event and order are unique. Lock before the simulated provider so
      // concurrent deliveries cannot duplicate a send or rewrite its recipient.
      await insertDelivery.run({eventId: event.id, orderId: event.data.order_id, payloadHash, recipientEmail: event.data.recipient_email, orderStatus: event.data.status, ...content}, client);
      const [delivery] = await lockDelivery.run({eventId: event.id}, client);
      if (!delivery || delivery.order_id !== event.data.order_id || delivery.payload_hash !== payloadHash) throw new DeliveryConflict();
      if (delivery.status !== 'pending') {await client.query('COMMIT'); return {status: delivery.status, duplicate: true, attempts: delivery.attempts, errorCode: delivery.error_code, providerMessageId: delivery.provider_message_id};}
      // This provider has no external side effect. Completion and its stable
      // message reference commit with the inbox; a real provider needs its own
      // idempotency guarantee across a network-success/database-failure window.
      const result = process(delivery);
      await completeDelivery.run({eventId: event.id, ...result}, client);
      active(); await client.query('COMMIT');
      return {status: result.status, duplicate: false, attempts: result.attempts, errorCode: result.errorCode, providerMessageId: result.providerMessageId};
    } catch (error) {
      try {await client.query('ROLLBACK');} catch {discard = true;}
      throw error;
    } finally {client.release(discard);}
  }
}
