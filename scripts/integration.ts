import assert from 'node:assert/strict';
import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {serviceEnvironment, type ServiceName} from './services.ts';

export function object(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

export interface Running {
  child: ChildProcessWithoutNullStreams;
  output: string;
  exited: Promise<{code: number | null; signal: NodeJS.Signals | null}>;
}

export async function start(service: ServiceName, env: NodeJS.ProcessEnv, children: Running[], role: 'server' | 'publisher' = 'server'): Promise<{process: Running; address: string; httpAddress?: string}> {
  const settings = service === 'identity'
    ? {INCIDENT_SYSTEM_IDENTITY_AUTH_CONCURRENCY: '4', INCIDENT_SYSTEM_IDENTITY_SESSION_TTL_SECONDS: '604800', ...env}
    : {INCIDENT_SYSTEM_GATEWAY_RPC_TIMEOUT: '3s', INCIDENT_SYSTEM_ORDER_RPC_TIMEOUT: '3s', ...env};
  const child = spawn(process.execPath, ['dist/scripts/services.js', service, ...(role === 'publisher' ? ['publish'] : [])], {env: serviceEnvironment(service, {...settings, INCIDENT_SYSTEM_TELEMETRY_SOURCE: 'integration'}, role)});
  const exited = new Promise<{code: number | null; signal: NodeJS.Signals | null}>(resolve => {
    child.once('exit', (code, signal) => resolve({code, signal}));
    child.once('error', () => resolve({code: 1, signal: null}));
  });
  const running: Running = {child, output: '', exited};
  children.push(running);
  let pending = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${service} startup timed out`)), 10000);
    child.stderr.on('data', (data: Buffer) => { running.output += data.toString(); });
    child.stdout.on('data', (data: Buffer) => {
      const text = data.toString();
      running.output += text;
      pending += text;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        let parsed: unknown;
        try { parsed = JSON.parse(line); } catch { continue; }
        const record = object(parsed);
        if (role === 'publisher' && (record.msg === 'outbox.started' || record.event === 'outbox.started')) {
          clearTimeout(timer); resolve({process: running, address: ''});
        }
        if (service === 'payment' && record.event === 'payment.started' && typeof record.port === 'number' && typeof record.http_port === 'number') {
          clearTimeout(timer); resolve({process: running, address: `127.0.0.1:${record.port}`, httpAddress: `127.0.0.1:${record.http_port}`});
        }
        if ((service === 'identity' || service === 'notification') && record.event === `${service}.started` && typeof record.port === 'number') {
          clearTimeout(timer); resolve({process: running, address: `127.0.0.1:${record.port}`});
        }
        if (service !== 'identity' && record.msg === `${service}.started` && typeof record.address === 'string') {
          clearTimeout(timer); resolve({process: running, address: record.address});
        }
      }
    });
    void exited.then(() => { clearTimeout(timer); reject(new Error(`${service} exited before startup completed`)); });
  });
}

export async function stop(process: Running): Promise<void> {
  if (process.child.exitCode !== null || process.child.signalCode !== null) return;
  process.child.kill('SIGTERM');
  const timer = setTimeout(() => process.child.kill('SIGKILL'), 7000);
  try {
    const exit = await process.exited;
    assert.equal(exit.code, 0, 'Service must shut down cleanly');
  } finally { clearTimeout(timer); }
}

