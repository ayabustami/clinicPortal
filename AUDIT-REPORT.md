# Clinic Portal — Comprehensive Audit Report

**Date:** 2026-10-16  
**Branch:** `arena/a5720833-clinicportal` (based on `75da1f2`, main after PR #3)  
**Scope:** Performance (client + server), Services (backend routes), All routes (frontend + backend)

---

## 1. Executive Summary

| Area | Status | Notes |
|---|---|---|
| Server tests | ✅ 111/111 pass | Verified with PGlite (PostgreSQL WASM) |
| Client build | ✅ Passes | 20 lazy chunks, main bundle 229 KB (gzip 75 KB) |
| Backend routes | ✅ 20 route modules mounted | All mounted in `app.js` |
| Frontend routes | ✅ 18 routes | All page files present |
| N+1 queries | ✅ None found | Batch queries with `ANY()` used |
| DB indexes | ✅ Comprehensive | 30+ indexes across tables |
| Error boundaries | ❌ Missing | No ErrorBoundary anywhere |
| Console errors (prod) | ✅ Clean | No console.log in client |
| TODO/FIXME | ✅ None | Clean codebase |

---

## 2. Performance Audit

### 2.1 Client Bundle (production build)

| Chunk | Size | gzip | Lazy? |
|---|---|---|---|
| `index.js` (main) | 228.96 KB | 74.71 KB | No (entry) |
| `Appointments.js` | 305.06 KB | 89.10 KB | Yes |
| `luxon.js` | 71.32 KB | 22.20 KB | Shared |
| `DentalChart.js` | 41.69 KB | 11.43 KB | Yes |
| `TreatmentPlans.js` | 34.04 KB | 9.61 KB | Yes |
| `Records.js` | 23.63 KB | 7.76 KB | Yes |
| `VisitWorkspace.js` | 22.07 KB | 5.74 KB | Yes |
| `PatientProfile.js` | 16.68 KB | 5.99 KB | Yes |
| `AppointmentModal.js` | 18.38 KB | 6.58 KB | Yes (via Appointments) |
| `WaitingRoom.js` | 14.27 KB | 4.54 KB | Yes |
| `Dashboard.js` | 14.62 KB | 4.11 KB | Yes |
| Others (12 chunks) | < 13 KB each | — | Yes |

**Findings:**
- ✅ Route-level code splitting covers all 17 pages + FullCalendar.
- ⚠️ `Appointments.js` (305 KB) is the heaviest chunk due to FullCalendar + luxon. Already lazy. Consider dynamic import of FullCalendar plugins (dayGrid/timeGrid/list) only when needed.
- ⚠️ Main bundle (229 KB) includes React, React Router, and shared UI. Could split vendor (react, react-dom, react-router) into a separate chunk via `manualChunks` for better caching.
- ✅ CSS is 33 KB (gzip 8 KB) — reasonable.

### 2.2 Memoization

| Component | Memoized? | Notes |
|---|---|---|
| `PatientRow` (Patients.jsx) | ✅ `React.memo` | Added in Step 31 |
| `RecordRow` (Records.jsx) | ✅ `React.memo` | Added in Step 31 |
| `Timeline` (PatientProfile.jsx) | ❌ | Re-renders on filter change (acceptable, filters change data) |
| `TreatmentPlans` | ❌ | Large; consider memoizing plan list items |
| `AppointmentModal` | ❌ | Re-renders on every keystroke (form state) — acceptable |

**Recommendation:** Add `React.memo` to `PlanCard`/`SessionCard` in TreatmentPlans.jsx (lists of plans). Low priority.

### 2.3 Server Performance

| Check | Result |
|---|---|
| N+1 queries | ✅ None — batch queries with `ANY(?::int[])` |
| DB indexes | ✅ 30+ indexes (patients, appointments, records, invoices, dental, audit) |
| Connection pool | ✅ `pg` Pool, max 10, 10s connect timeout, 30s idle timeout |
| Request caching | ✅ `apiCache.js` — 15s TTL, in-flight de-dup, invalidation on mutations |
| Rate limiting | ✅ DB-backed (migration 011), distributed-safe |
| Query timeouts | ⚠️ No explicit `statement_timeout` set on pool — consider adding for safety |

**Recommendation:** Add `statement_timeout: 30000` to Pool config to prevent runaway queries.

### 2.4 Caching Strategy

- ✅ `cachedGet` with 15s TTL + in-flight de-dup (collapses StrictMode double-mount).
- ✅ Mutations call `invalidate()` on affected keys.
- ✅ `invalidateTimelines()` after clinical/financial mutations.
- ⚠️ No service worker / offline cache — acceptable for MVP.

---

## 3. Services Audit (Backend Routes)

### 3.1 Route Registration (`app.js`)

All 20 route modules mounted under `/api/*`:

| Module | Mount path | Status |
|---|---|---|
| auth | `/api/auth` | ✅ |
| meta | `/api/meta` | ✅ |
| dashboard | `/api/dashboard` | ✅ |
| patients | `/api/patients` | ✅ |
| staff | `/api/staff` | ✅ |
| services | `/api/services` | ✅ |
| branches | `/api/branches` | ✅ |
| appointments | `/api/appointments` | ✅ |
| records | `/api/records` | ✅ |
| invoices | `/api/invoices` | ✅ |
| reports | `/api/reports` | ✅ |
| clinics | `/api/clinics` | ✅ |
| activity | `/api/activity` | ✅ |
| audit | `/api/audit` | ✅ |
| schedule | `/api/schedule` | ✅ |
| plans | `/api/plans` | ✅ |
| waiting | `/api/waiting` | ✅ |
| waiting-room | `/api/waiting-room` | ✅ |
| attachments | `/api/attachments` | ✅ |
| dental | `/api/patients/:patientId/dental` | ✅ |

### 3.2 Security

| Check | Result |
|---|---|
| CORS | ✅ Allowlist-based, credentials included |
| CSRF | ✅ `originGuard` middleware on `/api` |
| Helmet (CSP) | ✅ Strict in production, off in dev |
| Auth (JWT cookie) | ✅ HttpOnly, Secure in prod, SameSite |
| Rate limiting (login) | ✅ DB-backed, distributed-safe |
| SQL injection | ✅ Parameterized queries (`?` → `$n`) |
| Input validation | ✅ `V.int`, `V.str`, etc. in routes |
| Error handling | ✅ Central error handler, no stack leak |
| Tenant isolation | ✅ `clinic_id` filter on all queries |
| Role-based access | ✅ `PERMS.*` + `requireRole` middleware |

### 3.3 Permission Matrix (PERMS)

| Permission | Roles |
|---|---|
| `clinical` | owner, doctor |
| `financial_view` | owner, receptionist, accountant, doctor |
| `financial` | owner, accountant |
| `invoice_read` | owner, receptionist, accountant, doctor |
| `invoice_create` | owner, receptionist, accountant, doctor |
| `schedule_manage` | owner, receptionist |
| `staff_manage` | owner |
| `settings` | owner |

**Finding:** Receptionist can read records (redacted — no diagnosis/symptoms). This is by design (clinical-field redaction). Consider hiding the records list entirely for receptionist if not needed.

---

## 4. All Routes (Frontend)

### 4.1 Route Coverage

| Route | Page | Lazy | Auth required | Status |
|---|---|---|---|---|
| `/login` | Login | No (entry) | No | ✅ |
| `/` | Home → Dashboard/AdminClinics | Yes | Yes | ✅ |
| `/appointments` | Appointments | Yes | Yes | ✅ |
| `/calendar` | → `/appointments` redirect | — | Yes | ✅ |
| `/my-day` | MyDay | Yes | Yes | ✅ |
| `/waiting-room` | WaitingRoom | Yes | Yes | ✅ |
| `/patients` | Patients | Yes | Yes | ✅ |
| `/patients/:id` | PatientProfile | Yes | Yes | ✅ |
| `/patients/:id/dental` | DentalChart | Yes | Yes | ✅ |
| `/staff` | Staff | Yes | Yes | ✅ |
| `/services` | Services | Yes | Yes | ✅ |
| `/records` | Records | Yes | Yes | ✅ |
| `/visits/:appointmentId` | VisitWorkspace | Yes | Yes | ✅ |
| `/invoices` | Invoices | Yes | Yes | ✅ |
| `/invoices/:id` | InvoiceDetail | Yes | Yes | ✅ |
| `/reports` | Reports | Yes | Yes | ✅ |
| `/audit` | Audit | Yes | Yes | ✅ |
| `/settings` | Settings | Yes | Yes | ✅ |
| `/admin/clinics` | AdminClinics | Yes | Yes | ✅ |
| `*` | → `/` redirect | — | — | ✅ |

**All 18 protected routes + login + 404 redirect present.** ✅

### 4.2 Missing Features (not bugs)

| Feature | Status | Notes |
|---|---|---|
| Error Boundary | ❌ Missing | A crash in one component takes down the page. Add `errorElement` to routes. |
| Keyboard shortcuts | ⚠️ Partial | Esc closes modals. `/` for search, `n` for new appointment not implemented. |
| Breadcrumbs | ⚠️ Partial | Only PatientProfile + InvoiceDetail. Consider adding to Records, Staff, etc. |
| Offline support | ❌ Not implemented | Acceptable for MVP |
| PWA manifest | ❌ Not present | Acceptable for MVP |

---

## 5. Findings & Recommendations (Priority Order)

### 🔴 High Priority
1. **Add Error Boundary** — Wrap routes in an error boundary to prevent full-page crashes. Use React Router's `errorElement`.
2. **`statement_timeout` on PG pool** — Add to prevent runaway queries (30s).

### 🟡 Medium Priority
3. **Vendor chunk splitting** — Split react/react-dom/react-router into a separate chunk for better caching.
4. **FullCalendar plugin dynamic import** — Load dayGrid/timeGrid/list plugins only when needed.
5. **Memoize TreatmentPlans list items** — `PlanCard`/`SessionCard` with `React.memo`.

### 🟢 Low Priority
6. **Keyboard shortcuts** — `/` for search focus, `n` for new appointment.
7. **Breadcrumbs** — Extend to Records, Staff, Services, Invoices list.
8. **Receptionist records visibility** — Consider hiding records list entirely for receptionist (currently redacted).

---

## 6. Test Coverage

| Suite | Tests | Status |
|---|---|---|
| Server (node:test) | 111 | ✅ All pass |
| Client (build) | — | ✅ Passes |
| E2E (Playwright) | 2 specs | ⚠️ Not run (no browser in sandbox) |

**E2E specs:** `e2e/auth.spec.js`, `e2e/appointments.spec.js` — run locally with `npm run test:e2e` after `npx playwright install`.

---

## 7. Conclusion

The codebase is **well-structured and production-ready** with comprehensive security, indexing, and caching. The main gaps are:
- Missing Error Boundary (resilience)
- No statement_timeout (safety)
- Bundle size optimization opportunities (performance)

No critical bugs found. The earlier `useI18n` import fix (PR #3) resolved the runtime crash.
