/**
 * Bundles the built PWA into one self-contained HTML page for sharing.
 *
 * It ships the REAL CSS and the REAL component bundle; only the network layer
 * is replaced, by an in-memory model that mirrors the residual design, so the
 * fund sheet genuinely moves money and the numbers stay conserved.
 *
 * Two collisions with a generic host page are handled here rather than in the
 * app: the app's `data-theme` attribute is namespaced so a host that stamps its
 * own light/dark value on <html> cannot fight it, and the service worker is
 * left unregistered since there is nothing to cache.
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';

const DIST = '/home/user/Ballast-Budget-App/dist/client/assets';
const files = readdirSync(DIST);
const cssFile = files.find((f) => f.endsWith('.css'));
const jsFile = files.find((f) => f.endsWith('.js') && !f.endsWith('.map'));

let css = readFileSync(`${DIST}/${cssFile}`, 'utf8');
let js = readFileSync(`${DIST}/${jsFile}`, 'utf8');

// The page is served from a single file with no sibling assets, so the
// self-hosted faces have to travel inside it.
function inlineFonts(text) {
  // Vite emits these unquoted, so the quotes are optional in the pattern.
  return text.replace(/url\(['"]?\/fonts\/([^)'"]+)['"]?\)/g, (whole, file) => {
    try {
      const bytes = readFileSync(`/home/user/Ballast-Budget-App/web/public/fonts/${file}`);
      return `url('data:font/woff2;base64,${bytes.toString('base64')}')`;
    } catch {
      return whole;
    }
  });
}
css = inlineFonts(css);

// Namespace the theme attribute so the host's own data-theme cannot clobber it.
// The artifact host wraps this page in its own skeleton and pads :root by the
// phone's safe-area insets. `100svh` is measured against the VIEWPORT, not that
// padded box, so the shell would run taller than the space it is given and push
// the Now-Bar off the bottom — the exact defect this project already shipped
// once and built a browser suite to prevent. Percentages resolve against the
// padded parent instead, and html/body are already height:100% below.
css = css.replaceAll('100svh', '100%');

css = css.replaceAll('data-theme=atelier]', 'data-bt=atelier]');
css = css.replaceAll('data-theme=graphite]', 'data-bt=graphite]');
js = js.replaceAll('"data-theme"', '"data-bt"');

// Nothing to cache and no origin to cache it from.
js = js.replaceAll(
  'navigator.serviceWorker.register',
  '(()=>Promise.reject())||navigator.serviceWorker.register',
);

const STUB = `
/* ---------------------------------------------------------------------------
 * Demo backend. Same shapes the Worker returns, same rules it enforces.
 *
 * unallocated is the RESIDUAL — cash minus every named envelope — exactly as
 * the SQL view computes it, so conservation holds here for the same reason it
 * holds in production: it is an identity, not a rule anybody remembers to apply.
 *
 * The guards are real, not decorative. Funding more than is unallocated is
 * refused; approving a proposal the balance no longer covers is refused at the
 * moment of approval, not at the moment it was staged. Those are the two rules
 * the whole app exists to keep, so a demo that quietly let them slide would be
 * showing something Ballast is not.
 * ------------------------------------------------------------------------ */
(function () {
  var CASH = 1842000; // what the bank reports as AVAILABLE, in cents

  var entity = { id: 'ent_demo', name: 'Concierge Car Repair DFW', state: 'TX' };

  // Due dates are RELATIVE to today, so "due in 12 days" stays true however
  // long after this page was built somebody opens it.
  function inDays(n) {
    var d = new Date();
    d.setDate(d.getDate() + n);
    var p = function (x) { return String(x).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  var named = [
    { id: 'e_tax',  name: 'Tax',            type: 'tax',    targetMinor:  900000, balanceMinor: 620000, targetDate: null },
    { id: 'e_buf',  name: 'Buffer',         type: 'buffer', targetMinor: 1200000, balanceMinor: 450000, targetDate: null },
    { id: 'e_rack', name: 'Alignment rack', type: 'save',   targetMinor:  750000, balanceMinor: 280000, targetDate: inDays(12) },
    { id: 'e_ins',  name: 'Q1 insurance',   type: 'spend',  targetMinor:  340000, balanceMinor: 340000, targetDate: inDays(3) }
  ];

  var UNALLOC = 'e_unalloc';
  var nextId = 1;

  var proposals = [
    { id: 'p_1', kind: 'income_allocation', from: UNALLOC, to: 'e_tax',
      amountMinor: 48000, memo: 'Deposit landed Friday', status: 'pending' },
    { id: 'p_2', kind: 'waterfall', from: UNALLOC, to: 'e_buf',
      amountMinor: 240000, memo: 'Top the buffer toward one month of costs', status: 'pending' }
  ];

  function residual() {
    return named.reduce(function (n, e) { return n - e.balanceMinor; }, CASH);
  }

  function byId(id) {
    if (id === UNALLOC) {
      return { id: UNALLOC, name: 'Unallocated', type: 'unallocated', balanceMinor: residual() };
    }
    return named.filter(function (e) { return e.id === id; })[0] || null;
  }

  function envelopesBody() {
    var unalloc = {
      id: UNALLOC, name: 'Unallocated', type: 'unallocated',
      balanceMinor: residual(), targetMinor: null, targetDate: null, zone: null
    };
    var list = [unalloc].concat(named.map(function (e) {
      return { id: e.id, name: e.name, type: e.type, balanceMinor: e.balanceMinor,
               targetMinor: e.targetMinor, targetDate: e.targetDate, zone: null };
    }));
    return {
      entityId: entity.id,
      envelopes: list,
      safeToSpendMinor: Math.max(0, residual()),
      overAllocatedMinor: residual() < 0 ? -residual() : 0,
      invariant: 'balanced'
    };
  }

  function presentProposal(p) {
    var from = byId(p.from);
    var to = byId(p.to);
    var srcBal = from ? from.balanceMinor : null;
    return {
      id: p.id, kind: p.kind, amountMinor: p.amountMinor, memo: p.memo,
      createdAt: 0, expiresAt: null,
      from: { id: p.from, name: from ? from.name : null, type: from ? from.type : null },
      to:   { id: p.to,   name: to   ? to.name   : null, type: to   ? to.type   : null },
      sourceBalanceMinor: srcBal,
      // Three-valued on purpose: null means the balance is unknown, which is
      // neither "you can afford it" nor "you cannot".
      affordableNow: srcBal == null ? null : srcBal >= p.amountMinor
    };
  }

  function pending() {
    return proposals.filter(function (p) { return p.status === 'pending'; });
  }

  function json(body, status) {
    return new Response(JSON.stringify(body), {
      status: status || 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  var realFetch = window.fetch.bind(window);

  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var method = ((init && init.method) || 'GET').toUpperCase();
    if (url.indexOf('/api/') === -1) return realFetch(input, init);

    var body = {};
    try { body = JSON.parse((init && init.body) || '{}'); } catch (e) { body = {}; }

    if (url.indexOf('/api/me') !== -1) {
      return Promise.resolve(json({
        user: { userId: 'u_demo', email: 'demo@ballast.local' },
        entities: [entity],
        connections: [{
          itemId: 'item_demo', institutionName: 'Chase', status: 'ok',
          lastSyncedAt: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
          accountCount: 2
        }]
      }));
    }

    /* --- Proposals. Checked BEFORE /envelopes, because the approve path is
     *     /proposals/<id>/approve and a looser match would swallow it. ----- */
    if (url.indexOf('/proposals') !== -1) {
      var pm = url.match(/\\/proposals\\/([^/?]+)/);
      var target = pm ? proposals.filter(function (p) { return p.id === pm[1]; })[0] : null;

      if (url.indexOf('/approve') !== -1 && method === 'POST') {
        if (!target) return Promise.resolve(json({ code: 'not_found', message: 'Not found.' }, 404));
        if (target.status !== 'pending') {
          return Promise.resolve(json({ code: 'not_pending', message: 'That was already decided.' }, 409));
        }
        var src = byId(target.from);
        var dst = byId(target.to);
        // THE RULE: checked against the balance as it is NOW, not as it was
        // when the proposal was staged.
        if (!src || src.balanceMinor < target.amountMinor) {
          return Promise.resolve(json({
            code: 'insufficient_funds',
            message: 'That no longer fits \\u2014 the balance moved since this was suggested.'
          }, 409));
        }
        if (dst && dst.id !== UNALLOC) dst.balanceMinor += target.amountMinor;
        if (src.id !== UNALLOC) src.balanceMinor -= target.amountMinor;
        target.status = 'approved';
        return Promise.resolve(json({ entryId: 'led_' + target.id, amountMinor: target.amountMinor }, 201));
      }

      if (url.indexOf('/dismiss') !== -1 && method === 'POST') {
        if (!target || target.status !== 'pending') {
          return Promise.resolve(json({ code: 'not_pending', message: 'That was already decided.' }, 409));
        }
        target.status = 'dismissed';
        return Promise.resolve(json({ dismissed: true }));
      }

      if (method === 'PATCH') {
        if (!target || target.status !== 'pending') {
          return Promise.resolve(json({ code: 'not_pending', message: 'That was already decided.' }, 409));
        }
        if (!Number.isInteger(body.amountMinor) || body.amountMinor <= 0) {
          return Promise.resolve(json({
            code: 'bad_request', message: 'Amount must be a positive whole number of cents.'
          }, 400));
        }
        // Deliberately NOT balance-checked: a proposal reserves nothing, and
        // approve is the only check that decides anything.
        target.amountMinor = body.amountMinor;
        return Promise.resolve(json({ amountMinor: target.amountMinor }));
      }

      return Promise.resolve(json({ entityId: entity.id, proposals: pending().map(presentProposal) }));
    }

    if (url.indexOf('/transfers') !== -1 && method === 'POST') {
      var dest = named.filter(function (e) { return e.id === body.toEnvelopeId; })[0];
      if (!dest) return Promise.resolve(json({ code: 'rejected', message: 'No such envelope.' }, 400));
      // The same guard the SQL statement folds into its INSERT: you cannot move
      // more than is actually unallocated.
      if (body.amountMinor > residual()) {
        return Promise.resolve(json(
          { code: 'insufficient_funds', message: 'That envelope does not have enough to move.' }, 409));
      }
      dest.balanceMinor += body.amountMinor;
      return Promise.resolve(json({ entryId: 'led_demo' }, 201));
    }

    // completeEnvelope: sweep the remainder back and archive. Matched before
    // the bare /envelopes route, which would otherwise swallow it.
    if (url.indexOf('/complete') !== -1 && method === 'POST') {
      var cm = url.match(/\\/envelopes\\/([^/?]+)\\/complete/);
      var idx = cm ? named.findIndex(function (e) { return e.id === cm[1]; }) : -1;
      if (idx === -1) return Promise.resolve(json({ code: 'not_found', message: 'Not found.' }, 404));
      var swept = named[idx].balanceMinor;
      named.splice(idx, 1);
      // The money is not destroyed: removing the envelope returns it to the
      // residual automatically, which is the whole point of the design.
      return Promise.resolve(json({ sweptMinor: swept }));
    }

    if (url.indexOf('/envelopes') !== -1 && method === 'POST') {
      var name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name) return Promise.resolve(json({ code: 'bad_request', message: 'A name is required.' }, 400));
      if (body.targetDate != null && !/^\\d{4}-\\d{2}-\\d{2}$/.test(body.targetDate)) {
        return Promise.resolve(json({
          code: 'bad_request', message: 'A due date must be a real date, as YYYY-MM-DD.'
        }, 400));
      }
      var created = {
        id: 'e_new' + nextId++, name: name, type: body.type || 'save',
        targetMinor: body.targetMinor == null ? null : body.targetMinor,
        balanceMinor: 0, targetDate: body.targetDate || null
      };
      named.push(created);
      return Promise.resolve(json({ id: created.id }, 201));
    }

    if (url.indexOf('/envelopes') !== -1) return Promise.resolve(json(envelopesBody()));
    // Auth. The demo boots straight in, so these are only reached if somebody
    // taps Sign out in Settings — at which point /api/me signs them back in.
    // Handled anyway: an unhandled route falls through to the 404 below, and a
    // sign-out that errors is a worse demo than one that simply loops.
    if (url.indexOf('/auth/logout') !== -1) return Promise.resolve(json({}, 200));
    if (url.indexOf('/auth/login') !== -1) {
      return Promise.resolve(json({ user: { userId: 'u_demo', email: 'demo@ballast.local' } }));
    }
    if (url.indexOf('/health') !== -1) {
      return Promise.resolve(json({ ok: true, version: 'demo', time: new Date().toISOString() }));
    }
    return Promise.resolve(json({ code: 'not_found', message: 'Not found.' }, 404));
  };
})();
`;

const html = `<title>Ballast</title>
<meta name="color-scheme" content="light dark" />
<style>
${css}

/* --- Demo chrome. Not part of the app. ---------------------------------- */
html, body { height: 100%; margin: 0; padding: 0; }
body { overflow: hidden; }
.demo-flag {
  position: fixed; z-index: 90;
  /* Docked above the Now-Bar. At the top it sat across the entity name in the
     hero, which is the one line that says whose money this is. */
  bottom: calc(env(safe-area-inset-bottom, 0px) + 84px); left: 50%;
  transform: translateX(-50%);
  padding: 4px 11px; border-radius: 99px;
  font: 600 11px/1.4 var(--ui, system-ui), system-ui, sans-serif;
  letter-spacing: .06em; text-transform: uppercase;
  color: #f4f6fa;
  background: rgba(16, 27, 45, .72);
  border: 1px solid rgba(214, 178, 106, .55);
  backdrop-filter: blur(8px);
  pointer-events: none;
}
</style>

<!-- Sample figures, not anyone's real books. Stated on the page because an app
     whose whole premise is never showing a number it cannot support should not
     make an exception for its own demo. -->
<div class="demo-flag">Sample data</div>

<div id="app" class="screen"></div>

<script>
  (function () {
    try {
      var p = localStorage.getItem('ballast.theme');
      if (p !== 'atelier' && p !== 'graphite') p = null;
      var host = document.documentElement.getAttribute('data-theme');
      var dark = host === 'dark' ||
        (host !== 'light' && window.matchMedia &&
         window.matchMedia('(prefers-color-scheme: dark)').matches);
      var t = p || (dark ? 'graphite' : 'atelier');
      document.documentElement.setAttribute('data-bt', t);
      document.documentElement.style.colorScheme = t === 'graphite' ? 'dark' : 'light';
    } catch (_) {}
  })();
</script>

<script>
${STUB}
</script>

<script type="module">
${js}
</script>
`;

writeFileSync('/home/user/Ballast-Budget-App/preview/ballast-demo.html', html);
console.log(`artifact written · ${(html.length / 1024).toFixed(1)} KB`);
