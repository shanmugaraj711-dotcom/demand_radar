'use strict';
// End-to-end check of the whole app. Places, geocoder and websites are faked locally; keyword expansion uses the real network.
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { createApp } = require('../server');
const { normPhone } = require('../lib/leads');

let pass = 0, fail = 0;
const ok = (cond, msg, extra) => { if (cond) { pass++; console.log('  ok   ' + msg); } else { fail++; console.log('  FAIL ' + msg + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); } };
const listen = (handler) => new Promise((res) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => res({ s, port: s.address().port })); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- fakes ---------- */
const placesCalls = [];
function fakePlaces(req, res) {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    const body = JSON.parse(b || '{}');
    placesCalls.push({ key: req.headers['x-goog-api-key'], mask: req.headers['x-goog-fieldmask'], body });
    res.setHeader('Content-Type', 'application/json');
    if (req.headers['x-goog-api-key'] === 'bad') { res.statusCode = 403; return res.end(JSON.stringify({ error: { message: 'API key not valid.' } })); }
    // 45 results per query, in pages of 20. Localities share the same first 10 (tests dedupe).
    const q = body.textQuery || '';
    const seed = /Adyar/.test(q) ? 'A' : /Anna Nagar/.test(q) ? 'N' : 'C';
    const start = body.pageToken ? +body.pageToken : 0;
    const all = Array.from({ length: 45 }, (_, i) => {
      const shared = i < 10;
      const id = shared ? `shared${i}` : `${seed}${i}`;
      const mobile = i % 3 !== 0;
      const num = `9${{ A: 1, N: 2, C: 3 }[shared ? 'C' : seed]}${String(10000000 + i * 137).slice(0, 8)}`; // 10 digits starting with 9, unique per place
      return {
        id, displayName: { text: shared ? `Shared Abacus ${i}` : `${seed} Abacus Academy ${i}` },
        formattedAddress: `No ${i}, Main Street, ${seed === 'A' ? 'Adyar' : seed === 'N' ? 'Anna Nagar' : 'T Nagar'}, Chennai, Tamil Nadu 6000${10 + i}, India`,
        nationalPhoneNumber: mobile ? `0${num.slice(0, 5)} ${num.slice(5)}` : `044 2234 ${String(1000 + i + (shared ? 0 : seed.charCodeAt(0) * 100))}`,
        internationalPhoneNumber: mobile ? `+91 ${num.slice(0, 5)} ${num.slice(5)}` : `+91 44 2234 ${String(1000 + i + (shared ? 0 : seed.charCodeAt(0) * 100))}`,
        websiteUri: i === 11 ? `http://127.0.0.1:${sitePort}/app` : i === 12 ? `http://127.0.0.1:${sitePort}/plain` : i === 13 ? `http://127.0.0.1:${sitePort}/dead` : undefined,
        rating: 3 + (i % 20) / 10, userRatingCount: (i * 13) % 700, googleMapsUri: `https://maps.google.com/?cid=${id}`,
        businessStatus: i === 44 ? 'CLOSED_PERMANENTLY' : 'OPERATIONAL', location: { latitude: 13 + i / 1000, longitude: 80.2 },
      };
    });
    const page = all.slice(start, start + 20);
    res.end(JSON.stringify({ places: page, nextPageToken: start + 20 < all.length ? String(start + 20) : undefined }));
  });
}
function fakeNominatim(req, res) {
  const q = new URL(req.url, 'http://x').searchParams.get('q').toLowerCase();
  const known = { chennai: [13.08, 80.27, 'city'], salem: [11.66, 78.14, 'city'], pune: [18.52, 73.85, 'city'] };
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(known[q] ? [{ lat: String(known[q][0]), lon: String(known[q][1]), category: 'boundary', type: 'administrative', display_name: q }] : []));
}
let sitePort;
function fakeSite(req, res) {
  res.setHeader('Content-Type', 'text/html');
  if (req.url === '/app') return res.end('<html><body><a href="https://play.google.com/store/apps/details?id=x.y">Get our app</a> <a href="https://wa.me/919876543210">chat</a> <a href="mailto:hello@abacusfun.in">mail</a> Call 98765 43210. <a href="https://instagram.com/abacusfun">ig</a></body></html>');
  if (req.url === '/plain') return res.end('<html><body>Welcome. Contact: 91234-56789 (not a valid mobile) or 98411 72896. <a href="/contact-us">Contact</a></body></html>');
  if (req.url === '/contact-us') return res.end('<html><body>Email: teacher@sunrise.in</body></html>');
  res.statusCode = 404; res.end('nope');
}

async function main() {
  const P = await listen(fakePlaces), N = await listen(fakeNominatim), W = await listen(fakeSite);
  sitePort = W.port;
  const dbFile = path.join(os.tmpdir(), 'topic-radar-test-' + Date.now() + '.db');
  const app = createApp({ dbFile, placesBase: `http://127.0.0.1:${P.port}`, nominatimBase: `http://127.0.0.1:${N.port}`, gapMs: 15 });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const api = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text();
    let j; try { j = JSON.parse(t); } catch { j = t; }
    return { status: r.status, body: j };
  };
  const waitJob = async (id, ms = 120000) => { const t0 = Date.now(); for (;;) { const j = (await api('GET', '/api/jobs/' + id)).body; if (j.status !== 'running') return j; if (Date.now() - t0 > ms) throw new Error('job timeout'); await sleep(150); } };

  console.log('\nSecurity');
  {
    const r = await new Promise((res) => { const q = http.request({ host: '127.0.0.1', port: app.server.address().port, path: '/api/state', headers: { Host: 'evil.example' } }, (x) => res(x.statusCode)); q.end(); });
    ok(r === 403, 'rejects foreign Host header (DNS rebinding)', r);
    const r2 = await fetch(base + '/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}' });
    ok(r2.status === 403, 'rejects cross-origin writes', r2.status);
    const r3 = await fetch(base + '/..%2f..%2fserver.js');
    ok(r3.status !== 200 || !(await r3.text()).includes('createApp'), 'static server blocks path traversal');
  }

  console.log('\nPhones');
  ok(normPhone('097913 20405').wa === '919791320405' && normPhone('097913 20405').type === 'mobile', 'Indian mobile with leading 0');
  ok(normPhone('+91 97913 20405').type === 'mobile', '+91 mobile');
  ok(normPhone('044 2234 5678').type === 'landline', 'landline detected (no WhatsApp)');
  ok(normPhone('22345678').type === 'invalid', 'short number invalid');
  ok(normPhone('9791320405').wa === '919791320405', '10-digit mobile');

  console.log('\nSettings');
  {
    let s = (await api('GET', '/api/settings')).body.settings;
    ok(!s.placesKeySet, 'no Places key at start');
    await api('PUT', '/api/settings', { placesKey: 'testkey123456' });
    s = (await api('GET', '/api/settings')).body.settings;
    ok(s.placesKeySet && s.placesKey === '••••3456', 'key saved and masked in the API', s.placesKey);
    const st = (await api('GET', '/api/state')).body;
    ok(st.hasPlaces === true, 'state reports key present');
  }

  console.log('\nFind businesses (fake Places)');
  {
    const plan = await api('POST', '/api/leads/plan', { queries: ['abacus classes'], city: 'Chennai', mode: 'localities', localities: ['Adyar', 'Anna Nagar', 'T Nagar'] });
    ok(plan.body.searches === 3 && plan.body.worstRequests === 9, 'plan = 3 searches, 9 worst-case requests', plan.body);
    const grid = await api('POST', '/api/leads/plan', { queries: ['abacus classes'], city: 'Chennai', mode: 'grid', coverKm: 12, stepKm: 4 });
    ok(grid.body.searches > 15 && grid.body.searches < 60, 'grid mode geocodes the city and builds a lattice of circles', grid.body);
    const j0 = await api('POST', '/api/leads/find', { queries: ['abacus classes'], city: 'Chennai', mode: 'localities', localities: ['Adyar', 'Anna Nagar'], seed: 'abacus' });
    const job = await waitJob(j0.body.jobId);
    ok(job.status === 'done', 'find job completes', job);
    const list = (await api('GET', '/api/leads?limit=300')).body;
    // 2 queries x 44 open places (45th is closed) but 10 shared -> 10 + 2*34 = 78
    ok(list.total === 78, 'dedupes shared places and skips permanently closed ones (78 unique)', list.total);
    ok(job.requests === 6, 'followed all 3 pages per query (6 requests)', job.requests);
    const call = placesCalls[0];
    ok(call.key === 'testkey123456' && /nationalPhoneNumber/.test(call.mask) && /nextPageToken/.test(call.mask), 'sends key and field mask');
    ok(placesCalls.every((c) => c.body.regionCode === 'IN'), 'sends region code');
    const withArea = list.rows.filter((l) => l.area === 'Adyar' || l.area === 'Anna Nagar').length;
    ok(withArea > 60, 'guesses the locality from the address', withArea);
    const top = list.rows[0];
    ok(list.rows.every((l, i, a) => i === 0 || a[i - 1].score >= l.score), 'sorted by score');
    ok(top.signals.length >= 3, 'each lead carries readable score signals', top.signals);
    const usage = (await api('GET', '/api/state')).body.placesUsedToday;
    ok(usage === 6, 'request usage is metered', usage);
    // key errors surface clearly and stop the job
    await api('PUT', '/api/settings', { placesKey: 'bad' });
    const jb = await api('POST', '/api/leads/find', { queries: ['abacus classes'], city: 'Chennai', mode: 'city' });
    const bj = await waitJob(jb.body.jobId);
    ok(bj.status === 'error' && /rejected the key/.test(bj.error), 'bad key gives a clear error', bj.error);
    await api('PUT', '/api/settings', { placesKey: 'testkey123456' });
    // daily cap
    await api('PUT', '/api/settings', { placesDailyCap: 7 });
    const jc = await api('POST', '/api/leads/find', { queries: ['abacus classes'], city: 'Chennai', mode: 'localities', localities: ['T Nagar', 'Adyar'] });
    const cj = await waitJob(jc.body.jobId);
    ok(cj.requests === 1 && /cap/.test(cj.note), 'daily cap is a hard limit (1 request left today, exactly 1 used)', cj);
    await api('PUT', '/api/settings', { placesDailyCap: 200 });
  }

  console.log('\nEnrichment (fake websites)');
  {
    const all = (await api('GET', '/api/leads?limit=300&hasPhone=1')).body.rows;
    const withSite = all.filter((l) => l.website);
    ok(withSite.length >= 3, 'some leads have websites', withSite.length);
    const jb = await api('POST', '/api/leads/enrich', {});
    const job = await waitJob(jb.body.jobId);
    ok(job.status === 'done', 'enrich job completes', job);
    const after = (await api('GET', '/api/leads?limit=300')).body.rows.filter((l) => l.website);
    const app = after.find((l) => l.website.endsWith('/app'));
    const plain = after.find((l) => l.website.endsWith('/plain'));
    const dead = after.find((l) => l.website.endsWith('/dead'));
    ok(app && app.extra.hasApp === 'yes' && app.extra.appEvidence.includes('Google Play link'), 'detects an existing Play Store app', app && app.extra);
    ok(app && app.wa === '919876543210' && app.phone_type === 'mobile', 'prefers the WhatsApp number on the website', app && app.wa);
    ok(app && app.email === 'hello@abacusfun.in' && app.instagram.includes('instagram.com/abacusfun'), 'extracts email and Instagram');
    ok(app && app.signals.some((s) => /own app/.test(s.label)) && app.score < 60, 'lowers score for leads with their own app', app && app.score);
    ok(plain && plain.extra.hasApp === 'no' && plain.extra.emails.includes('teacher@sunrise.in'), 'follows the contact page', plain && plain.extra);
    ok(dead && dead.extra.enrichError, 'records unreachable sites without crashing', dead && dead.extra);
  }

  console.log('\nCSV import / export');
  {
    const csvText = 'title,phoneUnformatted,website,url,totalScore,reviewsCount,address,city\n' +
      '"Sunrise Abacus, Adyar",+919841112233,http://sunrise.example,https://www.google.com/maps/place/x,4.8,55,"5 Lake Rd, Adyar, Chennai, India",Chennai\n' +
      'Bright Minds,044 4455 6677,,,4.1,12,,Chennai\n' + ',123,,,,,,\n';
    const r = await api('POST', '/api/leads/import', { csv: csvText });
    ok(r.body.inserted === 2, 'imports Outscraper/Apify-style columns, skips blank names', r.body);
    const again = await api('POST', '/api/leads/import', { csv: csvText });
    ok(again.body.inserted === 0 && again.body.updated >= 1, 'importing twice does not duplicate', again.body);
    const found = (await api('GET', '/api/leads?q=Sunrise')).body.rows[0];
    ok(found && found.maps_url.includes('google.com/maps') && found.website === 'http://sunrise.example' && found.wa === '919841112233', 'maps url and website mapped correctly', found);
    const exp = await fetch(base + '/api/leads/export.csv');
    const txt = await exp.text();
    ok(exp.headers.get('content-type').includes('text/csv') && txt.includes('Sunrise Abacus'), 'exports leads as CSV');
    const bad = await api('POST', '/api/leads/import', { csv: 'foo,bar\n1,2' });
    ok(bad.status === 400 && /name column/.test(bad.body.error), 'clear error for a CSV without a name column');
  }

  console.log('\nFollow-up cadence');
  {
    let q = (await api('GET', '/api/queue')).body;
    ok(q.cap === 15 && q.fresh.length === 15 && q.due.length === 0, 'queue offers up to the daily cap of new leads', { fresh: q.fresh.length, cap: q.cap });
    ok(q.fresh.every((x, i, a) => i === 0 || a[i - 1].lead.score >= x.lead.score), 'best leads first');
    const item = q.fresh.find((x) => x.action.channel === 'whatsapp');
    ok(item.action.step === 'first' && item.action.wa.startsWith('https://wa.me/91') && item.action.text.startsWith('Hello 🙏'), 'first message uses a neutral greeting and a wa.me link');
    ok(!/madam|sir/i.test(item.action.text), 'no gendered greeting before we know the name');
    ok(/Adyar|Anna Nagar|T Nagar/.test(item.action.text) || !item.lead.area, 'mentions the area when known');
    const id = item.lead.id;
    let r = (await api('POST', `/api/leads/${id}/event`, { ev: 'sent', body: item.action.text })).body;
    ok(r.lead.stage === 'contacted' && r.lead.touches === 1 && r.lead.next_action === 'followup1', 'after first message: contacted, follow-up scheduled');
    const due = new Date(r.lead.next_followup);
    ok(due.getHours() === 11 && due.getTime() > Date.now() && due.getTime() < Date.now() + 2 * 864e5, 'follow-up set for 11 AM tomorrow', due.toString());
    q = (await api('GET', '/api/queue')).body;
    ok(q.sentToday === 1 && q.fresh.length === 14, 'daily cap counts first messages sent today', { sent: q.sentToday, fresh: q.fresh.length });
    ok(!q.due.find((x) => x.lead.id === id), 'not due yet');
    // fast-forward
    app.db.prepare('UPDATE leads SET next_followup=? WHERE id=?').run(Date.now() - 1000, id);
    q = (await api('GET', '/api/queue')).body;
    const d1 = q.due.find((x) => x.lead.id === id);
    ok(d1 && d1.action.step === 'followup1' && /Did you get a chance/.test(d1.action.text), 'follow-up becomes due with the follow-up text');
    r = (await api('POST', `/api/leads/${id}/event`, { ev: 'sent' })).body;
    ok(r.lead.next_action === 'call' && r.lead.touches === 2, 'after follow-up: one call scheduled (day 4)');
    app.db.prepare('UPDATE leads SET next_followup=? WHERE id=?').run(Date.now() - 1000, id);
    q = (await api('GET', '/api/queue')).body;
    ok(q.due.find((x) => x.lead.id === id).action.channel === 'call', 'call step is a call, with script');
    r = (await api('POST', `/api/leads/${id}/event`, { ev: 'called', outcome: 'no_answer' })).body;
    ok(r.lead.stage === 'lost' && !r.lead.next_action, 'no answer after the call: stop, do not chase further');
    // reply path
    const id2 = q.fresh[1].lead.id;
    await api('POST', `/api/leads/${id2}/event`, { ev: 'sent' });
    r = (await api('POST', `/api/leads/${id2}/event`, { ev: 'replied' })).body;
    ok(r.lead.stage === 'replied' && r.lead.next_action === 'send_details' && r.action.step === 'send_details', 'reply moves lead to "send details"');
    ok(/2 free student accounts/.test(r.action.text), 'details message carries the offer');
    r = (await api('POST', `/api/leads/${id2}/event`, { ev: 'sent' })).body;
    ok(r.lead.next_action === 'nudge_details', 'after details: nudge scheduled');
    r = (await api('POST', `/api/leads/${id2}/event`, { ev: 'pilot' })).body;
    ok(r.lead.stage === 'pilot' && r.lead.next_action === 'checkin3' && r.lead.pilot_start, 'pilot starts day-3 check-in');
    r = (await api('POST', `/api/leads/${id2}/event`, { ev: 'sent' })).body;
    ok(r.lead.next_action === 'checkin7', 'then day-7 check-in');
    // landline lead gets a call, retried once
    const ll = (await api('GET', '/api/leads?limit=300')).body.rows.find((l) => l.phone_type === 'landline' && l.stage === 'new');
    const act = (await api('GET', `/api/leads/${ll.id}`)).body.action;
    ok(act.channel === 'call' && act.wa === '' && /^tel:/.test(act.tel), 'landline-only lead is a call, not WhatsApp');
    r = (await api('POST', `/api/leads/${ll.id}/event`, { ev: 'called', outcome: 'no_answer' })).body;
    ok(r.lead.stage === 'contacted' && r.lead.next_action === 'call', 'first call unanswered: retry tomorrow once');
    // no whatsapp
    const nw = q.fresh.find((x) => x.lead.id !== id && x.lead.id !== id2 && x.action.channel === 'whatsapp').lead;
    r = (await api('POST', `/api/leads/${nw.id}/event`, { ev: 'no_whatsapp' })).body;
    ok(r.lead.phone_type === 'landline' && r.action.channel === 'call', '"no WhatsApp" switches the lead to calling');
    r = (await api('POST', `/api/leads/${nw.id}/event`, { ev: 'wrong_number' })).body;
    ok(r.lead.stage === 'invalid', 'wrong number closes the lead');
    // tamil
    const ta = (await api('POST', `/api/leads/${q.fresh[3].lead.id}/render`, { lang: 'ta', step: 'first' })).body;
    ok(/வணக்கம்/.test(ta.text) && ta.wa.includes('%E0%AE'), 'Tamil template renders and is URL-encoded in the WhatsApp link');
    const f = (await api('GET', '/api/funnel')).body;
    const totalLeads = (await api('GET', '/api/leads?limit=1')).body.total;
    ok(f.funnel.found === totalLeads && f.funnel.contacted >= 3 && f.funnel.replied >= 1 && f.funnel.pilot === 1, 'funnel counts', f.funnel);
  }

  console.log('\nKeywords (REAL network: Google suggest, quick scan, one source)');
  {
    const s = await api('POST', '/api/expand', { seed: 'abacus', country: 'IN', lang: 'en', depth: 'quick', city: 'Chennai', sources: ['google'] });
    let networkOk = true;
    const job = await waitJob(s.body.jobId, 180000);
    if (job.found === 0) { networkOk = false; console.log('  skip network unavailable, keyword checks skipped'); }
    if (networkOk) {
      ok(job.status === 'done' && job.found > 400, `expansion collected ${job.found} real phrases with ${job.requests} requests`, job);
      const id = s.body.searchId;
      const k = (await api('GET', `/api/searches/${id}/keywords?limit=50`)).body;
      ok(k.total === k.all && k.rows.length === 50 && k.rows[0].score >= k.rows[49].score, 'ranked results with paging');
      ok(k.rows.every((r) => r.phrase.includes('abacus')), 'every phrase is relevant to the seed');
      ok(k.facets.intents.length >= 6 && k.facets.terms.length >= 10, 'intent and term facets are built', { intents: k.facets.intents.length, terms: k.facets.terms.length });
      const loc = (await api('GET', `/api/searches/${id}/keywords?intent=local&limit=10`)).body;
      ok(loc.rows.length > 0 && loc.rows.every((r) => r.intent === 'local'), 'intent filter');
      const t = k.facets.terms[0].k;
      const byTerm = (await api('GET', `/api/searches/${id}/keywords?term=${encodeURIComponent(t)}&limit=500`)).body;
      ok(byTerm.total > 0 && byTerm.total <= k.total && byTerm.rows.every((r) => (' ' + r.phrase + ' ').includes(' ' + t + ' ')), `term filter ("${t}")`);
      const ex = (await api('GET', `/api/searches/${id}/keywords?exclude=classes&limit=500`)).body;
      ok(ex.rows.every((r) => !/\bclasses\b/.test(r.phrase)) && ex.total < k.total, 'exclude words');
      const q = (await api('GET', `/api/searches/${id}/keywords?q=near%20me`)).body;
      ok(q.total > 0 && q.rows.every((r) => r.phrase.includes('near me')), 'text search');
      ok(k.fringe > 0 && k.fringe < k.all * 0.6, `fringe detection flags ${k.fringe} of ${k.all} as possibly other meanings`);
      const csvr = await fetch(base + `/api/searches/${id}/export.csv?intent=local`);
      const csvt = await csvr.text();
      ok(csvt.split('\r\n').length > loc.total - 5 && csvt.includes('abacus classes'), 'CSV export honours filters');
      // place validation runs in the background against the (fake) geocoder
      await sleep(3500);
      const k2 = (await api('GET', `/api/searches/${id}/keywords?limit=1`)).body;
      const places = k2.facets.places.map((p) => p.k);
      ok(!places.includes('benefits') && !places.includes('login'), 'non-place words are removed by the geocoder check', places);
      // cached repeat is free
      const s2 = await api('POST', '/api/expand', { seed: 'abacus', country: 'IN', lang: 'en', depth: 'quick', city: 'Chennai', sources: ['google'] });
      const j2 = await waitJob(s2.body.jobId, 60000);
      ok(j2.requests === 0 && j2.found === job.found, 'repeat scan is served from cache (0 requests)', j2);
      // AI insights need a key
      const ai = await api('POST', '/api/ai/insights', { searchId: id });
      ok(ai.status === 400 && /Anthropic API key/.test(ai.body.error), 'AI insights explain that a key is needed');
    }
  }

  console.log('\nAny keyword, many sources (REAL network)');
  {
    const src = (await api('GET', '/api/sources')).body.sources;
    ok(src.length >= 6 && src.filter((s) => s.default).length === 4, 'server lists sources with defaults', src.map((s) => s.id));
    const { fetchOne } = require('../lib/suggest');
    const live = [];
    for (const s of src) { const r = await fetchOne(s.id, 'running shoes', { lang: 'en', country: 'in' }); live.push(`${s.id}:${r.status}${r.list ? '(' + r.list.length + ')' : ''}`); }
    const good = live.filter((x) => /:ok\(([1-9])/.test(x)).length;
    ok(good >= 5, `${good} of ${src.length} sources return live suggestions for a product query`, live.join(' '));
    // a service topic across three sources, and a product topic, and a Tamil-script topic
    const runSeed = async (seed, lang, sources, min, check) => {
      const s = await api('POST', '/api/expand', { seed, country: 'IN', lang, depth: 'quick', sources });
      const j = await waitJob(s.body.jobId, 240000);
      const k = (await api('GET', `/api/searches/${s.body.searchId}/keywords?limit=500`)).body;
      ok(j.status === 'done' && k.all >= min, `"${seed}" (${sources.join('+')}): ${k.all} phrases`, { status: j.status, all: k.all, note: j.note });
      ok(k.rows.length > 0 && k.rows.every(check), `"${seed}": every phrase stays on topic`);
      return k;
    };
    const yoga = await runSeed('yoga classes', 'en', ['google', 'duckduckgo', 'yahoo'], 300, (r) => r.phrase.includes('yoga') && r.phrase.includes('classes'));
    ok(yoga.facets.intents.some((i) => i.k === 'local') && yoga.rows.some((r) => r.sources.length === 3), 'multi-source agreement shows up in results');
    await runSeed('running shoes', 'en', ['google', 'amazon'], 200, (r) => r.phrase.includes('running') && r.phrase.includes('shoes'));
    const ta = await runSeed('பரதநாட்டியம்', 'ta', ['google', 'duckduckgo'], 20, (r) => r.phrase.includes('பரதநாட்டியம்'));
    ok(ta.rows.some((r) => /[஀-௿]/.test(r.phrase)), 'non-Latin script (Tamil) works end to end');
    const apps = await api('GET', '/api/apps?term=yoga&country=IN');
    ok(apps.status === 200 && apps.body.count > 5 && apps.body.apps[0].name && ['open', 'moderate', 'crowded'].includes(apps.body.crowd), 'App Store competitor search returns real apps', apps.body.count);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  app.close(); P.s.close(); N.s.close(); W.s.close();
  for (const ext of ['', '-wal', '-shm']) fs.rmSync(dbFile + ext, { force: true });
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
