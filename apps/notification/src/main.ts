import {tracing} from '../../../packages/telemetry/ts/telemetry.ts';
import {Pool} from 'pg';
import {ConfigurationError, notificationConfig} from './config.ts';
import {qstashURL, qstashSigningKeys, QStashConfigurationError} from '../../../packages/qstash/config.ts';
import {NotificationService} from './notifications/notifications.service.ts';
import {NotificationRepository} from './notifications/notifications.repository.ts';
import {SimulatedEmailProvider} from './notifications/email-provider.ts';
import {notificationServer} from './notifications/notifications.http.ts';
import {log} from './logger.ts';

async function main() {
  const shutdownTracing = tracing('notification');
  const config = notificationConfig();
  const destination = qstashURL('INCIDENT_SYSTEM_NOTIFICATION_CALLBACK_BASE_URL', undefined, {allowDockerHost: process.env.INCIDENT_SYSTEM_QSTASH_MODE === 'local'}).origin + '/events/order';
  const keys = qstashSigningKeys();
  const pool = new Pool(config.database);
  pool.on('error', () => log('warn', 'database.connection_lost'));
  const server = notificationServer(new NotificationService(new NotificationRepository(pool), new SimulatedEmailProvider(config.failures)), pool, destination, keys);
  try {
    await pool.query('SELECT event_id FROM notifications.deliveries LIMIT 0');
    await new Promise<void>((resolve, reject) => {server.once('error', reject); server.listen(config.port, config.host, resolve);});
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Invalid Notification listener');
    log('info', 'notification.started', {port: address.port});
  } catch (error) {server.close(); await pool.end(); throw error;}
  let stopping = false;
  const stop = () => {
    if (stopping) return; stopping = true;
    void (async () => {
      const timer = setTimeout(() => server.closeAllConnections(), 6000);
      await new Promise<void>(resolve => server.close(() => resolve()));
      clearTimeout(timer); await pool.end(); log('info', 'notification.stopped'); await shutdownTracing();
    })().catch(() => {log('error', 'notification.shutdown_failed'); process.exitCode = 1;});
  };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
void main().catch(error => {log('error', 'notification.start_failed', {reason: error instanceof ConfigurationError || error instanceof QStashConfigurationError ? error.message : 'initialization_failed'}); process.exitCode = 1;});
