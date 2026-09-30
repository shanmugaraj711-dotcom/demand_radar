'use strict';

const { normalizeMention } = require('./normalization');
const { extractMentionEntities } = require('./extraction');
const demandLib = require('./demand');
const productsLib = require('./products');
const relevanceLib = require('./relevance');

/**
 * Ingests a single mention into Demand Radar.
 *
 * Pipeline:
 * 1. Normalize raw mention (validates contract, bounds author, redacts PII)
 * 2. Audited entity & demand extraction (deterministic, fail-closed, explainable)
 * 3. Content-hash deduplication & insertion into demand_signals
 * 4. Optional product relevance & lead resolution
 *    - Strict safety invariant: No opportunity is created if entity_name is empty/unreliable.
 *    - Strict safety invariant: Any created opportunity remains 'unreviewed' awaiting human confirmation.
 *
 * Returns explainable result:
 * {
 *   inserted: boolean,
 *   duplicate: boolean,
 *   rejected: boolean,
 *   rejection_reason: string | null,
 *   signal_id: number | null,
 *   signal: object | null,
 *   extraction: object | null,
 *   relevance: object | null,
 *   opportunities: array
 * }
 */
async function ingestMention(db, rawMention, options = {}) {
  // 1. Normalization
  let normalized;
  try {
    normalized = normalizeMention(rawMention);
  } catch (err) {
    return {
      inserted: false,
      duplicate: false,
      rejected: true,
      rejection_reason: `Normalization rejected: ${err.message}`,
      signal_id: null,
      signal: null,
      extraction: null,
      relevance: null,
      opportunities: []
    };
  }

  // 2. Audited Entity Extraction
  const extraction = extractMentionEntities(normalized);

  // 3. Prepare structured signal for demand.insertSignal
  const signalInput = {
    source: normalized.source,
    source_id: normalized.source_id,
    source_url: normalized.source_url,
    raw_text: normalized.raw_text,
    observed_at: normalized.observed_at,
    entity_name: extraction.entity_name,
    location_hint: extraction.location_hint,
    detected_need: extraction.detected_need,
    intent_class: extraction.intent_class,
    confidence_score: extraction.confidence_score,
    lat: normalized.metadata && Number.isFinite(normalized.metadata.lat) ? Number(normalized.metadata.lat) : null,
    lng: normalized.metadata && Number.isFinite(normalized.metadata.lng) ? Number(normalized.metadata.lng) : null
  };

  // 4. Content-hash deduplication and insertion
  let insertResult;
  try {
    insertResult = demandLib.insertSignal(db, signalInput);
  } catch (err) {
    return {
      inserted: false,
      duplicate: false,
      rejected: true,
      rejection_reason: `Signal insertion rejected: ${err.message}`,
      signal_id: null,
      signal: null,
      extraction,
      relevance: null,
      opportunities: []
    };
  }

  const result = {
    inserted: insertResult.inserted,
    duplicate: insertResult.duplicate,
    rejected: false,
    rejection_reason: null,
    signal_id: insertResult.id,
    signal: insertResult.signal,
    extraction,
    relevance: null,
    opportunities: []
  };

  // If duplicate, return immediately
  if (insertResult.duplicate) {
    return result;
  }

  // 5. Optional Product Relevance Evaluation & Opportunity Creation
  const shouldEvaluateProduct = options.evaluateRelevance || options.productId != null;
  if (shouldEvaluateProduct) {
    const activeProduct = productsLib.getActiveProduct(db);
    const productId = options.productId != null ? Number(options.productId) : (activeProduct ? activeProduct.id : null);

    if (productId) {
      const product = productsLib.getProductById(db, productId);
      if (product) {
        let rel = null;
        try {
          rel = await relevanceLib.evaluateRelevance(db, product, insertResult.signal);
        } catch (err) {
          rel = {
            relevant: false,
            confidence: 0,
            stage1: { passed: false },
            stage2: { reason: `Relevance error: ${err.message}` }
          };
        }
        result.relevance = rel;

        // INVARIANT: An opportunity is created ONLY IF:
        // 1) Relevance engine confirms relevant === true
        // 2) An explicit, reliable business entity_name was extracted (entity_found === true)
        // 3) Lead matches with match_status === 'matched'
        if (rel && rel.relevant === true && extraction.entity_name && extraction.evidence.entity_found) {
          const matches = demandLib.resolve(db, insertResult.signal, 5);
          for (const m of matches.filter(x => x.match_status === 'matched')) {
            const oppId = demandLib.createOpportunity(db, insertResult.id, {
              lead_id: m.lead_id,
              leadReason: insertResult.signal.detected_need || insertResult.signal.intent_class || 'demand signal',
              confidence: Math.round(((m.confidence * 0.5) + (rel.confidence * 0.5)) * 1000) / 1000,
              reasons: [...m.reasons, `Relevance: ${rel.stage2.reason}`],
              distance_km: m.distance_km,
              signalSource: insertResult.signal.source,
              sourceUrl: insertResult.signal.source_url,
              observedAt: insertResult.signal.observed_at,
              rawText: insertResult.signal.raw_text,
              product_id: productId,
              relevance: {
                product_id: productId,
                confidence: rel.confidence,
                stage1_passed: rel.stage1.passed,
                matched_need: rel.stage2.matched_need,
                pitch_angle: rel.stage2.pitch_angle,
                reason: rel.stage2.reason
              }
            });
            result.opportunities.push({
              id: oppId,
              lead_id: m.lead_id,
              product_id: productId,
              confidence: m.confidence,
              status: 'unreviewed'
            });
          }
        }
      }
    }
  }

  return result;
}

/**
 * Ingests a batch of mentions sequentially.
 */
async function ingestBatch(db, mentions, options = {}) {
  if (!Array.isArray(mentions)) {
    throw new Error('Mentions batch must be an array.');
  }

  const results = [];
  for (const m of mentions) {
    results.push(await ingestMention(db, m, options));
  }

  return {
    total: mentions.length,
    inserted: results.filter(r => r.inserted).length,
    duplicates: results.filter(r => r.duplicate).length,
    rejected: results.filter(r => r.rejected).length,
    opportunities_created: results.reduce((acc, r) => acc + (r.opportunities ? r.opportunities.length : 0), 0),
    results
  };
}

module.exports = {
  ingestMention,
  ingestBatch
};
