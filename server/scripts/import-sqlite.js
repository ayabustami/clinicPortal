'use strict';
/**
 * One-time data import: legacy SQLite file -> PostgreSQL (Neon).
 *
 * Safety guarantees (by design):
 *  - The SQLite source is opened READ-ONLY and never modified. A VACUUM INTO
 *    backup is taken before anything else happens.
 *  - The PostgreSQL target is INSPECTED first. If it already contains rows in
 *    any data table, the import ABORTS with a per-table report (no mixing,
 *    no duplicates on re-run).
 *  - Migrations are applied first (idempotent), so the target schema always
 *    matches what this script expects.
 *  - Everything is inserted inside ONE transaction with explicit ids
 *    (parents before children, FK order); any invalid row aborts the whole
 *    import with the table + row id + reason. Nothing is silently skipped.
 *  - IDENTITY sequences are advanced past the imported MAX(id) afterwards.
 *  - schema_migrations is NOT imported: PostgreSQL keeps its own migration
 *    history (managed by npm run migrate).
 *
 * Usage:
 *   node scripts/import-sqlite.js [--source path/to/clinic-portal.db] [--dry-run]
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../src/config');
const db = require('../src/db');
const { migrate } = require('../src/migrate');

/** FK-safe order: parents before children. */
const TABLE_ORDER = [
  'clinics',
  'branches',
  'users',
  'doctors',
  'services',
  'patients',
  'doctor_unavailability',
  'appointments',
  'medical_records',
  'prescriptions',
  'attachments',
  'invoices',
  'invoice_items',
  'payments',
  'activity',
  'audit_logs',
  'dental_charts',
  'dental_findings',
  'dental_treatments',
  'dental_history',
];

function argVal(flag, def) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : def;
}
const DRY_RUN = process.argv.includes('--dry-run');
const SOURCE = path.resolve(argVal('--source', config.sqlitePath));

function fail(msg) {
  console.error(`[import] ABORTED: ${msg}`);
  process.exit(1);
}

/** Convert one SQLite value for a PostgreSQL column (strict: bad data aborts). */
function convert(table, row, col, value, pgType, nullable) {
  const bad = (why) => {
    throw new Error(`table "${table}" row id=${row.id ?? '?'} column "${col}": ${why} (value: ${JSON.stringify(value)})`);
  };
  if (value === null || value === undefined) {
    if (!nullable) bad('NULL is not allowed by the PostgreSQL schema');
    return null;
  }
  // SQLite frequently stores "not set" as '' in nullable columns.
  if (value === '' && (pgType === 'date' || pgType.includes('int') || pgType === 'timestamp with time zone')) {
    if (!nullable) bad('empty string is not allowed by the PostgreSQL schema');
    return null;
  }
  if (pgType === 'smallint' || pgType === 'integer' || pgType === 'bigint') {
    const n = Number(value);
    if (!Number.isInteger(n)) bad('expected an integer');
    return n;
  }
  if (pgType === 'date') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) bad('expected a YYYY-MM-DD date');
    return String(value);
  }
  if (pgType === 'timestamp with time zone' || pgType === 'timestamp without time zone') {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) bad('expected a valid ISO date-time');
    return d.toISOString();
  }
  // text / varchar / anything else: pass through as-is
  return String(value);
}

async function main() {
  if (!fs.existsSync(SOURCE)) fail(`SQLite source not found: ${SOURCE}`);
  console.log(`[import] source (read-only): ${SOURCE}`);
  console.log(`[import] target: PostgreSQL from DATABASE_URL (${DRY_RUN ? 'DRY RUN' : 'live import'})`);

  // 1) Backup the SQLite file first (VACUUM INTO = consistent snapshot).
  const backupDir = path.join(path.dirname(SOURCE), 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupPath = path.join(backupDir, `pre-import-${stamp}.db`);
  const sqlite = new Database(SOURCE, { readonly: true });
  try {
    sqlite.prepare('VACUUM INTO ?').run(backupPath);
    console.log(`[import] SQLite backup created: ${backupPath} (${fs.statSync(backupPath).size} bytes)`);

    // 2) Ensure the PostgreSQL schema is current, then INSPECT the target.
    await migrate();
    const occupied = [];
    for (const t of TABLE_ORDER) {
      const r = await db.q1(`SELECT COUNT(*) AS c FROM "${t}"`);
      if (Number(r.c) > 0) occupied.push(`${t}=${Number(r.c)}`);
    }
    if (occupied.length) {
      console.error('[import] The PostgreSQL target ALREADY CONTAINS DATA:');
      for (const o of occupied) console.error(`   ${o}`);
      console.error('[import] Importing into a non-empty database could duplicate or corrupt data.');
      console.error('[import] Use an empty database (or drop/recreate it), then re-run this script.');
      process.exit(2);
    }
    console.log('[import] target is empty — safe to import');

    // 3) Column metadata from both sides.
    const pgCols = {};
    for (const t of TABLE_ORDER) {
      pgCols[t] = await db.q(`
        SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ?
        ORDER BY ordinal_position
      `, [t]);
      if (!pgCols[t].length) fail(`table "${t}" does not exist in PostgreSQL — run migrations first`);
    }

    // 4) Read + convert + insert in ONE transaction, FK order, explicit ids.
    const imported = await db.withTx(async (tx) => {
      const counts = {};
      for (const t of TABLE_ORDER) {
        const sqliteCols = sqlite.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name);
        const pgByName = new Map(pgCols[t].map((c) => [c.column_name, c]));
        const missing = sqliteCols.filter((c) => !pgByName.has(c));
        if (missing.length) fail(`table "${t}": SQLite column(s) absent from PostgreSQL schema: ${missing.join(', ')}`);
        const cols = sqliteCols; // identical ordering on both sides by construction

        const rows = sqlite.prepare(`SELECT * FROM "${t}"`).all();
        counts[t] = rows.length;
        if (DRY_RUN || !rows.length) continue;

        const placeholders = cols.map(() => '?').join(', ');
        const sql = `INSERT INTO "${t}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${placeholders})`;
        for (const row of rows) {
          const values = cols.map((c) => {
            const meta = pgByName.get(c);
            return convert(t, row, c, row[c], meta.data_type, meta.is_nullable === 'YES');
          });
          try {
            await tx.exec(sql, values);
          } catch (err) {
            // Attribute the failure precisely, then abort the whole transaction.
            throw new Error(`INSERT failed for "${t}" id=${row.id ?? '?'}: ${err.message}`);
          }
        }
      }

      // 5) Advance IDENTITY sequences past the explicit ids we inserted.
      if (!DRY_RUN) {
        for (const t of TABLE_ORDER) {
          await tx.q1(`SELECT setval(pg_get_serial_sequence(?, 'id'), GREATEST((SELECT COALESCE(MAX(id), 1) FROM "${t}"), 1), true)`, [t]);
        }
      }
      return counts;
    });

    console.log(`[import] ${DRY_RUN ? 'DRY RUN — rows that WOULD be imported' : 'imported rows'} per table:`);
    let total = 0;
    for (const t of TABLE_ORDER) {
      console.log(`   ${t.padEnd(22)} ${String(imported[t]).padStart(6)}`);
      total += imported[t];
    }
    console.log(`   ${'TOTAL'.padEnd(22)} ${String(total).padStart(6)}`);
    if (!DRY_RUN) {
      console.log('[import] schema_migrations was intentionally NOT imported (PostgreSQL keeps its own history).');
      console.log('[import] Done. Verify with: node scripts/verify-import.js');
    }
  } finally {
    sqlite.close();
  }
  await db.closeDb();
}

main().catch(async (err) => {
  console.error(`[import] FAILED: ${err.message}`);
  try { await db.closeDb(); } catch { /* ignore */ }
  process.exit(1);
});
