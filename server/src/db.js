'use strict';
/**
 * PostgreSQL data-access layer (Neon-compatible).
 *
 * - One `pg` Pool configured exclusively from DATABASE_URL (never hardcoded
 *   credentials). SSL is enabled automatically for Neon hosts / sslmode=require
 *   and can be forced with PGSSLMODE=require.
 * - Type parsers keep the API contract identical to the previous SQLite build:
 *   TIMESTAMPTZ values come back as UTC ISO strings ("...T..:..:..SSSsZ"),
 *   DATE values as "YYYY-MM-DD", and int8 (COUNT/SUM) as JS numbers.
 * - Helpers q/q1/exec accept positional `?` placeholders (converted to $n
 *   outside string literals) and always use parameterized queries.
 * - withTx runs a callback inside a real BEGIN/COMMIT transaction on a single
 *   pooled client; the same helpers are available on the transaction handle.
 */
const { Pool, types: pgTypes } = require('pg');
const config = require('./config');

/* ---------------- type parsers: preserve the previous string contract ---------------- */

const toIsoUtc = (v) => (v === null ? null : new Date(v).toISOString());
pgTypes.setTypeParser(1114, toIsoUtc);            // timestamp (without tz)
pgTypes.setTypeParser(1184, toIsoUtc);            // timestamptz
pgTypes.setTypeParser(1082, (v) => v);            // date -> 'YYYY-MM-DD' string as-is
pgTypes.setTypeParser(20, (v) => Number.parseInt(v, 10));   // int8 (COUNT(*), SUM(int))
pgTypes.setTypeParser(1700, (v) => Number.parseFloat(v));   // numeric

/* ---------------- pool ---------------- */

let pool = null;

function sslConfigFor(url) {
  const mode = (process.env.PGSSLMODE || '').toLowerCase();
  if (mode === 'disable') return false;
  let host = '';
  let urlMode = '';
  try {
    const u = new URL(url);
    host = u.hostname;
    urlMode = (u.searchParams.get('sslmode') || '').toLowerCase();
  } catch { /* handled below */ }
  const wantsSsl = ['require', 'verify-ca', 'verify-full'].includes(mode)
    || ['require', 'verify-ca', 'verify-full'].includes(urlMode)
    || host.endsWith('.neon.tech');
  // Neon presents a publicly-trusted certificate; verify it.
  return wantsSsl ? { rejectUnauthorized: true } : false;
}

function getPool() {
  if (pool) return pool;
  if (!config.databaseUrl) {
    throw new Error('DATABASE_URL is not set. Configure the PostgreSQL (Neon) connection string in server/.env — see .env.example.');
  }
  pool = new Pool({
    connectionString: config.databaseUrl,
    ssl: sslConfigFor(config.databaseUrl),
    max: config.pgPoolMax,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
    application_name: 'clinic-portal-api',
    // Deterministic sessions: DATE <-> timestamptz casts and timestamp output
    // never depend on the server's default timezone (matches old SQLite UTC storage).
    options: '-c timezone=UTC',
  });
  // An idle client losing its connection (Neon suspends idle computes) must
  // not crash the process; the next query transparently reconnects.
  pool.on('error', (err) => {
    console.error('[db] idle client error (connection will be re-established):', err.message);
  });
  return pool;
}

async function closeDb() {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}

/* ---------------- SQL helpers ---------------- */

/**
 * Convert positional `?` placeholders to PostgreSQL `$n`, skipping anything
 * inside single-quoted strings, double-quoted identifiers and comments.
 */
function toDollarSql(sql) {
  if (!sql.includes('?')) return sql;
  let out = '';
  let n = 0;
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'") { // string literal ('' = escaped quote)
      out += ch; i++;
      while (i < sql.length) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { out += "''"; i += 2; continue; }
          out += "'"; i++; break;
        }
        out += sql[i]; i++;
      }
      continue;
    }
    if (ch === '"') { // quoted identifier
      out += ch; i++;
      while (i < sql.length) { out += sql[i]; if (sql[i] === '"') { i++; break; } i++; }
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') { // line comment
      while (i < sql.length && sql[i] !== '\n') { out += sql[i]; i++; }
      continue;
    }
    if (ch === '?' && sql[i + 1] !== '?') { out += `$${++n}`; i++; continue; }
    out += ch; i++;
  }
  return out;
}

function makeRunner(executor) {
  const run = async (sql, params = []) => executor.query(toDollarSql(sql), params);
  return {
    /** All matching rows. */
    async q(sql, params) { return (await run(sql, params)).rows; },
    /** First matching row or undefined. */
    async q1(sql, params) {
      const res = await run(sql, params);
      return res.rows[0];
    },
    /** INSERT/UPDATE/DELETE — returns { rowCount, rows } (use RETURNING for ids). */
    async exec(sql, params) {
      const res = await run(sql, params);
      return { rowCount: res.rowCount, rows: res.rows, lastInsertRowid: res.rows[0]?.id };
    },
    /** Raw pg query (already-$n SQL). */
    query: (sql, params) => executor.query(sql, params),
  };
}

const poolRunner = () => makeRunner(getPool());

async function q(sql, params) { return poolRunner().q(sql, params); }
async function q1(sql, params) { return poolRunner().q1(sql, params); }
async function exec(sql, params) { return poolRunner().exec(sql, params); }

/**
 * Run fn(t) inside a transaction; t exposes q/q1/exec/query bound to one client.
 * Commits on success, rolls back on any thrown error.
 */
async function withTx(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(makeRunner(client));
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connection may be gone */ }
    throw err;
  } finally {
    client.release();
  }
}

/** Connectivity probe used by /api/health and scripts/db-check.js. */
async function ping() {
  const row = await q1('SELECT 1 AS ok');
  return row?.ok === 1;
}

module.exports = { getPool, closeDb, q, q1, exec, withTx, ping, toDollarSql, makeRunner };
