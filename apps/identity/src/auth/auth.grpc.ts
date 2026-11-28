import {recordRPC} from '../../../../packages/telemetry/ts/metrics.ts';
import {failureFields, businessFields} from '../../../../packages/telemetry/ts/logging.ts';
import {inSpan, SpanKind, spanError} from '../../../../packages/telemetry/ts/telemetry.ts';
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
    const parents = call.metadata.get('traceparent');
    const parent = parents.length === 1 && typeof parents[0] === 'string' ? parents[0] : null;
    void inSpan(operation, SpanKind.SERVER, parent, async () => {
      let code = status.OK;
      let failure: Record<string, string> = {};
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
        failure = error instanceof AuthFailure ? {error_type: 'rejected', error_code: error.code, error_message: message} : failureFields(error);
        callback({code, message});
      } finally {
        recordRPC(operation, code, performance.now() - start); spanError(code !== status.OK);
        log(code === status.INTERNAL ? 'error' : code === status.OK ? 'info' : 'warn', code === status.OK ? 'rpc.succeeded' : 'rpc.failed', {message: code === status.OK ? `${operation} succeeded` : `${operation} failed: ${failure.error_message}`, operation, request_id: requestId, ...businessFields(call.request), ...failure, code: status[code], duration_ms: Math.round(performance.now() - start)});
      }
    });
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
