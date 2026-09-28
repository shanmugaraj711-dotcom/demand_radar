'use strict';
// Outbound-only check: can this machine reach the keyword sources? Changes nothing. Run: node tools/probe.js
const sources = require('../lib/suggest').SOURCES;
(async () => {
  for (const [id, s] of Object.entries(sources)) {
    const t = Date.now();
    try {
      const r = await fetch(s.url('yoga classes', { lang: 'en', country: 'in' }), { signal: AbortSignal.timeout(6000), redirect: 'manual', headers: { 'User-Agent': 'Mozilla/5.0' } });
      let n = '';
      if (r.ok) { try { n = ' ' + s.parse(await r.text()).length + ' phrases'; } catch { n = ' (unreadable reply)'; } }
      console.log(`${id.padEnd(11)} HTTP ${r.status}${n}  ${Date.now() - t} ms`);
    } catch (e) { console.log(`${id.padEnd(11)} FAILED (${e.name})  ${Date.now() - t} ms`); }
  }
})();
