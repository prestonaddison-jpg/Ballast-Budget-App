/**
 * Zone grid — the Canvas layout. Rendering only; the grouping rules and the
 * Miller's-law reasoning live in lib/zones.ts.
 */

import { createEnvelopeTile } from './envelope-tile';
import type { EnvelopeTileModel } from '../lib/envelope-math';
import type { Zone } from '../lib/zones';

export * from '../lib/zones';

export interface ZoneGridOptions {
  zones: Zone[];
  onSelect?: (envelope: EnvelopeTileModel) => void;
  /**
   * Which envelopes are actually tappable. Defaults to all of them.
   *
   * Without this, one `onSelect` for the whole grid made EVERY tile a button —
   * including unallocated, which is the source of a fund and never its
   * destination. It looked live, animated on press and did nothing.
   */
  isSelectable?: (envelope: EnvelopeTileModel) => boolean;
  /** Rendered when every zone is empty. */
  emptyState?: () => Node;
}

export function createZoneGrid(opts: ZoneGridOptions): HTMLElement {
  const root = document.createElement('div');
  root.className = 'canvas';

  const total = opts.zones.reduce((n, z) => n + z.envelopes.length, 0);
  if (total === 0) {
    root.append(
      opts.emptyState
        ? opts.emptyState()
        : Object.assign(document.createElement('p'), {
            className: 'soft',
            textContent: 'No envelopes yet.',
          }),
    );
    return root;
  }

  for (const zone of opts.zones) {
    if (zone.envelopes.length === 0) continue;

    const section = document.createElement('section');
    section.className = 'zone';
    section.dataset.zone = zone.id;

    let headingId: string | undefined;
    if (zone.title) {
      headingId = `zone-${zone.id}-title`;
      const heading = document.createElement('h2');
      heading.className = 'zone-title';
      heading.textContent = zone.title;
      heading.id = headingId;
      section.append(heading);

      if (zone.caption) {
        const caption = document.createElement('p');
        caption.className = 'zone-caption';
        caption.textContent = zone.caption;
        section.append(caption);
      }
    }

    // Built unconditionally. An untitled zone is still a zone of tiles; an
    // earlier version nested this inside the title branch and rendered an
    // empty section for any group without a heading.
    const grid = document.createElement('div');
    grid.className = 'zone-grid';
    grid.setAttribute('role', 'list');
    if (headingId) {
      // Labelled by its heading, so a screen reader announces "Spoken for,
      // 3 items" rather than an anonymous list.
      grid.setAttribute('aria-labelledby', headingId);
    }
    for (const envelope of zone.envelopes) {
      const item = document.createElement('div');
      item.setAttribute('role', 'listitem');
      const selectable = opts.onSelect != null && (opts.isSelectable?.(envelope) ?? true);
      item.append(
        createEnvelopeTile({ envelope, onSelect: selectable ? opts.onSelect : undefined }),
      );
      grid.append(item);
    }
    section.append(grid);

    root.append(section);
  }

  return root;
}
