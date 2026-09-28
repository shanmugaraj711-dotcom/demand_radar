'use strict';
// Real keyword data from the public autocomplete endpoints of Google, Bing, YouTube, DuckDuckGo, Yahoo, eBay and Amazon.
// These are unofficial but free and keyless. We stay polite: low concurrency, caching, backoff.
const { sleep, jitter, norm } = require('./util');
const { intentOf, placeOf, termsOf } = require('./intent');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const enc = encodeURIComponent;

const SOURCES = {
  google: {
    label: 'Google',
    url: (q, o) => `https://suggestqueries.google.com/complete/search?client=firefox&q=${enc(q)}&hl=${o.lang}&gl=${o.country}`,
    parse: (t) => JSON.parse(t)[1],
  },
  bing: {
    label: 'Bing',
    url: (q, o) => `https://api.bing.com/osjson.aspx?query=${enc(q)}&mkt=${o.lang}-${o.country}`,
    parse: (t) => JSON.parse(t)[1],
  },
  youtube: {
    label: 'YouTube',
    url: (q, o) => `https://suggestqueries.google.com/complete/search?client=youtube&ds=yt&q=${enc(q)}&hl=${o.lang}&gl=${o.country}`,
    parse: (t) => { const m = t.match(/\((\[[\s\S]*\])\)\s*;?\s*$/); return JSON.parse(m[1])[1].map((x) => x[0]); },
  },
  duckduckgo: {
    label: 'DuckDuckGo',
    url: (q, o) => `https://duckduckgo.com/ac/?q=${enc(q)}&type=list&kl=${o.country}-${o.lang}`,
    parse: (t) => JSON.parse(t)[1],
  },
  yahoo: {
    label: 'Yahoo',
    url: (q) => `https://search.yahoo.com/sugg/gossip/gossip-us-ff?output=fxjson&command=${enc(q)}`,
    parse: (t) => JSON.parse(t)[1],
  },
  ebay: {
    label: 'eBay (shopping)',
    url: (q) => `https://autosug.ebay.com/autosug?kwd=${enc(q)}&sId=0&_jgr=1&callback=cb`,
    parse: (t) => { const m = t.match(/cb\(([\s\S]*)\)\s*;?\s*$/); return (JSON.parse(m[1]).res || {}).sug || []; },
  },
  amazon: {
    label: 'Amazon US (shopping)',
    url: (q) => `https://completion.amazon.com/api/2017/suggestions?mid=ATVPDKIKX0DER&alias=aps&prefix=${enc(q)}`,
    parse: (t) => JSON.parse(t).suggestions.map((x) => x.value),
  },
};
// Sources ticked by default. The rest are optional because each one adds a full round of requests.
const DEFAULT_SOURCES = ['google', 'bing', 'youtube', 'duckduckgo'];

const LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('');
const DIGITS = '0123456789'.split('');
const SUFFIX = ['near me', 'for kids', 'for adults', 'for beginners', 'online', 'app', 'free', 'price', 'fees', 'class', 'classes', 'course',
  'training', 'teacher', 'certificate', 'franchise', 'worksheet', 'pdf', 'best', 'vs', 'how to', 'what is', 'why', 'where', 'can', 'is', 'in',
  'with', 'and', 'tutorial', 'video', 'books', 'competition', 'exam', 'jobs', 'business', 'software', 'game', 'apk', 'download', 'review',
  'institute', 'centre', 'center', 'academy', 'coaching', 'tuition', 'at home', 'timing', 'contact', 'address', 'login', 'syllabus', 'level',
  'age', 'benefits', 'tips', 'tricks', 'practice', 'test', 'for school', 'in tamil', 'in hindi', 'in english',
  'buy', 'cheap', 'for men', 'for women', 'brands', 'reviews', 'alternatives', 'under', 'kit', 'set', 'near', 'cost'];
const PREFIX = ['best', 'how to', 'what is', 'why', 'free', 'online', 'top', 'learn', 'buy', 'cheap', 'near'];

const DEPTHS = {
  quick: { digits: false, prefixLetters: false, l2: 0, l2Sources: [], l2Letters: LETTERS },
  deep: { digits: true, prefixLetters: true, l2: 20, l2Sources: ['google'], l2Letters: LETTERS },
  max: { digits: true, prefixLetters: true, l2: 60, l2Sources: ['google', 'bing'], l2Letters: LETTERS },
};

function level1(seeds, city, depth, sources) {
  const d = DEPTHS[depth] || DEPTHS.quick;
  const t = [];
  for (const source of sources) {
    for (const seed of seeds) {
      t.push({ source, q: seed, w: 1 });
      for (const m of SUFFIX) t.push({ source, q: `${seed} ${m}`, w: 1 });
      for (const m of PREFIX) t.push({ source, q: `${m} ${seed}`, w: 0.9 });
      for (const l of LETTERS) t.push({ source, q: `${seed} ${l}`, w: 0.8 });
      if (d.digits) for (const l of DIGITS) t.push({ source, q: `${seed} ${l}`, w: 0.8 });
      if (d.prefixLetters) for (const l of LETTERS) t.push({ source, q: `${l} ${seed}`, w: 0.6 });
      if (city) {
        t.push({ source, q: `${seed} ${city}`, w: 1 }, { source, q: `${seed} in ${city}`, w: 1 },
          { source, q: `${seed} classes in ${city}`, w: 1 }, { source, q: `${seed} near ${city}`, w: 0.9 });
      }
    }
  }
  return dedupe(t);
}

const dedupe = (tasks) => { const s = new Set(); return tasks.filter((x) => { const k = x.source + '|' + x.q; if (s.has(k)) return false; s.add(k); return true; }); };

class Aggregator {
  constructor(seeds, nSources) {
    this.map = new Map();
    this.nSources = nSources;
    this.seedTokens = seeds.map((s) => norm(s).split(' '));
    this.seeds = new Set(seeds.map(norm));
  }
  relevant(p) { return this.seedTokens.some((toks) => toks.every((t) => p.includes(t))); }
  add(phrase, source, pos, w) {
    const p = norm(phrase);
    if (!p || p.length > 90 || this.seeds.has(p) || !this.relevant(p)) return;
    let e = this.map.get(p);
    if (!e) { e = { phrase: p, sources: new Set(), occ: 0, best: 0 }; this.map.set(p, e); }
    e.sources.add(source);
    e.occ++;
    const v = w * (1 - Math.min(pos, 9) / 10);
    if (v > e.best) e.best = v;
  }
  // Score 0-100 = position in suggestion lists (50%) + how many sources agree (30%) + how often it surfaced (20%).
  // It ranks phrases by how strongly search engines surface them. It is not search volume.
  rows() {
    const arr = [...this.map.values()].map((e) => {
      const raw = 0.5 * e.best + 0.3 * (e.sources.size / this.nSources) + 0.2 * Math.min(1, Math.log(1 + e.occ) / Math.log(11));
      return { phrase: e.phrase, sources: [...e.sources].sort(), occ: e.occ, score: Math.round(raw * 100) };
    });
    arr.sort((a, b) => b.score - a.score || a.phrase.localeCompare(b.phrase));
    const n = arr.length;
    // Core vocabulary = terms that recur among the 100 strongest phrases. A phrase with no core term found by a
    // single source is probably another meaning of the seed word (for "abacus": valves, insurance, software).
    const seedTok = new Set(this.seedTokens.flat());
    const core = new Map();
    arr.slice(0, 100).forEach((r) => { for (const t of termsOf(r.phrase, seedTok)) core.set(t, (core.get(t) || 0) + 1); });
    const coreSet = new Set([...core].filter(([, c]) => c >= 3).map(([t]) => t));
    arr.forEach((r, i) => {
      const weak = this.nSources >= 2 ? r.sources.length < 2 : r.occ < 2; // with one source, "surfaced by a single query" is the weak signal
      r.intent = intentOf(r.phrase);
      // fringe = weak support, no shared vocabulary with the strongest phrases, and no recognisable intent
      r.fringe = weak && r.intent === 'other' && ![...termsOf(r.phrase, seedTok)].some((t) => coreSet.has(t)) ? 1 : 0;
      r.band = i < n * 0.15 ? 'high' : i < n * 0.5 ? 'medium' : 'low';
      r.place = placeOf(r.phrase);
    });
    return arr;
  }
  top(n) {
    return this.rows().filter((r) => r.phrase.split(' ').length <= 4).slice(0, n).map((r) => r.phrase);
  }
}

async function fetchOne(source, q, o, signal) {
  const s = SOURCES[source];
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 9000);
  const onAbort = () => ctl.abort();
  signal && signal.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(s.url(q, o), { headers: { 'User-Agent': UA, 'Accept-Language': o.lang }, signal: ctl.signal, redirect: 'manual' });
    if (res.status === 429 || res.status === 403 || res.status === 503 || (res.status >= 300 && res.status < 400)) return { status: 'rate' };
    if (!res.ok) return { status: 'err' };
    const text = await res.text();
    try { const list = s.parse(text); return Array.isArray(list) ? { status: 'ok', list: list.map(String) } : { status: 'err' }; } catch { return { status: 'err' }; }
  } catch { return { status: 'err' }; } finally { clearTimeout(timer); signal && signal.removeEventListener('abort', onAbort); }
}

/**
 * opts: seeds[], country, lang, depth, sources[], city, signal, cache{get,set}, onFlush(rows), onProgress({done,total,requests,phrases,message}),
 *       concurrency, gapMs
 * Returns { requests, phrases, partial, note }
 */
async function expand(opts) {
  const { seeds, country = 'IN', lang = 'en', depth = 'quick', city = '', signal, cache, onFlush, onProgress } = opts;
  const sources = (opts.sources || DEFAULT_SOURCES).filter((s) => SOURCES[s]);
  const conc = opts.concurrency || 4;
  const gap = opts.gapMs == null ? 90 : opts.gapMs;
  const ctx = { country: country.toLowerCase(), lang };
  const agg = new Aggregator(seeds, sources.length);
  const state = { done: 0, total: 0, requests: 0, cached: 0, notes: [] };
  const sh = Object.fromEntries(sources.map((s) => [s, { pausedUntil: 0, strikes: 0, off: false, errs: 0 }]));

  const runTasks = async (tasks) => {
    state.total += tasks.length;
    let i = 0, sinceFlush = 0;
    const worker = async () => {
      while (!(signal && signal.aborted)) {
        const idx = i++;
        if (idx >= tasks.length) return;
        const t = tasks[idx];
        const st = sh[t.source];
        if (st.off) { state.done++; continue; }
        const ck = `sg:${t.source}:${ctx.lang}:${ctx.country}:${norm(t.q)}`;
        let list = cache && cache.get(ck);
        if (list) state.cached++;
        else {
          while (st.pausedUntil > Date.now() && !(signal && signal.aborted)) await sleep(Math.min(1000, st.pausedUntil - Date.now()), signal);
          await sleep(jitter(gap), signal);
          let r = await fetchOne(t.source, t.q, ctx, signal);
          state.requests++;
          if (r.status !== 'ok' && !(signal && signal.aborted)) { await sleep(500, signal); r = await fetchOne(t.source, t.q, ctx, signal); state.requests++; }
          if (r.status === 'ok') { st.strikes = 0; st.errs = 0; list = r.list; cache && cache.set(ck, list); }
          else if (r.status === 'rate') {
            st.strikes++;
            if (st.strikes >= 4) { st.off = true; state.notes.push(`${SOURCES[t.source].label} asked us to slow down, so we stopped using it for this scan.`); }
            else st.pausedUntil = Date.now() + 15000 * st.strikes;
          } else if (++st.errs >= 25) { st.off = true; state.notes.push(`${SOURCES[t.source].label} kept failing, so we stopped using it for this scan.`); }
        }
        if (list) list.forEach((p, pos) => agg.add(p, t.source, pos, t.w));
        state.done++;
        if (++sinceFlush >= 120) { sinceFlush = 0; flush(); }
        else if (state.done % 10 === 0) progress();
      }
    };
    await Promise.all(Array.from({ length: conc }, worker));
  };
  const progress = (message) => onProgress && onProgress({ done: state.done, total: state.total, requests: state.requests, cached: state.cached, phrases: agg.map.size, message: message || '' });
  const flush = () => { onFlush && onFlush(agg.rows()); progress(); };

  progress('Asking search engines what people type…');
  await runTasks(level1(seeds, city, depth, sources));
  flush();

  const d = DEPTHS[depth] || DEPTHS.quick;
  if (d.l2 && !(signal && signal.aborted)) {
    const l2src = d.l2Sources.filter((s) => sources.includes(s) && !sh[s].off);
    if (l2src.length) {
      const base = agg.top(d.l2);
      const l2 = [];
      for (const source of l2src) for (const p of base) for (const l of d.l2Letters) l2.push({ source, q: `${p} ${l}`, w: 0.6 });
      progress(`Going deeper on the top ${base.length} phrases…`);
      await runTasks(dedupe(l2));
      flush();
    }
  }
  const active = sources.filter((s) => !sh[s].off);
  return { requests: state.requests, cached: state.cached, phrases: agg.map.size, partial: active.length < sources.length || !!(signal && signal.aborted), note: state.notes.join(' ') };
}

module.exports = { expand, SOURCES, DEFAULT_SOURCES, DEPTHS, level1, Aggregator, fetchOne };
