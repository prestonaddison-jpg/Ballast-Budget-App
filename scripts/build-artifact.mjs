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

// Namespace the theme attribute so the host's own data-theme cannot clobber it.
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
 * ------------------------------------------------------------------------ */
(function () {
  var CASH = 1842000; // what the bank reports as AVAILABLE, in cents

  var entity = { id: 'ent_demo', name: 'Concierge Car Repair DFW', state: 'TX' };

  var named = [
    { id: 'e_tax',    name: 'Tax',            type: 'tax',    targetMinor:  900000, balanceMinor: 620000 },
    { id: 'e_buf',    name: 'Buffer',         type: 'buffer', targetMinor: 1200000, balanceMinor: 450000 },
    { id: 'e_rack',   name: 'Alignment rack', type: 'save',   targetMinor:  750000, balanceMinor: 280000 },
    { id: 'e_ins',    name: 'Q1 insurance',   type: 'spend',  targetMinor:  340000, balanceMinor: 340000 }
  ];

  function residual() {
    return named.reduce(function (n, e) { return n - e.balanceMinor; }, CASH);
  }

  function envelopesBody() {
    var unalloc = {
      id: 'e_unalloc', name: 'Unallocated', type: 'unallocated',
      balanceMinor: residual(), targetMinor: null, targetDate: null, zone: null
    };
    var list = [unalloc].concat(named.map(function (e) {
      return { id: e.id, name: e.name, type: e.type, balanceMinor: e.balanceMinor,
               targetMinor: e.targetMinor, targetDate: null, zone: null };
    }));
    return {
      entityId: entity.id,
      envelopes: list,
      safeToSpendMinor: Math.max(0, residual()),
      overAllocatedMinor: residual() < 0 ? -residual() : 0,
      invariant: 'balanced'
    };
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

    if (url.indexOf('/transfers') !== -1 && method === 'POST') {
      var body = JSON.parse((init && init.body) || '{}');
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

    if (url.indexOf('/envelopes') !== -1) return Promise.resolve(json(envelopesBody()));
    if (url.indexOf('/auth/logout') !== -1) return Promise.resolve(json({}, 200));
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
