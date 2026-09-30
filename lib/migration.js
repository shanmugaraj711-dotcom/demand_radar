'use strict';

const productsLib = require('./products');

// Legacy production configuration fixture used strictly as migration data
// to seed the pre-Phase-1 configured product into the products table.
const LEGACY_PRODUCTION_CONFIG = {
  product: 'Abacus Buddy AI',
  topic: 'abacus',
  org: 'centre',
  link: 'https://abacus.promptstudioai.in',
  offer: '2 free student accounts are for you to test and show the app. Other students\' parents can unlock the full app, and your centre earns a share for each one.',
  target_keywords: ['abacus', 'abacus classes', 'vedic maths', 'mental arithmetic'],
  templates: {
    first_en: '{hello}\nI\'m {sender} from {product}. We made a phone app where kids practise {topic} at home with a friendly character.\n{area_line}\nWould you like to try it free? Here is the link: {link}\nIf you find it useful, we can talk about how it can help your {org}. No pressure.',
    first_ta: 'வணக்கம் 🙏\nநான் {sender}, {product} சார்பாக பேசுகிறேன். குழந்தைகள் வீட்டிலேயே {topic} பயிற்சி செய்ய ஒரு மொபைல் ஆப் உருவாக்கியுள்ளோம்.\nஇலவசமாக பார்த்துவிட்டு சொல்லுங்கள்: {link}\nபிடித்திருந்தால் அதைப் பற்றி பேசலாம். நன்றி 🙏',
    followup1_en: '{hello}\nDid you get a chance to look at the link? Happy to answer any questions or show a 5-minute demo whenever you\'re free.',
    followup1_ta: 'வணக்கம் 🙏\nநான் அனுப்பிய லிங்க்கைப் பார்க்க முடிந்ததா? ஏதேனும் சந்தேகம் இருந்தால் கேளுங்கள். உங்களுக்கு வசதியான நேரத்தில் 5 நிமிட டெமோவும் காட்டுகிறேன்.',
    call_en: 'Hello, I\'m {sender} from {product}. I sent you a WhatsApp about a free {topic} practice app for kids. Do you have one minute?\n\n(If yes) Kids practise {topic} at home with a friendly character. You can try it free and see if your students like it. Shall I send the details again?\n(If busy) No problem. When is a better time to call?',
    details_en: 'Thank you 🙏 Here are the details. {offer}\nYou can try the app here: {link}\nMay I know your name? I am happy to answer any questions or do a 10-minute video demo.',
    details_ta: 'நன்றி 🙏 விவரங்கள் இதோ. {offer}\nஆப்பை இங்கே பார்க்கலாம்: {link}\nஉங்கள் பெயர் தெரிந்துகொள்ளலாமா? சந்தேகங்கள் இருந்தால் கேளுங்கள், 10 நிமிட வீடியோ டெமோவும் காட்டலாம்.',
    nudge_en: '{hello}\nJust checking if you had a chance to read the details. Happy to do a 10-minute video demo whenever it suits you.',
    nudge_ta: 'வணக்கம் 🙏\nவிவரங்களைப் படிக்க முடிந்ததா? உங்களுக்கு வசதியான நேரத்தில் 10 நிமிட வீடியோ டெமோ காட்டுகிறேன்.',
    has_app_en: 'Thank you for telling me. Please keep your app. This is only for children\'s daily 10-minute {topic} practice at home. Could you try it with 2 students alongside your app? May I ask which app you use and what the children use it for?',
    checkin3_en: '{hello}\nHow are the students finding the app? Is anything confusing for them or the parents? Happy to fix it quickly.',
    checkin7_en: '{hello}\nIt has been a week. How many students practised? If you like, I can send a short message for your parents\' group.',
    review30_en: '{hello}\nThe 30-day trial is complete. Could we speak for 10 minutes about what worked and how to continue with your {org}?'
  }
};

function isMigrated(db) {
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='lead_opportunities'").get();
  const hasProducts = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='products'").get();
  if (!hasProducts || !table) return false;
  return table.sql.includes('product_id') && table.sql.includes('UNIQUE(lead_id, demand_signal_id, product_id)');
}

function migrate(db, options = {}) {
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

  // 2. Ensure initial product is seeded from existing profile settings or migration data
  let activeProduct = productsLib.getActiveProduct(db);
  if (!activeProduct) {
    let seedConfig = options.defaultProduct || null;
    if (!seedConfig) {
      try {
        const raw = db.prepare("SELECT v FROM settings WHERE k='profile'").get();
        if (raw && raw.v) seedConfig = JSON.parse(raw.v);
      } catch {
        seedConfig = null;
      }
    }
    // If neither profile nor options provide product info, fall back to legacy production migration config
    if (!seedConfig) {
      seedConfig = LEGACY_PRODUCTION_CONFIG;
    }
    activeProduct = productsLib.seedDefaultProduct(db, seedConfig);
  }
  const defaultProductId = activeProduct ? activeProduct.id : null;
  if (!defaultProductId) {
    throw new Error('Migration failed: no active product could be established.');
  }

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

  db.exec('PRAGMA foreign_keys=ON;');
  const fkSetting = db.prepare('PRAGMA foreign_keys').get();
  const fkVal = fkSetting ? Object.values(fkSetting)[0] : 0;
  if (fkVal !== 1) {
    throw new Error('PRAGMA foreign_keys is not ON after migration');
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

  // Check if it's currently on the migrated schema
  const isMigratedSchema = oppTable.sql.includes('product_id') && oppTable.sql.includes('UNIQUE(lead_id, demand_signal_id, product_id)');
  if (!isMigratedSchema) {
    return { ok: true, rolledBack: false, message: 'Already on pre-migration schema' };
  }

  // Check for multi-product opportunities sharing the same (lead_id, demand_signal_id)
  const conflicts = db.prepare(`
    SELECT lead_id, demand_signal_id, COUNT(*) as cnt
    FROM lead_opportunities
    GROUP BY lead_id, demand_signal_id
    HAVING cnt > 1
  `).all();

  if (conflicts && conflicts.length > 0) {
    throw new Error('Rollback blocked: multi-product opportunities cannot be represented by the pre-Phase-1 schema without data loss.');
  }

  // Record pre-rollback count to ensure zero data loss
  const preCount = db.prepare('SELECT COUNT(*) n FROM lead_opportunities').get().n;

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

    // Copy ALL rows 1:1 since no conflicts exist
    db.exec(`
      INSERT INTO lead_opportunities_rollback(id, lead_id, demand_signal_id, lead_reason, evidence, status, confirmed_at, confirmed_by, updated_at)
      SELECT id, lead_id, demand_signal_id, lead_reason, evidence, status, confirmed_at, confirmed_by, updated_at
      FROM lead_opportunities;
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

  // Verify foreign_keys is 1
  const fkSetting = db.prepare('PRAGMA foreign_keys').get();
  const fkVal = fkSetting ? Object.values(fkSetting)[0] : 0;
  if (fkVal !== 1) {
    throw new Error('PRAGMA foreign_keys is not ON after rollback');
  }

  // Verify exact row count preserved
  const postCount = db.prepare('SELECT COUNT(*) n FROM lead_opportunities').get().n;
  if (postCount !== preCount) {
    throw new Error(`Data loss detected during rollback: expected ${preCount} rows, got ${postCount}`);
  }

  const fk = db.prepare('PRAGMA foreign_key_check').all();
  if (fk && fk.length > 0) {
    throw new Error('Foreign key violations detected after rollback: ' + JSON.stringify(fk));
  }
  const ic = db.prepare('PRAGMA integrity_check').get();
  if (!ic || ic.integrity_check !== 'ok') {
    throw new Error('Database integrity check failed during rollback: ' + JSON.stringify(ic));
  }

  return { ok: true, rolledBack: true, rowCount: postCount };
}

module.exports = {
  LEGACY_PRODUCTION_CONFIG,
  isMigrated,
  migrate,
  rollback,
};
