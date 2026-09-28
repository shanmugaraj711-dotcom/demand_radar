'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const db_ = require('./lib/db');
const settingsLib = require('./lib/settings');
const suggest = require('./lib/suggest');
const intent = require('./lib/intent');
const jobs = require('./lib/jobs');
const leadsLib = require('./lib/leads');
const messages = require('./lib/messages');
const places = require('./lib/places');
const geo = require('./lib/geo');
const enrichLib = require('./lib/enrich');
const csv = require('./lib/csv');
const ai = require('./lib/ai');
const appsLib = require('./lib/apps');
const { norm, esc } = require('./lib/util');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function createApp(opts = {}) {
  const db = db_.open(opts.dbFile || path.join(__dirname, 'data', 'radar.db'));
  const cfg = { appsBase: opts.appsBase, placesBase: opts.placesBase, nominatimBase: opts.nominatimBase, anthropicBase: opts.anthropicBase };
  const S = () => settingsLib.load(db);
  const kwMemo = new Map();
  const checkingPlaces = new Set();

  /* ------------------------------------------------------------ keywords */
  const cache = { get: (k) => db_.cacheGet(db, k), set: (k, v) => db_.cacheSet(db, k, v, 14 * 864e5) };

  function saveKeywords(searchId, rows) {
    db_.tx(db, () => {
      db.prepare('DELETE FROM keywords WHERE search_id=?').run(searchId);
      const ins = db.prepare('INSERT INTO keywords(search_id,phrase,sources,occ,score,band,intent,place,fringe) VALUES(?,?,?,?,?,?,?,?,?)');
      for (const r of rows) ins.run(searchId, r.phrase, r.sources.join(','), r.occ, r.score, r.band, r.intent, r.place, r.fringe);
      db.prepare('UPDATE searches SET phrases=? WHERE id=?').run(rows.length, searchId);
    });
    kwMemo.delete(searchId);
  }

  function startExpand(body) {
    const seeds = String(body.seed || '').split(',').map((s) => norm(s)).filter(Boolean).slice(0, 3);
    if (!seeds.length) throw httpErr(400, 'Enter a topic first.');
    const s = S();
    const depth = suggest.DEPTHS[body.depth] ? body.depth : 'quick';
    const sources = (Array.isArray(body.sources) && body.sources.length ? body.sources : suggest.DEFAULT_SOURCES).filter((x) => suggest.SOURCES[x]);
    const country = /^[A-Za-z]{2}$/.test(body.country || '') ? body.country.toUpperCase() : s.country;
    const lang = /^[a-z]{2,3}$/.test(body.lang || '') ? body.lang : 'en';
    const city = String(body.city || '').trim().slice(0, 40);
    const r = db.prepare('INSERT INTO searches(seed,country,lang,city,depth,sources,status,created) VALUES(?,?,?,?,?,?,?,?)')
      .run(seeds.join(', '), country, lang, city, depth, sources.join(','), 'running', Date.now());
    const searchId = Number(r.lastInsertRowid);
    const job = jobs.create('expand', async (job, signal) => {
      job.meta = { searchId };
      let res;
      try {
        res = await suggest.expand({
          seeds, country, lang, depth, sources, city, signal, cache, gapMs: opts.gapMs,
          onFlush: (rows) => { saveKeywords(searchId, rows); job.found = rows.length; },
          onProgress: (p) => { job.done = p.done; job.total = p.total; job.requests = p.requests; job.found = p.phrases; if (p.message) job.message = p.message; job.cached = p.cached; },
        });
      } catch (e) {
        db.prepare("UPDATE searches SET status='error', note=?, finished=? WHERE id=?").run(e.message, Date.now(), searchId);
        throw e;
      }
      job.note = res.note;
      db.prepare('UPDATE searches SET status=?, requests=?, note=?, finished=? WHERE id=?')
        .run(signal.aborted ? 'stopped' : res.partial ? 'partial' : 'done', res.requests, res.note || '', Date.now(), searchId);
      job.message = res.phrases ? `${res.phrases.toLocaleString()} phrases collected.` : 'No phrases came back. The search engines may be blocking requests right now.';
      validatePlaces(searchId, country).catch(() => {});
    });
    return { jobId: job.id, searchId };
  }

  // Which of the "place" words we guessed are real places? Ask a geocoder, in the background, and drop the rest.
  async function validatePlaces(searchId, country) {
    if (checkingPlaces.has(searchId)) return;
    checkingPlaces.add(searchId);
    try {
      const cands = db.prepare("SELECT place, COUNT(*) n FROM keywords WHERE search_id=? AND place!='' GROUP BY place ORDER BY n DESC LIMIT 60").all(searchId);
      for (const c of cands) {
        const g = await geo.geocode(db, c.place, country, cfg.nominatimBase);
        if (g === undefined) continue; // network problem, leave as is
        if (g === null) db.prepare("UPDATE keywords SET place='' WHERE search_id=? AND place=?").run(searchId, c.place);
        kwMemo.delete(searchId);
      }
      db.prepare("UPDATE keywords SET place='' WHERE search_id=? AND place!='' AND place NOT IN (SELECT place FROM (SELECT place, COUNT(*) n FROM keywords WHERE search_id=? AND place!='' GROUP BY place ORDER BY n DESC LIMIT 60))").run(searchId, searchId);
    } finally { checkingPlaces.delete(searchId); kwMemo.delete(searchId); }
  }

  function loadRows(searchId) {
    let m = kwMemo.get(searchId);
    if (m) return m;
    const sr = db.prepare('SELECT * FROM searches WHERE id=?').get(searchId);
    if (!sr) return null;
    const seedTok = new Set(sr.seed.split(',').flatMap((x) => norm(x).split(' ')));
    const rows = db.prepare('SELECT phrase,sources,occ,score,band,intent,place,fringe FROM keywords WHERE search_id=? ORDER BY score DESC, phrase').all(searchId)
      .map((r) => ({ ...r, sources: r.sources.split(','), terms: intent.termsOf(r.phrase, seedTok) }));
    m = { search: sr, rows };
    kwMemo.set(searchId, m);
    return m;
  }

  function filterRows(rows, q, skip) {
    const words = norm(q.q || '').split(' ').filter(Boolean);
    const excl = String(q.exclude || '').split(',').map((x) => norm(x)).filter(Boolean).map((x) => new RegExp('(^|\\s)' + esc(x) + '(\\s|$)'));
    const minSrc = +q.minSources || 1;
    const terms = skip === 'term' ? [] : String(q.term || '').split('|').map(norm).filter(Boolean);
    return rows.filter((r) => {
      if (words.length && !words.every((w) => r.phrase.includes(w))) return false;
      if (excl.length && excl.some((re) => re.test(r.phrase))) return false;
      if (r.sources.length < minSrc) return false;
      if (q.hideFringe === '1' && r.fringe) return false;
      if (q.band && r.band !== q.band) return false;
      if (q.source && !r.sources.includes(q.source)) return false;
      if (skip !== 'intent' && q.intent && r.intent !== q.intent) return false;
      if (skip !== 'place' && q.place && r.place !== q.place) return false;
      for (const t of terms) if (!r.terms.has(t)) return false;
      return true;
    });
  }

  function queryKeywords(searchId, q) {
    const m = loadRows(searchId);
    if (!m) throw httpErr(404, 'Scan not found');
    const all = m.rows;
    const rows = filterRows(all, q);
    const count = (arr, f) => { const c = new Map(); for (const r of arr) { const k = f(r); if (k) c.set(k, (c.get(k) || 0) + 1); } return c; };
    const intents = [...count(filterRows(all, q, 'intent'), (r) => r.intent)].map(([k, n]) => ({ k, n, label: (intent.META[k] || {}).label || k })).sort((a, b) => b.n - a.n);
    const placesF = [...count(filterRows(all, q, 'place'), (r) => r.place)].map(([k, n]) => ({ k, n })).sort((a, b) => b.n - a.n).slice(0, 40);
    const tcount = new Map();
    for (const r of filterRows(all, q, 'term')) for (const t of r.terms) tcount.set(t, (tcount.get(t) || 0) + 1);
    const min = rows.length > 400 ? 4 : 2;
    const chosen = new Set(String(q.term || '').split('|').map(norm).filter(Boolean));
    const termsF = [...tcount].filter(([t, n]) => n >= min || chosen.has(t)).sort((a, b) => b[1] - a[1]).slice(0, 48).map(([k, n]) => ({ k, n }));
    const sort = q.sort || 'score';
    const sorted = sort === 'alpha' ? rows.slice().sort((a, b) => a.phrase.localeCompare(b.phrase)) : sort === 'short' ? rows.slice().sort((a, b) => a.phrase.length - b.phrase.length) : rows;
    const off = Math.max(0, +q.offset || 0), lim = Math.min(500, +q.limit || 100);
    return {
      search: publicSearch(m.search), total: rows.length, all: all.length, fringe: all.filter((r) => r.fringe).length,
      rows: sorted.slice(off, off + lim).map(({ terms, ...r }) => r),
      facets: { intents, places: placesF, terms: termsF }, checkingPlaces: checkingPlaces.has(searchId),
      intentMeta: intent.META,
    };
  }
  const publicSearch = (s) => ({ id: s.id, seed: s.seed, country: s.country, lang: s.lang, city: s.city, depth: s.depth, sources: s.sources.split(','), requests: s.requests, phrases: s.phrases, status: s.status, note: s.note, created: s.created });

  /* ------------------------------------------------------------ leads */
  function importLeads(rows, source, seed, query) {
    const s = S();
    const out = { inserted: 0, updated: 0, skipped: 0 };
    db_.tx(db, () => {
      for (const r of rows) {
        const city = r.city || '';
        const lead = { ...r, source, seed: seed || r.seed || '', query: query || r.query || '', area: r.area || messages.guessArea(r.address, city) };
        const res = leadsLib.upsert(db, lead, s);
        if (res.skipped) out.skipped++; else if (res.inserted) out.inserted++; else out.updated++;
      }
    });
    return out;
  }

  function startFind(body) {
    const s = S();
    if (!s.placesKey) throw httpErr(400, 'Add your Google Places API key in Settings first, or import a CSV instead.');
    const plan = buildPlan(body);
    if (!plan.tasks.length) throw httpErr(400, 'Nothing to search. Add at least one search phrase and a city.');
    const usedDay = db_.usedToday(db, 'places');
    const room = Math.max(0, (s.placesDailyCap || 200) - usedDay);
    if (room <= 0) throw httpErr(400, `Daily Places request cap reached (${s.placesDailyCap}). Raise it in Settings if you want to continue.`);
    const budget = Math.min(room, Math.max(1, +body.maxRequests || plan.worst));
    const job = jobs.create('find', async (job, signal) => {
      job.total = plan.tasks.length; job.message = 'Searching Google Maps…';
      let i = 0, spent = 0, reserved = 0, stopErr = null;
      const worker = async () => {
        while (!signal.aborted && !stopErr) {
          const idx = i++;
          if (idx >= plan.tasks.length) return;
          // reserve the pages this search may use, so parallel workers can never overshoot the cap
          const allow = Math.min(plan.pages, budget - reserved);
          if (allow <= 0) { job.note = `Stopped at your cap of ${budget} requests. Raise it in Settings to search further.`; return; }
          reserved += allow;
          const t = plan.tasks[idx];
          try {
            const r = await places.textSearch({ key: s.placesKey, textQuery: t.text, region: s.country, lang: 'en', bias: t.bias, pages: allow, base: cfg.placesBase, signal });
            reserved -= allow - r.requests;
            spent += r.requests; job.requests = spent; db_.bump(db, 'places', r.requests);
            const res = importLeads(r.places.map((p) => ({ ...p, city: body.city || '' })), 'places', body.seed, t.query);
            job.found += r.places.length; job.fresh += res.inserted;
          } catch (e) {
            if (signal.aborted) return;
            if (e.status === 400 || e.status === 401 || e.status === 403) { stopErr = e; return; }
            job.note = 'Some searches failed: ' + e.message;
          }
          job.done++;
        }
      };
      await Promise.all([worker(), worker()]);
      if (stopErr) throw new Error(explainPlacesError(stopErr));
      job.message = `${job.fresh} new businesses added (${job.found} results, ${job.requests} requests).`;
    });
    return { jobId: job.id };
  }

  function explainPlacesError(e) {
    if (e.status === 403 || e.status === 401) return `Google rejected the key: ${e.message} Check that Places API (New) is enabled and billing is on for the project.`;
    return `Google returned an error: ${e.message}`;
  }

  function buildPlan(body) {
    const queries = [...new Set((body.queries || []).map((q) => String(q).trim()).filter(Boolean))].slice(0, 12);
    const city = String(body.city || '').trim();
    const mode = body.mode || 'city';
    const pages = Math.min(3, Math.max(1, +body.pages || 3));
    const tasks = [];
    if (mode === 'localities') {
      const locs = [...new Set((body.localities || []).map((x) => String(x).trim()).filter(Boolean))].slice(0, 80);
      for (const q of queries) for (const l of locs) tasks.push({ query: q, text: `${q} in ${l}${city ? ', ' + city : ''}` });
    } else if (mode === 'grid') {
      for (const q of queries) for (const p of (body._grid || [])) tasks.push({ query: q, text: `${q}${city ? ' in ' + city : ''}`, bias: p });
    } else {
      for (const q of queries) tasks.push({ query: q, text: `${q}${city ? ' in ' + city : ''}` });
    }
    return { tasks, pages, worst: tasks.length * pages };
  }

  async function planFind(body) {
    if ((body.mode || 'city') === 'grid') {
      const city = String(body.city || '').trim();
      if (!city) throw httpErr(400, 'Grid mode needs a city.');
      const s = S();
      const g = await geo.geocode(db, city, s.country, cfg.nominatimBase);
      if (!g) throw httpErr(400, `Could not find "${city}" on the map. Try a nearby larger city or use Localities mode.`);
      body._grid = geo.grid(g.lat, g.lng, +body.coverKm || 12, +body.stepKm || 4);
    }
    return body;
  }

  function startEnrich(body) {
    const s = S();
    const ids = Array.isArray(body.ids) && body.ids.length ? body.ids.map(Number) : db.prepare("SELECT id FROM leads WHERE website!='' AND enriched=0 AND stage NOT IN ('lost','invalid','won') ORDER BY score DESC LIMIT 500").all().map((r) => r.id);
    const job = jobs.create('enrich', async (job, signal) => {
      job.total = ids.length; job.message = 'Reading business websites…';
      let i = 0;
      const worker = async () => {
        while (!signal.aborted) {
          const idx = i++;
          if (idx >= ids.length) return;
          const l = db.prepare('SELECT id, website FROM leads WHERE id=?').get(ids[idx]);
          if (l && l.website) { const e = await enrichLib.enrich(l.website, signal); const r = leadsLib.applyEnrichment(db, l.id, e, s); if (r && r.ok) job.found++; }
          job.done++;
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
      job.message = `Checked ${job.done} websites, ${job.found} responded.`;
    });
    return { jobId: job.id };
  }

  function listLeads(q) {
    const where = [], args = [];
    if (q.stage) { where.push('stage=?'); args.push(q.stage); }
    if (q.q) { where.push('(name LIKE ? OR area LIKE ? OR phone LIKE ? OR notes LIKE ?)'); const t = '%' + q.q + '%'; args.push(t, t, t, t); }
    if (q.minScore) { where.push('score>=?'); args.push(+q.minScore); }
    if (q.hasPhone === '1') where.push("phone_type!='invalid'");
    if (q.hideApp === '1') where.push("(extra NOT LIKE '%\"hasApp\":\"yes\"%')");
    if (q.hideChains === '1') where.push("(signals NOT LIKE '%franchise or chain%')");
    if (q.query) { where.push('query=?'); args.push(q.query); }
    const order = { score: 'score DESC', new: 'created DESC', name: 'name COLLATE NOCASE', follow: 'next_followup ASC' }[q.sort] || 'score DESC';
    const total = db.prepare(`SELECT COUNT(*) n FROM leads ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`).get(...args).n;
    const off = Math.max(0, +q.offset || 0), lim = Math.min(300, +q.limit || 100);
    const rows = db.prepare(`SELECT * FROM leads ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order}, id DESC LIMIT ? OFFSET ?`).all(...args, lim, off).map(leadsLib.hydrate);
    const stages = db.prepare('SELECT stage k, COUNT(*) n FROM leads GROUP BY stage').all();
    const queries = db.prepare("SELECT query k, COUNT(*) n FROM leads WHERE query!='' GROUP BY query ORDER BY n DESC LIMIT 20").all();
    return { total, rows, stages, queries };
  }

  const PATCHABLE = ['name', 'address', 'area', 'city', 'website', 'email', 'instagram', 'facebook', 'contact_name', 'notes', 'lang', 'stage', 'maps_url'];
  function patchLead(id, body) {
    const l = db.prepare('SELECT * FROM leads WHERE id=?').get(id);
    if (!l) throw httpErr(404, 'Lead not found');
    const set = {};
    for (const k of PATCHABLE) if (k in body) set[k] = String(body[k] == null ? '' : body[k]).slice(0, 2000);
    if ('phone' in body) {
      const ph = leadsLib.normPhone(body.phone, S().cc);
      Object.assign(set, { phone: String(body.phone).slice(0, 40), wa: ph.wa, phone_type: ph.type });
    }
    if (set.lang && !['en', 'ta'].includes(set.lang)) delete set.lang;
    if (set.stage && !['new', 'contacted', 'replied', 'pilot', 'won', 'lost', 'invalid'].includes(set.stage)) delete set.stage;
    const keys = Object.keys(set);
    if (keys.length) db.prepare(`UPDATE leads SET ${keys.map((k) => k + '=?').join(',')}, updated=? WHERE id=?`).run(...keys.map((k) => set[k]), Date.now(), id);
    leadsLib.rescore(db, id, S());
    return leadsLib.hydrate(db.prepare('SELECT * FROM leads WHERE id=?').get(id));
  }

  const HEAD = {
    name: ['name', 'title', 'business name', 'business', 'company', 'place name', 'centre', 'center', 'organization'],
    phone: ['phone', 'phone number', 'phonenumber', 'mobile', 'mobile number', 'contact number', 'telephone', 'phone_number', 'phone unformatted', 'phoneunformatted', 'whatsapp'],
    website: ['website', 'site', 'web', 'homepage'],
    url: ['url', 'link', 'google maps url', 'maps url', 'maps link', 'google_maps_url', 'googlemapsurl', 'google maps link'],
    address: ['address', 'full address', 'street', 'location'],
    city: ['city'],
    area: ['area', 'locality', 'neighborhood', 'neighbourhood'],
    rating: ['rating', 'totalscore', 'stars', 'review rating'],
    reviews: ['reviews', 'reviewscount', 'reviews_count', 'user_ratings_total', 'review count', 'reviews count', 'number of reviews'],
    email: ['email', 'emails', 'email address'],
    place_id: ['place_id', 'placeid', 'place id'],
    notes: ['notes', 'note'],
    contact_name: ['contact name', 'contact', 'owner', 'teacher'],
  };
  function csvToLeads(text) {
    const rows = csv.parse(text);
    if (rows.length < 2) throw httpErr(400, 'The file has no rows.');
    const head = rows[0].map((h) => norm(h));
    const col = (key) => { for (const n of HEAD[key]) { const i = head.indexOf(n); if (i >= 0) return i; } return -1; };
    const idx = Object.fromEntries(Object.keys(HEAD).map((k) => [k, col(k)]));
    if (idx.name < 0) throw httpErr(400, 'Could not find a name column. Expected a header such as "name", "title" or "business name".');
    return rows.slice(1).map((r) => {
      const g = (k) => (idx[k] >= 0 ? (r[idx[k]] || '').trim() : '');
      const lead = { name: g('name'), phone: g('phone'), website: g('website'), address: g('address'), city: g('city'), area: g('area'), email: g('email'), place_id: g('place_id'), notes: g('notes'), contact_name: g('contact_name'),
        rating: g('rating') ? parseFloat(g('rating')) : null, reviews: g('reviews') ? parseInt(String(g('reviews')).replace(/\D/g, ''), 10) : null };
      const u = g('url');
      if (u) { if (/google\.[a-z.]+\/maps|maps\.app\.goo\.gl|goo\.gl\/maps/i.test(u)) lead.maps_url = u; else if (!lead.website) lead.website = u; }
      return lead;
    }).filter((l) => l.name);
  }

  /* ------------------------------------------------------------ routes */
  const routes = [];
  const route = (method, pattern, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn });

  route('GET', '/api/state', () => {
    const s = S();
    const q = leadsLib.queue(db, s);
    return { hasPlaces: !!s.placesKey, hasAnthropic: !!s.anthropicKey, placesUsedToday: db_.usedToday(db, 'places'), placesDailyCap: s.placesDailyCap, due: q.due.length, fresh: q.fresh.length, leads: db.prepare('SELECT COUNT(*) n FROM leads').get().n, node: process.version };
  });
  route('GET', '/api/settings', () => ({ settings: settingsLib.publicView(S()), steps: leadsLib.STEPS }));
  route('PUT', '/api/settings', ({ body }) => { settingsLib.save(db, body); return { settings: settingsLib.publicView(S()) }; });

  route('GET', '/api/sources', () => ({ sources: Object.entries(suggest.SOURCES).map(([id, x]) => ({ id, label: x.label, default: suggest.DEFAULT_SOURCES.includes(id) })) }));
  route('GET', '/api/apps', async ({ query }) => {
    const term = String(query.term || '').trim().slice(0, 80);
    if (!term) throw httpErr(400, 'Enter a topic first.');
    try { return await appsLib.searchApps(term, /^[A-Za-z]{2}$/.test(query.country || '') ? query.country : S().country, 25, cfg.appsBase); } catch (e) { throw httpErr(502, e.message); }
  });
  route('POST', '/api/expand', ({ body }) => startExpand(body));
  route('GET', '/api/jobs/:id', ({ params }) => { const j = jobs.get(params.id); if (!j) throw httpErr(404, 'Job not found'); return jobs.view(j); });
  route('POST', '/api/jobs/:id/stop', ({ params }) => ({ ok: jobs.stop(params.id) }));
  route('GET', '/api/searches', () => ({ searches: db.prepare('SELECT * FROM searches ORDER BY id DESC LIMIT 50').all().map(publicSearch) }));
  route('DELETE', '/api/searches/:id', ({ params }) => { db.prepare('DELETE FROM keywords WHERE search_id=?').run(+params.id); db.prepare('DELETE FROM searches WHERE id=?').run(+params.id); kwMemo.delete(+params.id); return { ok: true }; });
  route('GET', '/api/searches/:id/keywords', ({ params, query }) => queryKeywords(+params.id, query));
  route('GET', '/api/searches/:id/export.csv', ({ params, query }) => {
    const m = loadRows(+params.id);
    if (!m) throw httpErr(404, 'Scan not found');
    const rows = filterRows(m.rows, query);
    const out = [['phrase', 'score', 'strength', 'intent', 'place', 'sources', 'possibly_other_meaning']].concat(rows.map((x) => [x.phrase, x.score, x.band, x.intent, x.place, x.sources.join('+'), x.fringe ? 'yes' : '']));
    return { csv: csv.stringify(out), filename: `topic-radar-${m.search.seed.replace(/\W+/g, '-')}.csv` };
  });
  route('POST', '/api/ai/insights', async ({ body }) => {
    const s = S();
    if (!s.anthropicKey) throw httpErr(400, 'Add an Anthropic API key in Settings to use AI insights.');
    const id = +body.searchId;
    const r = queryKeywords(id, { hideFringe: '1', limit: 150 });
    const seed = r.search.seed;
    try {
      const out = await ai.insights({ key: s.anthropicKey, model: s.aiModel, seed, city: r.search.city, total: r.total, intents: r.facets.intents.map((x) => [x.label, x.n]), places: r.facets.places.slice(0, 15).map((x) => [x.k, x.n]), top: r.rows, base: cfg.anthropicBase });
      return out;
    } catch (e) { throw httpErr(502, e.message); }
  });

  route('POST', '/api/leads/plan', async ({ body }) => {
    await planFind(body);
    const p = buildPlan(body);
    const s = S();
    const room = Math.max(0, (s.placesDailyCap || 200) - db_.usedToday(db, 'places'));
    return { searches: p.tasks.length, worstRequests: p.worst, roomToday: room, estUsd: +(p.worst * 0.035).toFixed(2), sample: p.tasks.slice(0, 3).map((t) => t.text) };
  });
  route('POST', '/api/leads/find', async ({ body }) => { await planFind(body); return startFind(body); });
  route('POST', '/api/leads/enrich', ({ body }) => startEnrich(body || {}));
  route('POST', '/api/leads/import', ({ body }) => {
    const rows = csvToLeads(String(body.csv || ''));
    if (rows.length > 20000) throw httpErr(400, 'Too many rows (max 20,000).');
    return importLeads(rows, 'import', body.seed, body.query || 'csv import');
  });
  route('POST', '/api/leads', ({ body }) => {
    const s = S();
    if (!body.name) throw httpErr(400, 'Name is required.');
    const res = leadsLib.upsert(db, { ...body, source: 'manual', area: body.area || messages.guessArea(body.address, body.city) }, s);
    if (res.skipped) throw httpErr(400, 'Could not add: ' + res.skipped);
    return leadsLib.hydrate(db.prepare('SELECT * FROM leads WHERE id=?').get(res.id));
  });
  route('GET', '/api/leads', ({ query }) => listLeads(query));
  route('GET', '/api/leads/export.csv', () => {
    const rows = db.prepare('SELECT * FROM leads ORDER BY score DESC').all().map(leadsLib.hydrate);
    const out = [['name', 'area', 'city', 'phone', 'whatsapp', 'website', 'email', 'rating', 'reviews', 'score', 'stage', 'touches', 'next_action', 'next_followup', 'last_contacted', 'has_app', 'notes', 'maps_url']]
      .concat(rows.map((l) => [l.name, l.area, l.city, l.phone, l.wa, l.website, l.email, l.rating, l.reviews, l.score, l.stage, l.touches, l.next_action || '', l.next_followup ? new Date(l.next_followup).toISOString() : '', l.last_contacted ? new Date(l.last_contacted).toISOString() : '', (l.extra || {}).hasApp || '', l.notes, l.maps_url]));
    return { csv: csv.stringify(out), filename: 'topic-radar-leads.csv' };
  });
  route('GET', '/api/leads/:id', ({ params }) => {
    const l = db.prepare('SELECT * FROM leads WHERE id=?').get(+params.id);
    if (!l) throw httpErr(404, 'Lead not found');
    const lead = leadsLib.hydrate(l);
    return { lead, activities: db.prepare('SELECT * FROM activities WHERE lead_id=? ORDER BY at DESC LIMIT 100').all(+params.id), action: messages.action(lead, S()) };
  });
  route('PATCH', '/api/leads/:id', ({ params, body }) => patchLead(+params.id, body));
  route('DELETE', '/api/leads/:id', ({ params }) => { db.prepare('DELETE FROM activities WHERE lead_id=?').run(+params.id); db.prepare('DELETE FROM leads WHERE id=?').run(+params.id); return { ok: true }; });
  route('POST', '/api/leads/:id/event', ({ params, body }) => {
    const lead = leadsLib.logEvent(db, +params.id, body.ev, body);
    return { lead, action: messages.action(lead, S()) };
  });
  route('POST', '/api/leads/:id/enrich', async ({ params }) => {
    const l = db.prepare('SELECT id, website FROM leads WHERE id=?').get(+params.id);
    if (!l) throw httpErr(404, 'Lead not found');
    if (!l.website) throw httpErr(400, 'This lead has no website to check.');
    const r = leadsLib.applyEnrichment(db, l.id, await enrichLib.enrich(l.website), S());
    return { result: r, lead: leadsLib.hydrate(db.prepare('SELECT * FROM leads WHERE id=?').get(l.id)) };
  });
  route('POST', '/api/leads/:id/render', ({ params, body }) => {
    const lead = leadsLib.hydrate(db.prepare('SELECT * FROM leads WHERE id=?').get(+params.id));
    if (!lead) throw httpErr(404, 'Lead not found');
    return messages.action({ ...lead, lang: body.lang || lead.lang }, S(), body.step);
  });

  route('GET', '/api/queue', () => {
    const s = S();
    const q = leadsLib.queue(db, s);
    const shape = (l) => ({ lead: l, action: messages.action(l, s) });
    return { sentToday: q.sentToday, cap: q.cap, waiting: q.waiting, due: q.due.map(shape), fresh: q.fresh.map(shape) };
  });
  route('GET', '/api/funnel', () => leadsLib.funnel(db));

  /* ------------------------------------------------------------ http */
  const HOST_OK = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
  const server = http.createServer(async (req, res) => {
    try {
      if (!HOST_OK.test(req.headers.host || '')) return send(res, 403, { error: 'Forbidden host' });
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET') {
          const origin = req.headers.origin;
          if (origin && !HOST_OK.test(origin.replace(/^https?:\/\//, ''))) return send(res, 403, { error: 'Forbidden origin' });
        }
        const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
        if (!r) return send(res, 404, { error: 'Not found' });
        const params = url.pathname.match(r.re).groups || {};
        const query = Object.fromEntries(url.searchParams);
        const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readJson(req) : {};
        const out = await r.fn({ params, query, body });
        if (out && out.csv !== undefined) {
          res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${out.filename}"` });
          return res.end('﻿' + out.csv);
        }
        return send(res, 200, out);
      }
      return serveStatic(url.pathname, res);
    } catch (e) {
      if (!e.status) console.error(e);
      send(res, e.status || 500, { error: e.status ? e.message : 'Something went wrong: ' + e.message });
    }
  });

  return { server, db, close: () => { server.close(); db.close(); } };
}

function httpErr(status, message) { const e = new Error(message); e.status = status; return e; }
function send(res, code, obj) { const b = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(b); }
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 8 * 1024 * 1024) { reject(httpErr(413, 'Request too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { const t = Buffer.concat(chunks).toString('utf8'); resolve(t ? JSON.parse(t) : {}); } catch { reject(httpErr(400, 'Invalid JSON')); } });
    req.on('error', reject);
  });
}
function serveStatic(p, res) {
  const root = path.join(__dirname, 'public');
  const file = path.normalize(path.join(root, p === '/' ? 'index.html' : p));
  if (!file.startsWith(root)) return send(res, 403, { error: 'Forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

module.exports = { createApp };

if (require.main === module) {
  const port = +process.env.PORT || 4173;
  const app = createApp();
  app.server.listen(port, '127.0.0.1', () => {
    console.log(`\n  Topic Radar is running:  http://localhost:${port}\n  Data is stored in ${path.join(__dirname, 'data')}\n  Press Ctrl+C to stop.\n`);
  });
}
