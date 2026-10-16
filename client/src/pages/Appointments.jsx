import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { DateTime } from 'luxon';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import listPlugin from '@fullcalendar/list';
import interactionPlugin from '@fullcalendar/interaction';
import luxon3Plugin from '@fullcalendar/luxon3';
import arLocale from '@fullcalendar/core/locales/ar';
import { api } from '../api.js';
import { useAuth, useClinicMeta } from '../auth.jsx';
import { useI18n } from '../i18n.jsx';
import { useToast, useConfirm, Spinner, EmptyState, StatusBadge, Pagination } from '../components/ui.jsx';
import AppointmentModal from '../components/AppointmentModal.jsx';
import AppointmentDetail from '../components/AppointmentDetail.jsx';
import { STATUS_META, STATUS_ORDER, relTime } from '../format.js';
import {
  IconChevL, IconChevR, IconPlus, IconSearch, IconCalendar, IconGrid as IconList,
  IconEdit, IconCheck, IconAlert, IconClock, IconX, IconUsers,
  IconSteth,
} from '../components/icons.jsx';

const DRAGGABLE = ['scheduled', 'confirmed', 'checked_in'];

/**
 * Operational work queues for the list workspace. Each tab pins a day offset
 * (relative to "today" in the clinic timezone) and, where the workflow implies
 * it, a status subset. `all` is the unbounded, paged history browser.
 * Statuses here are exactly the ones the API/DB define — nothing invented.
 */
const TAB_DEFS = [
  { id: 'today', dayOffset: 0 },
  { id: 'tomorrow', dayOffset: 1 },
  { id: 'upcoming', fromNow: true, statuses: ['scheduled', 'confirmed'] },
  { id: 'awaiting_arrival', dayOffset: 0, statuses: ['scheduled', 'confirmed'] },
  { id: 'arrived', dayOffset: 0, arrival: ['arrived'] },
  { id: 'waiting', dayOffset: 0, statuses: ['checked_in', 'in_progress'] },
  { id: 'in_progress', dayOffset: 0, statuses: ['in_progress'] },
  { id: 'completed', dayOffset: 0, statuses: ['completed'] },
  { id: 'cancelled', dayOffset: 0, statuses: ['cancelled'] },
  { id: 'no_show', dayOffset: 0, statuses: ['no_show'] },
  { id: 'all' },
];

/**
 * FullCalendar hands us native Dates, but with the luxon3 plugin some callbacks
 * receive Luxon DateTime objects. Normalize both to an ISO-8601 string so a
 * calendar callback can never crash the render tree.
 */
function toIso(d) {
  if (!d) return new Date().toISOString();
  if (typeof d.toISOString === 'function') return d.toISOString(); // native Date
  if (typeof d.toUTC === 'function') return d.toUTC().toISO(); // Luxon DateTime
  return new Date(String(d)).toISOString();
}

function useIsMobile() {
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 860px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 860px)');
    const fn = (e) => setMobile(e.matches);
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
  }, []);
  return mobile;
}

/** Default visible range: the current clinic-local week (Sunday start). */
function weekRangeAround(date, tz) {
  const day = tz ? DateTime.fromJSDate(date).setZone(tz) : DateTime.fromJSDate(date);
  const start = day.startOf('week'); // luxon weeks start Monday; shift to Sunday
  const sunday = start.minus({ days: (start.weekday % 7) });
  return { start: sunday.startOf('day'), end: sunday.plus({ days: 7 }).startOf('day') };
}

export default function Appointments() {
  const { user } = useAuth();
  const { clinic, doctors, allDoctors, branches, doctorProfile } = useClinicMeta();
  const { t, lang } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const [searchParams, setSearchParams] = useSearchParams();

  const tz = clinic?.timezone || null;
  const nowTz = useCallback(() => (tz ? DateTime.now().setZone(tz) : DateTime.now()), [tz]);
  const todayTz = useCallback(() => nowTz().startOf('day'), [nowTz]);

  /* ---------------- shared view + filter state ---------------- */
  // List-first: the operational list is the default workspace for every role;
  // the calendar stays one clear click away (button + ?view=calendar deep link).
  const [view, setView] = useState(() => (searchParams.get('view') === 'calendar' ? 'calendar' : 'list'));
  const [calView, setCalView] = useState(() => (window.matchMedia('(max-width: 860px)').matches ? 'timeGridDay' : 'timeGridWeek'));
  const [focusDate, setFocusDate] = useState(() => new Date());
  const [range, setRange] = useState(() => {
    const r = weekRangeAround(new Date(), tz);
    return { start: r.start.toUTC().toISO(), end: r.end.toUTC().toISO() };
  });
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  const [doctorFilter, setDoctorFilter] = useState('all');
  const [branchFilter, setBranchFilter] = useState('all');
  const [statusOn, setStatusOn] = useState(() => {
    // deep-link preset: /appointments?statuses=completed,no_show (dashboard chips)
    const st = new URLSearchParams(window.location.search).get('statuses');
    if (st) {
      const list = st.split(',').map((x) => x.trim()).filter((x) => STATUS_ORDER.includes(x));
      if (list.length) return new Set(list);
    }
    return new Set(STATUS_ORDER);
  });
  const [filtersOpen, setFiltersOpen] = useState(false); // mobile disclosure
  const filtersRef = useRef({ doctorFilter, branchFilter, statusOn, q });
  filtersRef.current = { doctorFilter, branchFilter, statusOn, q };

  /* ---------------- list workspace state (ops tabs) ---------------- */
  const [tab, setTab] = useState('today');
  const [dayOffset, setDayOffset] = useState(0); // extra days on top of the tab's base day
  const [sort, setSort] = useState('time_asc');
  const tabDef = TAB_DEFS.find((d) => d.id === tab) || TAB_DEFS[0];

  /** The clinic-local day the list is showing (null on the unbounded tab). */
  const listDay = useMemo(() => {
    if (tabDef.dayOffset === undefined) return null;
    return todayTz().plus({ days: tabDef.dayOffset + dayOffset });
  }, [tabDef, dayOffset, todayTz, tz]);

  /** Range for the list request; null on the `all` tab (whole history). */
  const listRange = useMemo(() => (listDay
    ? { start: listDay.startOf('day').toUTC().toISO(), end: listDay.plus({ days: 1 }).startOf('day').toUTC().toISO() }
    : null), [listDay]);

  function selectTab(next) {
    setTab(next);
    setDayOffset(0);
    setSort(next === 'all' ? 'time_desc' : 'time_asc');
    const def = TAB_DEFS.find((d) => d.id === next);
    if (def && def.dayOffset !== undefined) {
      setFocusDate(todayTz().plus({ days: def.dayOffset }).toJSDate());
    }
  }

  // debounce the search box so quick typing doesn't spam requests
  useEffect(() => {
    const id = setTimeout(() => setQ(qInput.trim()), 300);
    return () => clearTimeout(id);
  }, [qInput]);

  /* ---------------- modals ---------------- */
  const [createModal, setCreateModal] = useState(null); // { start?, end?, patient? }
  const [editAppt, setEditAppt] = useState(null);
  const [detailAppt, setDetailAppt] = useState(null);

  const canManage = ['owner', 'receptionist', 'doctor'].includes(user?.role);

  /* ---------------- waiting list (patients asking for an earlier slot) ---------------- */
  const [waitingList, setWaitingList] = useState([]);
  const [wlBooking, setWlBooking] = useState(null); // waiting entry being booked
  const loadWaiting = useCallback(() => {
    if (!canManage) return;
    api('/waiting').then((r) => setWaitingList(r.items || [])).catch(() => setWaitingList([]));
  }, [canManage]);
  useEffect(() => { loadWaiting(); }, [loadWaiting]);
  async function wlResolve(w, status, appointmentId) {
    try {
      await api(`/waiting/${w.id}/resolve`, { method: 'POST', body: { status, ...(appointmentId ? { appointment_id: appointmentId } : {}) } });
      toast.success(status === 'booked' ? (lang === 'ar' ? 'تم ربط إدخال قائمة الانتظار بالحجز الجديد.' : 'Waiting list entry linked to the new booking.') : (lang === 'ar' ? 'تم إزالة إدخال قائمة الانتظار.' : 'Waiting list entry removed.'));
    } catch (e) { toast.error(e.message); }
    loadWaiting();
  }
  const canClinical = ['owner', 'doctor'].includes(user?.role);

  /* ---------------- summary (today, clinic timezone) ---------------- */
  const [summary, setSummary] = useState(null);
  const loadSummary = useCallback(async () => {
    try {
      // Stage K: real per-status/per-arrival counts aggregated by the server
      // for today in the clinic timezone — one light query, no row transfer.
      const res = await api(`/appointments/summary?date=${new Date().toISOString()}`);
      setSummary(res);
    } catch { setSummary(null); }
  }, []);
  useEffect(() => { loadSummary(); }, [loadSummary]);

  const tabCounts = useMemo(() => (summary ? {
    today: summary.total,
    awaiting_arrival: (summary.by_status.scheduled || 0) + (summary.by_status.confirmed || 0),
    arrived: summary.by_arrival.arrived || 0,
    waiting: (summary.by_status.checked_in || 0) + (summary.by_status.in_progress || 0),
    in_progress: summary.by_status.in_progress || 0,
    completed: summary.by_status.completed || 0,
    cancelled: summary.by_status.cancelled || 0,
    no_show: summary.by_status.no_show || 0,
  } : null), [summary]);

  /* ---------------- list view data (paged, race-guarded) ---------------- */
  const [list, setList] = useState(null);
  const [listMeta, setListMeta] = useState({ page: 1, pages: 1, total: 0 });
  const [listPage, setListPage] = useState(1);
  const [listError, setListError] = useState('');
  const seq = useRef(0);
  const listStateRef = useRef({ listRange, tabDef, sort });
  listStateRef.current = { listRange, tabDef, sort };

  const loadList = useCallback(async (page = 1) => {
    const my = ++seq.current;
    setListError('');
    const f = filtersRef.current;
    const st = listStateRef.current;
    const params = new URLSearchParams({ page: String(page), limit: '25', sort: st.sort });
    if (st.listRange) {
      params.set('start', st.listRange.start);
      params.set('end', st.listRange.end);
    } else if (st.tabDef.fromNow) {
      params.set('start', new Date().toISOString()); // upcoming: from now on
    }
    if (st.tabDef.arrival) params.set('arrival', st.tabDef.arrival.join(','));
    if (f.doctorFilter !== 'all') params.set('doctor_id', f.doctorFilter);
    if (f.branchFilter !== 'all') params.set('branch_id', f.branchFilter);
    const statuses = st.tabDef.statuses
      || (f.statusOn.size !== STATUS_ORDER.length && f.statusOn.size > 0 ? [...f.statusOn] : null);
    if (statuses) params.set('statuses', statuses.join(','));
    if (f.q) params.set('q', f.q);
    try {
      const data = await api(`/appointments?${params.toString()}`);
      if (my !== seq.current) return; // a newer request superseded this one
      setList(data.appointments);
      setListMeta({ page: data.page, pages: data.pages, total: data.total });
      setListPage(page);
    } catch (e) {
      if (my !== seq.current) return;
      setListError(e.message);
      setList(null);
    }
  }, []);

  useEffect(() => {
    if (view === 'list') loadList(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, tab, dayOffset, sort, doctorFilter, branchFilter, statusOn, q, tz]);

  /* ---------------- calendar event sources ---------------- */
  const calRef = useRef(null);
  const [calLoading, setCalLoading] = useState(false);
  const [calError, setCalError] = useState('');

  const fetchEvents = useCallback(async (info, success, failure) => {
    const f = filtersRef.current;
    const params = new URLSearchParams({ start: toIso(info.start), end: toIso(info.end) });
    if (f.doctorFilter !== 'all') params.set('doctor_id', f.doctorFilter);
    if (f.branchFilter !== 'all') params.set('branch_id', f.branchFilter);
    if (f.q) params.set('q', f.q);
    if (f.statusOn.size !== STATUS_ORDER.length) {
      if (f.statusOn.size === 0) { success([]); return; }
      params.set('statuses', [...f.statusOn].join(','));
    }
    try {
      const data = await api(`/appointments?${params.toString()}`);
      setCalError('');
      // map by id so FullCalendar can never render duplicates
      const seen = new Set();
      success(data.appointments.filter((a) => (seen.has(a.id) ? false : (seen.add(a.id), true))).map((a) => ({
        id: String(a.id),
        start: a.start_at,
        end: new Date(new Date(a.start_at).getTime() + a.duration_min * 60000).toISOString(),
        title: `${a.patient_name} · ${a.doctor_name}`,
        editable: DRAGGABLE.includes(a.status),
        extendedProps: a,
      })));
    } catch (err) {
      setCalError(err.message);
      failure(err);
    }
  }, []);

  const fetchUnavailability = useCallback(async (info, success) => {
    try {
      const data = await api(`/schedule/unavailability?start=${toIso(info.start)}&end=${toIso(info.end)}`);
      const f = filtersRef.current;
      success(data.unavailability
        .filter((u) => f.doctorFilter === 'all' || String(u.doctor_id) === String(f.doctorFilter))
        .map((u) => ({
          id: `leave-${u.id}`,
          start: u.start_at,
          end: u.end_at,
          display: 'background',
          extendedProps: { isLeave: true, reason: u.reason, doctor_name: u.doctor_name },
        })));
    } catch { success([]); }
  }, []);

  useEffect(() => {
    if (view === 'calendar') calRef.current?.getApi().refetchEvents();
  }, [doctorFilter, branchFilter, statusOn, q, view]);

  const refreshAll = useCallback(() => {
    calRef.current?.getApi().refetchEvents();
    loadList(listPage);
    loadSummary();
    loadWaiting();
  }, [loadList, loadSummary, loadWaiting, listPage]);

  /* ---------------- deep link: /appointments?patient_id= ---------------- */
  useEffect(() => {
    const pid = searchParams.get('patient_id');
    if (!pid || !canManage) return;
    (async () => {
      try {
        const d = await api(`/patients/${pid}`);
        setCreateModal({ patient: d.patient });
      } catch { /* user can pick manually */ }
      setSearchParams({}, { replace: true });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------------- calendar rendering helpers ---------------- */
  const businessHours = useMemo(() => Object.entries(clinic?.working_hours || {}).map(([day, w]) => ({
    daysOfWeek: [Number(day)], startTime: w.start, endTime: w.end,
  })), [clinic]);

  const dayBounds = useMemo(() => {
    const wh = clinic?.working_hours || {};
    let min = '08:00', max = '18:00';
    for (const w of Object.values(wh)) {
      if (w.start < min) min = w.start;
      if (w.end > max) max = w.end;
    }
    return {
      min: `${String(Math.max(0, parseInt(min, 10) - 1)).padStart(2, '0')}:00`,
      max: `${String(Math.min(23, parseInt(max, 10) + 1)).padStart(2, '0')}:00`,
      scroll: min,
    };
  }, [clinic]);

  const slotMinutes = useMemo(() => Math.min(120, Math.max(5, Number(clinic?.slot_minutes) || 30)), [clinic]);
  const doctorColorOf = useCallback((id) => allDoctors.find((x) => String(x.id) === String(id))?.color || null, [allDoctors]);

  function eventContent(info) {
    const a = info.event.extendedProps;
    const m = STATUS_META[a.status] || STATUS_META.scheduled;
    const docColor = doctorColorOf(a.doctor_id);
    const time = fmtWall(a.start_at);
    if (info.view.type.startsWith('timeGrid')) {
      return {
        html: `
          <div class="evt-time">${time} · ${a.duration_min}m</div>
          <div class="evt-title">${escapeHtml(a.patient_name || '—')}</div>
          <div class="evt-sub">${escapeHtml(a.doctor_name || '')}${a.service_name ? ` · ${escapeHtml(a.service_name)}` : ''}</div>`,
      };
    }
    if (info.view.type === 'dayGridMonth') {
      return {
        html: `
          <div class="evt-pill-inner" style="background:${m.bg};border-color:${m.border};color:${m.fg}">
            ${docColor ? `<span class="pdot" style="background:${docColor}" title="${escapeHtml(a.doctor_name || '')}"></span>` : ''}
            <span class="pdot" style="background:${m.color}"></span>
            <span class="ptime">${time}</span>
            <span class="pname">${escapeHtml(a.patient_name || '—')}</span>
          </div>`,
      };
    }
    return { html: `<span style="font-weight:600">${escapeHtml(a.patient_name || '')}</span> <span style="color:#64748b">with ${escapeHtml(a.doctor_name || '')}</span>` };
  }

  function eventDidMount(info) {
    const a = info.event.extendedProps;
    if (a.isLeave) {
      info.el.classList.add('evt-leave');
      info.el.setAttribute('title', `${a.doctor_name || (lang === 'ar' ? 'طبيب' : 'Doctor')} ${lang === 'ar' ? 'غير متاح' : 'unavailable'}${a.reason ? ` — ${a.reason}` : ''}`);
      return;
    }
    const m = STATUS_META[a.status] || STATUS_META.scheduled;
    const docColor = doctorColorOf(a.doctor_id);
    if (info.view.type.startsWith('timeGrid')) {
      info.el.classList.add('evt-solid');
      info.el.style.backgroundColor = m.color;
      info.el.style.borderColor = m.color;
      info.el.style.opacity = a.status === 'cancelled' ? 0.55 : 1;
      if (docColor) info.el.style.borderInlineStart = `4px solid ${docColor}`;
    } else if (info.view.type === 'dayGridMonth') {
      info.el.classList.add('evt-pill');
    } else {
      const dot = info.el.querySelector('.fc-list-event-dot');
      if (dot) dot.style.borderColor = m.color;
    }
    info.el.setAttribute('title', `${a.patient_name} — ${m.label}`);
  }

  function fmtWall(iso) {
    const dt = tz ? DateTime.fromISO(iso).setZone(tz) : DateTime.fromISO(iso);
    return dt.toFormat('HH:mm');
  }
  function fmtWallFull(iso) {
    const dt = tz ? DateTime.fromISO(iso).setZone(tz) : DateTime.fromISO(iso);
    return { date: dt.toFormat('yyyy-MM-dd'), time: dt.toFormat('HH:mm'), weekday: dt.toFormat('ccc') };
  }

  /* ---------------- calendar interactions ---------------- */
  function handleSelect(info) {
    if (!canManage) return;
    if (info.view.type === 'dayGridMonth') {
      calRef.current.getApi().gotoDate(info.startStr);
      calRef.current.getApi().changeView('timeGridDay');
      return;
    }
    setCreateModal({ start: info.start, end: info.end });
    info.view.calendar.unselect();
  }

  function handleEventClick(info) {
    if (info.event.extendedProps.isLeave) return;
    setDetailAppt(info.event.extendedProps);
  }

  async function applyMove(info, label) {
    const ev = info.event;
    const appt = ev.extendedProps;
    const newStart = ev.start;
    const newDur = Math.max(5, Math.round((ev.end - ev.start) / 60000));
    const proceed = await confirm({
      title: label,
      message: `Move ${appt.patient_name}'s appointment to ${newStart.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} at ${newStart.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })} (${newDur} min)?`,
      confirmLabel: lang === 'ar' ? 'تطبيق التغيير' : 'Apply change',
    });
    if (!proceed) { info.revert(); return; }
    try {
      await api(`/appointments/${appt.id}`, { method: 'PUT', body: { start_at: newStart.toISOString(), duration_min: newDur } });
      toast.success(lang === 'ar' ? 'تم إعادة جدولة الموعد.' : 'Appointment rescheduled.');
      setDetailAppt(null);
      refreshAll();
    } catch (err) {
      info.revert(); // server rejected -> snap back, never a false success
      toast.error(err.message);
    }
  }

  /* ---------------- quick date navigation (both views) ---------------- */
  const cal = () => calRef.current?.getApi();
  function shiftRange(dir) {
    if (view === 'calendar') {
      if (dir === 0) cal().today(); else if (dir < 0) cal().prev(); else cal().next();
      return;
    }
    if (dir === 0) { setDayOffset(0); setFocusDate(todayTz().plus({ days: tabDef.dayOffset || 0 }).toJSDate()); return; }
    setDayOffset((o) => o + dir);
    if (listDay) setFocusDate(listDay.plus({ days: dir }).toJSDate());
  }
  function gotoDate(d) {
    if (!d) return;
    if (view === 'calendar') { cal().gotoDate(d); return; }
    const chosen = DateTime.fromJSDate(new Date(d));
    if (tabDef.dayOffset === undefined) return; // unbounded tab has no day to jump to
    const base = todayTz().plus({ days: tabDef.dayOffset });
    setDayOffset(Math.round(chosen.startOf('day').diff(base.startOf('day'), 'days').days));
    setFocusDate(chosen.toJSDate());
  }

  /* ---------------- list row actions (role-gated; server re-checks) ---------------- */
  async function patchStatus(a, status, verb) {
    const proceed = await confirm({
      title: verb,
      message: status === 'no_show'
        ? `Record that ${a.patient_name} did not arrive for the ${fmtWall(a.start_at)} appointment with ${a.doctor_name}? This is kept in the audit trail.`
        : `${verb} the appointment for ${a.patient_name} with ${a.doctor_name}?`,
      confirmLabel: verb,
      danger: status === 'cancelled' || status === 'no_show',
    });
    if (!proceed) return;
    try {
      await api(`/appointments/${a.id}/status`, { method: 'PATCH', body: { status } });
      toast.success(`Appointment marked ${STATUS_META[status].label.toLowerCase()}.`);
      refreshAll();
    } catch (e) { toast.error(e.message); }
  }

  /** A no-show may only be recorded once the appointment time has passed. */
  const startHasPassed = useCallback((a) => new Date(a.start_at).getTime() <= Date.now(), []);

  function rowActions(a) {
    const acts = [];
    const isOwn = user.role !== 'doctor' || (doctorProfile && a.doctor_id === doctorProfile.id);
    acts.push(
      <button key="p" className="btn btn-outline btn-sm" title={t('appt.openPatient')} aria-label={`${t('appt.openPatient')}: ${a.patient_name}`}
        onClick={(e) => { e.stopPropagation(); navigate(`/patients/${a.patient_id}`); }}>
        <IconUsers size={13} />
      </button>,
    );
    if (canManage && isOwn && ['scheduled', 'confirmed', 'checked_in'].includes(a.status)) {
      acts.push(<button key="e" className="btn btn-outline btn-sm" title="Edit / reschedule" aria-label="Edit / reschedule" onClick={(e) => { e.stopPropagation(); setEditAppt(a); }}><IconEdit size={13} /></button>);
    }
    // Visit workspace entry: every staff member who can see the row can open
    // the workspace; what it shows/adapts is permission-driven inside.
    if (isOwn) {
      acts.push(<button key="vw" className="btn btn-outline btn-sm" title={t('visit.openWorkspace')} aria-label={t('visit.openWorkspace')} onClick={(e) => { e.stopPropagation(); navigate(`/visits/${a.id}`); }}><IconSteth size={13} /></button>);
    }
    if (canManage && isOwn && ['scheduled', 'confirmed'].includes(a.status)) {
      acts.push(<button key="ci" className="btn btn-outline btn-sm" onClick={(e) => { e.stopPropagation(); patchStatus(a, 'checked_in', lang === 'ar' ? 'تسجيل وصول' : 'Check in'); }}>{lang === 'ar' ? 'تسجيل وصول' : 'Check in'}</button>);
    }
    if (canClinical && isOwn && a.status === 'checked_in') {
      acts.push(<button key="sv" className="btn btn-primary btn-sm" onClick={(e) => { e.stopPropagation(); patchStatus(a, 'in_progress', lang === 'ar' ? 'بدء الزيارة' : 'Start visit'); }}>{lang === 'ar' ? 'بدء الزيارة' : 'Start visit'}</button>);
    }
    if (canClinical && isOwn && a.status === 'in_progress') {
      acts.push(<button key="cv" className="btn btn-primary btn-sm" onClick={(e) => { e.stopPropagation(); patchStatus(a, 'completed', lang === 'ar' ? 'إكمال الزيارة' : 'Complete visit'); }}><IconCheck size={13} /> {lang === 'ar' ? 'إكمال' : 'Complete'}</button>);
    }
    // No-show: only once the slot time has actually passed (server enforces too),
    // never for upcoming appointments, and only for staff who may manage it.
    if (canManage && isOwn && ['scheduled', 'confirmed', 'checked_in', 'in_progress'].includes(a.status) && startHasPassed(a)) {
      acts.push(<button key="ns" className="btn btn-danger-outline btn-sm" title={t('appt.noShow')} aria-label={t('appt.noShow')} onClick={(e) => { e.stopPropagation(); patchStatus(a, 'no_show', t('appt.noShow')); }}><IconAlert size={13} /></button>);
    }
    if (canManage && isOwn && ['scheduled', 'confirmed'].includes(a.status)) {
      acts.push(<button key="x" className="btn btn-danger-outline btn-sm" title={lang === 'ar' ? 'إلغاء الموعد' : 'Cancel appointment'} aria-label={lang === 'ar' ? 'إلغاء الموعد' : 'Cancel appointment'} onClick={(e) => { e.stopPropagation(); patchStatus(a, 'cancelled', lang === 'ar' ? 'إلغاء' : 'Cancel'); }}><IconX size={13} /></button>);
    }
    if (canManage && isOwn && a.status === 'cancelled') {
      acts.push(<button key="r" className="btn btn-outline btn-sm" title={t('appt.restore')} aria-label={t('appt.restore')} onClick={(e) => { e.stopPropagation(); patchStatus(a, 'scheduled', t('appt.restore')); }}><IconClock size={13} /></button>);
    }
    return acts;
  }

  /* ---------------- render ---------------- */
  const views = isMobile
    ? [['timeGridDay', t('cal.day')], ['listWeek', t('cal.agenda')]]
    : [['dayGridMonth', t('cal.month')], ['timeGridWeek', t('cal.week')], ['timeGridDay', t('cal.day')], ['listWeek', t('cal.agenda')]];

  const tabLabel = (id) => ({
    today: t('appt.tabToday'),
    tomorrow: t('appt.tabTomorrow'),
    upcoming: t('appt.tabUpcoming'),
    awaiting_arrival: t('appt.tabAwaiting'),
    arrived: t('appt.tabArrived'),
    waiting: t('appt.tabWaiting'),
    in_progress: t('appt.tabInProgress'),
    completed: t('status.completed'),
    cancelled: t('status.cancelled'),
    no_show: t('status.no_show'),
    all: t('appt.tabAll'),
  }[id]);

  const listDayLabel = listDay
    ? listDay.toFormat(lang === 'ar' ? 'cccc d LLLL' : 'cccc, d LLLL')
    : null;

  const dateInputValue = view === 'list' && listDay
    ? listDay.toFormat('yyyy-MM-dd')
    : (tz ? DateTime.fromJSDate(focusDate).setZone(tz).toFormat('yyyy-MM-dd') : toInputDate(focusDate));

  return (
    <div className="page" style={{ paddingTop: 14 }}>
      <div className="page-head">
        <div>
          <h1>{t('nav.appointments')}</h1>
          <div className="desc">{clinic?.name} · {tz ? tz.replace('_', ' ') : ''}</div>
        </div>
        {canManage && (
          <button className="btn btn-primary" onClick={() => setCreateModal({})}>
            <IconPlus size={16} /> {t('appt.new')}
          </button>
        )}
      </div>

      {/* today's summary — appointment metrics only (no financial data) */}
      <div className="sum-chips" role="status" aria-label="Today's summary">
        {summary ? (
          <>
            <div className="sum-chip"><b>{summary.today}</b><span>{t('appt.sumToday')}</span></div>
            <div className="sum-chip" style={{ borderColor: '#fde4ad', background: '#fff7e6' }}><b>{summary.checkedIn}</b><span>{t('appt.sumCheckedIn')}</span></div>
            <div className="sum-chip" style={{ borderColor: '#d5e8b2', background: '#f2f8e5' }}><b>{summary.completed}</b><span>{t('appt.sumCompleted')}</span></div>
            <div className="sum-chip" style={{ borderColor: '#f3c1c1', background: '#fffbfa' }}><b>{summary.cancelled}</b><span>{t('appt.sumCancelled')}</span></div>
          </>
        ) : (
          <div className="sum-chip"><span className="muted small">…</span></div>
        )}
      </div>

      {canManage && waitingList.length > 0 && (
        <div className="card card-pad" style={{ marginBottom: 12 }}>
          <div className="card-title">Waiting list <span className="muted small">· patients asking for an earlier slot</span></div>
          {waitingList.map((w) => (
            <div key={w.id} className="dash-list-item">
              <span className="who" style={{ minWidth: 0 }}>
                <b>{w.patient_name}</b>
                <span>{[w.doctor_name, w.service_name].filter(Boolean).join(' · ') || 'Any doctor / service'}{w.reason ? ` · ${w.reason}` : ''}</span>
              </span>
              <span className="muted small" style={{ whiteSpace: 'nowrap' }}>{relTime(w.created_at)}</span>
              <span className="flex" style={{ gap: 6, flexWrap: 'wrap' }}>
                <button className="btn btn-primary btn-sm" onClick={() => {
                  const [first, ...rest] = (w.patient_name || '').split(' ');
                  setWlBooking(w);
                  setCreateModal({ patient: { id: w.patient_id, first_name: first || '', last_name: rest.join(' ') || '', mrn: '' } });
                }}>Book</button>
                <button className="btn btn-outline btn-sm" onClick={() => wlResolve(w, 'cancelled')}>Remove</button>
              </span>
            </div>
          ))}
        </div>
      )}

      {/* operational work queues — the list workspace primary navigation */}
      <div className="tabs ops-tabs" role="tablist" aria-label="Appointment queues">
        {TAB_DEFS.map((d) => {
          const count = tabCounts?.[d.id];
          return (
            <button
              key={d.id}
              className={`tab${tab === d.id ? ' on' : ''}`}
              role="tab"
              aria-selected={tab === d.id}
              onClick={() => selectTab(d.id)}
            >
              {tabLabel(d.id)}
              {count > 0 && <span className="tab-count">{count}</span>}
            </button>
          );
        })}
      </div>

      {/* shared filter + navigation bar */}
      <div className="card cal-filters" style={{ marginBottom: 12 }}>
        <div className="flex" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {tab !== 'all' && (
            <div className="cal-nav-group">
              <button className="btn btn-outline btn-sm" onClick={() => shiftRange(0)}>{t('cal.today')}</button>
              <button className="icon-btn" onClick={() => shiftRange(-1)} aria-label="Previous day"><IconChevL /></button>
              <button className="icon-btn" onClick={() => shiftRange(1)} aria-label="Next day"><IconChevR /></button>
            </div>
          )}
          {tab !== 'all' && (
            <input
              type="date"
              className="input"
              style={{ width: 'auto', padding: '5px 10px', fontSize: 12.5 }}
              value={dateInputValue}
              onChange={(e) => gotoDate(e.target.value)}
              aria-label="Select date"
            />
          )}
          <label className="search-box" style={{ flex: 1, minWidth: 180 }}>
            <IconSearch size={15} />
            <input
              className="input"
              placeholder={t('appt.searchPlaceholder')}
              value={qInput}
              onChange={(e) => setQInput(e.target.value)}
              aria-label={t('appt.searchPlaceholder')}
            />
            {qInput && <button className="icon-btn" onClick={() => setQInput('')} aria-label="Clear search"><IconX size={14} /></button>}
          </label>
          {isMobile && (
            <button className="btn btn-outline btn-sm" aria-expanded={filtersOpen} onClick={() => setFiltersOpen((o) => !o)}>
              {t('appt.filters')}
            </button>
          )}
          <div className="view-switch" role="tablist" aria-label="View">
            <button className={view === 'calendar' ? 'on' : ''} onClick={() => setView('calendar')} role="tab" aria-selected={view === 'calendar'} title={t('appt.openCalendar')}>
              <IconCalendar size={14} /> {t('appt.viewCalendar')}
            </button>
            <button className={view === 'list' ? 'on' : ''} onClick={() => setView('list')} role="tab" aria-selected={view === 'list'} title={t('appt.backToList')}>
              <IconList size={14} /> {t('appt.viewList')}
            </button>
          </div>
        </div>

        {(!isMobile || filtersOpen) && (
          <div className="flex" style={{ gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
            <select className="select" style={{ width: 'auto' }} value={doctorFilter} onChange={(e) => setDoctorFilter(e.target.value)} aria-label="Filter by doctor">
              <option value="all">{t('cal.allDoctors')}</option>
              {doctors.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
            {branches.length > 1 && (
              <select className="select" style={{ width: 'auto' }} value={branchFilter} onChange={(e) => setBranchFilter(e.target.value)} aria-label="Filter by branch">
                <option value="all">{t('cal.allBranches')}</option>
                {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            )}
            <label className="flex" style={{ gap: 6 }}>
              <span className="muted small">{t('appt.sort')}</span>
              <select className="select" style={{ width: 'auto' }} value={sort} onChange={(e) => setSort(e.target.value)} aria-label={t('appt.sort')}>
                <option value="time_asc">{t('appt.sortTimeAsc')}</option>
                <option value="time_desc">{t('appt.sortTimeDesc')}</option>
                <option value="patient">{t('appt.sortPatient')}</option>
                <option value="doctor">{t('appt.sortDoctor')}</option>
              </select>
            </label>
            {tab === 'all' && (
              <div className="checkbox-row" style={{ gap: 6 }}>
                {STATUS_ORDER.map((s) => (
                  <label
                    key={s}
                    className={`check-chip${statusOn.has(s) ? ' active' : ''}`}
                    style={statusOn.has(s) ? { borderColor: STATUS_META[s].color, background: STATUS_META[s].bg, color: STATUS_META[s].fg } : {}}
                  >
                    <input type="checkbox" checked={statusOn.has(s)} onChange={() => setStatusOn((prev) => {
                      const n = new Set(prev);
                      if (n.has(s)) n.delete(s); else n.add(s);
                      return n;
                    })} />
                    {t(`status.${s}`)}
                  </label>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ---------------- calendar view (optional alternative) ---------------- */}
      {view === 'calendar' && (
        <div className="cal-shell">
          <div className="cal-toolbar">
            <button className="btn btn-outline btn-sm" onClick={() => setView('list')}>
              <IconList size={14} /> {t('appt.backToList')}
            </button>
            <div className="cal-title">{calTitlePlaceholder()}</div>
            <div style={{ marginLeft: 'auto' }}>
              <div className="view-switch" role="tablist" aria-label="Calendar view">
                {views.map(([v, label]) => (
                  <button key={v} className={calView === v ? 'on' : ''} onClick={() => { setCalView(v); cal()?.changeView(v); }} role="tab" aria-selected={calView === v}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="cal-body card" style={{ padding: 10, background: 'var(--surface)', position: 'relative' }}>
            {calLoading && <div className="cal-loading"><div className="spinner" /></div>}
            {calError && (
              <div className="form-error" style={{ position: 'absolute', inset: '12px 12px auto 12px', zIndex: 15 }}>
                {t('appt.loadError')} {calError} — <button className="btn btn-sm btn-outline" onClick={() => cal()?.refetchEvents()}>Retry</button>
              </div>
            )}
            <FullCalendar
              ref={calRef}
              plugins={[dayGridPlugin, timeGridPlugin, listPlugin, interactionPlugin, luxon3Plugin]}
              initialView={calView}
              initialDate={focusDate}
              headerToolbar={false}
              height="100%"
              firstDay={0}
              nowIndicator
              dayMaxEvents={3}
              moreLinkClick="popover"
              selectable={canManage}
              selectMirror
              select={handleSelect}
              eventClick={handleEventClick}
              eventDrop={canManage ? (info) => applyMove(info, lang === 'ar' ? 'إعادة جدولة الموعد' : 'Reschedule appointment') : undefined}
              eventResize={canManage ? (info) => applyMove(info, lang === 'ar' ? 'تغيير مدة الموعد' : 'Change appointment duration') : undefined}
              eventSources={[fetchEvents, fetchUnavailability]}
              eventContent={eventContent}
              eventDidMount={eventDidMount}
              businessHours={businessHours}
              timeZone={tz || 'local'}
              locale={lang === 'ar' ? arLocale : 'en'}
              slotMinTime={dayBounds.min}
              slotMaxTime={dayBounds.max}
              scrollTime={dayBounds.scroll}
              slotDuration={{ minutes: slotMinutes }}
              slotLabelInterval={{ minutes: slotMinutes <= 60 && 60 % slotMinutes === 0 ? 60 : slotMinutes }}
              allDaySlot={false}
              expandRows
              stickyHeaderDates
              dayHeaderFormat={{ weekday: 'short', month: 'short', day: 'numeric' }}
              slotLabelFormat={{ hour: '2-digit', minute: '2-digit', hour12: false }}
              eventTimeFormat={{ hour: '2-digit', minute: '2-digit', hour12: false }}
              listDayFormat={{ weekday: 'long', month: 'long', day: 'numeric' }}
              listDaySideFormat={false}
              noEventsContent={() => ({ html: `<div style="padding:36px;text-align:center;color:#64748b">${escapeHtml(t('appt.empty'))}</div>` })}
              loading={setCalLoading}
              datesSet={(info) => {
                setCalView(info.view.type);
                setFocusDate(info.view.currentStart);
                setRange({ start: toIso(info.view?.activeStart ?? info.start), end: toIso(info.view?.activeEnd ?? info.end) });
              }}
              dragScroll
              unselectAuto
            />
          </div>
        </div>
      )}

      {/* ---------------- list view (primary workspace) ---------------- */}
      {view === 'list' && (
        <div className="card">
          <div className="flex-between" style={{ padding: '10px 14px 0 14px' }}>
            <div className="card-title" style={{ marginBottom: 0 }}>
              {tabLabel(tab)}
              {listDayLabel && <span className="muted small"> · {listDayLabel}</span>}
              <span className="muted small"> · {listMeta.total} {listMeta.total === 1 ? 'appointment' : 'appointments'}</span>
            </div>
          </div>
          {listError && <div className="form-error" style={{ margin: 14 }}>{t('appt.loadError')} {listError} — <button className="btn btn-sm btn-outline" onClick={() => loadList(listPage)}>Retry</button></div>}
          {!list && !listError ? <Spinner label={t('common.loading')} /> : list.length === 0 ? (
            <EmptyState icon="🗓" title={t('appt.empty')}>
              {canManage && ['today', 'tomorrow'].includes(tab) ? t('appt.emptyHint') : ''}
            </EmptyState>
          ) : (
            <>
              <div className="table-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>{t('appt.colWhen')}</th>
                      <th>{t('appt.colPatient')}</th>
                      <th className="hide-sm">{t('appt.colDoctor')}</th>
                      <th className="hide-md">{t('appt.colType')}</th>
                      <th>{t('appt.colStatus')}</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((a) => {
                      const w = fmtWallFull(a.start_at);
                      return (
                        <tr key={a.id} className="row-link" onClick={() => setDetailAppt(a)}>
                          <td className="mono">
                            <b>{w.time}</b> <span className="muted small">{w.date}</span>
                            <div className="muted small">{w.weekday} · {a.duration_min} min</div>
                          </td>
                          <td>
                            <b>{a.patient_name}</b>
                            {a.patient_mrn && <div className="muted small mono">MRN {a.patient_mrn}</div>}
                            {a.patient_phone && (
                              <div className="small" dir="ltr">
                                <a href={`tel:${String(a.patient_phone).replace(/[^\d+]/g, '')}`} onClick={(e) => e.stopPropagation()} style={{ color: 'var(--muted)' }}>
                                  {a.patient_phone}
                                </a>
                              </div>
                            )}
                          </td>
                          <td className="hide-sm">
                            <span className="flex" style={{ gap: 6 }}>
                              {a.doctor_color && <span className="pdot" style={{ background: a.doctor_color }} aria-hidden="true"></span>}
                              {a.doctor_name}
                            </span>
                            {a.branch_name && <div className="muted small hide-md">{a.branch_name}</div>}
                          </td>
                          <td className="hide-md">
                            {t(`appt.type.${a.appointment_type || 'new_visit'}`)}
                            {a.service_name && <div className="muted small">{a.service_name}</div>}
                          </td>
                          <td><StatusBadge status={a.status} /></td>
                          <td className="num">
                            <div className="flex" style={{ gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                              {rowActions(a)}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <Pagination page={listMeta.page} pages={listMeta.pages} total={listMeta.total} onPage={loadList} />
            </>
          )}
        </div>
      )}

      {/* ---------------- modals ---------------- */}
      {createModal && (
        <AppointmentModal
          mode="create"
          initial={createModal}
          onClose={() => { setCreateModal(null); setWlBooking(null); }}
          onSaved={(appt) => {
            setCreateModal(null);
            refreshAll();
            if (wlBooking) { wlResolve(wlBooking, 'booked', appt?.id); setWlBooking(null); }
          }}
        />
      )}
      {editAppt && (
        <AppointmentModal
          mode="edit"
          initial={{ appointment: editAppt }}
          onClose={() => setEditAppt(null)}
          onSaved={() => { setEditAppt(null); setDetailAppt(null); refreshAll(); }}
        />
      )}
      {detailAppt && !editAppt && (
        <AppointmentDetail
          appointment={detailAppt}
          onClose={() => setDetailAppt(null)}
          onChanged={(updated) => { setDetailAppt(updated); refreshAll(); }}
          onEdit={(a) => setEditAppt(a)}
        />
      )}
    </div>
  );

  function calTitlePlaceholder() {
    const s = fmtWallFull(range.start);
    const e = fmtWallFull(new Date(new Date(range.end).getTime() - 1000).toISOString());
    return `${s.date} → ${e.date}`;
  }
}

function toInputDate(d) {
  if (!d) return '';
  const dt = d instanceof Date ? d : new Date(d);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
