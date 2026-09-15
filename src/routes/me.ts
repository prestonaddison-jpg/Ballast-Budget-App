/**
 * Session-scoped read model for the PWA shell.
 */

import { Hono } from 'hono';
import type { Env } from '../env';
import { isLocalDev } from '../env';
import type { AppVariables } from '../http/middleware';
import { requireSession } from '../http/middleware';
import { json, unauthorized } from '../http/responses';
import { findUserById } from '../db/repos/users';
import { countAccountsByItem, listEntities, listItems } from '../db/repos/connections';

export const meRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();

meRoutes.use('*', requireSession);

meRoutes.get('/', async (c) => {
  const ctx = { secure: !isLocalDev(c.env) };
  const session = c.get('session');

  const user = await findUserById(c.env.DB, session.userId);
  if (!user) return unauthorized(ctx);

  // Each of these is scoped to session.userId — never to an id from the
  // request. That is the whole BOLA defence.
  const [entities, items, accountCounts] = await Promise.all([
    listEntities(c.env.DB, session.userId),
    listItems(c.env.DB, session.userId),
    countAccountsByItem(c.env.DB, session.userId),
  ]);

  return json(
    {
      user: { userId: user.id, email: user.email },
      entities: entities.map((e) => ({ id: e.id, name: e.name, state: e.state })),
      connections: items.map((item) => ({
        itemId: item.id,
        institutionName: item.institution_name,
        status: item.status,
        // ISO for the client; the freshness component turns it into
        // "synced 4m ago" and decides whether that counts as stale.
        lastSyncedAt: item.last_synced_at
          ? new Date(item.last_synced_at * 1000).toISOString()
          : null,
        accountCount: accountCounts.get(item.id) ?? 0,
      })),
    },
    ctx,
  );
});
