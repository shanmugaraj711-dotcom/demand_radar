'use strict';

const { SourceAdapter } = require('../adapters');
const { normalizeMention } = require('../normalization');
const { validateSafeUrl, safeFetch } = require('./common');

const FACEBOOK_ALLOWED_HOSTS = new Set([
  'graph.facebook.com',
  'api.facebook.com'
]);

class FacebookSourceAdapter extends SourceAdapter {
  constructor(options = {}) {
    super('facebook', options);
    this.accessToken = options.accessToken || process.env.FACEBOOK_ACCESS_TOKEN || null;
    this.pageId = options.pageId || process.env.FACEBOOK_PAGE_ID || 'me';
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
      throw new Error('Raw Facebook item must be an object.');
    }

    const postId = String(rawItem.id || '').trim();
    if (!postId) {
      throw new Error('Facebook item missing id.');
    }

    const message = String(rawItem.message || rawItem.story || rawItem.description || '').trim();
    const sourceUrl = `https://www.facebook.com/${encodeURIComponent(postId)}`;
    const author = String(rawItem.from?.name || rawItem.from?.id || '').trim();

    let observedAt;
    if (rawItem.created_time) {
      const d = new Date(rawItem.created_time);
      observedAt = Number.isFinite(d.getTime()) ? d.toISOString() : new Date().toISOString();
    } else {
      observedAt = new Date().toISOString();
    }

    return normalizeMention({
      source: this.name,
      source_id: postId,
      source_url: sourceUrl,
      raw_text: message,
      observed_at: observedAt,
      author,
      location_hint: rawItem.place?.name || '',
      metadata: {
        postId,
        from: rawItem.from || null,
        place: rawItem.place || null
      }
    });
  }

  async fetch(query, options = {}) {
    const effectiveToken = options.accessToken || this.accessToken;
    if (!effectiveToken && !options.fetchFn && !this.fetchFn) {
      throw new Error('Facebook adapter is disabled: Official Meta Graph API access requires configured developer credentials (FACEBOOK_ACCESS_TOKEN). HTML scraping and credential bypass are strictly disallowed.');
    }

    const limit = Math.max(1, Math.min(this.maxItems, Number(options.maxItems) || this.maxItems));
    const targetPage = encodeURIComponent(options.pageId || this.pageId);
    const endpoint = `https://graph.facebook.com/v19.0/${targetPage}/feed?fields=id,message,created_time,from,place&limit=${limit}&access_token=${encodeURIComponent(effectiveToken || 'mock-token')}`;

    validateSafeUrl(endpoint, { allowedHosts: FACEBOOK_ALLOWED_HOSTS });

    const rawResponse = await safeFetch(endpoint, {
      timeoutMs: options.timeoutMs || this.timeoutMs,
      maxBytes: options.maxBytes || this.maxBytes,
      fetchFn: options.fetchFn || this.fetchFn,
      allowedHosts: FACEBOOK_ALLOWED_HOSTS
    });

    let data;
    try {
      data = typeof rawResponse === 'string' ? JSON.parse(rawResponse) : rawResponse;
    } catch {
      throw new Error('Facebook API response is malformed or invalid JSON.');
    }

    if (data.error) {
      throw new Error(`Facebook API error ${data.error.code || 400}: ${data.error.message || 'Request failed'}`);
    }

    const items = Array.isArray(data.data) ? data.data : [];
    return items.slice(0, limit).map(item => this.normalize(item));
  }
}

module.exports = {
  FacebookSourceAdapter,
  FACEBOOK_ALLOWED_HOSTS
};
