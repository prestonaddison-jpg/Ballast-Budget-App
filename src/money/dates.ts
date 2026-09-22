/**
 * Target-date validation, Worker side.
 *
 * A DELIBERATE DUPLICATE of the same rule in web/src/lib/due-date.ts, and the
 * duplication is the lesser evil: `src/` runs in workerd and `web/src/` is
 * bundled for the browser by a different build with a different tsconfig, so
 * one module cannot serve both without dragging a runtime boundary across the
 * repo. test/unit/date-validation.test.ts imports BOTH and asserts they agree
 * on the same table of inputs, so the copies cannot drift in silence.
 *
 * THE DEFECT THIS EXISTS FOR: the create route took `typeof body.targetDate
 * === 'string'` as validation, so "next tuesday" or "03/15/2026" was written
 * straight into the column. Nothing failed. The date simply never appeared on
 * screen again, because the reader cannot parse it — the operator set a
 * deadline, the app accepted it, and then quietly did not have it.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * True when `value` is a real calendar date in 'YYYY-MM-DD' form.
 *
 * Shape alone is not enough: '2026-02-30' and '2026-13-01' both match the
 * pattern and neither exists. Date() rolls them over silently into March 2nd
 * and January 2027, so a typo would become a confident wrong deadline.
 */
export function isValidDateString(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1) return false;
  // Day 0 of the NEXT month is the last day of this one.
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}
