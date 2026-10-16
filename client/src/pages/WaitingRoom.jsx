import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DateTime } from 'luxon';
import { api } from '../api.js';
import { useAuth, useClinicMeta } from '../auth.jsx';
import { useI18n } from '../i18n.jsx';
import { useToast, useConfirm, Spinner, EmptyState, Modal, Field } from '../components/ui.jsx';
import { PatientFormModal } from './Patients.jsx';
import { STATUS_META } from '../format.js';
import { IconPlus, IconSearch, IconX, IconCheck, IconClock } from '../components/icons.jsx';

const ACTIVE = ['waiting', 'called', 'in_treatment'];
const TABS = [
  { id: 'active', statuses: ACTIVE },
  { id: 'waiting', statuses: ['waiting'] },
  { id: 'called', statuses: ['called'] },
  { id: 'treatment', statuses: ['in_treatment'] },
  { id: 'completed', statuses: ['completed'] },
  { id: 'left', statuses: ['left'] },
];
const WR_COLORS = {
  waiting: { color: '#f59e0b', bg: '#fff7e6', border: '#fde4ad' },
  called: { color: '#3b82f6', bg: '#eef4ff', border: '#c9d8fb' },
  in_treatment: { color: '#8b5cf6', bg: '#f3eeff', border: '#ddd0f9' },
  completed: { color: '#65a30d', bg: '#f2f8e5', border: '#d5e8b2' },
  left: { color: '#94a3b8', bg: '#f1f5f9', border: '#dbe3ea' },
};

function fmtDuration(ms) {
  const min = Math.max(0, Math.round(ms / 60000));
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m`;
}

export default function WaitingRoom() {
  const { user } = useAuth();
  const { clinic, doctors, branches, doctorProfile } = useClinicMeta();
  const { t } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();

  const tz = clinic?.timezone || null;
  const canManage = ['owner', 'receptionist', 'doctor'].includes(user?.role);
  const isFrontDesk = ['owner', 'receptionist'].includes(user?.role);

  const [all, setAll] = useState(null); // every queue entry for today (all statuses)
  const [error, setError] = useState('');
  const [tab, setTab] = useState('active');
  const [doctorFilter, setDoctorFilter] = useState('all');
  const [branchFilter, setBranchFilter] = useState('all');
  const [expected, setExpected] = useState(null); // today's booked, not in queue yet
  const [addOpen, setAddOpen] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [, setTick] = useState(0); // re-renders waiting durations every 30s
  const seq = useRef(0);

  const load = useCallback(async () => {
    const my = ++seq.current;
    setError('');
    try {
      const params = new URLSearchParams({ statuses: 'waiting,called,in_treatment,completed,left' });
      if (doctorFilter !== 'all') params.set('doctor_id', doctorFilter);
      if (branchFilter !== 'all') params.set('branch_id', branchFilter);
      const wr = await api(`/waiting-room?${params.toString()}`);
      if (my !== seq.current) return;
      setAll(wr.items);
    } catch (e) {
      if (my !== seq.current) return;
      setError(e.message);
      setAll(null);
    }
  }, [doctorFilter, branchFilter]);

  const loadExpected = useCallback(async () => {
    if (!clinic) return;
    try {
      const now = tz ? DateTime.now().setZone(tz) : DateTime.now();
      const start = now.startOf('day').toUTC().toISO();
      const end = now.plus({ days: 1 }).startOf('day').toUTC().toISO();
      const res = await api(`/appointments?start=${start}&end=${end}&statuses=scheduled,confirmed&limit=200`);
      setExpected(res.appointments);
    } catch { setExpected([]); }
  }, [clinic, tz]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadExpected(); }, [loadExpected]);
  useEffect(() => {
    const id = setInterval(() => setTick((x) => x + 1), 30000);
    return () => clearInterval(id);
  }, []);

  const refresh = useCallback(() => { load(); loadExpected(); }, [load, loadExpected]);

  const activePatientIds = useMemo(() => new Set((all || []).filter((e) => ACTIVE.includes(e.status)).map((e) => e.patient_id)), [all]);
  const activeApptIds = useMemo(() => new Set((all || []).filter((e) => ACTIVE.includes(e.status) && e.appointment_id).map((e) => e.appointment_id)), [all]);

  const counts = useMemo(() => {
    const c = { active: 0, waiting: 0, called: 0, treatment: 0, completed: 0, left: 0 };
    for (const e of all || []) {
      if (ACTIVE.includes(e.status)) c.active += 1;
      if (e.status === 'waiting') c.waiting += 1;
      if (e.status === 'called') c.called += 1;
      if (e.status === 'in_treatment') c.treatment += 1;
      if (e.status === 'completed') c.completed += 1;
      if (e.status === 'left') c.left += 1;
    }
    return c;
  }, [all]);

  const items = useMemo(() => {
    const def = TABS.find((x) => x.id === tab) || TABS[0];
    return (all || []).filter((e) => def.statuses.includes(e.status));
  }, [all, tab]);

  const expectedRows = useMemo(() => (expected || [])
    .filter((a) => !activeApptIds.has(a.id) && !activePatientIds.has(a.patient_id))
    .sort((a, b) => new Date(a.start_at) - new Date(b.start_at)), [expected, activeApptIds, activePatientIds]);

  const wall = useCallback((iso) => {
    const dt = tz ? DateTime.fromISO(iso).setZone(tz) : DateTime.fromISO(iso);
    return dt.toFormat('HH:mm');
  }, [tz]);

  function waitedLabel(e) {
    const end = e.ended_at ? new Date(e.ended_at) : new Date();
    return fmtDuration(end - new Date(e.arrived_at));
  }

  const isOwn = useCallback((e) => user.role !== 'doctor' || (doctorProfile && e.doctor_id === doctorProfile.id), [user.role, doctorProfile]);

  async function patchEntry(e, status, verb) {
    if (status === 'left') {
      const ok = await confirm({
        title: verb,
        message: `Mark ${e.patient_name} as left without being seen? The entry stays in today's history.`,
        confirmLabel: verb,
        danger: true,
      });
      if (!ok) return;
    }
    setBusyId(e.id);
    try {
      await api(`/waiting-room/${e.id}/status`, { method: 'PATCH', body: { status } });
      toast.success(`${e.patient_name}: ${t(`wr.st.${status}`).toLowerCase()}.`);
      refresh();
    } catch (err) { toast.error(err.message); } finally { setBusyId(null); }
  }

  async function checkIn(appt) {
    setBusyId(`appt-${appt.id}`);
    try {
      await api(`/appointments/${appt.id}/status`, { method: 'PATCH', body: { status: 'checked_in' } });
      toast.success(`${appt.patient_name} checked in and added to the waiting room.`);
      refresh();
    } catch (e) { toast.error(e.message); } finally { setBusyId(null); }
  }

  function rowActions(e) {
    if (!canManage || !isOwn(e)) return null;
    const acts = [];
    if (e.status === 'waiting') {
      acts.push(<button key="c" className="btn btn-primary btn-sm" disabled={busyId === e.id} onClick={() => patchEntry(e, 'called', t('wr.callIn'))}>{t('wr.callIn')}</button>);
    }
    if (e.status === 'called') {
      acts.push(<button key="s" className="btn btn-primary btn-sm" disabled={busyId === e.id} onClick={() => patchEntry(e, 'in_treatment', t('wr.startTx'))}>{t('wr.startTx')}</button>);
      acts.push(<button key="w" className="btn btn-outline btn-sm" disabled={busyId === e.id} onClick={() => patchEntry(e, 'waiting', t('wr.backToWaiting'))}>{t('wr.backToWaiting')}</button>);
    }
    if (e.status === 'in_treatment') {
      acts.push(<button key="d" className="btn btn-primary btn-sm" disabled={busyId === e.id} onClick={() => patchEntry(e, 'completed', t('wr.complete'))}><IconCheck size={13} /> {t('wr.complete')}</button>);
    }
    if (ACTIVE.includes(e.status) && (isFrontDesk || user.role === 'doctor')) {
      acts.push(<button key="l" className="btn btn-danger-outline btn-sm" disabled={busyId === e.id} onClick={() => patchEntry(e, 'left', t('wr.markLeft'))}>{t('wr.markLeft')}</button>);
    }
    return acts.length ? <div className="flex" style={{ gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap' }}>{acts}</div> : null;
  }

  return (
    <div className="page" style={{ paddingTop: 14 }}>
      <div className="page-head">
        <div>
          <h1>{t('nav.waitingRoom')}</h1>
          <div className="desc">{clinic?.name} · {tz ? tz.replace('_', ' ') : ''}</div>
        </div>
        {canManage && (
          <button className="btn btn-primary" onClick={() => setAddOpen(true)}>
            <IconPlus size={16} /> {t('wr.addPatient')}
          </button>
        )}
      </div>

      <div className="tabs" role="tablist" aria-label="Waiting room queues">
        {TABS.map((d) => (
          <button key={d.id} className={`tab${tab === d.id ? ' on' : ''}`} role="tab" aria-selected={tab === d.id} onClick={() => setTab(d.id)}>
            {t({ active: 'wr.tabActive', waiting: 'wr.tabWaiting', called: 'wr.tabCalled', treatment: 'wr.tabTreatment', completed: 'wr.tabCompleted', left: 'wr.tabLeft' }[d.id])}
            {counts[d.id] > 0 && <span className="tab-count">{counts[d.id]}</span>}
          </button>
        ))}
      </div>

      <div className="card cal-filters" style={{ marginBottom: 12 }}>
        <div className="flex" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <select className="select" style={{ width: 'auto' }} value={doctorFilter} onChange={(e) => setDoctorFilter(e.target.value)} aria-label={t('wr.dentist')}>
            <option value="all">{t('cal.allDoctors')}</option>
            {doctors.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          {branches.length > 1 && (
            <select className="select" style={{ width: 'auto' }} value={branchFilter} onChange={(e) => setBranchFilter(e.target.value)} aria-label={t('cal.allBranches')}>
              <option value="all">{t('cal.allBranches')}</option>
              {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          )}
        </div>
      </div>

      <div className="card">
        {error && <div className="form-error" style={{ margin: 14 }}>{t('wr.loadError')} {error} — <button className="btn btn-sm btn-outline" onClick={load}>Retry</button></div>}
        {!error && (!all ? <Spinner label={t('common.loading')} /> : items.length === 0 ? (
          <EmptyState icon="🪑" title={t('wr.empty')}>
            {canManage ? t('wr.emptyHint') : ''}
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t('appt.colPatient')}</th>
                  <th className="hide-sm">{t('wr.dentist')}</th>
                  <th className="hide-md">{t('wr.visitType')}</th>
                  <th>{t('wr.arrived')}</th>
                  <th>{t('wr.waited')}</th>
                  <th>{t('appt.colStatus')}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {items.map((e) => {
                  const m = WR_COLORS[e.status];
                  return (
                    <tr key={e.id}>
                      <td>
                        <b>{e.patient_name}</b>
                        {e.patient_mrn && <div className="muted small mono">MRN {e.patient_mrn}</div>}
                        {e.patient_phone && (
                          <div className="small" dir="ltr">
                            <a href={`tel:${String(e.patient_phone).replace(/[^\d+]/g, '')}`} style={{ color: 'var(--muted)' }}>{e.patient_phone}</a>
                          </div>
                        )}
                      </td>
                      <td className="hide-sm">
                        <span className="flex" style={{ gap: 6 }}>
                          {e.doctor_color && <span className="pdot" style={{ background: e.doctor_color }} aria-hidden="true"></span>}
                          {e.doctor_name}
                        </span>
                      </td>
                      <td className="hide-md">
                        {t(`appt.type.${e.visit_type}`)}
                        {e.reason && <div className="muted small">{e.reason}</div>}
                        {e.appointment_status === 'no_show' && (
                          <div className="muted small" title={t('wr.noShowNote')}>· {t('status.no_show')} {wall(e.appointment_start)}</div>
                        )}
                      </td>
                      <td className="mono"><b>{wall(e.arrived_at)}</b></td>
                      <td className="mono muted">{waitedLabel(e)}</td>
                      <td>
                        <span className="badge" style={{ background: m.bg, color: m.color, border: `1px solid ${m.border}` }}>
                          {t(`wr.st.${e.status}`)}
                        </span>
                      </td>
                      <td className="num">{rowActions(e)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}
      </div>

      {canManage && (
        <div className="card card-pad" style={{ marginTop: 12 }}>
          <div className="card-title">{t('wr.expected')}</div>
          {expected === null ? <Spinner /> : expectedRows.length === 0 ? (
            <div className="muted small">{t('wr.emptyExpected')}</div>
          ) : (
            expectedRows.map((a) => (
              <div key={a.id} className="dash-list-item">
                <span className="who" style={{ minWidth: 0 }}>
                  <b>{wall(a.start_at)}</b>&nbsp;·&nbsp;<b>{a.patient_name}</b>
                  <span>{a.doctor_name}{a.service_name ? ` · ${a.service_name}` : ''} · {STATUS_META[a.status]?.label || a.status}</span>
                </span>
                <button className="btn btn-primary btn-sm" disabled={busyId === `appt-${a.id}`} onClick={() => checkIn(a)}>
                  <IconClock size={13} /> {t('wr.checkIn')}
                </button>
              </div>
            ))
          )}
        </div>
      )}

      {addOpen && (
        <AddPatientModal
          onClose={() => setAddOpen(false)}
          onAdded={() => { setAddOpen(false); refresh(); }}
        />
      )}
    </div>
  );
}

/** Add-patient dialog: search an existing patient, pick dentist + visit type,
 *  optionally link today's appointment (a no-show link keeps its history),
 *  or register a brand-new patient through the existing registration modal. */
function AddPatientModal({ onClose, onAdded }) {
  const { clinic, doctors, branches } = useClinicMeta();
  const { t } = useI18n();
  const toast = useToast();

  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  const [patient, setPatient] = useState(null);
  const [doctorId, setDoctorId] = useState('');
  const [branchId, setBranchId] = useState('');
  const [visitType, setVisitType] = useState('new_visit');
  const [reason, setReason] = useState('');
  const [appts, setAppts] = useState([]);
  const [apptId, setApptId] = useState('');
  const [register, setRegister] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    const id = setTimeout(async () => {
      const term = q.trim();
      if (term.length < 2) { setResults(null); return; }
      try {
        const res = await api(`/patients?search=${encodeURIComponent(term)}&limit=8`);
        setResults(res.items);
      } catch { setResults([]); }
    }, 300);
    return () => clearTimeout(id);
  }, [q]);

  useEffect(() => {
    if (!patient || !clinic) { setAppts([]); return; }
    const now = clinic.timezone ? DateTime.now().setZone(clinic.timezone) : DateTime.now();
    const start = now.startOf('day').toUTC().toISO();
    const end = now.plus({ days: 1 }).startOf('day').toUTC().toISO();
    api(`/appointments?patient_id=${patient.id}&start=${start}&end=${end}`)
      .then((r) => setAppts(r.appointments || []))
      .catch(() => setAppts([]));
  }, [patient, clinic]);

  const linked = appts.find((a) => String(a.id) === apptId) || null;

  async function submit() {
    setErr('');
    if (!patient) { setErr(t('wr.searchPatient')); return; }
    if (!doctorId) { setErr(t('wr.selectDentist')); return; }
    setSaving(true);
    try {
      await api('/waiting-room', {
        method: 'POST',
        body: {
          patient_id: patient.id,
          doctor_id: Number(doctorId),
          visit_type: visitType,
          reason: reason.trim() || undefined,
          branch_id: branchId ? Number(branchId) : undefined,
          appointment_id: apptId ? Number(apptId) : undefined,
        },
      });
      toast.success(`${patient.first_name} ${patient.last_name} added to the waiting room.`);
      onAdded();
    } catch (e) { setErr(e.message); } finally { setSaving(false); }
  }

  return (
    <>
      <Modal title={t('wr.addTitle')} onClose={onClose} wide>
        <div style={{ display: 'grid', gap: 12 }}>
          <Field label={t('wr.searchPatient')}>
            {patient ? (
              <div className="flex" style={{ gap: 8 }}>
                <b>{patient.first_name} {patient.last_name}</b>
                <span className="muted small mono">MRN {patient.mrn}</span>
                <button className="icon-btn" onClick={() => { setPatient(null); setApptId(''); setQ(''); }} aria-label="Clear patient"><IconX size={14} /></button>
              </div>
            ) : (
              <>
                <label className="search-box">
                  <IconSearch size={15} />
                  <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('wr.searchPatient')} aria-label={t('wr.searchPatient')} autoFocus />
                </label>
                {results && (results.length === 0 ? (
                  <div className="muted small" style={{ marginTop: 6 }}>{t('wr.noResults')}</div>
                ) : (
                  <div style={{ display: 'grid', gap: 4, marginTop: 6 }}>
                    {results.map((p) => (
                      <button key={p.id} className="btn btn-outline btn-sm" style={{ justifyContent: 'flex-start' }} onClick={() => setPatient(p)}>
                        <b>{p.first_name} {p.last_name}</b>&nbsp;<span className="muted small mono">MRN {p.mrn}</span>
                      </button>
                    ))}
                  </div>
                ))}
                <button className="btn btn-outline btn-sm" style={{ marginTop: 8, justifySelf: 'start' }} onClick={() => setRegister(true)}>
                  <IconPlus size={13} /> {t('wr.registerNew')}
                </button>
              </>
            )}
          </Field>

          <div className="flex" style={{ gap: 10, flexWrap: 'wrap' }}>
            <Field label={t('wr.dentist')}>
              <select className="select" value={doctorId} onChange={(e) => setDoctorId(e.target.value)} aria-label={t('wr.dentist')}>
                <option value="">{t('wr.selectDentist')}</option>
                {doctors.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </Field>
            {branches.length > 1 && (
              <Field label={t('cal.allBranches')}>
                <select className="select" value={branchId} onChange={(e) => setBranchId(e.target.value)} aria-label={t('cal.allBranches')}>
                  <option value="">{t('cal.allBranches')}</option>
                  {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </Field>
            )}
            <Field label={t('wr.visitType')}>
              <select className="select" value={visitType} onChange={(e) => setVisitType(e.target.value)} aria-label={t('wr.visitType')}>
                {['new_visit', 'follow_up', 'consultation', 'procedure', 'emergency'].map((v) => (
                  <option key={v} value={v}>{t(`appt.type.${v}`)}</option>
                ))}
              </select>
            </Field>
          </div>

          <Field label={t('wr.reason')}>
            <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} aria-label={t('wr.reason')} />
          </Field>

          {patient && appts.length > 0 && (
            <Field label={t('wr.linkAppt')}>
              <select className="select" value={apptId} onChange={(e) => setApptId(e.target.value)} aria-label={t('wr.linkAppt')}>
                <option value="">{t('wr.linkNone')}</option>
                {appts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {DateTime.fromISO(a.start_at).setZone(clinic.timezone).toFormat('HH:mm')} — {t(`status.${a.status}`)}{a.service_name ? ` · ${a.service_name}` : ''}
                  </option>
                ))}
              </select>
              {linked?.status === 'no_show' && (
                <div className="muted small" style={{ marginTop: 6 }}>{t('wr.noShowNote')}</div>
              )}
            </Field>
          )}

          {err && <div className="form-error">{err}</div>}
          <div className="flex" style={{ justifyContent: 'flex-end', gap: 8 }}>
            <button className="btn btn-outline" onClick={onClose}>{t('common.cancel')}</button>
            <button className="btn btn-primary" disabled={saving} onClick={submit}>{t('wr.addPatient')}</button>
          </div>
        </div>
      </Modal>
      {register && (
        <PatientFormModal
          onClose={() => setRegister(false)}
          onSaved={(p) => { setRegister(false); setPatient(p); setQ(''); }}
        />
      )}
    </>
  );
}
