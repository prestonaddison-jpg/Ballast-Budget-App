/**
 * Zone assignment and grouping (Blueprint §13, A.7). PURE — no DOM.
 *
 * "Envelope tiles in an iOS-first zone-grid (the free-form board idea was
 * dropped). Can show 8-12 chunked tiles per zone (recognition, not recall —
 * no artificial 7-tile cap)."
 *
 * THE MILLER'S-LAW CORRECTION, applied. The design system is explicit that
 * 7±2 is about working-memory RECALL, not how many things may be VISIBLE.
 * Visible items use recognition — the operator can just look. So this
 * component deliberately has no tile cap. What it does instead is CHUNK:
 * tiles are grouped into named zones, which is the thing that actually
 * reduces load. Capping the grid at seven would hide envelopes the operator
 * needs while doing nothing for cognitive load.
 *
 * Zones are also where the blueprint's ordering intent lives: reserves before
 * discretionary, so the money that is already spoken for reads first.
 */

import type { EnvelopeTileModel } from './envelope-math';

export interface Zone {
  id: string;
  /** Shown as the zone heading. Null renders an unlabelled group. */
  title: string | null;
  envelopes: EnvelopeTileModel[];
  /** Optional one-line framing under the heading. */
  caption?: string;
}

/**
 * Default zone assignment.
 *
 * Reserves (tax, buffer) come first because they are the money that is NOT
 * free — surfacing them above discretionary envelopes is the whole point of
 * the app (§2: "not knowing what's truly free vs. already spoken-for").
 */
export function defaultZoneFor(type: EnvelopeTileModel['type']): string {
  switch (type) {
    case 'unallocated':
      return 'available';
    case 'tax':
    case 'buffer':
      return 'reserved';
    case 'save':
    case 'spend':
    default:
      return 'purpose';
  }
}

const ZONE_ORDER = ['available', 'reserved', 'purpose'] as const;

const ZONE_TITLE: Record<string, string> = {
  available: 'Available',
  reserved: 'Spoken for',
  purpose: 'Purpose',
};

const ZONE_CAPTION: Record<string, string> = {
  available: 'Not yet given a job.',
  reserved: 'Tax and buffer. Real money, already claimed.',
  purpose: 'Projects and planned spending.',
};

/** Group a flat envelope list into the default zones, in the default order. */
export function groupIntoZones(envelopes: EnvelopeTileModel[]): Zone[] {
  const buckets = new Map<string, EnvelopeTileModel[]>();
  for (const envelope of envelopes) {
    const zone = defaultZoneFor(envelope.type);
    const list = buckets.get(zone);
    if (list) list.push(envelope);
    else buckets.set(zone, [envelope]);
  }

  return ZONE_ORDER.filter((id) => buckets.has(id)).map((id) => ({
    id,
    title: ZONE_TITLE[id] ?? null,
    caption: ZONE_CAPTION[id],
    envelopes: buckets.get(id)!,
  }));
}
