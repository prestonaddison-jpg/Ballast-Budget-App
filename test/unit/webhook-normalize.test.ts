import { describe, expect, it } from 'vitest';
import { normalizeWebhook, statusFromItemError } from '../../src/ledger-source/plaid/source';

describe('normalizeWebhook', () => {
  it('routes RECURRING_TRANSACTIONS_UPDATE, which arrives as type TRANSACTIONS', () => {
    // There is NO 'RECURRING_TRANSACTIONS' webhook_type. A router that expects
    // one silently drops every recurring update — which would quietly disable
    // the whole forward-obligations engine.
    const event = normalizeWebhook({
      webhook_type: 'TRANSACTIONS',
      webhook_code: 'RECURRING_TRANSACTIONS_UPDATE',
      item_id: 'item_1',
      account_ids: ['acc_1'],
    });
    expect(event).toEqual({
      kind: 'recurring_updated',
      sourceItemId: 'item_1',
      accountIds: ['acc_1'],
    });
  });

  it('routes SYNC_UPDATES_AVAILABLE with its completion flags', () => {
    expect(
      normalizeWebhook({
        webhook_type: 'TRANSACTIONS',
        webhook_code: 'SYNC_UPDATES_AVAILABLE',
        item_id: 'item_1',
        initial_update_complete: true,
        historical_update_complete: false,
      }),
    ).toEqual({
      kind: 'sync_available',
      sourceItemId: 'item_1',
      initialComplete: true,
      historicalComplete: false,
    });
  });

  it('maps ITEM/ERROR with ITEM_LOGIN_REQUIRED to a re-auth prompt', () => {
    expect(
      normalizeWebhook({
        webhook_type: 'ITEM',
        webhook_code: 'ERROR',
        item_id: 'item_1',
        error: {
          error_type: 'ITEM_ERROR',
          error_code: 'ITEM_LOGIN_REQUIRED',
          error_message: 'the login details of this item have changed',
          display_message: null,
        },
      }),
    ).toEqual({ kind: 'reauth_required', sourceItemId: 'item_1' });
  });

  it('handles PENDING_DISCONNECT (US/CA), which carries disconnect_time', () => {
    expect(
      normalizeWebhook({
        webhook_type: 'ITEM',
        webhook_code: 'PENDING_DISCONNECT',
        item_id: 'item_1',
        disconnect_time: '2026-10-01T00:00:00Z',
        reason: 'INSTITUTION_TOKEN_EXPIRATION',
      }),
    ).toEqual({
      kind: 'pending_disconnect',
      sourceItemId: 'item_1',
      disconnectsAt: '2026-10-01T00:00:00Z',
    });
  });

  it('handles PENDING_EXPIRATION (EU/UK), which carries consent_expiration_time', () => {
    // The same 7-day consent warning, split by region with DIFFERENT fields.
    // Handling only one leaves the other region silently disconnected.
    expect(
      normalizeWebhook({
        webhook_type: 'ITEM',
        webhook_code: 'PENDING_EXPIRATION',
        item_id: 'item_1',
        consent_expiration_time: '2026-10-01T00:00:00Z',
      }),
    ).toEqual({
      kind: 'pending_disconnect',
      sourceItemId: 'item_1',
      disconnectsAt: '2026-10-01T00:00:00Z',
    });
  });

  it('ignores webhook types it does not handle rather than throwing', () => {
    expect(normalizeWebhook({ webhook_type: 'HOLDINGS', webhook_code: 'DEFAULT_UPDATE' })).toEqual({
      kind: 'ignored',
      type: 'HOLDINGS',
      code: 'DEFAULT_UPDATE',
    });
  });

  it('throws when a webhook that needs an item_id has none', () => {
    // Every field of NEW_ACCOUNTS_AVAILABLE is optional in the SDK, so this
    // must be a runtime check — TypeScript will not force the narrowing.
    expect(() =>
      normalizeWebhook({ webhook_type: 'ITEM', webhook_code: 'NEW_ACCOUNTS_AVAILABLE' }),
    ).toThrow();
  });
});

describe('statusFromItemError', () => {
  it('reports a healthy item when there is no error', () => {
    expect(statusFromItemError(null)).toBe('ok');
  });

  it('maps ITEM_LOGIN_REQUIRED to reauth_required', () => {
    expect(statusFromItemError({ error_code: 'ITEM_LOGIN_REQUIRED' })).toBe('reauth_required');
  });

  it('maps user revocation distinctly from a broken login', () => {
    expect(statusFromItemError({ error_code: 'USER_PERMISSION_REVOKED' })).toBe('revoked_by_user');
  });

  it('does not treat an unrelated error as a connection failure', () => {
    expect(statusFromItemError({ error_code: 'PRODUCT_NOT_READY' })).toBe('ok');
  });
});
