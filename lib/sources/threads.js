'use strict';

const { SourceAdapter } = require('../adapters');
const { normalizeMention } = require('../normalization');
const { validateSafeUrl, safeFetch } = require('./common');

const THREADS_ALLOWED_HOSTS = new Set([
  'graph.threads.net'
]);

class ThreadsSourceAdapter extends SourceAdapter {
  constructor(options = {}) {
    super('threads', options);
    this.accessToken = options.accessToken || process.env.THREADS_ACCESS_TOKEN || null;
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
      throw new Error('Raw Threads item must be an object.');
    }

    const threadId = String(rawItem.id || '').trim();
    if (!threadId) {
      throw new Error('Threads item missing id.');
    }

    const text = String(rawItem.text || '').trim();
    const permalink = String(rawItem.permalink || `https://www.threads.net/post/${encodeURIComponent(threadId)}`).trim();
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
      source_id: threadId,
      source_url: permalink,
      raw_text: text,
      observed_at: observedAt,
      author: username ? (username.startsWith('@') ? username : `@${username}`) : '',
      location_hint: '',
      metadata: {
        threadId,
        username: username || null,
        media_type: rawItem.media_type || null
      }
    });
  }

  async fetch(query, options = {}) {
    const effectiveToken = options.accessToken || this.accessToken;
    if (!effectiveToken && !options.fetchFn && !this.fetchFn) {
      throw new Error('Threads adapter is disabled: Official Meta Threads API credentials (THREADS_ACCESS_TOKEN) are required. HTML scraping and browser automation are strictly prohibited.');
    }

    const limit = Math.max(1, Math.min(this.maxItems, Number(options.maxItems) || this.maxItems));
    const endpoint = `https://graph.threads.net/v1.0/me/threads?fields=id,text,timestamp,permalink,username,media_type&limit=${limit}&access_token=${encodeURIComponent(effectiveToken || 'mock-token')}`;

    validateSafeUrl(endpoint, { allowedHosts: THREADS_ALLOWED_HOSTS });

    const rawResponse = await safeFetch(endpoint, {
      timeoutMs: options.timeoutMs || this.timeoutMs,
      maxBytes: options.maxBytes || this.maxBytes,
      fetchFn: options.fetchFn || this.fetchFn,
      allowedHosts: THREADS_ALLOWED_HOSTS
    });

    let data;
    try {
      data = typeof rawResponse === 'string' ? JSON.parse(rawResponse) : rawResponse;
    } catch {
      throw new Error('Threads API response is malformed or invalid JSON.');
    }

    if (data.error) {
      throw new Error(`Threads API error ${data.error.code || 400}: ${data.error.message || 'Request failed'}`);
    }

    const items = Array.isArray(data.data) ? data.data : [];
    return items.slice(0, limit).map(item => this.normalize(item));
  }
}

module.exports = {
  ThreadsSourceAdapter,
  THREADS_ALLOWED_HOSTS
};
