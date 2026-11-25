import type { PoolConfig } from 'pg';

export class ConfigurationError extends Error {}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new ConfigurationError(`${name} is required`);
  return value;
}

function integer(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name] ?? String(fallback);
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new ConfigurationError(`${name} is outside its allowed range`);
  }
  return value;
}

export function identityDatabaseConfig(): PoolConfig {
  const mode = process.env.INCIDENT_SYSTEM_DATABASE_SSL_MODE ?? 'disable';
  if (!['disable', 'require'].includes(mode)) {
    throw new ConfigurationError('INCIDENT_SYSTEM_DATABASE_SSL_MODE must be disable or require');
  }
  return {
    host: process.env.INCIDENT_SYSTEM_DATABASE_HOST ?? '127.0.0.1',
    port: integer('INCIDENT_SYSTEM_DATABASE_PORT', 55432, 1, 65535),
    database: process.env.INCIDENT_SYSTEM_IDENTITY_DATABASE_NAME ?? 'incident_system_identity',
    user: process.env.INCIDENT_SYSTEM_IDENTITY_DATABASE_USER ?? 'incident_system_identity',
    password: required('INCIDENT_SYSTEM_IDENTITY_DATABASE_PASSWORD'),
    ssl: mode === 'require',
    connectionTimeoutMillis: 2000,
    statement_timeout: 2000,
    max: 5,
  };
}

export function identityDatabaseUrl(): string {
  const config = identityDatabaseConfig();
  const host = config.host ?? '127.0.0.1';
  const url = new URL(`postgresql://${host.includes(':') ? `[${host}]` : host}:${config.port}`);
  url.username = encodeURIComponent(config.user ?? '');
  url.password = encodeURIComponent(required('INCIDENT_SYSTEM_IDENTITY_DATABASE_PASSWORD'));
  url.pathname = `/${encodeURIComponent(config.database ?? '')}`;
  url.searchParams.set('sslmode', config.ssl ? 'require' : 'disable');
  return url.toString();
}

export function identityConfig() {
  return {
    database: identityDatabaseConfig(),
    address: process.env.INCIDENT_SYSTEM_IDENTITY_GRPC_ADDRESS ?? '127.0.0.1:50051',
    sessionTtl: integer('INCIDENT_SYSTEM_IDENTITY_SESSION_TTL_SECONDS', 604800, 60, 604800),
    authConcurrency: integer('INCIDENT_SYSTEM_IDENTITY_AUTH_CONCURRENCY', 4, 1, 16),
  };
}
