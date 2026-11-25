import {createHmac, timingSafeEqual} from 'node:crypto';

export function signProviderBody(body: Uint8Array, timestamp: string, secret: string): string {
  return createHmac('sha256', secret).update(timestamp).update('.').update(body).digest('hex');
}
export function verifyProviderBody(body: Uint8Array, timestamp: string, signature: string, secret: string): boolean {
  if (!/^\d{10}$/.test(timestamp) || !/^[a-f0-9]{64}$/.test(signature) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const expected = Buffer.from(signProviderBody(body, timestamp, secret), 'hex');
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}
