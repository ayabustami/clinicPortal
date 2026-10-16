'use strict';
/**
 * Seed script — fictional demo data for two independent clinics.
 * Run: npm run seed          (skips if data exists)
 *      npm run seed -- --reset  (wipes and re-seeds)
 *
 * PostgreSQL: explicit ids are never inserted, so IDENTITY sequences stay in
 * sync automatically. --reset uses TRUNCATE ... RESTART IDENTITY CASCADE.
 *
 * All names, patients and contact details are invented. No real data.
 */
const db = require('./db');
const { migrate } = require('./migrate');
const { hashPassword } = require('./auth');
const { wallToUtc, wallParts, addMinutes, nowIso, todayLocalDate } = require('./util/time');
const { normalizeArabic } = require('./util/arabic');

// Deterministic RNG so the demo is reproducible
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}
const rand = mulberry32(20261012);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const randInt = (min, max) => min + Math.floor(rand() * (max - min + 1));

const DEMO_PASSWORD = 'Demo1234!';

const FIRST = ['Sami', 'Nadia', 'Yusuf', 'Aya', 'Tariq', 'Huda', 'Karim', 'Salma', 'Mazen', 'Noor', 'Fadi', 'Yara', 'Hassan', 'Reem', 'Ziad', 'Mona', 'Anas', 'Dana', 'Basil', 'Hana', 'Omar', 'Leila', 'Nader', 'Rita'];
const LAST = ['Qasem', 'Amari', 'Zidan', 'Mansour', 'Khalidi', 'Barakat', 'Suleiman', 'Idris', 'Rahhal', 'Najjar', 'Awad', 'Tamimi', 'Sabbagh', 'Jaber', 'Qaddoura', 'Halabi', 'Massad', 'Kanaan', 'Bishara', 'Safadi'];

function personName(usedNames) {
  for (let i = 0; i < 60; i++) {
    const n = `${pick(FIRST)} ${pick(LAST)}`;
    if (!usedNames.has(n)) { usedNames.add(n); return n; }
  }
  return `${pick(FIRST)} ${pick(LAST)} ${randInt(2, 99)}`;
}

/** All tables cleared by --reset, children before parents. */
const RESET_TABLES = [
  'dental_history', 'dental_treatments', 'dental_findings', 'dental_charts',
  'payments', 'invoice_items', 'invoices', 'prescriptions', 'medical_records',
  'doctor_unavailability', 'appointments', 'attachments', 'activity', 'audit_logs',
  'patients', 'services', 'branches', 'doctors', 'users', 'clinics',
];

async function main() {
  await migrate();

  // Production safeguard: demo seeding is a development-only operation.
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DESTRUCTIVE_SEED !== 'YES') {
    console.error('[seed] Refusing to seed in production. Demo data must never be inserted into a production database.');
    console.error('[seed] If you truly intend this, re-run with ALLOW_DESTRUCTIVE_SEED=YES.');
    process.exit(1);
  }

  const reset = process.argv.includes('--reset');
  const existing = Number((await db.q1('SELECT COUNT(*) AS c FROM clinics')).c);
  if (existing > 0 && !reset) {
    console.log('[seed] Database already contains data. Run "npm run seed -- --reset" to wipe and re-seed.');
    await db.closeDb();
    return;
  }

  if (existing > 0) {
    console.log('[seed] --reset given: clearing existing data...');
    await db.exec(`TRUNCATE TABLE ${RESET_TABLES.join(", ")} RESTART IDENTITY CASCADE`);
  }

  const now = nowIso();
  const pwHash = hashPassword(DEMO_PASSWORD);
  const usedNames = new Set();

  const SYMPTOMS = ['Headache and mild fever', 'Persistent cough for one week', 'Routine follow-up visit', 'Lower back pain', 'Seasonal allergy symptoms', 'Fatigue and dizziness', 'Sore throat and congestion', 'Elevated blood pressure reading', 'Abdominal discomfort', 'Sprained ankle during exercise'];
  const DIAGNOSES = ['Viral upper respiratory infection', 'Seasonal allergic rhinitis', 'Tension headache', 'Mild lumbar strain', 'Controlled hypertension', 'Acute pharyngitis', 'Gastroesophageal reflux', 'Ankle sprain, grade I', 'General wellness, no acute findings', 'Mild dehydration'];
  const TREATMENTS = ['Rest, fluids and symptomatic relief', 'Prescribed medication course', 'Referred for bloodwork', 'Physiotherapy exercises recommended', 'Dietary and lifestyle guidance', 'Observation; review in one week', 'Cold compress and elevation', 'Adjusted ongoing medication dosage'];
  const MEDS = [
    { medication: 'Paracetamol 500mg', dosage: '1 tablet', frequency: 'Every 8 hours', duration: '5 days' },
    { medication: 'Amoxicillin 500mg', dosage: '1 capsule', frequency: '3 times daily', duration: '7 days' },
    { medication: 'Cetirizine 10mg', dosage: '1 tablet', frequency: 'Once daily', duration: '10 days' },
    { medication: 'Ibuprofen 400mg', dosage: '1 tablet', frequency: 'Twice daily after food', duration: '5 days' },
    { medication: 'Omeprazole 20mg', dosage: '1 capsule', frequency: 'Once daily before breakfast', duration: '14 days' },
  ];

  const clinicDefs = [
    {
      name: 'Al Amal Family Clinic', slug: 'al-amal-family-clinic',
      email: 'hello@alamalclinic.demo', phone: '+970 9 555 0101',
      address: '14 Fictional Olive Street, Nablus', timezone: 'Asia/Hebron', slot: 30,
      hours: { '0': { start: '08:00', end: '17:00' }, '1': { start: '08:00', end: '17:00' }, '2': { start: '08:00', end: '17:00' }, '3': { start: '08:00', end: '17:00' }, '4': { start: '08:00', end: '15:00' } },
      branches: [{ name: 'Main Branch — Nablus', address: '14 Fictional Olive Street, Nablus' }],
      prefix: 'amal',
      users: [
        { email: 'owner@alamal.demo', name: 'Salam Qasem', role: 'owner' },
        { email: 'reception@alamal.demo', name: 'Rania Amari', role: 'receptionist' },
        { email: 'lina@alamal.demo', name: 'Dr. Lina Haddad', role: 'doctor', doctor: { name: 'Dr. Lina Haddad', specialty: 'Family Medicine', color: '#0d8f7e' } },
        { email: 'omar@alamal.demo', name: 'Dr. Omar Nassar', role: 'doctor', doctor: { name: 'Dr. Omar Nassar', specialty: 'Pediatrics', color: '#2563eb' } },
        { email: 'accounting@alamal.demo', name: 'Jabra Suleiman', role: 'accountant' },
      ],
      services: [
        { name: 'General Consultation', desc: 'Consultation with a family physician', dur: 30, price: 15000 },
        { name: 'Pediatric Checkup', desc: 'Well-child examination', dur: 30, price: 14000 },
        { name: 'Follow-up Visit', desc: 'Follow-up on an existing condition', dur: 20, price: 10000 },
        { name: 'Blood Pressure Review', desc: 'Measurement and medication review', dur: 15, price: 8000 },
        { name: 'Minor Procedure', desc: 'Suture removal, dressings, minor wounds', dur: 45, price: 25000 },
        { name: 'Vaccination', desc: 'Routine immunization', dur: 15, price: 12000 },
      ],
    },
    {
      name: 'Cedar Heights Clinic', slug: 'cedar-heights-clinic',
      email: 'care@cedarheights.demo', phone: '+970 2 555 0202',
      address: '88 Storybook Avenue, Ramallah', timezone: 'Asia/Gaza', slot: 30,
      hours: { '1': { start: '09:00', end: '18:00' }, '2': { start: '09:00', end: '18:00' }, '3': { start: '09:00', end: '18:00' }, '4': { start: '09:00', end: '18:00' }, '5': { start: '09:00', end: '14:00' } },
      branches: [
        { name: 'Downtown Branch', address: '88 Storybook Avenue, Ramallah' },
        { name: 'Northside Branch', address: '5 Example Lane, Al-Bireh' },
      ],
      prefix: 'cedar',
      users: [
        { email: 'owner@cedar.demo', name: 'Mira Khalidi', role: 'owner' },
        { email: 'reception@cedar.demo', name: 'Nabil Barakat', role: 'receptionist' },
        { email: 'sara@cedar.demo', name: 'Dr. Sara Idris', role: 'doctor', doctor: { name: 'Dr. Sara Idris', specialty: 'Internal Medicine', color: '#7c3aed' } },
        { email: 'adam@cedar.demo', name: 'Dr. Adam Rahhal', role: 'doctor', doctor: { name: 'Dr. Adam Rahhal', specialty: 'Dermatology', color: '#d97706' } },
        { email: 'faten@cedar.demo', name: 'Dr. Faten Najjar', role: 'doctor', doctor: { name: 'Dr. Faten Najjar', specialty: 'Cardiology', color: '#db2777' } },
        { email: 'accounting@cedar.demo', name: 'George Awad', role: 'accountant' },
      ],
      services: [
        { name: 'Internal Medicine Consultation', desc: 'Adult medicine consultation', dur: 30, price: 18000 },
        { name: 'Dermatology Consultation', desc: 'Skin examination and treatment plan', dur: 30, price: 20000 },
        { name: 'Cardiology Consultation', desc: 'Heart health consultation', dur: 45, price: 30000 },
        { name: 'ECG Test', desc: 'Electrocardiogram with interpretation', dur: 20, price: 15000 },
        { name: 'Skin Biopsy', desc: 'Punch biopsy with lab referral', dur: 30, price: 35000 },
      ],
    },
  ];

  const summary = await db.withTx(async (t) => {
    const out = { clinics: [], credentials: [] };

    for (const def of clinicDefs) {
      const clinicId = (await t.q1(
        'INSERT INTO clinics (name, slug, email, phone, address, timezone, slot_minutes, working_hours, created_at) VALUES (?,?,?,?,?,?,?,?,?) RETURNING id',
        [def.name, def.slug, def.email, def.phone, def.address, def.timezone, def.slot, JSON.stringify(def.hours), now]
      )).id;

      const branchIds = [];
      for (const b of def.branches) {
        branchIds.push((await t.q1('INSERT INTO branches (clinic_id, name, address) VALUES (?,?,?) RETURNING id', [clinicId, b.name, b.address])).id);
      }

      // users + doctors
      const userIds = {};
      const doctorProfileIds = [];
      for (const u of def.users) {
        const userId = (await t.q1(
          'INSERT INTO users (clinic_id, email, password_hash, full_name, role, phone, created_at) VALUES (?,?,?,?,?,?,?) RETURNING id',
          [clinicId, u.email, pwHash, u.name, u.role, '+970 555 0' + randInt(100, 999), now]
        )).id;
        userIds[u.email] = userId;
        if (u.doctor) {
          const docId = (await t.q1(
            'INSERT INTO doctors (clinic_id, user_id, name, specialty, color) VALUES (?,?,?,?,?) RETURNING id',
            [clinicId, userId, u.doctor.name, u.doctor.specialty, u.doctor.color]
          )).id;
          doctorProfileIds.push({ docId, userId, name: u.doctor.name });
        }
      }
      const ownerId = userIds[def.users[0].email];
      const receptionistId = userIds[def.users[1].email];
      const accountantId = userIds[def.users[def.users.length - 1].email];

      // services
      const serviceIds = [];
      for (const s of def.services) {
        serviceIds.push((await t.q1(
          'INSERT INTO services (clinic_id, name, description, duration_min, price_cents) VALUES (?,?,?,?,?) RETURNING id',
          [clinicId, s.name, s.desc, s.dur, s.price]
        )).id);
      }

      // patients
      const patientIds = [];
      const patientCount = randInt(14, 16);
      for (let i = 0; i < patientCount; i++) {
        const full = personName(usedNames);
        const [first, ...rest] = full.split(' ');
        const dob = `${randInt(1958, 2016)}-${String(randInt(1, 12)).padStart(2, '0')}-${String(randInt(1, 28)).padStart(2, '0')}`;
        const allergies = rand() < 0.25 ? pick(['Penicillin', 'Aspirin', 'Peanuts', 'Latex']) : '';
        const medicalInfo = rand() < 0.3 ? pick(['Hypertension — monitored monthly', 'Type 2 diabetes — on oral medication', 'Asthma — uses inhaler as needed', 'Hypothyroidism — daily levothyroxine']) : '';
        const createdDaysAgo = randInt(5, 120);
        const createdAt = new Date(Date.now() - createdDaysAgo * 86400000).toISOString();
        const pid = (await t.q1(`INSERT INTO patients (clinic_id, mrn, first_name, last_name, dob, gender, phone, email, address, allergies, medical_info, first_name_norm, last_name_norm, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
          [clinicId, `P-${1001 + i}`, first, rest.join(' '), dob, pick(['male', 'female']),
            `+970 59${randInt(0, 9)} ${randInt(100, 999)} ${randInt(100, 999)}`, null,
            `Demo address ${randInt(1, 99)}, Fictional Town`, allergies || null, medicalInfo || null,
            normalizeArabic(first), normalizeArabic(rest.join(' ')), createdAt])).id;
        patientIds.push(pid);
      }

      // appointments over -21..+14 days, no overlaps per doctor
      const today = todayLocalDate(def.timezone);
      const busy = new Map(); // docId -> array of [startMs, endMs]
      const apptRows = []; // keep created rows for records/invoices
      for (let dayOffset = -21; dayOffset <= 14; dayOffset++) {
        const base = addMinutes(wallToUtc(`${today} 00:00`, def.timezone), dayOffset * 24 * 60);
        const dayDate = wallParts(base, def.timezone).date;
        const weekday = wallParts(base, def.timezone).weekday;
        const win = def.hours[String(weekday)];
        if (!win) continue;

        for (const doc of doctorProfileIds) {
          const n = randInt(2, 5);
          for (let k = 0; k < n; k++) {
            const svcIdx = randInt(0, def.services.length - 1);
            const svcRow = def.services[svcIdx];
            const serviceId = serviceIds[svcIdx];
            // candidate start in minutes from window start, snapped to 15 min
            const winStartMin = parseInt(win.start.slice(0, 2), 10) * 60 + parseInt(win.start.slice(3), 10);
            const winEndMin = parseInt(win.end.slice(0, 2), 10) * 60 + parseInt(win.end.slice(3), 10);
            const latest = winEndMin - svcRow.dur;
            if (latest <= winStartMin) continue;
            let startMin = winStartMin + 15 * randInt(0, Math.floor((latest - winStartMin) / 15));
            // snap
            startMin = Math.min(startMin, latest);
            const startWall = `${dayDate} ${String(Math.floor(startMin / 60)).padStart(2, '0')}:${String(startMin % 60).padStart(2, '0')}`;
            const startUtc = wallToUtc(startWall, def.timezone);
            const endMs = startUtc.getTime() + svcRow.dur * 60000;
            const list = busy.get(doc.docId) || [];
            if (list.some(([s, e]) => startUtc.getTime() < e && endMs > s)) continue; // overlap: skip
            list.push([startUtc.getTime(), endMs]);
            busy.set(doc.docId, list);

            let status;
            const isPast = startUtc.getTime() + svcRow.dur * 60000 < Date.now();
            if (isPast) status = rand() < 0.78 ? 'completed' : (rand() < 0.5 ? 'cancelled' : 'no_show');
            else status = rand() < 0.45 ? 'confirmed' : 'scheduled';

            const branchId = branchIds[randInt(0, branchIds.length - 1)];
            const patientId = patientIds[randInt(0, patientIds.length - 1)];
            const notes = rand() < 0.15 ? 'Patient asked for a morning slot.' : null;
            const createdAt = new Date(startUtc.getTime() - randInt(1, 6) * 86400000).toISOString();
            const apptId = (await t.q1(`INSERT INTO appointments (clinic_id, branch_id, patient_id, doctor_id, service_id, status, start_at, duration_min, notes, created_by, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
              [clinicId, branchId, patientId, doc.docId, serviceId, status,
                startUtc.toISOString(), svcRow.dur, notes, rand() < 0.5 ? receptionistId : ownerId, createdAt])).id;
            apptRows.push({ apptId, status, patientId, docId: doc.docId, docUserId: doc.userId, serviceId, svcRow, startUtc, dayDate });
          }
        }
      }

      // medical records + prescriptions for completed appointments (up to 25)
      const completed = apptRows.filter((a) => a.status === 'completed').slice(0, 25);
      for (const a of completed) {
        const recId = (await t.q1(`INSERT INTO medical_records (clinic_id, patient_id, appointment_id, doctor_id, visit_date, symptoms, examination, diagnosis, treatment, follow_up, created_by, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
          [clinicId, a.patientId, a.apptId, a.docId, a.dayDate,
            pick(SYMPTOMS), 'Vital signs reviewed; focused examination performed.', pick(DIAGNOSES),
            pick(TREATMENTS), rand() < 0.4 ? 'Review in two weeks if symptoms persist.' : null,
            a.docUserId, a.startUtc.toISOString()])).id;
        if (rand() < 0.7) {
          const m = pick(MEDS);
          await t.exec(`INSERT INTO prescriptions (clinic_id, record_id, patient_id, medication, dosage, frequency, duration, notes, prescribed_by, created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?)`,
            [clinicId, recId, a.patientId, m.medication, m.dosage, m.frequency, m.duration, null, a.docUserId, a.startUtc.toISOString()]);
        }
      }

      // invoices for completed appointments (mix of paid/partial/unpaid)
      let invSeq = 0;
      const year = new Date().getUTCFullYear();
      for (const a of completed) {
        if (rand() < 0.2) continue; // some completed visits not yet billed
        invSeq += 1;
        const invoiceNo = `INV-${year}-${String(invSeq).padStart(4, '0')}`;
        const subtotal = a.svcRow.price + (rand() < 0.3 ? pick(def.services).price : 0);
        const invId = (await t.q1(`INSERT INTO invoices (clinic_id, invoice_no, patient_id, appointment_id, issue_date, due_date, notes, subtotal_cents, total_cents, currency, status, created_by, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
          [clinicId, invoiceNo, a.patientId, a.apptId, a.dayDate, null,
            null, subtotal, subtotal, 'ILS', 'unpaid', accountantId, a.startUtc.toISOString()])).id;
        // first item is always the appointment service
        await t.exec('INSERT INTO invoice_items (invoice_id, clinic_id, service_id, description, quantity, unit_price_cents, amount_cents) VALUES (?,?,?,?,?,?,?)',
          [invId, clinicId, a.serviceId, a.svcRow.name, 1, a.svcRow.price, a.svcRow.price]);
        if (subtotal > a.svcRow.price) {
          const extra = pick(def.services);
          const extraAmt = subtotal - a.svcRow.price;
          await t.exec('INSERT INTO invoice_items (invoice_id, clinic_id, service_id, description, quantity, unit_price_cents, amount_cents) VALUES (?,?,?,?,?,?,?)',
            [invId, clinicId, null, extra.name, 1, extraAmt, extraAmt]);
        }
        const payState = rand();
        let status = 'unpaid';
        if (payState < 0.6) {
          await t.exec('INSERT INTO payments (invoice_id, clinic_id, amount_cents, method, reference, paid_at, received_by, created_at) VALUES (?,?,?,?,?,?,?,?)',
            [invId, clinicId, subtotal, pick(['cash', 'card', 'card', 'bank_transfer']),
              rand() < 0.4 ? `REF-${randInt(10000, 99999)}` : null,
              new Date(a.startUtc.getTime() + 86400000).toISOString(), accountantId, now]);
          status = 'paid';
        } else if (payState < 0.8) {
          const part = Math.floor(subtotal / 2);
          await t.exec('INSERT INTO payments (invoice_id, clinic_id, amount_cents, method, reference, paid_at, received_by, created_at) VALUES (?,?,?,?,?,?,?,?)',
            [invId, clinicId, part, 'cash', null,
              new Date(a.startUtc.getTime() + 86400000).toISOString(), accountantId, now]);
          status = 'partial';
        }
        await t.exec('UPDATE invoices SET status = ? WHERE id = ?', [status, invId]);
      }

      // activity feed
      await t.exec('INSERT INTO activity (clinic_id, user_id, kind, message, created_at) VALUES (?,?,?,?,?)',
        [clinicId, ownerId, 'system', `Clinic "${def.name}" workspace initialized`, now]);
      await t.exec('INSERT INTO activity (clinic_id, user_id, kind, message, created_at) VALUES (?,?,?,?,?)',
        [clinicId, receptionistId, 'patient', `${patientCount} demo patients imported`, now]);
      await t.exec('INSERT INTO activity (clinic_id, user_id, kind, message, created_at) VALUES (?,?,?,?,?)',
        [clinicId, receptionistId, 'appointment', `${apptRows.length} appointments scheduled in the demo window`, now]);

      out.clinics.push({ id: clinicId, name: def.name, patients: patientIds.length, appointments: apptRows.length, invoices: invSeq });
      for (const u of def.users) out.credentials.push({ clinic: def.name, role: u.role, email: u.email });
    }

    // platform admin
    await t.exec('INSERT INTO users (clinic_id, email, password_hash, full_name, role, phone, created_at) VALUES (?,?,?,?,?,?,?)',
      [null, 'admin@clinicportal.local', pwHash, 'Platform Administrator', 'platform_admin', null, now]);
    out.credentials.push({ clinic: 'Platform', role: 'platform_admin', email: 'admin@clinicportal.local' });

    return out;
  });

  console.log('\n[seed] Done. Demo data created:');
  for (const c of summary.clinics) {
    console.log(`  - ${c.name}: ${c.patients} patients, ${c.appointments} appointments, ${c.invoices} invoices`);
  }
  console.log(`\n[seed] Demo password for ALL accounts: ${DEMO_PASSWORD}`);
  console.log('[seed] Accounts:');
  for (const c of summary.credentials) console.log(`  ${c.email.padEnd(28)} (${c.role}, ${c.clinic})`);
  await db.closeDb();
}

// Auto-run only when executed directly (npm run seed); tests require() this
// module and call main() themselves after pointing DATABASE_URL at a test DB.
if (require.main === module) {
  main().catch(async (err) => {
    console.error('[seed] failed:', err.message);
    try { await db.closeDb(); } catch { /* ignore */ }
    process.exit(1);
  });
}

module.exports = { main };
