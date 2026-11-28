import {validTraceparent} from '../../../../packages/telemetry/ts/telemetry.ts';
export interface FinalOrderEvent {
  traceparent?: string; id: string; type: 'order.confirmed' | 'order.failed' | 'order.refunded'; version: 1;
  occurred_at: string; request_id: string;
  data: {order_id: string; payment_id: string; status: 'confirmed' | 'failed' | 'refunded'; recipient_email: string | null};
}
export class DeliveryConflict extends Error {}
export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function record(value: unknown): value is Record<string, unknown> {return typeof value === 'object' && value !== null && !Array.isArray(value);}
function keys(value: Record<string, unknown>, expected: string[]) {return Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));}
export function finalOrderEvent(raw: string): FinalOrderEvent | undefined {
  let input: unknown; try {input = JSON.parse(raw);} catch {return undefined;}
  if (!record(input) || !keys(input, ['id', 'type', 'version', 'occurred_at', 'request_id', 'data', ...(Object.hasOwn(input, 'traceparent') ? ['traceparent'] : [])]) || typeof input.id !== 'string' || !uuidPattern.test(input.id) || (input.traceparent !== undefined && !validTraceparent(input.traceparent)) || input.version !== 1 || typeof input.occurred_at !== 'string' || !Number.isFinite(Date.parse(input.occurred_at)) || typeof input.request_id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(input.request_id) || !record(input.data)) return undefined;
  const data = input.data;
  if (!keys(data, ['order_id', 'payment_id', 'status', 'recipient_email']) || typeof data.order_id !== 'string' || !uuidPattern.test(data.order_id) || typeof data.payment_id !== 'string' || !uuidPattern.test(data.payment_id) || (data.status !== 'confirmed' && data.status !== 'failed' && data.status !== 'refunded') || input.type !== `order.${data.status}` || (data.recipient_email !== null && (typeof data.recipient_email !== 'string' || data.recipient_email.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(data.recipient_email)))) return undefined;
  // Every property is checked above at this untrusted event boundary.
  return input as unknown as FinalOrderEvent;
}
