/**
 * User + session persistence.
 *
 * BOLA DISCIPLINE: every function that reads user-owned data takes the
 * authenticated userId and puts it in the WHERE clause. There is deliberately
 * no `findById(id)` that trusts a caller-supplied id — that shape is how
 * object-level authorization bugs get written.
 */

import type { SessionRecord, SessionStore } from '../../auth/session';

export interface UserRecord {
  id: string;
  email: string;
  password_hash: string;
  created_at: number;
  updated_at: number;
  disabled_at: number | null;
}

export async function findUserByEmail(db: D1Database, email: string): Promise<UserRecord | null> {
  return db
    .prepare('SELECT * FROM users WHERE lower(email) = lower(?) AND disabled_at IS NULL')
    .bind(email)
    .first<UserRecord>();
}

export async function findUserById(db: D1Database, userId: string): Promise<UserRecord | null> {
  return db
    .prepare('SELECT * FROM users WHERE id = ? AND disabled_at IS NULL')
    .bind(userId)
    .first<UserRecord>();
}

export async function createUser(
  db: D1Database,
  user: { id: string; email: string; passwordHash: string; now: number },
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO users (id, email, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    )
    .bind(user.id, user.email, user.passwordHash, user.now, user.now)
    .run();
}

export async function updatePasswordHash(
  db: D1Database,
  userId: string,
  passwordHash: string,
  now: number,
): Promise<void> {
  await db
    .prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
    .bind(passwordHash, now, userId)
    .run();
}

/** D1-backed SessionStore. */
export function createSessionStore(db: D1Database): SessionStore {
  return {
    async insert(record: SessionRecord): Promise<void> {
      await db
        .prepare(
          `INSERT INTO sessions
             (id, user_id, token_hash, created_at, last_seen_at, absolute_expires_at, revoked_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          record.id,
          record.user_id,
          record.token_hash,
          record.created_at,
          record.last_seen_at,
          record.absolute_expires_at,
          record.revoked_at,
        )
        .run();
    },

    async findByTokenHash(tokenHash: string): Promise<SessionRecord | null> {
      return db
        .prepare('SELECT * FROM sessions WHERE token_hash = ?')
        .bind(tokenHash)
        .first<SessionRecord>();
    },

    async touch(id: string, lastSeenAt: number): Promise<void> {
      await db
        .prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?')
        .bind(lastSeenAt, id)
        .run();
    },

    async revoke(id: string, revokedAt: number): Promise<void> {
      await db
        .prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
        .bind(revokedAt, id)
        .run();
    },

    async revokeAllForUser(userId: string, revokedAt: number): Promise<void> {
      await db
        .prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
        .bind(revokedAt, userId)
        .run();
    },

    async deleteExpired(before: number): Promise<number> {
      const result = await db
        .prepare(
          'DELETE FROM sessions WHERE absolute_expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)',
        )
        .bind(before, before)
        .run();
      return result.meta.changes ?? 0;
    },
  };
}
