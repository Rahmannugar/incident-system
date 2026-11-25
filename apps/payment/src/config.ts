import type {PoolConfig} from 'pg';

export class ConfigurationError extends Error {}
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new ConfigurationError(`${name} is required`);
  return value;
}
function integer(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name] ?? String(fallback);
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) throw new ConfigurationError(`${name} is outside its allowed range`);
  return value;
}
function address(name: string, fallback: string): string {
  const value = process.env[name] ?? fallback;
  try {
    const url = new URL(`http://${value}`);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !/^\d+$/.test(value.slice(value.lastIndexOf(':') + 1)) || url.pathname !== '/' || url.search || url.username || url.password) throw new Error();
  } catch { throw new ConfigurationError(`${name} must contain a loopback host and valid port`); }
  return value;
}
export function paymentDatabaseConfig(): PoolConfig {
  const mode = process.env.INCIDENT_SYSTEM_DATABASE_SSL_MODE ?? 'disable';
  if (!['disable', 'require'].includes(mode)) throw new ConfigurationError('INCIDENT_SYSTEM_DATABASE_SSL_MODE must be disable or require');
  return {host: process.env.INCIDENT_SYSTEM_DATABASE_HOST ?? '127.0.0.1', port: integer('INCIDENT_SYSTEM_DATABASE_PORT', 55432, 1, 65535), database: process.env.INCIDENT_SYSTEM_PAYMENT_DATABASE_NAME ?? 'incident_system_payment', user: process.env.INCIDENT_SYSTEM_PAYMENT_DATABASE_USER ?? 'incident_system_payment', password: required('INCIDENT_SYSTEM_PAYMENT_DATABASE_PASSWORD'), ssl: mode === 'require', connectionTimeoutMillis: 2000, statement_timeout: 2000, max: 5};
}
export function paymentDatabaseUrl(): string {
  const config = paymentDatabaseConfig();
  const host = config.host ?? '127.0.0.1';
  const url = new URL(`postgresql://${host.includes(':') ? `[${host}]` : host}:${config.port}`);
  url.username = config.user ?? '';
  url.password = required('INCIDENT_SYSTEM_PAYMENT_DATABASE_PASSWORD');
  url.pathname = `/${encodeURIComponent(config.database ?? '')}`;
  url.searchParams.set('sslmode', config.ssl ? 'require' : 'disable');
  return url.toString();
}
export function paymentConfig() {
  const secret = required('INCIDENT_SYSTEM_PAYMENT_WEBHOOK_SECRET');
  if (secret.length < 32) throw new ConfigurationError('INCIDENT_SYSTEM_PAYMENT_WEBHOOK_SECRET must contain at least 32 characters');
  const serviceToken = required('INCIDENT_SYSTEM_INVENTORY_SERVICE_TOKEN');
  if (serviceToken.length < 32) throw new ConfigurationError('INCIDENT_SYSTEM_INVENTORY_SERVICE_TOKEN must contain at least 32 characters');
  const currency = process.env.INCIDENT_SYSTEM_PAYMENT_CURRENCY ?? 'USD';
  if (!/^[A-Z]{3}$/.test(currency)) throw new ConfigurationError('INCIDENT_SYSTEM_PAYMENT_CURRENCY must be a three-letter currency code');
  const rpcTimeout = process.env.INCIDENT_SYSTEM_PAYMENT_RPC_TIMEOUT ?? '3s';
  const match = /^(\d+)(ms|s)$/.exec(rpcTimeout);
  const timeoutMs = match ? Number(match[1]) * (match[2] === 's' ? 1000 : 1) : 0;
  if (timeoutMs < 1 || timeoutMs > 30000) throw new ConfigurationError('INCIDENT_SYSTEM_PAYMENT_RPC_TIMEOUT must be between 1ms and 30s');
  return {database: paymentDatabaseConfig(), grpcAddress: address('INCIDENT_SYSTEM_PAYMENT_GRPC_ADDRESS', '127.0.0.1:50054'), httpAddress: address('INCIDENT_SYSTEM_PAYMENT_HTTP_ADDRESS', '127.0.0.1:3001'), orderAddress: address('INCIDENT_SYSTEM_PAYMENT_ORDER_ADDRESS', '127.0.0.1:50052'), inventoryAddress: address('INCIDENT_SYSTEM_PAYMENT_INVENTORY_ADDRESS', '127.0.0.1:50053'), serviceToken, secret, currency, timeoutMs, unitAmount: integer('INCIDENT_SYSTEM_PAYMENT_UNIT_AMOUNT_MINOR', 1000, 1, 1000000000)};
}
