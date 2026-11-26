/** Types generated for queries found in "apps/payment/src/payments/outbox.sql" */
import { PreparedQuery } from '@pgtyped/runtime';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type NumberOrString = number | string;

/** 'ExhaustExpiredClaims' parameters type */
export type IExhaustExpiredClaimsParams = void;

/** 'ExhaustExpiredClaims' return type */
export type IExhaustExpiredClaimsResult = void;

/** 'ExhaustExpiredClaims' query type */
export interface IExhaustExpiredClaimsQuery {
  params: IExhaustExpiredClaimsParams;
  result: IExhaustExpiredClaimsResult;
}

const exhaustExpiredClaimsIR: any = {"usedParamSet":{},"params":[],"statement":"UPDATE payments.outbox\nSET exhausted_at = now(), claim_token = NULL, claim_until = NULL,\n    last_error_code = 'publish_attempts_exhausted'\nWHERE published_at IS NULL AND exhausted_at IS NULL AND publish_attempts >= 8\n    AND (claim_until IS NULL OR claim_until <= now())"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE payments.outbox
 * SET exhausted_at = now(), claim_token = NULL, claim_until = NULL,
 *     last_error_code = 'publish_attempts_exhausted'
 * WHERE published_at IS NULL AND exhausted_at IS NULL AND publish_attempts >= 8
 *     AND (claim_until IS NULL OR claim_until <= now())
 * ```
 */
export const exhaustExpiredClaims = new PreparedQuery<IExhaustExpiredClaimsParams,IExhaustExpiredClaimsResult>(exhaustExpiredClaimsIR);


/** 'ClaimOutboxBatch' parameters type */
export interface IClaimOutboxBatchParams {
  batchSize: NumberOrString;
  claimToken: string;
}

/** 'ClaimOutboxBatch' return type */
export interface IClaimOutboxBatchResult {
  id: string;
  payload: Json;
  payment_id: string;
  publish_attempts: number;
}

/** 'ClaimOutboxBatch' query type */
export interface IClaimOutboxBatchQuery {
  params: IClaimOutboxBatchParams;
  result: IClaimOutboxBatchResult;
}

const claimOutboxBatchIR: any = {"usedParamSet":{"batchSize":true,"claimToken":true},"params":[{"name":"batchSize","required":true,"transform":{"type":"scalar"},"locs":[{"a":283,"b":293}]},{"name":"claimToken","required":true,"transform":{"type":"scalar"},"locs":[{"a":343,"b":354}]}],"statement":"WITH pending AS (\n    SELECT id FROM payments.outbox\n    WHERE published_at IS NULL AND exhausted_at IS NULL AND available_at <= now()\n        AND publish_attempts < 8 AND (claim_until IS NULL OR claim_until <= now())\n    ORDER BY created_at, id\n    FOR UPDATE SKIP LOCKED\n    LIMIT :batchSize!\n)\nUPDATE payments.outbox AS o\nSET claim_token = :claimToken!, claim_until = now() + interval '30 seconds',\n    publish_attempts = publish_attempts + 1\nFROM pending WHERE o.id = pending.id\nRETURNING o.id, o.payment_id, o.payload, o.publish_attempts"};

/**
 * Query generated from SQL:
 * ```
 * WITH pending AS (
 *     SELECT id FROM payments.outbox
 *     WHERE published_at IS NULL AND exhausted_at IS NULL AND available_at <= now()
 *         AND publish_attempts < 8 AND (claim_until IS NULL OR claim_until <= now())
 *     ORDER BY created_at, id
 *     FOR UPDATE SKIP LOCKED
 *     LIMIT :batchSize!
 * )
 * UPDATE payments.outbox AS o
 * SET claim_token = :claimToken!, claim_until = now() + interval '30 seconds',
 *     publish_attempts = publish_attempts + 1
 * FROM pending WHERE o.id = pending.id
 * RETURNING o.id, o.payment_id, o.payload, o.publish_attempts
 * ```
 */
export const claimOutboxBatch = new PreparedQuery<IClaimOutboxBatchParams,IClaimOutboxBatchResult>(claimOutboxBatchIR);


/** 'FinishOutboxBatch' parameters type */
export interface IFinishOutboxBatchParams {
  claimToken: string;
  results: Json;
}

/** 'FinishOutboxBatch' return type */
export interface IFinishOutboxBatchResult {
  exhausted_at: Date | null;
  id: string;
  published_at: Date | null;
}

/** 'FinishOutboxBatch' query type */
export interface IFinishOutboxBatchQuery {
  params: IFinishOutboxBatchParams;
  result: IFinishOutboxBatchResult;
}

const finishOutboxBatchIR: any = {"usedParamSet":{"results":true,"claimToken":true},"params":[{"name":"results","required":true,"transform":{"type":"scalar"},"locs":[{"a":55,"b":63}]},{"name":"claimToken","required":true,"transform":{"type":"scalar"},"locs":[{"a":716,"b":727}]}],"statement":"WITH results AS (\n    SELECT * FROM jsonb_to_recordset(:results!::jsonb)\n        AS r(id uuid, message_id text, error_code text)\n)\nUPDATE payments.outbox AS o\nSET published_at = CASE WHEN r.message_id IS NOT NULL THEN now() ELSE NULL END,\n    qstash_message_id = r.message_id,\n    claim_token = NULL, claim_until = NULL,\n    last_error_code = r.error_code,\n    available_at = CASE WHEN r.message_id IS NOT NULL THEN available_at\n        ELSE now() + (least(300, power(2, publish_attempts)) * interval '1 second') END,\n    exhausted_at = CASE WHEN r.message_id IS NULL AND\n        (publish_attempts >= 8 OR r.error_code = 'invalid_event') THEN now() ELSE NULL END\nFROM results r\nWHERE o.id = r.id AND o.claim_token = :claimToken! AND o.published_at IS NULL\nRETURNING o.id, o.published_at, o.exhausted_at"};

/**
 * Query generated from SQL:
 * ```
 * WITH results AS (
 *     SELECT * FROM jsonb_to_recordset(:results!::jsonb)
 *         AS r(id uuid, message_id text, error_code text)
 * )
 * UPDATE payments.outbox AS o
 * SET published_at = CASE WHEN r.message_id IS NOT NULL THEN now() ELSE NULL END,
 *     qstash_message_id = r.message_id,
 *     claim_token = NULL, claim_until = NULL,
 *     last_error_code = r.error_code,
 *     available_at = CASE WHEN r.message_id IS NOT NULL THEN available_at
 *         ELSE now() + (least(300, power(2, publish_attempts)) * interval '1 second') END,
 *     exhausted_at = CASE WHEN r.message_id IS NULL AND
 *         (publish_attempts >= 8 OR r.error_code = 'invalid_event') THEN now() ELSE NULL END
 * FROM results r
 * WHERE o.id = r.id AND o.claim_token = :claimToken! AND o.published_at IS NULL
 * RETURNING o.id, o.published_at, o.exhausted_at
 * ```
 */
export const finishOutboxBatch = new PreparedQuery<IFinishOutboxBatchParams,IFinishOutboxBatchResult>(finishOutboxBatchIR);


