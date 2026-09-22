/**
 * Change a proposal's amount before approving it (Blueprint §4: proposals are
 * EDITABLE).
 *
 * Why this exists, concretely: a $2,400 waterfall against $1,520 of free cash
 * is otherwise a dead end where the only available move is to decline
 * something the operator actually wants. Editing turns it into "approve the
 * part that fits".
 *
 * THE ONE THING THAT MAKES THIS DIFFERENT FROM THE FUND SHEET. The fund sheet
 * refuses an amount above what is unallocated, because it is about to commit
 * it. This sheet does NOT, because a proposal reserves nothing and the amount
 * on it is an intent. An operator who expects a deposit tomorrow is entitled
 * to leave $2,400 staged. The sheet says what is there and lets them decide;
 * the only check that decides anything is the one folded into approve.
 */

import { formatMoney, formatMoneyExact } from '../lib/envelope-math';
import { PARSE_MESSAGE, parseMoneyToMinor } from '../lib/money-input';
import { trapFocus } from '../lib/dialog-trap';
import { editSuggestions } from '../lib/proposal-copy';
import type { ApiProposal } from '../lib/api';

export interface ProposalEditSheetOptions {
  proposal: ApiProposal;
  /**
   * Commit the new amount. Resolving means the queue will be refreshed by the
   * caller; this sheet never adjusts a figure itself.
   */
  onConfirm: (amountMinor: number) => Promise<void>;
  onDismiss: () => void;
  /** True when a rejected onConfirm means the SERVER refused. */
  isRejection?: (err: unknown) => boolean;
}

export function createProposalEditSheet(opts: ProposalEditSheetOptions): HTMLElement {
  const { proposal } = opts;
  const source = proposal.sourceBalanceMinor;

  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';

  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-labelledby', 'edit-sheet-title');

  const title = document.createElement('h2');
  title.id = 'edit-sheet-title';
  title.className = 'sheet-title';
  title.textContent = `Change this amount`;

  const sub = document.createElement('p');
  sub.className = 'sheet-sub';
  // Never a figure the bank has not given us.
  sub.textContent =
    source == null
      ? `${proposal.from.name ?? 'The source'} hasn't reported a balance yet.`
      : `${formatMoneyExact(source)} in ${proposal.from.name ?? 'the source'}`;

  const amountLabel = document.createElement('label');
  amountLabel.className = 'sheet-field-label';
  amountLabel.htmlFor = 'edit-amount';
  amountLabel.textContent = 'Amount';

  const input = document.createElement('input');
  input.className = 'sheet-input money';
  input.type = 'text';
  // `decimal`, not `numeric`: iOS shows a keypad WITH a decimal point.
  input.inputMode = 'decimal';
  input.autocomplete = 'off';
  input.placeholder = '0.00';
  input.id = 'edit-amount';
  input.value = (proposal.amountMinor / 100).toFixed(2);

  const chips = document.createElement('div');
  chips.className = 'sheet-chips';
  for (const { amountMinor, label } of editSuggestions(proposal)) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.textContent = label;
    chip.setAttribute('aria-label', `${label}, ${formatMoney(amountMinor)}`);
    chip.addEventListener('click', () => {
      input.value = (amountMinor / 100).toFixed(2);
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
  confirm.textContent = 'Save amount';

  actions.append(cancel, confirm);

  const note = document.createElement('p');
  note.className = 'sheet-note soft';
  // Said out loud, because a sheet that takes an amount looks like one that
  // spends it. This one does not: saving changes a suggestion, nothing else.
  note.textContent = 'Saving changes the suggestion only. Nothing moves until you approve it.';

  input.addEventListener('input', () => {
    message.textContent = '';
    const parsed = parseMoneyToMinor(input.value);
    confirm.disabled = !parsed.ok;
  });

  confirm.addEventListener('click', async () => {
    const parsed = parseMoneyToMinor(input.value);
    if (!parsed.ok) {
      message.textContent = PARSE_MESSAGE[parsed.reason];
      return;
    }

    confirm.disabled = true;
    confirm.textContent = 'Saving…';
    try {
      await opts.onConfirm(parsed.minor);
    } catch (err) {
      // Unlike the fund sheet, BOTH branches here can safely say nothing
      // moved — because editing an amount cannot move money under any
      // outcome. What is uncertain is only whether the suggestion changed.
      message.textContent = opts.isRejection?.(err)
        ? "That didn't save. The suggestion is unchanged, and nothing moved."
        : "We couldn't confirm that saved. Nothing moved either way.";
      confirm.disabled = false;
      confirm.textContent = 'Save amount';
    }
  });

  sheet.append(title, sub, amountLabel, input, chips, message, actions, note);
  backdrop.append(sheet);

  trapFocus({ backdrop, sheet, onDismiss: opts.onDismiss });

  queueMicrotask(() => {
    input.focus();
    // The whole amount selected, so typing replaces rather than appends — the
    // common case is a different number, not an edit to this one.
    input.select();
  });
  return backdrop;
}
