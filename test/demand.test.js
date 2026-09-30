'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { open } = require('../lib/db');
const demand = require('../lib/demand');

const file = path.join(os.tmpdir(), 'radar-demand-' + process.pid + '.db');
for (const s of ['', '-wal', '-shm']) fs.rmSync(file + s, { force: true });
const db = open(file);
const products = require('../lib/products');
try {
  products.createProduct(db, {
    slug: 'clinic-bot',
    name: 'ClinicBot AI',
    description: 'Clinic assistant',
    topic: 'appointments',
    active: 1
  });
  const now = Date.now();
  db.prepare('INSERT INTO leads(id,name,address,area,city,phone,wa,phone_type,lat,lng,score,stage,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(8492, 'Dr Sharma Clinic', '4th Cross, Indiranagar, Bengaluru, Karnataka', 'Indiranagar', 'Bengaluru', '+919800000000', '919800000000', 'mobile', 12.9719, 77.6412, 80, 'new', now, now);
  db.prepare('INSERT INTO leads(id,name,address,area,city,phone,wa,phone_type,lat,lng,score,stage,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(8493, 'Dr Sharma Dental', '4th Cross, Indiranagar, Bengaluru, Karnataka', 'Indiranagar', 'Bengaluru', '+919811111111', '919811111111', 'mobile', 12.9719, 77.6418, 70, 'new', now, now);

  const text = 'Avoid Dr Sharma Clinic on 4th Cross, Indiranagar. They never reply on WhatsApp to confirm appointments.';
  const parsed = demand.parseSignal({ source:'test', source_url:'https://example.test/post/1', raw_text:text, entity_name:'Dr Sharma Clinic', location_hint:'4th Cross, Indiranagar' });
  assert.equal(parsed.intent_class, 'operational_gap');
  assert.equal(parsed.detected_need, 'no_whatsapp_booking');
  assert.equal(parsed.content_hash.length, 64);

  const inserted = demand.insertSignal(db, { source:'test', source_url:'https://example.test/post/1', raw_text:text, entity_name:'Dr Sharma Clinic', location_hint:'4th Cross, Indiranagar' });
  assert.equal(inserted.inserted, true);
  const dup = demand.insertSignal(db, { source:'test', source_url:'https://example.test/post/1', raw_text:text, entity_name:'Dr Sharma Clinic', location_hint:'4th Cross, Indiranagar' });
  assert.equal(dup.duplicate, true);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM demand_signals').get().n, 1);

  const matches = demand.resolve(db, inserted.signal, 5);
  assert.equal(matches[0].lead_id, 8492);
  assert.equal(matches[0].match_status, 'matched');
  assert(matches[0].confidence > matches[1].confidence);

  const opp = demand.createOpportunity(db, inserted.id, {
    lead_id: matches[0].lead_id, leadReason: 'No WhatsApp booking response', confidence: matches[0].confidence,
    reasons: matches[0].reasons, distance_km: matches[0].distance_km, signalSource: inserted.signal.source,
    sourceUrl: inserted.signal.source_url, observedAt: inserted.signal.observed_at, rawText: inserted.signal.raw_text
  });
  assert.equal(opp, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lead_opportunities').get().n, 1);
  const evidence = JSON.parse(db.prepare('SELECT evidence FROM lead_opportunities WHERE id=1').get().evidence);
  assert.equal(evidence.source_url, 'https://example.test/post/1');
  assert(evidence.match_confidence > 0.7);
  console.log('demand.test: all checks passed');
} finally {
  db.close();
  for (const s of ['', '-wal', '-shm']) fs.rmSync(file + s, { force: true });
}
