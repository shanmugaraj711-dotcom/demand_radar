'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const migration = require('./migration');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS cache(k TEXT PRIMARY KEY, v TEXT, exp INTEGER);
CREATE TABLE IF NOT EXISTS usage(day TEXT, api TEXT, n INTEGER DEFAULT 0, PRIMARY KEY(day, api));
CREATE TABLE IF NOT EXISTS searches(
  id INTEGER PRIMARY KEY AUTOINCREMENT, seed TEXT, country TEXT, lang TEXT, city TEXT, depth TEXT, sources TEXT,
  requests INTEGER DEFAULT 0, phrases INTEGER DEFAULT 0, status TEXT, note TEXT, created INTEGER, finished INTEGER);
CREATE TABLE IF NOT EXISTS keywords(
  id INTEGER PRIMARY KEY AUTOINCREMENT, search_id INTEGER, phrase TEXT, sources TEXT, occ INTEGER, score INTEGER,
  band TEXT, intent TEXT, place TEXT, fringe INTEGER DEFAULT 0, UNIQUE(search_id, phrase));
CREATE INDEX IF NOT EXISTS kw_search ON keywords(search_id, score DESC);
CREATE TABLE IF NOT EXISTS leads(
  id INTEGER PRIMARY KEY AUTOINCREMENT, place_id TEXT, name TEXT, address TEXT, area TEXT, city TEXT,
  phone TEXT, wa TEXT, phone_type TEXT, website TEXT, email TEXT, instagram TEXT, facebook TEXT,
  rating REAL, reviews INTEGER, maps_url TEXT, lat REAL, lng REAL, source TEXT, query TEXT, seed TEXT,
  signals TEXT, extra TEXT, score INTEGER DEFAULT 0, stage TEXT DEFAULT 'new', lang TEXT DEFAULT 'en',
  contact_name TEXT, notes TEXT, touches INTEGER DEFAULT 0, next_action TEXT, next_followup INTEGER,
  last_contacted INTEGER, pilot_start INTEGER, lost_reason TEXT, enriched INTEGER DEFAULT 0,
  created INTEGER, updated INTEGER);
CREATE UNIQUE INDEX IF NOT EXISTS leads_place ON leads(place_id) WHERE place_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS leads_wa ON leads(wa);
CREATE INDEX IF NOT EXISTS leads_stage ON leads(stage, next_followup);
CREATE TABLE IF NOT EXISTS demand_signals(
  id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, source_id TEXT, content_hash TEXT UNIQUE NOT NULL, raw_text TEXT NOT NULL, entity_name TEXT, location_hint TEXT, detected_need TEXT, intent_class TEXT, confidence_score REAL DEFAULT 0.0, source_url TEXT, observed_at TEXT, created_at INTEGER, lat REAL, lng REAL
);
CREATE INDEX IF NOT EXISTS demand_signals_observed ON demand_signals(observed_at);
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
CREATE TABLE IF NOT EXISTS lead_opportunities(
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
CREATE INDEX IF NOT EXISTS lead_opp_status ON lead_opportunities(status, updated_at);
CREATE INDEX IF NOT EXISTS lead_opp_product ON lead_opportunities(product_id);
CREATE TRIGGER IF NOT EXISTS lead_opportunities_status_insert BEFORE INSERT ON lead_opportunities WHEN NEW.status NOT IN ('unreviewed','human_confirmed','rejected') BEGIN SELECT RAISE(ABORT, 'invalid opportunity status'); END;
CREATE TRIGGER IF NOT EXISTS lead_opportunities_status_update BEFORE UPDATE OF status ON lead_opportunities WHEN NEW.status NOT IN ('unreviewed','human_confirmed','rejected') BEGIN SELECT RAISE(ABORT, 'invalid opportunity status'); END;
CREATE TRIGGER IF NOT EXISTS lead_opportunities_product_immutable BEFORE UPDATE OF product_id ON lead_opportunities WHEN OLD.product_id IS NOT NULL AND NEW.product_id != OLD.product_id BEGIN SELECT RAISE(ABORT, 'product_id is immutable'); END;
CREATE TABLE IF NOT EXISTS activities(
  id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id INTEGER, type TEXT, step TEXT, lang TEXT, body TEXT, at INTEGER);
CREATE INDEX IF NOT EXISTS act_lead ON activities(lead_id, at);
CREATE INDEX IF NOT EXISTS act_at ON activities(at);
`;

function open(file, { autoMigrate = true } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;');
  db.exec(SCHEMA);
  if (autoMigrate) {
    const migrated = migration.isMigrated(db);
    const hasProducts = db.prepare('SELECT COUNT(*) n FROM products').get().n > 0;
    if (!migrated || !hasProducts) {
      migration.migrate(db);
    }
  }
  return db;
}

function tx(db, fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

const jget = (db, k, def) => {
  const r = db.prepare('SELECT v FROM settings WHERE k=?').get(k);
  if (!r) return def;
  try { return JSON.parse(r.v); } catch { return def; }
};
const jset = (db, k, v) => db.prepare('INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, JSON.stringify(v));

const cacheGet = (db, k) => {
  const r = db.prepare('SELECT v, exp FROM cache WHERE k=?').get(k);
  if (!r || r.exp < Date.now()) return null;
  try { return JSON.parse(r.v); } catch { return null; }
};
const cacheSet = (db, k, v, ttlMs) => db.prepare('INSERT INTO cache(k,v,exp) VALUES(?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, exp=excluded.exp').run(k, JSON.stringify(v), Date.now() + ttlMs);

const bump = (db, api, n = 1, day = new Date().toISOString().slice(0, 10)) =>
  db.prepare('INSERT INTO usage(day,api,n) VALUES(?,?,?) ON CONFLICT(day,api) DO UPDATE SET n=n+excluded.n').run(day, api, n);
const usedToday = (db, api, day = new Date().toISOString().slice(0, 10)) =>
  (db.prepare('SELECT n FROM usage WHERE day=? AND api=?').get(day, api) || { n: 0 }).n;

module.exports = { open, tx, jget, jset, cacheGet, cacheSet, bump, usedToday };
