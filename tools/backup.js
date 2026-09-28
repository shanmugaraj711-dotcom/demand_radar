'use strict';
// Consistent copy of the database (safe while the app is running). Keeps the newest 14. Run: node tools/backup.js
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const src = path.join(dataDir, 'radar.db');
if (!fs.existsSync(src)) { console.log('No database yet, nothing to back up.'); process.exit(0); }
const dir = path.join(dataDir, 'backups');
fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
const dest = path.resolve(dir, `radar-${stamp}.db`).split(path.sep).join("/");
if (fs.existsSync(dest)) fs.rmSync(dest);
const db = new DatabaseSync(src);
db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
db.close();
const files = fs.readdirSync(dir).filter((f) => /^radar-.*\.db$/.test(f)).sort();
for (const f of files.slice(0, Math.max(0, files.length - 14))) fs.rmSync(path.join(dir, f));
console.log(`Backup written: ${dest} (${(fs.statSync(dest).size / 1024).toFixed(0)} KB). Kept ${Math.min(files.length, 14)}.`);
