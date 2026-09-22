/**
 * One row of the Needs You queue (Blueprint §13).
 *
 * Structure mirrors the focal alert: a card, an amount, a route, and AT MOST
 * the actions that will actually work. Approve is drawn only when the source
 * currently covers the amount — a control the server is going to refuse is
 * worse than no control, because it fails after the operator has committed to
 * it rather than before.
 *
 * Dismiss is always available. Declining a suggestion is never blocked by the
 * balance, because declining moves nothing.
 */

import { presentProposal } from '../lib/proposal-copy';
import type { ApiProposal } from '../lib/api';

export interface ProposalCardHandlers {
  onApprove: (proposal: ApiProposal) => void;
  onDismiss: (proposal: ApiProposal) => void;
  onEdit: (proposal: ApiProposal) => void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export function createProposalCard(
  proposal: ApiProposal,
  handlers: ProposalCardHandlers,
): HTMLElement {
  const view = presentProposal(proposal);

  const card = el('section', 'proposal card');
  card.dataset.proposalId = proposal.id;
  card.dataset.affordability = view.affordability;

  card.append(el('div', 'label', view.kindLabel));

  const amount = el('div', 'proposal-amount', view.amountText);
  // The route is the sentence; the figure alone would read as a balance.
  amount.setAttribute('aria-label', `${view.amountText}, ${view.routeText}`);
  card.append(amount);

  card.append(el('div', 'proposal-route', view.routeText));

  if (view.memoText) card.append(el('p', 'soft proposal-memo', view.memoText));
  if (view.blockerText) {
    const blocker = el('p', 'proposal-blocker', view.blockerText);
    // Announced, because it is the reason Approve is not on the screen — and
    // a missing button with no explanation reads as a bug.
    blocker.setAttribute('role', 'status');
    card.append(blocker);
  }

  const actions = el('div', 'proposal-actions');

  // FIRST when the proposal no longer fits, because it is then the only move
  // that keeps the operator's intent — the alternative is declining something
  // they actually want. Last when it does fit, where approving is the point.
  const edit = el('button', 'btn-quiet', view.canApprove ? 'Change' : 'Change amount');
  edit.type = 'button';
  edit.setAttribute('aria-label', `Change the amount, ${view.amountText}, ${view.routeText}`);
  edit.addEventListener('click', () => handlers.onEdit(proposal));
  if (!view.canApprove) actions.append(edit);

  if (view.canApprove) {
    const approve = el('button', 'btn-primary', 'Approve');
    approve.type = 'button';
    approve.setAttribute('aria-label', `Approve ${view.amountText}, ${view.routeText}`);
    approve.addEventListener('click', () => handlers.onApprove(proposal));
    actions.append(approve);
  }

  if (view.canApprove) actions.append(edit);

  const dismiss = el('button', 'btn-quiet', 'Not now');
  dismiss.type = 'button';
  dismiss.setAttribute('aria-label', `Dismiss ${view.amountText}, ${view.routeText}`);
  dismiss.addEventListener('click', () => handlers.onDismiss(proposal));
  actions.append(dismiss);

  card.append(actions);
  return card;
}
