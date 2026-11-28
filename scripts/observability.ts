import {mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

const endpoints = {prometheus: 'http://127.0.0.1:19090/-/ready', collector: 'http://127.0.0.1:13133/', tempo: 'http://127.0.0.1:13200/ready', loki: 'http://127.0.0.1:13100/ready', grafana: 'http://127.0.0.1:13000/api/health'};
export async function observabilityReady() {
  const missing = new Set(Object.keys(endpoints));
  for (let attempt = 0; attempt < 90 && missing.size; attempt++) {
    await Promise.all(Object.entries(endpoints).filter(([name]) => missing.has(name)).map(async ([name, url]) => {
      try {const response = await fetch(url, {signal: AbortSignal.timeout(1000)}); await response.arrayBuffer(); if (response.ok) missing.delete(name);} catch { /* Containers can take time to recover local storage. */ }
    }));
    if (missing.size) await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (missing.size) throw new Error(`Observability services unavailable: ${[...missing].join(', ')}`);
}
async function main() {
  if (process.argv[2] === 'prepare') {mkdirSync('local/runtime/logs', {recursive: true, mode: 0o700}); return;}
  if (process.argv[2] !== 'ready') throw new Error('Choose prepare or ready');
  await observabilityReady(); console.log('Collector, Tempo, Loki, Prometheus and Grafana are ready. Grafana: http://localhost:13000');
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void main().catch(error => {console.error(error instanceof Error ? error.message : 'Observability readiness failed'); process.exitCode = 1;});
}
