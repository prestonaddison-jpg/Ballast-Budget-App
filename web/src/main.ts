/**
 * Ballast PWA shell — Phase 0.
 *
 * This is the skeleton: theme system, the five adopted components, the Now-Bar,
 * and an honest connection state fed by the Worker.
 *
 * DELIBERATE ABSENCE: there are no placeholder balances. The money model
 * (envelopes, ledger, conservation invariant) lands in Slice 1. Until then the
 * shell renders EMPTY STATES, never invented numbers — a fabricated "safe to
 * spend" in a cash-allocation app is the same dangerous lie as a stale sync,
 * and it would be the first thing to teach the operator to distrust the hero
 * figure (§14).
 */

import {
  initTheme,
  watchSystemTheme,
  applyTheme,
  readPreference,
  type ThemePreference,
} from './lib/theme';
import { api, envelopeApi, ApiError, type EnvelopesResponse, type MeResponse } from './lib/api';
import { createZoneGrid } from './components/zone-grid';
import { groupIntoZones } from './lib/zones';
import { createFundSheet } from './components/fund-sheet';
import { formatMoney, type EnvelopeTileModel } from './lib/envelope-math';
import { createGauge } from './components/gauge';
import { createFocalAlert } from './components/focal-alert';
import { createFreshness, computeFreshness } from './components/freshness';
import { createCollapsible } from './components/collapsible';
import { createNowBar, type NavKey } from './components/nowbar';

export const VERSION = '0.1.0-phase0';

const app = document.getElementById('app')!;

function clear(node: HTMLElement) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/* -------------------------------------------------------------------------
 * Signed-out view
 * ---------------------------------------------------------------------- */

function renderLogin(onSuccess: () => void) {
  clear(app);

  const scroll = h('div', 'scroll');
  const body = h('div', 'body');

  const hero = h('div', 'hero');
  hero.append(h('div', 'safe-label', 'Ballast'), h('div', 'safe-figure', '⚓'));
  hero.append(h('div', 'safe-sub', 'Praeclarus Ventures'));

  const form = h('form', 'card vitals');
  form.setAttribute('novalidate', '');

  const title = h('h2', undefined, 'Sign in');
  title.style.marginBottom = '12px';

  const emailLabel = h('label', 'label', 'Email');
  emailLabel.htmlFor = 'email';
  const email = h('input');
  email.id = 'email';
  email.type = 'email';
  email.autocomplete = 'username';
  email.required = true;

  const pwLabel = h('label', 'label', 'Password');
  pwLabel.htmlFor = 'password';
  const password = h('input');
  password.id = 'password';
  password.type = 'password';
  password.autocomplete = 'current-password';
  password.required = true;

  for (const input of [email, password]) {
    input.style.cssText =
      'width:100%;min-height:var(--tap);padding:10px 12px;margin:6px 0 14px;' +
      'border:1px solid var(--cardln);border-radius:10px;background:transparent;' +
      'color:var(--ink);font:inherit';
  }

  const submit = h('button', undefined, 'Sign in');
  submit.type = 'submit';
  submit.style.cssText =
    'width:100%;min-height:var(--tap);border:0;border-radius:99px;cursor:pointer;' +
    'background:var(--sig-ground);color:var(--sig-ink);font:inherit;font-weight:700';

  const error = h('p', 'soft');
  error.setAttribute('role', 'alert');
  error.style.cssText = 'color:var(--bad);font-size:.85rem;min-height:1.2em;margin:10px 0 0';

  form.append(title, emailLabel, email, pwLabel, password, submit, error);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.textContent = '';
    submit.disabled = true;
    submit.textContent = 'Signing in…';
    try {
      await api.login(email.value, password.value);
      onSuccess();
    } catch (err) {
      // Never distinguish "no such user" from "wrong password" in the UI.
      error.textContent =
        err instanceof ApiError && err.status === 429
          ? 'Too many attempts. Try again shortly.'
          : 'That email and password did not match.';
      submit.disabled = false;
      submit.textContent = 'Sign in';
    }
  });

  body.append(form);
  scroll.append(hero, body);
  app.append(scroll);
  email.focus();
}

/* -------------------------------------------------------------------------
 * Signed-in shell
 * ---------------------------------------------------------------------- */

function openFundSheet(
  entityId: string,
  unallocatedId: string,
  envelope: EnvelopeTileModel,
  availableMinor: number | null,
  me: MeResponse,
) {
  // A key per ATTEMPT, so a retry after a dropped response cannot allocate a
  // second time. Generated here rather than in the API client because the
  // client cannot tell a retry from a deliberate second transfer.
  const idempotencyKey = crypto.randomUUID();

  const sheet = createFundSheet({
    envelope,
    availableMinor,
    onDismiss: () => sheet.remove(),
    onConfirm: async (amountMinor) => {
      await envelopeApi.transfer(entityId, {
        fromEnvelopeId: unallocatedId,
        toEnvelopeId: envelope.id,
        amountMinor,
        idempotencyKey,
      });
      sheet.remove();
      const money = await loadMoney(me);
      renderShell(me, money);
    },
  });
  document.body.append(sheet);
}

/** Loads the money model for the first entity, or null if there is none. */
async function loadMoney(me: MeResponse): Promise<EnvelopesResponse | null> {
  const entity = me.entities[0];
  if (!entity) return null;
  try {
    return await envelopeApi.list(entity.id);
  } catch {
    // A failed money load must not blank the whole shell: the connection
    // state and the Needs You alert are still worth showing.
    return null;
  }
}

function renderShell(me: MeResponse, money: EnvelopesResponse | null) {
  clear(app);

  const connected = me.connections.length > 0;
  const worst =
    me.connections.find((c) => c.status === 'reauth_required') ??
    me.connections.find((c) => c.status === 'pending_disconnect') ??
    me.connections[0];

  const scroll = h('div', 'scroll');
  const body = h('div', 'body');

  /* --- Hero: "safe to spend" is the honest hero number (§14) ------------ */
  const hero = h('div', 'hero');
  hero.append(h('div', 'safe-label', 'Safe to spend'));

  const figure = h('div', 'safe-figure');
  const sub = h('div', 'safe-sub');

  if (!connected) {
    figure.textContent = '—';
    sub.textContent = 'Connect an account to see real figures.';
  } else if (money == null) {
    figure.textContent = '—';
    sub.textContent = 'Loading…';
  } else if (money.safeToSpendMinor == null) {
    // The "green but dead" rule applied to the hero. If the bank has not said
    // what is available, the honest answer is that we do not know — NEVER a
    // confident figure computed from stale cash.
    figure.textContent = '—';
    sub.textContent = "Your bank hasn't reported an available balance.";
  } else {
    figure.textContent = formatMoney(money.safeToSpendMinor);
    sub.textContent = 'Everything else already has a job.';
  }
  hero.append(figure, sub);

  if (worst) {
    hero.append(
      createFreshness({
        lastSyncedAt: worst.lastSyncedAt ? Date.parse(worst.lastSyncedAt) : null,
        connection: worst.status,
      }),
    );
  } else {
    hero.append(createFreshness({ lastSyncedAt: null, connection: 'never' }));
  }

  /* --- Focal alert: the ONE "do this next" (Von Restorff) --------------- */
  const reauth = me.connections.find((c) => c.status === 'reauth_required');
  if (reauth) {
    body.append(
      createFocalAlert({
        title: `Reconnect ${reauth.institutionName ?? 'your bank'}`,
        detail: 'Your bank needs a fresh sign-in before new activity shows up.',
        action: 'Reconnect',
        tone: 'bad',
      }),
    );
  } else if (!connected) {
    body.append(
      createFocalAlert({
        title: 'Connect your first business account',
        detail: 'Ballast reads balances and transactions. It never moves money.',
        action: 'Connect',
        tone: 'watch',
      }),
    );
  }

  /* --- Over-allocation, stated plainly ---------------------------------- */
  if (money && money.overAllocatedMinor > 0) {
    const notice = h('div', 'over-allocated');
    notice.append(
      document.createTextNode('Allocations are '),
      Object.assign(document.createElement('strong'), {
        textContent: formatMoney(money.overAllocatedMinor),
      }),
      document.createTextNode(
        ' above the cash actually available. Nothing is wrong with your envelopes — the bank balance moved. Free some up when you can.',
      ),
    );
    body.append(notice);
  }

  /* --- The Canvas: envelope tiles in a zone grid (§13) ------------------- */
  if (money && money.envelopes.length > 0) {
    const tiles: EnvelopeTileModel[] = money.envelopes.map((e) => ({
      id: e.id,
      name: e.name,
      type: e.type,
      balanceMinor: e.balanceMinor ?? 0,
      targetMinor: e.targetMinor,
      targetDate: e.targetDate,
      currency: 'USD',
    }));

    const unallocated = money.envelopes.find((e) => e.type === 'unallocated');

    body.append(
      createZoneGrid({
        zones: groupIntoZones(tiles),
        onSelect: (envelope) => {
          // Tapping unallocated is not a fund action — it IS the source.
          if (envelope.type === 'unallocated' || !unallocated) return;
          openFundSheet(money.entityId, unallocated.id, envelope, money.safeToSpendMinor, me);
        },
      }),
    );
  }

  /* --- Grouped vitals: entities + connections (A.6: one grouped unit) --- */
  const vitals = h('section', 'card vitals');
  vitals.append(h('div', 'label', 'Entities'));

  if (me.entities.length === 0) {
    vitals.append(
      h('p', 'soft', 'No entities yet. Each linked account is tagged to one entity and its state.'),
    );
  } else {
    for (const ent of me.entities) {
      const row = h('div');
      row.style.cssText =
        'display:flex;justify-content:space-between;align-items:center;min-height:var(--tap)';
      row.append(h('span', undefined, ent.name), h('span', 'soft num', ent.state));
      vitals.append(row);
    }
  }

  vitals.append(h('div', 'rule'));

  const connSummary = h('div', 'duo');
  const left = h('div');
  left.append(h('div', 'label', 'Accounts'));
  left.append(h('div', 'soil'));
  const accountsNum = h('div', 'num');
  accountsNum.style.cssText =
    'font-family:var(--display);font-weight:700;font-size:1.9rem;letter-spacing:-.03em';
  accountsNum.textContent = String(me.connections.reduce((n, c) => n + c.accountCount, 0));
  left.append(accountsNum);

  const sep = h('div', 'vsep');

  const right = h('div');
  right.append(h('div', 'label', 'Connections'));
  const connNum = h('div', 'num');
  connNum.style.cssText =
    'font-family:var(--display);font-weight:700;font-size:1.9rem;letter-spacing:-.03em';
  connNum.textContent = String(me.connections.length);
  right.append(connNum);

  connSummary.append(left, sep, right);
  vitals.append(connSummary);

  /* --- Progressive disclosure: the detail nobody needs by default ------- */
  vitals.append(
    createCollapsible({
      summary: 'Connection detail',
      body: () => {
        const wrap = h('div');
        if (me.connections.length === 0) {
          wrap.append(h('p', undefined, 'Nothing connected yet.'));
          return wrap;
        }
        for (const c of me.connections) {
          const row = h('div');
          row.style.cssText = 'display:flex;justify-content:space-between;gap:12px;padding:6px 0';
          row.append(h('span', undefined, c.institutionName ?? c.itemId));
          const f = computeFreshness({
            lastSyncedAt: c.lastSyncedAt ? Date.parse(c.lastSyncedAt) : null,
            connection: c.status,
          });
          row.append(h('span', 'soft', f.text));
          wrap.append(row);
        }
        return wrap;
      },
    }),
  );

  body.append(vitals);

  /* --- Settings-ish: theme toggle --------------------------------------- */
  const themeCard = h('section', 'card vitals');
  themeCard.append(h('div', 'label', 'Appearance'));
  const group = h('div');
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-label', 'Theme');
  group.style.cssText = 'display:flex;gap:8px;margin-top:10px;flex-wrap:wrap';

  const options: Array<{ value: ThemePreference; label: string }> = [
    { value: 'system', label: 'System' },
    { value: 'atelier', label: 'Atelier · light' },
    { value: 'graphite', label: 'Graphite · dark' },
  ];
  const current = readPreference();
  for (const opt of options) {
    const b = h('button', undefined, opt.label);
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(opt.value === current));
    b.style.cssText =
      'min-height:var(--tap);padding:8px 14px;border-radius:99px;cursor:pointer;font:inherit;' +
      `border:1px solid ${opt.value === current ? 'var(--accent)' : 'var(--cardln)'};` +
      'background:transparent;color:var(--ink)';
    b.addEventListener('click', () => {
      applyTheme(opt.value);
      renderShell(me, money);
    });
    group.append(b);
  }
  themeCard.append(group);
  body.append(themeCard);

  const foot = h('p', 'soft');
  foot.style.cssText = 'font-size:.75rem;text-align:center;padding:8px 0 4px';
  foot.textContent = `Ballast ${VERSION} · read-only · never moves money`;
  body.append(foot);

  scroll.append(hero, body);

  /* --- Now-Bar: 4 destinations + the one living status pill ------------- */
  const pill = reauth
    ? { text: 'Reconnect a bank', status: 'bad' as const }
    : !connected
      ? { text: 'Connect an account', status: 'watch' as const }
      : { text: 'Nothing needs you', status: 'good' as const };

  const nav = createNowBar({
    active: 'canvas' as NavKey,
    pill,
  });

  app.append(scroll, nav);
}

/* -------------------------------------------------------------------------
 * Boot
 * ---------------------------------------------------------------------- */

function renderFatal(message: string) {
  clear(app);
  const scroll = h('div', 'scroll');
  const body = h('div', 'body');
  const card = h('section', 'card vitals');
  card.append(h('h2', undefined, "Can't reach Ballast"));
  card.append(h('p', 'soft', message));
  body.append(card);
  scroll.append(body);
  app.append(scroll);
}

async function boot() {
  initTheme();
  watchSystemTheme(() => {});

  try {
    const me = await api.me();
    const money = await loadMoney(me);
    renderShell(me, money);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      renderLogin(() => void boot());
    } else {
      renderFatal(
        err instanceof ApiError
          ? err.message
          : 'The app is offline, or the server is not responding. Your data is untouched.',
      );
    }
  }
}

void boot();

/* -------------------------------------------------------------------------
 * Service worker
 * ---------------------------------------------------------------------- */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    // Absolute path: a relative register('sw.js') from a nested route resolves
    // to /nested/sw.js and 404s, and the default scope is the directory the
    // script was served from.
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
      // Non-fatal — the app works without offline support.
    });
  });

  // The service worker calls skipWaiting() + clients.claim(), which means a
  // freshly-activated worker can end up controlling a page running the OLD
  // bundle — and on standalone iOS there is no address bar, so the operator
  // cannot hard-refresh their way out of it. Reload exactly once when control
  // changes. The guard matters: without it, claim() during the initial
  // registration would reload the page on every first visit.
  // `reloading` alone is a fire-once guard, not a "was this page already
  // controlled" guard — so on the FIRST install, clients.claim() changes the
  // controller and reloads the page, which is exactly the case this is meant
  // to avoid. Capture whether a controller existed at registration time.
  const wasControlled = navigator.serviceWorker.controller !== null;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!wasControlled || reloading) return;
    reloading = true;
    window.location.reload();
  });
}

/**
 * Ask for storage persistence once installed.
 *
 * Home Screen web apps are already exempt from ITP's 7-day eviction, so this
 * is defence in depth rather than the fix — but it costs nothing and protects
 * the shell cache if the app is opened from a Safari tab instead.
 */
if (navigator.storage?.persist) {
  const installed =
    (navigator as Navigator & { standalone?: boolean }).standalone === true ||
    matchMedia('(display-mode: standalone)').matches;
  if (installed) void navigator.storage.persist().catch(() => {});
}
