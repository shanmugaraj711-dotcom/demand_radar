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

    // =========================================================================
    // Test 17: Product-Specific Relevance — APK Conversion vs Web Designer
    // =========================================================================
    console.log('  Testing 17. Product-specific relevance: APK conversion vs web designer...');
    const prodApk = productsLib.createProduct(db, {
      slug: 'web-to-apk-service',
      name: 'Website to Android APK Service',
      description: 'Convert existing responsive websites into Android APK mobile apps with offline cache',
      topic: 'app conversion',
      target_org: 'business',
      target_keywords: ['website', 'apk conversion', 'website to app', 'android apk', 'convert website'],
      active: false
    });

    const sigDesigner = demand.insertSignal(db, {
      source: 'social',
      source_id: 'sig-designer-17',
      raw_text: 'Looking for a website designer for my restaurant. Need modern UI and menu layout.',
      entity_name: 'Spice Garden Restaurant',
      location_hint: 'Chennai'
    });

    const relApkDesigner = await relevanceLib.evaluateRelevance(db, prodApk, sigDesigner.signal);
    assert.strictEqual(relApkDesigner.relevant, false, 'Web design demand must NOT be relevant for APK conversion product');
    assert(relApkDesigner.confidence <= 0.30, `Confidence must be <= 0.30 (got ${relApkDesigner.confidence})`);
    assert(relApkDesigner.stage2.reason.includes('Capability mismatch') || relApkDesigner.stage2.reason.includes('not provided') || relApkDesigner.stage2.reason.includes('design'), 'Reason must explicitly cite capability mismatch');
    console.log('    ok - APK conversion correctly rejected web designer demand (confidence <= 0.30)');

    // =========================================================================
    // Test 18: Product-Specific Relevance — Kids Abacus App
    // =========================================================================
    console.log('  Testing 18. Product-specific relevance: Kids abacus app...');
    const sigAbacusApp = demand.insertSignal(db, {
      source: 'social',
      source_id: 'sig-abacus-app-18',
      raw_text: 'Looking for an Android app to help my 8-year-old practise abacus at home.',
      entity_name: 'Alpha Abacus Academy',
      location_hint: 'Chennai'
    });

    const relAbacusApp = await relevanceLib.evaluateRelevance(db, prodMath, sigAbacusApp.signal);
    assert.strictEqual(relAbacusApp.relevant, true, 'Abacus practice app demand MUST be relevant for abacus product');
    assert(relAbacusApp.confidence >= 0.70, `Confidence must be strong (got ${relAbacusApp.confidence})`);
    console.log('    ok - Kids abacus app demand confirmed relevant with confidence:', relAbacusApp.confidence);

    // =========================================================================
    // Test 19: Product-Specific Relevance — Google Ads vs Website Repair
    // =========================================================================
    console.log('  Testing 19. Product-specific relevance: Google Ads vs website repair...');
    const prodBugFix = productsLib.createProduct(db, {
      slug: 'website-speed-fix',
      name: 'Website Speed & Bug Fix Service',
      description: 'Fix broken pages, database errors, and optimize WordPress/HTML website speed for businesses',
      topic: 'website maintenance',
      target_org: 'local businesses',
      target_keywords: ['local business', 'website repair', 'speed optimization', 'bug fix'],
      active: false
    });

    const sigGoogleAds = demand.insertSignal(db, {
      source: 'social',
      source_id: 'sig-ads-19',
      raw_text: 'Looking for Google Ads management for my local business. Need PPC search campaign setup.',
      entity_name: 'Metro Dental Clinic',
      location_hint: 'Chennai'
    });

    const relAdsRepair = await relevanceLib.evaluateRelevance(db, prodBugFix, sigGoogleAds.signal);
    assert.strictEqual(relAdsRepair.relevant, false, 'Google Ads demand must NOT be relevant for website speed & bug fix product');
    assert(relAdsRepair.confidence <= 0.30, `Confidence must be <= 0.30 (got ${relAdsRepair.confidence})`);
    assert(relAdsRepair.stage2.reason.includes('Capability mismatch') || relAdsRepair.stage2.reason.includes('advertising') || relAdsRepair.stage2.reason.includes('PPC'), 'Reason must cite capability mismatch');
    console.log('    ok - Website speed & bug fix correctly rejected Google Ads demand (confidence <= 0.30)');

    // =========================================================================
    // Test 20: Product-Specific Relevance — Landing Page + WhatsApp Service
    // =========================================================================
    console.log('  Testing 20. Product-specific relevance: Landing page + WhatsApp service...');
    const prodLanding = productsLib.createProduct(db, {
      slug: 'landing-whatsapp-service',
      name: 'Landing Page + WhatsApp Service',
      description: 'High-converting landing page creation with direct WhatsApp enquiry integration for small businesses',
      topic: 'lead generation',
      target_org: 'business',
      target_keywords: ['landing page', 'whatsapp enquiries', 'lead funnel', 'whatsapp booking'],
      active: false
    });

    const sigLanding = demand.insertSignal(db, {
      source: 'social',
      source_id: 'sig-landing-20',
      raw_text: 'Need a landing page with WhatsApp enquiries for my coaching business.',
      entity_name: 'Alpha Coaching',
      location_hint: 'Chennai'
    });

    const relLanding = await relevanceLib.evaluateRelevance(db, prodLanding, sigLanding.signal);
    assert.strictEqual(relLanding.relevant, true, 'Landing page + WhatsApp demand MUST be relevant for landing page service');
    assert(relLanding.confidence >= 0.70, `Confidence must be strong (got ${relLanding.confidence})`);
    console.log('    ok - Landing page + WhatsApp service confirmed relevant with confidence:', relLanding.confidence);

    // =========================================================================
    // Test 21: Invariant — Generic Words Alone Cannot Establish Relevance
    // =========================================================================
    console.log('  Testing 21. Invariant: Generic words alone cannot establish relevance...');
    const prodGeneric = productsLib.createProduct(db, {
      slug: 'business-solutions-pro',
      name: 'Business Solutions Service',
      description: 'Providing business solutions, service management, and customer support for companies',
      topic: 'business services',
      target_org: 'company',
      target_keywords: ['business', 'service', 'solutions', 'customer support'],
      active: false
    });

    const sigGeneric = demand.insertSignal(db, {
      source: 'social',
      source_id: 'sig-generic-21',
      raw_text: 'Need a good business service solution for my customer company.',
      entity_name: 'Generic Corp',
      location_hint: 'Chennai'
    });

    const relGeneric = await relevanceLib.evaluateRelevance(db, prodGeneric, sigGeneric.signal);
    assert.strictEqual(relGeneric.relevant, false, 'Generic words alone must NEVER establish relevance');
    assert(relGeneric.confidence <= 0.30, `Confidence must be <= 0.30 (got ${relGeneric.confidence})`);
    assert(relGeneric.stage2.reason.includes('Generic words') || relGeneric.stage2.reason.includes('generic terms'), 'Reason must explicitly cite generic terms');
    console.log('    ok - Generic words correctly rejected with confidence <= 0.30');

    // =========================================================================
    // Test 22: Cache Invalidation on Product Definition Changes
    // =========================================================================
    console.log('  Testing 22. Cache invalidation on product definition update...');
    // 1. Evaluate Product A (Math) + Signal X (sigAbacusApp)
    const initialEvalA = await relevanceLib.evaluateRelevance(db, prodMath, sigAbacusApp.signal);
    assert.strictEqual(initialEvalA.relevant, true);

    // 2. Verify cached
    const cachedEvalA = await relevanceLib.evaluateRelevance(db, prodMath, sigAbacusApp.signal);
    assert.strictEqual(cachedEvalA.cached, true, 'Must be cached on repeat call');

    // Also evaluate Product B (Yoga) + YogaSignal to establish cache for B
    const initialEvalB = await relevanceLib.evaluateRelevance(db, prodYoga, yogaSignal.signal);
    assert.strictEqual(initialEvalB.relevant, true);
    const cachedEvalB1 = await relevanceLib.evaluateRelevance(db, prodYoga, yogaSignal.signal);
    assert.strictEqual(cachedEvalB1.cached, true, 'Product B must be cached');

    // 3. Update Product A definition (change description & keywords to completely different domain)
    productsLib.updateProduct(db, prodMath.id, {
      description: 'Exclusive robotics and artificial intelligence hardware lab for high schools',
      topic: 'robotics hardware',
      target_keywords: ['robotics', 'ai hardware', 'arduino']
    });

    // Fetch refreshed prodMath
    const updatedProdMath = productsLib.getProductById(db, prodMath.id);

    // 4. Evaluate Product A again
    const postUpdateEvalA = await relevanceLib.evaluateRelevance(db, updatedProdMath, sigAbacusApp.signal);
    assert.strictEqual(postUpdateEvalA.cached, false, 'Product A old cache MUST NOT be returned after product definition update');
    assert.strictEqual(postUpdateEvalA.relevant, false, 'Updated Product A (robotics) is no longer relevant for abacus signal');

    // 5. Verify Product B cache is completely untouched
    const cachedEvalB2 = await relevanceLib.evaluateRelevance(db, prodYoga, yogaSignal.signal);
    assert.strictEqual(cachedEvalB2.cached, true, 'Product B cache must remain intact and cached');
    assert.strictEqual(cachedEvalB2.relevant, true, 'Product B result must remain untouched');
    console.log('    ok - Product A cache invalidated on update while Product B cache remained intact');

    // =========================================================================
    // Test 23: API-Level Route Tests (No Relevance Bypass Fallback)
    // =========================================================================
    console.log('  Testing 23. API-level enforcement: No relevance bypass...');
    const { createApp } = require('../server');
    const http = require('http');

    const app = createApp({ dbFile: testDbFile, pin: '', allowedHosts: 'localhost' });
    const serverPort = await new Promise((resolve) => {
      app.server.listen(0, '127.0.0.1', () => resolve(app.server.address().port));
    });

    const apiCall = (p, method = 'GET', body = null) => new Promise((resolve, reject) => {
      const r = http.request({
        host: '127.0.0.1',
        port: serverPort,
        path: p,
        method,
        headers: {
          'Host': 'localhost',
          ...(body ? { 'Content-Type': 'application/json' } : {})
        }
      }, (res) => {
        let t = '';
        res.on('data', (c) => (t += c));
        res.on('end', () => {
          let j;
          try { j = JSON.parse(t); } catch { j = t; }
          resolve({ status: res.statusCode, body: j });
        });
      });
      r.on('error', reject);
      if (body) r.write(JSON.stringify(body));
      r.end();
    });

    try {
      // Deactivate all products in a temporary scratch DB to test missing product error
      const noProdDbFile = path.join(tmpDir, `no-prod-${Date.now()}.db`);
      const noProdDb = db_.open(noProdDbFile, { autoMigrate: false });
      noProdDb.prepare('DELETE FROM products').run();
      const noProdApp = createApp({ db: noProdDb, pin: '', allowedHosts: 'localhost' });
      const noProdPort = await new Promise(res => noProdApp.server.listen(0, '127.0.0.1', () => res(noProdApp.server.address().port)));

      const missingProdCall = await new Promise((resolve, reject) => {
        const r = http.request({
          host: '127.0.0.1',
          port: noProdPort,
          path: '/api/demand/signals',
          method: 'POST',
          headers: { 'Host': 'localhost', 'Content-Type': 'application/json' }
        }, (res) => {
          let t = ''; res.on('data', c => t += c);
          res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(t) }); } catch { resolve({ status: res.statusCode, body: t }); } });
        });
        r.on('error', reject);
        r.write(JSON.stringify({ raw_text: 'Looking for coaching', entity_name: 'Alpha' }));
        r.end();
      });
      assert.strictEqual(missingProdCall.status, 400, 'Missing product must return HTTP 400');
      assert(missingProdCall.body.error.includes('Product is required'), 'Error must specify product required');
      noProdApp.server.close();
      noProdDb.close();
      for (const e of ['', '-wal', '-shm']) { try { fs.rmSync(noProdDbFile + e, { force: true }); } catch (_) {} }

      // Invalid product ID (999999) -> must return HTTP 404
      const invalidProdCall = await apiCall('/api/demand/signals', 'POST', {
        raw_text: 'Looking for coaching in Anna Nagar',
        entity_name: 'Alpha Abacus Academy',
        productId: 999999
      });
      assert.strictEqual(invalidProdCall.status, 404, 'Invalid productId must return HTTP 404');
      assert(invalidProdCall.body.error.includes('Product not found'), 'Error must specify product not found');

      // Unrelated signal -> 0 opportunities created
      const oppBefore = db.prepare('SELECT COUNT(*) n FROM lead_opportunities').get().n;
      const unrelatedApiCall = await apiCall('/api/demand/signals', 'POST', {
        raw_text: 'Where can I find bicycle repair mechanics in Chennai?',
        entity_name: 'Bike Shop',
        productId: prodYoga.id
      });
      assert.strictEqual(unrelatedApiCall.status, 200);
      assert.strictEqual(unrelatedApiCall.body.relevance.relevant, false, 'Unrelated signal must be marked not relevant');
      assert.strictEqual(unrelatedApiCall.body.opportunities.length, 0, 'ZERO opportunities must be created for unrelated signal');
      const oppAfter = db.prepare('SELECT COUNT(*) n FROM lead_opportunities').get().n;
      assert.strictEqual(oppAfter, oppBefore, 'Opportunity table count must not increase for unrelated signal');

      // Resolve endpoint with invalid product -> 404
      const resolveInvalid = await apiCall(`/api/demand/signals/${sig1.id}/resolve`, 'POST', { productId: 999999 });
      assert.strictEqual(resolveInvalid.status, 404, 'Resolve endpoint with invalid productId must return 404');
      console.log('    ok - API routes strictly reject missing/invalid products and block opportunities for non-relevant signals');
    } finally {
      app.server.close();
    }

    // =========================================================================
    // Test 24: Domain-Agnostic Relevance — Domain A: GST / Tax Filing
    // =========================================================================
    console.log('  Testing 24. Domain-agnostic relevance: GST / Tax Filing...');
    const prodGst = productsLib.createProduct(db, {
      slug: 'gst-tax-advisor',
      name: 'GST Filing & Tax Advisory',
      description: 'Monthly GST returns filing, input tax credit reconciliation, and tax compliance for small businesses',
      topic: 'tax filing',
      target_org: 'small business',
      target_keywords: ['gst return', 'tax filing', 'gst compliance', 'accounting'],
      active: false
    });

    const sigGstPos = demand.insertSignal(db, {
      source: 'social',
      source_id: 'sig-gst-pos-24',
      raw_text: 'Need someone to file GST returns for my small business.',
      entity_name: 'Metro Retailers',
      location_hint: 'Chennai'
    });

    const relGstPos = await relevanceLib.evaluateRelevance(db, prodGst, sigGstPos.signal);
    assert.strictEqual(relGstPos.relevant, true, 'GST returns filing demand MUST be relevant for GST filing product');
    assert(relGstPos.confidence >= 0.70, `Confidence must be >= 0.70 (got ${relGstPos.confidence})`);

    const sigGstNeg = demand.insertSignal(db, {
      source: 'social',
      source_id: 'sig-gst-neg-24',
      raw_text: 'Looking for a website designer for my business.',
      entity_name: 'Metro Retailers',
      location_hint: 'Chennai'
    });

    const relGstNeg = await relevanceLib.evaluateRelevance(db, prodGst, sigGstNeg.signal);
    assert.strictEqual(relGstNeg.relevant, false, 'Web designer demand must NOT be relevant for GST filing product');
    assert(relGstNeg.confidence <= 0.30, `Confidence must be <= 0.30 (got ${relGstNeg.confidence})`);
    console.log('    ok - GST filing correctly accepted GST demand (>= 0.70) and rejected web design demand (<= 0.30)');

    // =========================================================================
    // Test 25: Domain-Agnostic Relevance — Domain B: Home Appliance Repair
    // =========================================================================
    console.log('  Testing 25. Domain-agnostic relevance: Home Appliance Repair...');
    const prodAppliance = productsLib.createProduct(db, {
      slug: 'home-appliance-repair',
      name: 'Home Appliance Repair Service',
      description: 'Doorstep repair and maintenance for home air conditioners, refrigerators, and washing machines',
      topic: 'appliance repair',
      target_org: 'household',
      target_keywords: ['ac repair', 'appliance repair', 'cooling', 'technician'],
      active: false
    });

    const sigAcPos = demand.insertSignal(db, {
      source: 'social',
      source_id: 'sig-ac-pos-25',
      raw_text: 'My AC is not cooling. Need an AC technician.',
      entity_name: 'Home Owner',
      location_hint: 'Chennai'
    });

    const relAcPos = await relevanceLib.evaluateRelevance(db, prodAppliance, sigAcPos.signal);
    assert.strictEqual(relAcPos.relevant, true, 'AC cooling/technician demand MUST be relevant for appliance repair product');
    assert(relAcPos.confidence >= 0.70, `Confidence must be >= 0.70 (got ${relAcPos.confidence})`);

    const sigAcNeg = demand.insertSignal(db, {
      source: 'social',
      source_id: 'sig-ac-neg-25',
      raw_text: 'Looking for an SEO agency to improve Google rankings.',
      entity_name: 'Growth Agency',
      location_hint: 'Chennai'
    });

    const relAcNeg = await relevanceLib.evaluateRelevance(db, prodAppliance, sigAcNeg.signal);
    assert.strictEqual(relAcNeg.relevant, false, 'SEO agency demand must NOT be relevant for appliance repair product');
    assert(relAcNeg.confidence <= 0.30, `Confidence must be <= 0.30 (got ${relAcNeg.confidence})`);
    console.log('    ok - Appliance repair correctly accepted AC technician demand (>= 0.70) and rejected SEO demand (<= 0.30)');

    // =========================================================================
    // Test 26: Domain-Agnostic Relevance — Domain C: Wedding Photography
    // =========================================================================
    console.log('  Testing 26. Domain-agnostic relevance: Wedding Photography...');
    const prodWedding = productsLib.createProduct(db, {
      slug: 'moments-wedding-photo',
      name: 'Moments Wedding Photography',
      description: 'Candid wedding photography, pre-wedding shoots, and traditional marriage videography',
      topic: 'wedding photography',
      target_org: 'wedding couple',
      target_keywords: ['wedding photography', 'photographer', 'wedding photoshoot', 'videography'],
      active: false
    });

    const sigWeddingPos = demand.insertSignal(db, {
      source: 'social',
      source_id: 'sig-wed-pos-26',
      raw_text: 'Looking for a photographer for my wedding next month.',
      entity_name: 'Couple',
      location_hint: 'Chennai'
    });

    const relWeddingPos = await relevanceLib.evaluateRelevance(db, prodWedding, sigWeddingPos.signal);
    assert.strictEqual(relWeddingPos.relevant, true, 'Wedding photographer demand MUST be relevant for wedding photography product');
    assert(relWeddingPos.confidence >= 0.70, `Confidence must be >= 0.70 (got ${relWeddingPos.confidence})`);

    const sigWeddingNeg = demand.insertSignal(db, {
      source: 'social',
      source_id: 'sig-wed-neg-26',
      raw_text: 'Need a plumber to fix a bathroom leak.',
      entity_name: 'Tenant',
      location_hint: 'Chennai'
    });

    const relWeddingNeg = await relevanceLib.evaluateRelevance(db, prodWedding, sigWeddingNeg.signal);
    assert.strictEqual(relWeddingNeg.relevant, false, 'Plumbing demand must NOT be relevant for wedding photography product');
    assert(relWeddingNeg.confidence <= 0.30, `Confidence must be <= 0.30 (got ${relWeddingNeg.confidence})`);
    console.log('    ok - Wedding photography correctly accepted photographer demand (>= 0.70) and rejected plumber demand (<= 0.30)');

    console.log('\nAll 26 Phase 2 Product Relevance tests passed successfully!\n');
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
