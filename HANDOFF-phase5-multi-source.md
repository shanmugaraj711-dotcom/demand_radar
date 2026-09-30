## Update: Phase 5 Multi-Source Demand Ingestion (branch `feat/phase5-multi-source-ingestion`)

This document summarizes the Phase 5 architecture, implementation, and verification for Demand Radar.

### 1. Architectural Scope & Invariants
- **Multi-Platform Demand Discovery Architecture**: Expanded Demand Radar from Reddit-only to a source-agnostic multi-platform ingestion architecture supporting 10 distinct platform adapters unified under a central registry (`lib/sources/registry.js`).
- **Supported Demand Sources**:
  1. `reddit_rss` — Live/production: Public RSS/Atom feeds from Reddit subreddits and search queries. Preserved with 100% backwards compatibility.
  2. `youtube` — Official YouTube Data API v3: quota-metered search, disabled when `YOUTUBE_API_KEY` is absent, zero scraping.
  3. `x` — Official X API v2: search tweets endpoint with bearer token authentication (`X_BEARER_TOKEN`), disabled when absent, zero scraping or browser automation.
  4. `linkedin` — Official LinkedIn Community Management API: disabled (`DISABLED_APPROVAL_REQUIRED`) until approved enterprise partner access and `LINKEDIN_ACCESS_TOKEN` are configured.
  5. `facebook` — Official Meta Graph API: disabled (`DISABLED_APPROVAL_REQUIRED`) until approved Meta app access token (`FACEBOOK_ACCESS_TOKEN`) is configured.
  6. `instagram` — Official Instagram Graph API: disabled (`DISABLED_APPROVAL_REQUIRED`) until approved Instagram business access token (`INSTAGRAM_ACCESS_TOKEN`) is configured.
  7. `tiktok` — Official TikTok Display & Research APIs: explicit distinction between commercial Display API and academic Research API; disabled without approved access (`TIKTOK_ACCESS_TOKEN`).
  8. `threads` — Official Meta Threads API: disabled (`DISABLED_APPROVAL_REQUIRED`) without approved token (`THREADS_ACCESS_TOKEN`).
  9. `rss` — Generic RSS/Atom SourceAdapter: accepts arbitrary RSS 2.0 and Atom feeds, requiring an explicit hostname allow-list (`allowedHosts`) to prevent unrestricted fetching.
  10. `web` — Generic Web Page SourceAdapter: fetches and extracts demand mentions from explicitly allow-listed public web pages (`allowedHosts`), enforcing strict HTML sanitization, size caps, and content-type validation.
- **Universal SSRF Defense & Security Invariants**:
  - All network fetching across every adapter routes through `safeFetch` (`lib/sources/common.js`) with `redirect: 'error'` strictly enforced. HTTP redirects are rejected unconditionally.
  - Strict host validation: private IP ranges, loopback (`127.0.0.1`, `::1`), link-local (`169.254.169.254` cloud metadata), embedded credentials (`user:pass@`), and non-standard ports are rejected before network calls.
  - Streaming payload byte limits (1–2 MB maximum) and timeout abort controllers (max 10s) prevent denial-of-service.
- **Pipeline Integration**: Ingested raw items from all adapters pass through the canonical pipeline:
  `SourceAdapter.fetch()` → `SourceAdapter.parse()` → `normalizeMention()` (PII redaction, canonical URL) → `extractDemand()` (audited deterministic entity/location extraction) → `ingestMention()` (SHA-256 deduplication, product relevance scoring, lead matching, opportunity creation).
- **Execution Model**: Manual, on-demand execution only via authenticated operator APIs (`POST /api/demand/sources/:source` and `GET /api/demand/sources`). **No background daemons, cron jobs, intervals, or automated polling loops exist.**
- **Domain Neutrality**: Adapters and registry are 100% domain-neutral and accept arbitrary search queries, URLs, and target products. Zero domain-specific keywords or logic are hardcoded.
- **Human Confirmation Gate**: All created opportunities remain in status `'unreviewed'`. No outreach or messaging is sent.

### 2. Files Added & Modified
- Added `lib/sources/common.js`: Centralized safe network fetching (`safeFetch` with `redirect: 'error'`), SSRF prevention (`validateSafeUrl`, `isPrivateIpOrHost`), HTML sanitization (`stripHtml`), and entity decoding (`unescapeHtml`).
- Added `lib/sources/youtube.js`: `YouTubeSourceAdapter` (YouTube Data API v3).
- Added `lib/sources/x.js`: `XSourceAdapter` (X API v2).
- Added `lib/sources/linkedin.js`: `LinkedInSourceAdapter` (LinkedIn Community Management API).
- Added `lib/sources/facebook.js`: `FacebookSourceAdapter` (Meta Graph API).
- Added `lib/sources/instagram.js`: `InstagramSourceAdapter` (Instagram Graph API).
- Added `lib/sources/tiktok.js`: `TikTokSourceAdapter` (TikTok Display & Research APIs).
- Added `lib/sources/threads.js`: `ThreadsSourceAdapter` (Meta Threads API).
- Added `lib/sources/rss.js`: `GenericRssAdapter` (Generic RSS 2.0 / Atom feed adapter).
- Added `lib/sources/web.js`: `GenericWebAdapter` (Generic allow-listed public web adapter).
- Added `lib/sources/registry.js`: Central registry of 10 sources, adapter instantiation, credential status checks, and `ingestFromSource` orchestration.
- Added `lib/sources/index.js`: Barrel export module for `lib/sources`.
- Added `docs/SOURCES.md`: Detailed capability matrix, API authentication schemes, rate limits, security invariants, and provenance fields for all 10 sources.
- Added `test/multi-source.test.js`: 15 comprehensive adversarial tests verifying all 10 adapters, SSRF defense, redirect rejection, pipeline ingestion, opportunity gating, and HTTP API routes.
- Modified `server.js`: Added authenticated `GET /api/demand/sources` and `POST /api/demand/sources/:source` routes while preserving existing `POST /api/demand/sources/reddit`.
- Modified `package.json`: Included `test/multi-source.test.js` in `npm test` and `npm run test:local`.
- Modified `docs/ARCHITECTURE-INGESTION.md`: Added Section 10 documenting the Phase 5 Multi-Platform Demand Discovery Architecture.
- Added `HANDOFF-phase5-multi-source.md`: This handoff summary.

### 3. Verification
- `npm test`: Runs full suite of 134 automated tests across 9 test files (auth, demand, demand-safety, product-isolation, product-relevance, migration, demand-ingestion, reddit-rss, multi-source, and selftest) — all passing with 0 failures.
- `git diff --check`: Clean (no whitespace errors or formatting issues).
- Production state untouched: `radar.service` is active, `/opt/radar/app`, `/var/lib/radar/radar.db`, and `/etc/radar/radar.env` remain completely unmodified.
