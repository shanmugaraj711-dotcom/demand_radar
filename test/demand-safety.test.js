'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { open } = require('../lib/db');
const demand = require('../lib/demand');
const messages = require('../lib/messages');

const file = path.join(os.tmpdir(), 'radar-demand-safety-' + process.pid + '.db');
for (const s of ['', '-wal', '-shm']) fs.rmSync(file + s, { force: true });
const db = open(file);
const products = require('../lib/products');

function addLead(id, name, area, address = area) {
  const now = Date.now();
  db.prepare('INSERT INTO leads(id,name,address,area,city,phone,wa,phone_type,score,stage,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, name, address, area, 'Bengaluru', '+919800000000', '919800000000', 'mobile', 50, 'new', now, now);
}

try {
  products.createProduct(db, {
    slug: 'clinic-safety-bot',
    name: 'ClinicBot AI',
    description: 'Clinic assistant',
    topic: 'appointments',
    active: 1
  });
  addLead(1001, 'Sri Ganesh Abacus', 'Anna Nagar', '2nd Cross, Anna Nagar');
  addLead(1002, 'Sri Ganesha Abacus', 'Anna Nagar', '2nd Cross, Anna Nagar');
  addLead(1003, 'Business A Clinic', 'Indiranagar', '4th Cross, Indiranagar');
  addLead(1004, 'Business B Clinic', 'Indiranagar', '4th Cross, Indiranagar');
  addLead(1005, 'Signal Clinic', '4th Cross', '4th Cross, near the signal');

  const cases = [
    {
      id: 'a',
      text: 'Sri Ganesh Abacus and Sri Ganesha Abacus are both in Anna Nagar.',
      entity_name: 'Sri Ganesh Abacus',
      location_hint: 'Anna Nagar'
    },
    {
      id: 'b',
      text: 'Oh sure, Business A Clinic will reply to your WhatsApp... eventually.',
      entity_name: 'Business A Clinic',
      location_hint: 'Indiranagar'
    },
    {
      id: 'c',
      text: 'Business A Clinic is poor, but Business B Clinic is better than them.',
      entity_name: 'Business B Clinic',
      location_hint: 'Indiranagar'
    },
    {
      id: 'd',
      text: 'The clinic near the signal on 4th cross never replies.',
      entity_name: '',
      location_hint: '4th cross near the signal'
    }
  ];

  const evidence = {};
  for (const item of cases) {
    const signal = demand.parseSignal({ source: 'adversarial', raw_text: item.text, entity_name: item.entity_name, location_hint: item.location_hint });
    const matches = demand.resolve(db, signal, 5);
    evidence[item.id] = {
      match_status: matches[0] ? matches[0].match_status : 'none',
      confidence: matches[0] ? matches[0].confidence : null,
      lead_id: matches[0] ? matches[0].lead_id : null
    };
    assert.notEqual(evidence[item.id].match_status, 'none');
  }

  assert.equal(evidence.a.match_status, 'matched');
  assert.equal(evidence.a.confidence, 0.82);
  assert.equal(evidence.a.lead_id, 1001);

  assert.equal(evidence.b.match_status, 'matched');
  assert.equal(evidence.b.confidence, 0.82);
  assert.equal(evidence.b.lead_id, 1003);

  assert.equal(evidence.c.match_status, 'matched');
  assert.equal(evidence.c.confidence, 0.82);
  assert.equal(evidence.c.lead_id, 1004);

  assert.equal(evidence.d.match_status, 'weak');
  assert(evidence.d.confidence < 0.45);

  const inserted = demand.insertSignal(db, {
    source: 'adversarial',
    source_url: 'https://example.test/review?id=999',
    raw_text: 'Business A has an operational gap.',
    entity_name: 'Business A Clinic',
    location_hint: 'Indiranagar'
  });
  const oppId = demand.createOpportunity(db, inserted.id, {
    lead_id: 1003,
    leadReason: 'operational_gap',
    confidence: 0.99,
    reasons: ['test 0.99 confidence'],
    distance_km: null,
    signalSource: inserted.signal.source,
    sourceUrl: inserted.signal.source_url,
    observedAt: inserted.signal.observed_at,
    rawText: inserted.signal.raw_text
  });
  const opp = db.prepare('SELECT * FROM lead_opportunities WHERE id=?').get(oppId);
  assert.equal(opp.status, 'unreviewed');
  assert.equal(opp.confirmed_at, null);
  assert.equal(opp.confirmed_by, null);

  const blocked = messages.action(
    db.prepare('SELECT * FROM leads WHERE id=1003').get(),
    { templates: { first_en: 'SHOULD NEVER BE GENERATED' }, sender: '', product: '', topic: '', org: '', link: '', offer: '' },
    'first',
    opp
  );
  assert.deepEqual(blocked, {
    blocked: true,
    reason: 'awaiting human confirmation',
    opportunity_id: oppId,
    status: 'unreviewed'
  });
  assert.equal('text' in blocked, false);
  assert.equal('wa' in blocked, false);

  assert.throws(() => db.prepare("UPDATE lead_opportunities SET status='bogus' WHERE id=?").run(oppId));

  const formattedOpp = demand.getOpportunity(db, oppId);
  assert.equal(formattedOpp.id, oppId);
  assert.equal(formattedOpp.status, 'unreviewed');
  assert.equal(formattedOpp.confidence, 0.99);
  assert.equal(formattedOpp.raw_text_excerpt, 'Business A has an operational gap.');
  assert.deepEqual(formattedOpp.match_reasons, ['test 0.99 confidence']);
  assert.deepEqual(formattedOpp.candidate, {
    id: 1003,
    name: 'Business A Clinic',
    area: 'Indiranagar',
    address: '4th Cross, Indiranagar'
  });

  const confirmedOpp = demand.confirmOpportunity(db, oppId, 'auditor-agent');
  assert.equal(confirmedOpp.status, 'human_confirmed');
  assert(confirmedOpp.confirmed_at > 0);
  assert.equal(confirmedOpp.confirmed_by, 'auditor-agent');

  const unblocked = messages.action(
    db.prepare('SELECT * FROM leads WHERE id=1003').get(),
    { templates: { first_en: 'Hi {{name}}' }, sender: '', product: '', topic: '', org: '', link: '', offer: '' },
    'first',
    confirmedOpp
  );
  assert(!unblocked.blocked);
  assert(unblocked.text.includes('Business A Clinic'));
  assert(unblocked.wa.includes('919800000000'));

  const h1 = demand.contentHash({
    source: 'social',
    source_url: 'http://example.test/review?id=123',
    raw_text: 'same review'
  });
  const h2 = demand.contentHash({
    source: 'social',
    source_url: 'https://example.test/review?id=456',
    raw_text: 'same review'
  });
  const h3 = demand.contentHash({
    source: 'social',
    source_url: 'https://example.test/review?id=123',
    raw_text: 'same review'
  });
  assert.notEqual(h1, h2);
  assert.equal(h1, h3);

  console.log(JSON.stringify({
    adversarial: evidence,
    pre_confirmation: { confidence: 0.99, status: opp.status, outreach: blocked },
    post_confirmation: {
      status: confirmedOpp.status,
      confirmed_at: confirmedOpp.confirmed_at,
      confirmed_by: confirmedOpp.confirmed_by,
      outreach_unblocked: !unblocked.blocked,
      wa_generated: !!unblocked.wa
    },
    url_ids: { id123_hash: h3, id456_hash: h2, collide: h2 === h3 }
  }, null, 2));
  console.log('demand-safety.test: all checks passed');
} finally {
  db.close();
  for (const s of ['', '-wal', '-shm']) fs.rmSync(file + s, { force: true });
}
