'use strict';

const crypto = require('crypto');

const STOP = new Set([
  'the','a','an','and','or','of','to','in','on','for','is','are','was','were','this','that',
  'they','them','their','with','from','near','at','by','my','our','your','we','i','me','it',
  'does','do','did','never','not','no','why','where','when','can','could','please','need'
]);

const INTENT_RULES = [
  ['operational_gap', /\b(no\s+reply|never\s+reply|doesn.?t\s+reply|not\s+reply|won.?t\s+reply|unresponsive|doesn.?t\s+answer|no\s+answer|booking\s+(?:is\s+)?broken|cannot\s+book|can.?t\s+book|no\s+online\s+booking|closed\s+booking|broken\s+website|website\s+(?:is\s+)?down|not\s+working|doesn.?t\s+work|no\s+whatsapp|whatsapp\s+(?:is\s+)?not|no\s+response)\b/i],
  ['buying_intent', /\b(looking\s+for|recommend|recommendation|where\s+can\s+i\s+find|need\s+a|need\s+an|want\s+a|looking\s+to\s+hire|which\s+(?:clinic|school|class|centre|center|shop|service))\b/i],
  ['complaint', /\b(terrible|worst|bad\s+service|complaint|complaining|disappointed|avoid|scam|rude|poor\s+service|didn.?t\s+help|not\s+happy)\b/i],
  ['comparison', /\b(compare|vs\.?|versus|better\s+than|alternative|options?)\b/i]
];

const NEED_RULES = [
  ['no_whatsapp_booking', /\b(no\s+whatsapp|(?:no|never|not|doesn.?t|won.?t|cannot|can.?t)\s+reply.{0,40}whatsapp|whatsapp.{0,40}(?:no|never|not|doesn.?t|won.?t|cannot|can.?t).*reply|won.?t.*whatsapp|cannot.*whatsapp|can.?t.*whatsapp)\b/i],
  ['booking_failure', /\b(broken|can.?t|cannot|unable|failed|failure|not\s+working).{0,40}\b(book|booking|appointment|reservation)\b/i],
  ['no_online_booking', /\b(no|without|missing).{0,30}\b(online\s+booking|booking\s+system|appointment\s+booking)\b/i],
  ['no_response', /\b(no\s+reply|never\s+reply|doesn.?t\s+reply|unresponsive|doesn.?t\s+answer|no\s+answer)\b/i],
  ['poor_service', /\b(bad\s+service|poor\s+service|rude|terrible|worst|disappointed)\b/i]
];

function normalizeText(value) {
  return String(value || '').normalize('NFKC').toLowerCase()
    .replace(/https?:\/\/[^\s]+/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ').trim();
}
function tokens(value) {
  return new Set(normalizeText(value).split(' ').filter((x) => x && !STOP.has(x) && x.length > 1));
}
function canonicalUrl(url) {
  try {
    const u = new URL(String(url || '').trim());
    u.hash = ''; u.search = ''; u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');\n    u.protocol = 'https:';
    u.pathname = u.pathname.replace(/\/+$/, '') || '/';
    return u.toString();
  } catch { return String(url || '').trim().toLowerCase(); }
}
function contentHash(signal) {
  const source = normalizeText(signal.source || 'unknown');
  const sourceId = normalizeText(signal.source_id || '');
  const url = canonicalUrl(signal.source_url || '');
  const raw = normalizeText(signal.raw_text || '');
  const key = sourceId ? source + '|id:' + sourceId : source + '|url:' + url + '|text:' + raw;
  return crypto.createHash('sha256').update(key).digest('hex');
}
function classify(rawText) {
  const text = String(rawText || '');
  for (const [intent, re] of INTENT_RULES) if (re.test(text)) {
    const need = NEED_RULES.find(([, r]) => r.test(text));
    return { intent_class: intent, detected_need: need ? need[0] : '' };
  }
  const need = NEED_RULES.find(([, r]) => r.test(text));
  return { intent_class: need ? 'operational_gap' : 'other', detected_need: need ? need[0] : '' };
}
function parseSignal(input) {
  const rawText = String(input.raw_text || '').trim().slice(0, 12000);
  if (!rawText) throw new Error('raw_text is required.');
  const c = classify(rawText);
  return {
    source: String(input.source || 'manual').trim().slice(0, 80) || 'manual',
    source_id: String(input.source_id || '').trim().slice(0, 300),
    source_url: String(input.source_url || '').trim().slice(0, 2000),
    raw_text: rawText,
    entity_name: String(input.entity_name || '').trim().slice(0, 300),
    location_hint: String(input.location_hint || '').trim().slice(0, 300),
    detected_need: String(input.detected_need || c.detected_need).trim().slice(0, 120),
    intent_class: String(input.intent_class || c.intent_class).trim().slice(0, 80),
    confidence_score: Math.max(0, Math.min(1, Number.isFinite(+input.confidence_score) ? +input.confidence_score : (c.intent_class === 'operational_gap' ? 0.72 : 0.45))),
    observed_at: input.observed_at ? new Date(input.observed_at).toISOString() : new Date().toISOString(),
    lat: Number.isFinite(+input.lat) ? +input.lat : null,
    lng: Number.isFinite(+input.lng) ? +input.lng : null,
    content_hash: contentHash(input)
  };
}
function overlap(a, b) {
  if (!a.size || !b.size) return 0;
  let hit = 0; for (const x of a) if (b.has(x)) hit++;
  return hit / Math.max(a.size, b.size);
}
function haversineKm(lat1, lng1, lat2, lng2) {
  if (![lat1, lng1, lat2, lng2].every(Number.isFinite)) return null;
  const r = Math.PI / 180;
  const a = Math.sin((lat2 - lat1) * r / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin((lng2 - lng1) * r / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}
function resolve(db, signal, limit = 5) {
  const name = tokens(signal.entity_name), loc = tokens(signal.location_hint), rawLoc = normalizeText(signal.location_hint);
  const candidates = db.prepare("SELECT * FROM leads WHERE stage NOT IN ('invalid') ORDER BY score DESC LIMIT 10000").all();
  const scored = [];
  for (const lead of candidates) {
    const leadName = tokens(lead.name), address = tokens((lead.area || '') + ' ' + (lead.address || '') + ' ' + (lead.city || ''));
    const nameOverlap = overlap(name, leadName), locOverlap = overlap(loc, address);
    const exactName = name.size && normalizeText(signal.entity_name) === normalizeText(lead.name);
    const leadArea = normalizeText(lead.area);\n    const exactArea = rawLoc && leadArea && (rawLoc.includes(leadArea) || leadArea.includes(rawLoc));
    const distanceKm = haversineKm(signal.lat, signal.lng, lead.lat, lead.lng);
    let score = 0; const reasons = [];
    if (exactName) { score += 0.62; reasons.push('exact business name'); }
    else if (nameOverlap >= 0.75) { score += 0.45; reasons.push('name token overlap ' + Math.round(nameOverlap * 100) + '%'); }
    else if (nameOverlap >= 0.5) { score += 0.28; reasons.push('name token overlap ' + Math.round(nameOverlap * 100) + '%'); }
    if (exactArea) { score += 0.20; reasons.push('location hint matches lead area'); }
    else if (locOverlap >= 0.5) { score += 0.18; reasons.push('location overlap ' + Math.round(locOverlap * 100) + '%'); }
    else if (locOverlap >= 0.25) { score += 0.10; reasons.push('location overlap ' + Math.round(locOverlap * 100) + '%'); }
    if (distanceKm != null) {
      if (distanceKm <= 0.25) { score += 0.22; reasons.push(distanceKm.toFixed(2) + ' km away'); }
      else if (distanceKm <= 1) { score += 0.16; reasons.push(distanceKm.toFixed(2) + ' km away'); }
      else if (distanceKm <= 3) { score += 0.08; reasons.push(distanceKm.toFixed(2) + ' km away'); }
    }
    if (signal.lat != null && signal.lng != null && distanceKm != null && distanceKm > 15) score -= 0.30;
    if (score > 0) scored.push({ lead, score: Math.max(0, Math.min(1, score)), reasons, distanceKm });
  }
  scored.sort((a, b) => b.score - a.score || b.lead.score - a.lead.score);
  const uniqueName = name.size ? candidates.filter((l) => normalizeText(l.name) === normalizeText(signal.entity_name)).length : 0;
  return scored.slice(0, Math.max(1, limit)).map((x, i) => ({
    lead_id: x.lead.id, lead: x.lead, confidence: Math.round(x.score * 1000) / 1000, rank: i + 1,
    match_status: x.score >= 0.72 && (uniqueName <= 1 || x.reasons.some((r) => /location|km away/.test(r))) ? 'matched' : x.score >= 0.45 ? 'candidate' : 'weak',
    reasons: x.reasons, distance_km: x.distanceKm == null ? null : Math.round(x.distanceKm * 100) / 100
  }));
}
function insertSignal(db, input) {
  const signal = parseSignal(input), existing = db.prepare('SELECT id FROM demand_signals WHERE content_hash=?').get(signal.content_hash);
  if (existing) return { inserted: false, duplicate: true, id: existing.id, signal };
  const r = db.prepare('INSERT INTO demand_signals(source,source_id,content_hash,raw_text,entity_name,location_hint,detected_need,intent_class,confidence_score,source_url,observed_at,created_at,lat,lng) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(signal.source, signal.source_id, signal.content_hash, signal.raw_text, signal.entity_name, signal.location_hint, signal.detected_need, signal.intent_class, signal.confidence_score, signal.source_url, signal.observed_at, Date.now(), signal.lat, signal.lng);
  return { inserted: true, duplicate: false, id: Number(r.lastInsertRowid), signal };
}
const OPPORTUNITY_STATUSES = new Set(['unreviewed', 'human_confirmed', 'rejected']);\nfunction assertOpportunityStatus(status) {\n  if (!OPPORTUNITY_STATUSES.has(status)) throw new Error('Invalid opportunity status: ' + status);\n}\nfunction confirmOpportunity(db, opportunityId, confirmedBy) {\n  if (!confirmedBy || !String(confirmedBy).trim()) throw new Error('Authenticated confirmer is required.');\n  const id = Number(opportunityId);\n  const row = db.prepare('SELECT * FROM lead_opportunities WHERE id=?').get(id);\n  if (!row) throw new Error('Opportunity not found.');\n  assertOpportunityStatus(row.status);\n  const now = Date.now();\n  db.prepare("UPDATE lead_opportunities SET status='human_confirmed', confirmed_at=?, confirmed_by=?, updated_at=? WHERE id=? AND status='unreviewed'").run(now, String(confirmedBy).slice(0, 200), now, id);\n  const out = db.prepare('SELECT * FROM lead_opportunities WHERE id=?').get(id);\n  if (out.status !== 'human_confirmed' || !out.confirmed_at || !out.confirmed_by) throw new Error('Opportunity confirmation failed.');\n  return out;\n}\nfunction rejectOpportunity(db, opportunityId, rejectedBy) {\n  if (!rejectedBy || !String(rejectedBy).trim()) throw new Error('Authenticated confirmer is required.');\n  const id = Number(opportunityId);\n  const row = db.prepare('SELECT * FROM lead_opportunities WHERE id=?').get(id);\n  if (!row) throw new Error('Opportunity not found.');\n  assertOpportunityStatus(row.status);\n  const now = Date.now();\n  db.prepare("UPDATE lead_opportunities SET status='rejected', confirmed_at=NULL, confirmed_by=?, updated_at=? WHERE id=? AND status='unreviewed'").run(String(rejectedBy).slice(0, 200), now, id);\n  return db.prepare('SELECT * FROM lead_opportunities WHERE id=?').get(id);\n}\nfunction createOpportunity(db, signalId, match) {
  const evidence = {
    source: match.signalSource || '', source_url: match.sourceUrl || '', observed_at: match.observedAt || '',
    raw_text_excerpt: match.rawText ? match.rawText.slice(0, 600) : '', match_confidence: match.confidence,
    match_reasons: match.reasons, distance_km: match.distance_km, matched_at: new Date().toISOString()
  };
  const existing = db.prepare('SELECT id FROM lead_opportunities WHERE lead_id=? AND demand_signal_id=?').get(match.lead_id, signalId);
  if (existing) {
    db.prepare('UPDATE lead_opportunities SET lead_reason=?, evidence=?, updated_at=? WHERE id=?').run(match.leadReason, JSON.stringify(evidence), Date.now(), existing.id);
    return existing.id;
  }
  const r = db.prepare('INSERT INTO lead_opportunities(lead_id,demand_signal_id,lead_reason,evidence,status,updated_at) VALUES(?,?,?,?,?,?)')
    .run(match.lead_id, signalId, match.leadReason, JSON.stringify(evidence), 'unreviewed', Date.now());
  return Number(r.lastInsertRowid);
}
module.exports = { normalizeText, tokens, contentHash, classify, parseSignal, haversineKm, resolve, insertSignal, createOpportunity, confirmOpportunity, rejectOpportunity, assertOpportunityStatus, OPPORTUNITY_STATUSES };
