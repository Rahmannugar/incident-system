import {tracing} from '../../../packages/telemetry/ts/telemetry.ts';
import {Server, ServerCredentials, credentials} from '@grpc/grpc-js';
import {Pool} from 'pg';
import {PaymentServiceService} from '../../../packages/contracts/gen/ts/incident/payment/v1/payment_service.js';
import {OrderServiceClient} from '../../../packages/contracts/gen/ts/incident/order/v1/order_service.js';
import {InventoryServiceClient} from '../../../packages/contracts/gen/ts/incident/inventory/v1/inventory_service.js';
import {ConfigurationError, paymentConfig} from './config.ts';
import {PaymentRepository} from './payments/payments.repository.ts';
import {PaymentService} from './payments/payments.service.ts';
import {paymentHandlers} from './payments/payments.grpc.ts';
import {providerServer} from './payments/provider.http.ts';
import {log} from './logger.ts';

async function main() {
  const shutdownTracing = tracing('payment');
  const config = paymentConfig();
  const pool = new Pool(config.database);
  const orders = new OrderServiceClient(config.orderAddress, credentials.createInsecure());
  const inventory = new InventoryServiceClient(config.inventoryAddress, credentials.createInsecure());
  const repository = new PaymentRepository(pool);
  const server = new Server({'grpc.max_receive_message_length': 4096, 'grpc.max_concurrent_streams': 64});
  const http = providerServer(repository, config.secret, config.timeoutMs);
  try {
    await pool.query('SELECT payment_id FROM payments.refunds LIMIT 0');
    const service = new PaymentService(repository, orders, inventory, config.serviceToken, config.unitAmount, config.currency);
    server.addService(PaymentServiceService, paymentHandlers(service, pool, config.timeoutMs, config.settlementToken));
    const port = await new Promise<number>((resolve, reject) => server.bindAsync(config.grpcAddress, ServerCredentials.createInsecure(), (error, value) => error ? reject(error) : resolve(value)));
    const address = new URL(`http://${config.httpAddress}`);
    await new Promise<void>((resolve, reject) => {http.once('error', reject); http.listen(Number(config.httpAddress.slice(config.httpAddress.lastIndexOf(':') + 1)), address.hostname.replace(/^\[|\]$/g, ''), resolve);});
    const listener = http.address();
    if (!listener || typeof listener === 'string') throw new Error('Invalid webhook listener');
    log('info', 'payment.started', {port, http_port: listener.port});
  } catch (error) {
    server.forceShutdown(); http.closeAllConnections(); http.close(); orders.close(); inventory.close(); await pool.end(); throw error;
  }
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void (async () => {
      const timeout = setTimeout(() => {server.forceShutdown(); http.closeAllConnections();}, 5000);
      await Promise.all([new Promise<void>(resolve => server.tryShutdown(() => resolve())), new Promise<void>(resolve => http.close(() => resolve()))]);
      clearTimeout(timeout); orders.close(); inventory.close(); await pool.end(); log('info', 'payment.stopped'); await shutdownTracing();
    })().catch(() => {log('error', 'payment.shutdown_failed'); process.exitCode = 1;});
  };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
void main().catch(error => {log('error', 'payment.start_failed', {reason: error instanceof ConfigurationError ? error.message : 'initialization_failed'}); process.exitCode = 1;});
