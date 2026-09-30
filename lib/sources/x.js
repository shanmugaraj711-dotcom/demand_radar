'use strict';

const { SourceAdapter } = require('../adapters');
const { normalizeMention } = require('../normalization');
const { validateSafeUrl, safeFetch } = require('./common');

const X_ALLOWED_HOSTS = new Set([
  'api.twitter.com',
  'api.x.com'
]);

class XSourceAdapter extends SourceAdapter {
  constructor(options = {}) {
    super('x', options);
    this.bearerToken = options.bearerToken || process.env.X_BEARER_TOKEN || null;
    this.maxItems = Math.max(10, Math.min(100, Number(options.maxItems) || 20));
    this.timeoutMs = Math.max(500, Math.min(30000, Number(options.timeoutMs) || 8000));
    this.maxBytes = Math.max(1024, Math.min(5 * 1024 * 1024, Number(options.maxBytes) || 1024 * 1024));
    this.fetchFn = options.fetchFn || null;
  }

  isConfigured() {
    return Boolean(this.bearerToken || this.fetchFn);
  }

  normalize(rawItem) {
    if (!rawItem || typeof rawItem !== 'object') {
      throw new Error('Raw X item must be an object.');
    }

    const tweetId = String(rawItem.id || '').trim();
    if (!tweetId) {
      throw new Error('X item missing tweet id.');
    }

    const text = String(rawItem.text || '').trim();
    const sourceUrl = `https://x.com/i/status/${encodeURIComponent(tweetId)}`;
    const author = String(rawItem.author_username || rawItem.author_id || rawItem.author || '').trim();

    let observedAt;
    if (rawItem.created_at) {
      const d = new Date(rawItem.created_at);
      observedAt = Number.isFinite(d.getTime()) ? d.toISOString() : new Date().toISOString();
    } else {
      observedAt = new Date().toISOString();
    }

    return normalizeMention({
      source: this.name,
      source_id: tweetId,
      source_url: sourceUrl,
      raw_text: text,
      observed_at: observedAt,
      author: author ? (author.startsWith('@') ? author : `@${author}`) : '',
      location_hint: rawItem.geo?.place_id || '',
      metadata: {
        tweetId,
        author_id: rawItem.author_id || null,
        public_metrics: rawItem.public_metrics || null
      }
    });
  }

  async fetch(query, options = {}) {
    const q = String(query || '').trim();
    if (!q) {
      throw new Error('Search query is required for X adapter.');
    }

    const effectiveToken = options.bearerToken || this.bearerToken;
    if (!effectiveToken && !options.fetchFn && !this.fetchFn) {
      throw new Error('X adapter is disabled: Official X API v2 credentials (X_BEARER_TOKEN) are required. HTML scraping and browser automation are strictly prohibited.');
    }

    const limit = Math.max(10, Math.min(100, Number(options.maxItems) || this.maxItems));
    const endpoint = `https://api.x.com/2/tweets/search/recent?query=${encodeURIComponent(q)}&max_results=${limit}&tweet.fields=created_at,author_id,public_metrics`;

    validateSafeUrl(endpoint, { allowedHosts: X_ALLOWED_HOSTS });

    const rawResponse = await safeFetch(endpoint, {
      timeoutMs: options.timeoutMs || this.timeoutMs,
      maxBytes: options.maxBytes || this.maxBytes,
      headers: {
        'Authorization': `Bearer ${effectiveToken || 'mock-token'}`
      },
      fetchFn: options.fetchFn || this.fetchFn,
      allowedHosts: X_ALLOWED_HOSTS
    });

    let data;
    try {
      data = typeof rawResponse === 'string' ? JSON.parse(rawResponse) : rawResponse;
    } catch {
      throw new Error('X API response is malformed or invalid JSON.');
    }

    if (data.errors && !data.data) {
      const err = Array.isArray(data.errors) ? data.errors[0] : data.errors;
      throw new Error(`X API error: ${err.message || err.detail || 'Request failed'}`);
    }

    const items = Array.isArray(data.data) ? data.data : [];
    return items.map(item => this.normalize(item));
  }
}

module.exports = {
  XSourceAdapter,
  X_ALLOWED_HOSTS
};
