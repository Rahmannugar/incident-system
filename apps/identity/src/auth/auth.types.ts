export interface User {
  id: string;
  email: string;
}

export interface Session {
  user: User;
  token: string;
  expiresAt: Date;
}

export type FailureCode = 'invalid_request' | 'email_exists' | 'invalid_credentials' | 'unauthorized' | 'overloaded' | 'cancelled';

export class AuthFailure extends Error {
  constructor(readonly code: FailureCode, message: string) {
    super(message);
  }
}

export type AssertActive = () => void;
