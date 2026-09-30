'use strict';

const productsLib = require('./products');

function isMigrated(db) {
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='lead_opportunities'").get();
  const hasProducts = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='products'").get();
  if (!hasProducts || !table) return false;
  return table.sql.includes('product_id') && table.sql.includes('UNIQUE(lead_id, demand_signal_id, product_id)');
}

function migrate(db) {
  // 1. Create products table
  db.exec(`
    CREATE TABLE IF NOT EXISTS products(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      topic TEXT NOT NULL,
      target_org TEXT DEFAULT 'business',
      link TEXT,
      offer TEXT,
      target_keywords TEXT,
      templates TEXT,
      active INTEGER DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS products_active ON products(active, updated_at DESC);
  `);

  // 2. Ensure initial product is seeded from existing settings
  const activeProduct = productsLib.seedDefaultProduct(db);
  const defaultProductId = activeProduct ? activeProduct.id : 1;

  // 3. Check lead_opportunities table schema
  const oppTable = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='lead_opportunities'").get();
  if (oppTable) {
    const isAlreadyMigrated = oppTable.sql.includes('product_id') &&
      oppTable.sql.includes('UNIQUE(lead_id, demand_signal_id, product_id)');

    if (!isAlreadyMigrated) {
      const cols = db.prepare("PRAGMA table_info(lead_opportunities)").all().map(c => c.name);
      const hasProdCol = cols.includes('product_id');

      db.exec('PRAGMA foreign_keys=OFF;');
      db.exec('BEGIN TRANSACTION;');
      try {
        db.exec(`
          CREATE TABLE lead_opportunities_new(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
            demand_signal_id INTEGER REFERENCES demand_signals(id) ON DELETE CASCADE,
            product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
            lead_reason TEXT NOT NULL,
            evidence TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'unreviewed' CHECK(status IN ('unreviewed','human_confirmed','rejected')),
            confirmed_at INTEGER,
            confirmed_by TEXT,
            updated_at INTEGER,
            UNIQUE(lead_id, demand_signal_id, product_id)
          );
        `);

        const prodExpr = hasProdCol ? `COALESCE(product_id, ${defaultProductId})` : `${defaultProductId}`;

        db.exec(`
          INSERT INTO lead_opportunities_new(id, lead_id, demand_signal_id, product_id, lead_reason, evidence, status, confirmed_at, confirmed_by, updated_at)
          SELECT id, lead_id, demand_signal_id, ${prodExpr}, lead_reason, evidence, status, confirmed_at, confirmed_by, updated_at
          FROM lead_opportunities;
        `);

        // Drop triggers on old table
        db.exec(`
          DROP TRIGGER IF EXISTS lead_opportunities_status_insert;
          DROP TRIGGER IF EXISTS lead_opportunities_status_update;
          DROP TRIGGER IF EXISTS lead_opportunities_product_immutable;
          DROP TABLE lead_opportunities;
          ALTER TABLE lead_opportunities_new RENAME TO lead_opportunities;
        `);

        // Recreate indexes and triggers
        db.exec(`
          CREATE INDEX IF NOT EXISTS lead_opp_status ON lead_opportunities(status, updated_at);
          CREATE INDEX IF NOT EXISTS lead_opp_product ON lead_opportunities(product_id);
          CREATE TRIGGER IF NOT EXISTS lead_opportunities_status_insert BEFORE INSERT ON lead_opportunities WHEN NEW.status NOT IN ('unreviewed','human_confirmed','rejected') BEGIN SELECT RAISE(ABORT, 'invalid opportunity status'); END;
          CREATE TRIGGER IF NOT EXISTS lead_opportunities_status_update BEFORE UPDATE OF status ON lead_opportunities WHEN NEW.status NOT IN ('unreviewed','human_confirmed','rejected') BEGIN SELECT RAISE(ABORT, 'invalid opportunity status'); END;
          CREATE TRIGGER IF NOT EXISTS lead_opportunities_product_immutable BEFORE UPDATE OF product_id ON lead_opportunities WHEN OLD.product_id IS NOT NULL AND NEW.product_id != OLD.product_id BEGIN SELECT RAISE(ABORT, 'product_id is immutable'); END;
        `);

        db.exec('COMMIT;');
      } catch (err) {
        db.exec('ROLLBACK;');
        throw err;
      } finally {
        db.exec('PRAGMA foreign_keys=ON;');
      }
    } else {
      // Ensure index and triggers exist
      db.exec(`
        CREATE INDEX IF NOT EXISTS lead_opp_status ON lead_opportunities(status, updated_at);
        CREATE INDEX IF NOT EXISTS lead_opp_product ON lead_opportunities(product_id);
        CREATE TRIGGER IF NOT EXISTS lead_opportunities_status_insert BEFORE INSERT ON lead_opportunities WHEN NEW.status NOT IN ('unreviewed','human_confirmed','rejected') BEGIN SELECT RAISE(ABORT, 'invalid opportunity status'); END;
        CREATE TRIGGER IF NOT EXISTS lead_opportunities_status_update BEFORE UPDATE OF status ON lead_opportunities WHEN NEW.status NOT IN ('unreviewed','human_confirmed','rejected') BEGIN SELECT RAISE(ABORT, 'invalid opportunity status'); END;
        CREATE TRIGGER IF NOT EXISTS lead_opportunities_product_immutable BEFORE UPDATE OF product_id ON lead_opportunities WHEN OLD.product_id IS NOT NULL AND NEW.product_id != OLD.product_id BEGIN SELECT RAISE(ABORT, 'product_id is immutable'); END;
      `);
    }
  }

  const fk = db.prepare('PRAGMA foreign_key_check').all();
  if (fk && fk.length > 0) {
    throw new Error('Foreign key violations detected after migration: ' + JSON.stringify(fk));
  }
  const ic = db.prepare('PRAGMA integrity_check').get();
  if (!ic || ic.integrity_check !== 'ok') {
    throw new Error('Database integrity check failed: ' + JSON.stringify(ic));
  }

  return { ok: true, activeProduct };
}

function rollback(db) {
  const oppTable = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='lead_opportunities'").get();
  if (!oppTable) return { ok: true, rolledBack: false };

  db.exec('PRAGMA foreign_keys=OFF;');
  db.exec('BEGIN TRANSACTION;');
  try {
    db.exec(`
      CREATE TABLE lead_opportunities_rollback(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
        demand_signal_id INTEGER REFERENCES demand_signals(id) ON DELETE CASCADE,
        lead_reason TEXT NOT NULL,
        evidence TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'unreviewed' CHECK(status IN ('unreviewed','human_confirmed','rejected')),
        confirmed_at INTEGER,
        confirmed_by TEXT,
        updated_at INTEGER,
        UNIQUE(lead_id, demand_signal_id)
      );
    `);

    // In case there were multiple opportunities for the same (lead_id, demand_signal_id) with different products,
    // take the latest updated one to respect UNIQUE(lead_id, demand_signal_id)
    db.exec(`
      INSERT INTO lead_opportunities_rollback(id, lead_id, demand_signal_id, lead_reason, evidence, status, confirmed_at, confirmed_by, updated_at)
      SELECT id, lead_id, demand_signal_id, lead_reason, evidence, status, confirmed_at, confirmed_by, updated_at
      FROM lead_opportunities
      WHERE id IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (PARTITION BY lead_id, demand_signal_id ORDER BY updated_at DESC, id DESC) as rn
          FROM lead_opportunities
        ) WHERE rn = 1
      );
    `);

    db.exec(`
      DROP TRIGGER IF EXISTS lead_opportunities_status_insert;
      DROP TRIGGER IF EXISTS lead_opportunities_status_update;
      DROP TRIGGER IF EXISTS lead_opportunities_product_immutable;
      DROP TABLE lead_opportunities;
      ALTER TABLE lead_opportunities_rollback RENAME TO lead_opportunities;
      CREATE INDEX IF NOT EXISTS lead_opp_status ON lead_opportunities(status, updated_at);
      CREATE TRIGGER IF NOT EXISTS lead_opportunities_status_insert BEFORE INSERT ON lead_opportunities WHEN NEW.status NOT IN ('unreviewed','human_confirmed','rejected') BEGIN SELECT RAISE(ABORT, 'invalid opportunity status'); END;
      CREATE TRIGGER IF NOT EXISTS lead_opportunities_status_update BEFORE UPDATE OF status ON lead_opportunities WHEN NEW.status NOT IN ('unreviewed','human_confirmed','rejected') BEGIN SELECT RAISE(ABORT, 'invalid opportunity status'); END;
    `);

    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys=ON;');
  }

  const ic = db.prepare('PRAGMA integrity_check').get();
  if (!ic || ic.integrity_check !== 'ok') {
    throw new Error('Database integrity check failed during rollback: ' + JSON.stringify(ic));
  }

  return { ok: true, rolledBack: true };
}

module.exports = {
  isMigrated,
  migrate,
  rollback,
};
