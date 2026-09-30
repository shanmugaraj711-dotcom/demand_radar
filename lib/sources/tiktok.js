'use strict';

const { SourceAdapter } = require('../adapters');
const { normalizeMention } = require('../normalization');
const { validateSafeUrl, safeFetch } = require('./common');

const TIKTOK_ALLOWED_HOSTS = new Set([
  'open.tiktokapis.com',
  'business-api.tiktok.com'
]);

class TikTokSourceAdapter extends SourceAdapter {
  constructor(options = {}) {
    super('tiktok', options);
    this.accessToken = options.accessToken || process.env.TIKTOK_ACCESS_TOKEN || null;
    this.isResearchTier = Boolean(options.researchTier || process.env.TIKTOK_RESEARCH_APPROVED === 'true');
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
      throw new Error('Raw TikTok item must be an object.');
    }

    const videoId = String(rawItem.id || rawItem.video_id || '').trim();
    if (!videoId) {
      throw new Error('TikTok item missing video id.');
    }

    const title = String(rawItem.video_description || rawItem.title || rawItem.desc || '').trim();
    const username = String(rawItem.username || rawItem.author_name || '').trim();
    const sourceUrl = String(rawItem.share_url || `https://www.tiktok.com/@${encodeURIComponent(username || 'user')}/video/${encodeURIComponent(videoId)}`).trim();

    let observedAt;
    if (rawItem.create_time) {
      const ms = Number(rawItem.create_time) * 1000;
      const d = Number.isFinite(ms) ? new Date(ms) : new Date(rawItem.create_time);
      observedAt = Number.isFinite(d.getTime()) ? d.toISOString() : new Date().toISOString();
    } else {
      observedAt = new Date().toISOString();
    }

    return normalizeMention({
      source: this.name,
      source_id: videoId,
      source_url: sourceUrl,
      raw_text: title,
      observed_at: observedAt,
      author: username ? (username.startsWith('@') ? username : `@${username}`) : '',
      location_hint: rawItem.region_code || '',
      metadata: {
        videoId,
        isResearchTier: this.isResearchTier,
        region_code: rawItem.region_code || null,
        like_count: rawItem.like_count ?? null,
        comment_count: rawItem.comment_count ?? null
      }
    });
  }

  async fetch(query, options = {}) {
    const effectiveToken = options.accessToken || this.accessToken;
    if (!effectiveToken && !options.fetchFn && !this.fetchFn) {
      throw new Error('TikTok adapter is disabled: Requires approved TikTok API access credentials (TIKTOK_ACCESS_TOKEN). Commercial/public search requires explicit TikTok Research API partner approval. HTML scraping is strictly disallowed.');
    }

    const limit = Math.max(1, Math.min(this.maxItems, Number(options.maxItems) || this.maxItems));
    const endpoint = 'https://open.tiktokapis.com/v2/video/list/';

    validateSafeUrl(endpoint, { allowedHosts: TIKTOK_ALLOWED_HOSTS });

    const rawResponse = await safeFetch(endpoint, {
      timeoutMs: options.timeoutMs || this.timeoutMs,
      maxBytes: options.maxBytes || this.maxBytes,
      headers: {
        'Authorization': `Bearer ${effectiveToken || 'mock-token'}`
      },
      fetchFn: options.fetchFn || this.fetchFn,
      allowedHosts: TIKTOK_ALLOWED_HOSTS
    });

    let data;
    try {
      data = typeof rawResponse === 'string' ? JSON.parse(rawResponse) : rawResponse;
    } catch {
      throw new Error('TikTok API response is malformed or invalid JSON.');
    }

    if (data.error && data.error.code !== 'ok' && data.error.code !== 0) {
      throw new Error(`TikTok API error ${data.error.code}: ${data.error.message || 'Request failed'}`);
    }

    const items = Array.isArray(data.data?.videos) ? data.data.videos : [];
    return items.slice(0, limit).map(item => this.normalize(item));
  }
}

module.exports = {
  TikTokSourceAdapter,
  TIKTOK_ALLOWED_HOSTS
};
