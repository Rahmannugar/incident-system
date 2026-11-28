import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {test} from 'node:test';
import {Pool, type PoolClient} from 'pg';
import {paymentDatabaseConfig} from '../src/config.ts';
import {identityDatabaseConfig} from '../../identity/src/config.ts';
import {databaseConfig} from '../../../scripts/database/database.ts';
import {signProviderBody} from '../src/payments/provider-signature.ts';
import {object, start, stop, type Running} from '../../../scripts/integration.ts';
import {serviceEnvironment} from '../../../scripts/services.ts';

test('pending payment, signed provider webhook and atomic durable outcome/outbox', {timeout: 90000}, async () => {
  const pool = new Pool(paymentDatabaseConfig());
  const identities = new Pool(identityDatabaseConfig());
  const orders = new Pool({...databaseConfig(), database: process.env.INCIDENT_SYSTEM_ORDER_DATABASE_NAME ?? 'incident_system_order', user: process.env.INCIDENT_SYSTEM_ORDER_DATABASE_USER ?? 'incident_system_order', password: process.env.INCIDENT_SYSTEM_ORDER_DATABASE_PASSWORD});
  const children: Running[] = [];
  const fixture = randomUUID();
  const users: string[] = [], orderIDs: string[] = [];
  const sku = 'payment-item';
  const inventorySettings = {INCIDENT_SYSTEM_INVENTORY_GRPC_ADDRESS: '127.0.0.1:0', INCIDENT_SYSTEM_INVENTORY_REDIS_PREFIX: `incident-system:inventory:test-${fixture}:`, INCIDENT_SYSTEM_INVENTORY_HOLD_TTL: '15m'};
  const secret = process.env.INCIDENT_SYSTEM_PAYMENT_WEBHOOK_SECRET ?? '';
  assert.ok(secret);
  const password = 'Payment-integration-password-42';
  const secrets = [secret, password];
  const constraint = `test_outbox_${fixture.replaceAll('-', '')}`;
  let constraintAdded = false;
  let listener: PoolClient | undefined;
  function stockCommand(remove = false) {
    const args = ['dist/scripts/services.js', 'inventory', remove ? 'reset' : 'seed', '--sku', sku, '--stock', '10'];
    if (remove) args.push('--remove');
    execFileSync(process.execPath, args, {env: serviceEnvironment('inventory', {...inventorySettings, INCIDENT_SYSTEM_TELEMETRY_SOURCE: 'integration'}), stdio: 'pipe'});
  }
  try {
    stockCommand();
    assert.equal(serviceEnvironment('gateway').INCIDENT_SYSTEM_PAYMENT_WEBHOOK_SECRET, undefined);
    assert.equal(serviceEnvironment('payment').INCIDENT_SYSTEM_IDENTITY_DATABASE_PASSWORD, undefined);
    const identity = await start('identity', {INCIDENT_SYSTEM_IDENTITY_GRPC_ADDRESS: '127.0.0.1:0'}, children);
    const order = await start('order', {INCIDENT_SYSTEM_ORDER_GRPC_ADDRESS: '127.0.0.1:0', INCIDENT_SYSTEM_ORDER_IDENTITY_ADDRESS: identity.address}, children);
    let inventory = await start('inventory', inventorySettings, children);
    const paymentSettings = {INCIDENT_SYSTEM_PAYMENT_GRPC_ADDRESS: '127.0.0.1:0', INCIDENT_SYSTEM_PAYMENT_HTTP_ADDRESS: '127.0.0.1:0', INCIDENT_SYSTEM_PAYMENT_ORDER_ADDRESS: order.address, INCIDENT_SYSTEM_PAYMENT_INVENTORY_ADDRESS: inventory.address, INCIDENT_SYSTEM_PAYMENT_UNIT_AMOUNT_MINOR: '1000', INCIDENT_SYSTEM_PAYMENT_CURRENCY: 'USD'};
    let payment = await start('payment', paymentSettings, children);
    assert.ok(payment.httpAddress);
    const gateway = await start('gateway', {INCIDENT_SYSTEM_GATEWAY_HTTP_ADDRESS: '127.0.0.1:0', INCIDENT_SYSTEM_GATEWAY_IDENTITY_ADDRESS: identity.address, INCIDENT_SYSTEM_GATEWAY_ORDER_ADDRESS: order.address, INCIDENT_SYSTEM_GATEWAY_INVENTORY_ADDRESS: inventory.address, INCIDENT_SYSTEM_GATEWAY_PAYMENT_ADDRESS: payment.address}, children);
    const base = `http://${gateway.address}`;
    async function request(path: string, token?: string, body?: unknown, post = false) {
      const headers: Record<string, string> = {'X-Request-ID': `payment_${fixture}`};
      if (token) headers.Authorization = `Bearer ${token}`;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const options: RequestInit = {method: post || body !== undefined ? 'POST' : 'GET', headers};
      if (body !== undefined) options.body = JSON.stringify(body);
      const response = await fetch(base + path, options);
      const json: unknown = await response.json();
      return {status: response.status, body: object(json)};
    }
    async function signup(suffix: string) {
      const result = await request('/auth/signup', undefined, {email: `${fixture}-${suffix}@example.test`, password});
      assert.equal(result.status, 201);
      users.push(String(object(result.body.user).id)); secrets.push(String(result.body.token));
      return String(result.body.token);
    }
    const alice = await signup('alice'), bob = await signup('bob');
    async function createOrder(reserve = true) {
      const created = await request('/orders', alice, {sku, quantity: 1});
      assert.equal(created.status, 201);
      const id = String(created.body.id); orderIDs.push(id);
      if (reserve) assert.equal((await request(`/orders/${id}/reservation`, alice, undefined, true)).status, 200);
      return id;
    }
    const firstOrder = await createOrder();
    const path = `/orders/${firstOrder}/payment`;
    assert.equal((await request(path, undefined, undefined, true)).status, 401);
    assert.equal((await request(path, bob, undefined, true)).status, 404);
    assert.equal((await request(path, alice)).status, 404);
    const pending = await Promise.all(Array.from({length: 4}, () => request(path, alice, undefined, true)));
    assert.ok(pending.every(result => result.status === 200));
    const attempt = pending[0]?.body; assert.ok(attempt);
    assert.ok(pending.every(result => result.body.id === attempt.id));
    assert.equal(attempt.status, 'pending'); assert.equal(attempt.amount_minor, 1000); assert.equal(attempt.currency, 'USD');
    const missingReservationOrder = await createOrder(false);
    assert.equal((await request(`/orders/${missingReservationOrder}/payment`, alice, undefined, true)).status, 409);
    assert.equal((await request(path, alice)).body.status, 'pending', 'No provider callback means no success claim');
    assert.equal((await request(`/orders/${firstOrder.toUpperCase()}/payment`, alice)).status, 200);
    const {rows: initialOutbox} = await pool.query('SELECT id FROM payments.outbox WHERE payment_id = $1', [attempt.id]);
    assert.equal(initialOutbox.length, 0);

    function event(paymentID: string, outcome: 'succeeded' | 'failed', eventID = randomUUID()) {return {event_id: eventID, payment_id: paymentID, outcome};}
    async function webhook(value: unknown, options: {timestamp?: string; invalidSignature?: boolean; raw?: string} = {}) {
      const body = Buffer.from(options.raw ?? JSON.stringify(value));
      const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1000));
      const response = await fetch(`http://${payment.httpAddress}/webhooks/provider`, {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Payment-Timestamp': timestamp, 'X-Payment-Signature': options.invalidSignature ? '0'.repeat(64) : signProviderBody(body, timestamp, secret)}, body});
      const json: unknown = await response.json();
      return {status: response.status, body: object(json)};
    }
    const success = event(String(attempt.id), 'succeeded');
    assert.equal((await webhook(success, {invalidSignature: true})).status, 401);
    assert.equal((await webhook(success, {timestamp: String(Math.floor(Date.now() / 1000) - 600)})).status, 401);
    assert.equal((await webhook({...success, extra: true})).status, 400);
    assert.equal((await webhook({...success, outcome: ['succeeded']})).status, 400);
    assert.equal((await webhook(success, {raw: 'a'.repeat(17000)})).status, 413);
    assert.equal((await webhook(event(randomUUID(), 'succeeded'))).status, 404);
    listener = await pool.connect();
    const notifications: string[] = [];
    listener.on('notification', message => notifications.push(message.channel));
    await listener.query('LISTEN payment_outbox');
    const duplicates = await Promise.all(Array.from({length: 4}, () => webhook(success)));
    assert.ok(duplicates.every(result => result.status === 200));
    assert.equal(duplicates.filter(result => result.body.applied === true).length, 1);
    for (let i = 0; i < 30 && notifications.length === 0; i++) await delay(10);
    assert.deepEqual(notifications, ['payment_outbox']);
    const {rows: [outbox]} = await pool.query('SELECT id, event_type, payload FROM payments.outbox WHERE payment_id = $1', [attempt.id]);
    assert.equal(outbox.event_type, 'payment.succeeded'); assert.equal(outbox.payload.id, outbox.id);
    assert.equal(outbox.payload.data.order_id, firstOrder);
    assert.equal(outbox.payload.data.amount_minor, 1000);
    assert.equal(outbox.payload.request_id, `payment_${fixture}`);
    assert.equal((await request(path, alice)).body.status, 'succeeded');
    assert.equal((await request(path, bob)).status, 404);
    assert.equal((await request(`/orders/${firstOrder}`, alice)).body.status, 'pending', 'This slice does not claim downstream delivery');
    assert.equal((await webhook({...success, outcome: 'failed'})).status, 409, 'An event ID cannot change its payload');
    const stale = await webhook(event(String(attempt.id), 'failed'));
    assert.equal(stale.status, 200); assert.equal(stale.body.applied, false); assert.equal(stale.body.reason, 'terminal_conflict');
    assert.equal((await request(path, alice)).body.status, 'succeeded');

    const secondOrder = await createOrder();
    const second = await request(`/orders/${secondOrder}/payment`, alice, undefined, true);
    const failedEvent = event(String(second.body.id), 'failed');
    assert.match(String(second.body.id), /^[a-f0-9-]{36}$/);
    // Force the real outbox INSERT to fail for only this fixture, proving rollback of both preceding writes.
    await pool.query(`ALTER TABLE payments.outbox ADD CONSTRAINT "${constraint}" CHECK (payment_id <> '${String(second.body.id)}'::uuid)`);
    constraintAdded = true;
    assert.equal((await webhook(failedEvent)).status, 500);
    assert.equal((await request(`/orders/${secondOrder}/payment`, alice)).body.status, 'pending');
    const {rows: [rolledBack]} = await pool.query('SELECT count(*)::int AS count FROM payments.provider_events WHERE event_id = $1', [failedEvent.event_id]);
    assert.equal(rolledBack.count, 0);
    await pool.query(`ALTER TABLE payments.outbox DROP CONSTRAINT "${constraint}"`); constraintAdded = false;
    const simulation = execFileSync('task', ['payment-simulate', '--', '--payment-id', String(second.body.id), '--outcome', 'failed', '--event-id', failedEvent.event_id], {env: {...process.env, INCIDENT_SYSTEM_PAYMENT_HTTP_ADDRESS: payment.httpAddress}, stdio: 'pipe'});
    assert.ok(simulation.toString().includes('delivery_status'));
    assert.equal((await request(`/orders/${secondOrder}/payment`, alice)).body.status, 'failed');

    await stop(inventory.process);
    inventory = await start('inventory', {...inventorySettings, INCIDENT_SYSTEM_INVENTORY_GRPC_ADDRESS: inventory.address, INCIDENT_SYSTEM_INVENTORY_HOLD_TTL: '2s'}, children);
    for (let i = 0; i < 30; i++) {if ((await request('/health/ready')).status === 200) break; await delay(100);}
    const lateOrder = await createOrder();
    const late = await request(`/orders/${lateOrder}/payment`, alice, undefined, true);
    assert.equal(late.status, 200);
    await delay(2100);
    assert.equal((await request(`/orders/${lateOrder}/reservation`, alice)).body.state, 'expired');
    assert.equal((await webhook(event(String(late.body.id), 'succeeded'))).status, 200);
    const lateResult = await request(`/orders/${lateOrder}/payment`, alice);
    assert.equal(lateResult.body.status, 'succeeded'); assert.equal(lateResult.body.late, true);
    assert.equal((await request(`/orders/${lateOrder}`, alice)).body.status, 'pending');
    assert.equal((await request(`/orders/${lateOrder}/payment`, alice, undefined, true)).body.id, late.body.id, 'Retry cannot create another charge after expiry');

    const otherRole = new Pool({...identityDatabaseConfig(), database: paymentDatabaseConfig().database});
    try {await assert.rejects(otherRole.query('SELECT 1'), {code: '42501'});} finally {await otherRole.end();}
    const {rows: [role]} = await pool.query('SELECT rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = current_user');
    assert.deepEqual(role, {rolsuper: false, rolcreatedb: false, rolcreaterole: false});
    const ambiguousOrder = await createOrder();
    const ambiguous = await request(`/orders/${ambiguousOrder}/payment`, alice, undefined, true);
    assert.equal(ambiguous.status, 200); assert.equal(ambiguous.body.status, 'pending');
    await stop(payment.process);
    assert.equal((await request(path, alice)).status, 503);
    assert.equal((await request('/health/ready')).status, 503);
    assert.equal((await request('/health/live')).status, 200);
    payment = await start('payment', {...paymentSettings, INCIDENT_SYSTEM_PAYMENT_GRPC_ADDRESS: payment.address, INCIDENT_SYSTEM_PAYMENT_UNIT_AMOUNT_MINOR: '999'}, children);
    assert.ok(payment.httpAddress);
    for (let i = 0; i < 30; i++) {if ((await request('/health/ready')).status === 200) break; await delay(100);}
    const persisted = await request(path, alice, undefined, true);
    assert.equal(persisted.body.id, attempt.id); assert.equal(persisted.body.amount_minor, 1000); assert.equal(persisted.body.status, 'succeeded');
    const unresolved = await request(`/orders/${ambiguousOrder}/payment`, alice);
    assert.equal(unresolved.body.id, ambiguous.body.id); assert.equal(unresolved.body.status, 'pending');
    assert.equal(unresolved.body.amount_minor, 1000);
    assert.equal((await webhook(success)).status, 200);
    const {rows: [totals]} = await pool.query('SELECT count(*)::int AS count FROM payments.outbox WHERE payment_id = $1', [attempt.id]);
    assert.equal(totals.count, 1);
    for (const child of children) await stop(child);
    const logs = children.map(child => child.output).join('\n');
    assert.ok(logs.includes(`payment_${fixture}`));
    for (const value of [...secrets, paymentDatabaseConfig().password]) if (typeof value === 'string') assert.equal(logs.includes(value), false);
  } finally {
    for (const child of children) await stop(child);
    if (constraintAdded) await pool.query(`ALTER TABLE payments.outbox DROP CONSTRAINT "${constraint}"`);
    if (listener) {await listener.query('UNLISTEN payment_outbox'); listener.release();}
    stockCommand(true);
    await pool.query('DELETE FROM payments.outbox WHERE payment_id IN (SELECT id FROM payments.attempts WHERE order_id = ANY($1::uuid[]))', [orderIDs]);
    await pool.query('DELETE FROM payments.provider_events WHERE payment_id IN (SELECT id FROM payments.attempts WHERE order_id = ANY($1::uuid[]))', [orderIDs]);
    await pool.query('DELETE FROM payments.attempts WHERE order_id = ANY($1::uuid[])', [orderIDs]);
    await orders.query('DELETE FROM orders.orders WHERE id = ANY($1::uuid[])', [orderIDs]);
    await identities.query('DELETE FROM identity.users WHERE id = ANY($1::uuid[])', [users]);
    await Promise.all([pool.end(), orders.end(), identities.end()]);
  }
});
