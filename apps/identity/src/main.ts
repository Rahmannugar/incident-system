import {tracing} from '../../../packages/telemetry/ts/telemetry.ts';
import {Server, ServerCredentials} from '@grpc/grpc-js';
import {randomBytes} from 'node:crypto';
import {Pool} from 'pg';
import {IdentityServiceService} from '../../../packages/contracts/gen/ts/incident/identity/v1/identity_service.js';
import {ConfigurationError, identityConfig} from './config.ts';
import {AuthRepository} from './auth/auth.repository.ts';
import {AuthService} from './auth/auth.service.ts';
import {authHandlers} from './auth/auth.grpc.ts';
import {hashPassword} from './auth/password.ts';
import {log} from './logger.ts';

async function main() {
  const shutdownTracing = tracing('identity');
  const config = identityConfig();
  const pool = new Pool(config.database);
  const server = new Server({'grpc.max_receive_message_length': 16384, 'grpc.max_concurrent_streams': 64});
  try {
    await pool.query('SELECT token_hash FROM identity.sessions LIMIT 0');
    const dummy = await hashPassword(randomBytes(32).toString('hex'));
    const service = new AuthService(new AuthRepository(pool), config.sessionTtl, config.authConcurrency, dummy);
    server.addService(IdentityServiceService, authHandlers(service, pool));
    const port = await new Promise<number>((resolve, reject) => {
      server.bindAsync(config.address, ServerCredentials.createInsecure(), (error, boundPort) => error ? reject(error) : resolve(boundPort));
    });
    log('info', 'identity.started', {port});
  } catch (error) {
    server.forceShutdown();
    await pool.end();
    throw error;
  }

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void (async () => {
      const timeout = setTimeout(() => server.forceShutdown(), 5000);
      await new Promise<void>(resolve => server.tryShutdown(() => resolve()));
      clearTimeout(timeout);
      await pool.end();
      log('info', 'identity.stopped'); await shutdownTracing();
    })().catch(() => {
      log('error', 'identity.shutdown_failed');
      process.exitCode = 1;
    });
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

void main().catch(error => {
  log('error', 'identity.start_failed', {reason: error instanceof ConfigurationError ? error.message : 'initialization_failed'});
  process.exitCode = 1;
});
