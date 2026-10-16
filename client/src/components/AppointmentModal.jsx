import React, { useEffect, useMemo, useState } from 'react';
import { DateTime } from 'luxon';
import { api } from '../api.js';
import { useAuth, useClinicMeta } from '../auth.jsx';
import { Modal, Field, useToast } from './ui.jsx';
import PatientSelect from './PatientSelect.jsx';
import { STATUS_META, money } from '../format.js';
import { IconPlus, IconAlert, IconClock } from './icons.jsx';

const DURATIONS = [15, 20, 30, 45, 60, 75, 90, 120];

/**
 * Create / edit appointment form — works standalone (no calendar slot needed).
 * props:
 *   mode: 'create' | 'edit'
 *   initial: { patient?, doctor_id?, service_id?, start?: Date, end?: Date, appointment? }
 *   onClose(), onSaved(appointment)
 *
 * Wall-clock times are the CLINIC timezone (luxon, DST-exact); the server
 * re-validates working hours, leave periods and conflicts on submit.
 */
export default function AppointmentModal({ mode, initial = {}, onClose, onSaved }) {
  const { user } = useAuth();
  const { clinic, doctors, services, branches } = useClinicMeta();
  const toast = useToast();
  const appt = initial.appointment || null;
  const tz = clinic?.timezone || null;
  const slot = Math.min(120, Math.max(5, Number(clinic?.slot_minutes) || 30));

  /** Suggested start: next slot today inside working hours, else next open day. */
  function suggestStart() {
    if (!tz) {
      const d = new Date();
      d.setMinutes(Math.ceil(d.getMinutes() / 30) * 30, 0, 0);
      return { date: fmtLocal(d), time: hm(d) };
    }
    const wh = clinic?.working_hours || {};
    let day = DateTime.now().setZone(tz);
    for (let i = 0; i < 14; i++) {
      // Server working_hours keys follow JS getUTCDay(): '0'=Sunday.. '6'=Saturday.
      // luxon weekday is 1=Monday..7=Sunday -> convert.
      const winKey = String(day.weekday % 7);
      const window = wh[winKey];
      if (window) {
        const nowPlus = i === 0 ? day.plus({ minutes: 5 }) : day.set({ hour: 0, minute: 0 });
        const rounded = nowPlus.minus({ minutes: nowPlus.minute % slot }).plus({ minutes: nowPlus.minute % slot ? slot : 0 });
        const [wsH, wsM] = window.start.split(':').map(Number);
        const [weH, weM] = window.end.split(':').map(Number);
        const dayStart = day.set({ hour: wsH, minute: wsM, second: 0, millisecond: 0 });
        const dayEnd = day.set({ hour: weH, minute: weM, second: 0, millisecond: 0 });
        let candidate = rounded < dayStart ? dayStart : rounded;
        if (i === 0 && candidate < dayStart) candidate = dayStart;
        if (candidate.plus({ minutes: slot }) <= dayEnd) {
          return { date: candidate.toFormat('yyyy-MM-dd'), time: candidate.toFormat('HH:mm') };
        }
      }
      day = day.plus({ days: 1 });
    }
    const fallback = DateTime.now().setZone(tz).plus({ days: 1 }).set({ hour: 9, minute: 0 });
    return { date: fallback.toFormat('yyyy-MM-dd'), time: fallback.toFormat('HH:mm') };
  }

  const suggested = useMemo(() => (mode === 'create' && !initial.start ? suggestStart() : null), []); // eslint-disable-line react-hooks/exhaustive-deps

  function wallOf(d) {
    const dt = tz ? DateTime.fromJSDate(d).setZone(tz) : DateTime.fromJSDate(d);
    return { date: dt.toFormat('yyyy-MM-dd'), time: dt.toFormat('HH:mm') };
  }
  function fmtLocal(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
  function hm(d) { return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }

  const startInit = appt ? new Date(appt.start_at) : (initial.start || null);
  const initWall = startInit ? wallOf(startInit) : suggested;
  const durInit = appt ? appt.duration_min
    : initial.start && initial.end ? Math.max(5, Math.round((initial.end - initial.start) / 60000))
    : initial.duration_min ? Math.max(5, Number(initial.duration_min))
    : slot;

  const [patient, setPatient] = useState(appt
    ? { id: appt.patient_id, first_name: appt.patient_name?.split(' ')[0] || '', last_name: appt.patient_name?.split(' ').slice(1).join(' ') || '', mrn: '' }
    : (initial.patient || null));
  const [doctorId, setDoctorId] = useState(appt ? String(appt.doctor_id) : (initial.doctor_id ? String(initial.doctor_id) : (doctors[0] ? String(doctors[0].id) : '')));
  const [serviceIds, setServiceIds] = useState(() => {
    if (appt?.services?.length) return appt.services.map((x) => x.service_id);
    return appt?.service_id ? [appt.service_id] : [];
  });
  const [date, setDate] = useState(initWall?.date || '');
  const [time, setTime] = useState(initWall?.time || '');
  const [duration, setDuration] = useState(durInit);
  const [status, setStatus] = useState(appt?.status || 'scheduled');
  const [branchId, setBranchId] = useState(appt?.branch_id ? String(appt.branch_id) : '');
  const [notes, setNotes] = useState(appt?.notes || '');
  const [apptType, setApptType] = useState(appt?.appointment_type || initial.appointment_type || 'new_visit');
  const sessionId = initial.treatment_session_id || null;
  const [error, setError] = useState('');
  const [conflictInfo, setConflictInfo] = useState(null);
  const [wlBusy, setWlBusy] = useState(false);
  const [fieldErrors, setFieldErrors] = useState({});
  const [busy, setBusy] = useState(false);

  /* ---------- inline new-patient registration (permission-gated) ---------- */
  const canRegisterPatient = ['owner', 'receptionist'].includes(user?.role);
  const [registering, setRegistering] = useState(false);
  const [np, setNp] = useState({ first_name: '', last_name: '', phone: '', gender: 'female', dob: '' });
  const [npError, setNpError] = useState('');
  const [npBusy, setNpBusy] = useState(false);

  async function registerPatient(e) {
    e?.preventDefault?.();
    setNpError('');
    if (!np.first_name.trim() || !np.last_name.trim()) { setNpError('First and last name are required.'); return; }
    setNpBusy(true);
    try {
      const res = await api('/patients', {
        method: 'POST',
        body: {
          first_name: np.first_name.trim(), last_name: np.last_name.trim(),
          phone: np.phone.trim() || undefined, gender: np.gender, dob: np.dob || undefined,
        },
      });
      setPatient(res.patient);
      setRegistering(false);
      toast.success(`Patient ${res.patient.first_name} ${res.patient.last_name} registered.`);
    } catch (err) { setNpError(err.message); } finally { setNpBusy(false); }
  }

  /* ---------- availability / conflict hints for the chosen doctor+slot ---------- */
  const [hints, setHints] = useState(null);
  useEffect(() => {
    if (!doctorId || !date) { setHints(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const dayStart = tz ? DateTime.fromISO(`${date}T00:00:00`, { zone: tz }).toUTC().toISO() : `${date}T00:00:00.000Z`;
        const dayEnd = tz ? DateTime.fromISO(`${date}T00:00:00`, { zone: tz }).plus({ days: 1 }).toUTC().toISO() : `${date}T23:59:59.000Z`;
        const [appts, leave] = await Promise.all([
          api(`/appointments?doctor_id=${doctorId}&start=${dayStart}&end=${dayEnd}&limit=100`),
          api(`/schedule/unavailability?start=${dayStart}&end=${dayEnd}`),
        ]);
        if (cancelled) return;
        setHints({ appts: appts.appointments, leave: leave.unavailability.filter((u) => String(u.doctor_id) === String(doctorId)) });
      } catch { if (!cancelled) setHints(null); }
    })();
    return () => { cancelled = true; };
  }, [doctorId, date, tz, time, duration, appt?.id]);

  const conflicts = useMemo(() => {
    if (!hints || !time) return { overlaps: [], leave: [] };
    const start = tz ? DateTime.fromISO(`${date}T${time}`, { zone: tz }) : DateTime.fromISO(`${date}T${time}`);
    const end = start.plus({ minutes: Number(duration) });
    const overlaps = hints.appts
      .filter((a) => String(a.id) !== String(appt?.id))
      .filter((a) => !['cancelled', 'no_show'].includes(a.status))
      .filter((a) => {
        const s = DateTime.fromISO(a.start_at);
        const e = s.plus({ minutes: a.duration_min });
        return s < end && e > start;
      });
    const leave = hints.leave.filter((u) => {
      const s = DateTime.fromISO(u.start_at);
      const e = DateTime.fromISO(u.end_at);
      return s < end && e > start;
    });
    return { overlaps, leave };
  }, [hints, date, time, duration, tz, appt?.id]);

  const durations = useMemo(() => {
    const list = DURATIONS.includes(duration) ? DURATIONS : [...DURATIONS, duration].sort((a, b) => a - b);
    return list;
  }, [duration]);

  /** Multi-service booking: toggling recomputes the duration from the catalog
   *  (sum of selected services). The duration field stays editable afterwards. */
  function toggleService(id) {
    setServiceIds((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      if (next.length) {
        const sum = next.reduce((acc, sid) => acc + Number(services.find((s) => s.id === sid)?.duration_min || 0), 0);
        setDuration(Math.min(480, Math.max(5, sum)));
      }
      return next;
    });
  }

  // Snapshot fallback: services booked before a catalog change (or deactivated
  // since) still display from the appointment's own snapshot.
  const initialServiceIds = appt?.services?.length
    ? appt.services.map((x) => x.service_id)
    : (appt?.service_id ? [appt.service_id] : []);
  const servicesChanged = mode === 'create'
    || JSON.stringify([...serviceIds].sort()) !== JSON.stringify([...initialServiceIds].sort());
  const selectedServices = serviceIds
    .map((id) => {
      const cat = services.find((s) => s.id === id);
      if (cat) return cat;
      const snap = (appt?.services || []).find((x) => x.service_id === id);
      return snap ? { id, name: snap.name, duration_min: snap.duration_min, price_cents: snap.price_cents, is_active: false } : null;
    })
    .filter(Boolean);
  const selectedTotals = selectedServices.reduce(
    (acc, s) => ({ minutes: acc.minutes + Number(s.duration_min || 0), price: acc.price + Number(s.price_cents || 0) }),
    { minutes: 0, price: 0 });

  /** End time derived from start + duration (same model the server stores). */
  const endTime = useMemo(() => {
    if (!date || !time) return '';
    const start = tz ? DateTime.fromISO(`${date}T${time}`, { zone: tz }) : DateTime.fromISO(`${date}T${time}`);
    if (!start.isValid) return '';
    return start.plus({ minutes: Number(duration) }).toFormat('HH:mm');
  }, [date, time, duration, tz]);
  const crossesMidnight = endTime !== '' && endTime <= time;

  async function submit(e) {
    e.preventDefault();
    setError('');
    const fe = {};
    if (!patient) fe.patient = 'Select a patient (or register a new one).';
    if (!doctorId) fe.doctor = 'Select a doctor.';
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) fe.date = 'Provide a valid date.';
    if (!time || !/^\d{2}:\d{2}$/.test(time)) fe.time = 'Provide a valid start time.';
    if (!Number.isFinite(Number(duration)) || Number(duration) < 5 || Number(duration) > 480) fe.duration = 'Duration must be 5–480 minutes.';
    setFieldErrors(fe);
    if (Object.keys(fe).length) return;

    const startDt = tz ? DateTime.fromISO(`${date}T${time}`, { zone: tz }) : DateTime.fromISO(`${date}T${time}`);
    if (!startDt.isValid) { setFieldErrors({ date: 'Invalid date/time combination.' }); return; }
    const startIso = startDt.toUTC().toISO();

    const body = {
      patient_id: patient.id,
      doctor_id: Number(doctorId),
      ...(servicesChanged
        ? { service_id: serviceIds.length ? Number(serviceIds[0]) : null, service_ids: serviceIds.map(Number) }
        : {}),
      branch_id: branchId ? Number(branchId) : null,
      start_at: startIso,
      duration_min: Number(duration),
      notes: notes || null,
      appointment_type: apptType,
    };
    if (mode === 'create' && sessionId) body.treatment_session_id = sessionId;
    setBusy(true); // double-submit guard
    try {
      let res;
      if (mode === 'edit' && appt) {
        res = await api(`/appointments/${appt.id}`, { method: 'PUT', body });
      } else {
        body.status = status; // server only allows scheduled/confirmed at creation
        res = await api('/appointments', { method: 'POST', body });
      }
      toast.success(mode === 'edit' ? 'Appointment updated.' : `Appointment booked for ${date} at ${time}.`);
      onSaved?.(res.appointment);
    } catch (err) {
      // never a false success: surface the server's exact message
      setError(err.message);
      setConflictInfo(err.code === 'conflict' ? { date, time } : null);
      if (err.fields) setFieldErrors((prev) => ({ ...prev, ...mapServerFields(err.fields) }));
    } finally {
      setBusy(false);
    }
  }

  /** No usable slot? Offer the waiting list instead of losing the patient. */
  async function addToWaitingList() {
    setWlBusy(true);
    try {
      await api('/waiting', {
        method: 'POST',
        body: {
          patient_id: patient.id,
          doctor_id: doctorId ? Number(doctorId) : undefined,
          service_id: serviceIds.length ? Number(serviceIds[0]) : undefined,
          reason: `Wanted ${date} ${time} — no available slot`,
        },
      });
      toast.success('Patient added to the waiting list for an earlier slot.');
      setConflictInfo(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setWlBusy(false);
    }
  }

  function mapServerFields(fields) {
    const out = {};
    for (const [k, v] of Object.entries(fields || {})) out[k] = `${k}: ${v}`;
    return out;
  }

  const canPickStatus = mode === 'create';

  return (
    <Modal title={mode === 'edit' ? 'Edit appointment' : 'New appointment'} onClose={onClose} wide
      footer={
        <>
          <button className="btn btn-outline" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={busy}>
            {busy ? 'Saving…' : mode === 'edit' ? 'Save changes' : 'Book appointment'}
          </button>
        </>
      }
    >
      {error && (
        <div className="form-error" role="alert">
          {error}
          {conflictInfo && patient && (
            <div className="mt-8">
              <button type="button" className="btn btn-outline btn-sm" disabled={wlBusy} onClick={addToWaitingList}>
                {wlBusy ? 'Adding…' : 'Add patient to waiting list for an earlier slot'}
              </button>
            </div>
          )}
        </div>
      )}
      {sessionId && (
        <div className="field-hint mb-12" role="status">
          Linking this appointment to {initial.session_title ? `session “${initial.session_title}” of ` : ''}
          treatment plan {initial.plan_title ? `“${initial.plan_title}”` : `#${initial.plan_id || ''}`}.
          The session is marked Scheduled only after the booking succeeds.
        </div>
      )}
      <form onSubmit={submit}>
        <Field label="Patient" required error={fieldErrors.patient}>
          <PatientSelect value={patient} onChange={(p) => { setPatient(p); setFieldErrors((f) => ({ ...f, patient: undefined })); }} />
        </Field>
        {canRegisterPatient && !registering && mode === 'create' && (
          <button type="button" className="btn btn-outline btn-sm mb-12" onClick={() => setRegistering(true)}>
            <IconPlus size={14} /> Register a new patient
          </button>
        )}
        {registering && (
          <div className="card card-pad mb-12" style={{ background: 'var(--surface-2)' }}>
            <div className="flex-between mb-12">
              <b style={{ fontSize: 13 }}>New patient</b>
              <button type="button" className="btn btn-outline btn-sm" onClick={() => setRegistering(false)}>Close</button>
            </div>
            {npError && <div className="form-error">{npError}</div>}
            <div className="form-row">
              <Field label="First name" required><input className="input" value={np.first_name} maxLength={80} onChange={(e) => setNp({ ...np, first_name: e.target.value })} required /></Field>
              <Field label="Last name" required><input className="input" value={np.last_name} maxLength={80} onChange={(e) => setNp({ ...np, last_name: e.target.value })} required /></Field>
            </div>
            <div className="form-row-3">
              <Field label="Phone"><input className="input" dir="ltr" value={np.phone} maxLength={40} onChange={(e) => setNp({ ...np, phone: e.target.value })} placeholder="+970 …" /></Field>
              <Field label="Gender">
                <select className="select" value={np.gender} onChange={(e) => setNp({ ...np, gender: e.target.value })}>
                  <option value="female">Female</option><option value="male">Male</option>
                </select>
              </Field>
              <Field label="Date of birth"><input type="date" className="input" value={np.dob} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setNp({ ...np, dob: e.target.value })} /></Field>
            </div>
            <button type="button" className="btn btn-primary btn-sm" disabled={npBusy} onClick={registerPatient}>
              {npBusy ? 'Registering…' : 'Register & select'}
            </button>
          </div>
        )}
        <div className="form-row">
          <Field label="Doctor" required error={fieldErrors.doctor}>
            <select className="select" value={doctorId} onChange={(e) => { setDoctorId(e.target.value); setFieldErrors((f) => ({ ...f, doctor: undefined })); }}>
              {doctors.map((d) => <option key={d.id} value={d.id}>{d.name}{d.specialty ? ` — ${d.specialty}` : ''}</option>)}
            </select>
          </Field>
          <Field label="Services" hint={services.length ? 'Pick one or more — the duration defaults to their sum.' : undefined}>
            <div role="group" aria-label="Booked services" className="flex" style={{ flexDirection: 'column', gap: 2, maxHeight: 176, overflowY: 'auto', border: '1px solid var(--line)', borderRadius: 10, padding: '8px 10px' }}>
              {services.filter((s) => s.is_active).map((s) => (
                <label key={s.id} className="flex" style={{ gap: 8, alignItems: 'center', fontSize: 13, cursor: 'pointer', padding: '2px 0' }}>
                  <input type="checkbox" checked={serviceIds.includes(s.id)} onChange={() => toggleService(s.id)} />
                  <span style={{ flex: 1 }}>{s.name}{s.category ? <span style={{ color: 'var(--muted)' }}> · {s.category}</span> : null}</span>
                  <span className="mono" style={{ color: 'var(--muted)', fontSize: 12, whiteSpace: 'nowrap' }}>{s.duration_min} min · {money(s.price_cents)}</span>
                </label>
              ))}
              {serviceIds
                .filter((id) => !services.some((s) => s.id === id && s.is_active))
                .map((id) => {
                  const item = selectedServices.find((x) => x.id === id);
                  if (!item) return null;
                  return (
                    <label key={id} className="flex" style={{ gap: 8, alignItems: 'center', fontSize: 13, cursor: 'pointer', padding: '2px 0', opacity: 0.65 }}>
                      <input type="checkbox" checked onChange={() => toggleService(id)} />
                      <span style={{ flex: 1 }}>{item.name} <em style={{ color: 'var(--muted)' }}>(inactive)</em></span>
                      <span className="mono" style={{ color: 'var(--muted)', fontSize: 12, whiteSpace: 'nowrap' }}>{item.duration_min} min · {money(item.price_cents)}</span>
                    </label>
                  );
                })}
              {!services.some((s) => s.is_active) && <span style={{ color: 'var(--muted)', fontSize: 13 }}>No active services in the catalog.</span>}
            </div>
            {selectedServices.length > 0 && (
              <div className="hint" style={{ marginTop: 6 }}>
                Selected: {selectedServices.length} service{selectedServices.length > 1 ? 's' : ''} · {selectedTotals.minutes} min · {money(selectedTotals.price)}
              </div>
            )}
          </Field>
        </div>
        <div className="form-row-3">
          <Field label="Date" required error={fieldErrors.date} hint={tz ? `Clinic timezone: ${tz}` : undefined}>
            <input type="date" className="input" value={date} onChange={(e) => { setDate(e.target.value); setFieldErrors((f) => ({ ...f, date: undefined })); }} required />
          </Field>
          <Field label="Start time" required error={fieldErrors.time}>
            <input type="time" className="input" value={time} step="300" onChange={(e) => { setTime(e.target.value); setFieldErrors((f) => ({ ...f, time: undefined })); }} required />
          </Field>
          <Field label="Duration" required error={fieldErrors.duration} hint={endTime ? `Ends ${endTime}${crossesMidnight ? ' (next day)' : ''}` : undefined}>
            <select className="select" value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
              {durations.map((d) => <option key={d} value={d}>{d} minutes</option>)}
            </select>
          </Field>
        </div>
        {crossesMidnight && (
          <div className="form-error" role="alert">The appointment would end after midnight — pick an earlier start or shorter duration.</div>
        )}
        {/* availability hints (server still enforces) */}
        {mode === 'create' && (conflicts.overlaps.length > 0 || conflicts.leave.length > 0) && (
          <div className="form-error" role="alert" style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <IconAlert size={16} />
            <span>
              {conflicts.overlaps.length > 0 && (
                <>This doctor already has {conflicts.overlaps.length} overlapping appointment{conflicts.overlaps.length > 1 ? 's' : ''} at that time
                  ({conflicts.overlaps.slice(0, 3).map((a) => `${DateTime.fromISO(a.start_at).setZone(tz).toFormat('HH:mm')} ${a.patient_name}`).join(', ')}). The server will reject the booking. </>
              )}
              {conflicts.leave.length > 0 && <>The doctor is on leave during this period{conflicts.leave[0].reason ? ` (${conflicts.leave[0].reason})` : ''}.</>}
            </span>
          </div>
        )}
        {mode === 'create' && hints && conflicts.overlaps.length === 0 && conflicts.leave.length === 0 && (
          <div className="field-hint" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <IconClock size={14} /> {hints.appts.filter((a) => !['cancelled', 'no_show'].includes(a.status)).length} appointment(s) for this doctor on {date} — the chosen slot looks free.
          </div>
        )}
        <div className="form-row">
          <Field label="Type">
            <select className="select" value={apptType} onChange={(e) => setApptType(e.target.value)} aria-label="Appointment type">
              <option value="new_visit">New visit</option>
              <option value="follow_up">Follow-up</option>
              <option value="consultation">Consultation</option>
              <option value="procedure">Procedure</option>
              <option value="emergency">Emergency</option>
            </select>
          </Field>
          {canPickStatus ? (
            <Field label="Initial status" hint="Later changes follow the status workflow.">
              <select className="select" value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="scheduled">Scheduled</option>
                <option value="confirmed">Confirmed</option>
              </select>
            </Field>
          ) : (
            <Field label="Status" hint="Use the status actions on the appointment to change it.">
              <input className="input" value={STATUS_META[status]?.label || status} disabled />
            </Field>
          )}
          {branches.length > 1 ? (
            <Field label="Branch">
              <select className="select" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
                <option value="">— Not set —</option>
                {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </Field>
          ) : <div />}
        </div>
        <Field label="Reason for visit / notes" hint="Visible to authorized clinic staff.">
          <textarea className="textarea" rows={3} value={notes} maxLength={2000}
            onChange={(e) => setNotes(e.target.value)} placeholder="Reason for visit or anything the care team should know…" />
        </Field>
        <div className="field-hint">
          Times are in the clinic timezone{tz ? ` (${tz})` : ''}. Working hours, doctor leave and conflicts are validated by the server on save.
        </div>
        <button type="submit" style={{ display: 'none' }} aria-hidden />
      </form>
    </Modal>
  );
}
