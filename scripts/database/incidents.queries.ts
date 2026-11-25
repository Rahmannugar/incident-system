/** Types generated for queries found in "scripts/database/incidents.sql" */
import { PreparedQuery } from '@pgtyped/runtime';

/** 'InsertIncident' parameters type */
export interface IInsertIncidentParams {
  details?: string | null | void;
  id: string;
  summary: string;
}

/** 'InsertIncident' return type */
export interface IInsertIncidentResult {
  created_at: Date;
  details: string | null;
  id: string;
  summary: string;
}

/** 'InsertIncident' query type */
export interface IInsertIncidentQuery {
  params: IInsertIncidentParams;
  result: IInsertIncidentResult;
}

const insertIncidentIR: any = {"usedParamSet":{"id":true,"summary":true,"details":true},"params":[{"name":"id","required":true,"transform":{"type":"scalar"},"locs":[{"a":63,"b":66}]},{"name":"summary","required":true,"transform":{"type":"scalar"},"locs":[{"a":69,"b":77}]},{"name":"details","required":false,"transform":{"type":"scalar"},"locs":[{"a":80,"b":87}]}],"statement":"INSERT INTO sql_proof.incidents (id, summary, details)\nVALUES (:id!, :summary!, :details)\nRETURNING id, summary, details, created_at"};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO sql_proof.incidents (id, summary, details)
 * VALUES (:id!, :summary!, :details)
 * RETURNING id, summary, details, created_at
 * ```
 */
export const insertIncident = new PreparedQuery<IInsertIncidentParams,IInsertIncidentResult>(insertIncidentIR);


/** 'GetIncident' parameters type */
export interface IGetIncidentParams {
  id: string;
}

/** 'GetIncident' return type */
export interface IGetIncidentResult {
  created_at: Date;
  details: string | null;
  id: string;
  summary: string;
}

/** 'GetIncident' query type */
export interface IGetIncidentQuery {
  params: IGetIncidentParams;
  result: IGetIncidentResult;
}

const getIncidentIR: any = {"usedParamSet":{"id":true},"params":[{"name":"id","required":true,"transform":{"type":"scalar"},"locs":[{"a":76,"b":79}]}],"statement":"SELECT id, summary, details, created_at\nFROM sql_proof.incidents\nWHERE id = :id!"};

/**
 * Query generated from SQL:
 * ```
 * SELECT id, summary, details, created_at
 * FROM sql_proof.incidents
 * WHERE id = :id!
 * ```
 */
export const getIncident = new PreparedQuery<IGetIncidentParams,IGetIncidentResult>(getIncidentIR);


/** 'InsertOutbox' parameters type */
export interface IInsertOutboxParams {
  eventId: string;
  incidentId: string;
}

/** 'InsertOutbox' return type */
export interface IInsertOutboxResult {
  event_id: string;
  incident_id: string;
}

/** 'InsertOutbox' query type */
export interface IInsertOutboxQuery {
  params: IInsertOutboxParams;
  result: IInsertOutboxResult;
}

const insertOutboxIR: any = {"usedParamSet":{"eventId":true,"incidentId":true},"params":[{"name":"eventId","required":true,"transform":{"type":"scalar"},"locs":[{"a":61,"b":69}]},{"name":"incidentId","required":true,"transform":{"type":"scalar"},"locs":[{"a":72,"b":83}]}],"statement":"INSERT INTO sql_proof.outbox (event_id, incident_id)\nVALUES (:eventId!, :incidentId!)\nRETURNING event_id, incident_id"};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO sql_proof.outbox (event_id, incident_id)
 * VALUES (:eventId!, :incidentId!)
 * RETURNING event_id, incident_id
 * ```
 */
export const insertOutbox = new PreparedQuery<IInsertOutboxParams,IInsertOutboxResult>(insertOutboxIR);


/** 'GetOutbox' parameters type */
export interface IGetOutboxParams {
  incidentId: string;
}

/** 'GetOutbox' return type */
export interface IGetOutboxResult {
  event_id: string;
  incident_id: string;
}

/** 'GetOutbox' query type */
export interface IGetOutboxQuery {
  params: IGetOutboxParams;
  result: IGetOutboxResult;
}

const getOutboxIR: any = {"usedParamSet":{"incidentId":true},"params":[{"name":"incidentId","required":true,"transform":{"type":"scalar"},"locs":[{"a":71,"b":82}]}],"statement":"SELECT event_id, incident_id\nFROM sql_proof.outbox\nWHERE incident_id = :incidentId!"};

/**
 * Query generated from SQL:
 * ```
 * SELECT event_id, incident_id
 * FROM sql_proof.outbox
 * WHERE incident_id = :incidentId!
 * ```
 */
export const getOutbox = new PreparedQuery<IGetOutboxParams,IGetOutboxResult>(getOutboxIR);


