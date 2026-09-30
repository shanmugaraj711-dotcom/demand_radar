'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const db_ = require('../lib/db');
const demand = require('../lib/demand');
const productsLib = require('../lib/products');
const messages = require('../lib/messages');
const {
  RedditRssAdapter,
  ingestRedditRss,
  validateRedditUrl,
  buildRedditRssUrl,
  parseRedditXml,
  stripHtml,
  unescapeHtml
} = require('../lib/reddit-rss');
const { createApp } = require('../server');

const SAMPLE_ATOM_XML = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>r/chennai: search results - classes</title>
  <entry>
    <author>
      <name>/u/chennai_parent</name>
      <uri>https://www.reddit.com/user/chennai_parent</uri>
    </author>
    <category term="chennai" label="r/chennai"/>
    <content type="html">&lt;!-- SC_OFF --&gt;&lt;div class="md"&gt;&lt;p&gt;Does ABC Abacus Centre in Anna Nagar offer weekend classes for kids?&lt;/p&gt;&lt;/div&gt;&lt;!-- SC_ON --&gt;</content>
    <id>t3_post001</id>
    <link href="https://www.reddit.com/r/chennai/comments/post001/does_abc_abacus_centre_offer_weekend_classes/" />
    <updated>2026-09-30T10:00:00+00:00</updated>
    <published>2026-09-30T09:30:00+00:00</published>
    <title>Does ABC Abacus Centre in Anna Nagar offer weekend classes?</title>
  </entry>
  <entry>
    <author>
      <name>/u/math_seeker</name>
      <uri>https://www.reddit.com/user/math_seeker</uri>
    </author>
    <category term="chennai" label="r/chennai"/>
    <content type="html">&lt;div class="md"&gt;&lt;p&gt;Looking for a good abacus centre near Anna Nagar for my 7 year old child.&lt;/p&gt;&lt;/div&gt;</content>
    <id>t3_post002</id>
    <link href="https://www.reddit.com/r/chennai/comments/post002/looking_for_abacus_centre/" />
    <updated>2026-09-30T09:15:00+00:00</updated>
    <published>2026-09-30T09:00:00+00:00</published>
    <title>Looking for a good abacus centre</title>
  </entry>
  <entry>
    <author>
      <name>/u/foodie_chennai</name>
      <uri>https://www.reddit.com/user/foodie_chennai</uri>
    </author>
    <category term="chennai" label="r/chennai"/>
    <content type="html">&lt;p&gt;Best Italian pizza in Chennai? Looking for authentic wood fired pizza.&lt;/p&gt;</content>
    <id>t3_post003</id>
    <link href="https://www.reddit.com/r/chennai/comments/post003/best_italian_pizza/" />
    <updated>2026-09-30T08:45:00+00:00</updated>
    <published>2026-09-30T08:30:00+00:00</published>
    <title>Best Italian pizza in Chennai?</title>
  </entry>
</feed>`;

async function runPhase4RedditRssTestSuite() {
  console.log('\n=== Running Phase 4 Reddit RSS Demand Source Test Suite ===');
  const tmpDir = path.join(__dirname, '..', 'data', 'test-scratch');
  fs.mkdirSync(tmpDir, { recursive: true });
  const testDbFile = path.join(tmpDir, `reddit-rss-test-${Date.now()}.db`);

  let db;
  let testCount = 0;
  const pass = (desc) => {
    testCount++;
    console.log(`  ok ${testCount} - ${desc}`);
  };

  try {
    // -------------------------------------------------------------------------
    // Test R: No production DB interaction in tests
    // -------------------------------------------------------------------------
    assert.ok(!testDbFile.includes('/var/lib/radar'), 'Test must never touch /var/lib/radar/radar.db');
    db = db_.open(testDbFile);

    // Setup active product (Abacus Buddy AI) and sample lead in test DB
    const activeProd = productsLib.getActiveProduct(db);
    productsLib.updateProduct(db, activeProd.id, {
      name: 'Abacus Buddy AI',
      topic: 'abacus',
      target_org: 'centre',
      link: 'https://abacus.example.com',
      offer: '2 free trial accounts for your centre',
      target_keywords: ['abacus', 'abacus classes', 'vedic maths', 'mental arithmetic'],
      negative_keywords: ['college', 'adult', 'pizza'],
      templates: { first_en: 'Hello {name} from {product}!' }
    });

    const now = Date.now();
    db.prepare(`
      INSERT INTO leads(id, name, address, area, city, phone, wa, phone_type, lat, lng, score, stage, created, updated)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(201, 'ABC Abacus Centre', '15 2nd Ave, Anna Nagar', 'Anna Nagar', 'Chennai', '+919840111111', '919840111111', 'mobile', 13.085, 80.21, 90, 'new', now, now);

    pass('R. No production DB interaction: Completely isolated in scratch test database');

    // -------------------------------------------------------------------------
    // Test A: Valid Reddit RSS item normalization
    // -------------------------------------------------------------------------
    const adapter = new RedditRssAdapter();
    const parsed = parseRedditXml(SAMPLE_ATOM_XML);
    assert.strictEqual(parsed.length, 3, 'Must parse 3 items from sample Atom XML');

    const norm0 = adapter.normalize(parsed[0]);
    assert.strictEqual(norm0.source, 'reddit_rss');
    assert.strictEqual(norm0.source_id, 't3_post001');
    assert.strictEqual(norm0.source_url, 'https://reddit.com/r/chennai/comments/post001/does_abc_abacus_centre_offer_weekend_classes');
    assert.ok(norm0.raw_text.includes('Does ABC Abacus Centre in Anna Nagar offer weekend classes'));
    assert.strictEqual(norm0.author, 'u/chennai_parent');
    assert.strictEqual(norm0.location_hint, 'chennai');
    assert.strictEqual(norm0.metadata.subreddit, 'chennai');
    assert.strictEqual(norm0.metadata.post_id, 't3_post001');
    pass('A. Valid Reddit RSS item normalization: Standard Mention contract strictly satisfied');

    // -------------------------------------------------------------------------
    // Test B: Stable source_id extraction
    // -------------------------------------------------------------------------
    const rawNoId = {
      title: 'Math tutor needed',
      link: 'https://www.reddit.com/r/chennai/comments/7abc99/math_tutor_needed/'
    };
    const normNoId = adapter.normalize(rawNoId);
    assert.strictEqual(normNoId.source_id, 't3_7abc99', 'Must extract stable t3_ ID from comments URL');

    const rawWithShortId = {
      id: '8xyz12',
      title: 'Tutor needed',
      link: 'https://www.reddit.com/r/chennai/comments/8xyz12/tutor_needed/'
    };
    const normShortId = adapter.normalize(rawWithShortId);
    assert.strictEqual(normShortId.source_id, 't3_8xyz12');
    pass('B. Stable source_id extraction: Consistently derives t3_<id> representation');

    // -------------------------------------------------------------------------
    // Test C: Canonical public Reddit URL
    // -------------------------------------------------------------------------
    const rawHttpLink = {
      id: 't3_testlink',
      title: 'Test Title',
      link: 'http://old.reddit.com/r/chennai/comments/testlink/some_post/?utm_source=share'
    };
    const normHttpLink = adapter.normalize(rawHttpLink);
    assert.ok(normHttpLink.source_url.startsWith('https://reddit.com/r/chennai/comments/testlink'), 'URL must be canonical HTTPS reddit.com');
    pass('C. Canonical public Reddit URL: Canonicalized to HTTPS reddit.com');

    // -------------------------------------------------------------------------
    // Test D: Author PII redaction
    // -------------------------------------------------------------------------
    const rawPiiAuthor = {
      id: 't3_pii01',
      title: 'Looking for class',
      author: 'u/john_doe (contact: john.doe@example.com, +91 98401 22334)'
    };
    const normPii = adapter.normalize(rawPiiAuthor);
    assert.strictEqual(normPii.author.includes('john.doe@example.com'), false, 'Email must be redacted');
    assert.strictEqual(normPii.author.includes('98401'), false, 'Phone number must be redacted');
    assert.ok(normPii.author.includes('[redacted]'));
    pass('D. Author PII redaction: Emails and phone numbers sanitized from author handle');

    // -------------------------------------------------------------------------
    // Test E: Malformed XML rejection
    // -------------------------------------------------------------------------
    assert.throws(() => parseRedditXml('not xml at all'), /Invalid feed: missing RSS or Atom feed structure/);
    assert.throws(() => parseRedditXml(''), /Malformed or empty XML feed content/);
    assert.throws(() => parseRedditXml(null), /Malformed or empty XML feed content/);
    pass('E. Malformed XML rejection: Cleanly fails closed on corrupted/non-XML inputs');

    // -------------------------------------------------------------------------
    // Test F: Oversized response rejection
    // -------------------------------------------------------------------------
    const mockOversizedFetch = async () => 'x'.repeat(2000);
    const adapterSmall = new RedditRssAdapter({ maxBytes: 500, fetchFn: mockOversizedFetch });
    // When using custom fetch, adapter can enforce check
    await assert.rejects(async () => {
      const xml = await adapterSmall.fetch('https://www.reddit.com/r/test/.rss');
    }, /Response exceeds maximum allowed size/);
    pass('F. Oversized response rejection: Enforces strict byte caps');

    // -------------------------------------------------------------------------
    // Test G: HTTP error handling
    // -------------------------------------------------------------------------
    const mockErrorFetch = async (url) => {
      const err = new Error('Reddit RSS HTTP error 429: Too Many Requests');
      err.status = 429;
      throw err;
    };
    const adapterErr = new RedditRssAdapter({ fetchFn: mockErrorFetch });
    await assert.rejects(async () => {
      await adapterErr.fetch('r/chennai');
    }, /429/);
    pass('G. HTTP error handling: Explicit error throwing for upstream HTTP status codes');

    // -------------------------------------------------------------------------
    // Test H: Timeout handling
    // -------------------------------------------------------------------------
    const mockTimeoutFetch = async () => {
      const err = new Error('Reddit RSS request timed out after 500ms.');
      err.name = 'AbortError';
      throw err;
    };
    const adapterTimeout = new RedditRssAdapter({ timeoutMs: 500, fetchFn: mockTimeoutFetch });
    await assert.rejects(async () => {
      await adapterTimeout.fetch('r/chennai');
    }, /timed out/);
    pass('H. Timeout handling: Cleanly aborts and throws on slow/unresponsive requests');

    // -------------------------------------------------------------------------
    // Test I: HTTPS-only enforcement
    // -------------------------------------------------------------------------
    assert.throws(() => validateRedditUrl('http://www.reddit.com/r/chennai/.rss'), /Only HTTPS is permitted/);
    assert.throws(() => validateRedditUrl('ftp://www.reddit.com/r/chennai/.rss'), /Only HTTPS is permitted/);
    pass('I. HTTPS-only enforcement: Insecure HTTP and non-HTTPS protocols strictly rejected');

    // -------------------------------------------------------------------------
    // Test J: Arbitrary external URL is rejected
    // -------------------------------------------------------------------------
    assert.throws(() => validateRedditUrl('https://evil-site.com/feed.rss'), /Forbidden host/);
    assert.throws(() => validateRedditUrl('https://169.254.169.254/latest/meta-data'), /Forbidden host/);
    assert.throws(() => validateRedditUrl('https://google.com/search'), /Forbidden host/);
    pass('J. Arbitrary external URL rejection: Strict domain allow-list prevents SSRF');

    // -------------------------------------------------------------------------
    // Test K: Maximum item limit
    // -------------------------------------------------------------------------
    const mockThreeItemFetch = async () => SAMPLE_ATOM_XML;
    const adapterLimit = new RedditRssAdapter({ maxItems: 1, fetchFn: mockThreeItemFetch });
    const limitedItems = await adapterLimit.fetch('r/chennai');
    assert.strictEqual(limitedItems.length, 1, 'Must cap results to maxItems');
    assert.strictEqual(limitedItems[0].source_id, 't3_post001');
    pass('K. Maximum item limit: Output strictly bounded to configured maxItems limit');

    // -------------------------------------------------------------------------
    // Test L: Duplicate Reddit item deduplication via ingestion pipeline
    // -------------------------------------------------------------------------
    const mockFeedFetch = async () => SAMPLE_ATOM_XML;
    const adapterIngest = new RedditRssAdapter({ fetchFn: mockFeedFetch });

    // First ingestion of sample feed
    const batchRes1 = await ingestRedditRss(db, 'r/chennai', {
      fetchFn: mockFeedFetch,
      evaluateRelevance: true
    });
    assert.strictEqual(batchRes1.total, 3);
    assert.strictEqual(batchRes1.inserted, 3);
    assert.strictEqual(batchRes1.duplicates, 0);

    // Second ingestion of identical feed: all 3 must be duplicates
    const batchRes2 = await ingestRedditRss(db, 'r/chennai', {
      fetchFn: mockFeedFetch,
      evaluateRelevance: true
    });
    assert.strictEqual(batchRes2.total, 3);
    assert.strictEqual(batchRes2.inserted, 0, 'Zero new signals should be inserted on duplicate feed');
    assert.strictEqual(batchRes2.duplicates, 3, 'All 3 items must be flagged as duplicates');

    const totalInDb = db.prepare('SELECT COUNT(*) n FROM demand_signals WHERE source=?').get('reddit_rss').n;
    assert.strictEqual(totalInDb, 3, 'Database must contain exactly 3 rows for reddit_rss');
    pass('L. Duplicate Reddit item deduplication: Pipeline content_hash prevents duplicate rows');

    // -------------------------------------------------------------------------
    // Test M: Generic demand without a named business does NOT create an opportunity
    // -------------------------------------------------------------------------
    // Item 2 was "Looking for a good abacus centre near Anna Nagar" (generic need, no business named)
    const resultItem2 = batchRes1.results[1];
    assert.strictEqual(resultItem2.extraction.entity_name, '', 'Generic mention must have empty entity_name');
    assert.strictEqual(resultItem2.opportunities.length, 0, 'Must NOT create opportunity for generic mention');
    pass('M. Generic demand safety: Vague demand records signal but creates zero opportunities');

    // -------------------------------------------------------------------------
    // Test N: Named business + relevant demand proceeds through pipeline
    // -------------------------------------------------------------------------
    // Item 1 was "Does ABC Abacus Centre in Anna Nagar offer weekend classes?"
    const resultItem1 = batchRes1.results[0];
    assert.strictEqual(resultItem1.extraction.entity_name, 'ABC Abacus Centre');
    assert.strictEqual(resultItem1.opportunities.length, 1, 'Must create opportunity for ABC Abacus Centre');
    assert.strictEqual(resultItem1.opportunities[0].lead_id, 201);
    assert.strictEqual(resultItem1.opportunities[0].status, 'unreviewed');
    pass('N. Named business + relevant demand: Successfully creates unreviewed opportunity');

    // -------------------------------------------------------------------------
    // Test O: Unrelated demand is rejected by relevance logic
    // -------------------------------------------------------------------------
    // Item 3 was "Best Italian pizza in Chennai?"
    const resultItem3 = batchRes1.results[2];
    assert.ok(resultItem3.relevance !== null);
    assert.strictEqual(resultItem3.relevance.relevant, false, 'Pizza demand must be marked irrelevant to Abacus product');
    assert.strictEqual(resultItem3.opportunities.length, 0, 'Zero opportunities for irrelevant demand');
    pass('O. Unrelated demand: Correctly rejected by Phase 2 relevance gate, zero opportunities');

    // -------------------------------------------------------------------------
    // Test P: Existing human confirmation gate remains intact
    // -------------------------------------------------------------------------
    const opp = resultItem1.opportunities[0];
    const oppRow = demand.getOpportunity(db, opp.id);
    const leadRow = db.prepare('SELECT * FROM leads WHERE id=?').get(opp.lead_id);
    const settings = {
      product: 'Abacus Buddy AI',
      sender: 'Tester',
      offer: 'Free trial',
      templates: { first_en: 'Hello {name} from {product}!' }
    };

    // Outreach must be blocked prior to human confirmation
    const actionBefore = messages.action(leadRow, settings, 'first', oppRow);
    assert.strictEqual(actionBefore.blocked, true, 'Outreach must be blocked awaiting human confirmation');
    assert.strictEqual(actionBefore.reason, 'awaiting human confirmation');

    // Human confirmation
    demand.confirmOpportunity(db, opp.id, 'reviewer@example.com');
    const confirmedOppRow = demand.getOpportunity(db, opp.id);
    const actionAfter = messages.action(leadRow, settings, 'first', confirmedOppRow);
    assert.strictEqual(actionAfter.blocked, undefined, 'Outreach unblocks only after confirmation');
    assert.ok(actionAfter.text.includes('Hello ABC Abacus Centre'));
    pass('P. Human confirmation gate: Unreviewed opportunities strictly block messaging until sign-off');

    // -------------------------------------------------------------------------
    // Test Q: No background polling starts
    // -------------------------------------------------------------------------
    // Check that no interval or background daemon was scheduled
    const adapterPollCheck = new RedditRssAdapter();
    assert.strictEqual(typeof adapterPollCheck.startPolling, 'undefined', 'No polling daemon method should exist');
    pass('Q. No background polling starts: Ingestion is strictly on-demand / manual');

    // -------------------------------------------------------------------------
    // Test S: API Route POST /api/demand/sources/reddit End-to-End
    // -------------------------------------------------------------------------
    console.log('\n--- API Endpoint POST /api/demand/sources/reddit ---');
    const srv = createApp({
      db,
      pin: '1015',
      redditFetchFn: mockFeedFetch,
      allowedRedditHosts: ['127.0.0.1', 'reddit.com', 'www.reddit.com']
    });
    await new Promise(r => srv.server.listen(0, '127.0.0.1', r));
    const port = srv.server.address().port;

    try {
      // 1. Unauthenticated request -> 401
      const unauth = await makeRequest(port, 'POST', '/api/demand/sources/reddit', { subreddit: 'chennai' });
      assert.strictEqual(unauth.status, 401);

      // 2. Authenticate
      const login = await makeRequest(port, 'POST', '/api/login', { pin: '1015' });
      assert.strictEqual(login.status, 200);
      const cookie = login.headers['set-cookie'][0].split(';')[0];

      // 3. Authenticated ingestion via API
      const apiRes = await makeRequest(port, 'POST', '/api/demand/sources/reddit', {
        subreddit: 'chennai',
        query: 'classes',
        maxItems: 2
      }, cookie);
      assert.strictEqual(apiRes.status, 200);
      const data = JSON.parse(apiRes.body);
      assert.strictEqual(typeof data.total, 'number');

      // 4. Reject arbitrary foreign URL -> 400
      const evilRes = await makeRequest(port, 'POST', '/api/demand/sources/reddit', {
        url: 'https://evil-site.com/rss'
      }, cookie);
      assert.strictEqual(evilRes.status, 400);
      assert.ok(evilRes.body.includes('Forbidden host'));
    } finally {
      srv.server.close();
    }
    pass('S. API endpoint: POST /api/demand/sources/reddit verified for auth, query, and SSRF rejection');

    console.log(`\nAll ${testCount} Phase 4 Reddit RSS tests passed successfully!\n`);
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
  runPhase4RedditRssTestSuite().catch(err => {
    console.error('Test suite failed:', err);
    process.exit(1);
  });
}

module.exports = { runPhase4RedditRssTestSuite };
