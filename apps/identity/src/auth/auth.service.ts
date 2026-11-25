import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {AuthRepository} from './auth.repository.ts';
import {AuthFailure, type AssertActive, type Session} from './auth.types.ts';
import {hashPassword, verifyPassword} from './password.ts';

export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function credentials(email: string, password: string, signup: boolean): string {
  const normalized = email.trim().toLowerCase();
  if (normalized.length > 254 || !/^[\x21-\x7e]+$/.test(normalized) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new AuthFailure('invalid_request', 'A valid email is required');
  }
  const length = Buffer.byteLength(password, 'utf8');
  if (length < (signup ? 12 : 1) || length > 128) {
    throw new AuthFailure('invalid_request', signup ? 'Password must be between 12 and 128 bytes' : 'Password must be between 1 and 128 bytes');
  }
  return normalized;
}

function isDuplicateEmail(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505' && 'constraint' in error && error.constraint === 'users_email_unique';
}

export class AuthService {
  private inFlight = 0;
  constructor(private readonly repository: AuthRepository, private readonly ttl: number, private readonly limit: number, private readonly dummyHash: string) {}

  private async bounded<T>(work: () => Promise<T>): Promise<T> {
    if (this.inFlight >= this.limit) throw new AuthFailure('overloaded', 'Authentication is busy; retry shortly');
    this.inFlight++;
    try { return await work(); } finally { this.inFlight--; }
  }

  async signUp(email: string, password: string, assertActive: AssertActive): Promise<Session> {
    return this.bounded(async () => {
      const normalized = credentials(email, password, true);
      const passwordHash = await hashPassword(password);
      assertActive();
      const token = randomBytes(32).toString('base64url');
      try {
        const result = await this.repository.register({userId: randomUUID(), email: normalized, passwordHash, tokenHash: tokenHash(token), ttlSeconds: this.ttl}, assertActive);
        return {...result, token};
      } catch (error) {
        if (isDuplicateEmail(error)) throw new AuthFailure('email_exists', 'An account with this email already exists');
        throw error;
      }
    });
  }

  async login(email: string, password: string, assertActive: AssertActive): Promise<Session> {
    return this.bounded(async () => {
      const normalized = credentials(email, password, false);
      const user = await this.repository.findByEmail(normalized);
      assertActive();
      // Unknown accounts take the same password-hashing path as incorrect passwords.
      const valid = await verifyPassword(password, user?.password_hash ?? this.dummyHash);
      assertActive();
      if (!user || !valid) throw new AuthFailure('invalid_credentials', 'Email or password is incorrect');
      const token = randomBytes(32).toString('base64url');
      const expiresAt = await this.repository.createSession({userId: user.id, tokenHash: tokenHash(token), ttlSeconds: this.ttl});
      return {user: {id: user.id, email: user.email}, token, expiresAt};
    });
  }

  async getSession(token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new AuthFailure('unauthorized', 'A valid session is required');
    const session = await this.repository.findSession(tokenHash(token));
    if (!session) throw new AuthFailure('unauthorized', 'A valid session is required');
    return {user: {id: session.id, email: session.email}, expiresAt: session.expires_at};
  }
}
