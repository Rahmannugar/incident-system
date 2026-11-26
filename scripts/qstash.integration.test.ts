import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createServer as createSocket} from 'node:net';
import {test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {Receiver} from '@upstash/qstash';
import {qstashConnection, qstashSigningKeys, qstashCallbackURL} from '../packages/qstash/config.ts';
import {startQStashContainer} from './qstash.ts';

test('real QStash Local Mode batch, raw-body/destination signatures and retry', {timeout: 30000}, async () => {
  // Force local mode even when the developer normally uses hosted EU credentials.
  const previousMode = process.env.INCIDENT_SYSTEM_QSTASH_MODE;
  const previousURL = process.env.INCIDENT_SYSTEM_QSTASH_LOCAL_URL;
  const previousCallback = process.env.INCIDENT_SYSTEM_CALLBACK_BASE_URL;
  process.env.INCIDENT_SYSTEM_QSTASH_MODE = 'local';
  const socket = createSocket();
  await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve));
  const address = socket.address(); assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  process.env.INCIDENT_SYSTEM_QSTASH_LOCAL_URL = `http://127.0.0.1:${port}`;
  const connection = qstashConnection();
  const receiver = new Receiver({...qstashSigningKeys(), devMode: false});
  const seen: {body: string; signature: string; path: string}[] = [];
  const attempts = new Map<string, number>();
  let destination = '';
  let failure: unknown;
  let local: Awaited<ReturnType<typeof startQStashContainer>> | undefined;
  const callback = createServer((request, response) => {
    void (async () => {
      const parts: Buffer[] = [];
      for await (const part of request) parts.push(Buffer.isBuffer(part) ? part : Buffer.from(String(part)));
      const body = Buffer.concat(parts).toString();
      const signature = request.headers['upstash-signature']; assert.equal(typeof signature, 'string');
      const path = request.url ?? '';
      assert.ok(await receiver.verify({body, signature: String(signature), url: destination + path}));
      seen.push({body, signature: String(signature), path});
      const count = (attempts.get(path) ?? 0) + 1; attempts.set(path, count);
      response.writeHead(path === '/retry' && count === 1 ? 503 : 200); response.end();
    })().catch(error => {failure = error; response.writeHead(500); response.end();});
  });
  try {
    local = await startQStashContainer(port);
    await new Promise<void>(resolve => callback.listen(0, '127.0.0.1', resolve));
    const callbackAddress = callback.address(); assert.ok(callbackAddress && typeof callbackAddress !== 'string');
    destination = `http://host.docker.internal:${callbackAddress.port}`;
    process.env.INCIDENT_SYSTEM_CALLBACK_BASE_URL = destination;
    assert.equal(qstashCallbackURL().origin, destination);
    process.env.INCIDENT_SYSTEM_QSTASH_MODE = 'hosted';
    assert.throws(() => qstashCallbackURL(), /HTTPS/);
    process.env.INCIDENT_SYSTEM_QSTASH_MODE = 'local';
    const response = await fetch(`${connection.baseURL}/v2/batch`, {method: 'POST', headers: {Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json'}, body: JSON.stringify(['/success', '/retry'].map(path => ({destination: destination + path, body: JSON.stringify({example: path}), headers: {'Content-Type': 'application/json', 'Upstash-Retries': '1', 'Upstash-Retry-Delay': '1000'}}))), signal: AbortSignal.timeout(5000)});
    assert.ok(response.ok, `Batch rejected with HTTP ${response.status}`);
    const accepted: unknown = await response.json(); assert.ok(Array.isArray(accepted)); assert.equal(accepted.length, 2);
    assert.ok(accepted.every(value => typeof value.messageId === 'string'));
    for (let i = 0; i < 100 && (attempts.get('/retry') ?? 0) < 2 && !failure; i++) await delay(100);
    if (failure) throw failure;
    assert.equal(attempts.get('/success'), 1); assert.equal(attempts.get('/retry'), 2);
    const first = seen[0]; assert.ok(first);
    await assert.rejects(receiver.verify({body: first.body + ' ', signature: first.signature, url: destination + first.path}));
    await assert.rejects(receiver.verify({body: first.body, signature: first.signature, url: destination + '/different'}));
    await assert.rejects(receiver.verify({body: first.body, signature: 'invalid', url: destination + first.path}));
    const retried = seen.filter(value => value.path === '/retry');
    assert.equal(retried[0]?.body, retried[1]?.body);
  } finally {
    await new Promise<void>(resolve => callback.close(() => resolve()));
    await local?.stop();
    if (previousMode === undefined) delete process.env.INCIDENT_SYSTEM_QSTASH_MODE; else process.env.INCIDENT_SYSTEM_QSTASH_MODE = previousMode;
    if (previousURL === undefined) delete process.env.INCIDENT_SYSTEM_QSTASH_LOCAL_URL; else process.env.INCIDENT_SYSTEM_QSTASH_LOCAL_URL = previousURL;
    if (previousCallback === undefined) delete process.env.INCIDENT_SYSTEM_CALLBACK_BASE_URL; else process.env.INCIDENT_SYSTEM_CALLBACK_BASE_URL = previousCallback;
  }
});
