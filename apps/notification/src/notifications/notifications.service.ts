import {emailContent, type EmailProvider} from './email-provider.ts';
import type {NotificationRepository} from './notifications.repository.ts';
import type {FinalOrderEvent} from './notifications.types.ts';

export class NotificationService {
  constructor(private readonly repository: NotificationRepository, private readonly provider: EmailProvider) {}
  receive(event: FinalOrderEvent, payloadHash: string, active: () => void) {
    return this.repository.receive(event, payloadHash, emailContent(event), active, delivery => {
      const attempts = delivery.attempts + 1;
      const outcome = this.provider.send({id: event.id, recipient: delivery.recipient_email, subject: delivery.subject, body: delivery.body}, attempts);
      const result = attempts >= 3 && outcome.status === 'pending' ? {status: 'failed' as const, providerMessageId: null, errorCode: 'provider_attempts_exhausted'} : outcome;
      return {attempts, ...result};
    });
  }
}
