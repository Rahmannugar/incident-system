import type {Pool} from 'pg';
import {findSession, findUserByEmail, insertSession, insertUser} from './auth.queries.js';
import type {AssertActive, User} from './auth.types.ts';

interface NewSession {
  userId: string;
  tokenHash: string;
  ttlSeconds: number;
}

export class AuthRepository {
  constructor(private readonly pool: Pool) {}

  async register(input: NewSession & {email: string; passwordHash: string}, assertActive: AssertActive): Promise<{user: User; expiresAt: Date}> {
    assertActive();
    const client = await this.pool.connect();
    let discard = false;
    try {
      await client.query('BEGIN');
      assertActive();
      const [user] = await insertUser.run({id: input.userId, email: input.email, passwordHash: input.passwordHash}, client);
      const [session] = await insertSession.run(input, client);
      if (!user || !session) throw new Error('Registration returned no row');
      // A cancelled request must not deliberately commit a pending registration.
      assertActive();
      await client.query('COMMIT');
      return {user, expiresAt: session.expires_at};
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { discard = true; }
      throw error;
    } finally {
      client.release(discard);
    }
  }

  async findByEmail(email: string) {
    const [user] = await findUserByEmail.run({email}, this.pool);
    return user;
  }

  async createSession(input: NewSession): Promise<Date> {
    const [session] = await insertSession.run(input, this.pool);
    if (!session) throw new Error('Session returned no row');
    return session.expires_at;
  }

  async findSession(tokenHash: string) {
    const [session] = await findSession.run({tokenHash}, this.pool);
    return session;
  }
}
