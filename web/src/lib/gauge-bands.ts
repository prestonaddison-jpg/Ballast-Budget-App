/**
 * Gauge band classification. PURE — no DOM.
 *
 * "Every gauge ships a target marker + good/watch/bad bands" (Blueprint A.7,
 * after Stephen Few). This is the part that decides what the operator is told,
 * so it lives apart from the SVG that draws it.
 */

export type Tone = 'good' | 'watch' | 'bad';

export interface GaugeBand {
  /** Band start, in value units (inclusive). */
  from: number;
  /** Band end (exclusive, except on the last band). */
  to: number;
  tone: Tone;
}

export const TONE_WORD: Record<Tone, string> = {
  good: 'healthy',
  watch: 'watch',
  bad: 'short',
};

export function toneOf(value: number, bands: GaugeBand[] | undefined): Tone | null {
  if (!bands || bands.length === 0) return null;
  for (let i = 0; i < bands.length; i++) {
    const b = bands[i];
    const last = i === bands.length - 1;
    if (value >= b.from && (last ? value <= b.to : value < b.to)) return b.tone;
  }
  return null;
}
