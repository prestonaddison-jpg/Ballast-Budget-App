/**
 * Ballast PWA — shell, router and views.
 *
 * Four destinations, all real: Canvas (the envelope grid and tap-to-fund),
 * Needs You, Accounts and Settings. The Now-Bar drives them.
 *
 * TWO RULES THAT RUN THROUGH EVERY VIEW:
 *
 * 1. NEVER INVENT A NUMBER. A balance we could not fetch, or that the bank has
 *    not reported, renders as an em dash and says why — never as 0, and never
 *    as a stale figure presented as current. A fabricated "safe to spend" in a
 *    cash-allocation app is the same dangerous lie as a stale sync (§14).
 *
 * 2. NEVER RENDER A DEAD CONTROL. If there is nothing behind a button it is not
 *    drawn. The focal alert omits its action when no flow exists yet; a tile
 *    with no handler renders as a plain element rather than a disabled button.
 *    One control that does nothing teaches the operator that none of them work.
 *
 * The gauge component is deliberately NOT imported: it is Slice 3's runway
 * meter, and there is no runway figure to draw yet.
 */

import {
  initTheme,
  watchSystemTheme,
  applyTheme,
  readPreference,
  type ThemePreference,
} from './lib/theme';
import {
  api,
  envelopeApi,
  ApiError,
  type ApiEnvelope,
  type EnvelopesResponse,
  type MeResponse,
} from './lib/api';
import { PARSE_MESSAGE, parseMoneyToMinor } from './lib/money-input';
import { createZoneGrid } from './components/zone-grid';
import { groupIntoZones } from './lib/zones';
import { createFundSheet } from './components/fund-sheet';
import { formatMoney, type EnvelopeTileModel } from './lib/envelope-math';
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
 * App state + router
 *
 * One state object, one render(). The Now-Bar's four destinations are real
 * views: an app whose primary navigation does nothing is not a shell, it is a
 * screenshot.
 * ---------------------------------------------------------------------- */

/**
 * The money model is THREE states, not two.
 *
 * `null` used to mean both "no entity yet" and "the request failed", and the
 * shell rendered both as a permanent "Loading…" under a green "Nothing needs
 * you" pill — the app confidently reporting all-clear about figures it had
 * failed to fetch. That is the same class of lie as a stale balance shown as
 * fresh, and it is the one thing this app exists not to do.
 */
type MoneyState =
  | { status: 'ok'; data: EnvelopesResponse }
  | { status: 'none' }
  | { status: 'error'; message: string };

interface AppState {
  me: MeResponse;
  view: NavKey;
  /** Which entity the Canvas is showing. Entities never commingle (§3). */
  entityId: string | null;
  money: MoneyState;
}

let state: AppState | null = null;

async function loadMoney(entityId: string | null): Promise<MoneyState> {
  if (!entityId) return { status: 'none' };
  try {
    return { status: 'ok', data: await envelopeApi.list(entityId) };
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) throw err;
    return {
      status: 'error',
      message:
        err instanceof ApiError
          ? err.message
          : "Couldn't reach Ballast. Your figures are untouched.",
    };
  }
}

/** Re-fetch the current entity and repaint. */
async function refresh() {
  if (!state) return;
  try {
    state.money = await loadMoney(state.entityId);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return void boot();
    throw err;
  }
  render();
}

function go(view: NavKey) {
  if (!state) return;
  state.view = view;
  render();
}

/* -------------------------------------------------------------------------
 * Tap-to-fund
 * ---------------------------------------------------------------------- */

function openFundSheet(entityId: string, unallocatedId: string, envelope: EnvelopeTileModel) {
  // ONE KEY PER AMOUNT, not one per sheet.
  //
  // A single key for the whole sheet made a retry at a DIFFERENT amount
  // collide with the first attempt's key: the server correctly answered
  // "duplicate", the client read that as success, and the operator was told
  // their $50 had moved when what actually moved was the $200 they had
  // already given up on. Keyed by amount, a retry of the same amount is
  // idempotent and a changed amount is what it actually is — a new request.
  const keys = new Map<number, string>();

  const sheet = createFundSheet({
    envelope,
    availableMinor: unallocatedBalance(),
    onDismiss: () => close(),
    // An ApiError means the Worker replied, and it replied by refusing. Any
    // other rejection is a request that never came back, whose outcome we do
    // not know.
    isRejection: (err) => err instanceof ApiError,
    onConfirm: async (amountMinor) => {
      let key = keys.get(amountMinor);
      if (!key) {
        key = crypto.randomUUID();
        keys.set(amountMinor, key);
      }
      await envelopeApi.transfer(entityId, {
        fromEnvelopeId: unallocatedId,
        toEnvelopeId: envelope.id,
        amountMinor,
        idempotencyKey: key,
      });
      close();
      await refresh();
      announce(`${formatMoney(amountMinor)} set aside for ${envelope.name}.`);
    },
    // Offered only where it means something: an envelope with money in it that
    // is not the residual. Absent, rather than dead, everywhere else.
    onComplete:
      envelope.type === 'unallocated'
        ? undefined
        : async () => {
            const { sweptMinor } = await envelopeApi.complete(entityId, envelope.id);
            close();
            await refresh();
            announce(
              sweptMinor > 0
                ? `${envelope.name} closed. ${formatMoney(sweptMinor)} went back to unallocated.`
                : `${envelope.name} closed.`,
            );
          },
  });

  // Focus restore: whatever opened the sheet gets focus back when it closes,
  // so a keyboard or switch user is not dumped at the top of the document.
  const opener = document.activeElement as HTMLElement | null;
  function close() {
    sheet.remove();
    opener?.focus?.();
  }

  document.body.append(sheet);
}

/**
 * New-envelope sheet.
 *
 * Without this the Canvas could only ever show envelopes someone had inserted
 * into D1 by hand — which made the whole money model unreachable from the app
 * that is supposed to be its only interface.
 */
function openNewEnvelopeSheet(entityId: string) {
  const backdrop = h('div', 'sheet-backdrop');
  const sheet = h('div', 'sheet');
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-labelledby', 'new-env-title');

  const title = h('h2', 'sheet-title', 'New envelope');
  title.id = 'new-env-title';

  const nameLabel = h('label', 'sheet-field-label', 'Name');
  nameLabel.htmlFor = 'new-env-name';
  const name = h('input', 'sheet-input');
  name.id = 'new-env-name';
  name.type = 'text';
  name.autocomplete = 'off';
  name.placeholder = 'Alignment rack';
  name.maxLength = 80;

  const typeLabel = h('div', 'sheet-field-label', 'What kind');
  const types = h('div', 'sheet-chips');
  types.setAttribute('role', 'radiogroup');
  types.setAttribute('aria-label', 'Envelope kind');
  // 'unallocated' is deliberately absent: it is the residual, created with the
  // entity, and a second one would make the invariant ambiguous.
  const KINDS: Array<{ value: ApiEnvelope['type']; label: string }> = [
    { value: 'tax', label: 'Tax' },
    { value: 'buffer', label: 'Buffer' },
    { value: 'save', label: 'Save' },
    { value: 'spend', label: 'Spend' },
  ];
  let kind: ApiEnvelope['type'] = 'save';
  const kindButtons: HTMLButtonElement[] = [];
  for (const k of KINDS) {
    const b = h('button', 'chip', k.label);
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(k.value === kind));
    b.addEventListener('click', () => {
      kind = k.value;
      for (const other of kindButtons) {
        other.setAttribute('aria-checked', String(other === b));
        other.classList.toggle('is-on', other === b);
      }
    });
    b.classList.toggle('is-on', k.value === kind);
    kindButtons.push(b);
    types.append(b);
  }

  const targetLabel = h('label', 'sheet-field-label', 'Target (optional)');
  targetLabel.htmlFor = 'new-env-target';
  const target = h('input', 'sheet-input money');
  target.id = 'new-env-target';
  target.type = 'text';
  target.inputMode = 'decimal';
  target.autocomplete = 'off';
  target.placeholder = '0.00';

  const message = h('p', 'sheet-message');
  message.setAttribute('role', 'alert');

  const actions = h('div', 'sheet-actions');
  const cancel = h('button', 'btn-quiet', 'Not now');
  cancel.type = 'button';
  const create = h('button', 'btn-primary', 'Create it');
  create.type = 'button';
  actions.append(cancel, create);

  const opener = document.activeElement as HTMLElement | null;
  const close = () => {
    backdrop.remove();
    opener?.focus?.();
  };
  cancel.addEventListener('click', close);

  create.addEventListener('click', async () => {
    const trimmed = name.value.trim();
    if (!trimmed) {
      message.textContent = 'Give it a name so you recognise it on the Canvas.';
      name.focus();
      return;
    }
    let targetMinor: number | null = null;
    if (target.value.trim()) {
      const parsed = parseMoneyToMinor(target.value);
      if (!parsed.ok) {
        message.textContent = PARSE_MESSAGE[parsed.reason];
        target.focus();
        return;
      }
      targetMinor = parsed.minor;
    }

    create.disabled = true;
    create.textContent = 'Creating…';
    try {
      await envelopeApi.create(entityId, { name: trimmed, type: kind, targetMinor });
      close();
      await refresh();
      announce(`${trimmed} added.`);
    } catch (err) {
      message.textContent =
        err instanceof ApiError ? err.message : "We couldn't confirm that. Try again.";
      create.disabled = false;
      create.textContent = 'Create it';
    }
  });

  sheet.append(title, nameLabel, name, typeLabel, types, targetLabel, target, message, actions);
  backdrop.append(sheet);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  backdrop.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Escape') close();
  });
  document.body.append(backdrop);
  queueMicrotask(() => name.focus());
}

function unallocatedBalance(): number | null {
  if (state?.money.status !== 'ok') return null;
  return state.money.data.envelopes.find((e) => e.type === 'unallocated')?.balanceMinor ?? null;
}

/** A polite live region, so a committed transfer is announced to somebody. */
function announce(message: string) {
  let region = document.getElementById('ballast-live');
  if (!region) {
    region = h('div');
    region.id = 'ballast-live';
    region.setAttribute('role', 'status');
    region.setAttribute('aria-live', 'polite');
    region.style.cssText =
      'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap';
    document.body.append(region);
  }
  region.textContent = message;
}

/* -------------------------------------------------------------------------
 * Views
 * ---------------------------------------------------------------------- */

function currentEntity() {
  if (!state) return undefined;
  return state.me.entities.find((e) => e.id === state!.entityId) ?? state.me.entities[0];
}

function renderHero(): HTMLElement {
  const s = state!;
  const hero = h('div', 'hero');

  // WHOSE money. Entities never commingle (§3), so an unlabelled hero over an
  // account list invites the one misreading the structure exists to prevent.
  const entity = currentEntity();
  if (entity) hero.append(h('div', 'safe-entity', entity.name));
  hero.append(h('div', 'safe-label', 'Safe to spend'));

  // The app's headline figure is its h1. It had no heading role at all, so a
  // screen reader's document outline began at the zone titles.
  const figure = h('h1', 'safe-figure');
  const sub = h('div', 'safe-sub');

  if (s.me.connections.length === 0) {
    figure.textContent = '—';
    sub.textContent = 'Connect an account to see real figures.';
  } else if (s.money.status === 'none') {
    figure.textContent = '—';
    sub.textContent = 'No entity yet.';
  } else if (s.money.status === 'error') {
    figure.textContent = '—';
    sub.textContent = s.money.message;
  } else if (s.money.data.safeToSpendMinor == null) {
    // The "green but dead" rule applied to the hero. If the bank has not said
    // what is available, the honest answer is that we do not know.
    figure.textContent = '—';
    sub.textContent = "Your bank hasn't reported an available balance.";
  } else {
    figure.textContent = formatMoney(s.money.data.safeToSpendMinor);
    sub.textContent = 'Everything else already has a job.';
  }
  // An em dash is announced as nothing at all.
  if (figure.textContent === '—') figure.setAttribute('aria-label', 'not known yet');
  hero.append(figure, sub);

  const worst =
    s.me.connections.find((c) => c.status === 'reauth_required') ??
    s.me.connections.find((c) => c.status === 'pending_disconnect') ??
    s.me.connections[0];
  hero.append(
    createFreshness(
      worst
        ? {
            lastSyncedAt: worst.lastSyncedAt ? Date.parse(worst.lastSyncedAt) : null,
            connection: worst.status,
          }
        : { lastSyncedAt: null, connection: 'never' },
    ),
  );

  return hero;
}

/** The one thing that needs doing, or nothing. Shared by Canvas and Needs You. */
function focalAlert(): HTMLElement | null {
  const s = state!;
  const reauth = s.me.connections.find((c) => c.status === 'reauth_required');
  if (reauth) {
    return createFocalAlert({
      title: `Reconnect ${reauth.institutionName ?? 'your bank'}`,
      detail: 'Your bank needs a fresh sign-in before new activity shows up.',
      action: 'Reconnect',
      tone: 'bad',
      // No onAction: the Plaid Link flow is not built yet, and a button that
      // does nothing is worse than none. The card still says what is wrong.
    });
  }
  if (s.me.connections.length === 0) {
    return createFocalAlert({
      title: 'Connect your first business account',
      detail: 'Ballast reads balances and transactions. It never moves your money.',
      action: 'Connect',
      tone: 'watch',
    });
  }
  if (s.money.status === 'error') {
    return createFocalAlert({
      title: "Couldn't load your envelopes",
      detail: s.money.message,
      action: 'Try again',
      tone: 'bad',
      onAction: () => void refresh(),
    });
  }
  return null;
}

function renderCanvas(body: HTMLElement) {
  const s = state!;

  const alert = focalAlert();
  if (alert) body.append(alert);

  if (s.money.status !== 'ok') return;
  const money = s.money.data;

  if (money.overAllocatedMinor > 0) {
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

  if (money.envelopes.length === 0) return;

  const tiles: EnvelopeTileModel[] = money.envelopes.map((e) => ({
    id: e.id,
    name: e.name,
    type: e.type,
    // NOT `?? 0`. An unknown balance stays unknown all the way to the tile.
    balanceMinor: e.balanceMinor,
    targetMinor: e.targetMinor,
    targetDate: e.targetDate,
    currency: 'USD',
  }));

  const unallocated = money.envelopes.find((e) => e.type === 'unallocated');
  const fundable = unallocated != null && (unallocated.balanceMinor ?? 0) > 0;

  const grid = h('div');
  body.append(grid);

  grid.append(
    createZoneGrid({
      zones: groupIntoZones(tiles),
      // Unallocated is the SOURCE of a fund, never its destination, and there
      // is nothing to fund from when it is empty or unknown.
      isSelectable: (envelope) => envelope.type !== 'unallocated' && fundable,
      onSelect: (envelope) => {
        // Unallocated is the SOURCE of a fund, never its destination, so it is
        // not a control. createEnvelopeTile renders non-interactive tiles as
        // plain elements, so this guard is belt and braces.
        if (envelope.type === 'unallocated' || !unallocated || !fundable) return;
        openFundSheet(money.entityId, unallocated.id, envelope);
      },
    }),
  );

  const add = h('button', 'btn-quiet', '+ New envelope');
  add.type = 'button';
  add.style.cssText = 'width:100%;min-height:var(--tap);margin-top:14px';
  add.addEventListener('click', () => openNewEnvelopeSheet(money.entityId));
  body.append(add);
}

function renderNeeds(body: HTMLElement) {
  const alert = focalAlert();
  if (alert) body.append(alert);
  else {
    const card = h('section', 'card vitals');
    card.append(h('div', 'label', 'Needs you'));
    card.append(h('p', 'soft', 'Nothing right now.'));
    body.append(card);
  }

  // Said plainly rather than implied by an empty screen. The queue itself —
  // staged proposals, receipt prompts, unassigned spend — is Slice 2.
  const note = h('section', 'card vitals');
  note.append(h('div', 'label', 'Coming here'));
  note.append(
    h(
      'p',
      'soft',
      'One queue for staged allocations, receipt prompts and unassigned spend. Nothing changes a balance without you approving it.',
    ),
  );
  body.append(note);
}

function renderAccounts(body: HTMLElement) {
  const s = state!;

  const vitals = h('section', 'card vitals');
  vitals.append(h('div', 'label', 'Entities'));

  if (s.me.entities.length === 0) {
    vitals.append(
      h('p', 'soft', 'No entities yet. Each linked account is tagged to one entity and its state.'),
    );
  } else {
    for (const ent of s.me.entities) {
      // Every entity is SELECTABLE when there is more than one. The Canvas was
      // hard-wired to entities[0], so the other LLCs were listed as text the
      // operator could never open — in an app whose whole premise is keeping
      // them separate.
      const selectable = s.me.entities.length > 1;
      const row = h(selectable ? 'button' : 'div');
      if (selectable) {
        (row as HTMLButtonElement).type = 'button';
        row.addEventListener('click', () => {
          state!.entityId = ent.id;
          state!.view = 'canvas';
          void refresh();
        });
      }
      row.style.cssText =
        'display:flex;justify-content:space-between;align-items:center;width:100%;' +
        'min-height:var(--tap);background:none;border:0;padding:0;font:inherit;' +
        'color:var(--ink);text-align:left;' +
        (selectable ? 'cursor:pointer' : '');
      const name = h('span', undefined, ent.name);
      if (ent.id === s.entityId) name.style.fontWeight = '700';
      row.append(name, h('span', 'soft num', ent.state));
      vitals.append(row);
    }
  }

  vitals.append(h('div', 'rule'));

  const connSummary = h('div', 'duo');
  const numStyle =
    'font-family:var(--display),system-ui,sans-serif;font-weight:700;font-size:1.9rem;letter-spacing:-.03em';

  const left = h('div');
  left.append(h('div', 'label', 'Accounts'));
  const accountsNum = h('div', 'num');
  accountsNum.style.cssText = numStyle;
  accountsNum.textContent = String(s.me.connections.reduce((n, c) => n + c.accountCount, 0));
  left.append(accountsNum);

  const right = h('div');
  right.append(h('div', 'label', 'Connections'));
  const connNum = h('div', 'num');
  connNum.style.cssText = numStyle;
  connNum.textContent = String(s.me.connections.length);
  right.append(connNum);

  connSummary.append(left, h('div', 'vsep'), right);
  vitals.append(connSummary);

  vitals.append(
    createCollapsible({
      summary: 'Connection detail',
      body: () => {
        const wrap = h('div');
        if (s.me.connections.length === 0) {
          wrap.append(h('p', undefined, 'Nothing connected yet.'));
          return wrap;
        }
        for (const c of s.me.connections) {
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
}

function renderSettings(body: HTMLElement) {
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
      render();
    });
    group.append(b);
  }
  themeCard.append(group);
  body.append(themeCard);

  const account = h('section', 'card vitals');
  account.append(h('div', 'label', 'Account'));
  account.append(h('p', 'soft', state!.me.user.email));
  const out = h('button', 'btn-quiet', 'Sign out');
  out.type = 'button';
  out.style.cssText = 'margin-top:12px;min-height:var(--tap);padding:0 18px;width:100%';
  out.addEventListener('click', async () => {
    out.disabled = true;
    try {
      await api.logout();
    } catch {
      // Signing out locally still matters even if the request failed.
    }
    state = null;
    renderLogin(() => void boot());
  });
  account.append(out);
  body.append(account);
}

/* -------------------------------------------------------------------------
 * Shell
 * ---------------------------------------------------------------------- */

function render() {
  const s = state;
  if (!s) return;

  // Keep the reader where they were. A full repaint that jumps to the top
  // punishes anyone who tapped a control near the bottom of the page.
  const prior = app.querySelector<HTMLElement>('.scroll')?.scrollTop ?? 0;

  clear(app);

  const scroll = h('main', 'scroll');
  scroll.id = 'main';
  const body = h('div', 'body');

  if (s.view === 'canvas') scroll.append(renderHero());

  switch (s.view) {
    case 'canvas':
      renderCanvas(body);
      break;
    case 'needs':
      renderNeeds(body);
      break;
    case 'accounts':
      renderAccounts(body);
      break;
    case 'settings':
      renderSettings(body);
      break;
  }

  const foot = h('p', 'soft');
  foot.style.cssText = 'font-size:.75rem;text-align:center;padding:8px 0 4px';
  // Precise, because the fund sheet on the next screen says "Set it aside".
  // Ballast moves LABELS between envelopes; it never moves cash between
  // accounts, and the two claims must not look like they contradict.
  foot.textContent = `Ballast ${VERSION} · read-only · never moves money between your accounts`;
  body.append(foot);

  scroll.append(body);

  const reauth = s.me.connections.find((c) => c.status === 'reauth_required');
  // The ONE living status. It has to agree with the body: a pill reading
  // "Nothing needs you" above a notice saying otherwise teaches the operator
  // that the pill is decoration.
  const pill = reauth
    ? { text: 'Reconnect a bank', status: 'bad' as const }
    : s.me.connections.length === 0
      ? { text: 'Connect an account', status: 'watch' as const }
      : s.money.status === 'error'
        ? { text: "Couldn't load figures", status: 'bad' as const }
        : s.money.status === 'ok' && s.money.data.overAllocatedMinor > 0
          ? { text: 'Over-allocated', status: 'watch' as const }
          : s.money.status === 'ok' && s.money.data.safeToSpendMinor == null
            ? { text: 'Waiting on your bank', status: 'watch' as const }
            : { text: 'Nothing needs you', status: 'good' as const };

  app.append(scroll, createNowBar({ active: s.view, pill, onNavigate: go }));

  const next = app.querySelector<HTMLElement>('.scroll');
  if (next) next.scrollTop = prior;
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
  const retry = h('button', 'btn-quiet', 'Try again');
  retry.type = 'button';
  retry.style.cssText = 'margin-top:12px;min-height:var(--tap);padding:0 18px;width:100%';
  retry.addEventListener('click', () => void boot());
  card.append(retry);
  body.append(card);
  scroll.append(body);
  app.append(scroll);
}

async function boot() {
  initTheme();
  watchSystemTheme(() => {});

  try {
    const me = await api.me();
    const entityId = me.entities[0]?.id ?? null;
    state = { me, view: 'canvas', entityId, money: await loadMoney(entityId) };
    render();
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
