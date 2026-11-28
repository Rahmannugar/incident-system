/** Types generated for queries found in "apps/notification/src/notifications/notifications.sql" */
import { PreparedQuery } from '@pgtyped/runtime';

/** 'InsertDelivery' parameters type */
export interface IInsertDeliveryParams {
  body: string;
  eventId: string;
  orderId: string;
  orderStatus: string;
  payloadHash: string;
  recipientEmail?: string | null | void;
  subject: string;
}

/** 'InsertDelivery' return type */
export type IInsertDeliveryResult = void;

/** 'InsertDelivery' query type */
export interface IInsertDeliveryQuery {
  params: IInsertDeliveryParams;
  result: IInsertDeliveryResult;
}

const insertDeliveryIR: any = {"usedParamSet":{"eventId":true,"orderId":true,"payloadHash":true,"recipientEmail":true,"orderStatus":true,"subject":true,"body":true},"params":[{"name":"eventId","required":true,"transform":{"type":"scalar"},"locs":[{"a":126,"b":134}]},{"name":"orderId","required":true,"transform":{"type":"scalar"},"locs":[{"a":137,"b":145}]},{"name":"payloadHash","required":true,"transform":{"type":"scalar"},"locs":[{"a":148,"b":160}]},{"name":"recipientEmail","required":false,"transform":{"type":"scalar"},"locs":[{"a":163,"b":177}]},{"name":"orderStatus","required":true,"transform":{"type":"scalar"},"locs":[{"a":180,"b":192}]},{"name":"subject","required":true,"transform":{"type":"scalar"},"locs":[{"a":195,"b":203}]},{"name":"body","required":true,"transform":{"type":"scalar"},"locs":[{"a":206,"b":211}]}],"statement":"INSERT INTO notifications.deliveries (event_id, order_id, payload_hash, recipient_email, order_status, subject, body)\nVALUES (:eventId!, :orderId!, :payloadHash!, :recipientEmail, :orderStatus!, :subject!, :body!)\nON CONFLICT DO NOTHING"};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO notifications.deliveries (event_id, order_id, payload_hash, recipient_email, order_status, subject, body)
 * VALUES (:eventId!, :orderId!, :payloadHash!, :recipientEmail, :orderStatus!, :subject!, :body!)
 * ON CONFLICT DO NOTHING
 * ```
 */
export const insertDelivery = new PreparedQuery<IInsertDeliveryParams,IInsertDeliveryResult>(insertDeliveryIR);


/** 'LockDelivery' parameters type */
export interface ILockDeliveryParams {
  eventId: string;
}

/** 'LockDelivery' return type */
export interface ILockDeliveryResult {
  attempts: number;
  body: string;
  completed_at: Date | null;
  created_at: Date;
  error_code: string | null;
  event_id: string;
  order_id: string;
  order_status: string;
  payload_hash: string;
  provider_message_id: string | null;
  recipient_email: string | null;
  status: string;
  subject: string;
}

/** 'LockDelivery' query type */
export interface ILockDeliveryQuery {
  params: ILockDeliveryParams;
  result: ILockDeliveryResult;
}

const lockDeliveryIR: any = {"usedParamSet":{"eventId":true},"params":[{"name":"eventId","required":true,"transform":{"type":"scalar"},"locs":[{"a":56,"b":64}]}],"statement":"SELECT * FROM notifications.deliveries WHERE event_id = :eventId! FOR UPDATE"};

/**
 * Query generated from SQL:
 * ```
 * SELECT * FROM notifications.deliveries WHERE event_id = :eventId! FOR UPDATE
 * ```
 */
export const lockDelivery = new PreparedQuery<ILockDeliveryParams,ILockDeliveryResult>(lockDeliveryIR);


/** 'CompleteDelivery' parameters type */
export interface ICompleteDeliveryParams {
  attempts: number;
  errorCode?: string | null | void;
  eventId: string;
  providerMessageId?: string | null | void;
  status: string;
}

/** 'CompleteDelivery' return type */
export interface ICompleteDeliveryResult {
  status: string;
}

/** 'CompleteDelivery' query type */
export interface ICompleteDeliveryQuery {
  params: ICompleteDeliveryParams;
  result: ICompleteDeliveryResult;
}

const completeDeliveryIR: any = {"usedParamSet":{"status":true,"attempts":true,"providerMessageId":true,"errorCode":true,"eventId":true},"params":[{"name":"status","required":true,"transform":{"type":"scalar"},"locs":[{"a":45,"b":52},{"a":178,"b":185}]},{"name":"attempts","required":true,"transform":{"type":"scalar"},"locs":[{"a":66,"b":75}]},{"name":"providerMessageId","required":false,"transform":{"type":"scalar"},"locs":[{"a":100,"b":117}]},{"name":"errorCode","required":false,"transform":{"type":"scalar"},"locs":[{"a":137,"b":146}]},{"name":"eventId","required":true,"transform":{"type":"scalar"},"locs":[{"a":257,"b":265}]}],"statement":"UPDATE notifications.deliveries\nSET status = :status!, attempts = :attempts!, provider_message_id = :providerMessageId,\n    error_code = :errorCode,\n    completed_at = CASE WHEN :status! = 'pending' THEN NULL ELSE statement_timestamp() END\nWHERE event_id = :eventId!\nRETURNING status"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE notifications.deliveries
 * SET status = :status!, attempts = :attempts!, provider_message_id = :providerMessageId,
 *     error_code = :errorCode,
 *     completed_at = CASE WHEN :status! = 'pending' THEN NULL ELSE statement_timestamp() END
 * WHERE event_id = :eventId!
 * RETURNING status
 * ```
 */
export const completeDelivery = new PreparedQuery<ICompleteDeliveryParams,ICompleteDeliveryResult>(completeDeliveryIR);


