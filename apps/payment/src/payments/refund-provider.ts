// This provider simulates a full refund without transferring money. Its stable
// reference makes recovery after a lost acknowledgement return the same effect.
export function simulateFullRefund(payment: {id: string; amount_minor: string; currency: string}): string {
  if (BigInt(payment.amount_minor) < 1n || !/^[A-Z]{3}$/.test(payment.currency)) throw new Error('Invalid refund amount');
  return `simulated_refund_${payment.id}`;
}
