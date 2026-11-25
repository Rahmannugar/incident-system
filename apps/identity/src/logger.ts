export function log(level: 'info' | 'warn' | 'error', event: string, fields: Record<string, string | number | boolean> = {}): void {
  console.log(JSON.stringify({time: new Date().toISOString(), service: 'identity', level, event, ...fields}));
}
