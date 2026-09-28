'use strict';
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const geo = require('../lib/geo');
const enrich = require('../lib/enrich');

const OVERPASS = process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter';
const NOMINATIM = process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org';
const UA = 'DemandRadar/OSM-coverage-test/1.0 (manual research tool)';
const PROD_DB = process.env.RADAR_PROD_DB;
const TEST_DB = process.env.RADAR_TEST_DB || '/tmp/demand-radar-osm-test.db';
const RADIUS_M = Number(process.env.OSM_RADIUS_M || 20000);

const SEARCHES = [
  { q: 'abacus classes', tags: ['amenity~"^(school|college|training)$"', 'office="educational_institution"'], names: ['abacus'] },
  { q: 'yoga classes', tags: ['leisure="fitness_centre"', 'leisure="sports_centre"', 'amenity="school"'], names: ['yoga'] },
  { q: 'tally course', tags: ['amenity="school"', 'office="educational_institution"'], names: ['tally'] },
  { q: 'dance classes', tags: ['leisure="dance"', 'amenity="school"', 'leisure="fitness_centre"'], names: ['dance', 'bharatanatyam'] },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
function escRe(s) { return String(s).replace(/[|\\{}()[\]^$+*?.-]/g, '\\$&'); }
const pct = (n, d) => d ? +(100 * n / d).toFixed(1) : 0;

function distanceM(a, b) {
  const R = 6371000, p = Math.PI / 180;
  const dLat = (b.lat - a.lat) * p, dLon = (b.lon - a.lon) * p;
  const x = Math.sin(dLat/2)**2 + Math.cos(a.lat*p)*Math.cos(b.lat*p)*Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
function normName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\u0b80-\u0bff]+/g, ' ').trim().replace(/\s+/g, ' ');
}
function fuzzyDedupe(rows) {
  const out = [];
  for (const r of rows) {
    const n = normName(r.name);
    const hit = n && out.find(x => normName(x.name) === n && distanceM(x, r) <= 100);
    if (hit) { hit.osmIds.push(r.osm); continue; }
    out.push({ ...r, osmIds: [r.osm] });
  }
  return out;
}
function buildQuery(lat, lon, spec) {
  const nameRe = spec.names.map(escRe).join('|');
  const blocks = spec.tags.map(tag => \`nwr[\${tag}](around:\${RADIUS_M},\${lat},\${lon});\`);
  blocks.push(\`nwr["name"~"\${nameRe}",i](around:\${RADIUS_M},\${lat},\${lon});\`);
  return \`[out:json][timeout:60];(\${blocks.join('')});out center tags;\`;
}
async function overpass(query) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 75000);
  try {
    const r = await fetch(OVERPASS, {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ data: query }),
      signal: ctl.signal
    });
    if (!r.ok) throw new Error('Overpass HTTP ' + r.status);
    return r.json();
  } finally { clearTimeout(timer); }
}
function rowsFrom(data, spec) {
  const seen = new Set(), nameRe = new RegExp(spec.names.map(escRe).join('|'), 'i'), rows = [];
  for (const e of data.elements || []) {
    const t = e.tags || {}, c = e.center || {};
    const lat = Number(e.lat ?? c.lat), lon = Number(e.lon ?? c.lon), name = String(t.name || '').trim();
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const osm = e.type + '/' + e.id;
    if (seen.has(osm)) continue;
    seen.add(osm);
    rows.push({
      osm, name, lat, lon,
      phone: t.phone || t['contact:phone'] || t['contact:mobile'] || '',
      website: t.website || t['contact:website'] || '',
      address: [t['addr:housenumber'], t['addr:street'], t['addr:suburb'], t['addr:city'], t['addr:postcode']].filter(Boolean).join(', '),
      category: t.amenity || t.leisure || t.office || t.shop || t.tourism || '',
      matchedName: nameRe.test(name)
    });
  }
  return rows;
}
async function enrichRows(rows) {
  for (const r of rows) {
    if (!r.website) continue;
    const e = await enrich.enrich(r.website);
    if (e.ok) {
      r.enrichedPhones = e.phones || [];
      r.enrichedWhatsApp = e.wa || [];
      r.enrichedPhoneCount = r.enrichedPhones.length + r.enrichedWhatsApp.length;
    }
  }
}
function phoneKind(raw) {
  if (!raw) return 'none';
  const d = String(raw).replace(/\D/g, '');
  const n = d.length === 12 && d.startsWith('91') ? d.slice(2) : d.replace(/^0/, '');
  return n.length === 10 && /^[6-9]/.test(n) ? 'mobile' : 'landline';
}
function report(spec, raw, rows) {
  const rawPhones = rows.filter(x => x.phone);
  const enrichedPhones = rows.filter(x => x.phone || x.enrichedPhoneCount > 0);
  const mobile = rows.filter(x => phoneKind(x.phone) === 'mobile');
  const landline = rows.filter(x => phoneKind(x.phone) === 'landline');
  const website = rows.filter(x => x.website);
  const address = rows.filter(x => x.address);
  return {
    search: spec.q,
    total: rows.length,
    rawElementsBeforeFuzzyDedupe: raw.length,
    fuzzyDuplicatesRemoved: raw.length - rows.length,
    phoneRaw: rawPhones.length,
    phoneRawPct: pct(rawPhones.length, rows.length),
    phoneAfterExistingEnrichment: enrichedPhones.length,
    phoneAfterExistingEnrichmentPct: pct(enrichedPhones.length, rows.length),
    mobileRaw: mobile.length,
    mobileRawPct: pct(mobile.length, rows.length),
    landlineRaw: landline.length,
    landlineRawPct: pct(landline.length, rows.length),
    website: website.length,
    websitePct: pct(website.length, rows.length),
    address: address.length,
    addressPct: pct(address.length, rows.length)
  };
}

async function main() {
  if (!PROD_DB || !fs.existsSync(PROD_DB)) throw new Error('Set RADAR_PROD_DB to the production radar.db path.');
  if (fs.existsSync(TEST_DB)) fs.rmSync(TEST_DB);
  const src = new DatabaseSync(PROD_DB);
  src.exec(\`VACUUM INTO '\${TEST_DB.replace(/'/g, "''")}'\`);
  src.close();

  const db = new DatabaseSync(TEST_DB);
  const city = await geo.geocode(db, 'Chennai', 'IN', NOMINATIM);
  if (!city) throw new Error('Could not geocode Chennai.');
  console.log(\`Chennai: \${city.lat}, \${city.lng}\`);

  const reports = [];
  for (const spec of SEARCHES) {
    console.log('\\n' + spec.q);
    const raw = rowsFrom(await overpass(buildQuery(city.lat, city.lng, spec)), spec);
    const rows = fuzzyDedupe(raw);
    await enrichRows(rows);
    const r = report(spec, raw, rows);
    reports.push(r);
    console.log(JSON.stringify(r, null, 2));
    await sleep(1100);
  }

  const output = { generated: new Date().toISOString(), city: 'Chennai', radiusM: RADIUS_M, method: 'Overpass tag union + name match; OSM type/id; fuzzy same-name within 100m; existing website enrichment; no production writes', reports };
  fs.writeFileSync('/tmp/demand-radar-osm-coverage.json', JSON.stringify(output, null, 2));
  console.table(reports);
  db.close();
}
main().catch(e => { console.error(e.stack || e); process.exit(1); });
