/** Types generated for queries found in "apps/identity/src/auth/auth.sql" */
import { PreparedQuery } from '@pgtyped/runtime';

/** 'InsertUser' parameters type */
export interface IInsertUserParams {
  email: string;
  id: string;
  passwordHash: string;
}

/** 'InsertUser' return type */
export interface IInsertUserResult {
  email: string;
  id: string;
}

/** 'InsertUser' query type */
export interface IInsertUserQuery {
  params: IInsertUserParams;
  result: IInsertUserResult;
}

const insertUserIR: any = {"usedParamSet":{"id":true,"email":true,"passwordHash":true},"params":[{"name":"id","required":true,"transform":{"type":"scalar"},"locs":[{"a":62,"b":65}]},{"name":"email","required":true,"transform":{"type":"scalar"},"locs":[{"a":68,"b":74}]},{"name":"passwordHash","required":true,"transform":{"type":"scalar"},"locs":[{"a":77,"b":90}]}],"statement":"INSERT INTO identity.users (id, email, password_hash)\nVALUES (:id!, :email!, :passwordHash!)\nRETURNING id, email"};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO identity.users (id, email, password_hash)
 * VALUES (:id!, :email!, :passwordHash!)
 * RETURNING id, email
 * ```
 */
export const insertUser = new PreparedQuery<IInsertUserParams,IInsertUserResult>(insertUserIR);


/** 'FindUserByEmail' parameters type */
export interface IFindUserByEmailParams {
  email: string;
}

/** 'FindUserByEmail' return type */
export interface IFindUserByEmailResult {
  email: string;
  id: string;
  password_hash: string;
}

/** 'FindUserByEmail' query type */
export interface IFindUserByEmailQuery {
  params: IFindUserByEmailParams;
  result: IFindUserByEmailResult;
}

const findUserByEmailIR: any = {"usedParamSet":{"email":true},"params":[{"name":"email","required":true,"transform":{"type":"scalar"},"locs":[{"a":66,"b":72}]}],"statement":"SELECT id, email, password_hash FROM identity.users WHERE email = :email!"};

/**
 * Query generated from SQL:
 * ```
 * SELECT id, email, password_hash FROM identity.users WHERE email = :email!
 * ```
 */
export const findUserByEmail = new PreparedQuery<IFindUserByEmailParams,IFindUserByEmailResult>(findUserByEmailIR);


/** 'InsertSession' parameters type */
export interface IInsertSessionParams {
  tokenHash: string;
  ttlSeconds: number;
  userId: string;
}

/** 'InsertSession' return type */
export interface IInsertSessionResult {
  expires_at: Date;
}

/** 'InsertSession' query type */
export interface IInsertSessionQuery {
  params: IInsertSessionParams;
  result: IInsertSessionResult;
}

const insertSessionIR: any = {"usedParamSet":{"tokenHash":true,"userId":true,"ttlSeconds":true},"params":[{"name":"tokenHash","required":true,"transform":{"type":"scalar"},"locs":[{"a":72,"b":82}]},{"name":"userId","required":true,"transform":{"type":"scalar"},"locs":[{"a":85,"b":92}]},{"name":"ttlSeconds","required":true,"transform":{"type":"scalar"},"locs":[{"a":104,"b":115}]}],"statement":"INSERT INTO identity.sessions (token_hash, user_id, expires_at)\nVALUES (:tokenHash!, :userId!, now() + (:ttlSeconds!::integer * interval '1 second'))\nRETURNING expires_at"};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO identity.sessions (token_hash, user_id, expires_at)
 * VALUES (:tokenHash!, :userId!, now() + (:ttlSeconds!::integer * interval '1 second'))
 * RETURNING expires_at
 * ```
 */
export const insertSession = new PreparedQuery<IInsertSessionParams,IInsertSessionResult>(insertSessionIR);


/** 'FindSession' parameters type */
export interface IFindSessionParams {
  tokenHash: string;
}

/** 'FindSession' return type */
export interface IFindSessionResult {
  email: string;
  expires_at: Date;
  id: string;
}

/** 'FindSession' query type */
export interface IFindSessionQuery {
  params: IFindSessionParams;
  result: IFindSessionResult;
}

const findSessionIR: any = {"usedParamSet":{"tokenHash":true},"params":[{"name":"tokenHash","required":true,"transform":{"type":"scalar"},"locs":[{"a":123,"b":133}]}],"statement":"SELECT u.id, u.email, s.expires_at\nFROM identity.sessions s\nJOIN identity.users u ON u.id = s.user_id\nWHERE s.token_hash = :tokenHash! AND s.expires_at > now()"};

/**
 * Query generated from SQL:
 * ```
 * SELECT u.id, u.email, s.expires_at
 * FROM identity.sessions s
 * JOIN identity.users u ON u.id = s.user_id
 * WHERE s.token_hash = :tokenHash! AND s.expires_at > now()
 * ```
 */
export const findSession = new PreparedQuery<IFindSessionParams,IFindSessionResult>(findSessionIR);


