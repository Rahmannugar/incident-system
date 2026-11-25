import {status, type handleUnaryCall} from '@grpc/grpc-js';
import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import type {PaymentServiceServer, Payment} from '../../../../packages/contracts/gen/ts/incident/payment/v1/payment_service.js';
import type {IFindPaymentResult} from './payments.queries.js';
import type {PaymentService} from './payments.service.ts';
import {PaymentFailure, type AssertActive, type FailureCode} from './payments.types.ts';
import {log} from '../logger.ts';

const codes: Record<FailureCode, status> = {invalid_request: status.INVALID_ARGUMENT, not_found: status.NOT_FOUND, reservation_closed: status.FAILED_PRECONDITION, unauthorized: status.UNAUTHENTICATED, unavailable: status.UNAVAILABLE, timeout: status.DEADLINE_EXCEEDED, cancelled: status.CANCELLED, event_conflict: status.ALREADY_EXISTS};
function wire(payment: IFindPaymentResult): Payment {
  return {id: payment.id, orderId: payment.order_id, amountMinor: Number(payment.amount_minor), currency: payment.currency, status: payment.status, reservationExpiresAtUnixMs: payment.reservation_expires_at.getTime(), createdAtUnixMs: payment.created_at.getTime(), updatedAtUnixMs: payment.updated_at.getTime(), late: payment.late};
}
function unary<Request, Response>(operation: string, timeoutMs: number, work: (input: Request, authorization: string, requestId: string, deadline: number, active: AssertActive) => Promise<Response>): handleUnaryCall<Request, Response> {
  return (call, callback) => {
    const ids = call.metadata.get('x-request-id');
    const requestId = ids.length === 1 && typeof ids[0] === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(ids[0]) ? ids[0] : randomUUID();
    const credentials = call.metadata.get('authorization');
    const authorization = credentials.length === 1 && typeof credentials[0] === 'string' ? credentials[0] : '';
    const start = Date.now();
    const deadline = Math.min(start + timeoutMs, Number(call.getDeadline()));
    const active = () => {if (call.cancelled || Date.now() >= deadline) throw new PaymentFailure('cancelled', 'Request cancelled');};
    void (async () => {
      let code = status.OK;
      try {active(); callback(null, await work(call.request, authorization, requestId, deadline, active));}
      catch (error) {
        let message = 'Internal service error';
        code = status.INTERNAL;
        if (error instanceof PaymentFailure) {code = codes[error.code]; message = error.message;}
        else if (operation === 'check_health') {code = status.UNAVAILABLE; message = 'Payment database is unavailable';}
        else if (typeof error === 'object' && error !== null && 'code' in error && error.code === '57014') {code = status.DEADLINE_EXCEEDED; message = 'Payment operation timed out';}
        callback({code, message});
      } finally {log(code === status.INTERNAL ? 'error' : code === status.UNAVAILABLE ? 'warn' : 'info', 'rpc.completed', {operation, request_id: requestId, code, duration_ms: Date.now() - start});}
    })();
  };
}
export function paymentHandlers(service: PaymentService, pool: Pool, timeoutMs: number): PaymentServiceServer {
  return {
    initiatePayment: unary('payment.initiate', timeoutMs, async (request, authorization, requestId, deadline, active) => ({payment: wire(await service.initiate(request.orderId, authorization, requestId, deadline, active))})),
    getPayment: unary('payment.get', timeoutMs, async (request, authorization, requestId, deadline) => ({payment: wire(await service.get(request.orderId, authorization, requestId, deadline))})),
    checkHealth: unary('check_health', timeoutMs, async () => {await pool.query('SELECT 1'); return {healthy: true};}),
  };
}
