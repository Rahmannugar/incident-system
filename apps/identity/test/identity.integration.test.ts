import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {test} from 'node:test';
import {Pool} from 'pg';
import {identityDatabaseConfig} from '../src/config.ts';
import {databaseConfig} from '../../../scripts/database/database.ts';
import {serviceEnvironment} from '../../../scripts/services.ts';
import {object, start, stop, type Running} from '../../../scripts/integration.ts';
import {AuthRepository} from '../src/auth/auth.repository.ts';
import {tokenHash} from '../src/auth/auth.service.ts';

interface Session {
  user: {id: string; email: string};
  token: string;
}

function readSession(value: unknown): Session {
  const record = object(value);
  const user = object(record.user);
  assert.equal(typeof user.id, 'string');
  assert.equal(typeof user.email, 'string');
  assert.equal(typeof record.token, 'string');
  assert.equal(typeof record.expires_at, 'string');
  assert.equal(String(record.token).length, 43);
  assert.ok(Date.parse(String(record.expires_at)) > Date.now());
  return {user: {id: String(user.id), email: String(user.email)}, token: String(record.token)};
}

test('HTTP Gateway → gRPC Identity → PostgreSQL authentication and failure boundaries', {timeout: 60000}, async () => {
  const pool = new Pool(identityDatabaseConfig());
  const children: Running[] = [];
  const prefix = `slice2-${randomUUID()}`;
  const email = `${prefix}@example.test`;
  const raceEmail = `${prefix}-race@example.test`;
  const rollbackEmail = `${prefix}-rollback@example.test`;
  const password = 'An-integration-password-42';
  const secrets = [password, 'An-incorrect-password-42'];
  try {
    assert.equal(serviceEnvironment('gateway').INCIDENT_SYSTEM_DATABASE_ADMIN_PASSWORD, undefined);
    assert.equal(serviceEnvironment('gateway').INCIDENT_SYSTEM_IDENTITY_DATABASE_PASSWORD, undefined);
    assert.equal(serviceEnvironment('identity').INCIDENT_SYSTEM_DATABASE_ADMIN_PASSWORD, undefined);
    assert.equal(serviceEnvironment('identity').INCIDENT_SYSTEM_DATABASE_PASSWORD, undefined);
    const identity = await start('identity', {INCIDENT_SYSTEM_IDENTITY_GRPC_ADDRESS: '127.0.0.1:0'}, children);
    const order = await start('order', {INCIDENT_SYSTEM_ORDER_GRPC_ADDRESS: '127.0.0.1:0', INCIDENT_SYSTEM_ORDER_IDENTITY_ADDRESS: identity.address}, children);
    const gateway = await start('gateway', {INCIDENT_SYSTEM_GATEWAY_HTTP_ADDRESS: '127.0.0.1:0', INCIDENT_SYSTEM_GATEWAY_IDENTITY_ADDRESS: identity.address, INCIDENT_SYSTEM_GATEWAY_ORDER_ADDRESS: order.address}, children);
    const base = `http://${gateway.address}`;
    async function request(path: string, body?: unknown, token?: string, requestId?: string) {
      const headers: Record<string, string> = {};
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (token) headers.Authorization = `Bearer ${token}`;
      if (requestId) headers['X-Request-ID'] = requestId;
      const options: RequestInit = {method: body === undefined ? 'GET' : 'POST', headers};
      if (body !== undefined) options.body = JSON.stringify(body);
      const response = await fetch(base + path, options);
      const json: unknown = await response.json();
      return {response, body: json};
    }
    assert.equal((await request('/health/live')).response.status, 200);
    assert.equal((await request('/health/ready')).response.status, 200);
    assert.equal((await request('/auth/signup', {email: 'invalid', password})).response.status, 400);
    assert.equal((await request('/auth/signup', {email, password: 'short'})).response.status, 400);
    assert.equal((await request('/auth/signup', {email, password, extra: true})).response.status, 400);
    const invalidJson = await fetch(base + '/auth/signup', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{'});
    assert.equal(invalidJson.status, 400);
    await invalidJson.arrayBuffer();
    const tooLarge = await fetch(base + '/auth/signup', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({email, password: 'a'.repeat(5000)})});
    assert.equal(tooLarge.status, 413);
    await tooLarge.arrayBuffer();

    const requestId = `signup_${randomUUID()}`;
    const signup = await request('/auth/signup', {email: ` ${email.toUpperCase()} `, password}, undefined, requestId);
    assert.equal(signup.response.status, 201);
    assert.equal(signup.response.headers.get('x-request-id'), requestId);
    assert.equal(signup.response.headers.get('cache-control'), 'no-store');
    const registered = readSession(signup.body);
    secrets.push(registered.token);
    assert.equal(registered.user.email, email);
    const remaining = Date.parse(String(object(signup.body).expires_at)) - Date.now();
    assert.ok(remaining > 7 * 86400000 - 60000 && remaining <= 7 * 86400000, 'New sessions expire after seven days');
    const {rows: [stored]} = await pool.query('SELECT password_hash FROM identity.users WHERE id = $1', [registered.user.id]);
    assert.equal(stored.password_hash === password, false);
    assert.match(stored.password_hash, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    const {rows: [persisted]} = await pool.query('SELECT token_hash FROM identity.sessions WHERE user_id = $1', [registered.user.id]);
    assert.equal(persisted.token_hash === registered.token, false);
    assert.equal(persisted.token_hash === tokenHash(registered.token), true);
    assert.equal((await request('/auth/signup', {email: email.toUpperCase(), password})).response.status, 409);

    const race = await Promise.all([request('/auth/signup', {email: raceEmail, password}), request('/auth/signup', {email: raceEmail.toUpperCase(), password})]);
    assert.deepEqual(race.map(r => r.response.status).sort(), [201, 409]);
    const winner = race.find(r => r.response.status === 201);
    assert.ok(winner);
    secrets.push(readSession(winner.body).token);
    const {rows: [raceCount]} = await pool.query('SELECT count(*)::int AS count FROM identity.users WHERE email = $1', [raceEmail]);
    assert.equal(raceCount.count, 1);

    const wrong = await request('/auth/login', {email, password: 'An-incorrect-password-42'});
    const unknown = await request('/auth/login', {email: `${prefix}-missing@example.test`, password});
    assert.equal(wrong.response.status, 401);
    assert.equal(unknown.response.status, 401);
    assert.deepEqual(wrong.body, unknown.body);
    const login = await request('/auth/login', {email, password});
    assert.equal(login.response.status, 200);
    const authenticated = readSession(login.body);
    secrets.push(authenticated.token);
    assert.equal(authenticated.user.id, registered.user.id);
    assert.equal((await request('/auth/me')).response.status, 401);
    assert.equal((await request('/auth/me', undefined, authenticated.token)).response.status, 200);
    const tampered = authenticated.token.slice(0, -1) + (authenticated.token.endsWith('a') ? 'b' : 'a');
    assert.equal((await request('/auth/me', undefined, tampered)).response.status, 401);
    await pool.query("UPDATE identity.sessions SET expires_at = now() - interval '1 second' WHERE token_hash = $1", [tokenHash(registered.token)]);
    assert.equal((await request('/auth/me', undefined, registered.token)).response.status, 401);
    assert.equal((await request('/auth/me', undefined, authenticated.token)).response.status, 200);

    const repository = new AuthRepository(pool);
    await assert.rejects(repository.register({userId: randomUUID(), email: rollbackEmail, passwordHash: stored.password_hash, tokenHash: 'invalid', ttlSeconds: 3600}, () => {}), {code: '23514'});
    const {rows: rollbackRows} = await pool.query('SELECT id FROM identity.users WHERE email = $1', [rollbackEmail]);
    assert.equal(rollbackRows.length, 0);

    const otherRole = new Pool({...databaseConfig(), database: identityDatabaseConfig().database});
    try { await assert.rejects(otherRole.query('SELECT 1'), {code: '42501'}); } finally { await otherRole.end(); }

    const concurrencyLock = await pool.connect();
    let pendingLogins: ReturnType<typeof request>[] = [];
    try {
      await concurrencyLock.query('BEGIN');
      await concurrencyLock.query('LOCK TABLE identity.users IN ACCESS EXCLUSIVE MODE');
      pendingLogins = Array.from({length: 4}, () => request('/auth/login', {email, password}));
      let blocked = 0;
      for (let i = 0; i < 40; i++) {
        const {rows: [activity]} = await pool.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND usename = current_user AND wait_event_type = 'Lock' AND query LIKE '%identity.users%'");
        blocked = activity.count;
        if (blocked === 4) break;
        await delay(10);
      }
      assert.equal(blocked, 4, 'Establish four in-flight authentication requests');
      assert.equal((await request('/auth/login', {email, password})).response.status, 429);
    } finally { await concurrencyLock.query('ROLLBACK'); concurrencyLock.release(); }
    for (const result of await Promise.all(pendingLogins)) {
      assert.equal(result.response.status, 200);
      secrets.push(readSession(result.body).token);
    }
    const {rows: [beforeDeadline]} = await pool.query('SELECT count(*)::int AS count FROM identity.sessions WHERE user_id = $1', [registered.user.id]);

    const slowGateway = await start('gateway', {INCIDENT_SYSTEM_GATEWAY_HTTP_ADDRESS: '127.0.0.1:0', INCIDENT_SYSTEM_GATEWAY_IDENTITY_ADDRESS: identity.address, INCIDENT_SYSTEM_GATEWAY_ORDER_ADDRESS: order.address, INCIDENT_SYSTEM_GATEWAY_RPC_TIMEOUT: '120ms'}, children);
    const locker = await pool.connect();
    try {
      await locker.query('BEGIN');
      await locker.query('LOCK TABLE identity.users IN ACCESS EXCLUSIVE MODE');
      const timedOut = await fetch(`http://${slowGateway.address}/auth/login`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({email, password})});
      assert.equal(timedOut.status, 504);
      await timedOut.arrayBuffer();
    } finally { await locker.query('ROLLBACK'); locker.release(); }
    await stop(slowGateway.process);
    await delay(150);
    const {rows: [sessions]} = await pool.query('SELECT count(*)::int AS count FROM identity.sessions WHERE user_id = $1', [registered.user.id]);
    assert.equal(sessions.count, beforeDeadline.count, 'Timed-out login must not create a session after its blocked read resumes');

    await stop(identity.process);
    assert.equal((await request('/health/live')).response.status, 200);
    assert.equal((await request('/health/ready')).response.status, 503);
    assert.equal((await request('/auth/login', {email, password})).response.status, 503);
    await start('identity', {INCIDENT_SYSTEM_IDENTITY_GRPC_ADDRESS: identity.address}, children);
    let ready = false;
    for (let i = 0; i < 30; i++) {
      if ((await request('/health/ready')).response.status === 200) { ready = true; break; }
      await delay(100);
    }
    assert.equal(ready, true, 'Gateway must reconnect after Identity restarts');
    assert.equal((await request('/auth/me', undefined, authenticated.token)).response.status, 200, 'Sessions must survive process restart');
    assert.equal((await request('/auth/logout', {})).response.status, 401);
    for (let attempt = 0; attempt < 2; attempt++) {
      const logout = await fetch(base + '/auth/logout', {method: 'POST', headers: {Authorization: `Bearer ${authenticated.token}`}});
      assert.equal(logout.status, 204);
    }
    assert.equal((await request('/auth/me', undefined, authenticated.token)).response.status, 401, 'Logged-out session cannot be reused');
    const stillActive = await request('/auth/login', {email, password});
    assert.equal(stillActive.response.status, 200, 'Logout does not remove the account');
    secrets.push(readSession(stillActive.body).token);
    for (const child of children) await stop(child);
    const logs = children.map(child => child.output).join('\n');
    assert.equal(logs.includes(requestId), true, 'Request ID must propagate to Identity logs');
    for (const secret of secrets) assert.equal(logs.includes(secret), false, 'Service logs must not contain credentials');
  } finally {
    for (const child of children) await stop(child);
    await pool.query('DELETE FROM identity.users WHERE email = ANY($1::text[])', [[email, raceEmail, rollbackEmail]]);
    await pool.end();
  }
});
