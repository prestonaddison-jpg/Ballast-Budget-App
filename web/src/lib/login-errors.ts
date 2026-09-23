/**
 * What to tell someone whose sign-in did not work. PURE — no DOM.
 *
 * THE DEFECT THIS EXISTS FOR. The login form said "That email and password did
 * not match" for EVERY failure except a rate limit. On the first real
 * deployment the Worker was answering 503 "The server is not configured", and
 * the screen reported it as a wrong password. The operator retyped a correct
 * password repeatedly while the fault was in the deploy — and the audit log
 * proved it, because it was EMPTY: the login handler had never run at all.
 *
 * The security rule it was protecting is real and is preserved: inside a 401,
 * "no such user" and "wrong password" stay indistinguishable. The server
 * already returns one identical body for both. That rule was never a reason to
 * describe a broken server as a typing mistake.
 *
 * Kept out of main.ts so it can be tested at all: main.ts reads `document` at
 * module load, so importing it inside workerd throws before a single
 * assertion runs.
 */

import { ApiError } from './api';

export function loginErrorText(err: unknown): string {
  if (!(err instanceof ApiError)) {
    // Never reached the Worker at all: offline, DNS, a dead deploy.
    return "Couldn't reach Ballast. Check your connection and try again.";
  }
  switch (err.status) {
    case 401:
      return 'That email and password did not match.';
    case 429:
      return 'Too many attempts. Try again shortly.';
    case 503:
      // The server answered, and answered that it cannot serve. Saying so
      // sends the operator to the right place instead of to their keyboard.
      return 'Ballast is not finished setting up. This is a server problem, not your password.';
    case 403:
      // Origin/CSRF refusal. Almost always the app being opened on a hostname
      // the Worker was not told about, which no amount of retyping fixes.
      return "This address isn't one Ballast recognises. Try the official link.";
    default:
      return err.message || 'Something went wrong signing in.';
  }
}
