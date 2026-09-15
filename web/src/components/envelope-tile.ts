/**
 * Envelope tile — the unit of the Canvas (Blueprint §13). Rendering only.
 *
 * The presentation math and the rules behind it live in lib/envelope-math.ts.
 *
 * TWO RULES THAT LOOK LIKE STYLE AND ARE NOT:
 *
 * 1. NEVER SHAME COLORS. An envelope that is 20% funded is not failing — it is
 *    20% funded. Progress uses the brand accent, never --bad. The status
 *    colors are reserved for genuine status (a stale sync, an overdue
 *    obligation), because if "not yet full" is painted red then red stops
 *    meaning anything and the operator learns to ignore it (§14).
 *
 * 2. PERCENTAGE-PROGRESS FRAMING. A tile says "62% of $4,000", not "$1,520
 *    short". Same arithmetic, opposite emotional register — and the shortfall
 *    framing is the one that makes people avoid opening the app.
 *
 * Tiles are BUTTONS, not cards containing a button: tap-to-act is primary, so
 * the whole tile is the target (Fitts's).
 */

import {
  TYPE_LABEL,
  formatMoney,
  formatMoneyExact,
  fundedFraction,
  type EnvelopeTileModel,
} from '../lib/envelope-math';

export * from '../lib/envelope-math';

export interface EnvelopeTileOptions {
  envelope: EnvelopeTileModel;
  /** Tap-to-act. The whole tile is the target. */
  onSelect?: (envelope: EnvelopeTileModel) => void;
  /** Rendered small under the name, e.g. "due in 14 days". */
  note?: string;
}

export function createEnvelopeTile(opts: EnvelopeTileOptions): HTMLElement {
  const { envelope } = opts;
  const fraction = fundedFraction(envelope.balanceMinor, envelope.targetMinor);

  const tile = document.createElement('button');
  tile.type = 'button';
  tile.className = 'tile';
  tile.dataset.type = envelope.type;

  const head = document.createElement('div');
  head.className = 'tile-head';

  const name = document.createElement('span');
  name.className = 'tile-name';
  name.textContent = envelope.name;

  const kind = document.createElement('span');
  kind.className = 'tile-kind';
  kind.textContent = TYPE_LABEL[envelope.type];

  head.append(name, kind);

  const amount = document.createElement('div');
  amount.className = 'tile-amount money';
  amount.textContent = formatMoney(envelope.balanceMinor, envelope.currency);

  tile.append(head, amount);

  if (fraction != null && envelope.targetMinor != null) {
    const pct = Math.round(fraction * 100);

    const meter = document.createElement('div');
    meter.className = 'tide tile-tide';
    // The shared .tide component reads --p for its fill width.
    meter.style.setProperty('--p', `${pct}%`);

    const caption = document.createElement('div');
    caption.className = 'tile-progress';
    // Percentage-of-target, never "short by". Same numbers, and the operator
    // keeps opening the app.
    caption.textContent = `${pct}% of ${formatMoney(envelope.targetMinor, envelope.currency)}`;

    tile.append(meter, caption);
  } else if (envelope.type === 'unallocated') {
    const caption = document.createElement('div');
    caption.className = 'tile-progress';
    caption.textContent = 'ready to allocate';
    tile.append(caption);
  }

  if (opts.note) {
    const note = document.createElement('div');
    note.className = 'tile-note';
    note.textContent = opts.note;
    tile.append(note);
  }

  // One accessible name carrying everything the tile shows, so a screen reader
  // does not have to reconstruct it from four separate nodes.
  const parts = [
    envelope.name,
    TYPE_LABEL[envelope.type],
    formatMoneyExact(envelope.balanceMinor, envelope.currency),
  ];
  if (fraction != null && envelope.targetMinor != null) {
    parts.push(
      `${Math.round(fraction * 100)} percent of ${formatMoneyExact(envelope.targetMinor, envelope.currency)}`,
    );
  }
  if (opts.note) parts.push(opts.note);
  tile.setAttribute('aria-label', parts.join(', '));

  if (opts.onSelect) {
    tile.addEventListener('click', () => opts.onSelect!(envelope));
  } else {
    tile.disabled = true;
  }

  return tile;
}
