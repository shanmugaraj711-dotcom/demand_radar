# Demand Radar — Phase 3: Real Demand Discovery & Ingestion Architecture

## Overview

Phase 3 establishes a source-agnostic demand ingestion foundation for Demand Radar. It bridges raw, untrusted public mentions (web posts, forum discussions, search snippets, public reviews) to the structured `demand_signals` table and downstream product relevance engine without hardcoding platform-specific crawlers or domain-specific logic.

```
Public / Community Mentions (Untrusted Raw Text)
    ↓
Source Adapter (SourceAdapter Contract)
    ↓
Normalized Raw Mention (Standard Schema & PII Stripping)
    ↓
Audited Entity & Demand Extraction (Deterministic, Local, Fail-Closed)
    ↓
Deterministic Validation & Content-Hash Deduplication (SHA-256)
    ↓
demand_signals Table (Product-Neutral Storage)
    ↓
Downstream Product Relevance Engine (Phase 2 Deterministic + Semantic Gates)
    ↓ (relevant survivors with explicit named business only)
Opportunity Creation (status = 'unreviewed')
    ↓
Human Confirmation Safety Gate (Mandatory Human Sign-off)
    ↓
Outreach Action (WhatsApp / Call)
```

> **IMPORTANT**: Phase 3 provides the **ingestion, normalization, and audited extraction architecture**. **NO live social-media scrapers, automated crawlers, or background polling daemons are included in Phase 3.** Live collectors (e.g., Reddit, Web search APIs, forum crawlers) will plug in during future phases using the established adapter contract.

---

## 1. Normalized Mention Contract

All input sources must normalize raw incoming items into the standard `Mention` contract implemented in `lib/normalization.js`:

```javascript
{
  source: string,        // Identifier for the platform (e.g. 'reddit', 'forum', 'web', 'mock')
  source_id: string,     // Unique item ID on the source platform (post ID, comment ID, tweet ID)
  source_url: string,    // Canonical HTTPS URL to the public mention
  raw_text: string,      // Untrusted raw content, NFKC-normalized, max 12,000 chars (REQUIRED)
  observed_at: string,   // ISO 8601 timestamp of when mention was published or fetched
  author: string,        // Optional display handle (bounded to 80 chars; PII redacted)
  location_hint: string, // Optional locality tag provided by the platform (e.g. subreddit or tag)
  metadata: object       // Sanitized, non-sensitive metadata dictionary
}
```

### Normalization Rules & Guarantees
1. **Required Text**: `raw_text` is mandatory. Empty or whitespace-only inputs are immediately rejected.
2. **Unicode Normalization**: Text is normalized using `NFKC` to eliminate obfuscated or irregular character representations.
3. **URL Canonicalization**: URLs are parsed, hostnames normalized (lowercase, `www.` stripped), trailing slashes cleaned, and protocol standardized to HTTPS.
4. **Immutability**: `normalizeMention()` returns a frozen object (`Object.freeze`), guaranteeing that extraction and ingestion stages receive an un-mutated record.

---

## 2. Privacy Boundaries & PII Redaction

Demand Radar collects public demand signals, **not personal profiles**. The system enforces strict privacy boundaries:

- **No Personal Identity Required**: Mentions do not require real-world identities, real names, or user profiles.
- **Author PII Stripping**: The `author` field is stripped of email addresses (`EMAIL_RE`) and telephone numbers (`PHONE_RE`), replacing them with `[redacted]`.
- **Bounded Handles**: Author handles are strictly capped at 80 characters.
- **Metadata Sanitization**: Sensitive keys (such as `token`, `password`, `secret`, `cookie`, `api_key`, `authorization`) are automatically purged from mention metadata before storage.

---

## 3. Audited Entity & Demand Extraction

Implemented in `lib/extraction.js`, this module provides **audited, deterministic, explainable extraction** running entirely locally without external LLM dependencies.

### Extraction Pipeline

Input: `Normalized Mention`
Output:
```javascript
{
  entity_name: string,       // Explicit business name (e.g. "ABC Abacus Centre") or ""
  location_hint: string,     // Explicit locality/city (e.g. "Anna Nagar", "Chennai") or ""
  detected_need: string,     // Requested service / need (e.g. "weekend classes", "website designer")
  intent_class: string,      // 'buying_intent' | 'operational_gap' | 'complaint' | 'comparison' | 'other'
  confidence_score: number,  // 0.0 .. 1.0 (bounded)
  evidence: {
    entity_found: boolean,
    entity_type: 'business' | 'none',
    entity_signals: string[],
    location_found: boolean,
    location_signals: string[],
    intent_signals: string[],
    need_signals: string[],
    adversarial_flags: string[],
    entity_category: 'explicit_business' | 'location_only' | 'generic_need_only' | 'no_reliable_entity',
    rejection_reason: string | null
  }
}
```

### Extraction Principles & Invariants

1. **Explicit Business Entities**:
   - Matches named organizations with explicit designators (`Centre`, `Academy`, `Institute`, `School`, `Classes`, `Clinic`, `Hospital`, `Studio`, `Agency`, `Store`, `Shop`, etc.).
   - Requires proper noun / brand capitalization or acronyms (e.g., `"ABC Abacus Centre"`, `"Apollo Dental Clinic"`, `"Bright Star Academy"`).
   - Strips conversational and search prefixes (`"looking for"`, `"need"`, `"does"`, `"anyone know"`).

2. **Strict Hallucination Defense & Generic Rejection**:
   - Pure generic descriptors and determiners (`"a good abacus centre"`, `"some classes"`, `"someone"`, `"best provider"`) are **strictly rejected as entities** (`entity_name: ""`).
   - Merely mentioning a product keyword or domain concept never causes the system to invent a business.

3. **Locality Extraction**:
   - Matches metropolitan localities (e.g., `Anna Nagar`, `T Nagar`, `Adyar`, `Velachery`, `Indiranagar`, `Bandra`) and major cities.
   - Parses prepositional anchors (`near <Locality>`, `in <Locality>`, `at <Locality>`), rejecting non-place terms (`near home`, `in class`, `near me`).

4. **Demand & Need Extraction**:
   - Parses explicit expressions of need (`need <Need>`, `looking for <Need>`, `does <Entity> offer <Need>?`, `best <Need> in <Locality>`).
   - Cleanly isolates the requested need before prepositional locality phrases.

5. **Multi-Clause & Adversarial Noise Defense**:
   - When an entity is mentioned as part of a complaint / negative sentiment clause (`"ABC Abacus Centre is terrible"`) while a separate clause expresses buying intent for an unrelated need (`"I need a website designer"`):
     - The divergence is flagged: `adversarial_flags: ['complaint_need_divergence']`.
     - The complained entity is **NOT** bound to the requested need (`entity_name: ""`).
     - This guarantees that ABC Abacus Centre is never turned into an opportunity for a website design service.

---

## 4. Rejection and Fail-Closed Behavior

The ingestion pipeline fails closed at every critical boundary:

1. **Entity Ambiguity**: If an entity cannot be identified with high confidence as a specific, named organization, `entity_name` is set to `""`.
2. **Opportunity Prevention**: Unnamed demand (e.g. `"I need an abacus class for my 7 year old near Anna Nagar"`) is recorded in `demand_signals` as valuable market demand intelligence, but **zero lead opportunities are generated** because no specific business can be resolved.
3. **Relevance Enforcement**: If the active product relevance engine evaluates a signal as `relevant: false`, **zero opportunities are generated**.
4. **Human Gate Intact**: If a valid entity is named and product relevance passes, the created opportunity remains in status `'unreviewed'`. `messages.action()` strictly blocks any outreach action until an authenticated user confirms the opportunity.

---

## 5. Deduplication & Content Hashing

Demand Radar guarantees signal deduplication via SQLite unique constraint on `content_hash`:

```javascript
contentHash = crypto.createHash('sha256').update(
  sourceId
    ? `${source}|id:${sourceId}`
    : `${source}|url:${canonicalUrl}|text:${normalizedText}`
).digest('hex');
```

- When the same post is submitted twice, the database uniqueness constraint intercepts it.
- `ingestMention()` returns `{ inserted: false, duplicate: true, signal_id: existingId }`.
- Provenance from different sources or distinct post IDs with identical wording are tracked independently.

---

## 6. Source Adapter Architecture

Source adapters implement the `SourceAdapter` base class defined in `lib/adapters.js`:

```javascript
class SourceAdapter {
  constructor(name, config = {}) { ... }
  normalize(rawItem) { ... }  // Converts platform payload to standard Mention contract
  async fetch(query, options = {}) { ... }  // Extensibility hook for collectors
}
```

### Included Adapters (Phase 3)
- `SourceAdapter`: Abstract contract defining validation, normalization, and fetch hooks.
- `MockMentionAdapter`: Deterministic in-memory adapter for test fixtures and unit tests.
- `PublicMentionAdapter`: General-purpose adapter for static web snippets and forum mentions.

### How Future Public-Source Adapters Plug In

Future public adapters (e.g., `RedditSourceAdapter`, `WebSearchSourceAdapter`, `HackerNewsSourceAdapter`) inherit from `SourceAdapter`:

```javascript
class RedditSourceAdapter extends SourceAdapter {
  constructor(config = {}) {
    super('reddit', config);
  }

  normalize(rawRedditPost) {
    return normalizeMention({
      source: 'reddit',
      source_id: rawRedditPost.data.id,
      source_url: `https://reddit.com${rawRedditPost.data.permalink}`,
      raw_text: `${rawRedditPost.data.title}\n${rawRedditPost.data.selftext}`,
      observed_at: new Date(rawRedditPost.data.created_utc * 1000).toISOString(),
      author: rawRedditPost.data.author,
      location_hint: rawRedditPost.data.subreddit,
      metadata: { score: rawRedditPost.data.score, num_comments: rawRedditPost.data.num_comments }
    });
  }

  async fetch(query, options = {}) {
    // In future phases: calls Reddit public API or RSS feed and yields normalized mentions
  }
}
```

Plugging in new sources requires **zero changes** to `demand.js`, `products.js`, or the relevance engine.

---

## 7. Storage & Provenance

The foundation utilizes the existing `demand_signals` schema without requiring database migrations:

```sql
CREATE TABLE IF NOT EXISTS demand_signals(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  source_id TEXT,
  content_hash TEXT UNIQUE NOT NULL,
  raw_text TEXT NOT NULL,
  entity_name TEXT,
  location_hint TEXT,
  detected_need TEXT,
  intent_class TEXT,
  confidence_score REAL DEFAULT 0.0,
  source_url TEXT,
  observed_at TEXT,
  created_at INTEGER,
  lat REAL,
  lng REAL
);
```

All extraction evidence, provenance tokens, and explainability records are returned in the ingestion response and can be queried or linked via `source` and `source_id`.

---

## 8. Summary of Guarantees

| Invariant | Implementation Mechanism |
| :--- | :--- |
| **No live crawlers / daemons** | Phase 3 contains only normalization, extraction, and ingestion interfaces. |
| **Domain neutrality** | Zero Abacus-specific assumptions; works with arbitrary products (e.g. Web-to-APK service). |
| **No entity hallucination** | Generic words, pronouns, and indefinite articles fail closed (`entity_name: ""`). |
| **Multi-clause noise defense** | Complaints against entity do not bind to separate buying intent clauses. |
| **Mandatory human gate** | All ingested opportunities default to `'unreviewed'` and block messaging. |
| **Strict privacy** | Email addresses, phone numbers, and secrets are sanitized and redacted. |
| **Deterministic deduplication** | SHA-256 content hash guarantees zero duplicate signals in database. |
