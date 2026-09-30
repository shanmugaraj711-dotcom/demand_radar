'use strict';

/**
 * Shared security, URL validation, and safe HTTP utilities for Demand Radar source adapters.
 * Enforces strict SSRF defense, HTTPS-only protocols, byte bounds, timeouts, and redirect rejection.
 */

const DEFAULT_USER_AGENT = 'DemandRadar/1.0 (Public Demand Ingestion)';

/**
 * Checks whether an IPv4 address, IPv6 address, or hostname belongs to a private/loopback network.
 */
function isPrivateIpOrHost(hostname) {
  if (!hostname || typeof hostname !== 'string') return true;
  const h = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');

  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) {
    return true;
  }

  // IPv4 dotted quad check
  const ipv4Match = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [, o1, o2, o3, o4] = ipv4Match.map(Number);
    if ([o1, o2, o3, o4].some(o => o < 0 || o > 255)) return true;

    // 127.0.0.0/8 (Loopback)
    if (o1 === 127) return true;
    // 10.0.0.0/8 (Private RFC 1918)
    if (o1 === 10) return true;
    // 172.16.0.0/12 (Private RFC 1918: 172.16.x.x - 172.31.x.x)
    if (o1 === 172 && o2 >= 16 && o2 <= 31) return true;
    // 192.168.0.0/16 (Private RFC 1918)
    if (o1 === 192 && o2 === 168) return true;
    // 169.254.0.0/16 (Link-local & AWS/Cloud Metadata)
    if (o1 === 169 && o2 === 254) return true;
    // 0.0.0.0 / broadcast
    if (o1 === 0 || o1 === 255) return true;

    return false;
  }

  // IPv6 loopback / unique local / link-local check
  if (h === '::1' || h === '::' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) {
    return true;
  }

  return false;
}

/**
 * Validates a target URL against strict security requirements:
 * - Protocol must be HTTPS (or HTTP only if explicitly permitted for testing).
 * - No user:password credentials in the URL.
 * - Standard ports only (443 for HTTPS, 80 for HTTP).
 * - Target host must not resolve to a private/loopback/cloud metadata address.
 * - Target host must be present in the allowedHosts allow-list (if specified).
 */
function validateSafeUrl(urlString, { allowedHosts = null, requireHttps = true, allowCustomPorts = false } = {}) {
  if (!urlString || typeof urlString !== 'string') {
    throw new Error('URL is required and must be a string.');
  }

  let u;
  try {
    u = new URL(urlString.trim());
  } catch {
    throw new Error(`Invalid URL format: ${urlString}`);
  }

  if (requireHttps && u.protocol !== 'https:') {
    throw new Error(`Insecure protocol "${u.protocol}": Only HTTPS endpoints are permitted.`);
  }

  if (!requireHttps && u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new Error(`Unsupported protocol "${u.protocol}": Only HTTP or HTTPS endpoints are permitted.`);
  }

  if (u.username || u.password) {
    throw new Error('Embedded URL credentials (user:password@) are strictly forbidden.');
  }

  if (!allowCustomPorts && u.port) {
    const defaultPort = u.protocol === 'https:' ? '443' : '80';
    if (u.port !== defaultPort) {
      throw new Error(`Non-standard port "${u.port}" is forbidden.`);
    }
  }

  const hostname = u.hostname.toLowerCase();
  if (isPrivateIpOrHost(hostname) && !allowedHosts?.has(hostname)) {
    throw new Error(`Forbidden destination "${hostname}": Access to private, loopback, or metadata addresses is blocked (SSRF defense).`);
  }

  if (allowedHosts && allowedHosts.size > 0 && !allowedHosts.has(hostname)) {
    throw new Error(`Forbidden host "${hostname}": Host is not on the allowed host list.`);
  }

  return u;
}

/**
 * Fetches an endpoint safely:
 * - Native fetch enforces `redirect: 'error'` to completely prevent SSRF redirection.
 * - Streaming byte cap stops reading if payload exceeds maxBytes.
 * - AbortController timeout prevents slowloris/hung connections.
 */
async function safeFetch(url, {
  timeoutMs = 8000,
  maxBytes = 2 * 1024 * 1024,
  headers = {},
  fetchFn = null,
  allowedHosts = null,
  requireHttps = true,
  allowCustomPorts = false
} = {}) {
  if (fetchFn) {
    const res = await fetchFn(url, { timeoutMs, maxBytes, headers, redirect: 'error' });
    if (typeof res === 'string' && Buffer.byteLength(res) > maxBytes) {
      throw new Error(`Response exceeds maximum allowed size of ${maxBytes} bytes.`);
    }
    return res;
  }

  // Pre-validate URL before network request
  validateSafeUrl(url, { allowedHosts, requireHttps, allowCustomPorts });

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      redirect: 'error',
      headers: {
        'User-Agent': DEFAULT_USER_AGENT,
        'Accept': 'application/json, application/atom+xml, application/rss+xml, text/xml, text/html, text/plain',
        ...headers
      },
      signal: ctl.signal
    });

    if (res.status >= 300 && res.status < 400) {
      throw new Error(`HTTP redirect status ${res.status}: Redirects are rejected for SSRF protection.`);
    }

    if (!res.ok) {
      throw new Error(`HTTP request failed with status ${res.status}: ${res.statusText || 'Request error'}`);
    }

    const cl = res.headers.get('content-length');
    if (cl && Number(cl) > maxBytes) {
      throw new Error(`Response exceeds maximum allowed size of ${maxBytes} bytes (Content-Length: ${cl}).`);
    }

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
      throw new Error(`Request timed out after ${timeoutMs}ms.`);
    }
    if (err.cause?.message?.includes('redirect') || err.message?.includes('redirect')) {
      throw new Error(`HTTP fetch failed: Redirects are strictly rejected (SSRF defense): ${err.cause?.message || err.message}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Unescapes standard XML/HTML entities.
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
 * Strips HTML tags safely, preserving linebreaks and text content.
 */
function stripHtml(raw) {
  if (!raw) return '';
  const decoded = unescapeHtml(raw);
  return decoded
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*[\/]?>/gi, '\n')
    .replace(/<\/(?:p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

module.exports = {
  isPrivateIpOrHost,
  validateSafeUrl,
  safeFetch,
  stripHtml,
  unescapeHtml,
  DEFAULT_USER_AGENT
};
