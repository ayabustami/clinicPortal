# Clinic Management Portal

A professional, multi-tenant web application for private medical clinics: scheduling with a
Google-Calendar-style appointments page (calendar + list), patient registry, clinical records with draft/approve lifecycle,
services, invoices, payments, operational reports, audit trail, and role-based access control —
all database-backed and server-enforced.

> **Demo status:** all seeded patients, staff and clinics are **fictional**. Demo seeding is
> refused automatically when `NODE_ENV=production`.

---

## 1. Tech stack

| Layer     | Choice | Notes |
|-----------|--------|-------|
| Frontend  | **React 18 + Vite 5 (JavaScript)** | SPA, custom design system, route-level code splitting |
| Calendar  | **FullCalendar 6** (+ `luxon3` plugin) | Rendered in the **clinic's IANA timezone** |
| Backend   | **Node.js ≥ 20 + Express 4** | REST JSON API, Helmet, CSRF/origin defense, rate limiting |
| Database  | **PostgreSQL 14+ via `pg`** (Neon-compatible) | Pooled connections, real transactions, `DATABASE_URL` only — no hardcoded credentials |
| Auth      | JWT in httpOnly cookie + bcrypt | `token_version` session revocation, timing-safe login, per-IP/email rate limits |
| Migrations| Hand-rolled runner (`server/src/migrations/pg/*.sql`) | Versioned, per-file transactions, tracked in `schema_migrations` |
| i18n      | Hand-rolled dictionary provider | English + Arabic with full RTL flip |
| Tests     | `node:test` + `fetch` against a real server | **50 e2e/unit tests** incl. security regressions & DST correctness |

### Database access layer

`server/src/db.js` is the **only** module that talks to PostgreSQL. It exposes a small runner API
used everywhere else, so no route or service contains driver-specific code:

| Helper | Behaviour |
|--------|-----------|
| `q(sql, params)` | all rows |
| `q1(sql, params)` | first row or `undefined` |
| `exec(sql, params)` | `{ rowCount, rows }` — use `RETURNING id` to get new ids |
| `withTx(async (t) => …)` | one pooled client inside `BEGIN`/`COMMIT`; `t` has the same helpers |
| `ping()` / `closeDb()` | health probe / graceful shutdown |

SQL is written with positional `?` placeholders and converted to `$n` internally (string literals,
quoted identifiers and comments are skipped). **Every** query is parameterized.

Type parsers keep the JSON contract identical to the previous build: `timestamptz` →
UTC ISO-8601 strings, `date` → `YYYY-MM-DD`, `int8`/`numeric` (from `COUNT`/`SUM`) → JS numbers.
Sessions are pinned to `timezone=UTC` so `DATE` ↔ `timestamptz` comparisons are deterministic.

The legacy SQLite migrations remain in `server/src/migrations/*.{sql,js}` for history only; the
PostgreSQL runner ignores them. `better-sqlite3` is retained **solely** for
`scripts/backup.js`, `scripts/import-sqlite.js` and `scripts/verify-import.js`, which read the
legacy database file read-only.

---

## 2. Quick start

Requirements: **Node.js ≥ 20**, npm.

```bash
git clone <this repo> && cd clinic-portal
npm run setup          # installs server + client dependencies

# 1. Configure
cp server/.env.example server/.env
#    set DATABASE_URL (PostgreSQL/Neon connection string) and JWT_SECRET
#    production refuses to start with a missing DSN or a weak secret

# 2. Database: check connectivity, migrate, then seed demo data
cd server
npm run db:check       # masked DSN, server version, tables, pending migrations
npm run migrate        # applies server/src/migrations/pg/*.sql
npm run seed           # seeds 2 demo clinics (REFUSED when NODE_ENV=production)
#    npm run seed -- --reset  → TRUNCATE … RESTART IDENTITY + re-seed

# 3. Run (two terminals)
npm run dev:server     # API on http://localhost:4000
npm run dev:client     # SPA on http://localhost:5173 (proxies /api → :4000)
```

Open **http://localhost:5173**. Language toggle (English/العربية) is in the top bar and on the
login screen.

### Demo accounts

All accounts use password **`Demo1234!`**.

| Role | Email | Clinic |
|---|---|---|
| Clinic Owner | `owner@alamal.demo` | Al Amal Family Clinic (2 doctors, 1 branch) |
| Receptionist | `reception@alamal.demo` | Al Amal Family Clinic |
| Doctor | `lina@alamal.demo` (Dr. Lina Haddad) | Al Amal Family Clinic |
| Doctor | `omar@alamal.demo` (Dr. Omar Nassar) | Al Amal Family Clinic |
| Accountant | `accounting@alamal.demo` | Al Amal Family Clinic |
| Clinic Owner | `owner@cedar.demo` | Cedar Heights Clinic (3 doctors, 2 branches) |
| Receptionist | `reception@cedar.demo` | Cedar Heights Clinic |
| Doctor | `sara@ / adam@ / faten@cedar.demo` | Cedar Heights Clinic |
| Accountant | `accounting@cedar.demo` | Cedar Heights Clinic |
| Platform Admin | `admin@clinicportal.local` | Platform console |

**Tenant isolation demo:** sign in to both clinics (different browsers/profiles) — patients,
appointments, invoices and records never cross; cross-clinic IDs return `404` at the API level.

---

## 3. Project layout

```
clinic-portal/
├── .github/workflows/ci.yml      # CI: Node 20+24, server tests, client build
├── server/                       # Express API
│   ├── src/
│   │   ├── migrations/pg/        # 001_init.sql — consolidated PostgreSQL schema (21 tables)
│   │   ├── migrations/           # legacy SQLite migrations (history only; not executed)
│   │   ├── db.js migrate.js seed.js
│   │   ├── auth.js               # JWT, bcrypt, PERMS matrix, rate limits, origin guard, token_version
│   │   ├── config.js             # production fail-fast on weak JWT_SECRET
│   │   ├── services/             # appointments (conflicts/unavailability), invoices (numbering/locking)
│   │   ├── routes/               # auth meta dashboard patients staff services branches appointments
│   │   │                         # records invoices reports clinics activity audit schedule attachments
│   │   └── util/                 # validation, errors, time (DST-exact), arabic normalization, audit
│   ├── scripts/                  # db-check.js (connectivity) · import-sqlite.js (one-time
│   │                             #   SQLite → PostgreSQL import) · verify-import.js (row counts,
│   │                             #   password hashes, money sums, FK orphans, sequences)
│   │                             #   backup.js (legacy SQLite VACUUM INTO snapshot)
│   ├── tests/api.test.js         # 33 e2e tests · dental.test.js 11 · time.test.js 6 DST tests
│   └── data/                     # uploads/ + backups/ + legacy SQLite file (generated)
└── client/                       # React + Vite SPA
    └── src/
        ├── pages/                # Dashboard, Appointments, MyDay, Patients, PatientProfile, Staff,
        │                         # Services, Records, Invoices, InvoiceDetail, Reports, Audit,
        │                         # Settings, AdminClinics, Login
        ├── components/           # Layout, ui kit, AppointmentModal/Detail, PatientSelect, icons
        ├── i18n.jsx              # en/ar dictionary + RTL (document.dir)
        └── auth.jsx api.js format.js styles.css
```

---

## 3b. Dental chart (odontogram)

- **Where:** Patient Profile → **Dental Chart** (`/patients/:id/dental`, clinical roles only —
  owner/doctor; `PERMS.clinical`). Data lives in four tables (`migrations/pg/001_init.sql`):
  `dental_charts` (dentition config), `dental_findings` (current conditions),
  `dental_treatments` (planned/completed), `dental_history` (append-only audit trail).
- **Chart:** interactive SVG odontogram, FDI numbering (permanent 11-48, primary 51-85),
  per-type tooth shapes, five charting surfaces (M/D/O/B/L), permanent/primary/mixed dentition
  (age-based suggestion, always clinician-confirmed), condition colors + patterns + letter badges
  (never color alone), full legend, keyboard navigation, RTL-safe (anatomy never mirrors).
- **Three layers kept separate:** current findings, planned treatments (blue dashed ring + tag)
  and completed procedures (green check). Completing a treatment can *explicitly* apply a
  resulting finding and resolve addressed findings — nothing is overwritten silently; corrections
  require a reason and preserve old values in `dental_history` + `audit_logs`.
- **Safety:** contradictory states (e.g. caries on a missing tooth) are rejected for clinician
  review; "not assessed" (white) is distinct from "healthy" (green ✓); consequential entries
  (missing/extracted/extraction plans) require confirmation.
- **API:** `GET /api/patients/:id/dental` (chart payload), `/history?tooth=`, `/teeth/:tooth`,
  `POST /findings`, `PUT /findings/:fid`, `POST /findings/:fid/resolve`, `POST /treatments`,
  `PATCH /treatments/:tid/status` (`completed` accepts `apply`/`resolve`), `PUT /config`.
  Cross-clinic ids 404 identically to unknown ids; platform admins have no clinic access.

---

## 4. Scheduling & the visit workflow

- **Appointments page** (`/appointments`, old `/calendar` redirects): one page with a **calendar
  view** and a **paged list view** sharing the same data, filters and date. Header carries a
  prominent **+ New Appointment** button (the booking modal also works with no slot selected),
  a debounced **patient name / phone search**, doctor / branch / status filters, quick
  Today-Prev-Next-date navigation and role-aware **today summary chips** (total, checked-in,
  completed, cancelled).
- **Views:** Month / Week / Day / Agenda, prev-today-next + date jump; mobile falls back to
  Day + Agenda. Grid granularity follows the clinic's `slot_minutes` setting; the calendar renders
  in the **clinic's timezone** (luxon3), not the browser's. Drag-to-reschedule and resize-to-change-
  duration are confirmed before saving and revert on server rejection.
- **Search & pagination API:** `GET /api/appointments` accepts `q` (patient first/last name —
  Arabic-normalized — or phone digits), plus `page`/`limit` (≤500, default 25) returning
  `{appointments, page, pages, total}`; without `page` the legacy `{appointments}` array shape is
  kept. The serializer includes `patient_phone`.
- **Doctor identity:** each event carries the doctor's color (side stripe in time grids, extra dot
  in month view). **Doctor leave blocks** (`/api/schedule/unavailability`) render as striped
  background areas and are enforced server-side at booking time.
- **Status flow (server-enforced):** `scheduled → confirmed → checked_in → in_progress → completed`,
  with `cancelled` / `no_show` branches. `PUT /appointments/:id` **rejects status changes** — status
  only changes via `PATCH /appointments/:id/status`. `completed`/`in_progress` require a clinical
  role; doctors may only manage **their own** appointments; restoring a cancelled appointment
  re-runs full conflict validation; concurrent double-booking resolves to exactly one winner
  (single-transaction conflict check).
- **Unified visit workflow:** Check in → **Start visit** (in_progress) → clinical note opens
  pre-filled (`/records?patient_id&appointment_id&new=1`) → **Complete & invoice** (completes the
  appointment and opens the invoice form pre-filled). Doctors get a **My Day** queue page.
- **Server scheduling rules:** no doctor overlap (active statuses incl. in_progress), fits the
  day's working window in the clinic timezone, closed days rejected, doctor on leave rejected,
  inactive patients/doctors/services/branches rejected, duration 5–480 min in multiples of 5.

## 5. Clinical records, billing, reports

- **Records:** `draft` → `approved` lifecycle. Only the authoring doctor (or owner) can edit;
  approved records are **locked (409 on content edit)** — amendments require a new record.
  Prescription updates are applied as **diffs** (ids kept/added/removed) and audited before/after.
  **Attachments:** multipart upload (PDF/JPEG/PNG/WEBP ≤ 10 MB) with MIME **and magic-byte**
  validation, generated storage names, per-clinic folders, authenticated+audited downloads, soft
  delete.
- **Patients:** role-based serialization (allergies/medical info only for clinical+front-desk
  roles), Arabic-insensitive search (hamza/diacritics/ta-marbuta normalization), unified
  **timeline** endpoint (role-filtered events), activation/deactivation with full history kept.
- **Invoices:** sequential `INV-<year>-####` numbering (collision-safe), appointment links are
  validated (same clinic, same patient), per-invoice **currency snapshot**, `paid` invoices are
  locked (409 on item edits, overpayment 400). Configurable clinic currency (ILS default; JOD,
  USD, EUR, …) via Settings — all money rendering uses `Intl.NumberFormat`.
- **Reports:** appointments / revenue / new patients / **operations** (no-show rate per doctor,
  utilization vs working-hours capacity, revenue by service, billed vs collected, receivables
  aging 30/60/90). CSV exports are Excel-safe: **UTF-8 BOM** + **formula-injection neutralization**
  (`= + - @` prefixes quoted), Arabic preserved.

## 6. Security model

- **Permission matrix** (`PERMS` in `server/src/auth.js`) enforced per route:
  `financial: owner/accountant · clinical: owner/doctor · scheduling: owner/receptionist/doctor ·
  patient_registration: owner/receptionist · audit_view: owner`. Dashboard revenue is `null` for
  non-financial roles (computed server-side only when permitted).
- **Sessions:** 12h JWT httpOnly cookie with a `token_version` claim — logout, password change,
  admin password reset, deactivation and demotion **revoke live sessions** immediately.
  `POST /auth/change-password` re-issues the cookie. Cookie policy is environment-aware
  (`COOKIE_SAMESITE`/`COOKIE_SECURE`): production defaults to `SameSite=Lax`+`Secure`; development
  uses `SameSite=None`+`Secure` so HTTPS sandbox previews embedded in cross-site iframes can keep
  the session (browsers drop Lax cookies in third-party frames — verified by regression test).
- **Email verification codes** (`email_verification_codes`, migration `pg/011`): password reset
  (forgot password), password change confirmation (My account / Settings) and account-setup
  invitations all use single-use 6-digit codes. Codes are stored as SHA-256 hashes (never
  plaintext), expire after 15 minutes, allow 5 verification attempts, and at most one code is
  live per email at a time. Request throttling: 60s resend cooldown, 10 codes/hour per
  email+purpose, 60 requests/hour per IP; `forgot-password` always answers `ok` (no account
  enumeration). Changing a password requires **both** the current password and the emailed code.
  Delivery is pluggable (`EMAIL_TRANSPORT=console|http|smtp` — Resend-compatible HTTP, SMTP, or
  server-log fallback; see `server/.env.example` and §9.7). `console` never delivers to an inbox,
  so the API response says so (`email_delivery.deliverable:false`) and the UI warns instead of
  claiming “code sent”; `/api/health` exposes `email.transport`/`email.delivers`. Outside
  production (or with the explicit demo-only flag `EMAIL_DEV_EXPOSE_CODES=YES`) the code is echoed
  in the API response so demo deployments without a mail provider keep working.
- **Login hardening:** timing-safe verification (dummy bcrypt compare for unknown emails), rate
  limits (8 failures per email+IP, 40 per IP per 10 min → HTTP 429), generic error messages.
- **CSRF/origin defense:** state-changing requests are checked against `Sec-Fetch-Site`
  (browser-controlled, unspoofable) and an Origin allowlist (`CLIENT_ORIGIN` + request host).
- **Headers:** Helmet; `X-Content-Type-Options: nosniff` on attachment downloads; SPA served with
  `index:false` static + catch-all in production single-server mode.
- **Tenancy:** every query is scoped by the authenticated user's `clinic_id`; foreign ids → 404.
- **Owner governance:** platform admin provisions clinic owners (`POST /api/clinics/:id/owner`);
  the **last active owner** of a clinic can never be demoted or deactivated (server-enforced);
  self-demotion/self-deactivation blocked; deactivating staff revokes their sessions.
- **Audit:** append-only `audit_logs` (auth, scheduling, clinical, billing, staff, settings,
  attachments) with owner-only retrieval API + UI (filters by action/entity/user/date). No
  update/delete endpoints exist for audit rows.
- **Production fail-fast:** server refuses to boot with a default/short `JWT_SECRET`; seed refuses
  to run; secrets only via environment; SQL fully parameterized; error responses never leak stacks.

## 7. API overview (all under `/api`)

| Area | Endpoints |
|---|---|
| Auth | `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`, `POST /auth/forgot-password`, `POST /auth/reset-password`, `POST /auth/change-password/request-code`, `POST /auth/change-password` (current password **+** emailed code) |
| Bootstrap | `GET /meta/bootstrap` (user, clinic incl. **currency**, doctors incl. color, services, branches incl. is_active, `doctor_profile` for doctors) |
| Health | `GET /health` (probes the database) |
| Dashboard | `GET /dashboard/summary` (revenue only for financial roles) |
| Patients | `GET/POST /patients`, `GET/PUT /patients/:id`, `GET /patients/:id/records`, `GET /patients/:id/timeline` |
| Staff | `GET/POST /staff/doctors`, `PUT /staff/doctors/:id`, `GET/POST /staff/users` (sends an account-setup invitation email), `PUT /staff/users/:id` |
| Services | `GET/POST /services`, `PUT /services/:id` |
| Branches | `GET/POST /branches`, `PUT /branches/:id` |
| Appointments | `GET/POST /appointments`, `GET/PUT /appointments/:id` (no status), `PATCH /appointments/:id/status` |
| Schedule | `GET/POST /schedule/unavailability`, `DELETE /schedule/unavailability/:id` |
| Records | `GET/POST /records`, `GET/PUT /records/:id` (content + `status` approve; locked when approved) |
| Attachments | `POST /attachments` (multipart), `GET /attachments?entity_type&entity_id`, `GET /attachments/:id/download`, `DELETE /attachments/:id` |
| Billing | `GET/POST /invoices`, `GET/PUT /invoices/:id`, `POST /invoices/:id/payments` |
| Reports | `GET /reports/{appointments,revenue,patients,operations}` (+ `format=csv`) |
| Audit | `GET /audit` (owner; platform admin with `?clinic_id=`) |
| Clinics | `GET/PUT /clinics/settings` (owner incl. currency), `GET/POST /clinics`, `PUT /clinics/:id`, `POST /clinics/:id/owner` (platform admin) |
| Activity | `GET /activity` |

## 8. Testing

```bash
cd server && npm test
# tests/api.test.js (33 e2e) · tests/dental.test.js (11) · tests/time.test.js (6 DST)
```

Each database-backed test file creates its **own derived PostgreSQL database**
(`<dbname>_t_api`, `<dbname>_t_dental`) from `DATABASE_URL` in `test.before`
(drop → create → migrate → seed) and drops it in `test.after` — no shared state and
your development data is never touched. The role in `DATABASE_URL` therefore needs
`CREATEDB` (Neon's default role has it).

Latest actual run in this environment (Node v24, PostgreSQL 17.11): **`# tests 50 · # pass 50 · # fail 0`**.

Coverage includes all original e2e flows plus audit regressions: PUT status bypass rejection ·
role-restricted status transitions (in_progress/completed clinical-only) · doctor appointment
ownership · cancelled-restore revalidation · concurrent double-booking race · dashboard revenue
gating per role · clinical-field redaction · Arabic-normalized search · timeline role scoping ·
record draft/approve lock + author-only writes + prescription diff · invoice appointment-link
validation + paid-lock + currency · owner provisioning + last-owner protections · currency
settings flow · session revocation (logout/password change) · login rate limiting · audit API
authorization + filters · CSV BOM + formula injection + Arabic · unavailability enforcement ·
attachment upload/magic-byte/download/cross-clinic/soft-delete · operations report numbers ·
health probe · origin guard · DST-exact wall-clock conversion (Asia/Hebron & Asia/Gaza).

Date windows in tests are **relative** (no hardcoded years).

## 9. Operations (PostgreSQL / Neon)

### 9.1 Configure the database

1. Neon console → project → **Connection Details** → copy the **pooled** connection string
   (`…-pooler.…neon.tech`, role/ database of your branch).
2. Put it in `server/.env` as `DATABASE_URL=…` (git-ignored). `.env.example` ships a
   **placeholder only** — never commit real credentials, and never copy `DATABASE_URL` into any
   `VITE_*` variable: the SPA talks to the API with a session cookie and must never see the DSN.
3. SSL: enabled automatically for `*.neon.tech` hosts or `sslmode=require|verify-ca|verify-full`
   in the URL (the public Neon certificate is verified, `rejectUnauthorized: true`). Override
   with `PGSSLMODE` if needed.
4. `cd server && npm run db:check` — prints the **masked** DSN, server version, tables and
   pending migrations; exits non-zero on failure.

### 9.2 Migrations

- `npm run migrate` (also runs automatically at API boot) applies
  `server/src/migrations/pg/*.sql` in lexicographic order, each file in its own transaction,
  tracked in `schema_migrations`. Never destructive to existing data.

### 9.3 One-time data import from the legacy SQLite file

```bash
cd server
npm run db:import:dry   # read-only rehearsal: per-table row counts, no writes to PostgreSQL
npm run db:import       # backup SQLite → inspect target → import (one transaction) → fix sequences
npm run db:verify       # row counts, password hashes, money sums, FK orphans, sequence positions
```

Guarantees: the SQLite file is opened **read-only** and a `VACUUM INTO` backup is taken first;
the import **aborts** (exit 2) if the PostgreSQL target already contains rows in any data table;
rows are inserted parents-before-children with their original ids inside a single transaction —
any invalid row aborts everything with `table / row id / column / reason`; IDENTITY sequences are
advanced past `MAX(id)` afterwards; `schema_migrations` is not imported (PostgreSQL keeps its own
history). Users keep their bcrypt hashes — all existing logins continue to work unchanged.

### 9.4 Backups

- PostgreSQL: use Neon's built-in **branching / point-in-time restore**, or
  `pg_dump -Fc "$DATABASE_URL" > backup.dump` on a schedule.
- Legacy SQLite file: `npm run backup` still produces `VACUUM INTO` snapshots
  (`data/backups/`, retention `--keep N`, default 14).

### 9.5 Production single-server mode

`NODE_ENV=production` serves `client/dist` from the API and **refuses to start** without
`DATABASE_URL` and a strong `JWT_SECRET` (≥ 32 chars, non-default). Shutdown is graceful:
`SIGTERM`/`SIGINT` stop accepting connections and close the pg pool.

```bash
cd client && npm run build
cd ../server && npm ci --omit=dev
NODE_ENV=production PORT=4000 JWT_SECRET=<random 48-byte hex> \
DATABASE_URL=<neon pooled connection string> node src/index.js
```

Serve behind HTTPS (cookie is `Secure` in production). `CLIENT_ORIGIN` may list extra allowed
origins (comma-separated) when the SPA is hosted separately. Neon suspends idle computes — the
pool tolerates dropped idle clients and reconnects transparently; expect a short cold-start
latency on the first request after inactivity.

### 9.6 Split hosting (static SPA + separate API) — same-origin `/api` required

If the SPA and the API are deployed on **different hosts** (for example two Render services),
the browser treats them as different sites, and mobile Safari blocks the session cookie set by the
API host (third-party cookie blocking). Login then looks successful but every later call returns
`401`. **Serve the API through the SPA's own origin instead**, so the session cookie is
first-party:

| Where | Setting |
|---|---|
| Static site (SPA) — Redirects/Rewrites | **1st rule:** Source `/api/*` → Destination `https://<api-host>/api/*` → action **Rewrite**. **2nd rule (keep):** `/*` → `/index.html` → **Rewrite**. The API rule must be above the catch-all. |
| Static site (SPA) — Environment | **Do not set `VITE_API_URL`** (leave it unset). The client then calls relative `/api/...` URLs. Rebuild after changing it, because Vite reads it at build time. |
| API service — Environment | `NODE_ENV=production`, `CLIENT_ORIGIN=https://<spa-host>`, `JWT_SECRET`, `DATABASE_URL`. Leave `COOKIE_SAMESITE` unset (production default `Lax`, correct for same-origin) and keep `COOKIE_SECURE` at its default (`true`). |

Verify after deploying (the logged-out bootstrap must be `401`, and a login with a missing field
must be a `400` that names the field):

```bash
curl -si https://<spa-host>/api/meta/bootstrap | head -1                 # HTTP/2 401
curl -si -X POST https://<spa-host>/api/auth/login \
  -H 'Content-Type: application/json' -d '{"password":"x"}' | grep -E '^HTTP|email'   # 400, email=required
curl -si -X POST https://<spa-host>/api/auth/login -H 'Content-Type: application/json' \
  -H 'Origin: https://<spa-host>' -d '{"email":"<your account>","password":"<your password>"}' \
  | grep -iE '^HTTP|set-cookie'                                          # 200 + Set-Cookie for <spa-host>
```

**Login diagnostics.** A rejected login logs one line such as
`[auth] login rejected: email=required content-type=application/json body-keys=email,password`
(field names only — never the values). `GET /api/... -> 401` lines carry a `reason=` code
(`no_session_cookie`, `token_invalid`, `token_expired`, `session_revoked`, `account_disabled`) so a
missing cookie is distinguishable from an expired or revoked session.

### 9.7 Password-reset / verification email does not arrive

The application never silently pretends an email was sent. If no mail provider is configured,
the default transport is `console`: the full message (including the 6-digit code) is printed to
the **server log** and the UI now shows a warning instead of “Code sent to …”.

Check the effective configuration from the deployment itself:

```bash
curl -s https://<your-host>/api/health
# {"ok":true,"service":"clinic-portal-api","email":{"transport":"console","delivers":false}}
```

`delivers:false` means **no email will ever arrive** until the environment is fixed. Full details
(which variable is missing, SMTP-on-Render warning, bad `APP_URL`) are printed at boot and on every
send attempt in the service logs (`[email] …` lines).

| Symptom | Cause | Fix |
|---|---|---|
| `email.transport` is `console`, logs show `[email:console]` with the code | No provider configured (default) | Set the Resend variables below and redeploy |
| `email.delivers:false`, logs show `EMAIL_HTTP_API_KEY is not set` / `EMAIL_HTTP_URL …` | Provider half-configured | Add the missing variable(s) |
| `[email] send failed via http: provider responded 401/403/422` | Bad API key, or `EMAIL_FROM` uses a domain that is not verified with the provider | Create a new key / verify the sending domain, fix `EMAIL_FROM` |
| `[email] not sent … demo/reserved domain` | Recipient is a demo account (`@alamal.demo`, `@cedar.demo`, `@clinicportal.local`) or another reserved domain — it can never receive mail | Use a real address, or read the code from the logs |
| SMTP configured, requests time out, logs mention ports 25/465/587 | **Render blocks outbound SMTP on free services** (port 25 on every plan) | Use `EMAIL_TRANSPORT=http` with Resend — do not use Gmail SMTP on Render |
| Mail provider accepted the message but nothing arrives | Spam folder, unverified sender domain, Resend sandbox sender (`onboarding@resend.dev` only delivers to the Resend account owner) | Verify the domain, check spam, use a real `EMAIL_FROM` |

Working Resend configuration (Render → Environment):

```env
EMAIL_TRANSPORT=http
EMAIL_HTTP_URL=https://api.resend.com/emails
EMAIL_HTTP_API_KEY=re_xxxxxxxx
EMAIL_FROM=Denti Clinics <no-reply@your-verified-domain.com>
APP_URL=https://clinicportal.onrender.com
```

Then redeploy (environment changes need a service restart) and verify with:

```bash
cd server && npm run email:check                       # status only
cd server && npm run email:check -- --to you@example.com   # sends a real test message
```

Operational notes:

- **Immediate recovery without a provider:** open Render → your service → **Logs**, search for
  `[email:console]`, and copy `Your verification code: 123456` into the “Forgot password” dialog.
  Codes expire after 15 minutes and are single-use.
- `EMAIL_DEV_EXPOSE_CODES=YES` echoes the code in the API/UI. **Demo only** — anyone could take
  over an account, so never enable it on a real deployment.
- Request throttling: 60-second resend cooldown, 10 codes/hour per email, 60/hour per IP. A 429
  response is intentional; wait before retrying.
- Changing a password (My account / Settings) requires the emailed code too, so it is affected by
  the same configuration.

## 10. Known limitations (honest status)

- **i18n depth:** navigation, auth, dashboard, calendar chrome, status badges and roles are
  translated (en/ar) with full RTL layout flip; deeper page-level strings remain English
  (infrastructure + dictionary in `client/src/i18n.jsx` is ready to extend).
- Single role per user; one clinic per user; no per-doctor working schedules (clinic-wide hours +
  leave blocks). Password self-reset exists (emailed one-time code, sessions revoked); clinic owners
  can additionally reset staff passwords from Staff, which also revokes live sessions.
- Invoices: no discounts/tax/voiding; `paid` invoices fully locked by design (corrections via new
  invoice).
- No WebSocket live refresh. PostgreSQL connections are pooled (`PG_POOL_MAX`, default 10) —
  keep the pool within your Neon plan's connection limit and prefer the **pooled** connection
  string (`-pooler` host) so PgBouncer absorbs short spikes.
- Drag-drop into invalid slots is rejected after drop (revert + exact server reason toast).

## 11. AI features — planning only (not implemented, by request)

Possible future additions, deliberately **not** built in this phase: appointment no-show risk
scoring, transcript-to-clinical-note drafting, coding/diagnosis suggestions, invoice OCR,
Arabic NLP patient triage. Any such feature would require explicit clinical governance review.
