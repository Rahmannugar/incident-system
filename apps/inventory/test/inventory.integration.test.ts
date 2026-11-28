import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {test} from 'node:test';
import {Pool} from 'pg';
import {credentials, Metadata, status} from '@grpc/grpc-js';
import {InventoryServiceClient, type CommitResponse, type ReleaseResponse, type CheckStockResponse} from '../../../packages/contracts/gen/ts/incident/inventory/v1/inventory_service.js';
import {identityDatabaseConfig} from '../../identity/src/config.ts';
import {databaseConfig} from '../../../scripts/database/database.ts';
import {object, start, stop, type Running} from '../../../scripts/integration.ts';
import {serviceEnvironment} from '../../../scripts/services.ts';

test('Gateway reserves owned pending orders through real Inventory gRPC and hosted Redis', {timeout: 60000}, async () => {
  const identities = new Pool(identityDatabaseConfig());
  const orders = new Pool({...databaseConfig(), database: process.env.INCIDENT_SYSTEM_ORDER_DATABASE_NAME ?? 'incident_system_order', user: process.env.INCIDENT_SYSTEM_ORDER_DATABASE_USER ?? 'incident_system_order', password: process.env.INCIDENT_SYSTEM_ORDER_DATABASE_PASSWORD});
  const children: Running[] = [];
  const fixture = randomUUID();
  const settings = {INCIDENT_SYSTEM_INVENTORY_GRPC_ADDRESS: '127.0.0.1:0', INCIDENT_SYSTEM_INVENTORY_REDIS_PREFIX: `incident-system:inventory:test-${fixture}:`};
  const users: string[] = [];
  const secrets: string[] = ['Inventory-integration-password-42'];
  let client: InstanceType<typeof InventoryServiceClient> | undefined;
  const sku = 'gateway-item';
  function stockCommand(operation: 'seed' | 'reset', stock: number, remove = false) {
    const args = ['dist/scripts/services.js', 'inventory', operation, '--sku', sku, '--stock', String(stock)];
    if (remove) args.push('--remove');
    execFileSync(process.execPath, args, {env: serviceEnvironment('inventory', {...settings, INCIDENT_SYSTEM_TELEMETRY_SOURCE: 'integration'}), stdio: 'pipe'});
  }
  try {
    assert.equal(serviceEnvironment('gateway').INCIDENT_SYSTEM_INVENTORY_REDIS_URL, undefined);
    assert.equal(serviceEnvironment('inventory').INCIDENT_SYSTEM_ORDER_DATABASE_PASSWORD, undefined);
    stockCommand('seed', 2);
    const identity = await start('identity', {INCIDENT_SYSTEM_IDENTITY_GRPC_ADDRESS: '127.0.0.1:0'}, children);
    const order = await start('order', {INCIDENT_SYSTEM_ORDER_GRPC_ADDRESS: '127.0.0.1:0', INCIDENT_SYSTEM_ORDER_IDENTITY_ADDRESS: identity.address}, children);
    let inventory = await start('inventory', settings, children);
    const payment = await start('payment', {INCIDENT_SYSTEM_PAYMENT_GRPC_ADDRESS: '127.0.0.1:0', INCIDENT_SYSTEM_PAYMENT_HTTP_ADDRESS: '127.0.0.1:0', INCIDENT_SYSTEM_PAYMENT_ORDER_ADDRESS: order.address, INCIDENT_SYSTEM_PAYMENT_INVENTORY_ADDRESS: inventory.address}, children);
    const gateway = await start('gateway', {INCIDENT_SYSTEM_GATEWAY_HTTP_ADDRESS: '127.0.0.1:0', INCIDENT_SYSTEM_GATEWAY_IDENTITY_ADDRESS: identity.address, INCIDENT_SYSTEM_GATEWAY_ORDER_ADDRESS: order.address, INCIDENT_SYSTEM_GATEWAY_INVENTORY_ADDRESS: inventory.address, INCIDENT_SYSTEM_GATEWAY_PAYMENT_ADDRESS: payment.address}, children);
    const base = `http://${gateway.address}`;
    async function request(path: string, token?: string, body?: unknown, post = false) {
      const headers: Record<string, string> = {'X-Request-ID': `inventory_${fixture}`};
      if (token) headers.Authorization = `Bearer ${token}`;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const options: RequestInit = {method: post || body !== undefined ? 'POST' : 'GET', headers};
      if (body !== undefined) options.body = JSON.stringify(body);
      const response = await fetch(base + path, options);
      const result: unknown = await response.json();
      return {status: response.status, body: object(result)};
    }
    async function signup(suffix: string) {
      const result = await request('/auth/signup', undefined, {email: `${fixture}-${suffix}@example.test`, password: secrets[0]});
      assert.equal(result.status, 201);
      users.push(String(object(result.body.user).id));
      secrets.push(String(result.body.token));
      return String(result.body.token);
    }
    const alice = await signup('alice');
    const bob = await signup('bob');
    const first = await request('/orders', alice, {sku, quantity: 2});
    const second = await request('/orders', alice, {sku, quantity: 2});
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    const path = `/orders/${String(first.body.id)}/reservation`;
    const secondPath = `/orders/${String(second.body.id)}/reservation`;
    assert.equal((await request(path, undefined, undefined, true)).status, 401);
    assert.equal((await request(path, bob, undefined, true)).status, 404);
    const held = await request(path, alice, undefined, true);
    assert.equal(held.status, 200);
    assert.equal(held.body.state, 'held');
    assert.equal(held.body.order_id, first.body.id);
    assert.equal(held.body.sku, sku);
    assert.equal(held.body.quantity, 2);
    assert.deepEqual((await request(path, alice, undefined, true)).body, held.body);
    assert.deepEqual((await request(path, alice)).body, held.body);
    assert.equal((await request(secondPath, alice, undefined, true)).status, 409);
    assert.equal((await request(secondPath, alice)).status, 404);
    assert.equal((await request(`/orders/${String(second.body.id)}`, alice)).body.status, 'pending');

    client = new InventoryServiceClient(inventory.address, credentials.createInsecure());
    const rpc = client;
    const internal = new Metadata();
    const serviceToken = process.env.INCIDENT_SYSTEM_INVENTORY_SERVICE_TOKEN;
    assert.ok(serviceToken);
    secrets.push(serviceToken);
    internal.set('x-service-token', serviceToken);
    const customer = new Metadata();
    customer.set('authorization', `Bearer ${alice}`);
    await new Promise<void>((resolve, reject) => {
      rpc.commit({orderId: String(first.body.id), sku}, customer, (err) => {
        try { assert.equal(err?.code, status.UNAUTHENTICATED); resolve(); } catch (error) { reject(error); }
      });
    });
    const released = await new Promise<ReleaseResponse>((resolve, reject) => rpc.release({orderId: String(first.body.id), sku}, internal, (err, value) => err ? reject(err) : resolve(value)));
    assert.equal(released.reservation?.state, 'released');
    const retried = await request(secondPath, alice, undefined, true);
    assert.equal(retried.status, 200, 'Failed reservation can be retried for the same existing order');
    assert.equal(retried.body.state, 'held');

    await stop(inventory.process);
    assert.equal((await request(secondPath, alice)).status, 503);
    assert.equal((await request('/health/ready')).status, 503);
    assert.equal((await request('/health/live')).status, 200);
    assert.equal((await request(`/orders/${String(second.body.id)}`, alice)).status, 200);
    inventory = await start('inventory', {...settings, INCIDENT_SYSTEM_INVENTORY_GRPC_ADDRESS: inventory.address}, children);
    let recovered = false;
    for (let i = 0; i < 30; i++) {
      if ((await request('/health/ready')).status === 200) { recovered = true; break; }
      await delay(100);
    }
    assert.equal(recovered, true);
    assert.deepEqual((await request(secondPath, alice)).body, retried.body, 'Reservation survives process restart');
    for (let i = 0; i < 2; i++) {
      const committed = await new Promise<CommitResponse>((resolve, reject) => rpc.commit({orderId: String(second.body.id), sku}, internal, {deadline: Date.now() + 3000}, (err, value) => err ? reject(err) : resolve(value)));
      assert.equal(committed.reservation?.state, 'committed');
    }
    const stock = await new Promise<CheckStockResponse>((resolve, reject) => rpc.checkStock({sku}, internal, (err, value) => err ? reject(err) : resolve(value)));
    assert.equal(stock.remaining, 0);
    assert.equal(stock.available, 0);
    for (const child of children) await stop(child);
    const logs = children.map(child => child.output).join('\n');
    assert.ok(inventory.process.output.includes(`inventory_${fixture}`));
    for (const secret of secrets) assert.equal(logs.includes(secret), false);
  } finally {
    client?.close();
    for (const child of children) await stop(child);
    stockCommand('reset', 0, true);
    await orders.query('DELETE FROM orders.orders WHERE owner_id = ANY($1::uuid[])', [users]);
    await identities.query('DELETE FROM identity.users WHERE id = ANY($1::uuid[])', [users]);
    await orders.end();
    await identities.end();
  }
});
