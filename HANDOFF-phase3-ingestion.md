## Update: Phase 3 Real Demand Discovery Foundation (branch `feat/phase3-demand-ingestion`)

This document summarizes the Phase 3 architecture and implementation for Demand Radar.

### 1. Architectural Scope & Invariants
- **Source-Agnostic Mention Normalization**: `lib/normalization.js` provides `normalizeMention()` enforcing a standard schema across any future public sources (Reddit, forums, web, reviews) with mandatory PII redaction (email and phone stripping from author handles).
- **Audited Entity & Demand Extraction**: `lib/extraction.js` provides deterministic, local, explainable extraction. It strictly distinguishes explicit named businesses, locations, requested needs, and unstructured chatter.
- **Fail-Closed Hallucination Defense**: Generic descriptors (`"a good abacus centre"`, `"some classes"`, `"someone"`) fail closed to `entity_name: ""`. Product keywords alone never cause the engine to invent a business.
- **Multi-Clause & Adversarial Noise Defense**: In multi-clause posts where an entity is the subject of a complaint while buying intent is expressed for an unrelated need (e.g. `"ABC Abacus Centre is terrible, I need a website designer"`), the engine detects `complaint_need_divergence`, unbinds the entity, and prevents generating false opportunities.
- **Deduplication**: Content-hash deduplication (`SHA-256`) via existing `demand_signals.content_hash` ensures identical mentions are never inserted twice.
- **Human Confirmation Gate Intact**: Any opportunity created from ingested demand defaults to status `'unreviewed'` and strictly blocks outreach until confirmed by an authenticated user.
- **No Live Collectors in Phase 3**: Phase 3 provides the normalization and ingestion pipeline. No live scrapers, crawlers, or background polling daemons are included.

### 2. Files Added & Modified
- Added `lib/normalization.js`: Source-mention normalization with PII redaction and metadata sanitization.
- Added `lib/extraction.js`: Audited entity, location, and demand extraction with adversarial guards.
- Added `lib/adapters.js`: `SourceAdapter` base contract, `MockMentionAdapter`, and `PublicMentionAdapter`.
- Added `lib/ingestion.js`: Ingestion pipeline with deduplication, product relevance filtering, and opportunity gating.
- Modified `lib/demand.js`: Fixed `null` lat/lng evaluation to prevent false coordinate assignment.
- Modified `server.js`: Added authenticated `POST /api/demand/ingest` route supporting both single and batch mention ingestion.
- Modified `package.json`: Included `test/demand-ingestion.test.js` in `npm test` and `npm run test:local`.
- Added `docs/ARCHITECTURE-INGESTION.md`: Comprehensive architectural documentation.
- Added `test/demand-ingestion.test.js`: 14 comprehensive tests covering all required adversarial scenarios (A through N).

### 3. Verification
- `npm test`: Runs the full test suite including auth, demand, safety, product isolation, relevance, migration, demand ingestion, and selftest.
- `git diff --check`: Clean (no whitespace or format errors).
- Zero production files or services touched.
