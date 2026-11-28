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
export function notificationDatabaseConfig(): PoolConfig {
  const mode = process.env.INCIDENT_SYSTEM_DATABASE_SSL_MODE ?? 'disable';
  if (!['disable', 'require'].includes(mode)) throw new ConfigurationError('INCIDENT_SYSTEM_DATABASE_SSL_MODE must be disable or require');
  return {host: process.env.INCIDENT_SYSTEM_DATABASE_HOST ?? '127.0.0.1', port: integer('INCIDENT_SYSTEM_DATABASE_PORT', 55432, 1, 65535), database: process.env.INCIDENT_SYSTEM_NOTIFICATION_DATABASE_NAME ?? 'incident_system_notification', user: process.env.INCIDENT_SYSTEM_NOTIFICATION_DATABASE_USER ?? 'incident_system_notification', password: required('INCIDENT_SYSTEM_NOTIFICATION_DATABASE_PASSWORD'), ssl: mode === 'require', connectionTimeoutMillis: 2000, statement_timeout: 2000, max: 5};
}
export function notificationDatabaseUrl(): string {
  const config = notificationDatabaseConfig();
  const host = config.host ?? '127.0.0.1';
  const url = new URL(`postgresql://${host.includes(':') ? `[${host}]` : host}:${config.port}`);
  url.username = config.user ?? '';
  url.password = required('INCIDENT_SYSTEM_NOTIFICATION_DATABASE_PASSWORD');
  url.pathname = `/${encodeURIComponent(config.database ?? '')}`;
  url.searchParams.set('sslmode', config.ssl ? 'require' : 'disable');
  return url.toString();
}
export function notificationConfig() {
  const endpoint = new URL(`http://${address('INCIDENT_SYSTEM_NOTIFICATION_HTTP_ADDRESS', '127.0.0.1:3002')}`);
  const failures = integer('INCIDENT_SYSTEM_NOTIFICATION_PROVIDER_FAILURES', 0, 0, 2);
  return {database: notificationDatabaseConfig(), host: endpoint.hostname.replace(/^\[|\]$/g, ''), port: Number(endpoint.port || 80), failures};
}
