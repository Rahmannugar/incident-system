import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {qstashConnection} from '../packages/qstash/config.ts';

const execute = promisify(execFile);

export async function waitForQStash(baseURL: string): Promise<void> {
  const connection = qstashConnection();
  if (connection.mode !== 'local') throw new Error('Set INCIDENT_SYSTEM_QSTASH_MODE=local for the development container');
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`${baseURL}/v2/topics`, {headers: {Authorization: `Bearer ${connection.token}`}, signal: AbortSignal.timeout(500)});
      await response.arrayBuffer();
      if (response.ok) return;
    } catch { /* The container's API listener may not yet be ready. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('QStash container readiness timed out');
}

export async function startQStashContainer(port: number) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid QStash API port');
  const image = (await execute('docker', ['compose', 'config', '--images', 'qstash'])).stdout.trim();
  if (!/^public\.ecr\.aws\/upstash\/qstash(?:[:@])[A-Za-z0-9:._-]+$/.test(image)) throw new Error('Invalid QStash image configuration');
  // A unique container owns this check; never restart or erase the Console's server.
  // Host callbacks use host.docker.internal because localhost is inside Docker.
  const name = `incident-system-qstash-check-${randomUUID()}`;
  const {stdout} = await execute('docker', ['run', '--detach', '--rm', '--name', name, '--publish', `127.0.0.1:${port}:8080`, '--add-host', 'host.docker.internal:host-gateway', image, 'qstash', 'dev', '-port=8080', '-log-port=8081']);
  const id = stdout.trim();
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid QStash container identifier');
  const stop = async () => {await execute('docker', ['stop', '--time', '5', id]);};
  try {await waitForQStash(`http://127.0.0.1:${port}`); return {stop};}
  catch (error) {await stop(); throw error;}
}

async function main() {
  const connection = qstashConnection();
  await waitForQStash(connection.baseURL);
  console.log(`QStash container API: ${connection.baseURL}`);
  console.log('Upstash Console Local Mode address: http://localhost:8081');
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void main().catch(() => {console.error('QStash container unavailable; use local mode and run task qstash-local'); process.exitCode = 1;});
}
