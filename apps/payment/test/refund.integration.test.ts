import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {credentials, Metadata, status} from '@grpc/grpc-js';
import {Pool} from 'pg';
import {PaymentServiceClient, type Refund, type GetPaymentForSettlementResponse} from '../../../packages/contracts/gen/ts/incident/payment/v1/payment_service.js';
import {paymentDatabaseConfig} from '../src/config.ts';
import {PaymentRepository} from '../src/payments/payments.repository.ts';
import {PaymentFailure} from '../src/payments/payments.types.ts';
import {start, stop, type Running} from '../../../scripts/integration.ts';
import {serviceEnvironment} from '../../../scripts/services.ts';

test('full simulated refunds: protected RPC, atomic completion and durable duplicate recovery', {timeout: 30000}, async () => {
  const database = paymentDatabaseConfig();
  const fixtureDatabase = `incident_system_payment_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({...database, user: 'postgres', password: process.env.INCIDENT_SYSTEM_DATABASE_ADMIN_PASSWORD, database: 'postgres', max: 1});
  const children: Running[] = [];
  let created = false;
  let pool: Pool | undefined;
  let client: PaymentServiceClient | undefined;
  try {
    const owner = (database.user ?? 'incident_system_payment').replaceAll('"', '""');
    await admin.query(`CREATE DATABASE "${fixtureDatabase}" OWNER "${owner}"`); created = true;
    await admin.query(`REVOKE ALL ON DATABASE "${fixtureDatabase}" FROM PUBLIC`);
    execFileSync('bin/tern', ['migrate', '-c', 'apps/payment/tern.conf', '-m', 'apps/payment/src/payments/migrations'], {env: {...process.env, INCIDENT_SYSTEM_PAYMENT_DATABASE_NAME: fixtureDatabase}, stdio: 'pipe'});
    pool = new Pool({...database, database: fixtureDatabase});
    const repository = new PaymentRepository(pool);
    const settings = {INCIDENT_SYSTEM_PAYMENT_DATABASE_NAME: fixtureDatabase, INCIDENT_SYSTEM_PAYMENT_GRPC_ADDRESS: '127.0.0.1:0', INCIDENT_SYSTEM_PAYMENT_HTTP_ADDRESS: '127.0.0.1:0'};
    let payment = await start('payment', settings, children);
    client = new PaymentServiceClient(payment.address, credentials.createInsecure());
    const token = process.env.INCIDENT_SYSTEM_PAYMENT_SERVICE_TOKEN; assert.ok(token);
    const service = new Metadata(); service.set('x-service-token', token);
    const customer = new Metadata(); customer.set('authorization', `Bearer ${'a'.repeat(43)}`);
    const refund = (paymentId: string, orderId: string, metadata = service) => new Promise<Refund>((resolve, reject) => {
      client!.refundPayment({paymentId, orderId}, metadata, {deadline: Date.now() + 3000}, (error, response) => {
        if (error) return reject(error);
        if (!response.refund) return reject(new Error('Missing refund'));
        resolve(response.refund);
      });
    });
    const settlement = (orderId: string, metadata = service) => new Promise<GetPaymentForSettlementResponse>((resolve, reject) => {
      client!.getPaymentForSettlement({orderId}, metadata, {deadline: Date.now() + 3000}, (error, response) => error ? reject(error) : resolve(response));
    });
    async function seed(outcome?: 'succeeded' | 'failed') {
      const row = await repository.create({orderId: randomUUID(), amountMinor: 3500, currency: 'USD', reservationExpiresAt: new Date(Date.now() - 60000), requestId: randomUUID()}, () => {});
      if (outcome) {
        const event = {event_id: randomUUID(), payment_id: row.id, outcome};
        await repository.receive(event, createHash('sha256').update(JSON.stringify(event)).digest('hex'), () => {});
      }
      return row;
    }
    const paid = await seed('succeeded');
    await assert.rejects(refund(paid.id, paid.order_id, new Metadata()), {code: status.UNAUTHENTICATED});
    await assert.rejects(refund(paid.id, paid.order_id, customer), {code: status.UNAUTHENTICATED});
    await assert.rejects(settlement(paid.order_id, customer), {code: status.UNAUTHENTICATED});
    await assert.rejects(refund(paid.id, randomUUID()), {code: status.NOT_FOUND});
    await assert.rejects(refund('invalid', paid.order_id), {code: status.INVALID_ARGUMENT});
    for (const outcome of [undefined, 'failed'] as const) {
      const row = await seed(outcome);
      await assert.rejects(refund(row.id, row.order_id), {code: status.FAILED_PRECONDITION});
    }
    const results = await Promise.all(Array.from({length: 4}, () => refund(paid.id, paid.order_id)));
    assert.ok(results.every(result => JSON.stringify(result) === JSON.stringify(results[0])));
    assert.equal(results[0]?.amountMinor, 3500); assert.equal(results[0]?.currency, 'USD');
    assert.equal(results[0]?.providerReference, `simulated_refund_${paid.id}`);
    assert.ok(results[0]!.completedAtUnixMs > 0);
    const recorded = await repository.settlement(paid.order_id);
    assert.equal(recorded.payment.status, 'succeeded', 'Refund preserves the original successful charge');
    assert.ok(recorded.refund);
    assert.equal((await settlement(paid.order_id)).refund?.providerReference, results[0]?.providerReference);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM payments.refunds')).rows[0].count, 1);

    // Cancellation before commit must not claim a completed refund.
    const cancelled = await seed('succeeded');
    let checks = 0;
    await assert.rejects(repository.refund(cancelled.id, cancelled.order_id, () => {if (++checks === 2) throw new PaymentFailure('cancelled', 'Request cancelled');}), {code: 'cancelled'});
    assert.equal((await repository.settlement(cancelled.order_id)).refund, undefined);
    client.close();
    await stop(payment.process);
    payment = await start('payment', {...settings, INCIDENT_SYSTEM_PAYMENT_GRPC_ADDRESS: payment.address}, children);
    client = new PaymentServiceClient(payment.address, credentials.createInsecure());
    assert.deepEqual(await refund(paid.id, paid.order_id), results[0], 'Lost acknowledgement/restart returns the original completed refund');
    const env = serviceEnvironment('payment', {}, 'publisher');
    assert.equal(env.INCIDENT_SYSTEM_PAYMENT_SERVICE_TOKEN, undefined);
    for (const child of children) await stop(child);
    assert.equal(children.some(child => child.output.includes(token)), false);
  } finally {
    client?.close();
    for (const child of children) await stop(child);
    await pool?.end();
    // Require owned clients to close; dropping fixtures must not terminate live connections.
    if (created) await admin.query(`DROP DATABASE "${fixtureDatabase}"`);
    await admin.end();
  }
});
