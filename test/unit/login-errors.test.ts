/**
 * The sign-in screen must not blame the operator for the server's problems.
 *
 * THE DEFECT THIS EXISTS FOR, and it cost a real evening. The login form said
 * "That email and password did not match" for EVERY failure except a rate
 * limit. On the first real deployment the Worker was answering 503 "The server
 * is not configured", and the screen reported it as a wrong password. The
 * operator retyped a correct password repeatedly while the actual fault was in
 * the deploy — and the audit log proved it, because it was EMPTY: the login
 * handler had never run at all.
 *
 * The security rule it was protecting is real and is preserved: inside a 401,
 * "no such user" and "wrong password" stay indistinguishable. The server
 * already returns one identical body for both. That rule was never a reason to
 * describe a broken server as a typing mistake.
 */

import { describe, expect, it } from 'vitest';
import { ApiError } from '../../web/src/lib/api';
import { loginErrorText } from '../../web/src/lib/login-errors';

const CREDENTIALS = 'That email and password did not match.';

describe('loginErrorText', () => {
  it('claims a credentials failure ONLY on 401', () => {
    expect(loginErrorText(new ApiError(401, 'invalid_credentials', CREDENTIALS))).toBe(CREDENTIALS);
  });

  it('never claims a credentials failure for anything else', () => {
    for (const status of [400, 403, 429, 500, 502, 503, 504]) {
      expect(loginErrorText(new ApiError(status, 'x', 'raw message')), String(status)).not.toBe(
        CREDENTIALS,
      );
    }
  });

  it('says a 503 is the SERVER, in so many words', () => {
    // The exact case that wasted the evening. It must point away from the
    // keyboard, explicitly.
    const text = loginErrorText(
      new ApiError(503, 'misconfigured', 'The server is not configured.'),
    );
    expect(text).toMatch(/server/i);
    expect(text).toMatch(/not your password/i);
  });

  it('explains a 403 as the wrong address, not the wrong password', () => {
    const text = loginErrorText(new ApiError(403, 'forbidden', 'Request blocked.'));
    expect(text).toMatch(/address/i);
    expect(text).not.toBe(CREDENTIALS);
  });

  it('keeps the rate-limit message', () => {
    expect(loginErrorText(new ApiError(429, 'rate_limited', 'slow down'))).toMatch(/Too many/i);
  });

  it('treats a non-ApiError as never having reached the server', () => {
    // A TypeError from fetch means the request did not arrive. Reporting that
    // as bad credentials sends someone to check a password over a dead deploy.
    expect(loginErrorText(new TypeError('Failed to fetch'))).toMatch(/Couldn't reach/i);
    expect(loginErrorText(new TypeError('Failed to fetch'))).not.toBe(CREDENTIALS);
  });

  it('does not distinguish WHY a 401 happened', () => {
    // The security property, still intact: both server reasons arrive as the
    // same 401 with the same body, and produce the same sentence.
    const unknownUser = new ApiError(401, 'invalid_credentials', CREDENTIALS);
    const badPassword = new ApiError(401, 'invalid_credentials', CREDENTIALS);
    expect(loginErrorText(unknownUser)).toBe(loginErrorText(badPassword));
  });
});
