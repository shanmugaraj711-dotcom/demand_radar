'use strict';

const { SourceAdapter } = require('./adapters');
const { normalizeMention } = require('./normalization');

/**
 * Permitted Reddit hostnames.
 * Strict host validation prevents SSRF and redirection to arbitrary third-party endpoints.
 */
const DEFAULT_ALLOWED_HOSTS = new Set([
  'reddit.com',
  'www.reddit.com',
  'old.reddit.com',
  'np.reddit.com'
]);

/**
 * Standard User-Agent header for public Reddit RSS consumption.
 */
const DEFAULT_USER_AGENT = 'DemandRadar/1.0 (Public Demand Ingestion; source: reddit_rss)';

/**
 * Unescapes standard XML and HTML entities.
 */
function unescapeHtml(text) {
  if (!text) return '';
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)));
}

/**
 * Strips HTML markup from feed content, converting paragraphs/breaks to newlines
 * and decoding escaped XML entities.
 */
function stripHtml(raw) {
  if (!raw) return '';
  const decoded = unescapeHtml(raw);
  const text = decoded
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*[\/]?>/gi, '\n')
    .replace(/<\/(?:p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return unescapeHtml(text)
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

/**
 * Validates that a target URL is strictly HTTPS and targets an allowed Reddit domain.
 * Throws explicit errors if protocol is not HTTPS or if host is untrusted.
 */
function validateRedditUrl(urlString, allowedHosts = DEFAULT_ALLOWED_HOSTS) {
  if (!urlString || typeof urlString !== 'string') {
    throw new Error('Reddit RSS URL is required and must be a string.');
  }

  let u;
  try {
    u = new URL(urlString.trim());
  } catch {
    throw new Error(`Invalid URL format: ${urlString}`);
  }

  if (u.protocol !== 'https:') {
    throw new Error(`Insecure protocol "${u.protocol}": Only HTTPS is permitted for Reddit RSS.`);
  }

  const hostname = u.hostname.toLowerCase();
  if (!allowedHosts.has(hostname)) {
    throw new Error(`Forbidden host "${hostname}": URL must target an allowed Reddit domain.`);
  }

  return u;
}

/**
 * Constructs a valid Reddit RSS URL from a query, subreddit, or direct URL.
 */
function buildRedditRssUrl(input, allowedHosts = DEFAULT_ALLOWED_HOSTS) {
  if (!input) {
    throw new Error('Query, subreddit, or RSS URL is required.');
  }

  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (trimmed.startsWith('https://') || trimmed.startsWith('http://')) {
      const validated = validateRedditUrl(trimmed, allowedHosts);
      return validated.toString();
    }
  }

  let subreddit = '';
  let query = '';

  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (trimmed.startsWith('r/')) {
      subreddit = trimmed.slice(2).replace(/\/$/, '');
    } else {
      query = trimmed;
    }
  } else if (typeof input === 'object') {
    if (input.url) {
      return validateRedditUrl(input.url, allowedHosts).toString();
    }
    subreddit = String(input.subreddit || '').trim().replace(/^r\//, '').replace(/\/$/, '');
    query = String(input.query || input.q || '').trim();
  }

  if (subreddit) {
    const cleanSub = encodeURIComponent(subreddit);
    if (query) {
      return `https://www.reddit.com/r/${cleanSub}/search.rss?q=${encodeURIComponent(query)}&restrict_sr=1&sort=new`;
    }
    return `https://www.reddit.com/r/${cleanSub}/.rss`;
  }

  if (query) {
    return `https://www.reddit.com/search.rss?q=${encodeURIComponent(query)}&sort=new`;
  }

  throw new Error('Cannot construct Reddit RSS URL without a query or subreddit.');
}

/**
 * Dependency-free parser for Reddit Atom / RSS 2.0 XML feeds.
 * Validates XML root and extracts items deterministically.
 */
function parseRedditXml(xmlString) {
  if (!xmlString || typeof xmlString !== 'string') {
    throw new Error('Malformed or empty XML feed content.');
  }

  const trimmed = xmlString.trim();
  if (!trimmed.includes('<feed') && !trimmed.includes('<rss') && !trimmed.includes('<?xml')) {
    throw new Error('Invalid feed: missing RSS or Atom feed structure.');
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

    // Stable source_id derivation
    if (!id && link) {
      const idFromLink = link.match(/comments\/([a-z0-9]+)/i);
      id = idFromLink ? `t3_${idFromLink[1]}` : link;
    } else if (id && !id.startsWith('t3_')) {
      const idFromText = id.match(/comments\/([a-z0-9]+)/i);
      if (idFromText) id = `t3_${idFromText[1]}`;
    }

    // Content / Description / Summary
    let content = '';
    const contentMatch = block.match(/<(?:content|description|summary)[^>]*>([\s\S]*?)<\/(?:content|description|summary)>/i);
    if (contentMatch) {
      content = stripHtml(contentMatch[1]);
    }

    // Author: <author><name>...</name></author> or <author>...</author> or <dc:creator>
    let author = '';
    const authorNameMatch = block.match(/<author[^>]*>[\s\S]*?<name[^>]*>([\s\S]*?)<\/name>[\s\S]*?<\/author>/i);
    if (authorNameMatch) {
      author = unescapeHtml(authorNameMatch[1]).trim();
    } else {
      const directAuthorMatch = block.match(/<(?:author|dc:creator)[^>]*>([\s\S]*?)<\/(?:author|dc:creator)>/i);
      if (directAuthorMatch) author = unescapeHtml(directAuthorMatch[1]).trim();
    }

    // Published / Updated / PubDate
    let dateStr = '';
    const dateMatch = block.match(/<(?:published|updated|pubDate)[^>]*>([\s\S]*?)<\/(?:published|updated|pubDate)>/i);
    if (dateMatch) {
      dateStr = dateMatch[1].trim();
    }

    // Subreddit / Category
    let category = '';
    const catTermMatch = block.match(/<category[^>]+term=["']([^"']+)["']/i);
    if (catTermMatch) {
      category = catTermMatch[1].trim();
    } else {
      const catTagMatch = block.match(/<category[^>]*>([\s\S]*?)<\/category>/i);
      if (catTagMatch) category = catTagMatch[1].trim();
    }

    if (title || content) {
      items.push({
        id,
        title,
        content,
        link,
        author,
        date: dateStr,
        category
      });
    }
  }

  return items;
}

/**
 * Fetches feed content over HTTPS with strict timeout and maximum byte limits.
 */
async function safeFetchRss(url, { timeoutMs = 8000, maxBytes = 2 * 1024 * 1024, fetchFn = null } = {}) {
  if (fetchFn) {
    const res = await fetchFn(url, { timeoutMs, maxBytes });
    if (typeof res === 'string' && Buffer.byteLength(res) > maxBytes) {
      throw new Error(`Response exceeds maximum allowed size of ${maxBytes} bytes.`);
    }
    return res;
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      redirect: 'error',
      headers: {
        'User-Agent': DEFAULT_USER_AGENT,
        'Accept': 'application/atom+xml, application/rss+xml, application/xml, text/xml'
      },
      signal: ctl.signal
    });

    if (res.status >= 300 && res.status < 400) {
      throw new Error(`Reddit RSS HTTP redirect error ${res.status}: Redirects are rejected for SSRF protection.`);
    }

    if (!res.ok) {
      throw new Error(`Reddit RSS HTTP error ${res.status}: ${res.statusText || 'Request failed'}`);
    }

    // Check Content-Length header if present
    const cl = res.headers.get('content-length');
    if (cl && Number(cl) > maxBytes) {
      throw new Error(`Response exceeds maximum allowed size of ${maxBytes} bytes (Content-Length: ${cl}).`);
    }

    // Read response body with streaming byte cap
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (received > maxBytes) {
        throw new Error(`Response body exceeded maximum allowed limit of ${maxBytes} bytes.`);
      }
      chunks.push(value);
    }

    const totalBuffer = Buffer.concat(chunks);
    return totalBuffer.toString('utf8');
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Reddit RSS request timed out after ${timeoutMs}ms.`);
    }
    if (err.cause?.message?.includes('redirect') || err.message?.includes('redirect')) {
      throw new Error(`Reddit RSS fetch failed: HTTP redirects are rejected (SSRF protection): ${err.cause?.message || err.message}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reddit RSS Source Adapter implementing SourceAdapter contract.
 */
class RedditRssAdapter extends SourceAdapter {
  constructor(options = {}) {
    super('reddit_rss', options);
    this.maxItems = Math.max(1, Math.min(100, Number(options.maxItems) || 25));
    this.timeoutMs = Math.max(500, Math.min(30000, Number(options.timeoutMs) || 8000));
    this.maxBytes = Math.max(1024, Math.min(10 * 1024 * 1024, Number(options.maxBytes) || 2 * 1024 * 1024));
    this.fetchFn = options.fetchFn || null;

    this.allowedHosts = new Set(DEFAULT_ALLOWED_HOSTS);
    if (Array.isArray(options.allowedHosts)) {
      for (const h of options.allowedHosts) {
        this.allowedHosts.add(String(h).trim().toLowerCase());
      }
    }
  }

  /**
   * Normalizes a raw parsed Reddit item into the standard Mention contract.
   */
  normalize(rawItem) {
    if (!rawItem || typeof rawItem !== 'object') {
      throw new Error('Raw Reddit item must be a valid object.');
    }

    // 1. Stable source_id
    let sourceId = String(rawItem.id || '').trim();
    if (!sourceId && rawItem.link) {
      const m = String(rawItem.link).match(/comments\/([a-z0-9]+)/i);
      sourceId = m ? `t3_${m[1]}` : String(rawItem.link).trim();
    }
    if (!sourceId.startsWith('t3_') && /^[a-z0-9]+$/i.test(sourceId) && sourceId.length <= 10) {
      sourceId = `t3_${sourceId}`;
    }

    // 2. Canonical source_url
    let sourceUrl = String(rawItem.link || '').trim();
    if (sourceUrl) {
      try {
        const u = new URL(sourceUrl);
        u.protocol = 'https:';
        u.hostname = 'www.reddit.com';
        sourceUrl = u.toString();
      } catch (_) {}
    }

    // 3. Raw text: title + content
    const title = String(rawItem.title || '').trim();
    const content = String(rawItem.content || rawItem.description || rawItem.summary || '').trim();
    let rawText = title;
    if (content && content !== title) {
      rawText = title ? `${title}\n${content}` : content;
    }

    // 4. Author handle with PII sanitization
    let author = String(rawItem.author || '').trim().replace(/^\/?u\//, 'u/');
    if (author && !author.startsWith('u/')) {
      author = `u/${author}`;
    }

    // 5. Subreddit / Locality hint
    let subreddit = String(rawItem.category || rawItem.subreddit || '').trim().replace(/^r\//, '');
    if (!subreddit && sourceUrl) {
      const subMatch = sourceUrl.match(/\/r\/([^\/\?]+)/i);
      if (subMatch) subreddit = subMatch[1];
    }

    // 6. Observed timestamp
    let observedAt = rawItem.date || rawItem.published || rawItem.updated;
    if (observedAt) {
      const d = new Date(observedAt);
      observedAt = Number.isFinite(d.getTime()) ? d.toISOString() : new Date().toISOString();
    } else {
      observedAt = new Date().toISOString();
    }

    const metadata = {
      subreddit: subreddit || null,
      post_id: sourceId || null,
      ...(rawItem.metadata || {})
    };

    return normalizeMention({
      source: this.name,
      source_id: sourceId,
      source_url: sourceUrl,
      raw_text: rawText,
      observed_at: observedAt,
      author,
      location_hint: subreddit || '',
      metadata
    });
  }

  /**
   * Fetches, parses, and normalizes mentions from a public Reddit RSS feed.
   *
   * @param {string|object} queryOrInput - Subreddit, query, or Reddit RSS URL
   * @param {object} options - Request options (maxItems, timeoutMs, maxBytes)
   * @returns {Promise<Array>} Array of normalized mentions
   */
  async fetch(queryOrInput, options = {}) {
    const feedUrl = buildRedditRssUrl(queryOrInput, this.allowedHosts);
    const limit = Math.max(1, Math.min(this.maxItems, Number(options.maxItems) || this.maxItems));

    const xml = await safeFetchRss(feedUrl, {
      timeoutMs: options.timeoutMs || this.timeoutMs,
      maxBytes: options.maxBytes || this.maxBytes,
      fetchFn: options.fetchFn || this.fetchFn
    });

    const parsedItems = parseRedditXml(xml);
    const cappedItems = parsedItems.slice(0, limit);

    return cappedItems.map(item => this.normalize(item));
  }
}

/**
 * Orchestration service layer for on-demand Reddit RSS ingestion.
 *
 * Execution flow:
 *   fetch Reddit RSS → normalize → ingestBatch()
 *
 * Manual and on-demand only; zero background daemons.
 */
async function ingestRedditRss(db, queryOrInput, options = {}) {
  const adapter = new RedditRssAdapter(options);
  const mentions = await adapter.fetch(queryOrInput, options);

  if (!mentions.length) {
    return {
      total: 0,
      inserted: 0,
      duplicates: 0,
      rejected: 0,
      opportunities_created: 0,
      results: []
    };
  }

  const { ingestBatch } = require('./ingestion');
  return await ingestBatch(db, mentions, options);
}

module.exports = {
  RedditRssAdapter,
  ingestRedditRss,
  validateRedditUrl,
  buildRedditRssUrl,
  parseRedditXml,
  safeFetchRss,
  stripHtml,
  unescapeHtml,
  DEFAULT_ALLOWED_HOSTS,
  DEFAULT_USER_AGENT
};
