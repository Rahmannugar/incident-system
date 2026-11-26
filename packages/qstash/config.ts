export class QStashConfigurationError extends Error {}
const loopback = new Set(['127.0.0.1', 'localhost', '[::1]']);
function mode(): 'local' | 'hosted' {
  const value = process.env.INCIDENT_SYSTEM_QSTASH_MODE ?? 'hosted';
  if (value !== 'local' && value !== 'hosted') throw new QStashConfigurationError('INCIDENT_SYSTEM_QSTASH_MODE must be local or hosted');
  return value;
}
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new QStashConfigurationError(`${name} is required`);
  return value;
}
export function qstashURL(name: string, fallback?: string, options: {local?: boolean; allowDockerHost?: boolean} = {}): URL {
  try {
    const value = process.env[name] ?? fallback;
    if (!value) throw new Error();
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error();
    const httpHost = loopback.has(url.hostname) || options.allowDockerHost && url.hostname === 'host.docker.internal';
    if (options.local ? url.protocol !== 'http:' || !loopback.has(url.hostname) : url.protocol !== 'https:' && !(url.protocol === 'http:' && httpHost)) throw new Error();
    return url;
  } catch {throw new QStashConfigurationError(`${name} must be ${options.local ? 'a loopback HTTP origin' : options.allowDockerHost ? 'an HTTPS, loopback or host.docker.internal HTTP origin' : 'an HTTPS or loopback HTTP origin'}`);}
}
export function qstashCallbackURL(): URL {
  return qstashURL('INCIDENT_SYSTEM_CALLBACK_BASE_URL', undefined, {allowDockerHost: mode() === 'local'});
}
export function qstashConnection() {
  if (mode() === 'local') {
    // Public credentials from Upstash's development server, never hosted secrets.
    return {mode: 'local' as const, baseURL: qstashURL('INCIDENT_SYSTEM_QSTASH_LOCAL_URL', 'http://127.0.0.1:8081', {local: true}).origin, token: Buffer.from(JSON.stringify({UserID: 'defaultUser', Password: 'defaultPassword'})).toString('base64')};
  }
  return {mode: 'hosted' as const, baseURL: qstashURL('INCIDENT_SYSTEM_QSTASH_URL', 'https://qstash.upstash.io').origin, token: required('INCIDENT_SYSTEM_QSTASH_TOKEN')};
}
export function qstashSigningKeys() {
  if (mode() === 'local') return {currentSigningKey: 'sig_7kYjw48mhY7kAjqNGcy6cr29RJ6r', nextSigningKey: 'sig_5ZB6DVzB1wjE8S6rZ7eenA8Pdnhs'};
  return {currentSigningKey: required('INCIDENT_SYSTEM_QSTASH_CURRENT_SIGNING_KEY'), nextSigningKey: required('INCIDENT_SYSTEM_QSTASH_NEXT_SIGNING_KEY')};
}
