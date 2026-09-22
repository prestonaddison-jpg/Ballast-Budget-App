/**
 * Due dates. PURE — no DOM, no `new Date()` without an explicit clock.
 *
 * Blueprint §13: "Setup uses one-tap relative chips... never date-typing", and
 * §14's copy rules: "'due in 3 days' / 'overdue 2d', never a red telling-off."
 * Externalising time is the point (Barkley 1997) — an obligation the operator
 * cannot see coming is one they will meet by accident or not at all.
 *
 * WHY CALENDAR DAYS AND NOT MILLISECONDS. A target date is 'YYYY-MM-DD' — a
 * day, not an instant. Subtracting timestamps and dividing by 86,400,000 gets
 * the answer wrong twice: once near midnight, where "tomorrow" is 4 hours away
 * and floor()s to 0, and again across a daylight-saving boundary, where a day
 * is 23 or 25 hours long. Both produce an off-by-one on a bill's due date,
 * which is exactly the kind of small lie that makes an operator stop trusting
 * the screen. So both sides are reduced to a local calendar day first.
 */

/** A bare 'YYYY-MM-DD', which is the only shape a target date may take. */
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * True when `value` is a real calendar date in 'YYYY-MM-DD' form.
 *
 * Shape alone is not enough: '2026-02-30' and '2026-13-01' both match the
 * pattern and neither exists. Date() would roll them over silently into March
 * 2nd and January 2027, so a typo would become a confident wrong deadline.
 */
export function isValidDateString(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1) return false;
  // Day 0 of the NEXT month is the last day of this one.
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Local midnight for a 'YYYY-MM-DD', or null if it is not a real date. */
function localMidnight(dateString: string): Date | null {
  if (!isValidDateString(dateString)) return null;
  const [y, m, d] = dateString.split('-').map(Number);
  // Month is 0-based here, and the local constructor is deliberate: the
  // operator's "March 15th" is their March 15th, not UTC's.
  return new Date(y, m - 1, d);
}

/**
 * Whole calendar days from `now` until `dateString`. Negative when overdue.
 *
 * Null when the date is unusable, so every caller has to decide what to show
 * rather than silently rendering NaN.
 */
export function daysUntil(
  dateString: string | null | undefined,
  now: Date = new Date(),
): number | null {
  if (dateString == null) return null;
  const target = localMidnight(dateString);
  if (!target) return null;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target.getTime() - today.getTime()) / 86_400_000);
}

/**
 * Calm due-date phrasing. No shame, no scolding, no red for ordinary states.
 *
 * "overdue 2d" is a fact about a date. "You're 2 days late" is a fact about a
 * person, and §14 is explicit that the second one is what makes people stop
 * opening the app.
 */
export function duePhrase(daysUntilDue: number): string {
  if (daysUntilDue === 0) return 'due today';
  if (daysUntilDue === 1) return 'due tomorrow';
  if (daysUntilDue > 1) return `due in ${daysUntilDue} days`;
  const overdue = Math.abs(daysUntilDue);
  return overdue === 1 ? 'overdue 1d' : `overdue ${overdue}d`;
}

/** As above, straight from the stored string. Null when there is no date. */
export function dueText(
  dateString: string | null | undefined,
  now: Date = new Date(),
): string | null {
  const days = daysUntil(dateString, now);
  return days == null ? null : duePhrase(days);
}

/**
 * How close is close. Drives emphasis, NOT colour on its own.
 *
 * 'soon' is a week out, which is the window in which an operator can still act
 * — move money, chase an invoice, reschedule. Further away than that it is
 * information, not a prompt.
 */
export type DueTone = 'past' | 'today' | 'soon' | 'later';

export function dueTone(daysUntilDue: number): DueTone {
  if (daysUntilDue < 0) return 'past';
  if (daysUntilDue === 0) return 'today';
  return daysUntilDue <= 7 ? 'soon' : 'later';
}

export interface DateChoice {
  /** What the chip says. */
  label: string;
  /** 'YYYY-MM-DD'. */
  value: string;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** 'YYYY-MM-DD' for a local Date — never toISOString(), which shifts to UTC. */
export function toDateString(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * One-tap relative choices, because §13 forbids making the operator type a
 * date. The last day of a month is computed as day 0 of the next one, so it is
 * right in February and in a leap year without a table of month lengths.
 */
export function relativeDateChoices(now: Date = new Date()): DateChoice[] {
  const plusDays = (n: number) => {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    d.setDate(d.getDate() + n);
    return d;
  };
  const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const endOfNextMonth = new Date(now.getFullYear(), now.getMonth() + 2, 0);

  const choices: DateChoice[] = [
    { label: 'End of month', value: toDateString(endOfMonth) },
    { label: 'In 30 days', value: toDateString(plusDays(30)) },
    { label: 'End of next month', value: toDateString(endOfNextMonth) },
    { label: 'In 90 days', value: toDateString(plusDays(90)) },
  ];

  // On the last day of a month "End of month" IS today, which reads as a
  // mistake on a form about a future obligation. Drop it rather than offer a
  // deadline that has already arrived.
  const todayString = toDateString(now);
  const deduped: DateChoice[] = [];
  for (const choice of choices) {
    if (choice.value === todayString) continue;
    if (deduped.some((c) => c.value === choice.value)) continue;
    deduped.push(choice);
  }
  return deduped;
}
