import assert from 'node:assert/strict';
import {spawn, execFileSync} from 'node:child_process';
import {randomUUID, createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {Pool} from 'pg';
import {paymentDatabaseConfig} from '../src/config.ts';
import {PaymentRepository} from '../src/payments/payments.repository.ts';
import {OutboxRepository} from '../src/payments/outbox.repository.ts';
import {OutboxPublisher} from '../src/payments/outbox.publisher.ts';
import {serviceEnvironment} from '../../../scripts/services.ts';
import {object, stop, type Running} from '../../../scripts/integration.ts';

test('PostgreSQL outbox leases, batch acceptance and worker wakeup/poll recovery (local HTTP fixture)', {timeout: 45000}, async () => {
  const database = paymentDatabaseConfig();
  const fixtureDatabase = `incident_system_payment_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({...database, user: 'postgres', password: process.env.INCIDENT_SYSTEM_DATABASE_ADMIN_PASSWORD, database: 'postgres', max: 1});
  let created = false;
  let pool: Pool | undefined;
  let worker: Running | undefined;
  const accepted = new Map<string, string>();
  const rejected = new Set<string>();
  let loseResponse = false;
  let rejectNextBatch = false;
  const requests: string[][] = [];
  const server = createServer((request, response) => {
    void (async () => {
      assert.equal(request.url, '/v2/batch');
      assert.equal(request.headers.authorization, 'Bearer fixture-publisher-token');
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString());
      assert.ok(Array.isArray(parsed));
      const batch = parsed.map(value => object(value));
      const ids = batch.map(value => String(object(value.headers)['Upstash-Deduplication-Id']));
      requests.push(ids);
      if (rejectNextBatch) {for (const id of ids) rejected.add(id); rejectNextBatch = false;}
      const results = batch.map((value, index) => {
        assert.ok(String(value.destination).endsWith('/events/payment'));
        const payload: unknown = JSON.parse(String(value.body));
        const id = ids[index]; assert.ok(id);
        assert.equal(object(payload).id, id);
        if (rejected.has(id)) return {error: 'fixture_rejection'};
        const duplicate = accepted.has(id);
        const messageId = accepted.get(id) ?? `fixture_${randomUUID()}`;
        accepted.set(id, messageId);
        return {messageId, deduplicated: duplicate};
      });
      if (loseResponse) {loseResponse = false; response.destroy(); return;}
      response.writeHead(results.some(result => 'error' in result) ? 400 : 201, {'Content-Type': 'application/json'}); response.end(JSON.stringify(results));
    })().catch(() => {response.writeHead(500); response.end();});
  });
  try {
    const owner = (database.user ?? 'incident_system_payment').replaceAll('"', '""');
    await admin.query(`CREATE DATABASE "${fixtureDatabase}" OWNER "${owner}"`); created = true;
    await admin.query(`REVOKE ALL ON DATABASE "${fixtureDatabase}" FROM PUBLIC`);
    execFileSync('bin/tern', ['migrate', '-c', 'apps/payment/tern.conf', '-m', 'apps/payment/src/payments/migrations'], {env: {...process.env, INCIDENT_SYSTEM_PAYMENT_DATABASE_NAME: fixtureDatabase}, stdio: 'pipe'});
    pool = new Pool({...database, database: fixtureDatabase});
    const db = pool;
    const paymentRepository = new PaymentRepository(db);
    const outbox = new OutboxRepository(db);
    async function seed(count: number) {
      for (let i = 0; i < count; i++) {
        const payment = await paymentRepository.create({orderId: randomUUID(), amountMinor: 1000, currency: 'USD', reservationExpiresAt: new Date(Date.now() + 60000), requestId: randomUUID()}, () => {});
        const event = {event_id: randomUUID(), payment_id: payment.id, outcome: 'succeeded' as const};
        await paymentRepository.receive(event, createHash('sha256').update(JSON.stringify(event)).digest('hex'), () => {});
      }
    }
    async function reset() {await db.query('TRUNCATE payments.refunds, payments.outbox, payments.provider_events, payments.attempts');}
    await seed(6);
    const firstToken = randomUUID(), secondToken = randomUUID();
    const [first, second] = await Promise.all([outbox.claim(firstToken, 3), outbox.claim(secondToken, 3)]);
    assert.equal(first.length, 3); assert.equal(second.length, 3);
    assert.equal(new Set([...first, ...second].map(row => row.id)).size, 6);
    await db.query("UPDATE payments.outbox SET claim_until = now() - interval '1 second' WHERE claim_token = $1", [firstToken]);
    const replacementToken = randomUUID();
    const replacement = await outbox.claim(replacementToken, 3);
    assert.deepEqual(replacement.map(row => row.id).sort(), first.map(row => row.id).sort());
    const patch = first.map(row => ({id: row.id, message_id: 'fixture_message', error_code: null}));
    assert.equal((await outbox.finish(firstToken, patch)).length, 0, 'Stale claim cannot acknowledge reclaimed work');
    assert.equal((await outbox.finish(replacementToken, patch)).length, 3);
    await outbox.finish(secondToken, second.map(row => ({id: row.id, message_id: null, error_code: 'publish_unconfirmed'})));
    const {rows: [backoff]} = await db.query('SELECT bool_and(available_at > now()) AS backed_off FROM payments.outbox WHERE published_at IS NULL');
    assert.equal(backoff.backed_off, true);

    await reset(); await seed(2);
    const {rows: pending} = await db.query('SELECT id FROM payments.outbox ORDER BY id');
    const rejectedId = String(pending[1]?.id); rejected.add(rejectedId);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const publisher = new OutboxPublisher(outbox, {baseURL: base, token: 'fixture-publisher-token', destination: base + '/events/payment'});
    assert.equal(await publisher.runBatch(new AbortController().signal), 2);
    assert.equal(requests[0]?.length, 2, 'Publish actual batches, not one request per event');
    const {rows: [partial]} = await db.query('SELECT count(*) FILTER (WHERE published_at IS NOT NULL)::int AS published, count(*) FILTER (WHERE last_error_code IS NOT NULL)::int AS failed FROM payments.outbox');
    assert.deepEqual(partial, {published: 1, failed: 1});
    rejected.clear();
    await db.query('UPDATE payments.outbox SET available_at = now() WHERE published_at IS NULL');
    await publisher.runBatch(new AbortController().signal);
    assert.equal(accepted.size, 2);

    await reset(); await seed(1); accepted.clear();
    loseResponse = true;
    await publisher.runBatch(new AbortController().signal);
    assert.equal(accepted.size, 1);
    const {rows: [unconfirmed]} = await db.query('SELECT published_at FROM payments.outbox');
    assert.equal(unconfirmed.published_at, null, 'Acceptance without an acknowledgement is not marked published');
    await db.query('UPDATE payments.outbox SET available_at = now()');
    await publisher.runBatch(new AbortController().signal);
    assert.equal(accepted.size, 1, 'Retry uses stable deduplication ID');
    const {rows: [confirmed]} = await db.query('SELECT published_at FROM payments.outbox');
    assert.ok(confirmed.published_at);

    await reset(); await seed(1);
    await db.query("UPDATE payments.outbox SET publish_attempts = 8, claim_token = $1, claim_until = now() - interval '1 second'", [randomUUID()]);
    assert.equal((await outbox.claim(randomUUID())).length, 0);
    const {rows: [exhausted]} = await db.query('SELECT exhausted_at, claim_token FROM payments.outbox');
    assert.ok(exhausted.exhausted_at); assert.equal(exhausted.claim_token, null);

    await reset();
    const settings = {INCIDENT_SYSTEM_QSTASH_MODE: 'hosted', INCIDENT_SYSTEM_PAYMENT_DATABASE_NAME: fixtureDatabase, INCIDENT_SYSTEM_QSTASH_TOKEN: 'fixture-publisher-token', INCIDENT_SYSTEM_QSTASH_URL: base, INCIDENT_SYSTEM_CALLBACK_BASE_URL: base};
    const env = serviceEnvironment('payment', settings, 'publisher');
    assert.equal(env.INCIDENT_SYSTEM_PAYMENT_WEBHOOK_SECRET, undefined);
    assert.equal(env.INCIDENT_SYSTEM_INVENTORY_SERVICE_TOKEN, undefined);
    const child = spawn(process.execPath, ['dist/scripts/services.js', 'payment', 'publish'], {env});
    const exited = new Promise<{code: number | null; signal: NodeJS.Signals | null}>(resolve => child.once('exit', (code, signal) => resolve({code, signal})));
    worker = {child, output: '', exited};
    const running = worker;
    child.stdout.on('data', (data: Buffer) => {running.output += data.toString();});
    child.stderr.on('data', (data: Buffer) => {running.output += data.toString();});
    async function until(predicate: () => Promise<boolean>, timeout = 8000) {
      const end = Date.now() + timeout;
      while (Date.now() < end) {if (await predicate()) return; await delay(20);}
      assert.fail('Outbox worker did not make the expected durable progress');
    }
    await until(async () => {
      const {rows: [state]} = await db.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND usename = current_user AND query = 'LISTEN payment_outbox'");
      return state.count === 1;
    });
    await seed(1);
    const {rows: [queued]} = await db.query('SELECT id FROM payments.outbox');
    const queuedId = String(queued.id);
    await until(async () => {
      const {rows: [state]} = await db.query('SELECT published_at FROM payments.outbox WHERE id = $1', [queuedId]);
      return Boolean(state.published_at);
    });
    // No notification is emitted for a deferred retry: polling must recover it.
    await reset(); rejectNextBatch = true; await seed(1);
    const {rows: [retry]} = await db.query('SELECT id FROM payments.outbox');
    rejected.add(String(retry.id));
    await until(async () => {
      const {rows: [state]} = await db.query('SELECT last_error_code FROM payments.outbox WHERE id = $1', [retry.id]);
      return state.last_error_code === 'qstash_rejected';
    });
    rejected.clear();
    await until(async () => {
      const {rows: [state]} = await db.query('SELECT published_at FROM payments.outbox WHERE id = $1', [retry.id]);
      return Boolean(state.published_at);
    });
    await stop(worker); worker = undefined;
    assert.ok(running.output.includes('outbox.stopped'));
    assert.equal(running.output.includes('fixture-publisher-token'), false);
  } finally {
    if (worker) await stop(worker);
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await pool?.end();
    // Require owned clients to close; dropping fixtures must not terminate live connections.
    if (created) await admin.query(`DROP DATABASE "${fixtureDatabase}"`);
    await admin.end();
  }
});
