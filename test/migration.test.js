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

const PRODUCTION_CONFIG_FIXTURE = {
  product: 'Abacus Buddy AI',
  topic: 'abacus',
  org: 'centre',
  link: 'https://abacus.promptstudioai.in',
  offer: '2 free student accounts are for you to test and show the app. Other students\' parents can unlock the full app, and your centre earns a share for each one.',
  target_keywords: ['abacus', 'abacus classes', 'vedic maths', 'mental arithmetic'],
  templates: {
    first_en: 'Hello {name} from {product}'
  }
};

function getFkSetting(db) {
  const r = db.prepare('PRAGMA foreign_keys').get();
  return r ? Object.values(r)[0] : 0;
}

function getTableCounts(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(t => t.name);
  const counts = {};
  for (const t of tables) {
    counts[t] = db.prepare(`SELECT COUNT(*) n FROM "${t}"`).get().n;
  }
  return counts;
}

function testForeignKeys(db, { isMigrated = true } = {}) {
  assert.strictEqual(getFkSetting(db), 1, 'PRAGMA foreign_keys must be 1 (ON)');

  // Attempt invalid lead_id reference
  assert.throws(() => {
    if (isMigrated) {
      db.prepare(`
        INSERT INTO lead_opportunities(lead_id, demand_signal_id, product_id, lead_reason, evidence, status, updated_at)
        VALUES (999999, NULL, 1, 'invalid lead', '{}', 'unreviewed', 1000)
      `).run();
    } else {
      db.prepare(`
        INSERT INTO lead_opportunities(lead_id, demand_signal_id, lead_reason, evidence, status, updated_at)
        VALUES (999999, NULL, 'invalid lead', '{}', 'unreviewed', 1000)
      `).run();
    }
  }, /FOREIGN KEY constraint failed/, 'Invalid lead_id insert must be rejected by foreign key check');

  if (isMigrated) {
    // Attempt invalid product_id reference
    // Get an existing lead
    const lead = db.prepare('SELECT id FROM leads LIMIT 1').get();
    if (lead) {
      assert.throws(() => {
        db.prepare(`
          INSERT INTO lead_opportunities(lead_id, demand_signal_id, product_id, lead_reason, evidence, status, updated_at)
          VALUES (?, NULL, 999999, 'invalid product', '{}', 'unreviewed', 1000)
        `).run(lead.id);
      }, /FOREIGN KEY constraint failed/, 'Invalid product_id insert must be rejected by foreign key check');
    }
  }

  // Attempt invalid demand_signal_id reference
  const leadForSig = db.prepare('SELECT id FROM leads LIMIT 1').get();
  if (leadForSig) {
    assert.throws(() => {
      if (isMigrated) {
        db.prepare(`
          INSERT INTO lead_opportunities(lead_id, demand_signal_id, product_id, lead_reason, evidence, status, updated_at)
          VALUES (?, 999999, 1, 'invalid signal', '{}', 'unreviewed', 1000)
        `).run(leadForSig.id);
      } else {
        db.prepare(`
          INSERT INTO lead_opportunities(lead_id, demand_signal_id, lead_reason, evidence, status, updated_at)
          VALUES (?, 999999, 'invalid signal', '{}', 'unreviewed', 1000)
        `).run(leadForSig.id);
      }
    }, /FOREIGN KEY constraint failed/, 'Invalid demand_signal_id insert must be rejected by foreign key check');
  }

  const fk = db.prepare('PRAGMA foreign_key_check').all();
  assert.strictEqual(fk.length, 0, 'foreign_key_check must return 0 violations');

  const ic = db.prepare('PRAGMA integrity_check').get();
  assert.strictEqual(ic.integrity_check, 'ok', 'integrity_check must be ok');
}

function testSyntheticProductionShapeMigration() {
  console.log('\n--- Running Synthetic Production-Shape Migration Test ---');
  const tmpDir = path.join(__dirname, '..', 'data', 'test-scratch');
  fs.mkdirSync(tmpDir, { recursive: true });
  const testDbFile = path.join(tmpDir, `synthetic-migration-${Date.now()}.db`);

  try {
    const db = new DatabaseSync(testDbFile);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
    db.exec(PRE_MIGRATION_SCHEMA);

    // Populate full production shape
    db.prepare("INSERT INTO settings(k, v) VALUES ('profile', ?)").run(JSON.stringify(PRODUCTION_CONFIG_FIXTURE));
    db.prepare("INSERT INTO settings(k, v) VALUES ('secret.session', '\"fake-session-token\"')").run();

    // Cache
    db.prepare("INSERT INTO cache(k, v, exp) VALUES ('test-key', '\"cached-value\"', ?)").run(Date.now() + 86400000);

    // Usage
    db.prepare("INSERT INTO usage(day, api, n) VALUES ('2026-09-30', 'places', 5)").run();

    // Searches & keywords
    db.prepare("INSERT INTO searches(id, seed, country, lang, city, depth, status, created) VALUES (1, 'abacus', 'IN', 'en', 'Chennai', 'quick', 'done', 1790730000000)").run();
    db.prepare("INSERT INTO keywords(search_id, phrase, sources, occ, score, band) VALUES (1, 'abacus classes', 'google', 1, 90, 'hot')").run();
    db.prepare("INSERT INTO keywords(search_id, phrase, sources, occ, score, band) VALUES (1, 'vedic maths', 'google', 1, 80, 'hot')").run();

    // Leads
    db.prepare(`
      INSERT INTO leads(id, name, address, area, city, phone, wa, phone_type, score, stage)
      VALUES (1, 'Alpha Centre', '10 Main Rd, Anna Nagar', 'Anna Nagar', 'Chennai', '9840011111', '919840011111', 'mobile', 85, 'new')
    `).run();
    db.prepare(`
      INSERT INTO leads(id, name, address, area, city, phone, wa, phone_type, score, stage)
      VALUES (2, 'Beta Academy', '25 Park Ave, T Nagar', 'T Nagar', 'Chennai', '9840022222', '919840022222', 'mobile', 80, 'new')
    `).run();

    // Activities
    db.prepare("INSERT INTO activities(lead_id, type, step, body, at) VALUES (1, 'message', 'first', 'hello', 1790730000000)").run();

    // Demand Signals
    db.prepare(`
      INSERT INTO demand_signals(id, source, source_id, content_hash, raw_text, entity_name, location_hint, detected_need, intent_class, confidence_score, observed_at, created_at)
      VALUES (1, 'social', 'sig-1', 'hash-1', 'Need abacus classes in Anna Nagar', 'Alpha Centre', 'Anna Nagar', 'abacus', 'buying_intent', 0.85, '2026-09-30T00:00:00.000Z', 1790730000000)
    `).run();
    db.prepare(`
      INSERT INTO demand_signals(id, source, source_id, content_hash, raw_text, entity_name, location_hint, detected_need, intent_class, confidence_score, observed_at, created_at)
      VALUES (2, 'social', 'sig-2', 'hash-2', 'Looking for academy in T Nagar', 'Beta Academy', 'T Nagar', 'academy', 'buying_intent', 0.80, '2026-09-30T00:00:00.000Z', 1790730000000)
    `).run();

    // Opportunities (pre-migration: UNIQUE(lead_id, demand_signal_id))
    db.prepare(`
      INSERT INTO lead_opportunities(id, lead_id, demand_signal_id, lead_reason, evidence, status, updated_at)
      VALUES (1, 1, 1, 'need abacus classes', '{"match_confidence":0.85}', 'unreviewed', 1790730000000)
    `).run();
    db.prepare(`
      INSERT INTO lead_opportunities(id, lead_id, demand_signal_id, lead_reason, evidence, status, confirmed_at, confirmed_by, updated_at)
      VALUES (2, 2, 2, 'looking for academy', '{"match_confidence":0.80}', 'human_confirmed', 1790731000000, 'tester', 1790731000000)
    `).run();

    // Record BEFORE counts and state
    const beforeCounts = getTableCounts(db);
    console.log('  BEFORE migration row counts:', beforeCounts);
    assert.strictEqual(beforeCounts.leads, 2);
    assert.strictEqual(beforeCounts.demand_signals, 2);
    assert.strictEqual(beforeCounts.lead_opportunities, 2);
    assert.strictEqual(beforeCounts.settings, 2);
    assert.strictEqual(beforeCounts.searches, 1);
    assert.strictEqual(beforeCounts.keywords, 2);
    assert.strictEqual(beforeCounts.activities, 1);
    assert.strictEqual(beforeCounts.cache, 1);
    assert.strictEqual(beforeCounts.usage, 1);
    assert.strictEqual(migration.isMigrated(db), false);

    // Execute migration
    const migRes = migration.migrate(db);
    assert.strictEqual(migRes.ok, true);
    assert.strictEqual(migration.isMigrated(db), true);

    // Record AFTER counts
    const afterCounts = getTableCounts(db);
    console.log('  AFTER migration row counts:', afterCounts);

    // Verify all existing table counts are strictly preserved
    for (const [table, cnt] of Object.entries(beforeCounts)) {
      assert.strictEqual(afterCounts[table], cnt, `Table ${table} count must be preserved`);
    }
    assert.strictEqual(afterCounts.products, 1, 'products table must contain 1 seeded product');

    // Verify products table content
    const seededProd = db.prepare('SELECT * FROM products WHERE id=1').get();
    assert.strictEqual(seededProd.name, 'Abacus Buddy AI');
    assert.strictEqual(seededProd.slug, 'abacus-buddy-ai');
    assert.strictEqual(seededProd.active, 1);

    // Verify opportunities backfill
    const opp1 = db.prepare('SELECT * FROM lead_opportunities WHERE id=1').get();
    assert.strictEqual(opp1.product_id, 1);
    assert.strictEqual(opp1.status, 'unreviewed');
    assert.strictEqual(opp1.confirmed_at, null);

    const opp2 = db.prepare('SELECT * FROM lead_opportunities WHERE id=2').get();
    assert.strictEqual(opp2.product_id, 1);
    assert.strictEqual(opp2.status, 'human_confirmed');
    assert.strictEqual(opp2.confirmed_by, 'tester');
    assert.strictEqual(opp2.confirmed_at, 1790731000000);

    // Verify triggers exist
    const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all().map(t => t.name);
    assert(triggers.includes('lead_opportunities_status_insert'), 'status insert trigger must exist');
    assert(triggers.includes('lead_opportunities_status_update'), 'status update trigger must exist');
    assert(triggers.includes('lead_opportunities_product_immutable'), 'product immutable trigger must exist');

    // Verify product_id immutability trigger
    assert.throws(() => {
      db.prepare('UPDATE lead_opportunities SET product_id=99 WHERE id=1').run();
    }, /product_id is immutable/, 'Trigger must block mutating product_id');

    // BLOCKER 4: Explicit Foreign-Key Verification
    testForeignKeys(db, { isMigrated: true });
    console.log('  ok   Foreign key enforcement verified (PRAGMA foreign_keys = 1, invalid inserts rejected)');

    // ============================================================
    // BLOCKER 1 TESTS: ROLLBACK MUST NOT SILENTLY DESTROY DATA
    // ============================================================

    // Create Product B
    const prodB = productsLib.createProduct(db, {
      slug: 'robotics-flow',
      name: 'Robotics Flow',
      description: 'Robotics for kids',
      topic: 'robotics',
      active: false
    });

    // Case 2: Multi-product conflict scenario
    // Add opportunity for Product B on the SAME (lead_id=1, demand_signal_id=1)
    db.prepare(`
      INSERT INTO lead_opportunities(lead_id, demand_signal_id, product_id, lead_reason, evidence, status, updated_at)
      VALUES (1, 1, ?, 'robotics gap', '{"confidence":0.88}', 'unreviewed', 1790732000000)
    `).run(prodB.id);

    const countBeforeRollback = db.prepare('SELECT COUNT(*) n FROM lead_opportunities').get().n;
    assert.strictEqual(countBeforeRollback, 3, 'Should now have 3 opportunities across 2 products');

    // Attempt rollback: MUST FAIL with exact required error
    let rollbackThrew = false;
    try {
      migration.rollback(db);
    } catch (err) {
      rollbackThrew = true;
      assert.strictEqual(
        err.message,
        'Rollback blocked: multi-product opportunities cannot be represented by the pre-Phase-1 schema without data loss.',
        'Rollback must throw exact data loss protection error'
      );
    }
    assert.strictEqual(rollbackThrew, true, 'Rollback must refuse when multi-product rows exist');

    // Case 3: Verify state after refused rollback: NO DATA LOSS, NO PARTIAL ROLLBACK
    const countAfterFailedRollback = db.prepare('SELECT COUNT(*) n FROM lead_opportunities').get().n;
    assert.strictEqual(countAfterFailedRollback, 3, 'All 3 opportunities must still exist after failed rollback');

    const oppsOnLead1Sig1 = db.prepare('SELECT * FROM lead_opportunities WHERE lead_id=1 AND demand_signal_id=1 ORDER BY id').all();
    assert.strictEqual(oppsOnLead1Sig1.length, 2, 'Both Product A and Product B opportunities must still exist');
    assert.strictEqual(oppsOnLead1Sig1[0].product_id, 1);
    assert.strictEqual(oppsOnLead1Sig1[0].status, 'unreviewed');
    assert.strictEqual(oppsOnLead1Sig1[1].product_id, prodB.id);
    assert.strictEqual(oppsOnLead1Sig1[1].status, 'unreviewed');
    assert.strictEqual(oppsOnLead1Sig1[1].lead_reason, 'robotics gap');

    // Verify DB still in migrated state and intact
    assert.strictEqual(migration.isMigrated(db), true, 'DB must remain in migrated state after blocked rollback');
    testForeignKeys(db, { isMigrated: true });
    console.log('  ok   Rollback safely REFUSED on multi-product conflict; zero data loss, zero partial rollback');

    // Case 1: Clean rollback when no multi-product conflict exists
    // Delete the Product B opportunity so there is only 1 product per (lead_id, demand_signal_id)
    db.prepare('DELETE FROM lead_opportunities WHERE product_id=?').run(prodB.id);
    const preCleanCount = db.prepare('SELECT COUNT(*) n FROM lead_opportunities').get().n;
    assert.strictEqual(preCleanCount, 2);

    const cleanRollbackRes = migration.rollback(db);
    assert.strictEqual(cleanRollbackRes.ok, true);
    assert.strictEqual(cleanRollbackRes.rolledBack, true);
    assert.strictEqual(migration.isMigrated(db), false, 'DB should now be in pre-migration schema');

    // Verify all 2 opportunities were preserved exactly
    const postCleanCount = db.prepare('SELECT COUNT(*) n FROM lead_opportunities').get().n;
    assert.strictEqual(postCleanCount, 2, 'Clean rollback must preserve all rows');

    const rbOpp1 = db.prepare('SELECT * FROM lead_opportunities WHERE id=1').get();
    assert.strictEqual(rbOpp1.lead_reason, 'need abacus classes');
    assert.strictEqual(rbOpp1.status, 'unreviewed');
    assert(!('product_id' in rbOpp1), 'product_id column must not exist after rollback');

    const rbOpp2 = db.prepare('SELECT * FROM lead_opportunities WHERE id=2').get();
    assert.strictEqual(rbOpp2.status, 'human_confirmed');
    assert.strictEqual(rbOpp2.confirmed_by, 'tester');

    // Test FK enforcement on the rolled-back table
    testForeignKeys(db, { isMigrated: false });
    console.log('  ok   Clean rollback succeeded with 100% row preservation and foreign key enforcement');

    // Re-migrate to confirm roundtrip capability
    const reMig = migration.migrate(db);
    assert.strictEqual(reMig.ok, true);
    assert.strictEqual(migration.isMigrated(db), true);
    testForeignKeys(db, { isMigrated: true });
    console.log('  ok   Re-migration succeeded cleanly');

    console.log('Synthetic Production-Shape Migration Test: ALL CHECKS PASSED');
  } finally {
    try { fs.rmSync(testDbFile, { force: true }); } catch (_) {}
    try { fs.rmSync(testDbFile + '-wal', { force: true }); } catch (_) {}
    try { fs.rmSync(testDbFile + '-shm', { force: true }); } catch (_) {}
  }
}

function testActualProductionCopyMigration() {
  console.log('\n--- Running Actual Production-Copy Migration Test ---');
  // Check if a read-only copy of production DB exists in /tmp
  const prodSource = '/tmp/radar-prod-read.db';
  if (!fs.existsSync(prodSource)) {
    console.log('  [NOTICE] Production copy /tmp/radar-prod-read.db not found; skipping actual production-copy test.');
    return { ran: false };
  }

  const tmpDir = path.join(__dirname, '..', 'data', 'test-scratch');
  fs.mkdirSync(tmpDir, { recursive: true });
  const testDbFile = path.join(tmpDir, `actual-prod-copy-migration-${Date.now()}.db`);

  try {
    // Copy the read-only production database to isolated scratch file
    fs.copyFileSync(prodSource, testDbFile);

    const db = new DatabaseSync(testDbFile);
    db.exec('PRAGMA foreign_keys=ON;');

    // Inspect pre-migration state
    const beforeCounts = getTableCounts(db);
    console.log('  ACTUAL PRODUCTION COPY - Row counts BEFORE migration:');
    for (const [t, n] of Object.entries(beforeCounts)) {
      console.log(`    ${t}: ${n}`);
    }

    assert(beforeCounts.leads > 0, 'Production copy must have leads');
    assert(beforeCounts.keywords > 0, 'Production copy must have keywords');
    assert.strictEqual(migration.isMigrated(db), false, 'Production DB should not be migrated yet');

    // Run migration, passing the production configuration fixture
    const migRes = migration.migrate(db, { defaultProduct: PRODUCTION_CONFIG_FIXTURE });
    assert.strictEqual(migRes.ok, true);
    assert.strictEqual(migration.isMigrated(db), true);

    const afterCounts = getTableCounts(db);
    console.log('  ACTUAL PRODUCTION COPY - Row counts AFTER migration:');
    for (const [t, n] of Object.entries(afterCounts)) {
      console.log(`    ${t}: ${n}`);
    }

    // Verify all original table counts are strictly identical
    for (const [t, cnt] of Object.entries(beforeCounts)) {
      assert.strictEqual(afterCounts[t], cnt, `Table ${t} row count must match exactly: ${cnt}`);
    }
    assert.strictEqual(afterCounts.products, 1, 'products table must have seeded active product');

    // Verify active product
    const active = productsLib.getActiveProduct(db);
    assert.strictEqual(active.name, 'Abacus Buddy AI');
    assert.strictEqual(active.active, 1);

    // Verify foreign key enforcement
    testForeignKeys(db, { isMigrated: true });

    // Verify trigger immutability
    const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all().map(t => t.name);
    assert(triggers.includes('lead_opportunities_product_immutable'));

    // Test rollback safety on production copy
    const rbRes = migration.rollback(db);
    assert.strictEqual(rbRes.ok, true);
    assert.strictEqual(migration.isMigrated(db), false);

    const rbCounts = getTableCounts(db);
    for (const [t, cnt] of Object.entries(beforeCounts)) {
      assert.strictEqual(rbCounts[t], cnt, `Post-rollback table ${t} row count must match: ${cnt}`);
    }

    // Re-migrate
    const reMig = migration.migrate(db, { defaultProduct: PRODUCTION_CONFIG_FIXTURE });
    assert.strictEqual(reMig.ok, true);
    assert.strictEqual(migration.isMigrated(db), true);

    console.log('Actual Production-Copy Migration Test: ALL CHECKS PASSED');
    return {
      ran: true,
      beforeCounts,
      afterCounts
    };
  } finally {
    try { fs.rmSync(testDbFile, { force: true }); } catch (_) {}
    try { fs.rmSync(testDbFile + '-wal', { force: true }); } catch (_) {}
    try { fs.rmSync(testDbFile + '-shm', { force: true }); } catch (_) {}
  }
}

function runAll() {
  testSyntheticProductionShapeMigration();
  const prodRes = testActualProductionCopyMigration();
  if (prodRes.ran) {
    console.log('\nBoth Synthetic and Actual Production-Copy migration tests completed successfully.');
  } else {
    console.log('\nSynthetic migration test completed successfully (actual production copy was unavailable).');
  }
}

runAll();
