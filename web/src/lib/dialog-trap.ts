/**
 * Modal containment for a sheet: Escape, backdrop tap, and a real focus trap.
 *
 * Extracted because it is subtle and there is now more than one sheet.
 * `aria-modal="true"` TELLS assistive technology that the rest of the page is
 * unavailable — without containment that is simply false, and Tab walks the
 * operator out into a Canvas their screen reader has been told is not there.
 * A second hand-written copy of this would eventually differ from the first,
 * and the difference would be invisible to anyone not using a keyboard.
 */

export interface DialogTrapOptions {
  /** The full-screen element behind the dialog. Tapping it dismisses. */
  backdrop: HTMLElement;
  /** The dialog itself. Focus is kept inside this. */
  sheet: HTMLElement;
  onDismiss: () => void;
}

export function trapFocus({ backdrop, sheet, onDismiss }: DialogTrapOptions): void {
  // Dismiss on backdrop tap, but never on a tap inside the sheet.
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) onDismiss();
  });

  backdrop.addEventListener('keydown', (e) => {
    const ev = e as KeyboardEvent;
    if (ev.key === 'Escape') {
      onDismiss();
      return;
    }
    if (ev.key !== 'Tab') return;

    // Recomputed per keypress, because a sheet's controls come and go — chips,
    // a complete button, a primary action that disables itself mid-request.
    const focusable = [
      ...sheet.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)'),
    ].filter((el) => el.offsetParent !== null);
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;

    if (ev.shiftKey && (active === first || !sheet.contains(active))) {
      ev.preventDefault();
      last.focus();
    } else if (!ev.shiftKey && active === last) {
      ev.preventDefault();
      first.focus();
    }
  });
}
