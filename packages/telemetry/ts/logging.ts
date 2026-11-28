// Static explanations keep operational logs useful without serializing exception
// messages, SQL details, request bodies or configured connection strings.
export function failureFields(error: unknown): Record<string, string> {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) {
    const message = code === '57014' ? 'Database operation was cancelled or exceeded its time limit'
      : code.startsWith('23') ? 'Database rejected a write that violates a data constraint'
      : code.startsWith('08') || code.startsWith('53') || code.startsWith('57') ? 'Database connection or availability failure'
      : 'Database operation failed';
    return {error_type: 'database', sqlstate: code, error_message: message};
  }
  if (typeof code === 'string' && ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN'].includes(code)) {
    return {error_type: 'connection', error_code: code, error_message: 'A dependency connection failed'};
  }
  return {error_type: 'internal', error_code: 'unexpected_failure', error_message: 'Operation failed unexpectedly'};
}

const messages: Record<string, string> = {
  'outbox.batch': 'Finished publishing an outbox batch; item counts describe the results',
  'outbox.started': 'Outbox publisher started',
  'outbox.stopped': 'Outbox publisher stopped',
  'outbox.listener_unavailable': 'Database notification listener is unavailable; polling will continue',
  'outbox.batch_unconfirmed': 'Outbox batch could not be confirmed; leased events remain eligible for recovery',
  'outbox.start_failed': 'Outbox publisher could not start',
  'database.connection_lost': 'An idle database connection was lost',
};
export function eventMessage(service: string, event: string): string {
  if (messages[event]) return messages[event];
  const action = event.split('.').at(-1);
  if (action === 'started') return `${service} service started`;
  if (action === 'stopped') return `${service} service stopped`;
  if (action === 'start_failed') return `${service} service could not start`;
  if (action === 'shutdown_failed') return `${service} service could not shut down cleanly`;
  return event.replace(/[._]/g, ' ');
}

export function businessFields(input: unknown): Record<string, string> {
  if (!input || typeof input !== 'object') return {};
  const row = input as Record<string, unknown>, fields: Record<string, string> = {};
  for (const [key, name] of [['orderId', 'order_id'], ['paymentId', 'payment_id']] as const) {
    const value = row[key];
    if (typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value)) fields[name] = value;
  }
  return fields;
}
