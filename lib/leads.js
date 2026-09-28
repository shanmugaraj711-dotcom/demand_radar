'use strict';
// Lead storage, phone handling, scoring and the follow-up cadence.
const { tx } = require('./db');
const { atEleven, startOfDay, esc } = require('./util');

/* ---------- phones ---------- */
// Returns { wa, type } where wa is digits with country code, type is mobile | landline | unknown | invalid.
function normPhone(raw, cc = '91') {
  if (!raw) return { wa: '', type: 'invalid' };
  const plus = /^\s*\+/.test(raw);
  let d = String(raw).replace(/\D/g, '');
  if (!d) return { wa: '', type: 'invalid' };
  if (d.startsWith('00')) { d = d.slice(2); return d.startsWith(cc) || cc !== '91' ? fin(d, cc) : { wa: d, type: 'unknown' }; }
  if (plus) return d.startsWith(cc) ? fin(d, cc) : { wa: d, type: 'unknown' };
  if (cc === '91') {
    const n = d.startsWith('91') && d.length === 12 ? d.slice(2) : d.replace(/^0+/, '');
    if (n.length !== 10) return { wa: '', type: 'invalid' };
    return { wa: '91' + n, type: /^[6-9]/.test(n) ? 'mobile' : 'landline' };
  }
  return { wa: d.startsWith(cc) ? d : cc + d.replace(/^0+/, ''), type: 'unknown' };
}
function fin(d, cc) {
  if (cc === '91') {
    const n = d.slice(2);
    if (n.length !== 10) return { wa: '', type: 'invalid' };
    return { wa: d, type: /^[6-9]/.test(n) ? 'mobile' : 'landline' };
  }
  return { wa: d, type: 'unknown' };
}

/* ---------- scoring ---------- */
const chainRe = (words) => {
  const list = String(words || '').split(',').map((w) => w.trim().toLowerCase()).filter(Boolean);
  return list.length ? new RegExp('\\b(' + list.map(esc).join('|') + ')\\b', 'i') : null;
};

// Transparent score: every signal shows why the lead went up or down. Meant to rank who to message first, not to predict sales.
function score(l, settings) {
  const sig = [];
  let s = 30;
  const add = (label, pts) => { sig.push({ label, pts }); s += pts; };
  if (l.rating != null) {
    if (l.rating >= 4.5) add(`Rated ${l.rating}`, 15);
    else if (l.rating >= 4.0) add(`Rated ${l.rating}`, 10);
    else if (l.rating < 3.5) add(`Low rating ${l.rating}`, -5);
  }
  if (l.reviews != null) {
    if (l.reviews >= 5 && l.reviews <= 150) add(`${l.reviews} reviews: active, likely independent`, 15);
    else if (l.reviews > 150 && l.reviews <= 500) add(`${l.reviews} reviews`, 8);
    else if (l.reviews > 500) add(`${l.reviews} reviews: likely large`, 0);
    else add('Very few reviews', 3);
  }
  if (l.phone_type === 'mobile') add('Mobile number (WhatsApp likely)', 15);
  else if (l.phone_type === 'landline') add('Landline only (call, no WhatsApp)', 5);
  else if (l.phone_type === 'unknown') add('Phone found', 8);
  else add('No usable phone', -20);
  const ex = l.extra || {};
  if (ex.hasApp === 'yes') add('Already has its own app', -25);
  else if (ex.hasApp === 'maybe') add('Mentions a portal or app', -10);
  else if (l.enriched && ex.hasApp === 'no') add('No app found on website', 8);
  if (l.website && !l.enriched) add('Has a website (not checked yet)', 3);
  const re = chainRe(settings.chainWords);
  if (re && re.test(l.name || '')) add('Looks like a franchise or chain: head office may decide', -20);
  return { score: Math.max(0, Math.min(100, s)), signals: sig };
}

/* ---------- storage ---------- */
const COLS = ['place_id', 'name', 'address', 'area', 'city', 'phone', 'wa', 'phone_type', 'website', 'email', 'instagram', 'facebook', 'rating', 'reviews',
  'maps_url', 'lat', 'lng', 'source', 'query', 'seed', 'lang', 'contact_name', 'notes'];

function hydrate(r) {
  if (!r) return r;
  return { ...r, signals: safe(r.signals, []), extra: safe(r.extra, {}) };
}
const safe = (t, d) => { try { return t ? JSON.parse(t) : d; } catch { return d; } };

/** Insert a new lead or refresh an existing one (matched by Maps place id, then by WhatsApp number). Never touches stage or history. */
function upsert(db, raw, settings) {
  const cc = settings.cc || '91';
  const ph = normPhone(raw.phone || raw.intl_phone || '', cc);
  const l = { ...raw, wa: ph.wa, phone_type: ph.type };
  if (l.status && /CLOSED/i.test(l.status)) return { skipped: 'closed' };
  if (!l.name) return { skipped: 'no name' };
  let row = l.place_id ? db.prepare('SELECT * FROM leads WHERE place_id=?').get(l.place_id) : null;
  if (!row && l.wa) row = db.prepare('SELECT * FROM leads WHERE wa=?').get(l.wa);
  const now = Date.now();
  if (row) {
    const cur = hydrate(row);
    const merged = { ...cur };
    for (const c of ['address', 'area', 'website', 'rating', 'reviews', 'maps_url', 'lat', 'lng', 'city']) if (l[c] != null && l[c] !== '') merged[c] = l[c];
    if (!cur.wa && l.wa) { merged.wa = l.wa; merged.phone = l.phone; merged.phone_type = l.phone_type; }
    if (!cur.place_id && l.place_id) merged.place_id = l.place_id;
    const sc = score(merged, settings);
    db.prepare('UPDATE leads SET place_id=?,address=?,area=?,city=?,phone=?,wa=?,phone_type=?,website=?,rating=?,reviews=?,maps_url=?,lat=?,lng=?,score=?,signals=?,updated=? WHERE id=?')
      .run(merged.place_id || null, merged.address || '', merged.area || '', merged.city || '', merged.phone || '', merged.wa || '', merged.phone_type || 'invalid', merged.website || '',
        merged.rating, merged.reviews, merged.maps_url || '', merged.lat, merged.lng, sc.score, JSON.stringify(sc.signals), now, row.id);
    return { id: row.id, inserted: false };
  }
  const sc = score({ ...l, extra: {} }, settings);
  const r = db.prepare(`INSERT INTO leads(place_id,name,address,area,city,phone,wa,phone_type,website,email,instagram,facebook,rating,reviews,maps_url,lat,lng,source,query,seed,
    signals,extra,score,stage,lang,contact_name,notes,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(l.place_id || null, l.name, l.address || '', l.area || '', l.city || '', l.phone || '', l.wa || '', l.phone_type || 'invalid', l.website || '', l.email || '', l.instagram || '', l.facebook || '',
      l.rating == null ? null : l.rating, l.reviews == null ? null : l.reviews, l.maps_url || '', l.lat == null ? null : l.lat, l.lng == null ? null : l.lng, l.source || 'manual', l.query || '', l.seed || '',
      JSON.stringify(sc.signals), '{}', sc.score, 'new', l.lang || settings.lang || 'en', l.contact_name || '', l.notes || '', now, now);
  return { id: Number(r.lastInsertRowid), inserted: true };
}

function rescore(db, id, settings) {
  const l = hydrate(db.prepare('SELECT * FROM leads WHERE id=?').get(id));
  if (!l) return;
  const sc = score(l, settings);
  db.prepare('UPDATE leads SET score=?, signals=?, updated=? WHERE id=?').run(sc.score, JSON.stringify(sc.signals), Date.now(), id);
}

function applyEnrichment(db, id, e, settings) {
  const l = hydrate(db.prepare('SELECT * FROM leads WHERE id=?').get(id));
  if (!l) return null;
  const extra = { ...l.extra };
  const upd = { enriched: Date.now() };
  if (!e.ok) { extra.enrichError = e.reason; db.prepare('UPDATE leads SET enriched=?, extra=? WHERE id=?').run(upd.enriched, JSON.stringify(extra), id); rescore(db, id, settings); return { ok: false, reason: e.reason }; }
  delete extra.enrichError;
  extra.hasApp = e.hasApp; extra.appEvidence = [...e.stores, ...e.words]; extra.emails = e.emails;
  extra.otherPhones = e.phones.map((p) => '+91' + p);
  const cc = settings.cc || '91';
  let phone = l.phone, wa = l.wa, phone_type = l.phone_type, phoneNote = '';
  // A WhatsApp link on the website is the best number; otherwise use a website mobile if we have none.
  const waNum = e.wa[0];
  if (waNum) { const n = normPhone('+' + waNum, cc); if (n.wa) { wa = n.wa; phone_type = 'mobile'; phone = phone || '+' + waNum; phoneNote = 'WhatsApp number from website'; } }
  else if (phone_type !== 'mobile' && e.phones[0]) { const n = normPhone(e.phones[0], cc); if (n.type === 'mobile') { wa = n.wa; phone_type = 'mobile'; phone = phone || e.phones[0]; phoneNote = 'Mobile number from website'; } }
  if (phoneNote) extra.phoneNote = phoneNote;
  db.prepare('UPDATE leads SET enriched=?, extra=?, email=?, instagram=?, facebook=?, phone=?, wa=?, phone_type=? WHERE id=?')
    .run(upd.enriched, JSON.stringify(extra), l.email || e.emails[0] || '', l.instagram || e.instagram || '', l.facebook || e.facebook || '', phone, wa, phone_type, id);
  rescore(db, id, settings);
  return { ok: true, hasApp: e.hasApp };
}

/* ---------- follow-up cadence ---------- */
// Rules taken from the outreach plan: first WhatsApp, follow-up next day 11 AM-3 PM, one call on day 4, then stop.
const STEPS = {
  first: { label: 'First message', channel: 'whatsapp', tpl: 'first', hint: 'Send one at a time from your own number.' },
  followup1: { label: 'Follow-up', channel: 'whatsapp', tpl: 'followup1', hint: 'Best between 11 AM and 3 PM. One follow-up only.' },
  call: { label: 'Call', channel: 'call', tpl: 'call', hint: 'Call between 11 AM and 3 PM. If no answer, this is the last try.' },
  send_details: { label: 'Send details', channel: 'whatsapp', tpl: 'details', hint: 'They replied. Attach your PDF after sending this.' },
  nudge_details: { label: 'Nudge', channel: 'whatsapp', tpl: 'nudge', hint: 'Gentle reminder after sending details.' },
  checkin3: { label: 'Pilot check-in (day 3)', channel: 'whatsapp', tpl: 'checkin3', hint: 'Ask what kids liked and what confused them.' },
  checkin7: { label: 'Pilot check-in (day 7)', channel: 'whatsapp', tpl: 'checkin7', hint: 'Judge success by repeat use in the first week.' },
  review30: { label: 'Day-30 review', channel: 'whatsapp', tpl: 'review30', hint: 'Time to talk about continuing or a paid plan.' },
};

// event -> field updates. `lead` is the current row, `p` the payload.
function transition(lead, ev, p = {}, now = Date.now()) {
  const u = {};
  const step = lead.next_action || (lead.stage === 'new' ? (lead.wa && lead.phone_type !== 'landline' ? 'first' : 'call') : null);
  const next = (action, at) => { u.next_action = action; u.next_followup = at; };
  const clear = () => { u.next_action = null; u.next_followup = null; };
  switch (ev) {
    case 'sent':
      u.last_contacted = now;
      if (step === 'first') { u.touches = (lead.touches || 0) + 1; u.stage = 'contacted'; next('followup1', atEleven(1, now)); }
      else if (step === 'followup1') { u.touches = (lead.touches || 0) + 1; next('call', atEleven(3, now)); }
      else if (step === 'send_details') { next('nudge_details', atEleven(2, now)); }
      else if (step === 'nudge_details') { next('call', atEleven(2, now)); }
      else if (step === 'checkin3') { next('checkin7', atEleven(4, now)); }
      else if (step === 'checkin7') { next('review30', atEleven(Math.max(1, Math.ceil(((lead.pilot_start || now) + 30 * 864e5 - now) / 864e5)), now)); }
      else if (step === 'review30') { clear(); }
      break;
    case 'called': {
      u.last_contacted = now;
      const out = p.outcome;
      if (out === 'interested') { u.stage = 'replied'; next('send_details', now); }
      else if (out === 'not_interested') { u.stage = 'lost'; u.lost_reason = 'not interested'; clear(); }
      else if (['replied', 'pilot'].includes(lead.stage)) { next(step || 'nudge_details', atEleven(2, now)); }
      else if (!(lead.touches > 0)) { u.touches = 1; u.stage = 'contacted'; next('call', atEleven(1, now)); } // first-ever contact was a call: one retry tomorrow
      else { u.stage = 'lost'; u.lost_reason = 'no reply after call'; clear(); }
      break;
    }
    case 'replied':
      if (['new', 'contacted'].includes(lead.stage)) { u.stage = 'replied'; next('send_details', now); }
      break;
    case 'pilot': u.stage = 'pilot'; u.pilot_start = now; next('checkin3', atEleven(3, now)); break;
    case 'won': u.stage = 'won'; clear(); break;
    case 'lost': u.stage = 'lost'; u.lost_reason = p.reason || 'not interested'; clear(); break;
    case 'no_whatsapp': u.phone_type = 'landline'; next('call', now); break;
    case 'wrong_number': u.stage = 'invalid'; u.lost_reason = 'wrong number'; clear(); break;
    case 'snooze': u.next_followup = atEleven(Math.max(1, p.days || 1), now); u.next_action = lead.next_action || step; break;
    case 'note': break;
    default: throw new Error('Unknown event ' + ev);
  }
  return { updates: u, step };
}

function logEvent(db, id, ev, p = {}) {
  const lead = hydrate(db.prepare('SELECT * FROM leads WHERE id=?').get(id));
  if (!lead) throw new Error('Lead not found');
  const now = Date.now();
  const { updates, step } = transition(lead, ev, p, now);
  tx(db, () => {
    const keys = Object.keys(updates);
    if (keys.length) db.prepare(`UPDATE leads SET ${keys.map((k) => k + '=?').join(',')}, updated=? WHERE id=?`).run(...keys.map((k) => updates[k]), now, id);
    db.prepare('INSERT INTO activities(lead_id,type,step,lang,body,at) VALUES(?,?,?,?,?,?)').run(id, ev, step || '', p.lang || lead.lang, p.body || p.outcome || p.reason || '', now);
  });
  return hydrate(db.prepare('SELECT * FROM leads WHERE id=?').get(id));
}

const DONE = "('won','lost','invalid')";

function queue(db, settings, now = Date.now()) {
  const day0 = startOfDay(new Date(now));
  const sentToday = db.prepare("SELECT COUNT(*) n FROM activities WHERE type='sent' AND step='first' AND at>=?").get(day0).n;
  const capLeft = Math.max(0, (settings.dailyCap || 15) - sentToday);
  const due = db.prepare(`SELECT * FROM leads WHERE next_action IS NOT NULL AND next_followup<=? AND stage NOT IN ${DONE} ORDER BY next_followup ASC LIMIT 200`).all(now).map(hydrate);
  const fresh = capLeft
    ? db.prepare(`SELECT * FROM leads WHERE stage='new' AND next_action IS NULL AND phone_type!='invalid' AND score>=? ORDER BY score DESC, reviews DESC LIMIT ?`).all(settings.minQueueScore || 0, capLeft).map(hydrate)
    : [];
  const waiting = db.prepare("SELECT COUNT(*) n FROM leads WHERE stage='new' AND next_action IS NULL AND phone_type!='invalid'").get().n;
  return { due, fresh, sentToday, cap: settings.dailyCap || 15, waiting };
}

function funnel(db) {
  const c = (sql, ...a) => db.prepare(sql).get(...a).n;
  const total = c('SELECT COUNT(*) n FROM leads');
  const f = {
    found: total,
    reachable: c("SELECT COUNT(*) n FROM leads WHERE phone_type!='invalid'"),
    contacted: c('SELECT COUNT(*) n FROM leads WHERE touches>0'),
    replied: c("SELECT COUNT(DISTINCT lead_id) n FROM activities WHERE type IN ('replied') OR (type='called' AND body='interested')"),
    pilot: c("SELECT COUNT(*) n FROM leads WHERE pilot_start IS NOT NULL"),
    won: c("SELECT COUNT(*) n FROM leads WHERE stage='won'"),
  };
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const from = startOfDay(new Date(Date.now() - i * 864e5)), to = from + 864e5;
    days.push({ day: new Date(from).toISOString().slice(0, 10), sent: c("SELECT COUNT(*) n FROM activities WHERE type='sent' AND at>=? AND at<?", from, to), replied: c("SELECT COUNT(*) n FROM activities WHERE type='replied' AND at>=? AND at<?", from, to) });
  }
  const by = (col) => db.prepare(`SELECT ${col} k, COUNT(*) contacted, SUM(CASE WHEN stage IN ('replied','pilot','won') OR pilot_start IS NOT NULL THEN 1 ELSE 0 END) replied FROM leads WHERE touches>0 AND ${col}!='' GROUP BY ${col} ORDER BY contacted DESC LIMIT 12`).all();
  return { funnel: f, days, byLang: by('lang'), byQuery: by('query'), stages: db.prepare('SELECT stage k, COUNT(*) n FROM leads GROUP BY stage').all() };
}

module.exports = { upsert, hydrate, normPhone, score, rescore, applyEnrichment, logEvent, queue, funnel, STEPS, transition, COLS };
