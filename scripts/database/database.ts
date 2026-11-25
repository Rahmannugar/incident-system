import { Pool, type PoolConfig } from 'pg';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function databaseConfig(): PoolConfig {
  const rawPort = required('INCIDENT_SYSTEM_DATABASE_PORT');
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('INCIDENT_SYSTEM_DATABASE_PORT must be between 1 and 65535');
  }
  const sslMode = required('INCIDENT_SYSTEM_DATABASE_SSL_MODE');
  if (sslMode !== 'disable' && sslMode !== 'require') {
    throw new Error('INCIDENT_SYSTEM_DATABASE_SSL_MODE must be disable or require');
  }
  return {
    host: required('INCIDENT_SYSTEM_DATABASE_HOST'),
    port,
    database: required('INCIDENT_SYSTEM_DATABASE_NAME'),
    user: required('INCIDENT_SYSTEM_DATABASE_USER'),
    password: required('INCIDENT_SYSTEM_DATABASE_PASSWORD'),
    ssl: sslMode === 'require',
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
    max: 2,
  };
}

export function databaseUrl(): string {
  const config = databaseConfig();
  const host = required('INCIDENT_SYSTEM_DATABASE_HOST');
  const authority = host.includes(':') ? `[${host}]` : host;
  const url = new URL(`postgresql://${authority}:${config.port}`);
  url.username = encodeURIComponent(required('INCIDENT_SYSTEM_DATABASE_USER'));
  url.password = encodeURIComponent(required('INCIDENT_SYSTEM_DATABASE_PASSWORD'));
  url.pathname = `/${encodeURIComponent(required('INCIDENT_SYSTEM_DATABASE_NAME'))}`;
  url.searchParams.set('sslmode', config.ssl ? 'require' : 'disable');
  return url.toString();
}

export function createDatabasePool(): Pool {
  return new Pool(databaseConfig());
}
