/**
 * Focal-alert card (Blueprint A.5, §13 "The Needs You inbox").
 *
 * Von Restorff isolation: ONE emphasized thing per screen. This renders the
 * Needs You "do this next" — an implementation-intention (Gollwitzer &
 * Sheeran 2006, d=.65): a concrete action with a concrete when, one tap to
 * commit.
 *
 * Copy rules (§14 guardrails): no shame, no scolding, no red warnings for
 * ordinary states. "$180 over in Fuel this month", never "you overspent".
 * "due in 3 days" / "overdue 2d", never a red telling-off.
 */

export type AlertTone = 'good' | 'watch' | 'bad' | 'neutral';

export interface FocalAlert {
  /** The concrete action, phrased as a thing to do. */
  title: string;
  /** The concrete when / context. */
  detail?: string;
  /** Label for the single tap. Only rendered when `onAction` is supplied. */
  action: string;
  tone?: AlertTone;
  onAction?: () => void;
}

/**
 * Calm due-date phrasing. Externalizes time (Barkley 1997) without scolding.
 */
export function duePhrase(daysUntil: number): string {
  if (daysUntil === 0) return 'due today';
  if (daysUntil === 1) return 'due tomorrow';
  if (daysUntil > 1) return `due in ${daysUntil} days`;
  const overdue = Math.abs(daysUntil);
  return overdue === 1 ? 'overdue 1d' : `overdue ${overdue}d`;
}

export function createFocalAlert(alert: FocalAlert): HTMLElement {
  const card = document.createElement('section');
  card.className = 'needs card';
  card.dataset.tone = alert.tone ?? 'neutral';

  const dot = document.createElement('span');
  dot.className = 'd';
  dot.setAttribute('aria-hidden', 'true');

  const txt = document.createElement('div');
  txt.className = 'txt';
  const strong = document.createElement('strong');
  strong.textContent = alert.title;
  txt.appendChild(strong);
  if (alert.detail) {
    const span = document.createElement('span');
    span.textContent = alert.detail;
    txt.appendChild(span);
  }

  card.append(dot, txt);

  // ONLY when there is something to do. An action button wired to nothing is
  // worse than no button: this card is the one Von Restorff element on the
  // screen, so a dead control here is the app's most prominent broken promise,
  // and it teaches the operator that tapping things does not work.
  if (alert.onAction) {
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'go';
    go.textContent = alert.action;
    // The accessible name carries the whole intention, not just "Review".
    go.setAttribute('aria-label', `${alert.action}: ${alert.title}`);
    go.addEventListener('click', alert.onAction);
    card.append(go);
  }

  return card;
}
