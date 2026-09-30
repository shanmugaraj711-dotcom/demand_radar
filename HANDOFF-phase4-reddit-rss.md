## Update: Phase 4 Public Demand Source — Reddit RSS (branch `feat/phase4-reddit-rss-source`)

This document summarizes the Phase 4 architecture, implementation, and verification for Demand Radar.

### 1. Architectural Scope & Invariants
- **Public Demand Source via Reddit RSS**: Implemented `lib/reddit-rss.js` extending the `SourceAdapter` base contract to ingest public demand signals from Reddit's public RSS/Atom feeds (`.rss` feeds for subreddits and search queries).
- **Dependency-Free Parsing & Sanitization**: Built a custom, dependency-free XML/Atom/RSS parser and HTML entity decoder/tag stripper that safely parses feed entries without external libraries or XXE vulnerabilities.
- **Strict Security & SSRF Protection**:
  - Enforces HTTPS only (`validateRedditUrl`).
  - Strict host whitelist: `reddit.com`, `www.reddit.com`, `old.reddit.com`, and `np.reddit.com`.
  - Rejects loopback/private IPs, URLs with embedded credentials (`user:pass@`), and non-standard ports.
  - Rejects HTTP redirects (`redirect: 'error'`) to prevent SSRF bypass to internal endpoints or metadata services.
  - Imposes strict payload size caps (default 1 MB) and network timeouts (default 10s).
- **Pipeline Integration**: Ingested entries pass through the full existing pipeline:
  `RedditRssAdapter` → `normalizeMention()` (PII redaction, canonical URL) → `extractDemand()` (audited deterministic extraction) → `ingestMention()` (SHA-256 deduplication, product relevance filtering, opportunity generation).
- **Execution Model**: Manual, on-demand execution only via `POST /api/demand/sources/reddit` or `ingestRedditRss()`. **No background daemons, cron jobs, or automated polling loops are added.**
- **Domain Neutrality**: The adapter and API route are 100% domain-neutral and accept arbitrary search queries, subreddits, and target products. Zero domain-specific keywords or logic are hardcoded.
- **Human Confirmation Gate**: All created opportunities remain in status `'unreviewed'`. No outreach or messaging is sent.

### 2. Files Added & Modified
- Added `lib/reddit-rss.js`: `RedditRssAdapter`, `ingestRedditRss`, `validateRedditUrl`, `buildRedditRssUrl`, `parseRedditXml`, `stripHtml`, and `unescapeHtml`.
- Added `test/reddit-rss.test.js`: 20 comprehensive adversarial tests covering all required edge cases (A through T + API route).
- Modified `server.js`: Added authenticated `POST /api/demand/sources/reddit` route with input validation.
- Modified `package.json`: Included `test/reddit-rss.test.js` in `npm test` and `npm run test:local`.
- Modified `docs/ARCHITECTURE-INGESTION.md`: Added Section 9 detailing Phase 4 Reddit RSS live public source architecture.
- Added `HANDOFF-phase4-reddit-rss.md`: This handoff summary.

### 3. Verification
- `npm test`: Runs the full test suite including auth, demand, safety, product isolation, relevance, migration, demand ingestion, and reddit-rss tests (all passing).
- `git diff --check`: Clean (no whitespace or format errors).
- Zero production files or services touched (`radar.service`, `/opt/radar/app`, `/var/lib/radar/radar.db`, `/etc/radar/radar.env`).
