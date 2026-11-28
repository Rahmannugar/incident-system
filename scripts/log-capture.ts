import {constants, closeSync, existsSync, mkdirSync, openSync, readdirSync, renameSync, statSync, unlinkSync, writeSync} from 'node:fs';
import {resolve} from 'node:path';
import type {ServiceName} from './services.ts';

const fields = new Set(['operation', 'request_id', 'trace_id', 'span_id', 'order_id', 'payment_id', 'event_id', 'provider_event_id', 'status', 'code', 'duration_ms', 'applied', 'duplicate', 'claimed', 'acknowledged', 'published', 'exhausted', 'dependency', 'port', 'http_port', 'message', 'error_type', 'error_code', 'error_message', 'sqlstate', 'outcome', 'outcome_reason', 'retryable', 'attempt', 'provider', 'provider_message_id', 'sku', 'quantity', 'reservation_state', 'event_type']);
export function capturedLog(line: string, service: ServiceName, role: 'server' | 'publisher' = 'server', source: 'application' | 'integration' = 'application'): string | undefined {
  let value: unknown; try {value = JSON.parse(line);} catch {return undefined;}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const event = input.event ?? input.msg;
  if (typeof event !== 'string' || !/^[a-z][a-z0-9_.]{0,80}$/.test(event) || event === 'trace.completed') return undefined;
  const record: Record<string, string | number | boolean> = {time: typeof input.time === 'string' && Number.isFinite(Date.parse(input.time)) ? input.time : new Date().toISOString(), service, process_role: role, source, event, level: ['info', 'warn', 'error', 'debug'].includes(String(input.level).toLowerCase()) ? String(input.level).toLowerCase() : 'info'};
  // Persist only operational fields; bodies, addresses, raw errors and arbitrary
  // extra keys cannot enter the file receiver or its downstream log store.
  for (const key of fields) {
    const field = input[key];
    if (typeof field === 'string' && field.length <= 256 && !/[\r\n]/.test(field)) record[key] = field;
    else if (typeof field === 'number' && Number.isFinite(field) || typeof field === 'boolean') record[key] = field;
  }
  return JSON.stringify(record) + '\n';
}
export function logCapture(service: ServiceName, role: 'server' | 'publisher', directory = resolve('local/runtime/logs'), source: 'application' | 'integration' = 'application') {
  mkdirSync(directory, {recursive: true, mode: 0o700});
  const prefix = `${service}-${role}-`;
  const files = readdirSync(directory).filter(name => name.startsWith(prefix) && /-\d+(?:\.[1-3])?\.jsonl$/.test(name));
  const inactive = new Map<string, number>();
  for (const file of files) {
    const id = file.slice(prefix.length).split('.')[0]; if (!id || !/^\d+$/.test(id)) continue;
    try {process.kill(Number(id), 0); continue;} catch { /* Reclaim only this project's inactive capture files. */ }
    inactive.set(id, Math.max(inactive.get(id) ?? 0, statSync(resolve(directory, file)).mtimeMs));
  }
  const keep = new Set([...inactive].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id]) => id));
  for (const file of files) {
    const id = file.slice(prefix.length).split('.')[0]; if (id && inactive.has(id) && !keep.has(id)) unlinkSync(resolve(directory, file));
  }
  const path = resolve(directory, `${prefix}${process.pid}.jsonl`);
  const segment = (index: number) => path.replace(/\.jsonl$/, `.${index}.jsonl`);
  const open = () => openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
  let fd = open(), bytes = statSync(path).size, pending = '', failed = false;
  const rotate = () => {
    closeSync(fd); fd = -1;
    if (existsSync(segment(3))) unlinkSync(segment(3));
    for (let index = 2; index >= 1; index--) if (existsSync(segment(index))) renameSync(segment(index), segment(index + 1));
    renameSync(path, segment(1)); fd = open(); bytes = 0;
  };
  return {
    write(chunk: Buffer) {
      if (failed) return;
      try {
        pending += chunk.toString();
        const lines = pending.split('\n'); pending = lines.pop() ?? '';
        if (pending.length > 32768) pending = '';
        for (const line of lines) {
          if (Buffer.byteLength(line) > 32768) continue;
          const safe = capturedLog(line, service, role, source); if (!safe) continue;
          if (bytes + Buffer.byteLength(safe) > 2 * 1024 * 1024) rotate();
          writeSync(fd, safe); bytes += Buffer.byteLength(safe);
        }
      } catch {failed = true; console.error('Structured log capture unavailable');}
    },
    close() {if (fd >= 0) {try {closeSync(fd);} catch {console.error('Structured log capture could not close');} fd = -1;}},
  };
}
