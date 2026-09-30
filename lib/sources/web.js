'use strict';

const crypto = require('crypto');
const { SourceAdapter } = require('../adapters');
const { normalizeMention } = require('../normalization');
const { validateSafeUrl, safeFetch, stripHtml, unescapeHtml } = require('./common');

class GenericWebAdapter extends SourceAdapter {
  constructor(options = {}) {
    super('web', options);
    this.maxBytes = Math.max(1024, Math.min(5 * 1024 * 1024, Number(options.maxBytes) || 1024 * 1024));
    this.timeoutMs = Math.max(500, Math.min(30000, Number(options.timeoutMs) || 8000));
    this.fetchFn = options.fetchFn || null;

    this.allowedHosts = new Set();
    if (Array.isArray(options.allowedHosts)) {
      for (const h of options.allowedHosts) {
        if (h) this.allowedHosts.add(String(h).trim().toLowerCase());
      }
    }
  }

  addAllowedHost(host) {
    if (host && typeof host === 'string') {
      this.allowedHosts.add(host.trim().toLowerCase());
    }
  }

  extractContent(rawHtmlOrText, url) {
    if (!rawHtmlOrText || typeof rawHtmlOrText !== 'string') {
      throw new Error('Empty or invalid web content.');
    }

    // Extract HTML <title> if present
    const titleMatch = rawHtmlOrText.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? stripHtml(titleMatch[1]) : '';

    // Strip scripts, styles, navigation, footer tags before extracting main body
    const cleaned = rawHtmlOrText
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
      .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
      .replace(/<header[\s\S]*?<\/header>/gi, ' ');

    const text = stripHtml(cleaned);
    if (!text && !title) {
      throw new Error('No readable text content extracted from web page.');
    }

    const rawText = title ? (text.startsWith(title) ? text : `${title}\n${text}`) : text;
    const sourceId = crypto.createHash('sha256').update(url).digest('hex').slice(0, 16);

    return {
      sourceId,
      title,
      rawText: rawText.slice(0, 12000), // bounded to standard mention max length
      url
    };
  }

  normalize(rawItem) {
    if (!rawItem || typeof rawItem !== 'object') {
      throw new Error('Raw web item must be an object.');
    }

    const url = String(rawItem.url || rawItem.source_url || '').trim();
    const sourceId = rawItem.sourceId || rawItem.source_id || crypto.createHash('sha256').update(url).digest('hex').slice(0, 16);
    const rawText = String(rawItem.rawText || rawItem.raw_text || rawItem.text || '').trim();

    return normalizeMention({
      source: this.name,
      source_id: sourceId,
      source_url: url,
      raw_text: rawText,
      observed_at: rawItem.observed_at || new Date().toISOString(),
      author: rawItem.author || '',
      location_hint: rawItem.location_hint || '',
      metadata: {
        title: rawItem.title || null,
        url
      }
    });
  }

  async fetch(urlOrConfig, options = {}) {
    const targetUrl = typeof urlOrConfig === 'string' ? urlOrConfig.trim() : String(urlOrConfig?.url || '').trim();
    if (!targetUrl) {
      throw new Error('Target URL is required for Generic Web adapter.');
    }

    const mergedHosts = new Set(this.allowedHosts);
    if (Array.isArray(options.allowedHosts)) {
      for (const h of options.allowedHosts) {
        if (h) mergedHosts.add(String(h).trim().toLowerCase());
      }
    }

    if (mergedHosts.size === 0) {
      throw new Error('Generic Web adapter requires an explicit allow-list of approved target hostnames (allowedHosts). Arbitrary web crawling is strictly prohibited.');
    }

    validateSafeUrl(targetUrl, { allowedHosts: mergedHosts });

    const rawContent = await safeFetch(targetUrl, {
      timeoutMs: options.timeoutMs || this.timeoutMs,
      maxBytes: options.maxBytes || this.maxBytes,
      fetchFn: options.fetchFn || this.fetchFn,
      allowedHosts: mergedHosts
    });

    const parsed = this.extractContent(rawContent, targetUrl);
    return [this.normalize(parsed)];
  }
}

module.exports = {
  GenericWebAdapter
};
