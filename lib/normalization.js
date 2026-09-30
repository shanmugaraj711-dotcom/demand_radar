'use strict';

/**
 * PII redaction patterns for author/display name to prevent storing
 * unnecessary personal data.
 */
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE = /(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,5}/g;

/**
 * Normalizes a URL into a safe canonical representation.
 */
function canonicalUrl(url) {
  if (!url || typeof url !== 'string') return '';
  const trimmed = url.trim();
  if (!trimmed) return '';
  try {
    const u = new URL(trimmed);
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
    u.protocol = 'https:';
    u.pathname = u.pathname.replace(/\/+$/, '') || '/';
    return u.toString().slice(0, 2000);
  } catch {
    return trimmed.slice(0, 2000);
  }
}

/**
 * Sanitizes author / handle information by stripping potential PII
 * and bounding length. Real person identity is never required.
 */
function sanitizeAuthor(author) {
  if (!author || typeof author !== 'string') return '';
  const sanitized = author
    .replace(EMAIL_RE, '[redacted]')
    .replace(PHONE_RE, '[redacted]')
    .trim()
    .slice(0, 80);
  return sanitized;
}

/**
 * Validates and sanitizes metadata dictionary.
 * Filters out sensitive keys (e.g. auth tokens, passwords, cookies).
 */
function sanitizeMetadata(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return {};
  const BLOCKED_KEYS = new Set(['token', 'auth', 'password', 'secret', 'cookie', 'api_key', 'authorization']);
  const clean = {};
  for (const [k, v] of Object.entries(meta)) {
    const lk = k.toLowerCase();
    if (BLOCKED_KEYS.has(lk)) continue;
    // Allow primitives and small objects
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null) {
      clean[k] = v;
    } else if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      try {
        const str = JSON.stringify(v);
        if (str.length <= 1000) clean[k] = JSON.parse(str);
      } catch (_) {}
    }
  }
  return clean;
}

/**
 * Normalizes an incoming raw mention into the standard Mention contract.
 *
 * Contract:
 * - source: string (max 80 chars, default 'unknown')
 * - source_id: string (max 300 chars, default '')
 * - source_url: string (canonicalized, max 2000 chars, default '')
 * - raw_text: string (normalized NFKC, max 12000 chars, required)
 * - observed_at: string (ISO 8601 timestamp)
 * - author: string (bounded, PII-redacted, max 80 chars)
 * - location_hint: string (bounded, max 300 chars)
 * - metadata: object (sanitized metadata)
 *
 * Throws Error if raw_text is missing or empty.
 */
function normalizeMention(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('Mention input must be a valid object.');
  }

  const rawText = String(input.raw_text || input.text || input.content || input.body || '')
    .normalize('NFKC')
    .trim()
    .slice(0, 12000);

  if (!rawText) {
    throw new Error('raw_text is required and cannot be empty.');
  }

  let observedAt;
  const rawDate = input.observed_at || input.timestamp || input.created_at;
  if (rawDate) {
    const d = new Date(rawDate);
    observedAt = Number.isFinite(d.getTime()) ? d.toISOString() : new Date().toISOString();
  } else {
    observedAt = new Date().toISOString();
  }

  const source = String(input.source || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9_\-\.]/g, '')
    .slice(0, 80) || 'unknown';

  const sourceId = String(input.source_id || input.id || '')
    .trim()
    .slice(0, 300);

  const sourceUrl = canonicalUrl(input.source_url || input.url || '');

  const author = sanitizeAuthor(input.author || input.author_name || input.user || '');

  const locationHint = String(input.location_hint || input.location || '')
    .trim()
    .slice(0, 300);

  const metadata = sanitizeMetadata(input.metadata);

  return Object.freeze({
    source,
    source_id: sourceId,
    source_url: sourceUrl,
    raw_text: rawText,
    observed_at: observedAt,
    author,
    location_hint: locationHint,
    metadata
  });
}

function isNormalizedMention(obj) {
  if (!obj || typeof obj !== 'object') return false;
  return (
    typeof obj.source === 'string' &&
    typeof obj.raw_text === 'string' &&
    typeof obj.observed_at === 'string' &&
    typeof obj.author === 'string' &&
    typeof obj.location_hint === 'string' &&
    typeof obj.metadata === 'object'
  );
}

module.exports = {
  normalizeMention,
  isNormalizedMention,
  canonicalUrl,
  sanitizeAuthor,
  sanitizeMetadata
};
