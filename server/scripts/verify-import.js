'use strict';
/**
 * Post-import verification: SQLite source vs PostgreSQL target.
 *
 * Checks (all read-only on both sides):
 *  1. Row count per table must match exactly.
 *  2. users: every password_hash must be byte-identical (login continuity).
 *  3. Money invariants: SUM(total_cents) on invoices and SUM(amount_cents)
 *     on payments must match.
 *  4. FK integrity on the PostgreSQL side: zero orphan rows for the main
 *     relations (appointments->patients/doctors, invoices->patients,
 *     payments->invoices, prescriptions->medical_records).
 *  5. IDENTITY sequences must be ahead of MAX(id) (next insert won't clash).
 *
 * Usage: node scripts/verify-import.js [--source path/to/clinic-portal.db]
 * Exits 0 when everything matches, 1 otherwise.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../src/config');
const db = require('../src/db');

const TABLES = [
  'clinics', 'branches', 'users', 'doctors', 'services', 'patients',
  'doctor_unavailability', 'appointments', 'medical_records', 'prescriptions',
  'attachments', 'invoices', 'invoice_items', 'payments', 'activity',
  'audit_logs', 'dental_charts', 'dental_findings', 'dental_treatments', 'dental_history',
];

const FK_CHECKS = [
  ['appointments -> patients', 'SELECT COUNT(*) AS c FROM appointments a LEFT JOIN patients p ON p.id = a.patient_id WHERE p.id IS NULL'],
  ['appointments -> doctors', 'SELECT COUNT(*) AS c FROM appointments a LEFT JOIN doctors d ON d.id = a.doctor_id WHERE d.id IS NULL'],
  ['invoices -> patients', 'SELECT COUNT(*) AS c FROM invoices i LEFT JOIN patients p ON p.id = i.patient_id WHERE p.id IS NULL'],
  ['payments -> invoices', 'SELECT COUNT(*) AS c FROM payments pm LEFT JOIN invoices i ON i.id = pm.invoice_id WHERE i.id IS NULL'],
  ['prescriptions -> medical_records', 'SELECT COUNT(*) AS c FROM prescriptions rx LEFT JOIN medical_records r ON r.id = rx.record_id WHERE r.id IS NULL'],
  ['dental_findings -> patients', 'SELECT COUNT(*) AS c FROM dental_findings f LEFT JOIN patients p ON p.id = f.patient_id WHERE p.id IS NULL'],
];

function argVal(flag, def) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : def;
}
const SOURCE = path.resolve(argVal('--source', config.sqlitePath));

let failures = 0;
function report(ok, label, detail) {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

async function main() {
  if (!fs.existsSync(SOURCE)) {
    console.error(`[verify] SQLite source not found: ${SOURCE}`);
    process.exit(1);
  }
  const sqlite = new Database(SOURCE, { readonly: true });
  try {
    console.log('[verify] 1) Row counts per table (SQLite -> PostgreSQL)');
    for (const t of TABLES) {
      const s = sqlite.prepare(`SELECT COUNT(*) AS c FROM "${t}"`).get().c;
      const p = Number((await db.q1(`SELECT COUNT(*) AS c FROM "${t}"`)).c);
      report(s === p, t.padEnd(22), `${s} -> ${p}`);
    }

    console.log('[verify] 2) Password hashes identical (users)');
    const sUsers = sqlite.prepare('SELECT id, email, password_hash FROM users ORDER BY id').all();
    const pUsers = await db.q('SELECT id, email, password_hash FROM users ORDER BY id');
    const pMap = new Map(pUsers.map((u) => [u.id, u]));
    let hashMismatch = 0;
    for (const u of sUsers) {
      const p = pMap.get(u.id);
      if (!p || p.password_hash !== u.password_hash || p.email !== u.email) hashMismatch += 1;
    }
    report(hashMismatch === 0 && sUsers.length === pUsers.length, 'users.password_hash/email', `${sUsers.length} users checked, ${hashMismatch} mismatches`);

    console.log('[verify] 3) Money invariants');
    const sInv = sqlite.prepare('SELECT COALESCE(SUM(total_cents),0) AS s FROM invoices').get().s;
    const pInv = Number((await db.q1('SELECT COALESCE(SUM(total_cents),0) AS s FROM invoices')).s);
    report(sInv === pInv, 'SUM(invoices.total_cents)', `${sInv} -> ${pInv}`);
    const sPay = sqlite.prepare('SELECT COALESCE(SUM(amount_cents),0) AS s FROM payments').get().s;
    const pPay = Number((await db.q1('SELECT COALESCE(SUM(amount_cents),0) AS s FROM payments')).s);
    report(sPay === pPay, 'SUM(payments.amount_cents)', `${sPay} -> ${pPay}`);

    console.log('[verify] 4) FK integrity on the PostgreSQL side (orphans must be 0)');
    for (const [label, sql] of FK_CHECKS) {
      const c = Number((await db.q1(sql)).c);
      report(c === 0, label, `${c} orphans`);
    }

    console.log('[verify] 5) IDENTITY sequences ahead of MAX(id)');
    for (const t of TABLES) {
      const seq = await db.q1('SELECT pg_get_serial_sequence(?, \'id\') AS seq', [t]);
      if (!seq || !seq.seq) { report(false, `${t}.id sequence`, 'no sequence found'); continue; }
      const st = await db.q1(`SELECT last_value, is_called FROM ${seq.seq}`);
      const maxId = Number((await db.q1(`SELECT COALESCE(MAX(id),0) AS m FROM "${t}"`)).m);
      const next = Number(st.last_value) + (st.is_called ? 1 : 0);
      report(next > maxId || maxId === 0, `${t.padEnd(22)}`, `next=${next}, max_id=${maxId}`);
    }

    console.log(failures === 0
      ? '\n[verify] ALL CHECKS PASSED'
      : `\n[verify] ${failures} CHECK(S) FAILED — do not use this database until resolved`);
  } finally {
    sqlite.close();
  }
  await db.closeDb();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(`[verify] FAILED: ${err.message}`);
  try { await db.closeDb(); } catch { /* ignore */ }
  process.exit(1);
});
