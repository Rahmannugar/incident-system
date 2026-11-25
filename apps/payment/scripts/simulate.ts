import {parseArgs} from 'node:util';
import {randomUUID} from 'node:crypto';
import {signProviderBody} from '../src/payments/provider-signature.ts';
import {uuidPattern} from '../src/payments/payments.types.ts';

async function main() {
  const {values} = parseArgs({options: {'payment-id': {type: 'string'}, outcome: {type: 'string'}, 'event-id': {type: 'string'}}});
  const paymentId = values['payment-id'];
  const eventId = values['event-id'] ?? randomUUID();
  if (!paymentId || !uuidPattern.test(paymentId) || !uuidPattern.test(eventId) || !['succeeded', 'failed'].includes(values.outcome ?? '')) throw new Error('Use --payment-id UUID --outcome succeeded|failed [--event-id UUID]');
  const secret = process.env.INCIDENT_SYSTEM_PAYMENT_WEBHOOK_SECRET;
  if (!secret || secret.length < 32) throw new Error('INCIDENT_SYSTEM_PAYMENT_WEBHOOK_SECRET is required');
  const body = Buffer.from(JSON.stringify({event_id: eventId, payment_id: paymentId, outcome: values.outcome}));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const address = process.env.INCIDENT_SYSTEM_PAYMENT_HTTP_ADDRESS ?? '127.0.0.1:3001';
  const response = await fetch(`http://${address}/webhooks/provider`, {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Payment-Timestamp': timestamp, 'X-Payment-Signature': signProviderBody(body, timestamp, secret)}, body, signal: AbortSignal.timeout(5000)});
  if (!response.ok) throw new Error(`Provider webhook returned HTTP ${response.status}`);
  console.log(JSON.stringify({event_id: eventId, payment_id: paymentId, outcome: values.outcome, delivery_status: response.status}));
}
void main().catch(error => {console.error(error instanceof Error && (error.message.startsWith('Use --') || error.message.startsWith('INCIDENT_SYSTEM_') || error.message.startsWith('Provider webhook')) ? error.message : 'Simulated provider delivery failed'); process.exitCode = 1;});
