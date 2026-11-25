import {status, type handleUnaryCall} from '@grpc/grpc-js';
import type {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import type {IdentityServiceServer} from '../../../../packages/contracts/gen/ts/incident/identity/v1/identity_service.js';
import {log} from '../logger.ts';
import {AuthFailure, type AssertActive, type FailureCode} from './auth.types.ts';
import type {AuthService} from './auth.service.ts';

const codes: Record<FailureCode, status> = {
  invalid_request: status.INVALID_ARGUMENT,
  email_exists: status.ALREADY_EXISTS,
  invalid_credentials: status.UNAUTHENTICATED,
  unauthorized: status.UNAUTHENTICATED,
  overloaded: status.RESOURCE_EXHAUSTED,
  cancelled: status.CANCELLED,
};

function unary<Request, Response>(operation: string, work: (request: Request, active: AssertActive) => Promise<Response>): handleUnaryCall<Request, Response> {
  return (call, callback) => {
    const incoming = call.metadata.get('x-request-id')[0];
    const requestId = typeof incoming === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(incoming) ? incoming : randomUUID();
    const start = performance.now();
    const active = () => {
      if (call.cancelled || Date.now() >= Number(call.getDeadline())) {
        throw new AuthFailure('cancelled', 'Request cancelled');
      }
    };
    void (async () => {
      let code = status.OK;
      try {
        active();
        callback(null, await work(call.request, active));
      } catch (error) {
        let message = 'Internal service error';
        if (error instanceof AuthFailure) {
          code = codes[error.code];
          message = error.message;
        } else if (operation === 'check_health') {
          code = status.UNAVAILABLE;
          message = 'Database is unavailable';
        } else if (typeof error === 'object' && error !== null && 'code' in error && error.code === '57014') {
          code = status.DEADLINE_EXCEEDED;
          message = 'Database operation timed out';
        } else {
          code = status.INTERNAL;
        }
        callback({code, message});
      } finally {
        log(code === status.INTERNAL ? 'error' : code === status.UNAVAILABLE ? 'warn' : 'info', 'rpc.completed', {operation, request_id: requestId, code, duration_ms: Math.round(performance.now() - start)});
      }
    })();
  };
}

export function authHandlers(service: AuthService, pool: Pool): IdentityServiceServer {
  return {
    signUp: unary('auth.signup', async (request, active) => {
      const session = await service.signUp(request.email, request.password, active);
      return {user: session.user, token: session.token, expiresAtUnix: Math.floor(session.expiresAt.getTime() / 1000)};
    }),
    login: unary('auth.login', async (request, active) => {
      const session = await service.login(request.email, request.password, active);
      return {user: session.user, token: session.token, expiresAtUnix: Math.floor(session.expiresAt.getTime() / 1000)};
    }),
    logout: unary('auth.logout', async request => {
      await service.logout(request.token);
      return {};
    }),
    getSession: unary('auth.session', async request => {
      const session = await service.getSession(request.token);
      return {user: session.user, expiresAtUnix: Math.floor(session.expiresAt.getTime() / 1000)};
    }),
    checkHealth: unary('check_health', async () => {
      await pool.query('SELECT 1');
      return {healthy: true};
    }),
  };
}
