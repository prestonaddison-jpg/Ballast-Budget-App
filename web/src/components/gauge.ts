/**
 * Gauge done right (Blueprint A.5, A.7 "Few").
 *
 * A radial dial with a TARGET TICK ("where you should be") and good/watch/bad
 * QUALITATIVE BANDS. Never a bare arc — a bare value is weak; Stephen Few's
 * rule is that a dial needs a target plus qualitative ranges to mean anything.
 *
 * Used for: runway (months of buffer, net of obligations) and envelope /
 * reserve fill. This is Ballast's ONE signature element, so it is the only
 * place (with the Now-Bar pill) that spends the Praeclarus navy/gold.
 *
 * Accessibility: exposed as role="meter" with aria-valuetext, and the band a
 * value falls in is ALSO stated in text — meaning is never carried by color
 * alone (A.8).
 */

export type Tone = 'good' | 'watch' | 'bad';

export interface GaugeBand {
  /** Band start, in value units (inclusive). */
  from: number;
  /** Band end, in value units (exclusive, except the last band). */
  to: number;
  tone: Tone;
}

export interface GaugeOptions {
  value: number;
  max: number;
  min?: number;
  /** "Where you should be" — drawn as a tick on the arc. */
  target?: number;
  bands?: GaugeBand[];
  /** Short caption under the figure, e.g. "runway". */
  label: string;
  /** Renders the big centre figure. Defaults to one decimal place. */
  format?: (value: number) => string;
  /** Optional line under the label, e.g. "net of obligations". */
  sublabel?: string;
  /** Screen-reader description of what the number means. */
  describe?: (value: number, tone: Tone | null) => string;
}

const NS = 'http://www.w3.org/2000/svg';

/** Arc geometry: 270° sweep, bottom-left round to bottom-right. */
const START_DEG = 135;
const SWEEP_DEG = 270;
const CX = 100;
const CY = 100;
const R = 78;
const STROKE = 13;
const ARC_LEN = (SWEEP_DEG / 360) * 2 * Math.PI * R;

function polar(deg: number, radius = R): [number, number] {
  const rad = (deg * Math.PI) / 180;
  return [CX + radius * Math.cos(rad), CY + radius * Math.sin(rad)];
}

/** Fraction (0..1) of the way along the arc for a value. */
function fractionOf(value: number, min: number, max: number): number {
  if (max === min) return 0;
  return clamp01((value - min) / (max - min));
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** Path for a sub-arc between two fractions of the sweep. */
function arcPath(fromFrac: number, toFrac: number, radius = R): string {
  const a0 = START_DEG + clamp01(fromFrac) * SWEEP_DEG;
  const a1 = START_DEG + clamp01(toFrac) * SWEEP_DEG;
  const [x0, y0] = polar(a0, radius);
  const [x1, y1] = polar(a1, radius);
  const largeArc = a1 - a0 > 180 ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${radius} ${radius} 0 ${largeArc} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

function el<K extends keyof SVGElementTagNameMap>(
  name: K,
  attrs: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

export function toneOf(value: number, bands: GaugeBand[] | undefined): Tone | null {
  if (!bands || bands.length === 0) return null;
  for (let i = 0; i < bands.length; i++) {
    const b = bands[i];
    const last = i === bands.length - 1;
    if (value >= b.from && (last ? value <= b.to : value < b.to)) return b.tone;
  }
  return null;
}

const TONE_WORD: Record<Tone, string> = {
  good: 'healthy',
  watch: 'watch',
  bad: 'short',
};

const prefersReducedMotion = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export function createGauge(opts: GaugeOptions): HTMLElement {
  const min = opts.min ?? 0;
  const { max, bands, target } = opts;
  const value = opts.value;
  const fmt = opts.format ?? ((v: number) => v.toFixed(1));
  const tone = toneOf(value, bands);

  const wrap = document.createElement('div');
  wrap.className = 'gauge';

  const svg = el('svg', {
    viewBox: '0 0 200 182',
    class: 'gauge-svg',
    'aria-hidden': 'true',
    focusable: 'false',
  });

  // 1. Track — the empty portion of the meter.
  svg.appendChild(
    el('path', {
      d: arcPath(0, 1),
      class: 'g-track',
      fill: 'none',
      'stroke-width': STROKE,
      'stroke-linecap': 'round',
    }),
  );

  // 2. Qualitative bands — drawn as a thin ring OUTSIDE the track, so the
  //    thresholds are legible without competing with the value fill.
  if (bands && bands.length) {
    const bandR = R + STROKE / 2 + 5;
    for (const b of bands) {
      svg.appendChild(
        el('path', {
          d: arcPath(fractionOf(b.from, min, max), fractionOf(b.to, min, max), bandR),
          class: `g-band g-band-${b.tone}`,
          fill: 'none',
          'stroke-width': 4,
          'stroke-linecap': 'butt',
        }),
      );
    }
  }

  // 3. Value fill — stroke-dasharray sweep.
  const frac = fractionOf(value, min, max);
  const fill = el('path', {
    d: arcPath(0, 1),
    class: 'g-fill',
    fill: 'none',
    'stroke-width': STROKE,
    'stroke-linecap': 'round',
    'stroke-dasharray': `${ARC_LEN} ${ARC_LEN}`,
    'stroke-dashoffset': ARC_LEN,
  });
  svg.appendChild(fill);

  // 4. Target tick — "where you should be". A bare arc without this is
  //    exactly what the blueprint forbids.
  if (target != null) {
    const tf = fractionOf(target, min, max);
    const deg = START_DEG + tf * SWEEP_DEG;
    const [x0, y0] = polar(deg, R - STROKE / 2 - 3);
    const [x1, y1] = polar(deg, R + STROKE / 2 + 3);
    svg.appendChild(
      el('line', {
        x1: x0.toFixed(2),
        y1: y0.toFixed(2),
        x2: x1.toFixed(2),
        y2: y1.toFixed(2),
        class: 'g-target',
        'stroke-width': 3,
        'stroke-linecap': 'round',
      }),
    );
  }

  wrap.appendChild(svg);

  // 5. Centre readout.
  const centre = document.createElement('div');
  centre.className = 'gauge-centre';
  const figure = document.createElement('div');
  figure.className = 'gauge-figure';
  figure.textContent = fmt(value);
  const label = document.createElement('div');
  label.className = 'gauge-label';
  label.textContent = opts.label;
  centre.append(figure, label);
  if (opts.sublabel) {
    const sub = document.createElement('div');
    sub.className = 'gauge-sub';
    sub.textContent = opts.sublabel;
    centre.appendChild(sub);
  }
  wrap.appendChild(centre);

  // 6. Semantics. role="meter" carries the number; the tone is ALSO written
  //    out so the band is never communicated by color alone.
  const described = opts.describe
    ? opts.describe(value, tone)
    : `${fmt(value)} ${opts.label}${tone ? ` — ${TONE_WORD[tone]}` : ''}${
        target != null ? `, target ${fmt(target)}` : ''
      }`;
  wrap.setAttribute('role', 'meter');
  wrap.setAttribute('aria-valuenow', String(value));
  wrap.setAttribute('aria-valuemin', String(min));
  wrap.setAttribute('aria-valuemax', String(max));
  wrap.setAttribute('aria-valuetext', described);
  if (tone) wrap.dataset.tone = tone;

  // Visible, non-color statement of the band (A.8: never color alone).
  if (tone) {
    const badge = document.createElement('div');
    badge.className = 'gauge-tone';
    badge.dataset.tone = tone;
    badge.textContent = TONE_WORD[tone];
    wrap.appendChild(badge);
  }

  // 7. Sweep. ~560ms ease-out (A.5), skipped under reduced motion.
  const settle = () => {
    fill.setAttribute('stroke-dashoffset', String(ARC_LEN * (1 - frac)));
  };
  if (prefersReducedMotion()) {
    settle();
  } else {
    fill.style.transition = `stroke-dashoffset var(--t-gauge, 560ms) var(--ease-out, ease-out)`;
    requestAnimationFrame(() => requestAnimationFrame(settle));
  }

  return wrap;
}
