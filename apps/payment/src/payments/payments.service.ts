import {Metadata, status, type ServiceError} from '@grpc/grpc-js';
import type {Order, OrderServiceClient} from '../../../../packages/contracts/gen/ts/incident/order/v1/order_service.js';
import type {InventoryServiceClient} from '../../../../packages/contracts/gen/ts/incident/inventory/v1/inventory_service.js';
import {PaymentRepository} from './payments.repository.ts';
import {PaymentFailure, uuidPattern, type AssertActive} from './payments.types.ts';

function dependency(error: ServiceError, internal = false): PaymentFailure {
  if (error.code === status.UNAUTHENTICATED && !internal) return new PaymentFailure('unauthorized', 'A valid session is required');
  if (error.code === status.NOT_FOUND && !internal) return new PaymentFailure('not_found', 'Order not found');
  if (error.code === status.NOT_FOUND || error.code === status.FAILED_PRECONDITION) return new PaymentFailure('reservation_closed', 'An active inventory reservation is required');
  if (error.code === status.INVALID_ARGUMENT) return new PaymentFailure('invalid_request', 'A valid order ID is required');
  if (error.code === status.DEADLINE_EXCEEDED) return new PaymentFailure('timeout', 'Payment dependency timed out');
  if (error.code === status.CANCELLED) return new PaymentFailure('cancelled', 'Request cancelled');
  return new PaymentFailure('unavailable', 'Payment dependency is unavailable');
}

export class PaymentService {
  constructor(private readonly repository: PaymentRepository, private readonly orders: OrderServiceClient, private readonly inventory: InventoryServiceClient, private readonly token: string, private readonly unitAmount: number, private readonly currency: string) {}
  async settlement(orderId: string) {
    if (!uuidPattern.test(orderId)) throw new PaymentFailure('invalid_request', 'A valid order ID is required');
    return this.repository.settlement(orderId.toLowerCase());
  }
  async refund(paymentId: string, orderId: string, active: AssertActive) {
    if (!uuidPattern.test(paymentId) || !uuidPattern.test(orderId)) throw new PaymentFailure('invalid_request', 'Valid payment and order IDs are required');
    return this.repository.refund(paymentId.toLowerCase(), orderId.toLowerCase(), active);
  }
  private async ownedOrder(orderId: string, authorization: string, requestId: string, deadline: number) {
    if (!uuidPattern.test(orderId)) throw new PaymentFailure('invalid_request', 'A valid order ID is required');
    if (!/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization)) throw new PaymentFailure('unauthorized', 'A valid session is required');
    const metadata = new Metadata(); metadata.set('authorization', authorization); metadata.set('x-request-id', requestId);
    return new Promise<Order>((resolve, reject) => {
      this.orders.getOrder({id: orderId}, metadata, {deadline}, (error, response) => {
        if (error) return reject(dependency(error));
        if (!response.order || response.order.id !== orderId) return reject(new PaymentFailure('unavailable', 'Order returned an invalid response'));
        resolve(response.order);
      });
    });
  }
  async get(orderId: string, authorization: string, requestId: string, deadline: number) {
    orderId = orderId.toLowerCase();
    await this.ownedOrder(orderId, authorization, requestId, deadline);
    const payment = await this.repository.find(orderId);
    if (!payment) throw new PaymentFailure('not_found', 'Payment attempt not found');
    return payment;
  }
  async initiate(orderId: string, authorization: string, requestId: string, deadline: number, active: AssertActive) {
    orderId = orderId.toLowerCase();
    const order = await this.ownedOrder(orderId, authorization, requestId, deadline);
    active();
    const existing = await this.repository.find(orderId);
    if (existing) return existing;
    if (order.status !== 'pending' || order.quantity < 1 || order.quantity > 1000) throw new PaymentFailure('reservation_closed', 'The order is not payable');
    const metadata = new Metadata(); metadata.set('x-service-token', this.token); metadata.set('x-request-id', requestId);
    const reservation = await new Promise<{state: string; expiresAtUnixMs: number; quantity: number; sku: string; orderId: string}>((resolve, reject) => {
      this.inventory.getReservation({orderId, sku: order.sku}, metadata, {deadline}, (error, response) => {
        if (error) return reject(dependency(error, true));
        if (!response.reservation) return reject(new PaymentFailure('unavailable', 'Inventory returned an invalid response'));
        resolve(response.reservation);
      });
    });
    active();
    if (reservation.state !== 'held' || reservation.expiresAtUnixMs <= Date.now() || reservation.quantity !== order.quantity || reservation.sku !== order.sku || reservation.orderId !== orderId) throw new PaymentFailure('reservation_closed', 'An active inventory reservation is required');
    return this.repository.create({orderId, amountMinor: order.quantity * this.unitAmount, currency: this.currency, reservationExpiresAt: new Date(reservation.expiresAtUnixMs), requestId}, active);
  }
}
