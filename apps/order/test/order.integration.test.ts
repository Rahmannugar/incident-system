import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {Pool} from 'pg';
import {credentials, Metadata, status, type ServiceError} from '@grpc/grpc-js';
import {OrderServiceClient} from '../../../packages/contracts/gen/ts/incident/order/v1/order_service.js';
import {identityDatabaseConfig} from '../../identity/src/config.ts';
import {databaseConfig} from '../../../scripts/database/database.ts';
import {tokenHash} from '../../identity/src/auth/auth.service.ts';
import {object, start, stop, type Running} from '../../../scripts/integration.ts';
import {serviceEnvironment} from '../../../scripts/services.ts';

// Real service processes and service-owned databases exercise ownership and cancellation boundaries.
test('HTTP Gateway → gRPC Order → PostgreSQL ownership, persistence and failure boundaries', {timeout: 60000}, async () => {
  const orderConfig = {...databaseConfig(),
    database: process.env.INCIDENT_SYSTEM_ORDER_DATABASE_NAME ?? 'incident_system_order',
    user: process.env.INCIDENT_SYSTEM_ORDER_DATABASE_USER ?? 'incident_system_order',
    password: process.env.INCIDENT_SYSTEM_ORDER_DATABASE_PASSWORD,
    max: 4,
  };
  const pool = new Pool(orderConfig);
  const identities = new Pool(identityDatabaseConfig());
  const children: Running[] = [];
  const userIDs: string[] = [];
  const password = 'Order-integration-password-42';
  const secrets = [password];
  const prefix = `slice3-${randomUUID()}`;
  let rpc: InstanceType<typeof OrderServiceClient> | undefined;
  try {
    assert.equal(serviceEnvironment('order').INCIDENT_SYSTEM_IDENTITY_DATABASE_PASSWORD, undefined);
    assert.equal(serviceEnvironment('order').INCIDENT_SYSTEM_DATABASE_ADMIN_PASSWORD, undefined);
    assert.equal(serviceEnvironment('gateway').INCIDENT_SYSTEM_ORDER_DATABASE_PASSWORD, undefined);
    const identity = await start('identity', {INCIDENT_SYSTEM_IDENTITY_GRPC_ADDRESS: '127.0.0.1:0'}, children);
    let order = await start('order', {INCIDENT_SYSTEM_ORDER_GRPC_ADDRESS: '127.0.0.1:0', INCIDENT_SYSTEM_ORDER_IDENTITY_ADDRESS: identity.address}, children);
    const inventory = await start('inventory', {INCIDENT_SYSTEM_INVENTORY_GRPC_ADDRESS: '127.0.0.1:0'}, children);
    const payment = await start('payment', {INCIDENT_SYSTEM_PAYMENT_GRPC_ADDRESS: '127.0.0.1:0', INCIDENT_SYSTEM_PAYMENT_HTTP_ADDRESS: '127.0.0.1:0', INCIDENT_SYSTEM_PAYMENT_ORDER_ADDRESS: order.address, INCIDENT_SYSTEM_PAYMENT_INVENTORY_ADDRESS: inventory.address}, children);
    const gatewaySettings = {INCIDENT_SYSTEM_GATEWAY_PAYMENT_ADDRESS: payment.address, INCIDENT_SYSTEM_GATEWAY_INVENTORY_ADDRESS: inventory.address, INCIDENT_SYSTEM_GATEWAY_HTTP_ADDRESS: '127.0.0.1:0', INCIDENT_SYSTEM_GATEWAY_IDENTITY_ADDRESS: identity.address, INCIDENT_SYSTEM_GATEWAY_ORDER_ADDRESS: order.address};
    const gateway = await start('gateway', gatewaySettings, children);
    const base = `http://${gateway.address}`;
    async function request(path: string, body?: unknown, token?: string, requestID?: string, url = base) {
      const headers: Record<string, string> = {};
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (token) headers.Authorization = `Bearer ${token}`;
      if (requestID) headers['X-Request-ID'] = requestID;
      const options: RequestInit = {method: body === undefined ? 'GET' : 'POST', headers};
      if (body !== undefined) options.body = JSON.stringify(body);
      const response = await fetch(url + path, options);
      const bodyJSON: unknown = await response.json();
      return {status: response.status, body: object(bodyJSON), headers: response.headers};
    }
    async function signup(suffix: string) {
      const result = await request('/auth/signup', {email: `${prefix}-${suffix}@example.test`, password});
      assert.equal(result.status, 201);
      const user = object(result.body.user);
      assert.equal(typeof user.id, 'string');
      assert.equal(typeof result.body.token, 'string');
      userIDs.push(String(user.id));
      secrets.push(String(result.body.token));
      return {id: String(user.id), token: String(result.body.token)};
    }
    const alice = await signup('alice');
    const bob = await signup('bob');
    assert.equal((await request('/health/ready')).status, 200);
    const input = {sku: 'shirt-blue-m', quantity: 2};
    assert.equal((await request('/orders', input)).status, 401);
    assert.equal((await request(`/orders/${randomUUID()}`)).status, 401);
    assert.equal((await request('/orders', input, 'a'.repeat(43))).status, 401);
    const requestID = `order_${randomUUID()}`;
    const created = await request('/orders', input, alice.token, requestID);
    assert.equal(created.status, 201);
    assert.equal(created.headers.get('x-request-id'), requestID);
    assert.equal(created.headers.get('cache-control'), 'no-store');
    assert.equal(created.body.sku, input.sku);
    assert.equal(created.body.quantity, input.quantity);
    assert.equal(created.body.status, 'pending');
    assert.equal(created.body.owner_id, undefined);
    assert.match(String(created.body.id), /^[a-f0-9-]{36}$/);
    assert.ok(Number.isFinite(Date.parse(String(created.body.created_at))));
    const id = String(created.body.id);
    const fetched = await request(`/orders/${id}`, undefined, alice.token);
    assert.equal(fetched.status, 200);
    assert.deepEqual(fetched.body, created.body);
    const foreign = await request(`/orders/${id}`, undefined, bob.token);
    const missing = await request(`/orders/${randomUUID()}`, undefined, bob.token);
    assert.equal(foreign.status, 404);
    assert.equal(missing.status, 404);
    assert.deepEqual(foreign.body, missing.body);
    assert.equal((await request('/orders/not-an-id', undefined, alice.token)).status, 400);
    for (const invalid of [
      {sku: '', quantity: 2}, {sku: 'bad sku', quantity: 2}, {sku: '-bad', quantity: 2},
      {sku: 'a'.repeat(65), quantity: 2}, {sku: 'valid', quantity: 0},
      {sku: 'valid', quantity: 1001}, {sku: 'valid', quantity: 1.5},
      {...input, owner_id: bob.id}, {...input, status: 'confirmed'}, {items: [input]},
    ]) assert.equal((await request('/orders', invalid, alice.token)).status, 400);
    const wrongType = await fetch(base + '/orders', {method: 'POST', headers: {Authorization: `Bearer ${alice.token}`}, body: JSON.stringify(input)});
    assert.equal(wrongType.status, 415);
    await wrongType.arrayBuffer();
    const tooLarge = await request('/orders', {sku: 'a'.repeat(5000), quantity: 1}, alice.token);
    assert.equal(tooLarge.status, 413);

    rpc = new OrderServiceClient(order.address, credentials.createInsecure());
    const client = rpc;
    async function directGet(metadata: Metadata) {
      return new Promise<number>((resolve, reject) => {
        client.getOrder({id}, metadata, {deadline: Date.now() + 3000}, (err: ServiceError | null) => {
          if (err) resolve(err.code); else reject(new Error('Foreign or unauthenticated direct access succeeded'));
        });
      });
    }
    assert.equal(await directGet(new Metadata()), status.UNAUTHENTICATED);
    const forged = new Metadata();
    forged.set('authorization', `Bearer ${bob.token}`);
    forged.set('x-user-id', alice.id);
    assert.equal(await directGet(forged), status.NOT_FOUND, 'Order must derive owner from Identity, never user-id metadata');
    forged.set('authorization', `Bearer ${bob.token}, Bearer ${alice.token}`);
    assert.equal(await directGet(forged), status.UNAUTHENTICATED);
    const {rows: [stored]} = await pool.query('SELECT owner_id, sku, quantity, status FROM orders.orders WHERE id = $1', [id]);
    assert.deepEqual(stored, {owner_id: alice.id, sku: input.sku, quantity: 2, status: 'pending'});
    for (const values of [[alice.id, 'valid', 0], [alice.id, 'bad sku', 1]]) {
      await assert.rejects(pool.query('INSERT INTO orders.orders (owner_id, sku, quantity) VALUES ($1, $2, $3)', values), {code: '23514'});
    }
    await assert.rejects(pool.query("UPDATE orders.orders SET status = 'confirmed' WHERE id = $1", [id]), {code: '23514'});
    const {rows: [role]} = await pool.query('SELECT rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = current_user');
    assert.deepEqual(role, {rolsuper: false, rolcreatedb: false, rolcreaterole: false});
    for (const settings of [
      {...identityDatabaseConfig(), database: orderConfig.database},
      {...orderConfig, database: identityDatabaseConfig().database},
    ]) {
      const foreignPool = new Pool(settings);
      try { await assert.rejects(foreignPool.query('SELECT 1'), {code: '42501'}); }
      finally { await foreignPool.end(); }
    }

    const slowGateway = await start('gateway', {...gatewaySettings, INCIDENT_SYSTEM_GATEWAY_RPC_TIMEOUT: '300ms'}, children);
    const lock = await pool.connect();
    try {
      await lock.query('BEGIN');
      await lock.query('LOCK TABLE orders.orders IN ACCESS EXCLUSIVE MODE');
      const pending = request('/orders', {sku: 'blocked-order', quantity: 1}, alice.token, undefined, `http://${slowGateway.address}`);
      let blocked = false;
      for (let i = 0; i < 40; i++) {
        const {rows: [activity]} = await pool.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND usename = current_user AND wait_event_type = 'Lock' AND query LIKE '%INSERT INTO orders.orders%'");
        if (activity.count > 0) { blocked = true; break; }
        await delay(5);
      }
      const timeout = await pending;
      assert.equal(blocked, true, 'Establish that the request reached the blocked SQL insert');
      assert.equal(timeout.status, 504);
    } finally { await lock.query('ROLLBACK'); lock.release(); }
    await stop(slowGateway.process);
    await delay(150);
    const {rows: [count]} = await pool.query('SELECT count(*)::int AS count FROM orders.orders WHERE owner_id = $1', [alice.id]);
    assert.equal(count.count, 1, 'Cancelled blocked insert must not create a late order');

    await stop(order.process);
    assert.equal((await request('/health/live')).status, 200);
    assert.equal((await request('/health/ready')).status, 503);
    assert.equal((await request('/orders', input, alice.token)).status, 503);
    assert.equal((await request('/auth/me', undefined, alice.token)).status, 200);
    order = await start('order', {INCIDENT_SYSTEM_ORDER_GRPC_ADDRESS: order.address, INCIDENT_SYSTEM_ORDER_IDENTITY_ADDRESS: identity.address}, children);
    async function waitReady() {
      for (let i = 0; i < 40; i++) {
        if ((await request('/health/ready')).status === 200) return;
        await delay(100);
      }
      assert.fail('Gateway dependencies must reconnect after restart');
    }
    await waitReady();
    assert.deepEqual((await request(`/orders/${id}`, undefined, alice.token)).body, created.body);
    await stop(identity.process);
    assert.equal((await request(`/orders/${id}`, undefined, alice.token)).status, 503, 'Order must fail closed when Identity is unavailable');
    await start('identity', {INCIDENT_SYSTEM_IDENTITY_GRPC_ADDRESS: identity.address}, children);
    await waitReady();
    assert.equal((await request(`/orders/${id}`, undefined, alice.token)).status, 200);
    await identities.query("UPDATE identity.sessions SET expires_at = now() - interval '1 second' WHERE token_hash = $1", [tokenHash(alice.token)]);
    assert.equal((await request(`/orders/${id}`, undefined, alice.token)).status, 401);
    for (const child of children) await stop(child);
    const logs = children.map(child => child.output).join('\n');
    assert.ok(order.process.output.includes('order.started'));
    assert.ok(children.filter(c => c.output.includes('order.created')).some(c => c.output.includes(requestID)));
    assert.ok(identity.process.output.includes(requestID), 'Order must propagate correlation to Identity');
    for (const secret of [...secrets, orderConfig.password, identityDatabaseConfig().password]) {
      if (typeof secret === 'string') assert.equal(logs.includes(secret), false, 'Logs must not contain credentials');
    }
  } finally {
    rpc?.close();
    for (const child of children) await stop(child);
    await pool.query('DELETE FROM orders.orders WHERE owner_id = ANY($1::uuid[])', [userIDs]);
    await identities.query('DELETE FROM identity.users WHERE id = ANY($1::uuid[])', [userIDs]);
    await pool.end();
    await identities.end();
  }
});
