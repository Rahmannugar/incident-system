import {eventMessage} from '../../../packages/telemetry/ts/logging.ts';
import {traceFields} from '../../../packages/telemetry/ts/telemetry.ts';
export function log(level: 'info' | 'warn' | 'error', event: string, fields: Record<string, string | number | boolean> = {}): void {
  console.log(JSON.stringify({time: new Date().toISOString(), service: 'identity', level, event, message: eventMessage('identity', event), ...fields, ...traceFields()}));
}
