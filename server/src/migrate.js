'use strict';
/**
 * PostgreSQL migration runner.
 * - Applies .sql files from src/migrations/pg in lexicographic order.
 * - Each file runs inside its own transaction; applied versions are tracked
 *   in schema_migrations (same concept as the previous SQLite runner).
 * - Never destructive to existing data.
 *
 * The historical SQLite migrations remain in src/migrations/*.sql|js for
 * reference and for scripts/import-sqlite.js (which reads an existing SQLite
 * database); they are NOT executed against PostgreSQL.
 */
const fs = require('fs');
const path = require('path');
const { getPool, closeDb } = require('./db');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations', 'pg');

async function ensureMigrationsTable(client) {
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
}

async function pendingMigrations(client) {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  const applied = new Set(
    (await client.query('SELECT version FROM schema_migrations')).rows.map((r) => r.version)
  );
  return files.filter((f) => !applied.has(f));
}

async function migrate() {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await ensureMigrationsTable(client);
    const pending = await pendingMigrations(client);
    for (const file of pending) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch { /* ignore */ }
        err.message = `Migration ${file} failed: ${err.message}`;
        throw err;
      }
      console.log(`[migrate] applied ${file}`);
    }
    if (pending.length === 0) console.log('[migrate] schema up to date');
    return pending;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  migrate()
    .then(() => closeDb())
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[migrate]', err.message);
      process.exit(1);
    });
}

module.exports = { migrate, pendingMigrations };
