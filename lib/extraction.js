'use strict';

const demandLib = require('./demand');

/**
 * Common business / organization designators indicating an explicit entity.
 */
const BUSINESS_DESIGNATORS = [
  'centre', 'center', 'academy', 'institute', 'institution', 'classes', 'school',
  'clinic', 'hospital', 'studio', 'agency', 'services', 'service', 'solutions',
  'technologies', 'labs', 'consultancy', 'consultants', 'firm', 'group',
  'store', 'shop', 'salon', 'spa', 'restaurant', 'cafe', 'café', 'bakery',
  'enterprises', 'associates'
];

const BUSINESS_DESIGNATORS_SET = new Set(BUSINESS_DESIGNATORS);

/**
 * Conversational phrases and verbs that should never be included in an entity name.
 */
const CONVERSATIONAL_PREFIXES_RE = /^(?:looking\s+for|need|want|recommend|suggest|search\s+for|in\s+search\s+of|anyone\s+know|has\s+anyone\s+tried|tried|is\s+there|are\s+there|how\s+is|review\s+of|details\s+about|heard\s+of|about)\s+/i;

/**
 * Generic words and determiners that CANNOT form an entity name alone
 * and indicate a category description rather than an explicit entity.
 */
const GENERIC_DESCRIPTORS = new Set([
  'a', 'an', 'the', 'some', 'any', 'someone', 'anyone', 'somebody', 'anybody',
  'good', 'best', 'top', 'local', 'nearby', 'new', 'old', 'great', 'fine',
  'cheap', 'affordable', 'expensive', 'private', 'public', 'online', 'offline',
  'my', 'our', 'your', 'their', 'which', 'what', 'where', 'how', 'another',
  'reputable', 'certified', 'trusted', 'popular', 'known', 'reliable', 'famous',
  'one', 'two', 'other', 'many', 'few'
]);

/**
 * Prepositions and prefixes to trim from extracted entity names.
 */
const LEADING_TRIM_RE = /^(?:at|in|near|from|to|for|called|named|by|with|about|does|do|can|is|are|a|an|the)\s+/i;
const TRAILING_TRIM_RE = /\s+(?:in|at|near|for|who|which|that|offers?|offering|does|do|is|are|with|having)$/i;

/**
 * Known Indian metropolitan localities and major cities.
 */
const KNOWN_LOCALITIES = [
  // Chennai
  'Anna Nagar', 'T Nagar', 'Adyar', 'Velachery', 'Besant Nagar', 'Mylapore',
  'Nungambakkam', 'Alwarpet', 'Tambaram', 'Porur', 'Guindy', 'OMR', 'ECR',
  'Kilpauk', 'Egmore', 'Royapettah', 'Thiruvanmiyur', 'Kodambakkam', 'Perambur',
  'Chromepet', 'Pallavaram', 'Ambattur', 'Sholinganallur', 'Medavakkam',
  // Bengaluru
  'Indiranagar', 'Koramangala', 'HSR Layout', 'Whitefield', 'Jayanagar',
  'JP Nagar', 'Electronic City', 'Marathahalli', 'BTM Layout', 'Malleshwaram',
  'Hebbal', 'Yelahanka', 'Banashankari', 'Rajajinagar',
  // Mumbai
  'Bandra', 'Andheri', 'Powai', 'Juhu', 'Colaba', 'Dadar', 'Borivali',
  'Goregaon', 'Malad', 'Thane', 'Navi Mumbai', 'Worli', 'Khar',
  // Delhi NCR
  'Connaught Place', 'Karol Bagh', 'Hauz Khas', 'Saket', 'Vasant Kunj',
  'Lajpat Nagar', 'Rohini', 'Dwarka', 'Noida', 'Gurgaon', 'Gurugram'
];

const KNOWN_CITIES = [
  'Chennai', 'Bangalore', 'Bengaluru', 'Mumbai', 'Delhi', 'Hyderabad',
  'Pune', 'Kolkata', 'Coimbatore', 'Madurai', 'Trichy', 'Salem', 'Tiruppur',
  'Kochi', 'Cochin', 'Ahmedabad', 'Jaipur', 'Chandigarh', 'Lucknow'
];

/**
 * Words following "in" / "near" that are NOT locations.
 */
const NOT_LOCATION = new Set([
  'a', 'an', 'the', 'my', 'our', 'your', 'his', 'her', 'their', 'me', 'us',
  'school', 'schools', 'home', 'class', 'classes', 'centre', 'center',
  'office', 'college', 'hospital', 'clinic', 'store', 'shop', 'app',
  'advance', 'addition', 'order', 'fact', 'case', 'short', 'general',
  'online', 'offline', 'person', 'time', 'detail', 'details', 'hindi', 'tamil',
  'english', 'telugu', 'kannada', 'malayalam', 'marathi', 'gujarati'
]);

/**
 * Extracts explicit location hints from text.
 */
function extractLocation(rawText, existingHint = '') {
  const signals = [];
  const text = String(rawText || '').trim();

  // 1. Check known metropolitan localities (case-insensitive substring match)
  for (const loc of KNOWN_LOCALITIES) {
    const re = new RegExp(`\\b${loc.replace(/ /g, '\\s+')}\\b`, 'i');
    if (re.test(text)) {
      signals.push(`known_locality:${loc}`);
      return { location: loc, signals };
    }
  }

  // 2. Check known cities
  for (const city of KNOWN_CITIES) {
    const re = new RegExp(`\\b${city}\\b`, 'i');
    if (re.test(text)) {
      signals.push(`known_city:${city}`);
      return { location: city, signals };
    }
  }

  // 3. Pattern match prepositional phrases: "near <Locality>", "in <Locality>", "at <Locality>"
  const prepMatches = text.matchAll(/\b(?:near|in|at|around|close to|located in|based in)\s+([A-Z][A-Za-z0-9\s.'-]{2,30})(?=[,\.\?!;\n]|\s+(?:for|to|with|and|who|which|that|does|do|can|offer|offering|is|are)\b|$)/g);
  for (const match of prepMatches) {
    let candidate = (match[1] || '').trim();
    candidate = candidate.replace(/\s+/g, ' ');
    const firstWord = candidate.split(' ')[0].toLowerCase();
    if (!NOT_LOCATION.has(firstWord) && candidate.length >= 3) {
      signals.push(`prepositional_phrase:${candidate}`);
      return { location: candidate, signals };
    }
  }

  // 4. Fallback to existing hint from mention provenance if clean
  if (existingHint && typeof existingHint === 'string' && existingHint.trim()) {
    const cleanHint = existingHint.trim();
    if (cleanHint.length <= 100) {
      signals.push(`adapter_provided_hint:${cleanHint}`);
      return { location: cleanHint, signals };
    }
  }

  return { location: '', signals: [] };
}

/**
 * Extracts requested need from mention text.
 */
function extractNeed(rawText, baseClassify) {
  const text = String(rawText || '').trim();
  const signals = [];

  // Need patterns: "need <need>", "looking for <need>", "want <need>", "searching for <need>"
  const needRegex = /\b(?:need|looking for|looking to hire|want|searching for|in search of|seeking|require|hiring)\s+(?:an?\s+|the\s+|for\s+)?([a-zA-Z0-9\s\-]{2,50}?)(?=[,\.\?!;\n]|\s+\b(?:in|near|at|around|for my|for our|for a|for an|who|with|offering)\b|$)/i;
  const match = text.match(needRegex);

  let need = '';
  if (match && match[1]) {
    const candidate = match[1].trim().replace(/\s+/g, ' ');
    if (candidate.length >= 3) {
      need = candidate.toLowerCase();
      signals.push(`regex_need:${need}`);
    }
  }

  // Question/availability pattern: "does <Entity> offer <Need>?"
  const offerRegex = /\boffers?\s+(?:an?\s+|the\s+)?([a-zA-Z0-9\s\-]{2,50}?)(?=[,\.\?!;\n]|\s+\b(?:in|near|at|around|for|who|with)\b|$)/i;
  const offerMatch = text.match(offerRegex);
  if (!need && offerMatch && offerMatch[1]) {
    const cand = offerMatch[1].trim().replace(/\s+/g, ' ');
    if (cand.length >= 3) {
      need = cand.toLowerCase();
      signals.push(`offer_inquiry:${need}`);
    }
  }

  // "Best / top / recommend <need> in <location>?"
  const bestRegex = /\b(?:best|top|recommended|recommend)\s+(?:an?\s+|the\s+)?([a-zA-Z0-9\s\-]{2,50}?)(?=[,\.\?!;\n]|\s+\b(?:in|near|at|around|for)\b|$)/i;
  const bestMatch = text.match(bestRegex);
  if (!need && bestMatch && bestMatch[1]) {
    const cand = bestMatch[1].trim().replace(/\s+/g, ' ');
    if (cand.length >= 3) {
      need = cand.toLowerCase();
      signals.push(`best_inquiry:${need}`);
    }
  }

  // Fallback to demand.classify detected need
  if (!need && baseClassify && baseClassify.detected_need) {
    need = baseClassify.detected_need;
    signals.push(`classifier_need:${need}`);
  }

  return { need, signals };
}

/**
 * Detects adversarial clauses, mixed sentiment, or multi-clause noise.
 * Specifically handles cases where an entity is attacked/complained about in one clause
 * while an unrelated need is requested in another clause (e.g. Test D).
 */
function detectAdversarialDivergence(rawText) {
  const text = String(rawText || '').trim();
  const COMPLAINT_PATTERNS = [
    /\b(?:is\s+terrible|is\s+horrible|is\s+worst|bad\s+service|poor\s+service|avoid|scam|hate|didn.?t\s+help|rude|useless|unprofessional)\b/i
  ];
  const NEED_PATTERNS = [
    /\b(?:i\s+need|looking\s+for|want|searching\s+for|require|hiring)\b/i
  ];

  let hasComplaint = false;
  for (const cp of COMPLAINT_PATTERNS) {
    if (cp.test(text)) {
      hasComplaint = true;
      break;
    }
  }

  let hasNeed = false;
  for (const np of NEED_PATTERNS) {
    if (np.test(text)) {
      hasNeed = true;
      break;
    }
  }

  if (hasComplaint && hasNeed) {
    return {
      divergent: true,
      reason: 'Entity mentioned in complaint clause cannot be bound to unrelated buying intent'
    };
  }

  return { divergent: false, reason: null };
}

/**
 * Validates whether a candidate string qualifies as a genuine business entity name.
 * Strictly enforces:
 * - Proper nouns / Specific names
 * - Rejection of pure generic descriptors ("a good abacus centre", "someone", "any classes")
 */
function isValidEntityCandidate(candidate) {
  if (!candidate || typeof candidate !== 'string') return false;
  let clean = candidate.trim().replace(CONVERSATIONAL_PREFIXES_RE, '').replace(/\s+/g, ' ');
  if (clean.length < 3 || clean.length > 100) return false;

  const words = clean.split(' ');
  const lowerWords = words.map(w => w.toLowerCase());

  // If every word is a generic descriptor, reject
  const nonGeneric = lowerWords.filter(w => !GENERIC_DESCRIPTORS.has(w));
  if (nonGeneric.length === 0) return false;

  // Single-word pronouns like "someone", "anyone", "nobody"
  if (words.length === 1 && GENERIC_DESCRIPTORS.has(lowerWords[0])) return false;

  // If all non-generic words are just designators (e.g. "good classes"), reject
  const nonDesignatorWords = nonGeneric.filter(w => !BUSINESS_DESIGNATORS_SET.has(w));
  if (nonDesignatorWords.length === 0) return false;

  // Distinctive check: must contain at least one capitalized proper noun, acronym,
  // or distinctive proper name that distinguishes a specific entity from a generic category.
  // E.g. "ABC Abacus Centre", "Bright Star Academy", "Apex Clinic".
  // Purely lowercased generic phrases like "a good abacus centre" have no capitalized proper noun.
  const hasCapitalizedProperNoun = words.some(w => /^[A-Z][a-zA-Z0-9'&.\-]*$/.test(w) && !GENERIC_DESCRIPTORS.has(w.toLowerCase()));
  const hasAcronym = words.some(w => /^[A-Z]{2,10}$/.test(w));

  return (hasCapitalizedProperNoun || hasAcronym);
}

/**
 * Cleans extracted entity name string.
 */
function cleanEntityCandidate(str) {
  if (!str) return '';
  return str
    .replace(CONVERSATIONAL_PREFIXES_RE, '')
    .replace(LEADING_TRIM_RE, '')
    .replace(TRAILING_TRIM_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extracts explicit business / provider entity name from text.
 * Returns { entity: string, signals: string[], type: 'business' | 'none', rejection_reason: string | null }
 */
function extractEntity(rawText, locationHint = '') {
  const text = String(rawText || '').trim();
  const signals = [];

  // Check multi-clause adversarial conflict first
  const adv = detectAdversarialDivergence(text);
  if (adv.divergent) {
    return {
      entity: '',
      signals: [`adversarial_divergence:${adv.reason}`],
      type: 'none',
      rejection_reason: adv.reason
    };
  }

  // 1. Availability / inquiry pattern: "Does <Entity> in <Loc>? / Does <Entity> offer <Need>?"
  const doesMatch = text.match(/\bdoes\s+([A-Z0-9][A-Za-z0-9'&.\s]{1,50}?)\s+(?:in|at|near|offer|have|provide)\b/i);
  if (doesMatch && doesMatch[1]) {
    const cand = cleanEntityCandidate(doesMatch[1]);
    if (isValidEntityCandidate(cand)) {
      signals.push(`inquiry_target:${cand}`);
      return { entity: cand, signals, type: 'business', rejection_reason: null };
    }
  }

  // 2. Named designator pattern: "<ProperNoun...> <Designator>"
  // E.g. "ABC Abacus Centre", "St. Jude's Academy", "Apollo Clinic"
  const designatorPattern = new RegExp(`\\b([A-Z0-9][A-Za-z0-9'&.\\s]{1,40}?)\\s+(${BUSINESS_DESIGNATORS.join('|')})\\b`, 'i');
  const dMatch = text.match(designatorPattern);
  if (dMatch && dMatch[1] && dMatch[2]) {
    const rawPrefix = dMatch[1];
    const prefix = cleanEntityCandidate(rawPrefix);
    let designator = dMatch[2].trim();

    if (/^[A-Z]/.test(prefix)) {
      designator = designator.charAt(0).toUpperCase() + designator.slice(1).toLowerCase();
    }

    const fullCandidate = cleanEntityCandidate(`${prefix} ${designator}`);
    if (isValidEntityCandidate(fullCandidate)) {
      signals.push(`designator_match:${fullCandidate}`);
      return { entity: fullCandidate, signals, type: 'business', rejection_reason: null };
    }
  }

  // 3. Quoted entity names: called "..." or named "..."
  const quotedMatch = text.match(/\b(?:called|named|at)\s+["']([A-Z0-9][A-Za-z0-9'&.\s]{2,40})["']/i);
  if (quotedMatch && quotedMatch[1]) {
    const cand = cleanEntityCandidate(quotedMatch[1]);
    if (isValidEntityCandidate(cand)) {
      signals.push(`quoted_entity:${cand}`);
      return { entity: cand, signals, type: 'business', rejection_reason: null };
    }
  }

  // 4. Fail-closed: No reliable entity found
  return {
    entity: '',
    signals: ['no_explicit_business_entity_detected'],
    type: 'none',
    rejection_reason: 'No reliable explicit business entity named in text'
  };
}

/**
 * Audited Entity & Demand Extraction
 *
 * Input: normalized raw mention object
 * Output:
 * {
 *   entity_name: string,
 *   location_hint: string,
 *   detected_need: string,
 *   intent_class: string,
 *   confidence_score: number,
 *   evidence: { ... }
 * }
 */
function extractMentionEntities(mention) {
  if (!mention || typeof mention !== 'object') {
    throw new Error('Mention is required for extraction.');
  }

  const rawText = String(mention.raw_text || '').trim();
  if (!rawText) {
    return {
      entity_name: '',
      location_hint: '',
      detected_need: '',
      intent_class: 'other',
      confidence_score: 0.0,
      evidence: {
        entity_found: false,
        entity_type: 'none',
        entity_signals: [],
        location_found: false,
        location_signals: [],
        intent_signals: [],
        need_signals: [],
        adversarial_flags: ['empty_text'],
        entity_category: 'no_reliable_entity',
        rejection_reason: 'Empty raw text'
      }
    };
  }

  // 1. Base intent classification from demand module
  const baseClassify = demandLib.classify(rawText);

  // 2. Extract location
  const locRes = extractLocation(rawText, mention.location_hint);

  // 3. Extract requested need
  const needRes = extractNeed(rawText, baseClassify);

  // 4. Extract explicit entity
  const entityRes = extractEntity(rawText, locRes.location);

  // 5. Adversarial checks
  const advRes = detectAdversarialDivergence(rawText);
  const adversarialFlags = [];
  if (advRes.divergent) {
    adversarialFlags.push('complaint_need_divergence');
  }

  // 6. Refine intent_class:
  // If text is an inquiry ("does ... offer", "is there ..."), mark as buying_intent
  let effectiveIntent = baseClassify.intent_class || 'other';
  if (effectiveIntent === 'other') {
    if (/\b(?:does|is\s+there|offers?|availability|available)\b/i.test(rawText) && (needRes.need || entityRes.entity)) {
      effectiveIntent = 'buying_intent';
    } else if (/\b(?:best|top|recommend|good)\b/i.test(rawText) && needRes.need) {
      effectiveIntent = 'buying_intent';
    }
  }

  // 7. Categorize extraction state
  let entityCategory = 'no_reliable_entity';
  if (entityRes.entity) {
    entityCategory = 'explicit_business';
  } else if (locRes.location && needRes.need) {
    entityCategory = 'location_only';
  } else if (needRes.need) {
    entityCategory = 'generic_need_only';
  }

  // 8. Calculate bounded confidence score (0..1)
  let confidence = 0.40;
  if (entityRes.entity) {
    confidence = 0.85;
    if (locRes.location) confidence += 0.08;
    if (needRes.need) confidence += 0.05;
  } else if (locRes.location && needRes.need) {
    confidence = 0.70;
  } else if (needRes.need) {
    confidence = 0.55;
  } else {
    confidence = 0.30;
  }

  if (advRes.divergent) {
    confidence = Math.min(confidence, 0.45);
  }

  const boundedConfidence = Math.max(0, Math.min(1, Math.round(confidence * 100) / 100));

  return {
    entity_name: entityRes.entity,
    location_hint: locRes.location,
    detected_need: needRes.need || baseClassify.detected_need || '',
    intent_class: effectiveIntent,
    confidence_score: boundedConfidence,
    evidence: {
      entity_found: Boolean(entityRes.entity),
      entity_type: entityRes.type,
      entity_signals: entityRes.signals,
      location_found: Boolean(locRes.location),
      location_signals: locRes.signals,
      intent_signals: [`effective_intent:${effectiveIntent}`],
      need_signals: needRes.signals,
      adversarial_flags: adversarialFlags,
      entity_category: entityCategory,
      rejection_reason: entityRes.rejection_reason || null
    }
  };
}

module.exports = {
  extractMentionEntities,
  extractLocation,
  extractNeed,
  extractEntity,
  isValidEntityCandidate,
  detectAdversarialDivergence,
  BUSINESS_DESIGNATORS,
  GENERIC_DESCRIPTORS,
  KNOWN_LOCALITIES,
  KNOWN_CITIES
};
