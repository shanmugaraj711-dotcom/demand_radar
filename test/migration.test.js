'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const migration = require('../lib/migration');
const productsLib = require('../lib/products');

const PRE_MIGRATION_SCHEMA = `
CREATE TABLE settings(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE cache(k TEXT PRIMARY KEY, v TEXT, exp INTEGER);
CREATE TABLE usage(day TEXT, api TEXT, n INTEGER DEFAULT 0, PRIMARY KEY(day, api));
CREATE TABLE searches(
  id INTEGER PRIMARY KEY AUTOINCREMENT, seed TEXT, country TEXT, lang TEXT, city TEXT, depth TEXT, sources TEXT,
  requests INTEGER DEFAULT 0, phrases INTEGER DEFAULT 0, status TEXT, note TEXT, created INTEGER, finished INTEGER);
CREATE TABLE keywords(
  id INTEGER PRIMARY KEY AUTOINCREMENT, search_id INTEGER, phrase TEXT, sources TEXT, occ INTEGER, score INTEGER,
  band TEXT, intent TEXT, place TEXT, fringe INTEGER DEFAULT 0, UNIQUE(search_id, phrase));
CREATE INDEX kw_search ON keywords(search_id, score DESC);
CREATE TABLE leads(
  id INTEGER PRIMARY KEY AUTOINCREMENT, place_id TEXT, name TEXT, address TEXT, area TEXT, city TEXT,
  phone TEXT, wa TEXT, phone_type TEXT, website TEXT, email TEXT, instagram TEXT, facebook TEXT,
  rating REAL, reviews INTEGER, maps_url TEXT, lat REAL, lng REAL, source TEXT, query TEXT, seed TEXT,
  signals TEXT, extra TEXT, score INTEGER DEFAULT 0, stage TEXT DEFAULT 'new', lang TEXT DEFAULT 'en',
  contact_name TEXT, notes TEXT, touches INTEGER DEFAULT 0, next_action TEXT, next_followup INTEGER,
  last_contacted INTEGER, pilot_start INTEGER, lost_reason TEXT, enriched INTEGER DEFAULT 0,
  created INTEGER, updated INTEGER);
CREATE UNIQUE INDEX leads_place ON leads(place_id) WHERE place_id IS NOT NULL;
CREATE INDEX leads_wa ON leads(wa);
CREATE INDEX leads_stage ON leads(stage, next_followup);
CREATE TABLE demand_signals(
  id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, source_id TEXT, content_hash TEXT UNIQUE NOT NULL, raw_text TEXT NOT NULL, entity_name TEXT, location_hint TEXT, detected_need TEXT, intent_class TEXT, confidence_score REAL DEFAULT 0.0, source_url TEXT, observed_at TEXT, created_at INTEGER, lat REAL, lng REAL
);
CREATE INDEX demand_signals_observed ON demand_signals(observed_at);
CREATE TABLE lead_opportunities(
  id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE, demand_signal_id INTEGER REFERENCES demand_signals(id) ON DELETE CASCADE, lead_reason TEXT NOT NULL, evidence TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'unreviewed' CHECK(status IN ('unreviewed','human_confirmed','rejected')), confirmed_at INTEGER, confirmed_by TEXT, updated_at INTEGER, UNIQUE(lead_id, demand_signal_id)
);
CREATE INDEX lead_opp_status ON lead_opportunities(status, updated_at);
CREATE TRIGGER lead_opportunities_status_insert BEFORE INSERT ON lead_opportunities WHEN NEW.status NOT IN ('unreviewed','human_confirmed','rejected') BEGIN SELECT RAISE(ABORT, 'invalid opportunity status'); END;
CREATE TRIGGER lead_opportunities_status_update BEFORE UPDATE OF status ON lead_opportunities WHEN NEW.status NOT IN ('unreviewed','human_confirmed','rejected') BEGIN SELECT RAISE(ABORT, 'invalid opportunity status'); END;
CREATE TABLE activities(
  id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id INTEGER, type TEXT, step TEXT, lang TEXT, body TEXT, at INTEGER);
CREATE INDEX act_lead ON activities(lead_id, at);
CREATE INDEX act_at ON activities(at);
`;

function testMigration() {
  const tmpDir = path.join(__dirname, '..', 'data', 'test-scratch');
  fs.mkdirSync(tmpDir, { recursive: true });
  const testDbFile = path.join(tmpDir, `migration-test-${Date.now()}.db`);

  try {
    const db = new DatabaseSync(testDbFile);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
    db.exec(PRE_MIGRATION_SCHEMA);

    // Populate pre-migration data
    db.prepare("INSERT INTO settings(k, v) VALUES ('profile', ?)").run(JSON.stringify({
      product: 'Abacus Buddy AI',
      topic: 'abacus',
      org: 'centre',
      link: 'https://abacus.promptstudioai.in',
      offer: '2 free student accounts'
    }));

    db.prepare(`
      INSERT INTO leads(id, name, address, area, city, phone, wa, phone_type, score, stage)
      VALUES (1, 'Alpha Abacus Hub', '10 Main Rd, Anna Nagar', 'Anna Nagar', 'Chennai', '9840011111', '919840011111', 'mobile', 85, 'new')
    `).run();
    db.prepare(`
      INSERT INTO leads(id, name, address, area, city, phone, wa, phone_type, score, stage)
      VALUES (2, 'Beta Learning Academy', '25 Park Ave, T Nagar', 'T Nagar', 'Chennai', '9840022222', '919840022222', 'mobile', 80, 'new')
    `).run();

    db.prepare(`
      INSERT INTO demand_signals(id, source, source_id, content_hash, raw_text, entity_name, location_hint, detected_need, intent_class, confidence_score, observed_at, created_at)
      VALUES (1, 'social', 'sig-1', 'hash-1', 'Need abacus classes in Anna Nagar', 'Alpha Abacus Hub', 'Anna Nagar', 'abacus', 'buying_intent', 0.85, '2026-09-30T00:00:00.000Z', 1790730000000)
    `).run();
    db.prepare(`
      INSERT INTO demand_signals(id, source, source_id, content_hash, raw_text, entity_name, location_hint, detected_need, intent_class, confidence_score, observed_at, created_at)
      VALUES (2, 'social', 'sig-2', 'hash-2', 'Looking for tutors in T Nagar', 'Beta Learning Academy', 'T Nagar', 'tutors', 'buying_intent', 0.80, '2026-09-30T00:00:00.000Z', 1790730000000)
    `).run();

    db.prepare(`
      INSERT INTO lead_opportunities(id, lead_id, demand_signal_id, lead_reason, evidence, status, updated_at)
      VALUES (1, 1, 1, 'need abacus classes', '{"match_confidence":0.85}', 'unreviewed', 1790730000000)
    `).run();
    db.prepare(`
      INSERT INTO lead_opportunities(id, lead_id, demand_signal_id, lead_reason, evidence, status, confirmed_at, confirmed_by, updated_at)
      VALUES (2, 2, 2, 'looking for tutors', '{"match_confidence":0.80}', 'human_confirmed', 1790731000000, 'tester', 1790731000000)
    `).run();

    // Verify pre-migration state
    assert.strictEqual(migration.isMigrated(db), false, 'DB should not be marked as migrated yet');
    const preLeadsCount = db.prepare('SELECT COUNT(*) n FROM leads').get().n;
    const preSignalsCount = db.prepare('SELECT COUNT(*) n FROM demand_signals').get().n;
    const preOppsCount = db.prepare('SELECT COUNT(*) n FROM lead_opportunities').get().n;
    assert.strictEqual(preLeadsCount, 2);
    assert.strictEqual(preSignalsCount, 2);
    assert.strictEqual(preOppsCount, 2);

    // Run migration
    const res = migration.migrate(db);
    assert.strictEqual(res.ok, true, 'Migration should return ok');
    assert(res.activeProduct, 'Migration should return active product');
    assert.strictEqual(res.activeProduct.slug, 'abacus-buddy');
    assert.strictEqual(res.activeProduct.name, 'Abacus Buddy AI');
    assert.strictEqual(migration.isMigrated(db), true, 'DB should now be marked as migrated');

    // Verify row counts preserved
    const postLeadsCount = db.prepare('SELECT COUNT(*) n FROM leads').get().n;
    const postSignalsCount = db.prepare('SELECT COUNT(*) n FROM demand_signals').get().n;
    const postOppsCount = db.prepare('SELECT COUNT(*) n FROM lead_opportunities').get().n;
    assert.strictEqual(postLeadsCount, preLeadsCount, 'Leads count must match');
    assert.strictEqual(postSignalsCount, preSignalsCount, 'Demand signals count must match');
    assert.strictEqual(postOppsCount, preOppsCount, 'Opportunities count must match');

    // Verify opportunities table structure and product_id backfill
    const opp1 = db.prepare('SELECT * FROM lead_opportunities WHERE id=1').get();
    assert.strictEqual(opp1.product_id, res.activeProduct.id, 'Existing opp 1 should be linked to seeded product');
    assert.strictEqual(opp1.status, 'unreviewed');

    const opp2 = db.prepare('SELECT * FROM lead_opportunities WHERE id=2').get();
    assert.strictEqual(opp2.product_id, res.activeProduct.id, 'Existing opp 2 should be linked to seeded product');
    assert.strictEqual(opp2.status, 'human_confirmed');
    assert.strictEqual(opp2.confirmed_by, 'tester');

    // Verify integrity and foreign key checks
    const fk = db.prepare('PRAGMA foreign_key_check').all();
    assert.strictEqual(fk.length, 0, 'No FK violations allowed');
    const ic = db.prepare('PRAGMA integrity_check').get();
    assert.strictEqual(ic.integrity_check, 'ok', 'Integrity check must be ok');

    // Test product isolation at DB constraint level:
    // Create Product B
    const prodB = productsLib.createProduct(db, {
      slug: 'tutor-match',
      name: 'Tutor Match AI',
      description: 'Find matching tutors',
      topic: 'tutors',
      target_org: 'academy',
      active: false
    });

    // Allowed: Insert an opportunity for the same lead and signal for Product B
    db.prepare(`
      INSERT INTO lead_opportunities(lead_id, demand_signal_id, product_id, lead_reason, evidence, status, updated_at)
      VALUES (1, 1, ?, 'tutor match for same signal', '{"match_confidence":0.75}', 'unreviewed', 1790732000000)
    `).run(prodB.id);

    const sameLeadAndSignalOpps = db.prepare('SELECT * FROM lead_opportunities WHERE lead_id=1 AND demand_signal_id=1').all();
    assert.strictEqual(sameLeadAndSignalOpps.length, 2, 'Should allow 2 separate opportunities on same lead & signal for different products');

    // Rejected: Insert duplicate opportunity for Product B on same lead and signal
    assert.throws(() => {
      db.prepare(`
        INSERT INTO lead_opportunities(lead_id, demand_signal_id, product_id, lead_reason, evidence, status, updated_at)
        VALUES (1, 1, ?, 'duplicate opp', '{"match_confidence":0.75}', 'unreviewed', 1790732000000)
      `).run(prodB.id);
    }, /UNIQUE constraint failed/, 'Duplicate (lead_id, demand_signal_id, product_id) must be rejected');

    // Rejected: product_id immutability trigger
    assert.throws(() => {
      db.prepare('UPDATE lead_opportunities SET product_id=? WHERE id=1').run(prodB.id);
    }, /product_id is immutable/, 'product_id must be immutable once created');

    // Test idempotency of migrate()
    const secondMigrate = migration.migrate(db);
    assert.strictEqual(secondMigrate.ok, true, 'Running migrate a second time should succeed idempotently');

    // Test rollback
    const rollbackRes = migration.rollback(db);
    assert.strictEqual(rollbackRes.ok, true, 'Rollback should succeed');
    assert.strictEqual(rollbackRes.rolledBack, true);
    assert.strictEqual(migration.isMigrated(db), false, 'After rollback, DB is not marked as migrated');

    const rollbackFk = db.prepare('PRAGMA foreign_key_check').all();
    assert.strictEqual(rollbackFk.length, 0, 'No FK violations after rollback');
    const rollbackIc = db.prepare('PRAGMA integrity_check').get();
    assert.strictEqual(rollbackIc.integrity_check, 'ok', 'Integrity check must be ok after rollback');

    // Re-migrate to ensure full roundtrip works cleanly
    const reMigrate = migration.migrate(db);
    assert.strictEqual(reMigrate.ok, true, 'Re-migration after rollback should succeed');
    assert.strictEqual(migration.isMigrated(db), true);

    console.log('test/migration.test.js: all migration tests passed successfully');
  } finally {
    try { fs.rmSync(testDbFile, { force: true }); } catch (_) {}
    try { fs.rmSync(testDbFile + '-wal', { force: true }); } catch (_) {}
    try { fs.rmSync(testDbFile + '-shm', { force: true }); } catch (_) {}
  }
}

testMigration();
