'use strict';
/**
 * Safe SQLite backup using VACUUM INTO — produces a consistent snapshot even
 * while the WAL-mode database is serving live traffic (never copy the raw .db
 * file of a running WAL database).
 *
 * NOTE: the production application runs on PostgreSQL. This script (and
 * scripts/import-sqlite.js) are the only remaining users of better-sqlite3 —
 * they exist to back up and migrate the LEGACY SQLite file. The source file is
 * opened READ-ONLY and is never modified.
 *
 * Usage: node scripts/backup.js [--keep N]   (default keeps last 14 backups)
 * Restore: stop the server, move the backup file over data/clinic-portal.db,
 *          delete any -wal/-shm files, restart, verify with npm test.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../src/config');

const keepIdx = process.argv.indexOf('--keep');
const keep = keepIdx >= 0 ? parseInt(process.argv[keepIdx + 1], 10) : 14;
if (!Number.isFinite(keep) || keep < 1) {
  console.error('[backup] --keep must be a positive integer');
  process.exit(1);
}

const src = path.resolve(config.sqlitePath);
if (!fs.existsSync(src)) {
  console.error(`[backup] SQLite file not found: ${src}`);
  process.exit(1);
}

const dir = path.join(path.dirname(src), 'backups');
fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const target = path.join(dir, `clinic-portal-${stamp}.db`);

const db = new Database(src, { readonly: true });
try {
  db.prepare('VACUUM INTO ?').run(target);
} finally {
  db.close();
}
console.log(`[backup] created ${target} (${fs.statSync(target).size} bytes)`);

const files = fs.readdirSync(dir)
  .filter((f) => f.startsWith('clinic-portal-') && f.endsWith('.db'))
  .sort();
while (files.length > keep) {
  const old = files.shift();
  fs.rmSync(path.join(dir, old));
  console.log(`[backup] pruned old backup ${old} (retention: ${keep})`);
}
