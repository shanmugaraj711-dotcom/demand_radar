'use strict';
// Google Places API (New) - Text Search. Needs the user's own API key with billing enabled.
const { sleep } = require('./util');

const FIELDS = [
  'places.id', 'places.displayName', 'places.formattedAddress', 'places.shortFormattedAddress', 'places.nationalPhoneNumber',
  'places.internationalPhoneNumber', 'places.websiteUri', 'places.rating', 'places.userRatingCount', 'places.googleMapsUri',
  'places.businessStatus', 'places.location', 'places.types', 'nextPageToken',
].join(',');

class PlacesError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

function normalize(p) {
  return {
    place_id: p.id,
    name: p.displayName && p.displayName.text || '',
    address: p.formattedAddress || '',
    area: p.shortFormattedAddress || '',
    phone: p.nationalPhoneNumber || '',
    intl_phone: p.internationalPhoneNumber || '',
    website: p.websiteUri || '',
    rating: p.rating == null ? null : p.rating,
    reviews: p.userRatingCount == null ? null : p.userRatingCount,
    maps_url: p.googleMapsUri || '',
    status: p.businessStatus || '',
    lat: p.location ? p.location.latitude : null,
    lng: p.location ? p.location.longitude : null,
    types: p.types || [],
  };
}

/** One Text Search, following up to `pages` pages (20 results each, 60 max). Returns { places, requests }. */
async function textSearch(o) {
  const out = [];
  let pageToken, requests = 0;
  for (let page = 0; page < (o.pages || 3); page++) {
    const body = { textQuery: o.textQuery, pageSize: 20, languageCode: o.lang || 'en' };
    if (o.region) body.regionCode = o.region;
    if (o.bias) body.locationBias = { circle: { center: { latitude: o.bias.lat, longitude: o.bias.lng }, radius: o.bias.radius } };
    if (pageToken) body.pageToken = pageToken;
    const res = await fetch((o.base || 'https://places.googleapis.com') + '/v1/places:searchText', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': o.key, 'X-Goog-FieldMask': FIELDS },
      body: JSON.stringify(body),
      signal: o.signal,
    });
    requests++;
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new PlacesError((j.error && j.error.message) || `Places API returned HTTP ${res.status}`, res.status);
    const got = j.places || [];
    got.forEach((p) => out.push(normalize(p)));
    pageToken = j.nextPageToken;
    if (!pageToken || got.length < 20) break;
    await sleep(250, o.signal);
  }
  return { places: out, requests };
}

module.exports = { textSearch, PlacesError, normalize };
