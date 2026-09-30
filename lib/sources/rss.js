'use strict';

const crypto = require('crypto');
const { SourceAdapter } = require('../adapters');
const { normalizeMention } = require('../normalization');
const { validateSafeUrl, safeFetch, stripHtml, unescapeHtml } = require('./common');

class GenericRssAdapter extends SourceAdapter {
  constructor(options = {}) {
    super('rss', options);
    this.maxItems = Math.max(1, Math.min(100, Number(options.maxItems) || 25));
    this.timeoutMs = Math.max(500, Math.min(30000, Number(options.timeoutMs) || 8000));
    this.maxBytes = Math.max(1024, Math.min(10 * 1024 * 1024, Number(options.maxBytes) || 2 * 1024 * 1024));
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

  parseXmlFeed(xmlString) {
    if (!xmlString || typeof xmlString !== 'string') {
      throw new Error('Malformed or empty XML feed content.');
    }

    const trimmed = xmlString.trim();
    if (!trimmed.includes('<feed') && !trimmed.includes('<rss') && !trimmed.includes('<?xml')) {
      throw new Error('Invalid feed: missing RSS or Atom root structure.');
    }

    const items = [];
    const entryRegex = /<(?:entry|item)(?:[\s>])([\s\S]*?)<\/(?:entry|item)>/gi;
    let match;

    while ((match = entryRegex.exec(trimmed)) !== null) {
      const block = match[1];

      // Title
      const titleMatch = block.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      const title = titleMatch ? stripHtml(titleMatch[1]) : '';

      // ID / Guid
      const idMatch = block.match(/<(?:id|guid)[^>]*>([\s\S]*?)<\/(?:id|guid)>/i);
      let id = idMatch ? unescapeHtml(idMatch[1]).trim() : '';

      // Link: <link href="..." /> or <link>...</link>
      let link = '';
      const linkHrefMatch = block.match(/<link[^>]+href=["']([^"']+)["']/i);
      if (linkHrefMatch) {
        link = linkHrefMatch[1].trim();
      } else {
        const linkTagMatch = block.match(/<link[^>]*>([\s\S]*?)<\/link>/i);
        if (linkTagMatch) link = linkTagMatch[1].trim();
      }

      // Content / Description / Summary
      let content = '';
      const contentMatch = block.match(/<(?:content|description|summary)[^>]*>([\s\S]*?)<\/(?:content|description|summary)>/i);
      if (contentMatch) {
        content = stripHtml(contentMatch[1]);
      }

      // Author
      let author = '';
      const authorNameMatch = block.match(/<author[^>]*>[\s\S]*?<name[^>]*>([\s\S]*?)<\/name>[\s\S]*?<\/author>/i);
      if (authorNameMatch) {
        author = unescapeHtml(authorNameMatch[1]).trim();
      } else {
        const directAuthorMatch = block.match(/<(?:author|dc:creator)[^>]*>([\s\S]*?)<\/(?:author|dc:creator)>/i);
        if (directAuthorMatch) author = unescapeHtml(directAuthorMatch[1]).trim();
      }

      // Date
      let dateStr = '';
      const dateMatch = block.match(/<(?:published|updated|pubDate)[^>]*>([\s\S]*?)<\/(?:published|updated|pubDate)>/i);
      if (dateMatch) {
        dateStr = dateMatch[1].trim();
      }

      // Category
      let category = '';
      const catTermMatch = block.match(/<category[^>]+term=["']([^"']+)["']/i);
      if (catTermMatch) {
        category = catTermMatch[1].trim();
      } else {
        const catTagMatch = block.match(/<category[^>]*>([\s\S]*?)<\/category>/i);
        if (catTagMatch) category = catTagMatch[1].trim();
      }

      if (title || content) {
        items.push({ id, title, content, link, author, date: dateStr, category });
      }
    }

    return items;
  }

  normalize(rawItem) {
    if (!rawItem || typeof rawItem !== 'object') {
      throw new Error('Raw RSS item must be an object.');
    }

    let sourceId = String(rawItem.id || '').trim();
    const link = String(rawItem.link || '').trim();
    if (!sourceId && link) {
      sourceId = crypto.createHash('sha256').update(link).digest('hex').slice(0, 16);
    }
    if (!sourceId) {
      sourceId = crypto.createHash('sha256').update(`${rawItem.title || ''}|${rawItem.content || ''}`).digest('hex').slice(0, 16);
    }

    const title = String(rawItem.title || '').trim();
    const content = String(rawItem.content || rawItem.description || rawItem.summary || '').trim();
    let rawText = title;
    if (content && content !== title) {
      rawText = title ? `${title}\n${content}` : content;
    }

    let observedAt = rawItem.date || rawItem.published || rawItem.updated;
    if (observedAt) {
      const d = new Date(observedAt);
      observedAt = Number.isFinite(d.getTime()) ? d.toISOString() : new Date().toISOString();
    } else {
      observedAt = new Date().toISOString();
    }

    return normalizeMention({
      source: this.name,
      source_id: sourceId,
      source_url: link,
      raw_text: rawText,
      observed_at: observedAt,
      author: rawItem.author || '',
      location_hint: rawItem.category || '',
      metadata: {
        feedUrl: rawItem.feedUrl || null,
        category: rawItem.category || null
      }
    });
  }

  async fetch(urlOrFeed, options = {}) {
    const feedUrl = typeof urlOrFeed === 'string' ? urlOrFeed.trim() : String(urlOrFeed?.url || '').trim();
    if (!feedUrl) {
      throw new Error('Feed URL is required for Generic RSS adapter.');
    }

    const mergedHosts = new Set(this.allowedHosts);
    if (Array.isArray(options.allowedHosts)) {
      for (const h of options.allowedHosts) {
        if (h) mergedHosts.add(String(h).trim().toLowerCase());
      }
    }

    if (mergedHosts.size === 0) {
      throw new Error('Generic RSS adapter requires an explicit allow-list of approved feed hostnames (allowedHosts).');
    }

    validateSafeUrl(feedUrl, { allowedHosts: mergedHosts });

    const xml = await safeFetch(feedUrl, {
      timeoutMs: options.timeoutMs || this.timeoutMs,
      maxBytes: options.maxBytes || this.maxBytes,
      fetchFn: options.fetchFn || this.fetchFn,
      allowedHosts: mergedHosts
    });

    const parsedItems = this.parseXmlFeed(xml);
    const limit = Math.max(1, Math.min(this.maxItems, Number(options.maxItems) || this.maxItems));
    const capped = parsedItems.slice(0, limit);

    return capped.map(item => this.normalize({ ...item, feedUrl }));
  }
}

module.exports = {
  GenericRssAdapter
};
