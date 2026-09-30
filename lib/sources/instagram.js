'use strict';

const { SourceAdapter } = require('../adapters');
const { normalizeMention } = require('../normalization');
const { validateSafeUrl, safeFetch } = require('./common');

const INSTAGRAM_ALLOWED_HOSTS = new Set([
  'graph.facebook.com',
  'graph.instagram.com',
  'api.instagram.com'
]);

class InstagramSourceAdapter extends SourceAdapter {
  constructor(options = {}) {
    super('instagram', options);
    this.accessToken = options.accessToken || process.env.INSTAGRAM_ACCESS_TOKEN || null;
    this.maxItems = Math.max(1, Math.min(50, Number(options.maxItems) || 20));
    this.timeoutMs = Math.max(500, Math.min(30000, Number(options.timeoutMs) || 8000));
    this.maxBytes = Math.max(1024, Math.min(5 * 1024 * 1024, Number(options.maxBytes) || 1024 * 1024));
    this.fetchFn = options.fetchFn || null;
  }

  isConfigured() {
    return Boolean(this.accessToken || this.fetchFn);
  }

  normalize(rawItem) {
    if (!rawItem || typeof rawItem !== 'object') {
      throw new Error('Raw Instagram item must be an object.');
    }

    const mediaId = String(rawItem.id || '').trim();
    if (!mediaId) {
      throw new Error('Instagram item missing media id.');
    }

    const caption = String(rawItem.caption || rawItem.text || '').trim();
    const permalink = String(rawItem.permalink || `https://www.instagram.com/p/${encodeURIComponent(mediaId)}/`).trim();
    const username = String(rawItem.username || '').trim();

    let observedAt;
    if (rawItem.timestamp) {
      const d = new Date(rawItem.timestamp);
      observedAt = Number.isFinite(d.getTime()) ? d.toISOString() : new Date().toISOString();
    } else {
      observedAt = new Date().toISOString();
    }

    return normalizeMention({
      source: this.name,
      source_id: mediaId,
      source_url: permalink,
      raw_text: caption,
      observed_at: observedAt,
      author: username ? (username.startsWith('@') ? username : `@${username}`) : '',
      location_hint: '',
      metadata: {
        mediaId,
        media_type: rawItem.media_type || null,
        username: username || null
      }
    });
  }

  async fetch(query, options = {}) {
    const effectiveToken = options.accessToken || this.accessToken;
    if (!effectiveToken && !options.fetchFn && !this.fetchFn) {
      throw new Error('Instagram adapter is disabled: Official Instagram Graph API credentials (INSTAGRAM_ACCESS_TOKEN) are required. HTML scraping and browser automation are strictly prohibited.');
    }

    const limit = Math.max(1, Math.min(this.maxItems, Number(options.maxItems) || this.maxItems));
    const endpoint = `https://graph.instagram.com/me/media?fields=id,caption,media_type,permalink,timestamp,username&limit=${limit}&access_token=${encodeURIComponent(effectiveToken || 'mock-token')}`;

    validateSafeUrl(endpoint, { allowedHosts: INSTAGRAM_ALLOWED_HOSTS });

    const rawResponse = await safeFetch(endpoint, {
      timeoutMs: options.timeoutMs || this.timeoutMs,
      maxBytes: options.maxBytes || this.maxBytes,
      fetchFn: options.fetchFn || this.fetchFn,
      allowedHosts: INSTAGRAM_ALLOWED_HOSTS
    });

    let data;
    try {
      data = typeof rawResponse === 'string' ? JSON.parse(rawResponse) : rawResponse;
    } catch {
      throw new Error('Instagram API response is malformed or invalid JSON.');
    }

    if (data.error) {
      throw new Error(`Instagram API error ${data.error.code || 400}: ${data.error.message || 'Request failed'}`);
    }

    const items = Array.isArray(data.data) ? data.data : [];
    return items.slice(0, limit).map(item => this.normalize(item));
  }
}

module.exports = {
  InstagramSourceAdapter,
  INSTAGRAM_ALLOWED_HOSTS
};
