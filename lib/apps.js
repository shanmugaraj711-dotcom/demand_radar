'use strict';
// Competing apps, from Apple's public iTunes Search API (official, free, no key).
// Tells you how crowded a topic is and how good the incumbents really are.
async function searchApps(term, country = 'IN', limit = 25, base) {
  const url = `${base || 'https://itunes.apple.com'}/search?term=${encodeURIComponent(term)}&entity=software&country=${encodeURIComponent(country)}&limit=${limit}`;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 12000);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error(`App Store search returned HTTP ${r.status}`);
    const j = JSON.parse(await r.text());
    const apps = (j.results || []).map((a) => ({
      name: a.trackName, developer: a.artistName, rating: a.averageUserRating ? +a.averageUserRating.toFixed(1) : null,
      ratings: a.userRatingCount || 0, price: a.formattedPrice || '', genre: a.primaryGenreName || '', url: a.trackViewUrl || '',
      updated: a.currentVersionReleaseDate || '',
    }));
    const rated = apps.filter((a) => a.ratings > 0);
    const totalRatings = rated.reduce((s, a) => s + a.ratings, 0);
    return {
      apps, count: apps.length, totalRatings,
      strongest: rated.sort((a, b) => b.ratings - a.ratings)[0] || null,
      // How hard is it to break in? Few apps with few ratings = open field.
      crowd: apps.length < 8 ? 'open' : totalRatings > 20000 ? 'crowded' : 'moderate',
    };
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('App Store search timed out. Try again.');
    throw e;
  } finally { clearTimeout(t); }
}
module.exports = { searchApps };
