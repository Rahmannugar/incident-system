/** Types generated for queries found in "apps/payment/src/payments/refunds.sql" */
import { PreparedQuery } from '@pgtyped/runtime';

/** 'FindRefund' parameters type */
export interface IFindRefundParams {
  paymentId: string;
}

/** 'FindRefund' return type */
export interface IFindRefundResult {
  amount_minor: string;
  completed_at: Date;
  currency: string;
  payment_id: string;
  provider_reference: string;
}

/** 'FindRefund' query type */
export interface IFindRefundQuery {
  params: IFindRefundParams;
  result: IFindRefundResult;
}

const findRefundIR: any = {"usedParamSet":{"paymentId":true},"params":[{"name":"paymentId","required":true,"transform":{"type":"scalar"},"locs":[{"a":179,"b":189}]}],"statement":"SELECT r.payment_id, p.amount_minor, p.currency, r.provider_reference, r.completed_at\nFROM payments.refunds r\nJOIN payments.attempts p ON p.id = r.payment_id\nWHERE r.payment_id = :paymentId!"};

/**
 * Query generated from SQL:
 * ```
 * SELECT r.payment_id, p.amount_minor, p.currency, r.provider_reference, r.completed_at
 * FROM payments.refunds r
 * JOIN payments.attempts p ON p.id = r.payment_id
 * WHERE r.payment_id = :paymentId!
 * ```
 */
export const findRefund = new PreparedQuery<IFindRefundParams,IFindRefundResult>(findRefundIR);


/** 'InsertRefund' parameters type */
export interface IInsertRefundParams {
  paymentId: string;
  providerReference: string;
}

/** 'InsertRefund' return type */
export type IInsertRefundResult = void;

/** 'InsertRefund' query type */
export interface IInsertRefundQuery {
  params: IInsertRefundParams;
  result: IInsertRefundResult;
}

const insertRefundIR: any = {"usedParamSet":{"providerReference":true,"paymentId":true},"params":[{"name":"providerReference","required":true,"transform":{"type":"scalar"},"locs":[{"a":73,"b":91}]},{"name":"paymentId","required":true,"transform":{"type":"scalar"},"locs":[{"a":127,"b":137}]}],"statement":"INSERT INTO payments.refunds (payment_id, provider_reference)\nSELECT id, :providerReference! FROM payments.attempts\nWHERE id = :paymentId! AND status = 'succeeded'\nON CONFLICT (payment_id) DO NOTHING"};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO payments.refunds (payment_id, provider_reference)
 * SELECT id, :providerReference! FROM payments.attempts
 * WHERE id = :paymentId! AND status = 'succeeded'
 * ON CONFLICT (payment_id) DO NOTHING
 * ```
 */
export const insertRefund = new PreparedQuery<IInsertRefundParams,IInsertRefundResult>(insertRefundIR);


