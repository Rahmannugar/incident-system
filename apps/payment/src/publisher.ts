import {Client, Pool} from 'pg';
import {paymentDatabaseConfig, ConfigurationError} from './config.ts';
import {OutboxRepository} from './payments/outbox.repository.ts';
import {OutboxPublisher, type PublisherConfig} from './payments/outbox.publisher.ts';
import {log} from './logger.ts';
import {qstashConnection, qstashCallbackURL, QStashConfigurationError} from '../../../packages/qstash/config.ts';

function publisherConfig(): PublisherConfig {
  const connection = qstashConnection();
  const callback = qstashCallbackURL();
  return {...connection, destination: `${callback.origin}/events/payment`};
}
async function main() {
  const config = publisherConfig();
  const database = paymentDatabaseConfig();
  const pool = new Pool({...database, max: 2});
  const publisher = new OutboxPublisher(new OutboxRepository(pool), config);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  let listener: Client | undefined;
  let dirty = true;
  let wake: (() => void) | undefined;
  const notify = () => {dirty = true; wake?.();};
  const listen = async () => {
    if (listener) return;
    const client = new Client(database);
    let connected = false;
    client.on('notification', notify);
    client.on('error', () => {if (listener === client) listener = undefined; void client.end().catch(() => {}); if (connected) notify();});
    client.on('end', () => {if (listener === client) {listener = undefined; if (connected) notify();}});
    listener = client;
    try {await client.connect(); await client.query('LISTEN payment_outbox'); connected = true;}
    catch {if (listener === client) listener = undefined; await client.end().catch(() => {}); log('warn', 'outbox.listener_unavailable');}
  };
  const wait = () => new Promise<void>(resolve => {
    const finish = () => {clearTimeout(timer); controller.signal.removeEventListener('abort', finish); wake = undefined; resolve();};
    const timer = setTimeout(finish, 5000);
    wake = finish;
    controller.signal.addEventListener('abort', finish, {once: true});
    if (dirty || controller.signal.aborted) finish();
  });
  try {
    await pool.query('SELECT published_at, claim_token FROM payments.outbox LIMIT 0');
    log('info', 'outbox.started');
    while (!controller.signal.aborted) {
      dirty = false;
      await listen();
      try {if (await publisher.runBatch(controller.signal) === 20) dirty = true;}
      catch {log('warn', 'outbox.batch_unconfirmed');}
      if (!dirty) await wait();
    }
  } finally {
    await listener?.end().catch(() => {});
    await pool.end();
    log('info', 'outbox.stopped');
  }
}
void main().catch(error => {log('error', 'outbox.start_failed', {reason: error instanceof ConfigurationError || error instanceof QStashConfigurationError ? error.message : 'initialization_failed'}); process.exitCode = 1;});
