import { describe, expect, it } from 'vitest';
import { toneOf } from '../../web/src/components/gauge';

/**
 * "Every gauge ships a target marker + good/watch/bad bands" (Blueprint A.7,
 * after Stephen Few). The band lookup is the part that decides what the
 * operator is told, so it is tested independently of the DOM.
 */
const RUNWAY_BANDS = [
  { from: 0, to: 1, tone: 'bad' as const },
  { from: 1, to: 3, tone: 'watch' as const },
  { from: 3, to: 12, tone: 'good' as const },
];

describe('toneOf', () => {
  it('classifies values into their band', () => {
    expect(toneOf(0.5, RUNWAY_BANDS)).toBe('bad');
    expect(toneOf(2, RUNWAY_BANDS)).toBe('watch');
    expect(toneOf(6, RUNWAY_BANDS)).toBe('good');
  });

  it('treats a band start as inclusive and its end as exclusive', () => {
    expect(toneOf(1, RUNWAY_BANDS)).toBe('watch');
    expect(toneOf(3, RUNWAY_BANDS)).toBe('good');
  });

  it('includes the very top of the last band', () => {
    // The final band is closed, so a value exactly at max is still classified
    // rather than falling through to "no tone".
    expect(toneOf(12, RUNWAY_BANDS)).toBe('good');
  });

  it('returns null outside every band rather than guessing', () => {
    expect(toneOf(-1, RUNWAY_BANDS)).toBeNull();
    expect(toneOf(99, RUNWAY_BANDS)).toBeNull();
  });

  it('returns null when no bands are supplied', () => {
    expect(toneOf(5, undefined)).toBeNull();
    expect(toneOf(5, [])).toBeNull();
  });
});
