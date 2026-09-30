'use strict';

const { SourceAdapter } = require('../adapters');
const { normalizeMention } = require('../normalization');
const { validateSafeUrl, safeFetch } = require('./common');

const YOUTUBE_ALLOWED_HOSTS = new Set([
  'www.googleapis.com',
  'googleapis.com',
  'youtube.googleapis.com'
]);

class YouTubeSourceAdapter extends SourceAdapter {
  constructor(options = {}) {
    super('youtube', options);
    this.apiKey = options.apiKey || process.env.YOUTUBE_API_KEY || null;
    this.maxItems = Math.max(1, Math.min(50, Number(options.maxItems) || 20));
    this.timeoutMs = Math.max(500, Math.min(30000, Number(options.timeoutMs) || 8000));
    this.maxBytes = Math.max(1024, Math.min(5 * 1024 * 1024, Number(options.maxBytes) || 1024 * 1024));
    this.fetchFn = options.fetchFn || null;
  }

  isConfigured() {
    return Boolean(this.apiKey || this.fetchFn);
  }

  normalize(rawItem) {
    if (!rawItem || typeof rawItem !== 'object') {
      throw new Error('Raw YouTube item must be an object.');
    }

    const videoId = String(rawItem.id?.videoId || rawItem.id || '').trim();
    if (!videoId) {
      throw new Error('YouTube item missing videoId.');
    }

    const snippet = rawItem.snippet || {};
    const title = String(snippet.title || '').trim();
    const description = String(snippet.description || '').trim();
    const rawText = title ? (description ? `${title}\n${description}` : title) : description;

    const sourceUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
    const channelTitle = String(snippet.channelTitle || '').trim();

    let observedAt;
    if (snippet.publishedAt) {
      const d = new Date(snippet.publishedAt);
      observedAt = Number.isFinite(d.getTime()) ? d.toISOString() : new Date().toISOString();
    } else {
      observedAt = new Date().toISOString();
    }

    return normalizeMention({
      source: this.name,
      source_id: videoId,
      source_url: sourceUrl,
      raw_text: rawText,
      observed_at: observedAt,
      author: channelTitle,
      location_hint: '',
      metadata: {
        channelId: snippet.channelId || null,
        channelTitle: channelTitle || null,
        videoId
      }
    });
  }

  async fetch(query, options = {}) {
    const q = String(query || '').trim();
    if (!q) {
      throw new Error('Search query is required for YouTube adapter.');
    }

    const effectiveKey = options.apiKey || this.apiKey;
    if (!effectiveKey && !options.fetchFn && !this.fetchFn) {
      throw new Error('YouTube adapter is disabled: Official YouTube Data API v3 key (YOUTUBE_API_KEY) is required. HTML scraping is strictly disallowed.');
    }

    const limit = Math.max(1, Math.min(this.maxItems, Number(options.maxItems) || this.maxItems));
    const endpoint = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&q=${encodeURIComponent(q)}&maxResults=${limit}&key=${encodeURIComponent(effectiveKey || 'mock-key')}`;

    // Security validation on constructed endpoint
    validateSafeUrl(endpoint, { allowedHosts: YOUTUBE_ALLOWED_HOSTS });

    const rawResponse = await safeFetch(endpoint, {
      timeoutMs: options.timeoutMs || this.timeoutMs,
      maxBytes: options.maxBytes || this.maxBytes,
      fetchFn: options.fetchFn || this.fetchFn,
      allowedHosts: YOUTUBE_ALLOWED_HOSTS
    });

    let data;
    try {
      data = typeof rawResponse === 'string' ? JSON.parse(rawResponse) : rawResponse;
    } catch {
      throw new Error('YouTube API response is malformed or invalid JSON.');
    }

    if (data.error) {
      const code = data.error.code || 400;
      const msg = data.error.message || 'YouTube API error';
      throw new Error(`YouTube API error ${code}: ${msg}`);
    }

    const items = Array.isArray(data.items) ? data.items : [];
    const capped = items.slice(0, limit);
    return capped.map(item => this.normalize(item));
  }
}

module.exports = {
  YouTubeSourceAdapter,
  YOUTUBE_ALLOWED_HOSTS
};
