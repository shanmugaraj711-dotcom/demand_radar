'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const db_ = require('../lib/db');
const productsLib = require('../lib/products');
const demand = require('../lib/demand');
const messages = require('../lib/messages');
const relevanceLib = require('../lib/relevance');

async function testPhase2ProductRelevance() {
  console.log('\n=== Running Phase 2 Product Relevance Engine Test Suite ===');
  const tmpDir = path.join(__dirname, '..', 'data', 'test-scratch');
  fs.mkdirSync(tmpDir, { recursive: true });
  const testDbFile = path.join(tmpDir, `relevance-test-${Date.now()}.db`);

  let db;
  try {
    db = db_.open(testDbFile);

    const defaultProd = productsLib.getActiveProduct(db);
    const prodMath = productsLib.updateProduct(db, defaultProd.id, {
      name: 'MathGenius Kids',
      topic: 'abacus maths',
      target_org: 'centre',
      link: 'https://mathgenius.test',
      offer: '2 free trial accounts for your centre',
      target_keywords: ['abacus', 'abacus classes', 'vedic maths', 'mental arithmetic', 'math tuition'],
      negative_keywords: ['college', 'adult', 'used book', 'job vacancy'],
      templates: {
        first_en: 'Hello from {product}!'
      }
    });

    // Create a second product (Product 2: Yoga Studio Pro)
    const prodYoga = productsLib.createProduct(db, {
      slug: 'yogaflow-pro',
      name: 'YogaFlow Pro',
      description: 'Management and booking software for yoga and fitness studios',
      topic: 'yoga fitness',
      target_org: 'studio',
      link: 'https://yogaflow.test',
      offer: '14-day free pilot for your yoga studio',
      target_keywords: ['yoga', 'yoga classes', 'meditation', 'pranayama', 'fitness studio'],
      negative_keywords: ['swimming', 'martial arts', 'used mat'],
      templates: {
        first_en: 'Namaste from {product}!'
      },
      active: false
    });

    // Create sample leads for resolution testing
    const now = Date.now();
    db.prepare(`
      INSERT INTO leads(id, name, address, area, city, phone, wa, phone_type, lat, lng, score, stage, created, updated)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(501, 'Alpha Abacus Academy', '12 Cross, Anna Nagar', 'Anna Nagar', 'Chennai', '+919840111111', '919840111111', 'mobile', 13.085, 80.21, 85, 'new', now, now);

    db.prepare(`
      INSERT INTO leads(id, name, address, area, city, phone, wa, phone_type, lat, lng, score, stage, created, updated)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(502, 'Shanti Yoga Kendra', '45 Main Rd, Anna Nagar', 'Anna Nagar', 'Chennai', '+919840222222', '919840222222', 'mobile', 13.086, 80.212, 85, 'new', now, now);

    // =========================================================================
    // Test 1: Strongly Relevant Signal
    // =========================================================================
    console.log('  Testing 1. Strongly relevant signal...');
    const sig1 = demand.insertSignal(db, {
      source: 'social',
      source_id: 'sig-strong-1',
      raw_text: 'Looking for abacus classes and mental arithmetic in Anna Nagar for my child. Please recommend good centers.',
      entity_name: 'Alpha Abacus Academy',
      location_hint: 'Anna Nagar',
      detected_need: 'looking_for_abacus_classes',
      intent_class: 'buying_intent'
    });
    assert.strictEqual(sig1.inserted, true);

    const rel1 = await relevanceLib.evaluateRelevance(db, prodMath, sig1.signal);
    assert.strictEqual(rel1.stage1.passed, true, 'Stage 1 deterministic gate must pass for strongly relevant signal');
    assert.strictEqual(rel1.relevant, true, 'Stage 2 must classify strongly relevant signal as relevant');
    assert(rel1.confidence >= 0.75, `Confidence must be high (got ${rel1.confidence})`);
    assert(rel1.stage1.matched_keywords.includes('abacus'), 'Should match keyword abacus');
    assert(rel1.stage2.matched_need.length > 0, 'Matched need must be populated');
    assert(rel1.stage2.pitch_angle.length > 0, 'Pitch angle must be populated');
    console.log('    ok - Strongly relevant signal passed with confidence:', rel1.confidence);

    // =========================================================================
    // Test 2: Clearly Unrelated Signal
    // =========================================================================
    console.log('  Testing 2. Clearly unrelated signal...');
    const sig2 = demand.insertSignal(db, {
      source: 'social',
      source_id: 'sig-unrelated-2',
      raw_text: 'Where can I get car tyre replacement and wheel alignment in Chennai?',
      entity_name: 'Tyre Hub',
      location_hint: 'Chennai',
      detected_need: 'car_repair',
      intent_class: 'buying_intent'
    });

    const rel2 = await relevanceLib.evaluateRelevance(db, prodMath, sig2.signal);
    assert.strictEqual(rel2.stage1.passed, false, 'Deterministic gate must reject clearly unrelated domain');
    assert.strictEqual(rel2.relevant, false, 'Unrelated signal must not be relevant');
    assert.strictEqual(rel2.confidence, 0.0, 'Confidence must be 0.0 for deterministic rejection');
    assert(rel2.stage1.rejection_reason.includes('zero overlap') || rel2.stage1.reasons[0].includes('zero'), 'Rejection reason must explain zero overlap');
    console.log('    ok - Clearly unrelated signal rejected at Stage 1');

    // =========================================================================
    // Test 3: Keyword Overlap but Wrong Intent (Recruitment / Classified)
    // =========================================================================
    console.log('  Testing 3. Keyword overlap but wrong intent...');
    const sig3 = demand.insertSignal(db, {
      source: 'social',
      source_id: 'sig-hiring-3',
      raw_text: 'Urgently hiring abacus teacher and trainers. Immediate joiner needed. Salary 25k. Send cv.',
      entity_name: 'Alpha Abacus Academy',
      location_hint: 'Anna Nagar'
    });

    const rel3 = await relevanceLib.evaluateRelevance(db, prodMath, sig3.signal);
    assert.strictEqual(rel3.stage1.passed, true, 'Deterministic gate should pass on keyword abacus');
    assert.strictEqual(rel3.relevant, false, 'Semantic classifier must reject recruitment / non-customer intent');
    assert(rel3.confidence <= 0.20, 'Confidence for wrong intent must be low');
    assert(rel3.stage2.reason.includes('non-customer') || rel3.stage2.reason.includes('intent'), 'Reason must explain wrong intent');
    console.log('    ok - Keyword overlap with wrong intent rejected by semantic stage');

    // =========================================================================
    // Test 4: Synonym / Semantic Relevance
    // =========================================================================
    console.log('  Testing 4. Synonym / semantic phrasing...');
    const sig4 = demand.insertSignal(db, {
      source: 'social',
      source_id: 'sig-synonym-4',
      raw_text: 'Looking for mental arithmetic coaching and math tuition for primary school learners.',
      entity_name: 'Alpha Abacus Academy',
      location_hint: 'Anna Nagar',
      intent_class: 'buying_intent'
    });

    const rel4 = await relevanceLib.evaluateRelevance(db, prodMath, sig4.signal);
    assert.strictEqual(rel4.stage1.passed, true, 'Stemmed / token overlap on math tuition and mental arithmetic must pass');
    assert.strictEqual(rel4.relevant, true, 'Semantic classifier must confirm relevance');
    assert(rel4.confidence >= 0.70, 'Confidence must be strong for synonym/need match');
    console.log('    ok - Synonym phrasing passed with confidence:', rel4.confidence);

    // =========================================================================
    // Test 5: Negative / Exclusion Term
    // =========================================================================
    console.log('  Testing 5. Negative / exclusion term...');
    const sig5 = demand.insertSignal(db, {
      source: 'social',
      source_id: 'sig-neg-5',
      raw_text: 'Need abacus classes for adult college degree students in Anna Nagar.',
      entity_name: 'Alpha Abacus Academy',
      location_hint: 'Anna Nagar',
      intent_class: 'buying_intent'
    });

    const rel5 = await relevanceLib.evaluateRelevance(db, prodMath, sig5.signal);
    assert.strictEqual(rel5.stage1.passed, false, 'Deterministic gate must reject when negative keyword is present');
    assert.strictEqual(rel5.relevant, false, 'Excluded signal must not be relevant');
    assert(rel5.stage1.negative_hits.includes('college') || rel5.stage1.negative_hits.includes('adult'), 'Must report negative hit');
    assert.strictEqual(rel5.provider, 'deterministic_gate', 'Semantic provider must NOT be invoked for negative hit');
    console.log('    ok - Excluded by negative term:', rel5.stage1.negative_hits);

    // =========================================================================
    // Test 6: Sarcasm / Anti-sentiment
    // =========================================================================
    console.log('  Testing 6. Sarcasm detection...');
    const sig6 = demand.insertSignal(db, {
      source: 'social',
      source_id: 'sig-sarcasm-6',
      raw_text: 'Great job ignoring customer messages for 3 weeks! Best abacus classes ever, wonderful service! /s',
      entity_name: 'Alpha Abacus Academy',
      location_hint: 'Anna Nagar'
    });

    const rel6 = await relevanceLib.evaluateRelevance(db, prodMath, sig6.signal);
    assert.strictEqual(rel6.stage1.passed, true, 'Deterministic gate passes survivor on keyword abacus');
    assert.strictEqual(rel6.relevant, false, 'Semantic classifier must reject sarcastic anti-recommendation');
    assert(rel6.stage2.reason.includes('Sarcasm') || rel6.stage2.reason.includes('sarcastic'), 'Reason must identify sarcasm');
    console.log('    ok - Sarcasm correctly identified and rejected');

    // =========================================================================
    // Test 7: Ambiguous Signal (Insufficient context)
    // =========================================================================
    console.log('  Testing 7. Ambiguous signal...');
    const sig7 = demand.insertSignal(db, {
      source: 'social',
      source_id: 'sig-ambig-7',
      raw_text: 'Abacus is nice.',
      entity_name: 'Alpha Abacus Academy',
      location_hint: 'Anna Nagar'
    });

    const rel7 = await relevanceLib.evaluateRelevance(db, prodMath, sig7.signal);
    assert.strictEqual(rel7.stage1.passed, true, 'Single keyword matches deterministic gate');
    assert.strictEqual(rel7.relevant, false, 'Semantic classifier must reject ambiguous signal lacking clear need');
    assert(rel7.confidence <= 0.30, 'Confidence must be low');
    console.log('    ok - Ambiguous signal flagged as low confidence / not relevant');

    // =========================================================================
    // Test 8: Same Signal against Two Different Products
    // =========================================================================
    console.log('  Testing 8. Same signal evaluated against two different products...');
    const yogaSignal = demand.insertSignal(db, {
      source: 'social',
      source_id: 'sig-yoga-shared',
      raw_text: 'Looking for authentic yoga classes and meditation near Anna Nagar for beginners.',
      entity_name: 'Shanti Yoga Kendra',
      location_hint: 'Anna Nagar',
      intent_class: 'buying_intent'
    });

    const relMathYoga = await relevanceLib.evaluateRelevance(db, prodMath, yogaSignal.signal);
    const relYogaYoga = await relevanceLib.evaluateRelevance(db, prodYoga, yogaSignal.signal);

    assert.strictEqual(relMathYoga.relevant, false, 'Yoga signal must NOT be relevant for Math product');
    assert.strictEqual(relMathYoga.stage1.passed, false, 'Math deterministic gate must reject Yoga signal');
    assert.strictEqual(relYogaYoga.relevant, true, 'Yoga signal MUST be relevant for Yoga product');
    assert.strictEqual(relYogaYoga.stage1.passed, true, 'Yoga deterministic gate must pass Yoga signal');
    assert(relYogaYoga.confidence >= 0.75, 'Yoga product confidence must be high');
    console.log('    ok - Product A rejected signal, Product B accepted signal');

    // =========================================================================
    // Test 9: Cache Isolation between Products
    // =========================================================================
    console.log('  Testing 9. Cache isolation between products...');
    const cacheKeyMath = relevanceLib.makeRelevanceCacheKey(prodMath.id, yogaSignal.signal.content_hash);
    const cacheKeyYoga = relevanceLib.makeRelevanceCacheKey(prodYoga.id, yogaSignal.signal.content_hash);

    assert.notStrictEqual(cacheKeyMath, cacheKeyYoga, 'Cache keys for different products must be distinct');

    const rowMath = db.prepare('SELECT * FROM product_relevance WHERE cache_key=?').get(cacheKeyMath);
    const rowYoga = db.prepare('SELECT * FROM product_relevance WHERE cache_key=?').get(cacheKeyYoga);

    assert(rowMath, 'Math relevance record must exist in DB');
    assert(rowYoga, 'Yoga relevance record must exist in DB');
    assert.strictEqual(rowMath.product_id, prodMath.id);
    assert.strictEqual(rowYoga.product_id, prodYoga.id);
    assert.strictEqual(rowMath.stage2_passed, 0);
    assert.strictEqual(rowYoga.stage2_passed, 1);
    console.log('    ok - Cache keys and records are completely isolated');

    // =========================================================================
    // Test 10: Malformed Semantic-Provider Response (Fail Closed)
    // =========================================================================
    console.log('  Testing 10. Malformed semantic provider response...');
    const malformedProvider = new relevanceLib.MockRelevanceProvider(() => {
      // Returns non-compliant structure missing required 'relevant' boolean
      return { status: 'ok', score: 0.9 };
    });

    const relMalformed = await relevanceLib.evaluateRelevance(db, prodMath, sig1.signal, {
      provider: malformedProvider,
      forceRefresh: true
    });
    assert.strictEqual(relMalformed.relevant, false, 'Must fail closed when provider returns malformed response');
    assert.strictEqual(relMalformed.confidence, 0.0, 'Confidence must be 0.0 on malformed output');
    assert(relMalformed.stage2.reason.includes('failed') || relMalformed.stage2.reason.includes('relevant'), 'Reason must describe failure');
    console.log('    ok - Malformed response caught and failed closed');

    // =========================================================================
    // Test 11: Provider Failure / Exception (Fail Closed)
    // =========================================================================
    console.log('  Testing 11. Provider failure / crash...');
    const crashingProvider = new relevanceLib.MockRelevanceProvider(() => {
      throw new Error('Connection timeout to upstream model service');
    });

    const relCrash = await relevanceLib.evaluateRelevance(db, prodMath, sig1.signal, {
      provider: crashingProvider,
      forceRefresh: true
    });
    assert.strictEqual(relCrash.relevant, false, 'Must fail closed when provider throws error');
    assert.strictEqual(relCrash.confidence, 0.0, 'Confidence must be 0.0 on provider crash');
    assert(relCrash.stage2.reason.includes('Connection timeout'), 'Failure reason must be captured');
    console.log('    ok - Provider exception caught and failed closed');

    // =========================================================================
    // Test 12: Confidence Boundary Validation
    // =========================================================================
    console.log('  Testing 12. Confidence boundary validation...');
    assert.throws(
      () => relevanceLib.validateSemanticResult({ relevant: true, confidence: 1.5, matched_need: 'a', pitch_angle: 'b', reason: 'c' }),
      /Semantic provider confidence must be a finite number between 0.0 and 1.0/,
      'Confidence > 1.0 must be rejected'
    );
    assert.throws(
      () => relevanceLib.validateSemanticResult({ relevant: true, confidence: -0.1, matched_need: 'a', pitch_angle: 'b', reason: 'c' }),
      /Semantic provider confidence must be a finite number between 0.0 and 1.0/,
      'Confidence < 0.0 must be rejected'
    );
    assert.throws(
      () => relevanceLib.validateSemanticResult({ relevant: true, confidence: NaN, matched_need: 'a', pitch_angle: 'b', reason: 'c' }),
      /Semantic provider confidence must be a finite number between 0.0 and 1.0/,
      'NaN confidence must be rejected'
    );
    assert.throws(
      () => relevanceLib.validateSemanticResult({ relevant: 'true', confidence: 0.8, matched_need: 'a', pitch_angle: 'b', reason: 'c' }),
      /must include boolean "relevant"/,
      'Non-boolean relevant must be rejected'
    );
    console.log('    ok - Schema validation strictly enforces confidence boundaries 0..1 and types');

    // =========================================================================
    // Test 13: Unreviewed Opportunity Remains Blocked from Outreach
    // =========================================================================
    console.log('  Testing 13. Unreviewed opportunity remains blocked...');
    const matches = demand.resolve(db, sig1.signal, 5);
    const topMatch = matches.find(m => m.match_status === 'matched');
    assert(topMatch, 'Should find matching lead');

    const oppId = demand.createOpportunity(db, sig1.id, {
      lead_id: topMatch.lead_id,
      leadReason: sig1.signal.detected_need,
      confidence: topMatch.confidence,
      reasons: topMatch.reasons,
      signalSource: sig1.signal.source,
      sourceUrl: sig1.signal.source_url,
      observedAt: sig1.signal.observed_at,
      rawText: sig1.signal.raw_text,
      product_id: prodMath.id,
      relevance: {
        product_id: prodMath.id,
        confidence: rel1.confidence,
        stage1_passed: rel1.stage1.passed,
        matched_need: rel1.stage2.matched_need,
        pitch_angle: rel1.stage2.pitch_angle,
        reason: rel1.stage2.reason
      }
    });

    const opp = demand.getOpportunity(db, oppId);
    assert.strictEqual(opp.status, 'unreviewed', 'Opportunity must be unreviewed on creation');

    const leadRow = db.prepare('SELECT * FROM leads WHERE id=?').get(opp.lead_id);
    const actionBlocked = messages.action(
      leadRow,
      { templates: { first_en: 'SHOULD NEVER BE GENERATED' }, sender: '', product: '', topic: '', org: '', link: '', offer: '' },
      'first',
      opp
    );
    assert.strictEqual(actionBlocked.blocked, true, 'Unreviewed opportunity must be blocked from outreach');
    assert.strictEqual('text' in actionBlocked, false, 'No message text allowed for unreviewed opportunity');
    assert.strictEqual('wa' in actionBlocked, false, 'No WhatsApp URL allowed for unreviewed opportunity');
    console.log('    ok - Unreviewed opportunity strictly blocked from outreach');

    // =========================================================================
    // Test 14: Human-Confirmed Opportunity Unblocks Outreach
    // =========================================================================
    console.log('  Testing 14. Human confirmation unblocks outreach...');
    demand.confirmOpportunity(db, oppId, 'auditor-reviewer');
    const confirmedOpp = demand.getOpportunity(db, oppId);
    assert.strictEqual(confirmedOpp.status, 'human_confirmed');
    assert.strictEqual(confirmedOpp.confirmed_by, 'auditor-reviewer');

    const actionUnblocked = messages.action(
      leadRow,
      { templates: { first_en: 'Hi {name}' }, sender: 'Shan', product: 'MathGenius', topic: 'math', org: 'centre', link: 'https://test', offer: 'free' },
      'first',
      confirmedOpp
    );
    assert.strictEqual(!actionUnblocked.blocked, true, 'Human-confirmed opportunity must unblock outreach');
    assert(actionUnblocked.text.includes('Alpha Abacus Academy'), 'Message text must be present');
    assert(actionUnblocked.wa.includes('919840111111'), 'WhatsApp URL must be generated');
    console.log('    ok - Human confirmation successfully unblocks outreach');

    // =========================================================================
    // Test 15: No Product Leakage
    // =========================================================================
    console.log('  Testing 15. No product context leakage...');
    // Modify Product 1 (MathGenius Kids) description and target_keywords
    productsLib.updateProduct(db, prodMath.id, {
      description: 'Updated Math description with altered text',
      offer: '30-day extended trial'
    });

    // Check that Product 2 (Yoga) relevance result for yogaSignal is completely untouched
    const yogaCached = await relevanceLib.evaluateRelevance(db, prodYoga, yogaSignal.signal);
    assert.strictEqual(yogaCached.cached, true, 'Yoga relevance must be served from its own cache');
    assert.strictEqual(yogaCached.product_id, prodYoga.id);
    assert.strictEqual(yogaCached.relevant, true);
    assert(!yogaCached.stage2.pitch_angle.includes('Math'), 'No math content should leak into yoga pitch');
    console.log('    ok - Modifying Product A does not alter Product B results');

    // =========================================================================
    // Test 16: No Duplicate Semantic Calls for Identical Product+Signal
    // =========================================================================
    console.log('  Testing 16. Cache prevents duplicate semantic calls...');
    let providerCalls = 0;
    const countingProvider = new relevanceLib.MockRelevanceProvider(() => {
      providerCalls++;
      return {
        relevant: true,
        confidence: 0.92,
        matched_need: 'Counted need',
        pitch_angle: 'Counted pitch',
        reason: 'Counted reason'
      };
    });

    // Fresh signal for counting test
    const sigCounter = demand.insertSignal(db, {
      source: 'social',
      source_id: 'sig-counter-1',
      raw_text: 'Need abacus classes for 8 year old in Chennai.',
      entity_name: 'Alpha Abacus Academy',
      location_hint: 'Chennai'
    });

    // Call 1: uncached, should invoke countingProvider
    const eval1 = await relevanceLib.evaluateRelevance(db, prodMath, sigCounter.signal, { provider: countingProvider });
    assert.strictEqual(eval1.cached, false, 'First call must not be cached');
    assert.strictEqual(providerCalls, 1, 'Provider must be called once on first run');

    // Call 2: identical product + identical signal, should be served from cache
    const eval2 = await relevanceLib.evaluateRelevance(db, prodMath, sigCounter.signal, { provider: countingProvider });
    assert.strictEqual(eval2.cached, true, 'Second call must be served from cache');
    assert.strictEqual(providerCalls, 1, 'Provider call count must remain 1 (no duplicate call!)');
    assert.strictEqual(eval2.confidence, 0.92, 'Cached confidence must match');
    console.log('    ok - Identical product+signal consumed semantic provider exactly once');

    console.log('\nAll 16 Phase 2 Product Relevance tests passed successfully!\n');
  } finally {
    if (db) db.close();
    for (const ext of ['', '-wal', '-shm']) {
      try { fs.rmSync(testDbFile + ext, { force: true }); } catch (_) {}
    }
  }
}

if (require.main === module) {
  testPhase2ProductRelevance()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('test/product-relevance.test.js FAILED:', err);
      process.exit(1);
    });
}

module.exports = { testPhase2ProductRelevance };
