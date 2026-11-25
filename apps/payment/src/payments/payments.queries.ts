/** Types generated for queries found in "apps/payment/src/payments/payments.sql" */
import { PreparedQuery } from '@pgtyped/runtime';

export type DateOrString = Date | string;

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type NumberOrString = number | string;

/** 'FindPayment' parameters type */
export interface IFindPaymentParams {
  orderId: string;
}

/** 'FindPayment' return type */
export interface IFindPaymentResult {
  amount_minor: string;
  created_at: Date;
  currency: string;
  id: string;
  late: boolean;
  order_id: string;
  request_id: string;
  reservation_expires_at: Date;
  status: string;
  updated_at: Date;
}

/** 'FindPayment' query type */
export interface IFindPaymentQuery {
  params: IFindPaymentParams;
  result: IFindPaymentResult;
}

const findPaymentIR: any = {"usedParamSet":{"orderId":true},"params":[{"name":"orderId","required":true,"transform":{"type":"scalar"},"locs":[{"a":49,"b":57}]}],"statement":"SELECT * FROM payments.attempts WHERE order_id = :orderId!"};

/**
 * Query generated from SQL:
 * ```
 * SELECT * FROM payments.attempts WHERE order_id = :orderId!
 * ```
 */
export const findPayment = new PreparedQuery<IFindPaymentParams,IFindPaymentResult>(findPaymentIR);


/** 'InsertPayment' parameters type */
export interface IInsertPaymentParams {
  amountMinor: NumberOrString;
  currency: string;
  orderId: string;
  requestId: string;
  reservationExpiresAt: DateOrString;
}

/** 'InsertPayment' return type */
export interface IInsertPaymentResult {
  amount_minor: string;
  created_at: Date;
  currency: string;
  id: string;
  late: boolean;
  order_id: string;
  request_id: string;
  reservation_expires_at: Date;
  status: string;
  updated_at: Date;
}

/** 'InsertPayment' query type */
export interface IInsertPaymentQuery {
  params: IInsertPaymentParams;
  result: IInsertPaymentResult;
}

const insertPaymentIR: any = {"usedParamSet":{"orderId":true,"amountMinor":true,"currency":true,"reservationExpiresAt":true,"requestId":true},"params":[{"name":"orderId","required":true,"transform":{"type":"scalar"},"locs":[{"a":109,"b":117}]},{"name":"amountMinor","required":true,"transform":{"type":"scalar"},"locs":[{"a":120,"b":132}]},{"name":"currency","required":true,"transform":{"type":"scalar"},"locs":[{"a":135,"b":144}]},{"name":"reservationExpiresAt","required":true,"transform":{"type":"scalar"},"locs":[{"a":147,"b":168}]},{"name":"requestId","required":true,"transform":{"type":"scalar"},"locs":[{"a":171,"b":181}]}],"statement":"INSERT INTO payments.attempts (order_id, amount_minor, currency, reservation_expires_at, request_id)\nVALUES (:orderId!, :amountMinor!, :currency!, :reservationExpiresAt!, :requestId!)\nON CONFLICT (order_id) DO NOTHING\nRETURNING *"};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO payments.attempts (order_id, amount_minor, currency, reservation_expires_at, request_id)
 * VALUES (:orderId!, :amountMinor!, :currency!, :reservationExpiresAt!, :requestId!)
 * ON CONFLICT (order_id) DO NOTHING
 * RETURNING *
 * ```
 */
export const insertPayment = new PreparedQuery<IInsertPaymentParams,IInsertPaymentResult>(insertPaymentIR);


/** 'LockPayment' parameters type */
export interface ILockPaymentParams {
  paymentId: string;
}

/** 'LockPayment' return type */
export interface ILockPaymentResult {
  amount_minor: string;
  created_at: Date;
  currency: string;
  id: string;
  late: boolean;
  order_id: string;
  request_id: string;
  reservation_expires_at: Date;
  status: string;
  updated_at: Date;
}

/** 'LockPayment' query type */
export interface ILockPaymentQuery {
  params: ILockPaymentParams;
  result: ILockPaymentResult;
}

const lockPaymentIR: any = {"usedParamSet":{"paymentId":true},"params":[{"name":"paymentId","required":true,"transform":{"type":"scalar"},"locs":[{"a":43,"b":53}]}],"statement":"SELECT * FROM payments.attempts WHERE id = :paymentId! FOR UPDATE"};

/**
 * Query generated from SQL:
 * ```
 * SELECT * FROM payments.attempts WHERE id = :paymentId! FOR UPDATE
 * ```
 */
export const lockPayment = new PreparedQuery<ILockPaymentParams,ILockPaymentResult>(lockPaymentIR);


/** 'FindProviderEvent' parameters type */
export interface IFindProviderEventParams {
  eventId: string;
}

/** 'FindProviderEvent' return type */
export interface IFindProviderEventResult {
  payload_hash: string;
  payment_id: string;
}

/** 'FindProviderEvent' query type */
export interface IFindProviderEventQuery {
  params: IFindProviderEventParams;
  result: IFindProviderEventResult;
}

const findProviderEventIR: any = {"usedParamSet":{"eventId":true},"params":[{"name":"eventId","required":true,"transform":{"type":"scalar"},"locs":[{"a":79,"b":87}]}],"statement":"SELECT payment_id, payload_hash FROM payments.provider_events WHERE event_id = :eventId!"};

/**
 * Query generated from SQL:
 * ```
 * SELECT payment_id, payload_hash FROM payments.provider_events WHERE event_id = :eventId!
 * ```
 */
export const findProviderEvent = new PreparedQuery<IFindProviderEventParams,IFindProviderEventResult>(findProviderEventIR);


/** 'RecordProviderEvent' parameters type */
export interface IRecordProviderEventParams {
  applied: boolean;
  eventId: string;
  outcome: string;
  payloadHash: string;
  paymentId: string;
}

/** 'RecordProviderEvent' return type */
export type IRecordProviderEventResult = void;

/** 'RecordProviderEvent' query type */
export interface IRecordProviderEventQuery {
  params: IRecordProviderEventParams;
  result: IRecordProviderEventResult;
}

const recordProviderEventIR: any = {"usedParamSet":{"eventId":true,"paymentId":true,"payloadHash":true,"outcome":true,"applied":true},"params":[{"name":"eventId","required":true,"transform":{"type":"scalar"},"locs":[{"a":100,"b":108}]},{"name":"paymentId","required":true,"transform":{"type":"scalar"},"locs":[{"a":111,"b":121}]},{"name":"payloadHash","required":true,"transform":{"type":"scalar"},"locs":[{"a":124,"b":136}]},{"name":"outcome","required":true,"transform":{"type":"scalar"},"locs":[{"a":139,"b":147}]},{"name":"applied","required":true,"transform":{"type":"scalar"},"locs":[{"a":150,"b":158}]}],"statement":"INSERT INTO payments.provider_events (event_id, payment_id, payload_hash, outcome, applied)\nVALUES (:eventId!, :paymentId!, :payloadHash!, :outcome!, :applied!)"};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO payments.provider_events (event_id, payment_id, payload_hash, outcome, applied)
 * VALUES (:eventId!, :paymentId!, :payloadHash!, :outcome!, :applied!)
 * ```
 */
export const recordProviderEvent = new PreparedQuery<IRecordProviderEventParams,IRecordProviderEventResult>(recordProviderEventIR);


/** 'FinalizePayment' parameters type */
export interface IFinalizePaymentParams {
  outcome: string;
  paymentId: string;
}

/** 'FinalizePayment' return type */
export interface IFinalizePaymentResult {
  amount_minor: string;
  created_at: Date;
  currency: string;
  id: string;
  late: boolean;
  order_id: string;
  request_id: string;
  reservation_expires_at: Date;
  status: string;
  updated_at: Date;
}

/** 'FinalizePayment' query type */
export interface IFinalizePaymentQuery {
  params: IFinalizePaymentParams;
  result: IFinalizePaymentResult;
}

const finalizePaymentIR: any = {"usedParamSet":{"outcome":true,"paymentId":true},"params":[{"name":"outcome","required":true,"transform":{"type":"scalar"},"locs":[{"a":38,"b":46}]},{"name":"paymentId","required":true,"transform":{"type":"scalar"},"locs":[{"a":151,"b":161}]}],"statement":"UPDATE payments.attempts\nSET status = :outcome!, updated_at = statement_timestamp(), late = reservation_expires_at <= statement_timestamp()\nWHERE id = :paymentId! AND status = 'pending'\nRETURNING *"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE payments.attempts
 * SET status = :outcome!, updated_at = statement_timestamp(), late = reservation_expires_at <= statement_timestamp()
 * WHERE id = :paymentId! AND status = 'pending'
 * RETURNING *
 * ```
 */
export const finalizePayment = new PreparedQuery<IFinalizePaymentParams,IFinalizePaymentResult>(finalizePaymentIR);


/** 'InsertOutcome' parameters type */
export interface IInsertOutcomeParams {
  eventType: string;
  id: string;
  payload: Json;
  paymentId: string;
}

/** 'InsertOutcome' return type */
export type IInsertOutcomeResult = void;

/** 'InsertOutcome' query type */
export interface IInsertOutcomeQuery {
  params: IInsertOutcomeParams;
  result: IInsertOutcomeResult;
}

const insertOutcomeIR: any = {"usedParamSet":{"id":true,"paymentId":true,"eventType":true,"payload":true},"params":[{"name":"id","required":true,"transform":{"type":"scalar"},"locs":[{"a":74,"b":77}]},{"name":"paymentId","required":true,"transform":{"type":"scalar"},"locs":[{"a":80,"b":90}]},{"name":"eventType","required":true,"transform":{"type":"scalar"},"locs":[{"a":93,"b":103}]},{"name":"payload","required":true,"transform":{"type":"scalar"},"locs":[{"a":106,"b":114}]}],"statement":"INSERT INTO payments.outbox (id, payment_id, event_type, payload)\nVALUES (:id!, :paymentId!, :eventType!, :payload!::jsonb)"};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO payments.outbox (id, payment_id, event_type, payload)
 * VALUES (:id!, :paymentId!, :eventType!, :payload!::jsonb)
 * ```
 */
export const insertOutcome = new PreparedQuery<IInsertOutcomeParams,IInsertOutcomeResult>(insertOutcomeIR);


/** 'WakePublisher' parameters type */
export type IWakePublisherParams = void;

/** 'WakePublisher' return type */
export interface IWakePublisherResult {
  pg_notify: undefined | null;
}

/** 'WakePublisher' query type */
export interface IWakePublisherQuery {
  params: IWakePublisherParams;
  result: IWakePublisherResult;
}

const wakePublisherIR: any = {"usedParamSet":{},"params":[],"statement":"SELECT pg_notify('payment_outbox', '')"};

/**
 * Query generated from SQL:
 * ```
 * SELECT pg_notify('payment_outbox', '')
 * ```
 */
export const wakePublisher = new PreparedQuery<IWakePublisherParams,IWakePublisherResult>(wakePublisherIR);


