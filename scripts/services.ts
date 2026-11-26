import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

export type ServiceName = 'identity' | 'gateway' | 'order' | 'inventory' | 'payment';

export function serviceEnvironment(service: ServiceName, overrides: NodeJS.ProcessEnv = {}, role: 'server' | 'publisher' = 'server'): NodeJS.ProcessEnv {
  const source = {...process.env, ...overrides};
  const env: NodeJS.ProcessEnv = {};
  const shared = new Set(['PATH', 'TZ', 'LANG']);
  if (service !== 'identity' && service !== 'payment') shared.add('GODEBUG');
  if (service === 'gateway' || service === 'payment') shared.add('INCIDENT_SYSTEM_INVENTORY_SERVICE_TOKEN');
  if (service === 'gateway') {
    for (const name of ['INCIDENT_SYSTEM_PAYMENT_SERVICE_TOKEN', 'INCIDENT_SYSTEM_ORDER_SERVICE_TOKEN', 'INCIDENT_SYSTEM_QSTASH_MODE', 'INCIDENT_SYSTEM_CALLBACK_BASE_URL']) shared.add(name);
    if (source.INCIDENT_SYSTEM_QSTASH_MODE !== 'local') {shared.add('INCIDENT_SYSTEM_QSTASH_CURRENT_SIGNING_KEY'); shared.add('INCIDENT_SYSTEM_QSTASH_NEXT_SIGNING_KEY');}
  }
  if (service === 'identity' || service === 'order' || service === 'payment') {
    for (const name of ['HOST', 'PORT', 'SSL_MODE']) shared.add(`INCIDENT_SYSTEM_DATABASE_${name}`);
  }
  if (role === 'publisher') {
    if (service !== 'payment') throw new Error('Unsupported publisher service');
    for (const name of ['INCIDENT_SYSTEM_QSTASH_MODE', 'INCIDENT_SYSTEM_QSTASH_LOCAL_URL', 'INCIDENT_SYSTEM_QSTASH_TOKEN', 'INCIDENT_SYSTEM_QSTASH_URL', 'INCIDENT_SYSTEM_CALLBACK_BASE_URL', 'INCIDENT_SYSTEM_PAYMENT_DATABASE_NAME', 'INCIDENT_SYSTEM_PAYMENT_DATABASE_USER', 'INCIDENT_SYSTEM_PAYMENT_DATABASE_PASSWORD']) shared.add(name);
    shared.delete('INCIDENT_SYSTEM_INVENTORY_SERVICE_TOKEN');
    if (source.INCIDENT_SYSTEM_QSTASH_MODE === 'local') {shared.delete('INCIDENT_SYSTEM_QSTASH_TOKEN'); shared.delete('INCIDENT_SYSTEM_QSTASH_URL');}
  }
  const prefix = `INCIDENT_SYSTEM_${service.toUpperCase()}_`;
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && (shared.has(key) || (role === 'server' && key.startsWith(prefix)))) env[key] = value;
  }
  return env;
}

function run(service: ServiceName): void {
  const role = service === 'payment' && process.argv[3] === 'publish' ? 'publisher' : 'server';
  const nodeService = service === 'identity' || service === 'payment';
  const command = nodeService ? process.execPath : resolve(`bin/${service}`);
  const args = nodeService ? [`dist/apps/${service}/src/${role === 'publisher' ? 'publisher' : 'main'}.js`] : process.argv.slice(3);
  const child = spawn(command, args, {stdio: 'inherit', env: serviceEnvironment(service, {}, role)});
  let stopping = false;
  const stop = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    child.kill(signal);
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
  child.once('error', () => { console.error('Unable to start service'); process.exitCode = 1; });
  child.once('exit', code => { process.exitCode = code ?? 1; });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const service = process.argv[2];
  if (service !== 'identity' && service !== 'gateway' && service !== 'order' && service !== 'inventory' && service !== 'payment') throw new Error('Choose identity, gateway, order, inventory, or payment');
  run(service);
}
