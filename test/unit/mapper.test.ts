import { describe, expect, it } from 'vitest';
import {
  mapAccount,
  mapStream,
  mapTransaction,
  normalizeAmount,
  toMinor,
} from '../../src/ledger-source/plaid/mapper';
import type {
  PlaidAccount,
  PlaidTransaction,
  PlaidTransactionStream,
} from '../../src/ledger-source/plaid/api-types';

const baseTxn: PlaidTransaction = {
  account_id: 'acc_1',
  amount: 0,
  iso_currency_code: 'USD',
  unofficial_currency_code: null,
  date: '2026-09-01',
  name: 'Test',
  pending: false,
  pending_transaction_id: null,
  transaction_id: 'txn_1',
};

describe('normalizeAmount — THE sign flip', () => {
  /**
   * Plaid: "Positive values when money moves out of the account; negative
   * values when money moves in... direct deposits and refunds are negative."
   * Ballast: positive is money IN. Everything downstream depends on this.
   */
  it('turns a Plaid deposit (negative) into a positive inflow', () => {
    expect(normalizeAmount(-2500.0)).toBe(250_000);
  });

  it('turns a Plaid purchase (positive) into a negative outflow', () => {
    expect(normalizeAmount(42.5)).toBe(-4250);
  });

  it('keeps zero at zero without producing -0', () => {
    expect(Object.is(normalizeAmount(0), -0)).toBe(false);
    expect(normalizeAmount(0)).toBe(0);
  });
});

describe('toMinor', () => {
  it('rounds rather than truncates, so cents are not lost', () => {
    // 12.34 * 100 is 1233.9999999999998 in IEEE-754. Truncation would drop a
    // cent here, and a cash-allocation app that loses cents breaks its own
    // conservation invariant over time.
    expect(toMinor(12.34)).toBe(1234);
    expect(toMinor(0.1 + 0.2)).toBe(30);
    expect(toMinor(1e6 + 0.07)).toBe(100_000_007);
  });
});

describe('mapTransaction', () => {
  it('prefers the raw bank descriptor over Plaid’s cleaned name', () => {
    const txn = {
      ...baseTxn,
      name: 'Square Inc',
      original_description: 'SQUARE INC 240901 ABC123',
    };
    expect(mapTransaction(txn, () => undefined).description).toBe('SQUARE INC 240901 ABC123');
  });

  it('falls back to name when original_description is absent', () => {
    // The field is ABSENT (not null) unless include_original_description is set.
    expect(mapTransaction(baseTxn, () => undefined).description).toBe('Test');
  });

  it('uses the structured counterparty for counterparty learning', () => {
    const txn: PlaidTransaction = {
      ...baseTxn,
      merchant_name: 'Cleaned Merchant',
      counterparties: [
        { name: 'SBA', type: 'financial_institution', website: null, logo_url: null },
      ],
    };
    expect(mapTransaction(txn, () => undefined).counterparty).toBe('SBA');
  });

  it('never falls back to the raw descriptor for counterparty', () => {
    // Descriptors carry per-transaction trace ids and dates, so learning on
    // them would never match a second time.
    const txn = { ...baseTxn, original_description: 'ACH 9931 XYZ', merchant_name: null };
    expect(mapTransaction(txn, () => undefined).counterparty).toBeNull();
  });
});

describe('mapAccount', () => {
  const account = (over: Partial<PlaidAccount> = {}): PlaidAccount => ({
    account_id: 'acc_1',
    balances: {
      available: 1000,
      current: 1200,
      limit: null,
      iso_currency_code: 'USD',
      unofficial_currency_code: null,
    },
    mask: '1234',
    name: 'Business Checking',
    official_name: null,
    type: 'depository',
    subtype: 'checking',
    ...over,
  });

  it('preserves a null available balance as null, never zero', () => {
    // "Unknown available balance" and "no money available" lead to opposite
    // decisions. Coercing one into the other is the dangerous bug here.
    const mapped = mapAccount(
      account({
        balances: {
          available: null,
          current: 500,
          limit: null,
          iso_currency_code: 'USD',
          unofficial_currency_code: null,
        },
      }),
    );
    expect(mapped.availableMinor).toBeNull();
    expect(mapped.currentMinor).toBe(50_000);
  });

  it('does not sign-flip balances (a balance is a position, not a movement)', () => {
    expect(mapAccount(account()).availableMinor).toBe(100_000);
  });

  it('marks depository checking as budgetable', () => {
    expect(mapAccount(account()).budgetable).toBe(true);
  });

  it('excludes credit accounts from budgetable cash', () => {
    // Including a liability would break the per-entity conservation invariant,
    // which sums envelopes against BUDGETABLE accounts only.
    const mapped = mapAccount(account({ type: 'credit', subtype: 'credit card' }));
    expect(mapped.budgetable).toBe(false);
    expect(mapped.type).toBe('credit');
    expect(mapped.subtype).toBe('credit_card');
  });

  it('maps brokerage onto investment and leaves it non-budgetable', () => {
    expect(mapAccount(account({ type: 'brokerage', subtype: null })).type).toBe('investment');
    expect(mapAccount(account({ type: 'brokerage', subtype: null })).budgetable).toBe(false);
  });
});

describe('mapStream', () => {
  const stream = (over: Partial<PlaidTransactionStream> = {}): PlaidTransactionStream => ({
    account_id: 'acc_1',
    stream_id: 'str_1',
    description: 'ACME INSURANCE',
    merchant_name: null,
    first_date: '2024-09-01',
    last_date: '2026-09-01',
    frequency: 'ANNUALLY',
    transaction_ids: ['a', 'b', 'c'],
    average_amount: { amount: 1200, iso_currency_code: 'USD' },
    last_amount: { amount: 1200, iso_currency_code: 'USD' },
    is_active: true,
    status: 'MATURE',
    ...over,
  });

  it('maps ANNUALLY — the cadence that catches forgotten yearly premiums', () => {
    expect(mapStream(stream()).cadence).toBe('annually');
  });

  it('normalizes an outflow stream to a negative amount', () => {
    // Plaid reports an outflow as positive; Ballast says money out is negative.
    expect(mapStream(stream()).lastAmountMinor).toBe(-120_000);
  });

  it('reports an absent amount as null, NOT as a $0 obligation', () => {
    // TransactionStreamAmount.amount is OPTIONAL in the SDK. Coercing it to 0
    // would hand the forward-obligations engine a confident "$0 bill": funded
    // at zero, netted out of safe-to-spend at zero, and silently
    // under-reserving for an obligation that actually has a value.
    const s = mapStream(stream({ last_amount: { iso_currency_code: 'USD' } }));
    expect(s.lastAmountMinor).toBeNull();
  });

  it('still maps a real zero as zero', () => {
    const s = mapStream(stream({ last_amount: { amount: 0, iso_currency_code: 'USD' } }));
    expect(s.lastAmountMinor).toBe(0);
  });

  it('falls back to unofficial_currency_code when iso is null', () => {
    const s = mapStream(
      stream({
        last_amount: { amount: 10, iso_currency_code: null, unofficial_currency_code: 'XBT' },
        average_amount: { amount: 10, iso_currency_code: null, unofficial_currency_code: 'XBT' },
      }),
    );
    expect(s.currency).toBe('XBT');
  });

  it('distinguishes EARLY_DETECTION from MATURE', () => {
    // An early-detection stream is provisional and must not be treated as a
    // confirmed obligation.
    expect(mapStream(stream({ status: 'EARLY_DETECTION' })).maturity).toBe('early_detection');
  });

  it('maps a quarterly-ish bill to unknown, not to a wrong cadence', () => {
    // Plaid has no QUARTERLY. Quarterly estimated taxes land in UNKNOWN, and
    // consumers must treat that as a real case rather than an error.
    expect(mapStream(stream({ frequency: 'UNKNOWN' })).cadence).toBe('unknown');
  });
});
