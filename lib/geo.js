'use strict';
// Geocoding through OpenStreetMap Nominatim (free, 1 request/second, needs a User-Agent).
// Used to (a) confirm that a word found in keywords really is a place and (b) get coordinates for map grids.
const { sleep } = require('./util');
const db = require('./db');

const UA = 'TopicRadar/1.0 (local research tool)';
const PLACE_TYPES = new Set(['city', 'town', 'village', 'suburb', 'neighbourhood', 'hamlet', 'state', 'county', 'district', 'quarter',
  'city_district', 'locality', 'borough', 'municipality', 'administrative', 'region', 'country', 'province', 'state_district', 'residential']);

let last = 0;
let chain = Promise.resolve();
const throttled = (fn) => {
  const run = chain.then(async () => { const wait = Math.max(0, last + 1100 - Date.now()); if (wait) await sleep(wait); last = Date.now(); return fn(); });
  chain = run.catch(() => {});
  return run;
};

async function geocode(dbh, name, countryCode, base = 'https://nominatim.openstreetmap.org') {
  const key = `geo:${(countryCode || '').toLowerCase()}:${name.toLowerCase()}`;
  const hit = db.cacheGet(dbh, key);
  if (hit) return hit.none ? null : hit;
  const url = `${base}/search?q=${encodeURIComponent(name)}&format=jsonv2&limit=1${countryCode ? '&countrycodes=' + countryCode.toLowerCase() : ''}`;
  try {
    const arr = await throttled(async () => {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 10000);
      try {
        const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en' }, signal: ctl.signal });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      } finally { clearTimeout(t); }
    });
    const x = arr[0];
    const ok = x && (x.category === 'boundary' || x.category === 'place' || x.class === 'boundary' || x.class === 'place') && PLACE_TYPES.has(x.type);
    const val = ok ? { name, lat: +x.lat, lng: +x.lon, type: x.type, label: x.display_name } : { none: true };
    db.cacheSet(dbh, key, val, 90 * 864e5);
    return ok ? val : null;
  } catch { return undefined; } // network problem: unknown, do not cache
}

const R = 6371;
const toRad = (d) => (d * Math.PI) / 180;
const offset = (lat, lng, dxKm, dyKm) => ({ lat: lat + (dyKm / R) * (180 / Math.PI), lng: lng + ((dxKm / R) * (180 / Math.PI)) / Math.cos(toRad(lat)) });

// Circles that cover a city: a square lattice inside coverKm of the centre. Each circle has radius ~0.75 * step.
function grid(lat, lng, coverKm = 12, stepKm = 4) {
  const pts = [];
  const n = Math.ceil(coverKm / stepKm);
  for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) {
    const dx = i * stepKm, dy = j * stepKm;
    if (Math.hypot(dx, dy) > coverKm + stepKm * 0.4) continue;
    const p = offset(lat, lng, dx, dy);
    pts.push({ lat: +p.lat.toFixed(5), lng: +p.lng.toFixed(5), radius: Math.round(stepKm * 750) });
  }
  return pts;
}

module.exports = { geocode, grid };
