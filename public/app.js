'use strict';
/* Topic Radar front end. Plain JS, no build step. All text goes through textContent, never innerHTML. */

/* ---------------------------------------------------------------- helpers */
const $ = (s, r = document) => r.querySelector(s);
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn);
    else if (['value', 'checked', 'disabled', 'hidden', 'textContent', 'selected'].includes(k)) e[k] = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}
const clear = (el) => { el.textContent = ''; return el; };
const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : '');
const num = (n) => Number(n || 0).toLocaleString();
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

async function api(method, url, body) {
  let r;
  try { r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); }
  catch { throw new Error('Cannot reach the Topic Radar server. Is it still running?'); }
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && j.login) { location.href = '/login.html'; throw new Error('Login required'); }
  if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
  return j;
}
const qs = (o) => Object.entries(o).filter(([, v]) => v !== '' && v != null && v !== false).map(([k, v]) => `${k}=${encodeURIComponent(v === true ? '1' : v)}`).join('&');

let toastT;
function toast(msg, ms = 3200) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms); }
const fail = (e) => toast(e.message || String(e), 5000);

function when(ts) {
  if (!ts) return '';
  const d = new Date(ts), now = new Date();
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(now)) / 864e5);
  const hm = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (diff === 0) return (d <= now ? 'now' : 'today ') + (d <= now ? '' : hm);
  if (diff === 1) return 'tomorrow ' + hm;
  if (diff === -1) return 'yesterday';
  if (diff < 0) return `${-diff} days ago`;
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ' ' + hm;
}
const ago = (ts) => { const s = (Date.now() - ts) / 1000; return s < 90 ? 'just now' : s < 3600 ? Math.round(s / 60) + ' min ago' : s < 86400 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' days ago'; };

const COUNTRIES = [['IN', 'India'], ['SG', 'Singapore'], ['MY', 'Malaysia'], ['AE', 'UAE'], ['LK', 'Sri Lanka'], ['GB', 'United Kingdom'], ['US', 'United States'], ['CA', 'Canada'], ['AU', 'Australia'], ['BD', 'Bangladesh'], ['PK', 'Pakistan'], ['NP', 'Nepal']];
const LANGS = [['en', 'English'], ['ta', 'Tamil'], ['hi', 'Hindi'], ['te', 'Telugu'], ['kn', 'Kannada'], ['ml', 'Malayalam'], ['mr', 'Marathi'], ['bn', 'Bengali']];
const DEPTHS = [['quick', 'Quick: about 300 requests, under a minute'], ['deep', 'Deep: about 800 requests, a few minutes'], ['max', 'Max: thousands of requests, 10+ minutes']];
const LOCALITIES = {
  chennai: 'Adyar, Anna Nagar, T. Nagar, Velachery, Tambaram, Porur, Ambattur, Avadi, Perungalathur, Virugambakkam, West Mambalam, Kasturba Nagar, Chromepet, Guindy, Mylapore, Kodambakkam, Nungambakkam, Sholinganallur, Medavakkam, Perambur, Kolathur, Madipakkam, Thiruvanmiyur, Pallavaram, Mogappair, Kilpauk, Royapettah, Saidapet, Ashok Nagar, Vadapalani',
};
const opts = (list, val) => list.map(([v, l]) => h('option', { value: v, selected: v === val }, l));

const S = { tab: 'radar', state: null, steps: {} };

/* ---------------------------------------------------------------- job tracker */
async function trackJob(box, jobId, { onTick, label } = {}) {
  clear(box);
  const txt = h('div', {}, h('span', { class: 'spinner' }), ' ', label || 'Working…');
  const bar = h('div', { class: 'bar' }, h('i', { style: 'width:2%' }));
  const stopBtn = h('button', { class: 'btn sm', on: { click: () => api('POST', `/api/jobs/${jobId}/stop`).catch(fail) } }, 'Stop');
  box.append(h('div', { class: 'prog' }, h('div', { class: 'row' }, h('div', { style: 'flex:1' }, txt), stopBtn), bar));
  box.hidden = false;
  for (;;) {
    let j;
    try { j = await api('GET', '/api/jobs/' + jobId); } catch (e) { clear(box); box.append(h('div', { class: 'notice err' }, e.message)); return null; }
    const pct = j.total ? Math.max(2, Math.round((j.done / j.total) * 100)) : 2;
    bar.firstChild.style.width = pct + '%';
    txt.textContent = '';
    txt.append(h('span', { class: 'spinner' }), ' ', j.message || label || 'Working…', j.total ? `  ${num(j.done)} of ${num(j.total)}` : '', j.found ? `  ·  ${num(j.found)} found` : '');
    onTick && onTick(j);
    if (j.status !== 'running') {
      clear(box);
      if (j.status === 'error') box.append(h('div', { class: 'notice err' }, j.error));
      else {
        box.append(h('div', { class: 'notice ok' }, (j.status === 'stopped' ? 'Stopped. ' : '') + (j.message || 'Done.')));
        if (j.note) box.append(h('div', { class: 'notice' }, j.note));
      }
      return j;
    }
    await new Promise((r) => setTimeout(r, 700));
  }
}

/* ---------------------------------------------------------------- shell */
async function refreshState() {
  try {
    S.state = await api('GET', '/api/state');
    const b = $('#qbadge'), n = S.state.due;
    b.hidden = !n; b.textContent = n;
    $('#logout').hidden = !S.state.auth;
    const p = $('#keypill');
    p.className = 'pill ' + (S.state.hasPlaces ? 'ok' : 'warn');
    p.textContent = S.state.hasPlaces ? `Maps ✓  ${S.state.placesUsedToday}/${S.state.placesDailyCap} today` : 'Add Google Maps key';
  } catch (e) { $('#keypill').textContent = 'Server offline'; }
}
const views = {};
function go(tab) {
  S.tab = tab;
  history.replaceState(null, '', '#' + tab);
  document.querySelectorAll('#tabs button').forEach((b) => (b.getAttribute('data-tab') === tab ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')));
  document.querySelectorAll('main > section').forEach((s) => (s.hidden = s.id !== 'tab-' + tab));
  closeDrawer();
  const v = views[tab];
  const sec = $('#tab-' + tab);
  if (v && !sec.dataset.built) { sec.dataset.built = '1'; v.build(sec); }
  v && v.show && v.show();
  refreshState();
}
document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => go(b.getAttribute('data-tab'))));
$('#keypill').addEventListener('click', () => go('settings'));
$('#logout').addEventListener('click', async () => { try { await api('POST', '/api/logout'); } catch { /* ignore */ } location.href = '/login.html'; });

// Coming back from WhatsApp: ask once whether the message was sent, so the follow-up schedule stays accurate.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !S.waPending) return;
  const p = S.waPending; S.waPending = null;
  if (!p.box.isConnected) return;
  const banner = h('div', { class: 'notice info', style: 'margin-top:10px' }, `Did you send the message to ${p.lead.name}? `,
    h('button', { class: 'btn sm pri', on: { click: () => p.ev('sent') } }, 'Yes, sent'), ' ', h('button', { class: 'btn sm', on: { click: () => banner.remove() } }, 'Not yet'));
  p.box.append(banner);
});

// A contact card, so WhatsApp and the dialer show the business name instead of a bare number.
function saveContact(lead) {
  const clean = (x) => String(x || '').replace(/[\r\n;,]/g, ' ').trim();
  const tel = lead.wa ? '+' + lead.wa : clean(lead.phone);
  const vcf = ['BEGIN:VCARD', 'VERSION:3.0', 'FN:' + clean(lead.name), 'ORG:' + clean(lead.name), 'TEL;TYPE=CELL:' + tel, lead.website ? 'URL:' + clean(lead.website) : '', 'END:VCARD'].filter(Boolean).join('\r\n');
  const a = h('a', { href: URL.createObjectURL(new Blob([vcf], { type: 'text/vcard' })), download: clean(lead.name).slice(0, 40) + '.vcf' });
  document.body.append(a); a.click(); a.remove();
}

/* ================================================================ RADAR */
const R = { apps: null, searchId: null, data: null, rows: [], selected: new Set(), f: { q: '', intent: '', term: [], place: '', exclude: '', hideFringe: false, minSources: 1, sort: 'score', band: '' }, ai: null, busy: false };

views.radar = {
  build(sec) {
    const seed = h('input', { type: 'text', id: 'r-seed', value: 'abacus', maxlength: 80, placeholder: 'e.g. abacus, or "tailoring classes"' });
    const city = h('input', { type: 'text', id: 'r-city', value: 'Chennai', maxlength: 40, placeholder: 'optional' });
    const country = h('select', { id: 'r-country' }, opts(COUNTRIES, 'IN'));
    const lang = h('select', { id: 'r-lang' }, opts(LANGS, 'en'));
    const depth = h('select', { id: 'r-depth' }, opts(DEPTHS, 'quick'));
    const srcs = h('span', { class: 'row', style: 'gap:10px' });
    api('GET', '/api/sources').then(({ sources }) => sources.forEach((x) => srcs.append(h('label', { class: 'chk', title: x.default ? '' : 'Optional: adds a full round of requests' }, h('input', { type: 'checkbox', checked: x.default, 'data-src': x.id }), x.label)))).catch(() => {});
    const go1 = h('button', { class: 'btn pri', on: { click: scan } }, 'Scan demand');
    seed.addEventListener('keydown', (e) => e.key === 'Enter' && scan());
    R.hist = h('select', { on: { change: (e) => e.target.value && openSearch(+e.target.value) } });
    R.job = h('div', { hidden: true, style: 'margin-top:12px' });
    R.out = h('div');
    sec.append(
      h('div', { class: 'card' },
        h('div', { class: 'head' }, h('h2', {}, 'What are people searching for?'), h('span', { class: 'sub grow' }, 'Type a topic. Get thousands of real phrases from Google, Bing and YouTube suggestions, sorted by who is asking.')),
        h('div', { class: 'grid g2' },
          h('label', { class: 'f' }, 'Topic (comma-separate up to 3)', seed), h('label', { class: 'f' }, 'Your city (adds local phrases)', city),
          h('label', { class: 'f' }, 'Country', country), h('label', { class: 'f' }, 'Language', lang),
          h('label', { class: 'f', style: 'grid-column:1/-1' }, 'How deep', depth)),
        h('div', { class: 'row', style: 'margin-top:12px' }, go1, h('span', { class: 'mute small' }, 'Sources:'), srcs, h('span', { class: 'grow', style: 'flex:1' }), h('label', { class: 'f', style: 'min-width:220px' }, R.hist)),
        R.job),
      R.out);
    loadHistory(true);
  },
  show() { loadHistory(false); },
};

async function loadHistory(openLatest) {
  try {
    const { searches } = await api('GET', '/api/searches');
    clear(R.hist).append(h('option', { value: '' }, searches.length ? 'Previous scans…' : 'No scans yet'), ...searches.map((s) => h('option', { value: s.id, selected: s.id === R.searchId }, `${s.seed}${s.city ? ' · ' + s.city : ''} · ${num(s.phrases)} phrases · ${ago(s.created)}`)));
    if (openLatest && searches.length && !R.searchId) openSearch(searches[0].id);
    else if (!searches.length && !R.searchId) renderEmptyRadar();
  } catch (e) { fail(e); }
}
function renderEmptyRadar() {
  clear(R.out).append(h('div', { class: 'card empty' }, h('h3', {}, 'Start with one word'), h('p', {}, 'Try "abacus", "yoga classes" or "tally course". The first scan takes about half a minute and needs no account or key.')));
}

async function scan() {
  if (R.busy) return;
  const body = { seed: $('#r-seed').value, city: $('#r-city').value, country: $('#r-country').value, lang: $('#r-lang').value, depth: $('#r-depth').value, sources: [...document.querySelectorAll('[data-src]')].filter((c) => c.checked).map((c) => c.getAttribute('data-src')) };
  if (!body.sources.length) return toast('Pick at least one source.');
  R.busy = true;
  try {
    const { jobId, searchId } = await api('POST', '/api/expand', body);
    R.searchId = searchId; R.ai = null; R.apps = null; resetFilters();
    let last = 0;
    const j = await trackJob(R.job, jobId, { label: 'Asking search engines…', onTick: (j) => { if (Date.now() - last > 3500 && j.found) { last = Date.now(); loadKeywords(false, true); } } });
    await loadKeywords(false);
    await loadHistory(false);
    if (j && j.status === 'done' && !j.found) toast('No phrases came back. The search engines may be blocking requests right now. Try again in a few minutes.', 7000);
  } catch (e) { fail(e); } finally { R.busy = false; }
}
function resetFilters() { R.f = { q: '', intent: '', term: [], place: '', exclude: '', hideFringe: false, minSources: 1, sort: 'score', band: '' }; R.selected.clear(); }
async function openSearch(id) { R.searchId = id; R.ai = null; R.apps = null; resetFilters(); R.job.hidden = true; await loadKeywords(false); }

const kwParams = (offset) => qs({ q: R.f.q, intent: R.f.intent, term: R.f.term.join('|'), place: R.f.place, exclude: R.f.exclude, hideFringe: R.f.hideFringe, minSources: R.f.minSources > 1 ? R.f.minSources : '', sort: R.f.sort === 'score' ? '' : R.f.sort, band: R.f.band, offset, limit: 100 });
let kwSeq = 0;
async function loadKeywords(append, keepScroll) {
  const seq = ++kwSeq;
  try {
    const off = append ? R.rows.length : 0;
    const d = await api('GET', `/api/searches/${R.searchId}/keywords?${kwParams(off)}`);
    if (seq !== kwSeq) return;
    R.data = d; R.rows = append ? R.rows.concat(d.rows) : d.rows;
    renderRadar();
    if (d.checkingPlaces) setTimeout(() => { if (seq === kwSeq && S.tab === 'radar') loadKeywords(false, true); }, 6000);
  } catch (e) { fail(e); }
}
const refilter = debounce(() => loadKeywords(false), 250);

function renderRadar() {
  const d = R.data, out = clear(R.out);
  const s = d.search;
  // header
  const head = h('div', { class: 'card', style: 'margin-top:14px' },
    h('div', { class: 'head' },
      h('h2', {}, `${num(d.all)} phrases for "${s.seed}"`),
      h('span', { class: 'sub grow' }, `${s.country} · ${s.lang} · ${s.depth} scan · ${num(s.requests)} requests · ${ago(s.created)}`),
      h('button', { class: 'btn sm danger', on: { click: async () => { if (!confirm('Delete this scan and its phrases?')) return; await api('DELETE', '/api/searches/' + s.id); R.searchId = null; R.data = null; await loadHistory(true); if (!R.searchId) renderEmptyRadar(); } } }, 'Delete scan')),
    s.note ? h('div', { class: 'notice' }, s.note) : null,
    s.status === 'partial' || s.status === 'stopped' ? h('div', { class: 'notice' }, s.status === 'stopped' ? 'This scan was stopped early, so the list is partial.' : 'Some sources stopped early, so the list may be smaller than a full scan.') : null,
    h('div', { class: 'small mute' }, 'Score ranks how strongly search engines suggest each phrase (position, agreement between sources, repetition). It is not monthly search volume.'));
  out.append(head);
  if (!d.all) { out.append(h('div', { class: 'card empty' }, h('h3', {}, 'No phrases yet'), h('p', {}, s.status === 'running' ? 'Scanning…' : 'Nothing came back. Try again later or with another source.'))); return; }

  // sidebar
  const side = h('div', { class: 'side' });
  const meta = d.intentMeta;
  const intents = h('div', { class: 'facet' },
    h('button', { 'aria-pressed': !R.f.intent, on: { click: () => { R.f.intent = ''; refilter(); } } }, h('span', {}, 'All intents'), h('span', { class: 'n' }, num(d.total))),
    d.facets.intents.map((i) => h('button', { 'aria-pressed': R.f.intent === i.k, on: { click: () => { R.f.intent = R.f.intent === i.k ? '' : i.k; refilter(); } } }, h('span', {}, i.label), h('span', { class: 'n' }, num(i.n)))));
  side.append(h('div', { class: 'card' }, h('h3', { style: 'margin-bottom:8px' }, 'Who is asking'), intents));
  if (d.facets.places.length || d.checkingPlaces) {
    side.append(h('div', { class: 'card' }, h('h3', { style: 'margin-bottom:8px' }, 'Places mentioned ', d.checkingPlaces ? h('span', { class: 'spinner', title: 'Checking which words are real places' }) : null),
      h('div', { class: 'chips' }, d.facets.places.slice(0, 24).map((p) => h('button', { class: 'chip', 'aria-pressed': R.f.place === p.k, on: { click: () => { R.f.place = R.f.place === p.k ? '' : p.k; refilter(); } } }, p.k, h('small', {}, p.n)))),
      h('p', { class: 'small mute', style: 'margin:8px 0 0' }, 'Where else people look for this. Good places to expand into.')));
  }
  side.append(h('div', { class: 'card' }, h('h3', { style: 'margin-bottom:8px' }, 'Narrow by word'),
    h('div', { class: 'chips' }, d.facets.terms.map((t) => h('button', { class: 'chip', 'aria-pressed': R.f.term.includes(t.k), on: { click: () => { R.f.term = R.f.term.includes(t.k) ? R.f.term.filter((x) => x !== t.k) : [...R.f.term, t.k]; refilter(); } } }, t.k, h('small', {}, t.n)))),
    h('label', { class: 'f', style: 'margin-top:12px' }, 'Leave out words (comma-separated)', h('input', { type: 'text', value: R.f.exclude, placeholder: 'e.g. valves, insurance, software', on: { input: (e) => { R.f.exclude = e.target.value; refilter(); } } })),
    h('label', { class: 'chk', style: 'margin-top:10px' }, h('input', { type: 'checkbox', checked: R.f.hideFringe, on: { change: (e) => { R.f.hideFringe = e.target.checked; refilter(); } } }), `Hide phrases that may mean something else (${num(d.fringe)})`),
    d.search.sources.length > 1 ? h('label', { class: 'chk', style: 'margin-top:6px' }, h('input', { type: 'checkbox', checked: R.f.minSources > 1, on: { change: (e) => { R.f.minSources = e.target.checked ? 2 : 1; refilter(); } } }), 'Only phrases found by 2+ sources') : null));

  // main list
  const angle = R.f.intent && meta[R.f.intent] ? h('div', { class: 'notice info', style: 'margin-bottom:10px' }, h('b', {}, meta[R.f.intent].who + '. '), meta[R.f.intent].angle) : null;
  const placeAct = R.f.place ? h('div', { class: 'notice info', style: 'margin-bottom:10px' }, `People also search for this in ${R.f.place}. `, h('a', { href: '#leads', on: { click: (e) => { e.preventDefault(); prefillLeads({ city: R.f.place }); } } }, `Find businesses in ${R.f.place}`)) : null;
  const q = h('input', { type: 'search', value: R.f.q, placeholder: 'Search within results…', on: { input: (e) => { R.f.q = e.target.value; refilter(); } } });
  const sort = h('select', { style: 'width:auto', on: { change: (e) => { R.f.sort = e.target.value; refilter(); } } }, opts([['score', 'Strongest first'], ['short', 'Shortest first'], ['alpha', 'A to Z']], R.f.sort));
  const selN = R.selected.size;
  const tools = h('div', { class: 'row', style: 'margin-bottom:10px' }, h('div', { style: 'flex:1;min-width:180px' }, q), sort,
    h('button', { class: 'btn', on: { click: () => prefillLeads({ phrases: selN ? [...R.selected] : null, useTop: !selN }) } }, selN ? `Find businesses for ${selN} selected` : 'Find businesses'),
    h('a', { class: 'btn', href: `/api/searches/${d.search.id}/export.csv?${kwParams(0).replace(/&?(offset|limit)=\d+/g, '')}`, download: '' }, 'Export CSV'),
    h('button', { class: 'btn', title: 'Real apps on the App Store for this topic', on: { click: runApps } }, R.apps === 'loading' ? 'Looking…' : 'Competing apps'),
    h('button', { class: 'btn', title: S.state && S.state.hasAnthropic ? '' : 'Needs an Anthropic API key in Settings', on: { click: runInsights } }, R.ai === 'loading' ? 'Thinking…' : 'AI brief'));
  const list = h('div');
  R.rows.forEach((r) => list.append(kwRow(r)));
  const more = R.rows.length < d.total ? h('div', { class: 'row', style: 'justify-content:center;margin-top:12px' }, h('button', { class: 'btn', on: { click: () => loadKeywords(true) } }, `Show more (${num(d.total - R.rows.length)} left)`)) : null;
  const insight = R.ai && R.ai !== 'loading' ? insightView(R.ai) : null;
  const appsBox = R.apps && R.apps !== 'loading' ? appsView(R.apps) : null;
  const main = h('div', { class: 'card' }, h('div', { class: 'head' }, h('h3', {}, `${num(d.total)} phrases`), h('span', { class: 'sub' }, d.total !== d.all ? `filtered from ${num(d.all)}` : '')), angle, placeAct, tools, appsBox, insight, list.children.length ? list : h('div', { class: 'empty' }, 'No phrases match these filters.'), more);
  out.append(h('div', { class: 'split' }, side, main));
}

function kwRow(r) {
  const cb = h('input', { type: 'checkbox', checked: R.selected.has(r.phrase), 'aria-label': 'Select ' + r.phrase, on: { change: (e) => { e.target.checked ? R.selected.add(r.phrase) : R.selected.delete(r.phrase); renderSelBtn(); } } });
  const tone = { high: 'ok', medium: 'warn', low: '' }[r.band];
  return h('div', { class: 'kw' + (r.fringe ? ' dim' : '') },
    cb,
    h('a', { href: 'https://www.google.com/search?q=' + encodeURIComponent(r.phrase), target: '_blank', rel: 'noopener', title: 'Open real Google results' }, r.phrase, r.fringe ? h('span', { class: 'tag', style: 'margin-left:8px' }, 'other meaning?') : null),
    h('span', { class: 'tag ' + (r.intent === 'local' || r.intent === 'app' ? 'acc' : '') }, (R.data.intentMeta[r.intent] || {}).label || r.intent),
    h('span', { class: 'sc', title: `Found by ${r.sources.join(', ')}; surfaced ${r.occ} time(s)` }, h('span', { class: 'bar' }, h('i', { style: `width:${r.score}%;${tone === 'warn' ? 'background:var(--warn)' : tone === '' ? 'background:var(--mute)' : ''}` })), r.score),
    h('span', { class: 'src' }, r.sources.map((x) => x[0].toUpperCase()).join('')));
}
function renderSelBtn() { renderRadarKeepScroll(); }
function renderRadarKeepScroll() { const y = window.scrollY; renderRadar(); window.scrollTo(0, y); }

async function runApps() {
  R.apps = 'loading'; renderRadarKeepScroll();
  try { R.apps = await api('GET', '/api/apps?' + qs({ term: R.data.search.seed.split(',')[0].trim(), country: R.data.search.country })); } catch (e) { R.apps = null; fail(e); }
  renderRadarKeepScroll();
}
function appsView(d) {
  const crowd = { open: ['ok', 'Open field: few apps for this topic.'], moderate: ['warn', 'Moderately crowded.'], crowded: ['bad', 'Crowded: incumbents have many ratings.'] }[d.crowd];
  return h('div', { class: 'insight' }, h('div', { class: 'row' }, h('h3', { style: 'flex:1' }, 'Competing apps on the App Store'), h('button', { class: 'btn sm', on: { click: () => { R.apps = null; renderRadarKeepScroll(); } } }, 'Hide')),
    h('p', {}, h('span', { class: 'tag ' + crowd[0] }, crowd[1]), ' ', d.count + ' apps found, ' + num(d.totalRatings) + ' ratings in total.', d.strongest ? ' Strongest: ' + d.strongest.name + ' (' + num(d.strongest.ratings) + ' ratings).' : ''),
    h('table', { class: 't' }, h('thead', {}, h('tr', {}, h('th', {}, 'App'), h('th', {}, 'By'), h('th', {}, 'Rating'), h('th', {}, 'Price'))),
      h('tbody', {}, d.apps.slice(0, 15).map((x) => h('tr', {}, h('td', {}, safeUrl(x.url) ? h('a', { href: x.url, target: '_blank', rel: 'noopener' }, x.name) : x.name), h('td', {}, x.developer), h('td', {}, x.ratings ? '★ ' + x.rating + ' (' + num(x.ratings) + ')' : 'no ratings'), h('td', {}, x.price))))),
    h('p', { class: 'small mute' }, "From Apple's public App Store search. Google Play is not included because it has no open search."));
}

async function runInsights() {
  if (!S.state.hasAnthropic) { toast('Add an Anthropic API key in Settings to use the AI brief.'); return go('settings'); }
  R.ai = 'loading'; renderRadarKeepScroll();
  try { R.ai = await api('POST', '/api/ai/insights', { searchId: R.searchId }); } catch (e) { R.ai = null; fail(e); }
  renderRadarKeepScroll();
}
function insightView(a) {
  return h('div', { class: 'insight' }, h('h3', {}, 'AI brief'), a.summary ? h('p', {}, a.summary) : null,
    (a.opportunities || []).map((o) => h('div', { style: 'margin-top:10px' }, h('b', {}, o.title), h('p', { class: 'mute' }, 'Evidence: ' + (o.evidence || '')), h('p', {}, 'Sell to: ' + (o.who_to_sell_to || '')), h('p', {}, 'Offer: ' + (o.offer_idea || '')), h('p', {}, 'First message: "' + (o.first_message || '') + '"'))),
    (a.watch_out || []).length ? h('p', { class: 'small mute', style: 'margin-top:10px' }, 'Watch out: ' + a.watch_out.join(' · ')) : null,
    h('p', { class: 'small mute' }, 'Written by an AI from the phrases above. Treat it as a starting point, not a fact.'));
}

function prefillLeads({ city, phrases, useTop } = {}) {
  go('leads');
  const L = views.leads;
  let list = phrases;
  if (!list || !list.length) {
    const s = R.data && R.data.search;
    const seed = s ? s.seed.split(',')[0].trim() : '';
    const local = (R.rows || []).filter((r) => r.intent === 'local' && !r.place && r.phrase.split(' ').length <= 3 && !/near me|online|free/.test(r.phrase)).slice(0, 2).map((r) => r.phrase);
    list = local.length ? local : seed ? [`${seed} classes`] : [];
  }
  if (list.length) $('#l-queries').value = list.slice(0, 12).join('\n');
  const c = city || (R.data && R.data.search.city);
  if (c) { $('#l-city').value = c; L.cityChanged(); }
  L.seed = R.data ? R.data.search.seed : '';
  L.plan();
}

/* ================================================================ LEADS */
const Lf = { q: '', stage: '', minScore: '', hasPhone: false, hideChains: false, hideApp: false, sort: 'score', query: '' };
const L = { rows: [], total: 0, seed: '' };

views.leads = {
  build(sec) {
    const queries = h('textarea', { id: 'l-queries', rows: 3, placeholder: 'One search per line, e.g.\nabacus classes\nvedic maths institute' }, 'abacus classes');
    const city = h('input', { type: 'text', id: 'l-city', value: 'Chennai', maxlength: 40 });
    const mode = h('select', { id: 'l-mode' }, opts([['localities', 'By locality (name the neighbourhoods)'], ['grid', 'Map grid (covers the whole city)'], ['city', 'Whole city, one search (max 60 results)']], 'localities'));
    const locs = h('textarea', { id: 'l-locs', rows: 3 }, LOCALITIES.chennai);
    const cover = h('input', { type: 'number', id: 'l-cover', value: 12, min: 2, max: 40 });
    const step = h('input', { type: 'number', id: 'l-step', value: 4, min: 1, max: 10 });
    const pages = h('select', { id: 'l-pages' }, opts([['3', 'Up to 60 results per search'], ['2', 'Up to 40'], ['1', 'Up to 20']], '3'));
    const maxr = h('input', { type: 'number', id: 'l-max', min: 1, placeholder: 'no extra limit' });
    L.locsBox = h('label', { class: 'f', style: 'grid-column:1/-1' }, 'Neighbourhoods (comma-separated)', locs);
    L.gridBox = h('div', { class: 'grid g2', style: 'grid-column:1/-1' }, h('label', { class: 'f' }, 'Cover this far from the centre (km)', cover), h('label', { class: 'f' }, 'Circle spacing (km)', step));
    L.planBox = h('div', { class: 'notice info', style: 'margin-top:12px' }, 'Fill in the search to see the request estimate.');
    L.keyNote = h('div', { class: 'notice', hidden: true, style: 'margin-bottom:12px' });
    L.job = h('div', { hidden: true, style: 'margin-top:12px' });
    const findBtn = h('button', { class: 'btn pri', on: { click: find } }, 'Find businesses');
    const upd = debounce(() => L.plan(), 500);
    for (const el of [queries, city, locs, cover, step, pages, maxr]) el.addEventListener('input', upd);
    mode.addEventListener('change', () => { toggleMode(); L.plan(); });
    city.addEventListener('input', () => L.cityChanged());
    const file = h('input', { type: 'file', accept: '.csv,text/csv', hidden: true, on: { change: importCsv } });
    L.list = h('div');
    L.sum = h('div', { class: 'sub' });
    L.filters = h('div', { class: 'row', style: 'margin:10px 0' });
    L.jobEnrich = h('div', { hidden: true, style: 'margin-bottom:10px' });
    sec.append(
      h('div', { class: 'card' },
        h('div', { class: 'head' }, h('h2', {}, 'Find the businesses'), h('span', { class: 'sub grow' }, 'Real businesses from Google Maps, with phone numbers. Or import a CSV, or add one by hand.')),
        L.keyNote,
        h('div', { class: 'grid g2' },
          h('label', { class: 'f', style: 'grid-column:1/-1' }, 'What to search for', queries),
          h('label', { class: 'f' }, 'City', city), h('label', { class: 'f' }, 'How to cover the city', mode),
          L.locsBox, L.gridBox,
          h('label', { class: 'f' }, 'Depth', pages), h('label', { class: 'f' }, 'Stop after this many requests', maxr)),
        L.planBox,
        h('div', { class: 'row', style: 'margin-top:12px' }, findBtn,
          h('button', { class: 'btn', on: { click: () => file.click() } }, 'Import CSV'), file,
          h('button', { class: 'btn', on: { click: addManual } }, 'Add one by hand'),
          h('a', { class: 'btn', href: '/api/leads/export.csv', download: '' }, 'Export all')),
        L.job),
      h('div', { class: 'card' },
        h('div', { class: 'head' }, h('h2', {}, 'Your leads'), L.sum, h('span', { class: 'grow' }),
          h('button', { class: 'btn sm', title: 'Reads each business website for WhatsApp numbers, emails and whether they already have an app', on: { click: enrichAll } }, 'Check websites')),
        L.jobEnrich, L.filters, L.list));
    buildLeadFilters();
    toggleMode();
    L.cityChanged();
    L.plan();
    loadLeads();
  },
  show() { loadLeads(); this.keyState(); L.plan(); },
  keyState() {
    if (!L.keyNote) return;
    L.keyNote.hidden = !!(S.state && S.state.hasPlaces);
    clear(L.keyNote).append('Finding businesses on Google Maps needs your own Google Places API key. ', h('a', { href: '#settings', on: { click: (e) => { e.preventDefault(); go('settings'); } } }, 'Add it in Settings'), '. Until then you can import a CSV (for example from Outscraper or Apify) or add businesses by hand.');
  },
  cityChanged() {
    const c = ($('#l-city').value || '').trim().toLowerCase();
    if (LOCALITIES[c] && !$('#l-locs').value.trim()) $('#l-locs').value = LOCALITIES[c];
  },
  plan: debounce(async function () {
    if (!L.planBox) return;
    const body = planBody();
    if (!body.queries.length || (!body.city && body.mode !== 'city')) { L.planBox.textContent = 'Fill in the search and city to see the request estimate.'; return; }
    try {
      const p = await api('POST', '/api/leads/plan', body);
      clear(L.planBox).append(h('b', {}, `${num(p.searches)} searches`), `, up to ${num(p.worstRequests)} requests (each returns up to 20 businesses). `,
        h('span', { class: 'mute' }, `At Google's list price of about $35 per 1,000 requests that is up to about $${p.estUsd}, and may fall inside your free monthly allowance. Check your Google Cloud billing page. Requests left in today's cap: ${num(p.roomToday)}.`));
    } catch (e) { L.planBox.textContent = e.message; }
  }, 300),
};
views.leads.cityChanged = views.leads.cityChanged.bind(views.leads);
views.leads.plan = views.leads.plan.bind(views.leads);
L.cityChanged = () => views.leads.cityChanged();
L.plan = () => views.leads.plan();

function toggleMode() { const m = $('#l-mode').value; L.locsBox.hidden = m !== 'localities'; L.gridBox.hidden = m !== 'grid'; }
function planBody() {
  const m = $('#l-mode').value;
  return { queries: $('#l-queries').value.split('\n').map((x) => x.trim()).filter(Boolean), city: $('#l-city').value.trim(), mode: m, localities: $('#l-locs').value.split(/[,\n]/).map((x) => x.trim()).filter(Boolean), coverKm: +$('#l-cover').value || 12, stepKm: +$('#l-step').value || 4, pages: +$('#l-pages').value, maxRequests: +$('#l-max').value || undefined, seed: L.seed };
}
async function find() {
  if (!S.state.hasPlaces) { toast('Add your Google Places API key in Settings first.'); return go('settings'); }
  try {
    const { jobId } = await api('POST', '/api/leads/find', planBody());
    let last = 0;
    await trackJob(L.job, jobId, { label: 'Searching Google Maps…', onTick: (j) => { if (Date.now() - last > 4000) { last = Date.now(); loadLeads(); } } });
    await loadLeads(); refreshState();
  } catch (e) { fail(e); }
}
async function enrichAll() {
  try {
    const { jobId } = await api('POST', '/api/leads/enrich', {});
    await trackJob(L.jobEnrich, jobId, { label: 'Reading business websites…' });
    await loadLeads();
  } catch (e) { fail(e); }
}
async function importCsv(e) {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try {
    const csv = await f.text();
    const r = await api('POST', '/api/leads/import', { csv, seed: L.seed });
    toast(`Imported: ${r.inserted} new, ${r.updated} already known, ${r.skipped} skipped.`, 5000);
    loadLeads();
  } catch (err) { fail(err); }
}
function addManual() {
  const name = prompt('Business name?'); if (!name) return;
  const phone = prompt('Phone number (optional)') || '';
  const city = $('#l-city').value.trim();
  api('POST', '/api/leads', { name, phone, city }).then((l) => { toast('Added.'); loadLeads(); openLead(l.id); }).catch(fail);
}

function buildLeadFilters() {
  const rerun = debounce(() => loadLeads(), 250);
  clear(L.filters).append(
    h('div', { style: 'flex:1;min-width:180px' }, h('input', { type: 'search', placeholder: 'Search name, area, phone…', on: { input: (e) => { Lf.q = e.target.value; rerun(); } } })),
    h('select', { style: 'width:auto', on: { change: (e) => { Lf.stage = e.target.value; loadLeads(); } } }, opts([['', 'All stages'], ['new', 'New'], ['contacted', 'Contacted'], ['replied', 'Replied'], ['pilot', 'Pilot'], ['won', 'Won'], ['lost', 'Lost'], ['invalid', 'Invalid']], '')),
    h('select', { style: 'width:auto', on: { change: (e) => { Lf.minScore = e.target.value; loadLeads(); } } }, opts([['', 'Any score'], ['40', 'Score 40+'], ['60', 'Score 60+'], ['75', 'Score 75+']], '')),
    h('select', { style: 'width:auto', on: { change: (e) => { Lf.sort = e.target.value; loadLeads(); } } }, opts([['score', 'Best first'], ['new', 'Newest'], ['name', 'A to Z'], ['follow', 'Next follow-up']], 'score')),
    h('label', { class: 'chk' }, h('input', { type: 'checkbox', on: { change: (e) => { Lf.hasPhone = e.target.checked; loadLeads(); } } }), 'Has phone'),
    h('label', { class: 'chk' }, h('input', { type: 'checkbox', on: { change: (e) => { Lf.hideChains = e.target.checked; loadLeads(); } } }), 'Hide chains'),
    h('label', { class: 'chk' }, h('input', { type: 'checkbox', on: { change: (e) => { Lf.hideApp = e.target.checked; loadLeads(); } } }), 'Hide ones with an app'));
}
let leadSeq = 0;
async function loadLeads(append) {
  const seq = ++leadSeq;
  try {
    const d = await api('GET', '/api/leads?' + qs({ ...Lf, offset: append ? L.rows.length : 0, limit: 100 }));
    if (seq !== leadSeq) return;
    L.rows = append ? L.rows.concat(d.rows) : d.rows; L.total = d.total;
    const st = Object.fromEntries(d.stages.map((s) => [s.k, s.n]));
    L.sum.textContent = `${num(d.total)} shown` + (Object.keys(st).length ? ` · ${st.new || 0} new, ${st.contacted || 0} contacted, ${st.replied || 0} replied, ${st.pilot || 0} in pilot, ${st.won || 0} won` : '');
    clear(L.list);
    if (!L.rows.length) L.list.append(h('div', { class: 'empty' }, h('h3', {}, 'No leads yet'), h('p', {}, 'Find businesses above, import a CSV or add one by hand.')));
    L.rows.forEach((l) => L.list.append(leadRow(l)));
    if (L.rows.length < L.total) L.list.append(h('div', { class: 'row', style: 'justify-content:center;margin-top:12px' }, h('button', { class: 'btn', on: { click: () => loadLeads(true) } }, `Show more (${num(L.total - L.rows.length)} left)`)));
  } catch (e) { fail(e); }
}
const scClass = (n) => (n >= 65 ? 'sc-hi' : n >= 45 ? 'sc-md' : 'sc-lo');
const STAGE_TONE = { new: '', contacted: 'acc', replied: 'ok', pilot: 'ok', won: 'ok', lost: 'bad', invalid: 'bad' };
const PHONE_LABEL = { mobile: 'mobile', landline: 'landline', unknown: 'phone', invalid: 'no phone' };
function leadRow(l) {
  const chips = (l.signals || []).filter((s) => s.pts !== 0).slice(0, 3).map((s) => h('span', { class: 'tag ' + (s.pts > 0 ? 'ok' : 'bad') }, s.label.length > 34 ? s.label.slice(0, 32) + '…' : s.label));
  return h('div', { class: 'lead', tabindex: 0, role: 'button', on: { click: () => openLead(l.id), keydown: (e) => e.key === 'Enter' && openLead(l.id) } },
    h('div', {},
      h('h3', {}, h('span', { class: 'sc-pill ' + scClass(l.score) }, l.score), l.name, h('span', { class: 'tag ' + (STAGE_TONE[l.stage] || '') }, l.stage)),
      h('div', { class: 'meta' }, l.area ? h('span', {}, l.area) : null, h('span', {}, `${l.phone || 'no phone'} (${PHONE_LABEL[l.phone_type] || ''})`),
        l.rating != null ? h('span', {}, `★ ${l.rating}${l.reviews != null ? ' (' + l.reviews + ')' : ''}`) : null, l.website ? h('span', {}, 'website') : null, l.extra && l.extra.hasApp === 'yes' ? h('span', { class: 'neg' }, 'has app') : null),
      h('div', { class: 'chips', style: 'margin-top:6px' }, chips)),
    h('div', { class: 'small mute nowrap', style: 'text-align:right' }, l.next_action && l.next_followup ? (S.steps[l.next_action] || {}).label + ' ' + when(l.next_followup) : ''));
}

/* ---- drawer ---- */
function closeDrawer() { const d = $('#drawer'); d.hidden = true; clear(d); }
async function openLead(id) {
  try {
    const { lead, activities, action } = await api('GET', '/api/leads/' + id);
    const d = clear($('#drawer'));
    const f = (label, key, type) => h('label', { class: 'f' }, label, h('input', { type: type || 'text', value: lead[key] || '', 'data-k': key }));
    const save = async () => {
      const body = {};
      d.querySelectorAll('[data-k]').forEach((el) => (body[el.getAttribute('data-k')] = el.value));
      try { await api('PATCH', '/api/leads/' + id, body); toast('Saved.'); loadLeads(); refreshState(); openLead(id); } catch (e) { fail(e); }
    };
    d.append(
      h('div', { class: 'row', style: 'margin-bottom:12px' }, h('h2', { style: 'flex:1' }, lead.name), h('button', { class: 'btn sm', on: { click: closeDrawer } }, 'Close')),
      action && !['won', 'lost', 'invalid'].includes(lead.stage) ? actionCard({ lead, action }, () => openLead(id).then(() => { loadLeads(); refreshState(); })) : h('div', { class: 'notice info' }, lead.stage === 'won' ? 'Won 🎉' : lead.stage === 'lost' ? 'Closed: ' + (lead.lost_reason || 'lost') : lead.stage === 'invalid' ? 'Closed: ' + (lead.lost_reason || 'invalid') : 'No next step.'),
      h('div', { class: 'card', style: 'margin-top:12px' }, h('h3', { style: 'margin-bottom:8px' }, 'Details'),
        h('div', { class: 'grid g2' }, f('Name', 'name'), f('Contact person (once you know)', 'contact_name'), f('Phone', 'phone'), f('Area', 'area'), f('Website', 'website'), f('Email', 'email'),
          h('label', { class: 'f' }, 'Message language', h('select', { 'data-k': 'lang' }, opts([['en', 'English'], ['ta', 'Tamil']], lead.lang))),
          h('label', { class: 'f' }, 'Stage', h('select', { 'data-k': 'stage' }, opts([['new', 'New'], ['contacted', 'Contacted'], ['replied', 'Replied'], ['pilot', 'Pilot'], ['won', 'Won'], ['lost', 'Lost'], ['invalid', 'Invalid']], lead.stage)))),
        h('label', { class: 'f', style: 'margin-top:10px' }, 'Notes', h('textarea', { rows: 3, 'data-k': 'notes' }, lead.notes || '')),
        h('div', { class: 'row', style: 'margin-top:10px' }, h('button', { class: 'btn pri', on: { click: save } }, 'Save changes'),
          lead.website ? h('button', { class: 'btn', on: { click: async () => { toast('Reading website…'); try { const r = await api('POST', `/api/leads/${id}/enrich`); toast(r.result.ok ? 'Website checked.' : 'Could not read the website: ' + r.result.reason); openLead(id); loadLeads(); } catch (e) { fail(e); } } } }, 'Check website') : null,
          safeUrl(lead.maps_url) ? h('a', { class: 'btn', href: safeUrl(lead.maps_url), target: '_blank', rel: 'noopener' }, 'Open in Maps') : null,
          safeUrl(lead.website) ? h('a', { class: 'btn', href: safeUrl(lead.website), target: '_blank', rel: 'noopener' }, 'Open website') : null,
          h('button', { class: 'btn danger', on: { click: async () => { if (!confirm('Delete this lead and its history?')) return; await api('DELETE', '/api/leads/' + id); closeDrawer(); loadLeads(); refreshState(); } } }, 'Delete'))),
      h('div', { class: 'card', style: 'margin-top:12px' }, h('h3', { style: 'margin-bottom:6px' }, `Why score ${lead.score}`), (lead.signals || []).map((s) => h('div', { class: 'sig' }, h('span', {}, s.label), h('b', { class: s.pts > 0 ? 'pos' : s.pts < 0 ? 'neg' : '' }, (s.pts > 0 ? '+' : '') + s.pts))),
        lead.extra && lead.extra.appEvidence && lead.extra.appEvidence.length ? h('p', { class: 'small mute' }, 'App evidence: ' + lead.extra.appEvidence.join(', ')) : null,
        lead.extra && lead.extra.phoneNote ? h('p', { class: 'small mute' }, lead.extra.phoneNote) : null,
        lead.extra && lead.extra.otherPhones && lead.extra.otherPhones.length ? h('p', { class: 'small mute' }, 'Other numbers on website: ' + lead.extra.otherPhones.join(', ')) : null),
      h('div', { class: 'card', style: 'margin-top:12px' }, h('h3', { style: 'margin-bottom:6px' }, 'History'), activities.length ? activities.map((a) => h('div', { class: 'tl' }, h('b', {}, a.type + (a.step ? ' · ' + a.step : '')), ' ', h('span', { class: 'mute' }, when(a.at)), a.body ? h('div', { class: 'mute', style: 'white-space:pre-wrap' }, a.body.slice(0, 400)) : null)) : h('div', { class: 'mute small' }, 'Nothing yet.')));
    d.hidden = false; d.scrollTop = 0;
  } catch (e) { fail(e); }
}

/* ---- the card that shows one next step ---- */
function actionCard(item, onDone) {
  const { lead } = item;
  let a = item.action;
  const box = h('div', { class: 'act' });
  const draw = () => {
    clear(box);
    const ta = h('textarea', { rows: 6, spellcheck: 'false', 'aria-label': 'Message text' }, a.text);
    const isCall = a.channel === 'call';
    const waBtn = h('a', { class: 'btn pri', href: '#', target: '_blank', rel: 'noopener', on: { click: (e) => { e.currentTarget.href = `https://wa.me/${lead.wa}?text=${encodeURIComponent(ta.value)}`; S.waPending = { box, lead, ev: (x) => ev(x) }; } } }, 'Open WhatsApp');
    const ev = async (ev, extra = {}) => {
      try {
        const r = await api('POST', `/api/leads/${lead.id}/event`, { ev, body: ev === 'sent' ? ta.value : undefined, lang: a.lang, ...extra });
        const n = r.lead;
        toast(n.next_action && n.next_followup ? `Logged. Next: ${(S.steps[n.next_action] || {}).label || n.next_action}, ${when(n.next_followup)}.` : n.stage === 'lost' || n.stage === 'invalid' ? 'Logged. Closed this lead.' : 'Logged.');
        refreshState(); onDone && onDone(r);
      } catch (e) { fail(e); }
    };
    const lang = (code, label) => h('button', { class: 'btn sm', 'aria-pressed': a.lang === code, style: a.lang === code ? 'background:var(--accbg);color:var(--acc)' : '', on: { click: async () => { try { a = await api('POST', `/api/leads/${lead.id}/render`, { lang: code, step: a.step }); api('PATCH', '/api/leads/' + lead.id, { lang: code }).catch(() => {}); draw(); } catch (e) { fail(e); } } } }, label);
    const oc = [];
    if (isCall) oc.push(btn('Interested', () => ev('called', { outcome: 'interested' }), true), btn('No answer', () => ev('called', { outcome: 'no_answer' })), btn('Not interested', () => ev('called', { outcome: 'not_interested' })));
    else oc.push(btn('✓ I sent it', () => ev('sent'), true), btn('They replied', () => ev('replied')), btn('No WhatsApp', () => ev('no_whatsapp')));
    if (['replied', 'contacted'].includes(lead.stage) && !isCall) oc.push(btn('Pilot started', () => ev('pilot')));
    if (['replied', 'pilot'].includes(lead.stage)) oc.push(btn('Won (paying)', () => ev('won')));
    if (lead.stage === 'replied' && isCall) oc.push(btn('Pilot started', () => ev('pilot')));
    if (!isCall) oc.push(btn('Not interested', () => ev('lost', { reason: 'not interested' })));
    oc.push(btn('Wrong number', () => ev('wrong_number')), btn('Snooze 1 day', () => ev('snooze', { days: 1 })));
    box.append(
      h('div', { class: 'top2' }, h('h3', { style: 'flex:1' }, lead.name), h('span', { class: 'sc-pill ' + scClass(lead.score) }, lead.score)),
      h('div', { class: 'meta' }, lead.area ? h('span', {}, lead.area) : null, h('span', {}, `${lead.phone || 'no phone'} (${PHONE_LABEL[lead.phone_type] || ''})`), lead.rating != null ? h('span', {}, `★ ${lead.rating} (${lead.reviews ?? '?'})`) : null,
        lead.extra && lead.extra.hasApp === 'yes' ? h('span', { class: 'neg' }, 'already has an app: use the "already have an app" line') : null),
      h('div', { class: 'row', style: 'margin-top:8px' }, h('span', { class: 'tag acc' }, a.label), h('span', { class: 'small mute' }, a.hint), h('span', { style: 'flex:1' }), isCall ? null : [lang('en', 'EN'), lang('ta', 'தமிழ்')]),
      ta,
      h('div', { class: 'row' }, isCall ? null : (lead.wa ? waBtn : h('span', { class: 'small mute' }, 'No WhatsApp number')), btn(isCall ? 'Copy script' : 'Copy', async () => { try { await navigator.clipboard.writeText(ta.value); toast('Copied.'); } catch { ta.select(); toast('Press Ctrl+C to copy.'); } }),
        a.tel ? h('a', { class: 'btn', href: a.tel }, 'Call') : null, lead.phone ? btn('Save contact', () => saveContact(lead)) : null, isCall && lead.wa ? h('a', { class: 'btn', href: `https://wa.me/${lead.wa}`, target: '_blank', rel: 'noopener' }, 'Open chat') : null,
        h('button', { class: 'btn sm', on: { click: () => openLead(lead.id) } }, 'Details')),
      h('div', { class: 'outcomes' }, oc));
  };
  const btn = (label, fn, pri) => h('button', { class: 'btn sm' + (pri ? ' pri' : ''), on: { click: fn } }, label);
  draw();
  return box;
}

/* ================================================================ FOLLOW-UPS */
views.queue = {
  build(sec) { R.q = h('div'); sec.append(R.q); },
  show() { loadQueue(); },
};
async function loadQueue() {
  try {
    const q = await api('GET', '/api/queue');
    const box = clear(R.q);
    const pct = Math.min(100, Math.round((q.sentToday / q.cap) * 100));
    box.append(h('div', { class: 'card' },
      h('div', { class: 'head' }, h('h2', {}, 'Today'), h('span', { class: 'sub grow' }, 'Send one message at a time from your own number. Nothing is sent for you.')),
      h('div', { class: 'cap' }, h('span', {}, `First messages today: ${q.sentToday} of ${q.cap}`), h('div', { class: 'bar' }, h('i', { style: `width:${pct}%` })), q.sentToday >= q.cap ? h('span', { class: 'tag warn' }, 'Daily limit reached') : null),
      h('div', { class: 'small mute' }, 'The limit protects your number from being flagged for looking like spam. Change it in Settings. Best time to follow up: 11 AM to 3 PM, when teachers are between classes.')));
    const section = (title, sub, items) => {
      if (!items.length) return;
      box.append(h('div', { style: 'margin-top:18px' }, h('h2', { style: 'margin-bottom:2px' }, title), h('div', { class: 'sub', style: 'margin-bottom:10px' }, sub),
        items.map((it) => actionCard(it, (r) => { loadQueue(); }))));
    };
    section(`Due now (${q.due.length})`, 'Follow-ups, calls and check-ins that are ready.', q.due);
    section(`New leads to message (${q.fresh.length})`, `Best-scoring leads first. ${q.waiting > q.fresh.length ? num(q.waiting - q.fresh.length) + ' more are waiting for tomorrow.' : ''}`, q.fresh);
    if (!q.due.length && !q.fresh.length) box.append(h('div', { class: 'card empty', style: 'margin-top:14px' }, h('h3', {}, q.waiting ? 'That is enough for today' : 'You are all caught up'), h('p', {}, q.waiting ? `${num(q.waiting)} leads are waiting. Come back tomorrow, or raise the daily limit in Settings.` : 'Find more businesses on the Leads tab.')));
  } catch (e) { fail(e); }
}

/* ================================================================ FUNNEL */
views.funnel = { build(sec) { R.fun = h('div'); sec.append(R.fun); }, show() { loadFunnel(); } };
async function loadFunnel() {
  try {
    const d = await api('GET', '/api/funnel');
    const f = d.funnel, box = clear(R.fun);
    const stages = [['Found', f.found], ['Reachable (has phone)', f.reachable], ['Contacted', f.contacted], ['Replied', f.replied], ['Pilot started', f.pilot], ['Won', f.won]];
    const max = Math.max(1, stages[0][1]);
    const worst = (() => { let w = null; for (let i = 1; i < stages.length; i++) { if (stages[i - 1][1] >= 5) { const r = stages[i][1] / stages[i - 1][1]; if (!w || r < w.r) w = { r, from: stages[i - 1][0], to: stages[i][0] }; } } return w; })();
    box.append(h('div', { class: 'card' }, h('div', { class: 'head' }, h('h2', {}, 'Funnel'), h('span', { class: 'sub grow' }, 'Where leads drop off. Fix the weakest step first.')),
      stages.map(([label, n], i) => h('div', { class: 'stage' }, h('span', {}, label), h('div', { class: 'bar' }, h('i', { style: `width:${Math.max(n ? 1.5 : 0, (n / max) * 100)}%` })),
        h('span', {}, h('b', {}, num(n)), i && stages[i - 1][1] ? h('span', { class: 'conv' }, `  ${Math.round((n / stages[i - 1][1]) * 100)}%`) : ''))),
      worst ? h('div', { class: 'notice info', style: 'margin-top:10px' }, `Weakest step so far: ${worst.from} → ${worst.to} (${Math.round(worst.r * 100)}%).`) : h('div', { class: 'small mute' }, 'Numbers become meaningful after about 20 contacts.')));
    const maxd = Math.max(1, ...d.days.map((x) => x.sent));
    box.append(h('div', { class: 'card' }, h('h3', {}, 'First messages and replies, last 14 days'),
      h('div', { class: 'days' }, d.days.map((x) => h('div', { title: `${x.day}: ${x.sent} sent, ${x.replied} replied` }, h('i', { style: `height:${(x.sent / maxd) * 80}px` }), h('span', {}, x.day.slice(8))))),
      h('div', { class: 'small mute' }, `Total sent: ${d.days.reduce((a, x) => a + x.sent, 0)} · replies logged: ${d.days.reduce((a, x) => a + x.replied, 0)}`)));
    const tbl = (title, rows, keyLabel) => rows.length ? h('div', { class: 'card' }, h('h3', { style: 'margin-bottom:6px' }, title), h('table', { class: 't' }, h('thead', {}, h('tr', {}, h('th', {}, keyLabel), h('th', {}, 'Contacted'), h('th', {}, 'Replied'), h('th', {}, 'Rate'))),
      h('tbody', {}, rows.map((r) => h('tr', {}, h('td', {}, r.k), h('td', {}, r.contacted), h('td', {}, r.replied || 0), h('td', {}, Math.round(((r.replied || 0) / r.contacted) * 100) + '%')))))) : null;
    box.append(...[tbl('Reply rate by message language', d.byLang, 'Language'), tbl('Reply rate by search phrase', d.byQuery, 'Search phrase')].filter(Boolean));
  } catch (e) { fail(e); }
}

/* ================================================================ SETTINGS */
views.settings = { build(sec) { R.set = h('div'); sec.append(R.set); }, show() { loadSettings(); } };
const TPL = [['first', 'First message'], ['followup1', 'Follow-up (next day)'], ['call', 'Call script'], ['details', 'After they reply: send details'], ['nudge', 'Nudge after details'], ['has_app', '"We already have an app" reply (copy from here)'], ['checkin3', 'Pilot check-in, day 3'], ['checkin7', 'Pilot check-in, day 7'], ['review30', 'Day-30 review']];
async function loadSettings() {
  try {
    const { settings: s, steps } = await api('GET', '/api/settings');
    S.steps = steps;
    const box = clear(R.set);
    const inp = (label, key, opts2 = {}) => h('label', { class: 'f', style: opts2.wide ? 'grid-column:1/-1' : '' }, label, h('input', { type: opts2.type || 'text', value: s[key] ?? '', 'data-s': key, placeholder: opts2.ph || '', autocomplete: 'off' }));
    const tplBox = h('div', { class: 'grid' });
    for (const [key, label] of TPL) {
      const langs = ['en', 'ta'].filter((l) => key === 'has_app' || key === 'call' || key.startsWith('checkin') || key === 'review30' ? l === 'en' : true);
      tplBox.append(h('div', {}, h('h3', { style: 'margin-bottom:6px' }, label), h('div', { class: 'grid g2' }, langs.map((l) => h('label', { class: 'f' }, l === 'en' ? 'English' : 'Tamil', h('textarea', { rows: 6, 'data-t': `${key}_${l}` }, s.templates[`${key}_${l}`] || '' ))))));
    }
    const save = async () => {
      const body = { templates: {} };
      box.querySelectorAll('[data-s]').forEach((el) => { const k = el.getAttribute('data-s'); body[k] = el.type === 'number' ? +el.value : el.value; });
      box.querySelectorAll('[data-t]').forEach((el) => (body.templates[el.getAttribute('data-t')] = el.value));
      try { await api('PUT', '/api/settings', body); toast('Settings saved.'); refreshState(); loadSettings(); } catch (e) { fail(e); }
    };
    box.append(
      h('div', { class: 'card' }, h('div', { class: 'head' }, h('h2', {}, 'Connections'), h('span', { class: 'sub grow' }, 'Keys stay on this computer, in the local database. They are never shown again in full.')),
        h('div', { class: 'grid g2' },
          inp('Google Places API key (finds businesses and phone numbers)', 'placesKey', { type: 'password', ph: s.placesKeySet ? 'saved' : 'AIza…', wide: true }),
          inp('Anthropic API key (optional, for the AI brief)', 'anthropicKey', { type: 'password', ph: s.anthropicKeySet ? 'saved' : 'sk-ant-…', wide: true }),
          inp('Max Google requests per day', 'placesDailyCap', { type: 'number' })),
        h('div', { class: 'small mute', style: 'margin-top:10px;line-height:1.6' },
          'To get a Places key: Google Cloud Console → create a project → enable "Places API (New)" → turn on billing → Credentials → Create API key. Restrict the key to Places API (New). ',
          'Search results with phone numbers are billed per request, so keep the daily cap low while testing. You can also set the keys as environment variables GOOGLE_PLACES_API_KEY and ANTHROPIC_API_KEY.')),
      h('div', { class: 'card' }, h('h2', { style: 'margin-bottom:10px' }, 'About you and your offer'), h('div', { class: 'grid g2' },
        inp('Your name (used in messages)', 'sender'), inp('Product name', 'product'), inp('Topic word (e.g. abacus)', 'topic'), inp('What you call them (centre, salon, clinic)', 'org'),
        inp('Link to try the product', 'link', { wide: true }), inp('One-line offer (used after they reply)', 'offer', { wide: true }),
        inp('Country code for phone numbers', 'cc'), inp('Google region (2 letters)', 'country'),
        inp('First messages per day', 'dailyCap', { type: 'number' }), inp('Skip leads scoring below', 'minQueueScore', { type: 'number' }),
        inp('Franchise or chain names to score down (comma-separated)', 'chainWords', { wide: true }),
        inp('Claude model for the AI brief', 'aiModel', { wide: true }))),
      h('div', { class: 'card' }, h('div', { class: 'head' }, h('h2', {}, 'Message templates'), h('span', { class: 'sub grow' }, 'Variables: {hello} {sender} {product} {topic} {org} {link} {offer} {area_line} {area} {name}. Keep the first message short and free of money talk. Have a native speaker check the Tamil.')), tplBox),
      h('div', { class: 'row' }, h('button', { class: 'btn pri', on: { click: save } }, 'Save settings')));
  } catch (e) { fail(e); }
}

/* ---------------------------------------------------------------- boot */
(async function boot() {
  await refreshState();
  try { const { steps } = await api('GET', '/api/settings'); S.steps = steps; } catch { /* ignore */ }
  const t = location.hash.slice(1);
  const phone = window.matchMedia('(max-width: 700px)').matches;
  go(views[t] ? t : phone && S.state && S.state.leads ? 'queue' : 'radar');
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  setInterval(refreshState, 60000);
})();
