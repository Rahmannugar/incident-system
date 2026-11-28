import {logCapture} from './log-capture.ts';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

export type ServiceName = 'identity' | 'gateway' | 'order' | 'inventory' | 'payment' | 'notification';

export function serviceEnvironment(service: ServiceName, overrides: NodeJS.ProcessEnv = {}, role: 'server' | 'publisher' = 'server'): NodeJS.ProcessEnv {
  const source = {...process.env, ...overrides};
  const env: NodeJS.ProcessEnv = {};
  const shared = new Set(['PATH', 'TZ', 'LANG', 'INCIDENT_SYSTEM_TELEMETRY_ENABLED', 'INCIDENT_SYSTEM_TELEMETRY_OTLP_ENDPOINT', 'INCIDENT_SYSTEM_TELEMETRY_CONSOLE', 'INCIDENT_SYSTEM_TELEMETRY_SOURCE', 'INCIDENT_SYSTEM_TELEMETRY_METRICS_ENDPOINT']);
  if (service !== 'identity' && service !== 'payment' && service !== 'notification') shared.add('GODEBUG');
  if (service === 'gateway' || service === 'payment') shared.add('INCIDENT_SYSTEM_INVENTORY_SERVICE_TOKEN');
  if (service === 'gateway') {
    for (const name of ['INCIDENT_SYSTEM_PAYMENT_SERVICE_TOKEN', 'INCIDENT_SYSTEM_ORDER_SERVICE_TOKEN', 'INCIDENT_SYSTEM_QSTASH_MODE', 'INCIDENT_SYSTEM_CALLBACK_BASE_URL']) shared.add(name);
    if (source.INCIDENT_SYSTEM_QSTASH_MODE !== 'local') {shared.add('INCIDENT_SYSTEM_QSTASH_CURRENT_SIGNING_KEY'); shared.add('INCIDENT_SYSTEM_QSTASH_NEXT_SIGNING_KEY');}
  }
  if (service === 'identity' || service === 'order' || service === 'payment' || service === 'notification') {
    for (const name of ['HOST', 'PORT', 'SSL_MODE']) shared.add(`INCIDENT_SYSTEM_DATABASE_${name}`);
  }
  if (role === 'publisher') {
    if (service !== 'payment' && service !== 'order') throw new Error('Unsupported publisher service');
    for (const name of ['INCIDENT_SYSTEM_QSTASH_MODE', 'INCIDENT_SYSTEM_QSTASH_LOCAL_URL', 'INCIDENT_SYSTEM_QSTASH_TOKEN', 'INCIDENT_SYSTEM_QSTASH_URL', 'INCIDENT_SYSTEM_CALLBACK_BASE_URL', `INCIDENT_SYSTEM_${service.toUpperCase()}_DATABASE_NAME`, `INCIDENT_SYSTEM_${service.toUpperCase()}_DATABASE_USER`, `INCIDENT_SYSTEM_${service.toUpperCase()}_DATABASE_PASSWORD`]) shared.add(name);
    if (service === 'order') {shared.add('INCIDENT_SYSTEM_NOTIFICATION_CALLBACK_BASE_URL');shared.delete('INCIDENT_SYSTEM_CALLBACK_BASE_URL');}
    shared.delete('INCIDENT_SYSTEM_INVENTORY_SERVICE_TOKEN');
    if (source.INCIDENT_SYSTEM_QSTASH_MODE === 'local') {shared.delete('INCIDENT_SYSTEM_QSTASH_TOKEN'); shared.delete('INCIDENT_SYSTEM_QSTASH_URL');}
  }
  if (service === 'notification') {
    shared.add('INCIDENT_SYSTEM_QSTASH_MODE');
    if (source.INCIDENT_SYSTEM_QSTASH_MODE !== 'local') {shared.add('INCIDENT_SYSTEM_QSTASH_CURRENT_SIGNING_KEY'); shared.add('INCIDENT_SYSTEM_QSTASH_NEXT_SIGNING_KEY');}
  }
  const prefix = `INCIDENT_SYSTEM_${service.toUpperCase()}_`;
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && (shared.has(key) || (role === 'server' && key.startsWith(prefix)))) env[key] = value;
  }
  env.INCIDENT_SYSTEM_PROCESS_ROLE = role;
  return env;
}

function run(service: ServiceName): void {
  const role = (service === 'payment' || service === 'order') && process.argv[3] === 'publish' ? 'publisher' : 'server';
  const nodeService = service === 'identity' || service === 'payment' || service === 'notification';
  const command = nodeService ? process.execPath : resolve(`bin/${service}${role === 'publisher' ? '-publisher' : ''}`);
  const args = nodeService ? [`dist/apps/${service}/src/${role === 'publisher' ? 'publisher' : 'main'}.js`] : role === 'publisher' ? [] : process.argv.slice(3);
  let capture: ReturnType<typeof logCapture> | undefined;
  try {capture = logCapture(service, role, undefined, process.env.INCIDENT_SYSTEM_TELEMETRY_SOURCE === 'integration' ? 'integration' : 'application');} catch {console.error('Structured log capture unavailable');}
  const child = spawn(command, args, {stdio: ['inherit', 'pipe', 'pipe'], env: serviceEnvironment(service, {}, role)});
  for (const [source, target] of [[child.stdout, process.stdout], [child.stderr, process.stderr]] as const) {
    source?.on('data', (chunk: Buffer) => {if (source === child.stdout) capture?.write(chunk); if (!target.write(chunk)) {source.pause(); target.once('drain', () => source.resume());}});
  }
  let stopping = false;
  const stop = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    child.kill(signal);
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
  child.once('error', () => { console.error('Unable to start service'); process.exitCode = 1; });
  child.once('close', code => { capture?.close(); process.exitCode = code ?? 1; });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const service = process.argv[2];
  if (service !== 'identity' && service !== 'gateway' && service !== 'order' && service !== 'inventory' && service !== 'payment' && service !== 'notification') throw new Error('Choose identity, gateway, order, inventory, payment, or notification');
  run(service);
}
