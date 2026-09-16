/**
 * Tap-to-fund sheet (Blueprint §13: "Tap-to-act primary, drag as an
 * enhancement").
 *
 * Opens from a tile tap and does ONE thing: move an amount from unallocated
 * into that envelope. It is deliberately not a general transfer builder —
 * Hick's law says one focal action per surface, and the general
 * move-between-any-two-envelopes case is a rarer operation that does not
 * deserve to complicate the common one.
 *
 * ADHD design notes that are requirements, not polish:
 *   - Quick-amount chips, so the common case is ONE tap and no typing (§13:
 *     "Setup uses one-tap relative chips... never date-typing" — the same
 *     principle applied to amounts).
 *   - The remaining-to-target amount is offered as a chip, because "fill it"
 *     is the thing the operator usually means.
 *   - No shame framing anywhere: the sheet says what is available, never what
 *     is missing.
 */

import { formatMoney, formatMoneyExact, type EnvelopeTileModel } from '../lib/envelope-math';
import { PARSE_MESSAGE, parseMoneyToMinor } from '../lib/money-input';
import { suggestAmounts } from '../lib/fund-suggest';

export { suggestAmounts };

export interface FundSheetOptions {
  envelope: EnvelopeTileModel;
  /** Spendable balance of unallocated, or null if unknown. */
  availableMinor: number | null;
  onConfirm: (amountMinor: number) => Promise<void>;
  onDismiss: () => void;
  /**
   * True when a rejected `onConfirm` means the SERVER refused — as opposed to
   * the request never completing. Injected rather than imported so this
   * component stays free of the API client, and so the distinction is
   * explicit at the call site instead of assumed here.
   */
  isRejection?: (err: unknown) => boolean;
}

export function createFundSheet(opts: FundSheetOptions): HTMLElement {
  const { envelope, availableMinor } = opts;

  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';

  const sheet = document.createElement('div');
  // NOT `sheet card`. A card may be translucent; a dialog with live content
  // behind it may not. .sheet carries its own opaque surface.
  sheet.className = 'sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-labelledby', 'fund-sheet-title');

  const title = document.createElement('h2');
  title.id = 'fund-sheet-title';
  title.className = 'sheet-title';
  title.textContent = `Fund ${envelope.name}`;

  const sub = document.createElement('p');
  sub.className = 'sheet-sub';
  sub.textContent =
    availableMinor == null
      ? // The "green but dead" rule: never invent a number the bank has not given.
        'Waiting on your bank for an available balance.'
      : `${formatMoneyExact(availableMinor)} unallocated`;

  const input = document.createElement('input');
  input.className = 'sheet-input money';
  input.type = 'text';
  // `decimal` rather than `numeric`: iOS shows a keypad WITH a decimal point.
  input.inputMode = 'decimal';
  input.autocomplete = 'off';
  input.placeholder = '0.00';
  input.setAttribute('aria-label', `Amount to move into ${envelope.name}`);

  const chips = document.createElement('div');
  chips.className = 'sheet-chips';
  for (const amount of suggestAmounts(
    availableMinor,
    envelope.balanceMinor,
    envelope.targetMinor,
  )) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.textContent = formatMoney(amount);
    chip.addEventListener('click', () => {
      input.value = (amount / 100).toFixed(2);
      input.dispatchEvent(new Event('input'));
      input.focus();
    });
    chips.append(chip);
  }

  const message = document.createElement('p');
  message.className = 'sheet-message';
  message.setAttribute('role', 'alert');

  const actions = document.createElement('div');
  actions.className = 'sheet-actions';

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn-quiet';
  cancel.textContent = 'Not now';
  cancel.addEventListener('click', () => opts.onDismiss());

  const confirm = document.createElement('button');
  confirm.type = 'button';
  confirm.className = 'btn-primary';
  confirm.textContent = 'Set it aside';
  confirm.disabled = availableMinor == null;

  actions.append(cancel, confirm);

  input.addEventListener('input', () => {
    message.textContent = '';
    const parsed = parseMoneyToMinor(input.value);
    confirm.disabled = !parsed.ok || availableMinor == null;
  });

  confirm.addEventListener('click', async () => {
    const parsed = parseMoneyToMinor(input.value);
    if (!parsed.ok) {
      message.textContent = PARSE_MESSAGE[parsed.reason];
      return;
    }
    if (availableMinor != null && parsed.minor > availableMinor) {
      // Stated as what IS available, not as what the operator got wrong.
      message.textContent = `There's ${formatMoneyExact(availableMinor)} unallocated.`;
      return;
    }

    confirm.disabled = true;
    confirm.textContent = 'Setting aside…';
    try {
      await opts.onConfirm(parsed.minor);
    } catch (err) {
      // "Nothing moved" is a CLAIM, and only one of these two cases supports
      // it. If the server answered, it answered by refusing, so nothing moved.
      // If the request simply never came back, the move may well have landed —
      // saying otherwise would be the app's own numbers lying to the operator,
      // which is the one thing it exists not to do.
      message.textContent = opts.isRejection?.(err)
        ? "That didn't go through. Nothing moved."
        : "We couldn't confirm that. Check the envelope before trying again.";
      confirm.disabled = false;
      confirm.textContent = 'Set it aside';
    }
  });

  sheet.append(title, sub, input, chips, message, actions);
  backdrop.append(sheet);

  // Dismiss on backdrop tap, but never on a tap inside the sheet.
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) opts.onDismiss();
  });
  backdrop.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Escape') opts.onDismiss();
  });

  queueMicrotask(() => input.focus());
  return backdrop;
}
