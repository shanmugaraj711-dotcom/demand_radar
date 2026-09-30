'use strict';

const crypto = require('crypto');

/**
 * Standard stop words for tokenization and n-gram extraction.
 */
const STOP_WORDS = new Set([
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and', 'any', 'are', 'aren',
  'as', 'at', 'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'by',
  'can', 'could', 'did', 'do', 'does', 'doing', 'down', 'during', 'each', 'few', 'for', 'from',
  'further', 'had', 'has', 'have', 'having', 'he', 'her', 'here', 'hers', 'herself', 'him', 'himself',
  'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'itself', 'just', 'me', 'more', 'most',
  'my', 'myself', 'no', 'nor', 'not', 'now', 'of', 'off', 'on', 'once', 'only', 'or', 'other', 'our',
  'ours', 'ourselves', 'out', 'over', 'own', 'same', 'she', 'should', 'so', 'some', 'such', 'than',
  'that', 'the', 'their', 'theirs', 'them', 'themselves', 'then', 'there', 'these', 'they', 'this',
  'those', 'through', 'to', 'too', 'under', 'until', 'up', 'very', 'was', 'we', 'were', 'what', 'when',
  'where', 'which', 'while', 'who', 'whom', 'why', 'with', 'would', 'you', 'your', 'yours', 'yourself',
  'yourselves', 'please', 'thanks', 'thank', 'hello', 'hi', 'hey'
]);

/**
 * Safe, domain-agnostic English stemming rules.
 */
const STEM_RULES = [
  [/classes$/i, 'class'],
  [/tuitions$/i, 'tuition'],
  [/courses$/i, 'course'],
  [/trainings?$/i, 'train'],
  [/teachers?$/i, 'teacher'],
  [/tutors?$/i, 'tutor'],
  [/learners?$/i, 'learn'],
  [/learning$/i, 'learn'],
  [/schools?$/i, 'school'],
  [/centres?$|centers?$/i, 'center'],
  [/services?$/i, 'service'],
  [/students?$/i, 'student'],
  [/studying$/i, 'study'],
  [/practising$|practicing$/i, 'practise'],
  [/coaching$/i, 'coach'],
  [/providers?$/i, 'provide'],
  [/apps?$/i, 'app'],
  [/books?$/i, 'book'],
  [/schedules?$/i, 'schedule'],
  [/schedulings?$/i, 'schedule'],
  [/bookings?$/i, 'book'],
  [/reservations?$/i, 'reserve'],
  [/clinics?$/i, 'clinic'],
  [/sessions?$/i, 'session']
];

function normalizeText(value) {
  return String(value || '').normalize('NFKC').toLowerCase()
    .replace(/https?:\/\/[^\s]+/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stemWord(word) {
  if (!word || word.length < 3) return word;
  for (const [re, rep] of STEM_RULES) {
    if (re.test(word)) return rep;
  }
  if (word.length > 4) {
    if (word.endsWith('ies')) return word.slice(0, -3) + 'y';
    if (word.endsWith('es') && !word.endsWith('ss')) return word.slice(0, -2);
    if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
    if (word.endsWith('ing') && word.length > 5) return word.slice(0, -3);
    if (word.endsWith('ed') && word.length > 4) return word.slice(0, -2);
  }
  return word;
}

function tokenize(value) {
  const norm = normalizeText(value);
  if (!norm) return [];
  return norm.split(' ').filter(x => x && !STOP_WORDS.has(x) && x.length > 1);
}

function tokenSet(value) {
  return new Set(tokenize(value));
}

function stemmedTokenSet(value) {
  const tokens = tokenize(value);
  return new Set(tokens.map(stemWord));
}

function ngrams(words, n) {
  const grams = new Set();
  if (!Array.isArray(words) || words.length < n) return grams;
  for (let i = 0; i <= words.length - n; i++) {
    grams.add(words.slice(i, i + n).join(' '));
  }
  return grams;
}

/**
 * STAGE 1 — Deterministic Relevance Gate
 * Evaluates cheap, local, explainable relevance using product fields:
 * name, description, topic, target_keywords, target_org, offer, negative_keywords.
 */
function evaluateDeterministicGate(product, signal) {
  const normSignalText = normalizeText(`${signal.raw_text || ''} ${signal.detected_need || ''} ${signal.intent_class || ''}`);
  if (!normSignalText) {
    return {
      passed: false,
      score: 0.0,
      reasons: ['Demand signal text is empty'],
      matched_keywords: [],
      matched_tokens: [],
      negative_hits: [],
      rejection_reason: 'Empty demand signal'
    };
  }

  // 1. Negative / Exclusion terms check
  const negativeKeywords = Array.isArray(product.negative_keywords)
    ? product.negative_keywords
    : (typeof product.negative_keywords === 'string' ? (() => { try { return JSON.parse(product.negative_keywords); } catch { return []; } })() : []);

  for (const neg of negativeKeywords) {
    const normNeg = normalizeText(neg);
    if (!normNeg) continue;
    const re = new RegExp(`(^|\\s)${normNeg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|\\s)`, 'i');
    if (re.test(normSignalText) || normSignalText.includes(normNeg)) {
      return {
        passed: false,
        score: 0.0,
        reasons: [`Excluded by negative keyword: ${neg}`],
        matched_keywords: [],
        matched_tokens: [],
        negative_hits: [neg],
        rejection_reason: `Excluded by negative keyword: ${neg}`
      };
    }
  }

  // 2. Exact keyword matches
  const targetKeywords = Array.isArray(product.target_keywords)
    ? product.target_keywords
    : (typeof product.target_keywords === 'string' ? (() => { try { return JSON.parse(product.target_keywords); } catch { return []; } })() : []);

  const matchedKeywords = [];
  for (const kw of targetKeywords) {
    const normKw = normalizeText(kw);
    if (!normKw) continue;
    const re = new RegExp(`(^|\\s)${normKw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|\\s)`, 'i');
    if (re.test(normSignalText) || normSignalText.includes(normKw)) {
      matchedKeywords.push(kw);
    }
  }

  // 3. Topic matching
  const normTopic = normalizeText(product.topic || '');
  const stemmedTopic = stemWord(normTopic);
  const signalTokens = tokenize(normSignalText);
  const stemmedSignalTokens = new Set(signalTokens.map(stemWord));

  const topicMatch = normTopic ? (
    normSignalText.includes(normTopic) ||
    stemmedSignalTokens.has(stemmedTopic) ||
    signalTokens.includes(normTopic)
  ) : false;

  // 4. Token & stemmed token overlap
  const productText = `${product.name || ''} ${product.topic || ''} ${product.description || ''} ${targetKeywords.join(' ')} ${product.offer || ''} ${product.target_org || ''}`;
  const prodTokens = tokenSet(productText);
  const prodStemmedTokens = stemmedTokenSet(productText);

  const matchedTokens = [];
  for (const tok of signalTokens) {
    if (prodTokens.has(tok) || prodStemmedTokens.has(stemWord(tok))) {
      matchedTokens.push(tok);
    }
  }

  // 5. N-gram overlap
  const signalWords = tokenize(signal.raw_text || '');
  const productWords = tokenize(productText);
  const sigBigrams = ngrams(signalWords, 2);
  const sigTrigrams = ngrams(signalWords, 3);
  const prodBigrams = ngrams(productWords, 2);
  const prodTrigrams = ngrams(productWords, 3);

  const matchedNgrams = [];
  for (const bg of sigBigrams) {
    if (prodBigrams.has(bg)) matchedNgrams.push(bg);
  }
  for (const tg of sigTrigrams) {
    if (prodTrigrams.has(tg)) matchedNgrams.push(tg);
  }

  // 6. Obvious unrelated-topic rejection
  if (matchedKeywords.length === 0 && matchedTokens.length === 0 && !topicMatch && matchedNgrams.length === 0) {
    return {
      passed: false,
      score: 0.0,
      reasons: ['Zero topic, keyword, or token overlap with product domain'],
      matched_keywords: [],
      matched_tokens: [],
      negative_hits: [],
      rejection_reason: 'Unrelated topic: zero overlap with product domain'
    };
  }

  // 7. Deterministic Scoring
  let score = 0;
  const reasons = [];

  if (matchedKeywords.length > 0) {
    score += Math.min(0.65, 0.45 + (matchedKeywords.length - 1) * 0.10);
    reasons.push(`Exact keyword match: ${matchedKeywords.join(', ')}`);
  }

  if (topicMatch) {
    score += 0.25;
    reasons.push(`Topic match: ${product.topic}`);
  }

  if (matchedNgrams.length > 0) {
    score += Math.min(0.20, matchedNgrams.length * 0.10);
    reasons.push(`Phrase match: ${matchedNgrams.slice(0, 3).join(', ')}`);
  }

  if (matchedTokens.length > 0) {
    const tokenScore = Math.min(0.25, matchedTokens.length * 0.05);
    score += tokenScore;
    reasons.push(`Token overlap: ${matchedTokens.slice(0, 5).join(', ')}`);
  }

  const boundedScore = Math.min(1.0, Math.round(score * 1000) / 1000);
  const passed = boundedScore >= 0.25 || matchedKeywords.length > 0 || (topicMatch && matchedTokens.length >= 1);

  return {
    passed,
    score: boundedScore,
    reasons: passed ? reasons : [...reasons, 'Score below relevance threshold'],
    matched_keywords: matchedKeywords,
    matched_tokens: matchedTokens,
    negative_hits: [],
    rejection_reason: passed ? null : 'Score below relevance threshold'
  };
}

/**
 * Strict schema validation for semantic provider response.
 * Enforces { relevant: boolean, confidence: 0..1, matched_need: string, pitch_angle: string, reason: string }.
 */
function validateSemanticResult(output) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error('Semantic provider response must be a JSON object');
  }
  if (typeof output.relevant !== 'boolean') {
    throw new Error('Semantic provider response must include boolean "relevant"');
  }
  const confidence = Number(output.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error(`Semantic provider confidence must be a finite number between 0.0 and 1.0 (received: ${output.confidence})`);
  }
  if (typeof output.matched_need !== 'string') {
    throw new Error('Semantic provider response must include string "matched_need"');
  }
  if (typeof output.pitch_angle !== 'string') {
    throw new Error('Semantic provider response must include string "pitch_angle"');
  }
  if (typeof output.reason !== 'string') {
    throw new Error('Semantic provider response must include string "reason"');
  }
  return {
    relevant: output.relevant,
    confidence: Math.round(confidence * 1000) / 1000,
    matched_need: output.matched_need.slice(0, 500),
    pitch_angle: output.pitch_angle.slice(0, 500),
    reason: output.reason.slice(0, 1000)
  };
}

/**
 * Base provider interface for semantic relevance classification.
 */
class RelevanceProvider {
  constructor(name = 'base') {
    this.name = name;
  }
  async classify({ product, signal, deterministicEvidence }) {
    throw new Error(`classify() must be implemented by provider ${this.name}`);
  }
}

/**
 * Built-in local semantic classifier.
 * Fully deterministic, offline, and generic. Requires no external API key.
 */
class LocalSemanticClassifier extends RelevanceProvider {
  constructor() {
    super('local');
  }

  async classify({ product, signal, deterministicEvidence }) {
    const rawText = String(signal.raw_text || '');
    const normText = normalizeText(rawText);

    // 1. Sarcasm / Anti-sentiment detection
    const SARCASM_PATTERNS = [
      /\b\/s\b/i,
      /\byeah\s+right\b/i,
      /\bthanks\s+for\s+nothing\b/i,
      /\bgreat\s+job\s+(?:ignoring|losing|failing|crashing)\b/i,
      /\b(best|wonderful|fantastic)\s+(?:service|app|support|coaching|classes|centre)\s+ever\s*[\.\!]*\s*(?:not|waited|never|terrible|useless)\b/i,
      /\bas\s+if\b/i
    ];
    for (const pat of SARCASM_PATTERNS) {
      if (pat.test(rawText)) {
        return {
          relevant: false,
          confidence: 0.15,
          matched_need: 'None (sarcastic / negative expression)',
          pitch_angle: 'None',
          reason: 'Sarcasm or satirical anti-recommendation detected; no commercial prospect fit'
        };
      }
    }

    // 2. Non-lead intent detection (employment, selling used goods, free piracy)
    const NON_LEAD_PATTERNS = [
      /\b(hiring|vacancy|vacancies|walk-in|recruiting|recruitment|job\s+opening|looking\s+to\s+hire|salary\s+offered|send\s+cv|send\s+resume|immediate\s+joiner)\b/i,
      /\b(for\s+sale|selling\s+my|used\s+books?|second\s+hand|moving\s+sale|pre-owned)\b/i,
      /\b(free\s+download|pirated|crack\s+version|torrent|free\s+pdf)\b/i
    ];
    for (const pat of NON_LEAD_PATTERNS) {
      if (pat.test(rawText)) {
        return {
          relevant: false,
          confidence: 0.10,
          matched_need: 'None (non-customer / employment / classifieds intent)',
          pitch_angle: 'None',
          reason: 'Demand signal exhibits non-customer intent (recruitment, selling used items, or free download hunting)'
        };
      }
    }

    // 3. Ambiguous signal detection (insufficient context or lack of demand action)
    const DEMAND_ACTION_PATTERNS = /\b(need|want|looking\s+for|where\s+can|recommend|recommendation|find|suggest|search|class|course|coaching|booking|appointment|pricing|fees|cost|trial|demo|contact|help|problem|broken|no\s+reply|unresponsive|worst|terrible|bad)\b/i;
    if (rawText.length < 25 && !DEMAND_ACTION_PATTERNS.test(rawText) && !signal.detected_need) {
      return {
        relevant: false,
        confidence: 0.20,
        matched_need: 'Unclear / ambiguous demand',
        pitch_angle: 'None',
        reason: 'Ambiguous signal lacking clear buyer, operational gap, or inquiry intent'
      };
    }

    // 4. Valid lead / Relevant Intent
    const hasGap = signal.intent_class === 'operational_gap' || /\b(no\s+reply|unresponsive|broken|cannot\s+book|poor\s+service)\b/i.test(rawText);
    const hasBuying = signal.intent_class === 'buying_intent' || /\b(looking\s+for|recommend|where\s+can|need\s+a|want\s+a)\b/i.test(rawText);
    const kwHits = deterministicEvidence ? (deterministicEvidence.matched_keywords || []).length : 0;

    let confidence = 0.70;
    if (kwHits > 0) confidence += 0.12;
    if (hasGap || hasBuying) confidence += 0.10;
    confidence = Math.min(0.96, Math.max(0.1, confidence));

    const matchedNeed = signal.detected_need
      ? `Prospect experiencing ${signal.detected_need.replace(/_/g, ' ')} for ${product.topic || 'services'}`
      : `Prospect seeking ${product.topic || 'solutions'} (${signal.intent_class || 'inquiry'})`;

    const pitchAngle = product.offer
      ? `Pitch ${product.name}: ${product.offer}`
      : `Introduce ${product.name} tailored for ${product.target_org || 'organizations'}`;

    const reason = `Validated commercial relevance: prospect need aligns with ${product.name} (${product.topic || 'domain'})`;

    return {
      relevant: true,
      confidence: Math.round(confidence * 1000) / 1000,
      matched_need: matchedNeed,
      pitch_angle: pitchAngle,
      reason
    };
  }
}

/**
 * Mock provider for testing failure modes, malformed outputs, and boundary checks.
 */
class MockRelevanceProvider extends RelevanceProvider {
  constructor(handler) {
    super('mock');
    this.handler = handler;
    this.callCount = 0;
  }

  async classify(args) {
    this.callCount++;
    if (typeof this.handler === 'function') {
      return this.handler(args, this.callCount);
    }
    return {
      relevant: true,
      confidence: 0.90,
      matched_need: 'Mock need',
      pitch_angle: 'Mock pitch',
      reason: 'Mock reason'
    };
  }
}

/**
 * Extensible LLM Provider (Anthropic, OpenAI, or compatible endpoint).
 * Fails closed on any error, network timeout, or schema invalidity.
 */
class LLMRelevanceProvider extends RelevanceProvider {
  constructor(options = {}) {
    super(options.name || 'llm');
    this.apiKey = options.apiKey || process.env.ANTHROPIC_API_KEY || null;
    this.model = options.model || 'claude-3-haiku-20240307';
    this.timeoutMs = options.timeoutMs || 5000;
  }

  async classify({ product, signal, deterministicEvidence }) {
    if (!this.apiKey) {
      throw new Error('LLM API key not configured');
    }
    // Strict prompt with untrusted data isolation
    const systemPrompt = 'You are a strict demand relevance classifier. Respond ONLY with valid JSON.';
    const userPrompt = JSON.stringify({
      instruction: 'Evaluate whether the untrusted demand signal is a genuine lead for the product. Return JSON { "relevant": boolean, "confidence": number (0.0-1.0), "matched_need": string, "pitch_angle": string, "reason": string }',
      product: {
        name: product.name,
        topic: product.topic,
        description: product.description,
        target_org: product.target_org,
        offer: product.offer,
        target_keywords: product.target_keywords
      },
      untrusted_signal: {
        raw_text: signal.raw_text,
        detected_need: signal.detected_need,
        intent_class: signal.intent_class
      },
      deterministic_evidence: deterministicEvidence
    });

    // In this phase, if actual HTTP call is invoked, enforce strict schema and timeout.
    // Throws on failure, handled by fail-closed wrapper in evaluateRelevance.
    throw new Error('Direct LLM endpoint not configured in offline mode');
  }
}

/**
 * Generates a stable SHA-256 cache key isolated per product and signal content_hash.
 */
function makeRelevanceCacheKey(productId, signalContentHash) {
  const pId = String(productId != null ? productId : '').trim();
  const hash = String(signalContentHash != null ? signalContentHash : '').trim();
  if (!pId || !hash) {
    throw new Error('Both productId and signalContentHash are required to construct cache key');
  }
  return crypto.createHash('sha256').update(`product:${pId}|signal:${hash}`).digest('hex');
}

/**
 * Evaluates product relevance for a demand signal against a specific product.
 * Enforces two-stage pipeline:
 * 1. Cheap deterministic gate
 * 2. Semantic classification only for survivors
 * 3. Stable caching by (product.id + content_hash)
 * 4. Durable product_relevance storage
 * 5. Fail-closed on any provider or validation error
 */
async function evaluateRelevance(db, product, signal, options = {}) {
  if (!product || !product.id) throw new Error('Valid product with id is required for relevance evaluation.');
  if (!signal) throw new Error('Valid demand signal is required for relevance evaluation.');

  const contentHash = signal.content_hash || (() => {
    const demandLib = require('./demand');
    return demandLib.contentHash(signal);
  })();

  const cacheKey = makeRelevanceCacheKey(product.id, contentHash);

  // Check cache unless forceRefresh is requested
  if (!options.forceRefresh && db) {
    const cachedRow = db.prepare('SELECT * FROM product_relevance WHERE cache_key=?').get(cacheKey);
    if (cachedRow) {
      let stage1Evidence = {};
      let stage2Result = {};
      try { stage1Evidence = JSON.parse(cachedRow.stage1_evidence); } catch (_) {}
      try { stage2Result = JSON.parse(cachedRow.stage2_result); } catch (_) {}

      return {
        id: cachedRow.id,
        product_id: cachedRow.product_id,
        demand_signal_id: cachedRow.demand_signal_id,
        cache_key: cachedRow.cache_key,
        relevant: Boolean(cachedRow.stage2_passed),
        confidence: cachedRow.confidence,
        stage1: stage1Evidence,
        stage2: stage2Result,
        provider: cachedRow.provider,
        cached: true,
        created_at: cachedRow.created_at,
        updated_at: cachedRow.updated_at
      };
    }
  }

  // STAGE 1 — Deterministic Gate
  const stage1 = evaluateDeterministicGate(product, signal);

  let stage2;
  let providerName = 'deterministic_gate';

  if (!stage1.passed) {
    // Non-survivors do NOT consume semantic provider resources
    stage2 = {
      relevant: false,
      confidence: 0.0,
      matched_need: '',
      pitch_angle: '',
      reason: stage1.rejection_reason || 'Rejected by deterministic gate'
    };
  } else {
    // STAGE 2 — Semantic Classifier (Only for survivors)
    const provider = options.provider || new LocalSemanticClassifier();
    providerName = provider.name || 'unknown';

    try {
      const rawOutput = await provider.classify({ product, signal, deterministicEvidence: stage1 });
      stage2 = validateSemanticResult(rawOutput);
    } catch (err) {
      // Fail closed safely
      stage2 = {
        relevant: false,
        confidence: 0.0,
        matched_need: '',
        pitch_angle: '',
        reason: `Semantic classification failed: ${err.message}`
      };
      providerName = `${providerName}:fail_closed`;
    }
  }

  const now = Date.now();
  let signalId = signal.id ? Number(signal.id) : null;
  if (!signalId && db && contentHash) {
    const sRow = db.prepare('SELECT id FROM demand_signals WHERE content_hash=?').get(contentHash);
    if (sRow) signalId = sRow.id;
  }

  // Persist into product_relevance table if db is provided
  let recordId = null;
  if (db && signalId) {
    const existing = db.prepare('SELECT id FROM product_relevance WHERE product_id=? AND demand_signal_id=?').get(product.id, signalId);
    if (existing) {
      db.prepare(`
        UPDATE product_relevance
        SET cache_key=?, stage1_passed=?, stage1_evidence=?, stage2_passed=?, stage2_result=?, confidence=?, provider=?, updated_at=?
        WHERE id=?
      `).run(
        cacheKey,
        stage1.passed ? 1 : 0,
        JSON.stringify(stage1),
        stage2.relevant ? 1 : 0,
        JSON.stringify(stage2),
        stage2.confidence,
        providerName,
        now,
        existing.id
      );
      recordId = existing.id;
    } else {
      const r = db.prepare(`
        INSERT INTO product_relevance(product_id, demand_signal_id, cache_key, stage1_passed, stage1_evidence, stage2_passed, stage2_result, confidence, provider, created_at, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        product.id,
        signalId,
        cacheKey,
        stage1.passed ? 1 : 0,
        JSON.stringify(stage1),
        stage2.relevant ? 1 : 0,
        JSON.stringify(stage2),
        stage2.confidence,
        providerName,
        now,
        now
      );
      recordId = Number(r.lastInsertRowid);
    }
  }

  return {
    id: recordId,
    product_id: product.id,
    demand_signal_id: signalId,
    cache_key: cacheKey,
    relevant: stage2.relevant,
    confidence: stage2.confidence,
    stage1,
    stage2,
    provider: providerName,
    cached: false,
    created_at: now,
    updated_at: now
  };
}

function getRelevance(db, productId, signalId) {
  const row = db.prepare('SELECT * FROM product_relevance WHERE product_id=? AND demand_signal_id=?').get(Number(productId), Number(signalId));
  if (!row) return null;
  let stage1 = {};
  let stage2 = {};
  try { stage1 = JSON.parse(row.stage1_evidence); } catch (_) {}
  try { stage2 = JSON.parse(row.stage2_result); } catch (_) {}
  return {
    ...row,
    relevant: Boolean(row.stage2_passed),
    stage1,
    stage2
  };
}

function listRelevanceBySignal(db, signalId) {
  const rows = db.prepare('SELECT * FROM product_relevance WHERE demand_signal_id=? ORDER BY confidence DESC').all(Number(signalId));
  return rows.map(r => {
    let stage1 = {};
    let stage2 = {};
    try { stage1 = JSON.parse(r.stage1_evidence); } catch (_) {}
    try { stage2 = JSON.parse(r.stage2_result); } catch (_) {}
    return {
      ...r,
      relevant: Boolean(r.stage2_passed),
      stage1,
      stage2
    };
  });
}

module.exports = {
  STOP_WORDS,
  STEM_RULES,
  normalizeText,
  stemWord,
  tokenize,
  tokenSet,
  stemmedTokenSet,
  ngrams,
  evaluateDeterministicGate,
  validateSemanticResult,
  RelevanceProvider,
  LocalSemanticClassifier,
  MockRelevanceProvider,
  LLMRelevanceProvider,
  makeRelevanceCacheKey,
  evaluateRelevance,
  getRelevance,
  listRelevanceBySignal
};
