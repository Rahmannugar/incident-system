export type Outcome = 'succeeded' | 'failed';
export interface ProviderEvent {event_id: string; payment_id: string; outcome: Outcome}
export type FailureCode = 'invalid_request' | 'not_found' | 'reservation_closed' | 'not_refundable' | 'unauthorized' | 'unavailable' | 'timeout' | 'cancelled' | 'event_conflict';
export class PaymentFailure extends Error {
  readonly code: FailureCode;
  constructor(code: FailureCode, message: string) {super(message); this.code = code;}
}
export type AssertActive = () => void;
export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
