/**
 * Health check.
 *
 * Unauthenticated ON PURPOSE, and therefore says as little as possible: no
 * version of a dependency, no binding names, no configuration state. It exists
 * to answer "is the Worker up" for uptime monitoring, nothing more.
 */

import { Hono } from 'hono';
import type { Env } from '../env';
import { isLocalDev } from '../env';
import { json } from '../http/responses';

export const VERSION = '4.1.0';

export const healthRoutes = new Hono<{ Bindings: Env }>();

healthRoutes.get('/', (c) =>
  json(
    { ok: true, version: VERSION, time: new Date().toISOString() },
    { secure: !isLocalDev(c.env) },
  ),
);
