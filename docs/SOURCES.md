# Demand Radar — Multi-Source Demand Ingestion Reference (`docs/SOURCES.md`)

This document specifies the supported public demand sources, API access methods, authentication models, safety boundaries, rate limits, and provenance tracking in Demand Radar.

---

## 1. Platform Capability & Access Matrix

| Platform | Source ID | Status | Official Access Method | Auth Required | Partner Approval | Default Limits |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Reddit RSS** | `reddit_rss` | **READY** | Public RSS/Atom feeds (`.rss`) | No | No | Max 100 items; ~1 req/sec |
| **YouTube** | `youtube` | **READY (when configured)** | Official YouTube Data API v3 | Yes (`YOUTUBE_API_KEY`) | No | Max 50 items; 100 quota units/search |
| **X (Twitter)** | `x` | **READY (when configured)** | Official X API v2 Recent Search | Yes (`X_BEARER_TOKEN`) | No | Max 100 items; 450 req / 15 min |
| **LinkedIn** | `linkedin` | **DISABLED (approval required)** | Official Community Management API | Yes (`LINKEDIN_ACCESS_TOKEN`) | **Yes (Enterprise Partner)** | Max 50 items; Partner tier throttle |
| **Facebook** | `facebook` | **DISABLED (approval required)** | Official Meta Graph API | Yes (`FACEBOOK_ACCESS_TOKEN`) | **Yes (App Review)** | Max 50 items; 200 calls/hr/user |
| **Instagram** | `instagram` | **DISABLED (approval required)** | Official Instagram Graph API | Yes (`INSTAGRAM_ACCESS_TOKEN`) | **Yes (App Review)** | Max 50 items; 200 calls/hr/user |
| **TikTok** | `tiktok` | **DISABLED (approval required)** | Official TikTok API (Display / Research) | Yes (`TIKTOK_ACCESS_TOKEN`) | **Yes (Research Partner)** | Max 50 items; 10-20 QPS |
| **Threads** | `threads` | **DISABLED (approval required)** | Official Meta Threads API | Yes (`THREADS_ACCESS_TOKEN`) | **Yes (App Review)** | Max 50 items; 250 posts/day |
| **Generic RSS** | `rss` | **READY (when configured)** | Standard RSS 2.0 / Atom over HTTPS | No | No (Explicit Allow-list) | Max 100 items; 1 req/sec |
| **Generic Web** | `web` | **READY (when configured)** | Allow-listed Public Web Pages over HTTPS | No | No (Explicit Allow-list) | Max 10 items; 1 req/sec |

---

## 2. Platform Access & Policy Requirements

### A. Reddit RSS (`reddit_rss`)
- **Method**: Public RSS feeds (`https://www.reddit.com/r/<sub-reddit>/.rss` or `search.rss`).
- **Policy**: No login or session hijack; standard public endpoint consumption.
- **SSRF Defense**: Restricted to `reddit.com`, `www.reddit.com`, `old.reddit.com`, and `np.reddit.com`. Redirects rejected.

### B. YouTube (`youtube`)
- **Method**: Official YouTube Data API v3 (`https://www.googleapis.com/youtube/v3/search`).
- **Credentials**: Google Cloud Console API Key with YouTube Data API v3 enabled.
- **Policy**: Zero HTML scraping. Quota-metered. Disabled if key is omitted.

### C. X (`x`)
- **Method**: Official X API v2 (`https://api.x.com/2/tweets/search/recent`).
- **Credentials**: Developer Portal Bearer Token (`X_BEARER_TOKEN`).
- **Policy**: Zero unofficial automation, scraping, or browser simulation. Disabled if token is omitted.

### D. LinkedIn (`linkedin`)
- **Method**: Official Community Management API / UGC Share API.
- **Credentials**: OAuth 2.0 Access Token with approved LinkedIn Enterprise/Partner permissions.
- **Policy**: Arbitrary member post scraping is strictly prohibited by LinkedIn TOS. The adapter remains disabled until enterprise credentials and partner approval are configured.

### E. Meta Platforms (Facebook `facebook`, Instagram `instagram`, Threads `threads`)
- **Method**: Official Meta Graph API (`graph.facebook.com`, `graph.instagram.com`, `graph.threads.net`).
- **Credentials**: Meta Developer App Review approval and Access Token (`FACEBOOK_ACCESS_TOKEN`, `INSTAGRAM_ACCESS_TOKEN`, `THREADS_ACCESS_TOKEN`).
- **Policy**: Zero scraping, zero session cookie theft. Disabled until approved token is configured.

### F. TikTok (`tiktok`)
- **Method**: Official TikTok for Developers Display API or Commercial Research API.
- **Credentials**: `TIKTOK_ACCESS_TOKEN`.
- **Policy**: Public keyword search requires explicit TikTok Research API approval. The adapter clearly distinguishes standard Display vs Research capabilities and fails closed without credentials.

### G. Generic RSS (`rss`) & Generic Web (`web`)
- **Method**: Standard HTTPS fetching of explicitly allow-listed feeds and URLs.
- **Policy**: Zero general unconstrained crawling. Hostnames must be pre-approved in `allowedHosts`.

---

## 3. Universal Security & SSRF Invariants

Every HTTP-capable adapter in Demand Radar adheres to strict security rules implemented in `lib/sources/common.js`:

1. **HTTPS Enforcement**: Only `https://` URLs are permitted by default. Insecure HTTP is blocked.
2. **Redirect Rejection (`redirect: 'error'`)**:
   - Native `fetch` is configured with `redirect: 'error'`.
   - Any 3xx redirect status immediately aborts the request.
   - **Guaranteed Invariant**: No redirected destination is ever fetched, eliminating open-redirect SSRF attack vectors.
3. **Private IP & Loopback Blocking**:
   - Explicit rejection of `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, and `169.254.0.0/16` (including AWS metadata `169.254.169.254`).
   - Hostnames matching `localhost`, `*.local`, `*.internal` are blocked.
4. **Credential & Port Safety**:
   - Embedded credentials (`user:password@`) are forbidden.
   - Non-standard ports are rejected.
5. **Streaming Byte Caps & Timeouts**:
   - Payloads exceeding `maxBytes` (default 1–2 MB) are terminated immediately during streaming.
   - Network requests timeout after `timeoutMs` (default 8–10 seconds).

---

## 4. Normalized Mention Contract & Provenance

All source adapters normalize raw payloads into the immutable `Mention` contract via `lib/normalization.js`:

```javascript
{
  source: string,        // e.g. 'youtube', 'x', 'reddit_rss', 'linkedin', 'rss', 'web'
  source_id: string,     // Platform unique identifier (e.g. videoId, tweetId, post_id, guid)
  source_url: string,    // Canonical HTTPS link to public post
  raw_text: string,      // NFKC-normalized text (title + body), capped at 12,000 chars
  observed_at: string,   // ISO 8601 published timestamp
  author: string,        // Handle or display name (bounded to 80 chars, email/phone redacted)
  location_hint: string, // Locality or category hint
  metadata: object       // Sanitized non-sensitive dictionary
}
```

### Privacy & PII Redaction
- Author handles are stripped of email addresses (`EMAIL_RE`) and telephone numbers (`PHONE_RE`), replacing them with `[redacted]`.
- Sensitive metadata keys (such as `token`, `password`, `secret`, `authorization`, `cookie`) are purged before storage.

---

## 5. Execution Model & Safety Gates

1. **Strictly On-Demand / Manual**:
   - Demand Radar does NOT run background polling loops, cron jobs, workers, or `setInterval` daemons.
   - Data collection occurs only when an authenticated operator triggers a query via the web interface or API.
2. **Product Neutrality**:
   - Adapters contain zero product-specific or industry-specific logic. Any product or service can be evaluated against incoming mentions.
3. **Mandatory Human Confirmation Gate**:
   - Opportunities created from any source default to status `'unreviewed'`.
   - Outreach via WhatsApp or phone remains strictly blocked until confirmed by an operator.
