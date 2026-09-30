# Demand Radar — Phase 2: Product Relevance Engine Architecture

## Overview

Phase 2 builds the Product Relevance Engine to evaluate demand signals against product-specific offerings before opportunities are generated.

```
Source Signal
    ↓
Text Normalization & Tokenization
    ↓
Stage 1: Deterministic Relevance Gate (local, cheap, explainable)
    ↓ (survivors only)
Stage 2: Semantic Relevance Classifier (provider abstraction, strict JSON, fail-closed)
    ↓
Relevance Evidence & Caching (product.id + signal.content_hash)
    ↓ (relevant survivors only)
Opportunity Creation (status = 'unreviewed')
    ↓
Human Confirmation Safety Gate (mandatory review)
    ↓
Outreach Action (WhatsApp / Call)
```

---

## The Pipeline Stages

### 1. Source Signal & Normalization
- Demand signals are ingested with product-neutral schemas (`raw_text`, `entity_name`, `location_hint`, `detected_need`, `intent_class`, `content_hash`).
- Demand text is untrusted user input. Text is normalized (`NFKC`, URL stripping, non-alphanumeric cleaning, lowercase).
- Stop words are removed for token extraction; safe domain-agnostic stemming strips suffixes (`classes` -> `class`, `coaching` -> `coach`, `tuitions` -> `tuition`).
- Word n-grams (bigrams and trigrams) are generated for phrase overlap detection.

### 2. Stage 1 — Deterministic Relevance Gate
Executed locally and deterministically against the target product's fields (`name`, `topic`, `description`, `target_keywords`, `negative_keywords`, `target_org`, `offer`):
- **Negative / Exclusion Check**: If any product negative keyword (e.g. `college`, `adult`, `used book`) appears in the signal, the signal is immediately rejected (`passed: false`, `score: 0.0`). The semantic classifier is **never** invoked for excluded terms.
- **Exact Keyword Matches**: Evaluates exact word-boundary matches for `target_keywords`.
- **Topic Matching**: Checks direct or stemmed overlap between `product.topic` and signal terms.
- **Token & Stemmed Overlap**: Computes intersection of product vocabulary and signal tokens.
- **N-gram Matching**: Detects multi-word phrase overlaps.
- **Unrelated-Topic Rejection**: If zero keywords, tokens, or topic match, the signal is rejected immediately with zero semantic cost.
- **Explainability**: Returns structured evidence containing matched keywords, tokens, score, and rejection reasons.

### 3. Stage 2 — Semantic Relevance Classifier
Only signals surviving Stage 1 are passed to Stage 2:
- **Clean Provider Abstraction**: `RelevanceProvider` base class with built-in `LocalSemanticClassifier`, `LLMRelevanceProvider`, and `MockRelevanceProvider`.
- **Zero API Key Requirement**: Default `LocalSemanticClassifier` operates offline, deterministically, and locally with zero external API dependencies.
- **Strict Schema Validation**:
  ```json
  {
    "relevant": true,
    "confidence": 0.85,
    "matched_need": "Prospect seeking abacus maths solutions (inquiry)",
    "pitch_angle": "Pitch MathGenius: 2 free trial accounts for your centre",
    "reason": "Validated commercial relevance: prospect need aligns with MathGenius"
  }
  ```
- **Fail-Closed Guarantee**: Any malformed JSON, schema violation, confidence boundary error, or provider exception immediately fails closed (`relevant: false`, `confidence: 0.0`), preventing invalid opportunity generation.
- **Intent Disambiguation**: Identifies and rejects non-customer intents (employment/recruitment, classified sales, free piracy) and sarcasm.

### 4. Caching & Product Isolation
- **Stable SHA-256 Cache Key**: Generated from `product.id + demand_signal.content_hash`:
  `SHA-256("product:" + productId + "|signal:" + contentHash)`
- **Mathematical Isolation**: Different products evaluating the exact same signal yield distinct cache keys and independent database records in `product_relevance`.
- **Cost Protection**: Identical `product_id` + `content_hash` queries are served from cache; the semantic provider is invoked at most once per product/signal pair.

### 5. Opportunity Safety & Human Review Gate
- **Conditional Opportunity Creation**: Opportunities are created in `lead_opportunities` **only** when relevance evaluates to `relevant: true`.
- **Immutable Human Review Gate**: All created opportunities start with `status = 'unreviewed'`.
- **Outreach Blocking**: Unreviewed opportunities are strictly blocked from outreach (`blocked: true`, no message text, no WhatsApp URL).
- **Confirmation Requirement**: Only an authenticated user calling `/api/demand/opportunities/:id/confirm` can transition the opportunity to `human_confirmed` and unblock outreach.
- **Terminal Rejection**: Rejected opportunities (`status = 'rejected'`) cannot be confirmed or contacted.

---

## Architectural Exclusions (Phase 2 Boundaries)

Phase 2 **STRICTLY DOES NOT** implement:
1. **External / Live Social Ingestion**: Demand signals remain manually or locally ingested test fixtures; no scrapers, background collectors, or social network API integrations are active.
2. **Entity Extraction**: Extraction of business names or locations from free-form `raw_text` is intentionally NOT implemented. Signals still require structured `entity_name` and `location_hint` fields.
3. **"For Me" User Interface**: No front-end UI components, dashboards, or PWA interface screens are built in Phase 2. All functionality is delivered via backend engine, API routes, and test suites.
