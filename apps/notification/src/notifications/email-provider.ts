import type {FinalOrderEvent} from './notifications.types.ts';
export function emailContent(event: FinalOrderEvent) {
  const text = {
    confirmed: ['Order confirmed', 'Your payment was successful and your order is confirmed.'],
    failed: ['Payment unsuccessful', 'Your payment was unsuccessful and your inventory reservation has been released.'],
    refunded: ['Payment refunded', 'Your payment has been fully refunded because your inventory reservation expired or was released.'],
  } as const;
  const [subject, message] = text[event.data.status];
  return {subject, body: `${message}\nOrder: ${event.data.order_id}`};
}
export type EmailOutcome = {status: 'pending' | 'sent' | 'failed'; providerMessageId: string | null; errorCode: string | null};
export interface EmailMessage {id: string; recipient: string | null; subject: string; body: string}
export interface EmailProvider {send(message: EmailMessage, attempt: number): EmailOutcome}
export class SimulatedEmailProvider implements EmailProvider {
  constructor(private readonly failures: number) {}
  send(message: EmailMessage, attempt: number): EmailOutcome {
    if (!message.recipient) return {status: 'failed', providerMessageId: null, errorCode: 'recipient_missing'};
    if (attempt <= this.failures) return {status: 'pending', providerMessageId: null, errorCode: 'simulated_provider_unavailable'};
    return {status: 'sent', providerMessageId: `simulated_email_${message.id}`, errorCode: null};
  }
}
