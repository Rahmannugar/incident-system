import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

export type ServiceName = 'identity' | 'gateway' | 'order' | 'inventory' | 'payment';

export function serviceEnvironment(service: ServiceName, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const source = {...process.env, ...overrides};
  const env: NodeJS.ProcessEnv = {};
  const shared = new Set(['PATH', 'TZ', 'LANG']);
  if (service !== 'identity' && service !== 'payment') shared.add('GODEBUG');
  if (service === 'gateway' || service === 'payment') shared.add('INCIDENT_SYSTEM_INVENTORY_SERVICE_TOKEN');
  if (service === 'identity' || service === 'order' || service === 'payment') {
    for (const name of ['HOST', 'PORT', 'SSL_MODE']) shared.add(`INCIDENT_SYSTEM_DATABASE_${name}`);
  }
  const prefix = `INCIDENT_SYSTEM_${service.toUpperCase()}_`;
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && (shared.has(key) || key.startsWith(prefix))) env[key] = value;
  }
  return env;
}

function run(service: ServiceName): void {
  const nodeService = service === 'identity' || service === 'payment';
  const command = nodeService ? process.execPath : resolve(`bin/${service}`);
  const args = nodeService ? [`dist/apps/${service}/src/main.js`] : process.argv.slice(3);
  const child = spawn(command, args, {stdio: 'inherit', env: serviceEnvironment(service)});
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
