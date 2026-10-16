'use strict';
/**
 * Test-database bootstrap for the PostgreSQL build.
 *
 * Each test file gets its OWN derived database (e.g. clinic_portal_t_api),
 * created fresh in test.before and dropped in test.after — no shared state,
 * no top-level await needed (CommonJS): the DATABASE_URL swap is synchronous
 * and happens before any src module creates a pool (the pool is lazy).
 *
 * Requirements: the role in DATABASE_URL must have CREATEDB, and a
 * maintenance database named "postgres" must exist (true for local PG and
 * Neon branches).
 */
const path = require('path');
const { Client } = require('pg');

// Load server/.env exactly like src/config does, but WITHOUT importing config
// (tests must control the environment before config is first required).
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

function baseUrl() {
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    throw new Error('DATABASE_URL is not set — tests need a PostgreSQL instance (see .env.example)');
  }
  return new URL(raw);
}

function derivedName(suffix) {
  const base = decodeURIComponent(baseUrl().pathname.replace(/^\//, '')) || 'postgres';
  const name = `${base}_t_${suffix}`.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 63);
  return name;
}

function sslFor(u) {
  const mode = (u.searchParams.get('sslmode') || '').toLowerCase();
  if (['require', 'verify-ca', 'verify-full'].includes(mode) || u.hostname.endsWith('.neon.tech')) {
    return { rejectUnauthorized: true };
  }
  return false;
}

async function adminClient() {
  const u = baseUrl();
  const c = new Client({
    host: u.hostname,
    port: u.port || 5432,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: 'postgres',
    ssl: sslFor(u),
    connectionTimeoutMillis: 10000,
  });
  await c.connect();
  return c;
}

/**
 * SYNCHRONOUS: point process.env.DATABASE_URL at the derived test database.
 * Must run before any src/* module is required (pool creation is lazy, so no
 * connection happens until createTestDb()/first query).
 */
function pointAtTestDb(suffix) {
  const u = baseUrl();
  const name = derivedName(suffix);
  u.pathname = `/${encodeURIComponent(name)}`;
  process.env.DATABASE_URL = u.toString();
  process.env.__TEST_DB_NAME = name;
  return name;
}

/** ASYNC: (re)create the derived database. Call in test.before. */
async function createTestDb() {
  const name = process.env.__TEST_DB_NAME || derivedName('default');
  const admin = await adminClient();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
  return name;
}

/** ASYNC: close the app pool and drop the derived database. Call in test.after. */
async function destroyTestDb() {
  const name = process.env.__TEST_DB_NAME;
  try {
    const db = require('../../src/db');
    await db.closeDb();
  } catch { /* pool never opened */ }
  if (!name) return;
  const admin = await adminClient();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

module.exports = { pointAtTestDb, createTestDb, destroyTestDb, derivedName };
