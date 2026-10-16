import React, { useCallback, useEffect, useState } from 'react';
import { useParams, Link, useSearchParams, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useApi } from '../useApi.js';
import { invalidate } from '../apiCache.js';
import { useAuth } from '../auth.jsx';
import { useI18n } from '../i18n.jsx';
import { Spinner, EmptyState, StatusBadge, useToast, useConfirm, Breadcrumb } from '../components/ui.jsx';
import { PatientFormModal } from './Patients.jsx';
import { fmtDateShort, fmtTime, ageFromDob, money } from '../format.js';
import { RecordDetail } from './Records.jsx';
import { Modal } from '../components/ui.jsx';
import { IconEdit, IconSteth } from '../components/icons.jsx';
import TreatmentPlans from '../components/TreatmentPlans.jsx';

const TL_ICONS = { appointment: '📅', record: '📝', prescription: '💊', invoice: '🧾', payment: '💳', dental: '🦷', plan: '🗂', session: '🗓' };
const TL_TYPES = [
  ['appointment', 'Visits'], ['record', 'Clinical notes'], ['prescription', 'Prescriptions'],
  ['dental', 'Chart changes'], ['plan', 'Plans'], ['session', 'Sessions'],
  ['invoice', 'Invoices'], ['payment', 'Payments'],
];

function Timeline({ patientId }) {
  const [types, setTypes] = useState(() => new Set());
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const { lang } = useI18n();
  // Filter state is part of the cache key: switching filters back to a
  // previously seen combination renders instantly from cache (no refetch,
  // no spinner), and a stale response can never overwrite a newer one.
  const qs = ['limit=300'];
  if (types.size) qs.push(`types=${[...types].join(',')}`);
  if (from) qs.push(`from=${from}`);
  if (to) qs.push(`to=${to}`);
  const { data, error, isLoading, isRefreshing, refetch } = useApi(`/patients/${patientId}/timeline?${qs.join('&')}`);

  if (error && !data) {
    return (
      <div className="card card-pad">
        <div className="form-error" role="alert">{lang === 'ar' ? 'فشل تحميل سجل النشاط:' : 'Failed to load activity log:'} {error}</div>
        <button className="btn btn-outline mt-12" onClick={() => refetch().catch(() => {})}>{lang === 'ar' ? 'إعادة المحاولة' : 'Retry'}</button>
      </div>
    );
  }
  return (
    <div className="card card-pad">
      <div className="card-title">{lang === 'ar' ? 'سجل النشاط السريري' : 'Clinical activity log'} <span className="muted small">· {lang === 'ar' ? 'الأحدث أولاً · مفلتر حسب الدور · كل إدخال يفتح مصدره' : 'newest first · role-filtered · every entry opens its source'}</span>
        {error && data && <span className="badge" style={{ marginLeft: 8, background: 'var(--warn-soft)', color: 'var(--warn)', borderColor: '#f5d9a8' }} title={error}>{lang === 'ar' ? 'عرض آخر تحميل — فشل التحديث' : 'showing last loaded — refresh failed'}</span>}
          {isRefreshing && !error && <span className="muted small" style={{ marginLeft: 8 }}>{lang === 'ar' ? 'جارٍ التحديث…' : 'updating…'}</span>}
      </div>
      <div className="flex" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 10 }} role="group" aria-label={lang === 'ar' ? 'تصفية الجدول الزمني حسب نوع الحدث' : 'Filter timeline by event type'}>
        {TL_TYPES.map(([v, label]) => (
          <button key={v} type="button" aria-pressed={types.has(v)}
            className={`btn btn-sm ${types.has(v) ? 'btn-primary' : 'btn-outline'}`}
            onClick={() => setTypes((prev) => { const n = new Set(prev); if (n.has(v)) n.delete(v); else n.add(v); return n; })}>
            {TL_ICONS[v]} {lang === 'ar' ? ({ appointment: 'الزيارات', record: 'ملاحظات سريرية', prescription: 'الوصفات', dental: 'تغييرات المخطط', plan: 'الخطط', session: 'الجلسات', invoice: 'الفواتير', payment: 'المدفوعات' }[v] || label) : label}
          </button>
        ))}
        {types.size > 0 && <button type="button" className="btn btn-sm btn-outline" onClick={() => setTypes(new Set())}>{lang === 'ar' ? 'مسح' : 'Clear'}</button>}
      </div>
      <div className="flex" style={{ gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <label className="muted small" htmlFor="tl-from">From</label>
        <input id="tl-from" type="date" className="input" style={{ width: 'auto', padding: '4px 8px', fontSize: 12.5 }} value={from} onChange={(e) => setFrom(e.target.value)} />
        <label className="muted small" htmlFor="tl-to">To</label>
        <input id="tl-to" type="date" className="input" style={{ width: 'auto', padding: '4px 8px', fontSize: 12.5 }} value={to} onChange={(e) => setTo(e.target.value)} />
        {(from || to) && <button type="button" className="btn btn-sm btn-outline" onClick={() => { setFrom(''); setTo(''); }}>{lang === 'ar' ? 'مسح التواريخ' : 'Clear dates'}</button>}
      </div>
      {isLoading ? <Spinner label={lang === 'ar' ? 'جارٍ تحميل النشاط…' : 'Loading activity…'} /> : !data.events.length ? (
        <EmptyState icon="🕐" title={types.size || from || to ? (lang === 'ar' ? 'لا يوجد نشاط لهذه الفلاتر' : 'No activity for these filters') : (lang === 'ar' ? 'لا يوجد سجل بعد' : 'No history yet')}>
          {types.size || from || to
            ? (lang === 'ar' ? 'وسّع نطاق التاريخ أو امسح فلاتر الأنواع — لا شيء مخفي، السجل فارغ لهذا الاختيار.' : 'Widen the date range or clear type filters — nothing is hidden, the log is empty for this selection.')
            : (lang === 'ar' ? 'تظهر الأحداث هنا مع تسجيل الزيارات والملاحظات والخطط والفواتير والمدفوعات.' : 'Events appear here as visits, notes, plans, invoices and payments are recorded.')}
        </EmptyState>
      ) : (
        <div className="timeline">
          {data.events.map((ev, i) => {
            const body = (
              <>
                <span className="tl-ico">{TL_ICONS[ev.type] || '•'}</span>
                <span className="tl-body">
                  <b>{ev.title}</b>
                  <span className="tl-detail">
                    {ev.detail ? `${ev.detail}${ev.actor ? ' · ' : ''}` : ''}{ev.actor || ''}
                  </span>
                </span>
                <span className="tl-meta">
                  {ev.status && <StatusBadge status={mapEventStatus(ev)} />}
                  <span className="muted small mono">{fmtDateShort(ev.at)} {fmtTime(ev.at)}</span>
                </span>
              </>
            );
            return ev.link
              ? <Link key={`${ev.type}-${ev.id}-${i}`} to={ev.link} className="tl-item tl-link" title={lang === 'ar' ? 'فتح السجل المصدر' : 'Open the source record'}>{body}</Link>
              : <div key={`${ev.type}-${ev.id}-${i}`} className="tl-item">{body}</div>;
          })}
        </div>
      )}
    </div>
  );
}

/** C: one visit, fully — appointment facts + the linked clinical record(s).
 *  Distinguishes "no record exists" (missing) from a record with empty fields. */
function VisitModal({ patient, appt, onClose }) {
  const navigate = useNavigate();
  const [recs, setRecs] = useState(null);
  const [err, setErr] = useState('');
  const [openRec, setOpenRec] = useState(null);
  const { lang } = useI18n();

  useEffect(() => {
    let live = true;
    api(`/records?patient_id=${patient.id}&appointment_id=${appt.id}`)
      .then((r) => { if (live) setRecs(r.items || []); })
      .catch((e) => { if (live) setErr(e.message); });
    return () => { live = false; };
  }, [patient.id, appt.id]);

  return (
    <>
      <Modal title={lang === 'ar' ? `زيارة · ${fmtDateShort(appt.start_at)} ${fmtTime(appt.start_at)}` : `Visit · ${fmtDateShort(appt.start_at)} ${fmtTime(appt.start_at)}`} onClose={onClose}
        footer={<button className="btn btn-outline" onClick={onClose}>{lang === 'ar' ? 'إغلاق' : 'Close'}</button>}>
        <div className="flex" style={{ gap: 10, alignItems: 'center', marginBottom: 10 }}>
          <StatusBadge status={appt.status} />
          <span className="muted small">
            {appt.type || appt.appointment_type || 'Appointment'}
            {appt.doctor_name ? ` · Dr. ${appt.doctor_name}` : ''}
            {appt.service_name ? ` · ${appt.service_name}` : ''}
            {appt.reason ? ` · ${appt.reason}` : ''}
          </span>
        </div>
        {err && <div className="form-error" role="alert">{err}</div>}
        {!recs && !err && <Spinner label={lang === 'ar' ? 'جارٍ تحميل تفاصيل الزيارة…' : 'Loading visit details…'} />}
        {recs && recs.length === 0 && (
          <EmptyState icon="📭" title={lang === 'ar' ? 'لا يوجد سجل سريري لهذه الزيارة' : 'No clinical record for this visit'}>
            The appointment happened but nothing was documented — this is a <b>missing record</b>, not an empty one.
            <div className="mt-12">
              <button className="btn btn-primary btn-sm" onClick={() => navigate(`/records?new=1&patient_id=${patient.id}&appointment_id=${appt.id}`)}>
                {lang === 'ar' ? 'توثيق هذه الزيارة' : 'Document this visit'}
              </button>
            </div>
          </EmptyState>
        )}
        {recs && recs.length > 0 && recs.map((r) => (
          <div key={r.id} className="dash-list-item row-link" onClick={() => setOpenRec(r.id)}>
            <span className="dash-time" style={{ width: 100 }}>{r.visit_date || fmtDateShort(appt.start_at)}</span>
            <span className="who"><b>{r.diagnosis || (lang === 'ar' ? 'ملاحظة زيارة' : 'Visit note')}</b><span>{r.doctor_name || '—'}{r.status ? ` · ${r.status}` : ''}</span></span>
            <span className="muted small">open ▸</span>
          </div>
        ))}
      </Modal>
      {openRec && (
        <RecordDetail id={openRec} onClose={() => setOpenRec(null)}
          onEdit={() => { onClose(); navigate(`/records?edit=${openRec}&patient_id=${patient.id}`); }} />
      )}
    </>
  );
}

function mapEventStatus(ev) {
  if (ev.type === 'appointment') return ev.status;
  if (ev.type === 'invoice') return ev.status === 'paid' ? 'completed' : ev.status === 'partial' ? 'checked_in' : 'scheduled';
  if (ev.type === 'record') return ev.status === 'approved' ? 'completed' : 'confirmed';
  if (ev.type === 'session' || ev.type === 'plan') return ['completed', 'cancelled', 'in_progress', 'scheduled'].includes(ev.status) ? ev.status : 'confirmed';
  if (ev.type === 'dental') return ev.status === 'postponed' ? 'cancelled' : 'completed';
  return null;
}

export default function PatientProfile() {
  const { id } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useAuth();
  const { lang } = useI18n();
  const { data, error, isLoading, isRefreshing, refetch } = useApi(id ? `/patients/${id}` : null);
  const [editing, setEditing] = useState(false);
  const [visitAppt, setVisitAppt] = useState(null);
  const [openRecordId, setOpenRecordId] = useState(null);
  const [tab, setTab] = useState(() => searchParams.get('tab') || 'overview');
  const focusPlanId = searchParams.get('plan');
  // keep-alive: a tab stays mounted after its first visit, so switching back
  // shows the previous content instantly instead of refetching from zero.
  const [visitedTabs, setVisitedTabs] = useState(() => new Set([tab]));
  useEffect(() => { setVisitedTabs((v) => (v.has(tab) ? v : new Set([...v, tab]))); }, [tab]);
  const toast = useToast();
  const confirm = useConfirm();

  const load = useCallback(() => refetch().catch(() => {}), [refetch]);

  if (error && !data) {
    const invalidRef = /whole number|not found|invalid/i.test(error);
    return (
      <div className="page">
        <div className="card card-pad" style={{ maxWidth: 520 }}>
          <div className="card-title">{lang === 'ar' ? '⚠️ تعذر فتح المريض' : '⚠️ Patient could not be opened'}</div>
          <div className="form-error" role="alert">{error}</div>
          <p className="muted small mt-12">
            {invalidRef
              ? (lang === 'ar' ? 'العنوان لا يشير إلى مريض صالح (مرجع سيء أو مفقود — "abc" و "34.5" مرفوضان، ويُقبل MRN).' : 'The address does not point to a valid patient (bad or missing reference — "abc" and "34.5" are rejected, and MRNs are accepted).')
              : (lang === 'ar' ? 'فشل الطلب؛ قد تبقى بيانات المريض سليمة.' : 'The request failed; the patient data may still be intact.')}
          </p>
          <div className="flex mt-12" style={{ gap: 8 }}>
            <Link to="/patients" className="btn btn-primary">{lang === 'ar' ? '← العودة إلى المرضى' : '← Back to patients'}</Link>
            <button className="btn btn-outline" onClick={load}>{lang === 'ar' ? 'إعادة المحاولة' : 'Retry'}</button>
          </div>
        </div>
      </div>
    );
  }
  if (isLoading || !data) {
    // Localized skeleton: the app shell (sidebar/topbar) stays mounted.
    return (
      <div className="page" aria-busy="true">
        <div className="skeleton skeleton-title" />
        <div className="skeleton skeleton-line" style={{ width: '35%' }} />
        <div className="grid-2" style={{ marginTop: 16 }}>
          <div className="skeleton skeleton-card" />
          <div className="skeleton skeleton-card" />
        </div>
      </div>
    );
  }

  const p = data.patient;
  const canEdit = ['owner', 'receptionist'].includes(user.role);
  const seesClinical = ['owner', 'doctor'].includes(user.role);
  const seesBilling = ['owner', 'accountant'].includes(user.role);
  const age = ageFromDob(p.dob);

  async function toggleActive() {
    const deactivating = p.is_active !== false;
    const ok = await confirm({
      title: deactivating ? 'Deactivate patient' : 'Reactivate patient',
      message: deactivating
        ? `Deactivate ${p.first_name} ${p.last_name}? Full history is preserved, but new appointments cannot be booked and the patient is hidden from default search.`
        : `Reactivate ${p.first_name} ${p.last_name}?`,
      confirmLabel: deactivating ? 'Deactivate' : 'Reactivate',
      danger: deactivating,
    });
    if (!ok) return;
    try {
      await api(`/patients/${p.id}`, { method: 'PUT', body: { is_active: !deactivating } });
      toast.success(deactivating ? (lang === 'ar' ? 'تم إلغاء تفعيل المريض.' : 'Patient deactivated.') : (lang === 'ar' ? 'تم إعادة تفعيل المريض.' : 'Patient reactivated.'));
      load();
    } catch (e) { toast.error(e.message); }
  }

  return (
    <div className="page">
      <Breadcrumb items={[{ label: lang === 'ar' ? 'المرضى' : 'Patients', to: '/patients' }, { label: `${p.first_name} ${p.last_name}` }]} />
      <div className="page-head">
        <div>
          <h1>
            {p.first_name} {p.last_name} <span className="muted" style={{ fontWeight: 500, fontSize: 15 }}>· {p.mrn}</span>
            {p.is_active === false && <span className="badge" style={{ marginLeft: 8, background: 'var(--danger-soft)', color: '#991b1b', borderColor: '#f3c1c1' }}>{lang === 'ar' ? 'غير نشط' : 'Inactive'}</span>}
            {isRefreshing && <span className="muted small" style={{ marginLeft: 8 }}>{lang === 'ar' ? 'جارٍ التحديث…' : 'updating…'}</span>}
            {error && data && <span className="badge" style={{ marginLeft: 8, background: 'var(--warn-soft)', color: 'var(--warn)', borderColor: '#f5d9a8' }} title={error}>{lang === 'ar' ? 'فشل التحديث — عرض المخزن' : 'refresh failed — showing cached'}</span>}
          </h1>
          <div className="desc">
            {[age !== null && `${age} years`, p.gender, p.phone, p.email].filter(Boolean).join(' · ') || (lang === 'ar' ? 'لا توجد تفاصيل اتصال مسجلة' : 'No contact details recorded')}
        </div>
        </div>
        <div className="flex">
          {seesClinical && <Link to={`/patients/${p.id}/dental`} className="btn btn-outline">{lang === 'ar' ? '🦷 مخطط الأسنان' : '🦷 Dental Chart'}</Link>}
          {p.is_active !== false && <Link to={`/appointments?patient_id=${p.id}`} className="btn btn-outline">{lang === 'ar' ? 'حجز موعد' : 'Book appointment'}</Link>}
          {canEdit && <button className={`btn ${p.is_active === false ? 'btn-outline' : 'btn-danger-outline'}`} onClick={toggleActive}>
            {p.is_active === false ? (lang === 'ar' ? 'إعادة تفعيل' : 'Reactivate') : (lang === 'ar' ? 'إلغاء تفعيل' : 'Deactivate')}
          </button>}
          {canEdit && <button className="btn btn-primary" onClick={() => setEditing(true)}><IconEdit size={15}/> {lang === 'ar' ? 'تعديل التفاصيل' : 'Edit details'}</button>}
        </div>
      </div>

      <div className="view-switch mb-12" style={{ width: 'fit-content' }} role="tablist">
        <button className={tab === 'overview' ? 'on' : ''} onClick={() => setTab('overview')} role="tab">{lang === 'ar' ? 'نظرة عامة' : 'Overview'}</button>
        {seesClinical && <button className={tab === 'plans' ? 'on' : ''} onClick={() => setTab('plans')} role="tab">{lang === 'ar' ? 'خطط العلاج' : 'Treatment plans'}</button>}
        <button className={tab === 'timeline' ? 'on' : ''} onClick={() => setTab('timeline')} role="tab">{lang === 'ar' ? 'الجدول الزمني' : 'Timeline'}</button>
      </div>

      {visitedTabs.has('timeline') && (
        <div hidden={tab !== 'timeline'}>
          <Timeline patientId={p.id} />
        </div>
      )}
      {visitedTabs.has('plans') && seesClinical && (
        <div hidden={tab !== 'plans'}>
          <TreatmentPlans patientId={p.id} focusPlanId={focusPlanId} onChanged={() => { load(); }} />
        </div>
      )}

      <div hidden={tab !== 'overview'}>
        <>
          {(p.allergies || p.medical_info) && (
            <div className="card card-pad mb-12" style={p.allergies ? { borderColor: '#f3c1c1', background: '#fffbfa' } : {}}>
              <div className="card-title">{lang === 'ar' ? 'التنبيهات السريرية' : 'Clinical flags'}</div>
              {p.allergies
                ? <div style={{ color: '#991b1b', fontWeight: 620, marginBottom: p.medical_info ? 8 : 0 }}>⚠️ {lang === 'ar' ? 'الحساسية:' : 'Allergies:'} {p.allergies}</div>
                : <div className="muted small">No known allergies recorded.</div>}
              {p.medical_info && <div className="small" style={{ color: 'var(--ink-2)' }}>{p.medical_info}</div>}
            </div>
          )}

          <div className="grid-2">
            <div className="card card-pad">
              <div className="card-title">{lang === 'ar' ? 'سجل الزيارات' : 'Visit history'} ({data.appointments.length}) <span className="muted small">· {lang === 'ar' ? 'انقر على زيارة للتفاصيل الكاملة' : 'click a visit for full details'}</span></div>
              {data.appointments.length === 0 ? <EmptyState icon="📅" title={lang === 'ar' ? 'لا توجد مواعيد بعد' : 'No appointments yet'} /> : (
                data.appointments.map((a) => (
                  <div key={a.id} className="dash-list-item row-link" role="button" tabIndex={0}
                    onClick={() => setVisitAppt(a)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setVisitAppt(a); } }}>
                    <span className="dash-time" style={{ width: 100 }}>{fmtDateShort(a.start_at)}</span>
                    <span className="who"><b>{fmtTime(a.start_at)} · {a.doctor_name || '—'}</b><span>{a.service_name || (lang === 'ar' ? 'موعد' : 'Appointment')}</span></span>
                    <span className="flex" style={{ gap: 8, alignItems: 'center' }}>
                      <StatusBadge status={a.status} />
                      <Link to={`/visits/${a.id}`} onClick={(e) => e.stopPropagation()} className="icon-btn" aria-label="Visit workspace" title={lang === 'ar' ? 'مساحة عمل الزيارة' : 'Visit workspace'}><IconSteth size={14} /></Link>
                      <span className="muted small" aria-hidden="true">▸</span>
                    </span>
                  </div>
                ))
              )}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {seesClinical && (
                <div className="card card-pad">
                  <div className="card-title">{lang === 'ar' ? 'السجلات السريرية' : 'Clinical records'} ({data.records.length})</div>
                  {!data.records.length ? <EmptyState icon="📝" title={lang === 'ar' ? 'لا توجد سجلات سريرية' : 'No clinical records'} /> : (
                    data.records.map((r) => (
                      <div key={r.id} className="dash-list-item row-link" role="button" tabIndex={0} onClick={() => setOpenRecordId(r.id)}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpenRecordId(r.id); } }}>
                        <span className="dash-time" style={{ width: 100 }}>{r.visit_date}</span>
                        <span className="who"><b>{r.diagnosis || (lang === 'ar' ? 'ملاحظة زيارة' : 'Visit note')}</b><span>{r.doctor_name} · {r.prescriptions} {lang === 'ar' ? 'وصفة' : 'prescription(s)'}{r.status ? ` · ${r.status}` : ''}</span></span>
                        <span className="muted small" aria-hidden="true">▸</span>
                      </div>
                    ))
                  )}
                  <div className="muted small" style={{ marginTop: 8 }}>{lang === 'ar' ? 'انقر على سجل لفتح الملاحظات الكاملة والوصفات والمرفقات.' : 'Click a record to open full notes, prescriptions and attachments.'}</div>
                </div>
              )}
              {seesBilling && (
                <div className="card card-pad">
                  <div className="card-title">{lang === 'ar' ? 'الفواتير' : 'Invoices'} ({data.invoices.length})</div>
                  {!data.invoices.length ? <EmptyState icon="🧾" title={lang === 'ar' ? 'لا توجد فواتير' : 'No invoices'} /> : (
                    data.invoices.map((inv) => (
                      <Link key={inv.id} to={`/invoices/${inv.id}`} className="dash-list-item" style={{ textDecoration: 'none', color: 'inherit' }}>
                        <span className="dash-time" style={{ width: 110 }}>{inv.invoice_no}</span>
                        <span className="who"><b>{money(inv.total_cents, inv.currency)}</b><span>{lang === 'ar' ? 'أُصدرت' : 'Issued'} {inv.issue_date}</span></span>
                        <StatusBadge status={inv.status === 'paid' ? 'completed' : inv.status === 'partial' ? 'checked_in' : 'scheduled'} />
                      </Link>
                    ))
                  )}
                </div>
              )}
            </div>
          </div>
        </>
      </div>

      {visitAppt && <VisitModal patient={p} appt={visitAppt} onClose={() => setVisitAppt(null)} />}
      {openRecordId && (
        <RecordDetail id={openRecordId} onClose={() => setOpenRecordId(null)}
          onEdit={() => { setOpenRecordId(null); }} onChanged={() => { load(); }} />
      )}

      {editing && (
        <PatientFormModal patient={p} onClose={() => setEditing(false)}
          onSaved={async () => { setEditing(false); invalidate('/patients?'); await load(); toast.info(lang === 'ar' ? 'تم تحديث ملف المريض.' : 'Patient profile refreshed.'); }} />
      )}
    </div>
  );
}
