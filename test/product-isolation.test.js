'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const db_ = require('../lib/db');
const productsLib = require('../lib/products');
const demand = require('../lib/demand');
const messages = require('../lib/messages');
const settingsLib = require('../lib/settings');

function testProductIsolation() {
  const tmpDir = path.join(__dirname, '..', 'data', 'test-scratch');
  fs.mkdirSync(tmpDir, { recursive: true });
  const testDbFile = path.join(tmpDir, `product-isolation-${Date.now()}.db`);

  try {
    const db = db_.open(testDbFile);

    // 1. Initial State: Default Product Seeded
    const activeProd = productsLib.getActiveProduct(db);
    assert(activeProd, 'Active product must exist');
    assert.strictEqual(activeProd.slug, 'abacus-buddy');
    assert.strictEqual(activeProd.name, 'Abacus Buddy AI');
    assert.strictEqual(activeProd.topic, 'abacus');
    assert.strictEqual(activeProd.active, 1);

    // 2. Product CRUD Operations
    const prodB = productsLib.createProduct(db, {
      slug: 'salonflow',
      name: 'SalonFlow AI',
      description: 'Automated appointment scheduler for salons',
      topic: 'salon management',
      target_org: 'salon',
      link: 'https://salonflow.test',
      offer: '14-day free trial for your salon',
      target_keywords: ['salon', 'hair salon', 'beauty parlour', 'spa booking'],
      templates: {
        first_en: 'Hello {name} from {product}! Try our {topic} solution for your {org}: {link}'
      },
      active: false
    });
    assert(prodB.id > activeProd.id);
    assert.strictEqual(prodB.slug, 'salonflow');
    assert.strictEqual(prodB.active, 0);

    const prodC = productsLib.createProduct(db, {
      slug: 'yogagrow',
      name: 'YogaGrow AI',
      description: 'Member retention system for yoga studios',
      topic: 'yoga studio',
      target_org: 'studio',
      link: 'https://yogagrow.test',
      offer: 'Free member pass test',
      target_keywords: ['yoga', 'yoga classes', 'meditation'],
      active: false
    });
    assert(prodC.id > prodB.id);

    // List all vs activeOnly
    const allProds = productsLib.listProducts(db);
    assert.strictEqual(allProds.length, 3);
    const activeProds = productsLib.listProducts(db, { activeOnly: true });
    assert.strictEqual(activeProds.length, 1);
    assert.strictEqual(activeProds[0].id, activeProd.id);

    // Update Product B
    const updatedB = productsLib.updateProduct(db, prodB.id, {
      offer: '30-day extended free trial for premium salons'
    });
    assert.strictEqual(updatedB.offer, '30-day extended free trial for premium salons');

    // Switch Active Product to Product B
    const activatedB = productsLib.activateProduct(db, prodB.id);
    assert.strictEqual(activatedB.active, 1);
    const reloadedActive = productsLib.getActiveProduct(db);
    assert.strictEqual(reloadedActive.id, prodB.id);
    assert.strictEqual(reloadedActive.slug, 'salonflow');

    // Verify settings overlay picks up new active product
    const currentSettings = settingsLib.load(db);
    assert.strictEqual(currentSettings.product, 'SalonFlow AI');
    assert.strictEqual(currentSettings.topic, 'salon management');
    assert.strictEqual(currentSettings.org, 'salon');
    assert.strictEqual(currentSettings.link, 'https://salonflow.test');

    // Switch back to Product A
    productsLib.activateProduct(db, activeProd.id);
    const activeAfterSwitchBack = productsLib.getActiveProduct(db);
    assert.strictEqual(activeAfterSwitchBack.id, activeProd.id);

    // 3. Demand Signal Ingestion (100% Product-Neutral)
    db.prepare(`
      INSERT INTO leads(id, name, address, area, city, phone, wa, phone_type, score, stage)
      VALUES (101, 'Radiance Beauty & Wellness', '42 2nd Ave, Indiranagar', 'Indiranagar', 'Bengaluru', '9845011111', '919845011111', 'mobile', 88, 'new')
    `).run();

    const signalRes = demand.insertSignal(db, {
      source: 'social',
      source_id: 'sig-indiranagar-01',
      source_url: 'https://social.test/post/1001',
      raw_text: 'Looking for appointment booking at Radiance Beauty & Wellness in Indiranagar, their WhatsApp never replies!',
      entity_name: 'Radiance Beauty & Wellness',
      location_hint: 'Indiranagar',
      detected_need: 'no_whatsapp_booking',
      intent_class: 'operational_gap',
      confidence_score: 0.88,
      lat: 12.9716,
      lng: 77.5946
    });
    assert.strictEqual(signalRes.inserted, true);
    assert(signalRes.id > 0);

    // Verify signal record contains no product leakage
    const savedSignal = db.prepare('SELECT * FROM demand_signals WHERE id=?').get(signalRes.id);
    assert.strictEqual(savedSignal.detected_need, 'no_whatsapp_booking');
    assert.strictEqual(savedSignal.entity_name, 'Radiance Beauty & Wellness');
    assert(!('product_id' in savedSignal), 'demand_signals must remain product-neutral');

    // 4. Create Opportunities for Separate Products on Same Lead & Signal
    const oppAId = demand.createOpportunity(db, signalRes.id, {
      lead_id: 101,
      leadReason: 'operational gap: no whatsapp booking',
      confidence: 0.88,
      reasons: ['exact business name', 'location hint matches lead area'],
      signalSource: 'social',
      sourceUrl: 'https://social.test/post/1001',
      rawText: savedSignal.raw_text,
      product_id: activeProd.id
    });
    assert(oppAId > 0);

    const oppBId = demand.createOpportunity(db, signalRes.id, {
      lead_id: 101,
      leadReason: 'operational gap: no whatsapp booking',
      confidence: 0.88,
      reasons: ['exact business name', 'location hint matches lead area'],
      signalSource: 'social',
      sourceUrl: 'https://social.test/post/1001',
      rawText: savedSignal.raw_text,
      product_id: prodB.id
    });
    assert(oppBId > 0);
    assert.notStrictEqual(oppAId, oppBId, 'Distinct products must have distinct opportunity IDs');

    // 5. Query and Isolation by Product ID
    const oppA = demand.getOpportunity(db, oppAId);
    assert.strictEqual(oppA.product_id, activeProd.id);
    assert.strictEqual(oppA.product.name, 'Abacus Buddy AI');
    assert.strictEqual(oppA.status, 'unreviewed');

    const oppB = demand.getOpportunity(db, oppBId);
    assert.strictEqual(oppB.product_id, prodB.id);
    assert.strictEqual(oppB.product.name, 'SalonFlow AI');
    assert.strictEqual(oppB.status, 'unreviewed');

    // Verify opportunities filter query
    const rowsForProdA = db.prepare(demand.OPPORTUNITY_SELECT + ' WHERE o.product_id=?').all(activeProd.id);
    assert.strictEqual(rowsForProdA.length, 1);
    assert.strictEqual(rowsForProdA[0].id, oppAId);

    const rowsForProdB = db.prepare(demand.OPPORTUNITY_SELECT + ' WHERE o.product_id=?').all(prodB.id);
    assert.strictEqual(rowsForProdB.length, 1);
    assert.strictEqual(rowsForProdB[0].id, oppBId);

    // 6. Idempotent Opportunity Updates Per Product
    const updatedOppAId = demand.createOpportunity(db, signalRes.id, {
      lead_id: 101,
      leadReason: 'operational gap: no whatsapp booking (re-evaluated)',
      confidence: 0.92,
      reasons: ['exact business name', 'location hint matches lead area', 'high confidence'],
      signalSource: 'social',
      sourceUrl: 'https://social.test/post/1001',
      rawText: savedSignal.raw_text,
      product_id: activeProd.id
    });
    assert.strictEqual(updatedOppAId, oppAId, 'Calling createOpportunity again for same product must update existing record');
    const oppAFresh = demand.getOpportunity(db, oppAId);
    assert.strictEqual(oppAFresh.confidence, 0.92);

    // Total count of opportunities on this lead/signal must still be exactly 2 (one for A, one for B)
    const countOnLeadAndSignal = db.prepare('SELECT COUNT(*) n FROM lead_opportunities WHERE lead_id=101 AND demand_signal_id=?').get(signalRes.id).n;
    assert.strictEqual(countOnLeadAndSignal, 2);

    // 7. Immutability of product_id
    assert.throws(() => {
      db.prepare('UPDATE lead_opportunities SET product_id=? WHERE id=?').run(prodC.id, oppAId);
    }, /product_id is immutable/, 'product_id must not be modified after opportunity creation');

    // 8. Human-Confirmation Gate Isolation
    const lead = db.prepare('SELECT * FROM leads WHERE id=101').get();

    // Both opportunities are unreviewed -> BOTH MUST BE BLOCKED
    const outreachPreA = messages.action(lead, currentSettings, 'first', oppAFresh);
    assert.strictEqual(outreachPreA.blocked, true);
    assert.strictEqual(outreachPreA.reason, 'awaiting human confirmation');
    assert.strictEqual(outreachPreA.text, undefined);
    assert.strictEqual(outreachPreA.wa, undefined);

    const outreachPreB = messages.action(lead, currentSettings, 'first', oppB);
    assert.strictEqual(outreachPreB.blocked, true);
    assert.strictEqual(outreachPreB.reason, 'awaiting human confirmation');

    // Confirm Opp-A ONLY
    const confirmedOppA = demand.confirmOpportunity(db, oppAId, 'reviewer-alpha');
    assert.strictEqual(confirmedOppA.status, 'human_confirmed');
    assert.strictEqual(confirmedOppA.confirmed_by, 'reviewer-alpha');
    assert(confirmedOppA.confirmed_at > 0);

    // Opp-A is now unblocked
    const fullConfirmedOppA = demand.getOpportunity(db, oppAId);
    const outreachPostA = messages.action(lead, currentSettings, 'first', fullConfirmedOppA);
    assert.strictEqual(outreachPostA.blocked, undefined);
    assert(outreachPostA.text.length > 0);
    assert(outreachPostA.wa.includes('wa.me/919845011111'));
    // Product A is Abacus Buddy AI
    assert(outreachPostA.text.includes('Abacus Buddy AI') || outreachPostA.text.includes('abacus'));

    // CRITICAL: Opp-B MUST REMAIN UNREVIEWED AND BLOCKED
    const oppBStillUnreviewed = demand.getOpportunity(db, oppBId);
    assert.strictEqual(oppBStillUnreviewed.status, 'unreviewed');
    const outreachStillBlockedB = messages.action(lead, currentSettings, 'first', oppBStillUnreviewed);
    assert.strictEqual(outreachStillBlockedB.blocked, true, 'Confirming Product A must NOT unblock Product B');

    // Reject Opp-B
    const rejectedOppB = demand.rejectOpportunity(db, oppBId, 'reviewer-beta');
    assert.strictEqual(rejectedOppB.status, 'rejected');
    const fullRejectedOppB = demand.getOpportunity(db, oppBId);
    const outreachRejectedB = messages.action(lead, currentSettings, 'first', fullRejectedOppB);
    assert.strictEqual(outreachRejectedB.blocked, true, 'Rejected opportunity must remain blocked');

    // 9. Separate Opportunity for Product B confirmed yields Product B's templates
    const oppB2Id = demand.createOpportunity(db, signalRes.id, {
      lead_id: 101,
      leadReason: 'second review test',
      confidence: 0.90,
      reasons: ['test'],
      product_id: prodB.id
    });
    // In our DB, (101, signalRes.id, prodB.id) already existed and was rejected, so createOpportunity updated it
    assert.strictEqual(oppB2Id, oppBId);
    // Reset status to unreviewed for testing confirmation rendering
    db.prepare("UPDATE lead_opportunities SET status='unreviewed' WHERE id=?").run(oppBId);
    demand.confirmOpportunity(db, oppBId, 'reviewer-beta');
    const confirmedOppB = demand.getOpportunity(db, oppBId);
    const outreachPostB = messages.action(lead, currentSettings, 'first', confirmedOppB);
    assert.strictEqual(outreachPostB.blocked, undefined);
    // Product B template was: 'Hello {name} from {product}! Try our {topic} solution for your {org}: {link}'
    assert(outreachPostB.text.includes('SalonFlow AI'));
    assert(outreachPostB.text.includes('salon management'));
    assert(outreachPostB.text.includes('https://salonflow.test'));

    // 10. Delete Restriction
    assert.throws(() => {
      productsLib.deleteProduct(db, prodB.id);
    }, /Cannot delete product referenced by existing opportunities/, 'Deleting product referenced by opportunities must throw');

    // Product C has no opportunities, so deleting it succeeds
    const delRes = productsLib.deleteProduct(db, prodC.id);
    assert.strictEqual(delRes.ok, true);
    assert.strictEqual(productsLib.getProductById(db, prodC.id), null);

    console.log('test/product-isolation.test.js: all 13 isolation invariants passed successfully');
  } finally {
    try { fs.rmSync(testDbFile, { force: true }); } catch (_) {}
    try { fs.rmSync(testDbFile + '-wal', { force: true }); } catch (_) {}
    try { fs.rmSync(testDbFile + '-shm', { force: true }); } catch (_) {}
  }
}

const http = require('http');
const { createApp } = require('../server');

function makeRequest(port, p, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: '127.0.0.1', port, path: p, method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers } },
      (x) => {
        let t = '';
        x.on('data', (c) => (t += c));
        x.on('end', () => {
          let j;
          try { j = JSON.parse(t); } catch { j = t; }
          resolve({ status: x.statusCode, headers: x.headers, body: j });
        });
      }
    );
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

async function testProductApi() {
  const tmpDir = path.join(__dirname, '..', 'data', 'test-scratch');
  fs.mkdirSync(tmpDir, { recursive: true });
  const testDbFile = path.join(tmpDir, `product-api-${Date.now()}.db`);

  const app = createApp({ dbFile: testDbFile });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const port = app.server.address().port;

  try {
    // GET /api/products
    let res = await makeRequest(port, '/api/products');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.rows.length, 1);
    assert.strictEqual(res.body.rows[0].slug, 'abacus-buddy');

    // GET /api/products/active
    res = await makeRequest(port, '/api/products/active');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.slug, 'abacus-buddy');

    // POST /api/products
    res = await makeRequest(port, '/api/products', {
      method: 'POST',
      body: {
        slug: 'dance-pro',
        name: 'DancePro AI',
        description: 'Dance academy management',
        topic: 'dance classes',
        target_org: 'academy',
        link: 'https://dancepro.test',
        offer: '7-day trial',
        target_keywords: ['dance', 'kathak', 'bharatanatyam'],
        active: false
      }
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.slug, 'dance-pro');
    const newProdId = res.body.id;

    // GET /api/products/:id
    res = await makeRequest(port, `/api/products/${newProdId}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.name, 'DancePro AI');

    // PUT /api/products/:id
    res = await makeRequest(port, `/api/products/${newProdId}`, {
      method: 'PUT',
      body: { description: 'Updated dance academy management' }
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.description, 'Updated dance academy management');

    // POST /api/products/:id/activate
    res = await makeRequest(port, `/api/products/${newProdId}/activate`, { method: 'POST' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.active, 1);

    // Verify active is now dance-pro
    res = await makeRequest(port, '/api/products/active');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.id, newProdId);

    // GET /api/products?active=1
    res = await makeRequest(port, '/api/products?active=1');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.rows.length, 1);
    assert.strictEqual(res.body.rows[0].id, newProdId);

    // DELETE /api/products/:id (deleting active product will switch active to remaining)
    res = await makeRequest(port, `/api/products/${newProdId}`, { method: 'DELETE' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ok, true);

    console.log('test/product-isolation.test.js: HTTP API tests passed successfully');
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    try { fs.rmSync(testDbFile, { force: true }); } catch (_) {}
    try { fs.rmSync(testDbFile + '-wal', { force: true }); } catch (_) {}
    try { fs.rmSync(testDbFile + '-shm', { force: true }); } catch (_) {}
  }
}

async function run() {
  testProductIsolation();
  await testProductApi();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
