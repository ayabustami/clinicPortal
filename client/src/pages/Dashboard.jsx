import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useApi } from '../useApi.js';
import { Link, useNavigate } from 'react-router-dom';
import { DateTime } from 'luxon';
import { api } from '../api.js';
import { useAuth, useClinicMeta } from '../auth.jsx';
import { useI18n } from '../i18n.jsx';
import { Spinner, EmptyState, StatusBadge } from '../components/ui.jsx';
import AppointmentModal from '../components/AppointmentModal.jsx';
import { STATUS_META, STATUS_ORDER, money, relTime, greetingName } from '../format.js';
import { IconCalendar, IconUsers, IconSteth, IconCard, IconClock, IconPlus, IconSearch, IconInvoice, IconFileText } from '../components/icons.jsx';

const KIND_ICONS = { appointment: '📅', patient: '🧑‍⚕️', billing: '💳', clinical: '📝', staff: '👥', system: '⚙️', info: 'ℹ️' };

function greetingKey(t) {
  const h = new Date().getHours();
  if (h < 12) return t('dash.greeting.morning');
  if (h < 17) return t('dash.greeting.afternoon');
  return t('dash.greeting.evening');
}

const dashboardPath = '/dashboard/summary';

export default function Dashboard() {
  // Cached + de-duplicated read: back-navigation and StrictMode double-mount
  // render instantly from cache instead of blanking and refetching.
  const { data, error, isLoading, refetch } = useApi(dashboardPath);
  const { user } = useAuth();
  const { clinic } = useClinicMeta();
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  const tz = clinic?.timezone || null;

  /* quick actions + global search */
  const [showAppt, setShowAppt] = useState(false);
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef(null);
  const canBook = ['owner', 'receptionist', 'doctor'].includes(user?.role);
  const canRegister = ['owner', 'receptionist'].includes(user?.role);
  const canBill = ['owner', 'accountant'].includes(user?.role);
  const isClinical = ['owner', 'doctor'].includes(user?.role);

  const load = () => refetch().catch(() => {});

  const searchSeq = useRef(0);
  useEffect(() => {
    if (!q.trim()) { setResults(null); return undefined; }
    const seq = (searchSeq.current += 1);
    const h = setTimeout(() => {
      api(`/patients?q=${encodeURIComponent(q.trim())}&limit=6`)
        .then((r) => { if (seq === searchSeq.current) { setResults(r.items || []); setSearchOpen(true); } })
        .catch(() => { if (seq === searchSeq.current) setResults([]); });
    }, 250);
    return () => clearTimeout(h);
  }, [q]);

  useEffect(() => {
    const onDoc = (e) => { if (!searchRef.current?.contains(e.target)) setSearchOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  // Bounded rows come from the server aggregate — no full plan list in browser memory.
  const pendingPlans = data?.clinical_tasks?.pending_plan_rows || [];
  const unscheduledSessions = data?.clinical_tasks?.unscheduled_session_rows || [];

  if (error && !data) {
    return (
      <div className="page">
        <div className="form-error" role="alert">Failed to load dashboard: {error}</div>
        <button className="btn btn-outline mt-12" onClick={load}>Retry</button>
      </div>
    );
  }
  if (!data) {
    // Skeleton in the content area only — sidebar and topbar stay interactive.
    return (
      <div className="page" aria-busy="true">
        <div className="skeleton skeleton-title" />
        <div className="skeleton skeleton-line" style={{ width: '30%' }} />
        <div className="stat-grid" style={{ marginTop: 16 }}>
          <div className="skeleton skeleton-card" />
          <div className="skeleton skeleton-card" />
          <div className="skeleton skeleton-card" />
        </div>
      </div>
    );
  }

  const statusMap = Object.fromEntries(data.statuses.map((s) => [s.status, s.c]));
  const todayTotal = data.statuses.reduce((s, r) => s + r.c, 0);
  const endWall = (a) => (tz
    ? DateTime.fromISO(a.start_at).setZone(tz).plus({ minutes: a.duration_min }).toFormat('HH:mm')
    : '');

  const balanceChip = (cents) => {
    if (cents === undefined || cents === null) return null;
    if (cents <= 0) return <span className="badge" style={{ background: 'var(--ok-soft)', color: 'var(--ok)', borderColor: '#d5e8b2' }}>Paid</span>;
    return <span className="badge" style={{ background: 'var(--warn-soft)', color: 'var(--warn)', borderColor: '#f5d9a8' }}>{money(cents)} due</span>;
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{greetingKey(t)}, {greetingName(user.full_name)} 👋</h1>
          <div className="desc">{clinic?.name} · {t('dash.subtitle')}</div>
        </div>
        <div className="flex" style={{ gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {/* global patient search: name, phone or record number */}
          <div className="search-box" ref={searchRef} style={{ position: 'relative', minWidth: 220 }}>
            <IconSearch size={15} />
            <input
              className="input" placeholder={lang === 'ar' ? 'بحث عن مريض…' : 'Find patient (name / phone / #)'}
              value={q} aria-label="Global patient search"
              onChange={(e) => setQ(e.target.value)}
              onFocus={() => q && setSearchOpen(true)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && results?.length) { navigate(`/patients/${results[0].id}`); setSearchOpen(false); }
                if (e.key === 'Escape') setSearchOpen(false);
              }}
            />
            {searchOpen && results && (
              <div className="combo-list" style={{ top: 'calc(100% + 4px)' }}>
                {results.length === 0 && <div className="combo-item muted">No matches</div>}
                {results.map((p) => (
                  <button type="button" key={p.id} className="combo-item" style={{ width: '100%', border: 'none', background: 'transparent', textAlign: 'start' }}
                    onClick={() => { navigate(`/patients/${p.id}`); setSearchOpen(false); setQ(''); }}>
                    <span><b>{p.first_name} {p.last_name}</b> <span className="sub mono">{p.mrn}</span></span>
                    <span className="sub" dir="ltr">{p.phone || ''}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          {canBook && <button className="btn btn-primary" onClick={() => setShowAppt(true)}><IconPlus size={16}/> {lang === 'ar' ? 'موعد جديد' : 'New Appointment'}</button>}
          {canRegister && <button className="btn btn-outline" onClick={() => navigate('/patients?new=1')}><IconUsers size={15}/> {lang === 'ar' ? 'مريض جديد' : 'New Patient'}</button>}
          {canBill && <button className="btn btn-outline" onClick={() => navigate('/invoices?new=1')}><IconInvoice size={15}/> {lang === 'ar' ? 'فاتورة جديدة' : 'New Invoice'}</button>}
          <Link to="/appointments" className="btn btn-outline"><IconCalendar size={16}/> {lang === 'ar' ? 'فتح التقويم' : 'Open calendar'}</Link>
        </div>
      </div>

      <div className="stat-grid">
        <Link to="/appointments" className="card stat-card" style={{ textDecoration: 'none', color: 'inherit' }}>
          <span className="stat-ico"><IconCalendar /></span>
          <span className="lbl">{t('dash.todayAppts')}</span>
          <span className="val">{data.today.appointments}</span>
          <span className="foot">{data.upcoming.count} {lang === 'ar' ? 'مواعيد قادمة' : 'more upcoming'}</span>
        </Link>
        <Link to="/patients" className="card stat-card" style={{ textDecoration: 'none', color: 'inherit' }}>
          <span className="stat-ico"><IconUsers /></span>
          <span className="lbl">{t('dash.patients')}</span>
          <span className="val">{data.patients}</span>
          <span className="foot">{lang === 'ar' ? 'إجمالي المرضى' : 'Active patient panel'}</span>
        </Link>
        <Link to={user.role === 'owner' ? '/staff' : '/appointments'} className="card stat-card" style={{ textDecoration: 'none', color: 'inherit' }}>
          <span className="stat-ico"><IconSteth /></span>
          <span className="lbl">{t('dash.careTeam')}</span>
          <span className="val">{data.active_doctors}</span>
          <span className="foot">{data.active_staff} {lang === 'ar' ? 'موظفين نشطين' : 'other staff active'}</span>
        </Link>
        {data.revenue && (
          <Link to={canBill ? '/invoices' : '/appointments'} className="card stat-card" style={{ textDecoration: 'none', color: 'inherit' }}>
            <span className="stat-ico" style={{ background: 'var(--warn-soft)', color: 'var(--warn)' }}><IconCard /></span>
            <span className="lbl">{t('dash.outstanding')}</span>
            <span className="val">{money(data.revenue.outstanding_cents)}</span>
            <span className="foot">{money(data.revenue.last_30_days_cents)} collected in last 30 days</span>
          </Link>
        )}
      </div>

      {(data.waiting_now?.length > 0 || data.in_treatment?.length > 0 || data.clinical_tasks) && (
        <div className="sum-chips">
          <div className="sum-chip" role="status">
            <b>{data.waiting_now?.length || 0}</b>
            <span>{lang === 'ar' ? 'في غرفة الانتظار الآن' : 'In waiting room now'}</span>
          </div>
          <div className="sum-chip" role="status">
            <b>{data.in_treatment?.length || 0}</b>
            <span>{lang === 'ar' ? 'قيد العلاج الآن' : 'In treatment right now'}</span>
          </div>
          {data.clinical_tasks && (
            <>
              <div className="sum-chip"><b>{data.clinical_tasks.draft_records}</b><span>{lang === 'ar' ? 'ملاحظات سريرية غير مكتملة' : 'Incomplete clinical notes'}</span></div>
              <div className="sum-chip"><b>{data.clinical_tasks.pending_plans}</b><span>{lang === 'ar' ? 'خطط علاج بانتظار الموافقة' : 'Plans awaiting approval'}</span></div>
              <div className="sum-chip"><b>{data.clinical_tasks.unscheduled_sessions}</b><span>{lang === 'ar' ? 'جلسات بانتظار الجدولة' : 'Sessions to schedule'}</span></div>
              <div className="sum-chip"><b>{data.clinical_tasks.upcoming_follow_ups}</b><span>{lang === 'ar' ? 'متابعات قادمة' : 'Follow-ups ahead'}</span></div>
            </>
          )}
        </div>
      )}

      <div className="dash-grid">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
          {data.waiting_now?.length > 0 && (
            <div className="card card-pad">
              <div className="card-title">{lang === 'ar' ? 'غرفة الانتظار' : 'Waiting room'} <span className="muted small">· checked in</span></div>
              {data.waiting_now.map((a) => (
                <div key={a.id} className="dash-list-item row-link" onClick={() => navigate(`/visits/${a.id}`)}>
                  <span className="dash-time">{a.local_time}</span>
                  <span className="who"><b style={{ cursor: 'pointer' }} title={a.patient_id ? 'Open patient' : undefined} onClick={(e) => { e.stopPropagation(); navigate(`/patients/${a.patient_id}`); }}>{a.patient_name}</b><span>{a.doctor_name}{a.service_name ? ` · ${a.service_name}` : ''}</span></span>
                  {balanceChip(a.patient_balance_cents)}
                  <StatusBadge status={a.status} />
                </div>
              ))}
            </div>
          )}
          {data.in_treatment?.length > 0 && (
            <div className="card card-pad">
              <div className="card-title">{lang === 'ar' ? 'قيد العلاج' : 'In treatment'}</div>
              {data.in_treatment.map((a) => (
                <div key={a.id} className="dash-list-item row-link" onClick={() => navigate(`/visits/${a.id}`)}>
                  <span className="dash-time">{a.local_time}</span>
                  <span className="who"><b style={{ cursor: 'pointer' }} title={a.patient_id ? 'Open patient' : undefined} onClick={(e) => { e.stopPropagation(); navigate(`/patients/${a.patient_id}`); }}>{a.patient_name}</b><span>{a.doctor_name}{a.service_name ? ` · ${a.service_name}` : ''}</span></span>
                  <StatusBadge status={a.status} />
                </div>
              ))}
            </div>
          )}

          <div className="card card-pad">
            <div className="card-title">Today's schedule <Link to="/appointments" className="small">View calendar →</Link></div>
            {data.today.list.length === 0 ? (
              <EmptyState icon="🗓" title="No appointments today">
                Enjoy the quiet — or book a patient from the calendar.
              </EmptyState>
            ) : (
              data.today.list.map((a) => (
                <div key={a.id} className="dash-list-item row-link" onClick={() => navigate(`/visits/${a.id}`)}>
                  <span className="dash-time">{a.local_time}–{endWall(a)}</span>
                  <span className="who"><b style={{ cursor: 'pointer' }} title={a.patient_id ? 'Open patient' : undefined} onClick={(e) => { e.stopPropagation(); navigate(`/patients/${a.patient_id}`); }}>{a.patient_name}</b><span>{a.doctor_name}{a.service_name ? ` · ${a.service_name}` : ''}</span></span>
                  {balanceChip(a.patient_balance_cents)}
                  <StatusBadge status={a.status} />
                </div>
              ))
            )}
          </div>

          <div className="card card-pad">
            <div className="card-title">Today by status</div>
            {todayTotal === 0 ? (
              <div className="muted small">No appointments recorded for today yet.</div>
            ) : (
              <>
                <div className="status-bar">
                  {STATUS_ORDER.map((s) => statusMap[s]
                    ? <i key={s} style={{ width: `${(statusMap[s] / todayTotal) * 100}%`, background: STATUS_META[s].color }} title={`${STATUS_META[s].label}: ${statusMap[s]}`} />
                    : null)}
                </div>
                <div className="status-key">
                  {STATUS_ORDER.map((s) => (
                    <button type="button" key={s} className="sk" style={{ border: 'none', background: 'transparent', cursor: 'pointer', font: 'inherit', color: 'inherit' }}
                      onClick={() => navigate(`/appointments?statuses=${s}`)} title={`Open ${STATUS_META[s].label} appointments`}>
                      <i style={{ background: STATUS_META[s].color }} />{STATUS_META[s].label}: <b>{statusMap[s] || 0}</b>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          <div className="card card-pad">
            <div className="card-title">Upcoming appointments</div>
            {data.upcoming.list.length === 0 ? (
              <EmptyState icon="📭" title="Nothing scheduled ahead" />
            ) : (
              data.upcoming.list.map((a) => (
                <div key={a.id} className="dash-list-item row-link" onClick={() => navigate(`/visits/${a.id}`)}>
                  <span className="dash-time" style={{ width: 108 }}>{a.local_date.split('-').slice(1).join('/')}&nbsp;{a.local_time}–{endWall(a)}</span>
                  <span className="who"><b style={{ cursor: 'pointer' }} title={a.patient_id ? 'Open patient' : undefined} onClick={(e) => { e.stopPropagation(); navigate(`/patients/${a.patient_id}`); }}>{a.patient_name}</b><span>{a.doctor_name}{a.service_name ? ` · ${a.service_name}` : ''}</span></span>
                  <StatusBadge status={a.status} />
                </div>
              ))
            )}
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
          {isClinical && (pendingPlans.length > 0 || unscheduledSessions.length > 0) && (
            <div className="card card-pad">
              <div className="card-title"><IconFileText size={15} /> Clinical tasks</div>
              {pendingPlans.map((p) => (
                <div key={`p${p.id}`} className="dash-list-item row-link" onClick={() => navigate(`/patients/${p.patient_id}?tab=plans&plan=${p.id}`)}>
                  <span className="who"><b>{p.patient_name}</b><span>Plan awaiting approval: {p.title}</span></span>
                  <span className="badge" style={{ background: 'var(--warn-soft)', color: 'var(--warn)', borderColor: '#f5d9a8' }}>approval</span>
                </div>
              ))}
              {unscheduledSessions.map((r) => (
                <div key={`s${r.session_id}`} className="dash-list-item row-link" onClick={() => navigate(`/patients/${r.patient_id}?tab=plans&plan=${r.plan_id}`)}>
                  <span className="who"><b>{r.patient_name}</b><span>{r.title} · {r.item_count} procedure(s) · needs a slot</span></span>
                  <span className="badge" style={{ background: 'var(--accent-soft)', color: 'var(--accent-2)', borderColor: 'var(--accent)' }}>schedule</span>
                </div>
              ))}
            </div>
          )}
          {data.revenue && (
            <div className="card card-pad">
              <div className="card-title">Revenue</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div className="flex-between"><span className="muted small">Collected (all time)</span><b className="mono">{money(data.revenue.total_cents)}</b></div>
                <div className="flex-between"><span className="muted small">Collected (last 30 days)</span><b className="mono">{money(data.revenue.last_30_days_cents)}</b></div>
                <div className="flex-between"><span className="muted small">Outstanding</span><b className="mono" style={{ color: 'var(--danger)' }}>{money(data.revenue.outstanding_cents)}</b></div>
              </div>
            </div>
          )}

          <div className="card card-pad" style={{ flex: 1 }}>
            <div className="card-title">Recent activity</div>
            {data.activity.length === 0 ? (
              <EmptyState icon="🕐" title="No activity yet" />
            ) : (
              data.activity.map((a, i) => (
                <div key={i} className="activity-item">
                  <span className="atico">{KIND_ICONS[a.kind] || 'ℹ️'}</span>
                  <span className="atxt">{a.message}</span>
                  <span className="atime">{relTime(a.created_at)}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {showAppt && (
        <AppointmentModal mode="create" onClose={() => setShowAppt(false)} onSaved={() => { setShowAppt(false); load(); }} />
      )}
    </div>
  );
}
