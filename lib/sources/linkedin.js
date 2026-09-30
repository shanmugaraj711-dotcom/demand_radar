'use strict';

const { SourceAdapter } = require('../adapters');
const { normalizeMention } = require('../normalization');
const { validateSafeUrl, safeFetch } = require('./common');

const LINKEDIN_ALLOWED_HOSTS = new Set([
  'api.linkedin.com',
  'www.linkedin.com'
]);

class LinkedInSourceAdapter extends SourceAdapter {
  constructor(options = {}) {
    super('linkedin', options);
    this.accessToken = options.accessToken || process.env.LINKEDIN_ACCESS_TOKEN || null;
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
      throw new Error('Raw LinkedIn item must be an object.');
    }

    const shareId = String(rawItem.id || rawItem.urn || '').trim();
    if (!shareId) {
      throw new Error('LinkedIn item missing share id / URN.');
    }

    const text = String(
      rawItem.text?.text ||
      rawItem.commentary ||
      rawItem.specificContent?.['com.linkedin.ugc.ShareContent']?.shareCommentary?.text ||
      rawItem.text ||
      ''
    ).trim();

    const cleanId = shareId.replace(/^urn:li:share:/, '').replace(/^urn:li:ugcPost:/, '');
    const sourceUrl = `https://www.linkedin.com/feed/update/urn:li:activity:${encodeURIComponent(cleanId)}`;
    const author = String(rawItem.author || rawItem.owner || '').replace(/^urn:li:person:/, '').replace(/^urn:li:organization:/, '');

    let observedAt;
    if (rawItem.created?.time || rawItem.createdAt) {
      const ms = Number(rawItem.created?.time || rawItem.createdAt);
      const d = Number.isFinite(ms) ? new Date(ms) : new Date(rawItem.created?.time || rawItem.createdAt);
      observedAt = Number.isFinite(d.getTime()) ? d.toISOString() : new Date().toISOString();
    } else {
      observedAt = new Date().toISOString();
    }

    return normalizeMention({
      source: this.name,
      source_id: shareId,
      source_url: sourceUrl,
      raw_text: text,
      observed_at: observedAt,
      author: author ? `urn:${author}` : '',
      location_hint: '',
      metadata: {
        shareId,
        author: rawItem.author || null,
        distribution: rawItem.distribution || null
      }
    });
  }

  async fetch(query, options = {}) {
    const effectiveToken = options.accessToken || this.accessToken;
    if (!effectiveToken && !options.fetchFn && !this.fetchFn) {
      throw new Error('LinkedIn adapter is disabled: Official LinkedIn API access requires approved LinkedIn Developer Partner credentials. Arbitrary member-post scraping is strictly prohibited.');
    }

    const limit = Math.max(1, Math.min(this.maxItems, Number(options.maxItems) || this.maxItems));
    const endpoint = `https://api.linkedin.com/v2/shares?q=owners&count=${limit}`;

    validateSafeUrl(endpoint, { allowedHosts: LINKEDIN_ALLOWED_HOSTS });

    const rawResponse = await safeFetch(endpoint, {
      timeoutMs: options.timeoutMs || this.timeoutMs,
      maxBytes: options.maxBytes || this.maxBytes,
      headers: {
        'Authorization': `Bearer ${effectiveToken || 'mock-token'}`,
        'X-Restli-Protocol-Version': '2.0.0'
      },
      fetchFn: options.fetchFn || this.fetchFn,
      allowedHosts: LINKEDIN_ALLOWED_HOSTS
    });

    let data;
    try {
      data = typeof rawResponse === 'string' ? JSON.parse(rawResponse) : rawResponse;
    } catch {
      throw new Error('LinkedIn API response is malformed or invalid JSON.');
    }

    if (data.serviceErrorCode || data.status >= 400) {
      throw new Error(`LinkedIn API error ${data.status || data.serviceErrorCode}: ${data.message || 'Request failed'}`);
    }

    const items = Array.isArray(data.elements) ? data.elements : [];
    return items.slice(0, limit).map(item => this.normalize(item));
  }
}

module.exports = {
  LinkedInSourceAdapter,
  LINKEDIN_ALLOWED_HOSTS
};
