'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const db_ = require('../lib/db');
const demand = require('../lib/demand');
const productsLib = require('../lib/products');
const relevanceLib = require('../lib/relevance');
const messages = require('../lib/messages');
const { normalizeMention } = require('../lib/normalization');
const { extractMentionEntities, isValidEntityCandidate, detectAdversarialDivergence } = require('../lib/extraction');
const { SourceAdapter, MockMentionAdapter, PublicMentionAdapter } = require('../lib/adapters');
const { ingestMention, ingestBatch } = require('../lib/ingestion');
const { createApp } = require('../server');

async function runDemandIngestionTestSuite() {
  console.log('\n=== Running Phase 3 Real Demand Discovery & Ingestion Test Suite ===');
  const tmpDir = path.join(__dirname, '..', 'data', 'test-scratch');
  fs.mkdirSync(tmpDir, { recursive: true });
  const testDbFile = path.join(tmpDir, `ingest-test-${Date.now()}.db`);

  let db;
  let testCount = 0;
  const pass = (desc) => {
    testCount++;
    console.log(`  ok ${testCount} - ${desc}`);
  };

  try {
    db = db_.open(testDbFile);

    // Setup active product (Product 1: Abacus Buddy AI)
    const activeProd = productsLib.getActiveProduct(db);
    productsLib.updateProduct(db, activeProd.id, {
      name: 'Abacus Buddy AI',
      topic: 'abacus',
      target_org: 'centre',
      link: 'https://abacus.example.com',
      offer: '2 free student accounts for your centre',
      target_keywords: ['abacus', 'abacus classes', 'vedic maths', 'mental arithmetic'],
      negative_keywords: ['college', 'adult', 'pizza', 'apk', 'website designer'],
      templates: { first_en: 'Hello from {product}!' }
    });

    // Setup test leads in database
    const now = Date.now();
    db.prepare(`
      INSERT INTO leads(id, name, address, area, city, phone, wa, phone_type, lat, lng, score, stage, created, updated)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(101, 'ABC Abacus Centre', '15 2nd Ave, Anna Nagar', 'Anna Nagar', 'Chennai', '+919840111111', '919840111111', 'mobile', 13.085, 80.21, 90, 'new', now, now);

    db.prepare(`
      INSERT INTO leads(id, name, address, area, city, phone, wa, phone_type, lat, lng, score, stage, created, updated)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(102, 'Chennai Pizza Corner', '22 Gandhi Rd, T Nagar', 'T Nagar', 'Chennai', '+919840222222', '919840222222', 'mobile', 13.04, 80.23, 70, 'new', now, now);

    // -------------------------------------------------------------------------
    // Test A: Positive Mention
    // "I need an abacus class for my 7 year old near Anna Nagar"
    // Expected: need detected, location extracted, entity remains empty, NOT matched to lead
    // -------------------------------------------------------------------------
    console.log('\n--- Test A: Positive Mention ---');
    const mentionA = {
      source: 'public_forum',
      source_id: 'post_a_001',
      source_url: 'https://forum.local/post/1',
      raw_text: 'I need an abacus class for my 7 year old near Anna Nagar'
    };
    const resA = await ingestMention(db, mentionA, { evaluateRelevance: true });
    assert.strictEqual(resA.inserted, true, 'Signal must be inserted into demand_signals');
    assert.strictEqual(resA.duplicate, false);
    assert.strictEqual(resA.extraction.entity_name, '', 'Entity name must be empty');
    assert.strictEqual(resA.extraction.location_hint, 'Anna Nagar', 'Location must be Anna Nagar');
    assert.ok(resA.extraction.detected_need.includes('abacus class'), 'Detected need must capture abacus class');
    assert.strictEqual(resA.extraction.evidence.entity_found, false, 'entity_found must be false');
    assert.strictEqual(resA.opportunities.length, 0, 'Must NOT automatically create a lead opportunity when no entity named');
    pass('A. Positive mention: Need and location extracted, entity empty, no fake business match');

    // -------------------------------------------------------------------------
    // Test B: Explicit Business
    // "Does ABC Abacus Centre in Anna Nagar offer weekend classes?"
    // Expected: entity = ABC Abacus Centre, location = Anna Nagar, buying/inquiry intent
    // -------------------------------------------------------------------------
    console.log('\n--- Test B: Explicit Business ---');
    const mentionB = {
      source: 'local_board',
      source_id: 'post_b_002',
      source_url: 'https://board.local/post/2',
      raw_text: 'Does ABC Abacus Centre in Anna Nagar offer weekend classes?'
    };
    const resB = await ingestMention(db, mentionB, { evaluateRelevance: true });
    assert.strictEqual(resB.inserted, true);
    assert.strictEqual(resB.extraction.entity_name, 'ABC Abacus Centre', 'Must extract ABC Abacus Centre');
    assert.strictEqual(resB.extraction.location_hint, 'Anna Nagar', 'Must extract Anna Nagar');
    assert.strictEqual(resB.extraction.evidence.entity_found, true, 'entity_found must be true');
    assert.strictEqual(resB.extraction.intent_class, 'buying_intent', 'Intent must be buying_intent');
    assert.ok(resB.extraction.detected_need.includes('weekend classes'), 'Need must identify weekend classes');
    assert.strictEqual(resB.opportunities.length, 1, 'Must create opportunity for matching lead ABC Abacus Centre');
    assert.strictEqual(resB.opportunities[0].lead_id, 101);
    assert.strictEqual(resB.opportunities[0].status, 'unreviewed');
    pass('B. Explicit business: Structured signal created with entity, location, and unreviewed opportunity');

    // -------------------------------------------------------------------------
    // Test C: Ambiguous Generic Mention
    // "Looking for a good abacus centre"
    // Expected: demand classified, entity_name empty, no fake business match
    // -------------------------------------------------------------------------
    console.log('\n--- Test C: Ambiguous Generic Mention ---');
    const mentionC = {
      source: 'social_web',
      source_id: 'post_c_003',
      raw_text: 'Looking for a good abacus centre'
    };
    const resC = await ingestMention(db, mentionC, { evaluateRelevance: true });
    assert.strictEqual(resC.inserted, true);
    assert.strictEqual(resC.extraction.entity_name, '', 'Generic descriptor must not become an entity name');
    assert.strictEqual(resC.extraction.evidence.entity_found, false);
    assert.strictEqual(resC.opportunities.length, 0, 'No opportunity without a named business');
    pass('C. Ambiguous mention: Generic descriptor rejected, entity empty, no hallucinated business');

    // -------------------------------------------------------------------------
    // Test D: Noisy / Adversarial Multi-Clause
    // "ABC Abacus Centre is terrible, I need a website designer"
    // Expected: extraction must not turn ABC into a valid Abacus opportunity for the wrong need
    // -------------------------------------------------------------------------
    console.log('\n--- Test D: Noisy/Adversarial Multi-Clause ---');
    const mentionD = {
      source: 'review_feed',
      source_id: 'post_d_004',
      raw_text: 'ABC Abacus Centre is terrible, I need a website designer'
    };
    const resD = await ingestMention(db, mentionD, { evaluateRelevance: true });
    assert.strictEqual(resD.inserted, true);
    assert.strictEqual(resD.extraction.entity_name, '', 'Entity in complaint clause must not bind to buying intent');
    assert.ok(resD.extraction.evidence.adversarial_flags.includes('complaint_need_divergence'), 'Must flag complaint_need_divergence');
    assert.ok(resD.extraction.detected_need.includes('website designer'), 'Detected need must reflect requested need');
    assert.strictEqual(resD.opportunities.length, 0, 'Must not create opportunity for ABC on wrong need');
    pass('D. Noisy/adversarial: Complaint-need divergence caught, entity unbound, zero false opportunities');

    // -------------------------------------------------------------------------
    // Test E: Unrelated Demand
    // "Best Italian pizza in Chennai?"
    // Expected: no Abacus-specific demand signal / opportunity
    // -------------------------------------------------------------------------
    console.log('\n--- Test E: Unrelated Demand ---');
    const mentionE = {
      source: 'food_forum',
      source_id: 'post_e_005',
      raw_text: 'Best Italian pizza in Chennai?'
    };
    const resE = await ingestMention(db, mentionE, { evaluateRelevance: true });
    assert.strictEqual(resE.inserted, true);
    assert.strictEqual(resE.extraction.entity_name, '');
    assert.strictEqual(resE.extraction.location_hint, 'Chennai');
    assert.ok(resE.relevance !== null, 'Relevance must be evaluated');
    assert.strictEqual(resE.relevance.relevant, false, 'Must be marked NOT relevant to Abacus product');
    assert.strictEqual(resE.opportunities.length, 0, 'Zero opportunities for unrelated domain');
    pass('E. Unrelated demand: Correctly rejected by product relevance engine, zero opportunities');

    // -------------------------------------------------------------------------
    // Test F: Entity Hallucination Defense
    // "Someone mentioned an abacus class but didn't name it"
    // Expected: entity_name remains empty
    // -------------------------------------------------------------------------
    console.log('\n--- Test F: Entity Hallucination Defense ---');
    const mentionF = {
      source: 'web_snippet',
      source_id: 'post_f_006',
      raw_text: "Someone mentioned an abacus class but didn't name it"
    };
    const resF = await ingestMention(db, mentionF);
    assert.strictEqual(resF.extraction.entity_name, '', 'Pronoun or vague mention must never become an entity');
    assert.strictEqual(resF.extraction.evidence.entity_found, false);
    pass('F. Entity hallucination defense: Generic words and pronouns strictly rejected');

    // -------------------------------------------------------------------------
    // Test G: Deduplication
    // same source/source_id/raw content twice
    // Expected: first is inserted, second is duplicate, count in DB is 1
    // -------------------------------------------------------------------------
    console.log('\n--- Test G: Deduplication ---');
    const mentionG = {
      source: 'twitter_mock',
      source_id: 'tweet_12345',
      source_url: 'https://mock.social/post/12345',
      raw_text: 'Need an abacus tutor for weekend lessons in Anna Nagar'
    };
    const firstG = await ingestMention(db, mentionG);
    assert.strictEqual(firstG.inserted, true);
    assert.strictEqual(firstG.duplicate, false);

    const secondG = await ingestMention(db, mentionG);
    assert.strictEqual(secondG.inserted, false, 'Second mention must not be inserted');
    assert.strictEqual(secondG.duplicate, true, 'Second mention must be marked duplicate');
    assert.strictEqual(secondG.signal_id, firstG.signal_id, 'Duplicate must report original signal_id');

    const countG = db.prepare('SELECT COUNT(*) n FROM demand_signals WHERE source=? AND source_id=?').get('twitter_mock', 'tweet_12345').n;
    assert.strictEqual(countG, 1, 'Only one row must exist in demand_signals for this source_id');
    pass('G. Deduplication: Identical mention deduplicated via content_hash, database has exactly 1 row');

    // -------------------------------------------------------------------------
    // Test H: Source Isolation
    // Same text from two different source IDs
    // Expected: both accepted according to content_hash semantics
    // -------------------------------------------------------------------------
    console.log('\n--- Test H: Source Isolation ---');
    const textH = 'Looking for mental arithmetic tuition in Adyar';
    const mentionH1 = { source: 'forum_a', source_id: 'post_100', raw_text: textH };
    const mentionH2 = { source: 'forum_a', source_id: 'post_200', raw_text: textH };

    const resH1 = await ingestMention(db, mentionH1);
    const resH2 = await ingestMention(db, mentionH2);

    assert.strictEqual(resH1.inserted, true);
    assert.strictEqual(resH2.inserted, true, 'Different source_ids must produce separate provenance signals');
    assert.notStrictEqual(resH1.signal_id, resH2.signal_id);
    pass('H. Source isolation: Distinct source IDs maintain provenance and unique content hashes');

    // -------------------------------------------------------------------------
    // Test I: Product Neutrality
    // Verify an unrelated product (Website-to-APK service) works without any Abacus logic
    // -------------------------------------------------------------------------
    console.log('\n--- Test I: Product Neutrality ---');
    const apkProd = productsLib.createProduct(db, {
      slug: 'web-to-apk-service',
      name: 'Web2APK Studio',
      description: 'Convert existing web applications and progressive web apps into native Android APK packages',
      topic: 'apk converter',
      target_org: 'developers',
      offer: 'Turn your website into a production-ready Android app in 24 hours',
      target_keywords: ['apk converter', 'convert website to app', 'pwa to apk', 'android app conversion'],
      negative_keywords: ['abacus', 'classes', 'restaurant', 'tutor'],
      active: false
    });

    // Ingest APK demand
    const apkMention = {
      source: 'dev_community',
      source_id: 'dev_post_999',
      raw_text: 'Looking for a reliable apk converter to convert website to app for my client'
    };
    const apkRes = await ingestMention(db, apkMention, { productId: apkProd.id, evaluateRelevance: true });
    assert.strictEqual(apkRes.inserted, true);
    assert.ok(apkRes.relevance !== null);
    assert.strictEqual(apkRes.relevance.relevant, true, 'APK product must be relevant to APK conversion demand');
    assert.ok(apkRes.relevance.confidence >= 0.70);

    // Ingest Abacus demand against APK product: must be rejected
    const abacusForApk = {
      source: 'parents_board',
      source_id: 'parent_post_111',
      raw_text: 'Need an abacus class for my kid'
    };
    const abacusForApkRes = await ingestMention(db, abacusForApk, { productId: apkProd.id, evaluateRelevance: true });
    assert.strictEqual(abacusForApkRes.relevance.relevant, false, 'APK product must reject abacus demand');
    pass('I. Product neutrality: Ingestion foundation is domain-agnostic and evaluates arbitrary products');

    // -------------------------------------------------------------------------
    // Test J: Human Confirmation Gate
    // Ingested demand resulting in opportunity must have status 'unreviewed' and block outreach
    // -------------------------------------------------------------------------
    console.log('\n--- Test J: Human Confirmation Gate ---');
    const opp = resB.opportunities[0];
    assert.ok(opp, 'ResB must have an opportunity');
    assert.strictEqual(opp.status, 'unreviewed');

    // Verify messages.action blocks unreviewed opportunity
    const oppRow = demand.getOpportunity(db, opp.id);
    const settings = {
      product: 'Abacus Buddy AI',
      sender: 'Tester',
      offer: 'Free trial',
      templates: { first_en: 'Hello {name} from {product}!' }
    };
    const leadRow = db.prepare('SELECT * FROM leads WHERE id=?').get(opp.lead_id);
    const actionResult = messages.action(leadRow, settings, 'first', oppRow);
    assert.ok(actionResult.blocked, 'Outreach must be strictly blocked on unreviewed opportunity');
    assert.strictEqual(actionResult.reason, 'awaiting human confirmation');

    // Confirm opportunity via human gate
    const confirmed = demand.confirmOpportunity(db, opp.id, 'auditor@example.com');
    assert.strictEqual(confirmed.status, 'human_confirmed');

    // Verify outreach unblocks after human confirmation
    const confirmedOppRow = demand.getOpportunity(db, opp.id);
    const actionAfterConfirm = messages.action(leadRow, settings, 'first', confirmedOppRow);
    assert.strictEqual(actionAfterConfirm.blocked, undefined, 'Outreach must be unblocked after human confirmation');
    assert.ok(actionAfterConfirm.text.includes('Hello'), 'Message must render properly');
    pass('J. Human confirmation gate: Unreviewed opportunities strictly block outreach until confirmed');

    // -------------------------------------------------------------------------
    // Test K: Privacy & PII Redaction
    // -------------------------------------------------------------------------
    console.log('\n--- Test K: Privacy & PII Redaction ---');
    const piiMention = {
      source: 'web_comment',
      author: 'John Doe <john.doe@example.com> +91 98401 23456',
      raw_text: 'Does ABC Abacus Centre offer weekend batches?',
      metadata: {
        token: 'super_secret_auth_token',
        password: 'password123',
        safe_key: 'public_value'
      }
    };
    const normPii = normalizeMention(piiMention);
    assert.strictEqual(normPii.author.includes('john.doe@example.com'), false, 'Email must be redacted from author');
    assert.strictEqual(normPii.author.includes('98401 23456'), false, 'Phone must be redacted from author');
    assert.strictEqual(normPii.metadata.token, undefined, 'Sensitive token must be removed from metadata');
    assert.strictEqual(normPii.metadata.password, undefined, 'Sensitive password must be removed from metadata');
    assert.strictEqual(normPii.metadata.safe_key, 'public_value', 'Non-sensitive metadata preserved');
    pass('K. Privacy & PII: Email, phone, and credentials sanitized from author and metadata');

    // -------------------------------------------------------------------------
    // Test L: Source Adapters & Mock Mention Adapter
    // -------------------------------------------------------------------------
    console.log('\n--- Test L: Source Adapters & Mock Adapter ---');
    const adapter = new MockMentionAdapter('mock_reddit');
    assert.strictEqual(adapter.name, 'mock_reddit');

    adapter.seed([
      { id: 'sub_1', text: 'Looking for an abacus class in Anna Nagar', user: 'parent_99' },
      { id: 'sub_2', text: 'Does ABC Abacus Centre offer demo classes?', user: 'inquirer_88' }
    ]);

    const fetched = await adapter.fetch('abacus');
    assert.strictEqual(fetched.length, 2);
    assert.strictEqual(fetched[0].source, 'mock_reddit');
    assert.strictEqual(fetched[0].source_id, 'sub_1');

    // Verify base class error throwing
    const baseAdapter = new SourceAdapter('generic');
    assert.throws(() => baseAdapter.normalize({}), /normalize\(\) must be implemented/);
    await assert.rejects(async () => await baseAdapter.fetch('q'), /Live crawling is not implemented/);
    pass('L. Source adapters: Base contract enforced and MockMentionAdapter seeds/fetches normalized mentions');

    // -------------------------------------------------------------------------
    // Test M: Batch Ingestion
    // -------------------------------------------------------------------------
    console.log('\n--- Test M: Batch Ingestion ---');
    const batch = [
      { source: 'batch_source', source_id: 'b_1', raw_text: 'Need an abacus class in Anna Nagar' },
      { source: 'batch_source', source_id: 'b_2', raw_text: 'Does ABC Abacus Centre offer classes?' },
      { source: 'batch_source', source_id: 'b_1', raw_text: 'Need an abacus class in Anna Nagar' } // duplicate
    ];
    const batchRes = await ingestBatch(db, batch, { evaluateRelevance: true });
    assert.strictEqual(batchRes.total, 3);
    assert.strictEqual(batchRes.inserted, 2);
    assert.strictEqual(batchRes.duplicates, 1);
    assert.strictEqual(batchRes.rejected, 0);
    pass('M. Batch ingestion: Correctly tallies inserted, duplicate, and created opportunity counts');

    // -------------------------------------------------------------------------
    // Test N: API Endpoint POST /api/demand/ingest End-to-End
    // -------------------------------------------------------------------------
    console.log('\n--- Test N: API Endpoint POST /api/demand/ingest ---');
    const srv = createApp({ db, pin: '1015' });
    await new Promise(r => srv.server.listen(0, '127.0.0.1', r));
    const port = srv.server.address().port;

    try {
      // 1. Unauthenticated request -> 401
      const unauthRes = await makeRequest(port, 'POST', '/api/demand/ingest', { raw_text: 'Hello test' });
      assert.strictEqual(unauthRes.status, 401, 'Unauthenticated request must return 401');

      // 2. Authenticate
      const loginRes = await makeRequest(port, 'POST', '/api/login', { pin: '1015' });
      assert.strictEqual(loginRes.status, 200);
      const cookie = loginRes.headers['set-cookie'] ? loginRes.headers['set-cookie'][0].split(';')[0] : '';

      // 3. Ingest single mention via API
      const apiMentionRes = await makeRequest(port, 'POST', '/api/demand/ingest', {
        source: 'api_test',
        source_id: 'api_001',
        raw_text: 'Does ABC Abacus Centre offer weekend sessions?'
      }, cookie);
      assert.strictEqual(apiMentionRes.status, 200);
      const apiData = JSON.parse(apiMentionRes.body);
      assert.strictEqual(apiData.inserted, true);
      assert.strictEqual(apiData.extraction.entity_name, 'ABC Abacus Centre');

      // 4. Ingest batch via API
      const apiBatchRes = await makeRequest(port, 'POST', '/api/demand/ingest', {
        mentions: [
          { source: 'api_batch', source_id: 'ab_1', raw_text: 'Looking for abacus tutor in Anna Nagar' }
        ]
      }, cookie);
      assert.strictEqual(apiBatchRes.status, 200);
      const apiBatchData = JSON.parse(apiBatchRes.body);
      assert.strictEqual(apiBatchData.inserted, 1);

      // 5. Ingest invalid empty raw_text -> 400
      const apiInvalidRes = await makeRequest(port, 'POST', '/api/demand/ingest', {
        source: 'api_test',
        raw_text: ''
      }, cookie);
      assert.strictEqual(apiInvalidRes.status, 400, 'Empty raw text must return 400');
    } finally {
      srv.server.close();
    }
    pass('N. API endpoint: POST /api/demand/ingest tested end-to-end for auth, single, batch, and validation');

    console.log(`\nAll ${testCount} Phase 3 Demand Ingestion tests passed successfully!\n`);
  } finally {
    if (db) {
      try { db.close(); } catch (_) {}
    }
    try {
      if (fs.existsSync(testDbFile)) fs.unlinkSync(testDbFile);
      const wal = testDbFile + '-wal';
      const shm = testDbFile + '-shm';
      if (fs.existsSync(wal)) fs.unlinkSync(wal);
      if (fs.existsSync(shm)) fs.unlinkSync(shm);
    } catch (_) {}
  }
}

function makeRequest(port, method, path, body, cookie = '') {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        'Host': '127.0.0.1',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...(cookie ? { 'Cookie': cookie } : {})
      }
    }, res => {
      let b = '';
      res.on('data', chunk => (b += chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

if (require.main === module) {
  runDemandIngestionTestSuite().catch(err => {
    console.error('Test suite failed:', err);
    process.exit(1);
  });
}

module.exports = { runDemandIngestionTestSuite };
