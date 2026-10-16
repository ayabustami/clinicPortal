'use strict';
/**
 * PostgreSQL connectivity & migration check.
 * Usage: node scripts/db-check.js
 *
 * Prints a masked connection target (NEVER the full DSN or password),
 * server version, table count and migration status. Exits non-zero on failure.
 */
const db = require('../src/db');
const config = require('../src/config');
const { pendingMigrations } = require('../src/migrate');

function maskUrl(raw) {
  try {
    const u = new URL(raw);
    const host = `${u.hostname}${u.port ? `:${u.port}` : ''}`;
    return `postgres://${u.username ? `${u.username}:***@` : ''}${host}${u.pathname}${u.searchParams.has('sslmode') ? `?sslmode=${u.searchParams.get('sslmode')}` : ''}`;
  } catch {
    return '<unparseable DATABASE_URL>';
  }
}

async function main() {
  if (!config.databaseUrl) {
    console.error('[db-check] DATABASE_URL is not set. Copy .env.example to .env and configure it.');
    process.exit(2);
  }
  console.log(`[db-check] target: ${maskUrl(config.databaseUrl)}`);
  const ok = await db.ping();
  if (!ok) throw new Error('ping failed');
  const ver = await db.q1('SELECT version() AS v');
  console.log(`[db-check] connected: ${ver.v.split(',')[0]}`);

  const tables = await db.q(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);
  console.log(`[db-check] tables (${tables.length}): ${tables.map((t) => t.table_name).join(', ') || 'none'}`);

  const hasMig = tables.some((t) => t.table_name === 'schema_migrations');
  let pending;
  if (hasMig) {
    const applied = await db.q('SELECT version, applied_at FROM schema_migrations ORDER BY version');
    console.log(`[db-check] applied migrations: ${applied.map((m) => m.version).join(', ') || 'none'}`);
    const client = await db.getPool().connect();
    try {
      pending = await pendingMigrations(client);
    } finally {
      client.release();
    }
  } else {
    const client = await db.getPool().connect();
    try {
      await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
      pending = await pendingMigrations(client);
    } finally {
      client.release();
    }
  }
  console.log(pending.length
    ? `[db-check] PENDING migrations: ${pending.join(', ')} — run: npm run migrate`
    : '[db-check] schema is up to date');

  if (tables.length) {
    let total = 0;
    for (const t of tables) {
      const r = await db.q1(`SELECT COUNT(*) AS c FROM "${t.table_name}"`);
      total += Number(r.c);
    }
    console.log(`[db-check] total rows across all tables: ${total}`);
  }
  await db.closeDb();
  console.log('[db-check] OK');
}

main().catch(async (err) => {
  // Message only — never leak the DSN/stack with credentials.
  console.error(`[db-check] FAILED: ${err.message}`);
  try { await db.closeDb(); } catch { /* ignore */ }
  process.exit(1);
});
