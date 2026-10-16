import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useI18n } from '../i18n.jsx';
import { api } from '../api.js';
import { cachedGet, invalidate, invalidateTimelines } from '../apiCache.js';
import { useAuth, useClinicMeta } from '../auth.jsx';
import { Spinner, EmptyState, Modal, Field, useToast, useConfirm } from '../components/ui.jsx';
import { fmtDateShort } from '../format.js';
import { IconPlus, IconPill, IconCheck, IconEdit, IconPaperclip } from '../components/icons.jsx';
import AppointmentModal from '../components/AppointmentModal.jsx';

const EMPTY_RX = { medication: '', dosage: '', frequency: '', duration: '', notes: '' };

function RecordStatusBadge({ status }) {
  const { lang } = useI18n();
  const approved = status === 'approved';
  return (
    <span className="badge" style={approved
      ? { background: 'var(--ok-soft)', color: 'var(--ok)', borderColor: '#d5e8b2' }
      : { background: 'var(--warn-soft)', color: 'var(--warn)', borderColor: '#fde4ad' }}>
      {approved ? (lang === 'ar' ? 'معتمد' : 'Approved') : (lang === 'ar' ? 'مسودة' : 'Draft')}
    </span>
  );
}

export function RecordModal({ onClose, onSaved, presetPatient, presetAppointmentId, editRecord }) {
  const { doctors, doctorProfile } = useClinicMeta();
  const { user } = useAuth();
  const { lang } = useI18n();
  const toast = useToast();
  const isDoctor = user.role === 'doctor';
  const editing = !!editRecord;
  const [f, setF] = useState({
    patient: presetPatient || (editRecord ? { id: editRecord.patient_id, first_name: editRecord.patient_name?.split(' ')[0] || '', last_name: editRecord.patient_name?.split(' ').slice(1).join(' ') || '', mrn: '' } : null),
    search: '', results: [],
    doctor_id: editing
      ? String(editRecord.doctor_id)
      : (isDoctor ? String(doctorProfile?.id || '') : (doctors[0] ? String(doctors[0].id) : '')),
    visit_date: editRecord?.visit_date || new Date().toISOString().slice(0, 10),
    symptoms: editRecord?.symptoms || '', examination: editRecord?.examination || '',
    diagnosis: editRecord?.diagnosis || '', treatment: editRecord?.treatment || '', follow_up: editRecord?.follow_up || '',
    prescriptions: editRecord?.prescriptions?.map((rx) => ({ id: rx.id, medication: rx.medication || '', dosage: rx.dosage || '', frequency: rx.frequency || '', duration: rx.duration || '', notes: rx.notes || '' })) || [],
    amendment_reason: '',
  });
  // Finalized (approved) records are edited as amendments: a reason is
  // mandatory and every change is appended to the record's amendment history.
  const amendingApproved = editing && editRecord.status === 'approved';
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Phase 4: unsaved-notes guard — compare clinical content against the
  // snapshot taken at mount so closing an edited form asks for confirmation.
  const confirm = useConfirm();
  const snapshot = () => JSON.stringify({
    patient_id: f.patient?.id ?? null, visit_date: f.visit_date,
    symptoms: f.symptoms, examination: f.examination, diagnosis: f.diagnosis,
    treatment: f.treatment, follow_up: f.follow_up,
    rx: f.prescriptions.map((rx) => [rx.medication, rx.dosage, rx.frequency, rx.duration, rx.notes]),
  });
  const baselineRef = useRef(snapshot());
  const dirty = useMemo(() => snapshot() !== baselineRef.current, [f]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!dirty) return undefined;
    const h = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);
  async function requestClose() {
    if (!dirty) { onClose(); return; }
    const ok = await confirm({
      title: lang === 'ar' ? 'تجاهل الملاحظات غير المحفوظة؟' : 'Discard unsaved notes?',
      message: lang === 'ar' ? 'هذا السجل السريري يحتوي تغييرات غير محفوظة (ملاحظات، تشخيص أو وصفات). الإغلاق الآن سيؤدي إلى فقدانها.' : 'This clinical record has unsaved changes (notes, diagnosis or prescriptions). Closing now will lose them.',
      confirmLabel: lang === 'ar' ? 'تجاهل التغييرات' : 'Discard changes', danger: true,
    });
    if (ok) onClose();
  }

  // A deep-linked preset patient is fetched asynchronously and can arrive
  // AFTER this modal mounted with an empty selection — sync it once.
  useEffect(() => {
    if (!presetPatient) return;
    setF((prev) => (prev.patient ? prev : { ...prev, patient: presetPatient }));
    // The deep-link preset arrives asynchronously and is not a user edit —
    // fold it into the unsaved-changes baseline so the guard stays quiet.
    const parsed = JSON.parse(baselineRef.current);
    if (!parsed.patient_id) {
      parsed.patient_id = presetPatient.id;
      baselineRef.current = JSON.stringify(parsed);
    }
  }, [presetPatient]);

  async function searchPatients(q) {
    setF((s) => ({ ...s, search: q }));
    if (!q) return;
    try {
      const res = await api(`/patients?search=${encodeURIComponent(q)}&limit=6`);
      setF((s) => ({ ...s, results: res.items }));
    } catch { /* ignore */ }
  }

  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const setRx = (i, k) => (e) => {
    const list = [...f.prescriptions];
    list[i] = { ...list[i], [k]: e.target.value };
    setF({ ...f, prescriptions: list });
  };

  async function submit(e, approve = false) {
    if (e) e.preventDefault();
    setError('');
    if (!f.patient) { setError(lang === 'ar' ? 'اختر مريضاً.' : 'Select a patient.'); return; }
    if (!isDoctor && !f.doctor_id) { setError(lang === 'ar' ? 'اختر الطبيب المعالج.' : 'Select the attending doctor.'); return; }
    if (amendingApproved && !f.amendment_reason.trim()) { setError(lang === 'ar' ? 'سبب التعديل مطلوب لتغيير سجل معتمد.' : lang === 'ar' ? 'سبب التعديل مطلوب لتغيير سجل معتمد.' : 'An amendment reason is required to change a finalized record.'); return; }
    setBusy(true);
    try {
      const body = {
        patient_id: f.patient.id, doctor_id: f.doctor_id ? Number(f.doctor_id) : undefined,
        visit_date: f.visit_date, symptoms: f.symptoms || null, examination: f.examination || null,
        diagnosis: f.diagnosis || null, treatment: f.treatment || null, follow_up: f.follow_up || null,
        // prescription diff: existing rows keep their id, new rows omit it
        prescriptions: f.prescriptions.filter((rx) => rx.medication.trim()),
      };
      if (editing) {
        if (amendingApproved) body.amendment_reason = f.amendment_reason.trim();
        await api(`/records/${editRecord.id}`, { method: 'PUT', body });
        if (approve && !amendingApproved) await api(`/records/${editRecord.id}`, { method: 'PUT', body: { status: 'approved' } });
        toast.success(amendingApproved ? (lang === 'ar' ? 'تم حفظ التعديل في سجل السجل.' : 'Amendment saved to the record history.') : approve ? (lang === 'ar' ? 'تم تحديث السجل واعتماده.' : 'Record updated and approved.') : (lang === 'ar' ? 'تم تحديث السجل.' : 'Record updated.'));
      } else {
        if (presetAppointmentId) body.appointment_id = Number(presetAppointmentId);
        if (approve) body.status = 'approved';
        await api('/records', { method: 'POST', body });
        toast.success(approve ? lang === 'ar' ? 'تم حفظ السجل السريري واعتماده.' : 'Clinical record saved and approved.' : lang === 'ar' ? 'تم حفظ السجل السريري كمسودة.' : 'Clinical record saved as draft.');
      }
      onSaved();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  return (
    <Modal title={amendingApproved ? lang === 'ar' ? 'تعديل سجل معتمد' : 'Amend finalized record' : editing ? (lang === 'ar' ? 'تعديل سجل سريري' : 'Edit clinical record') : (lang === 'ar' ? 'سجل سريري جديد' : 'New clinical record')} onClose={requestClose} wide
      footer={<>
        <button className="btn btn-outline" onClick={requestClose} disabled={busy}>Cancel</button>
        {amendingApproved ? (
          <button className="btn btn-primary" onClick={(e) => submit(e, false)} disabled={busy}>{busy ? lang === 'ar' ? 'جارٍ الحفظ…' : 'Saving…' : lang === 'ar' ? 'حفظ التعديل' : 'Save amendment'}</button>
        ) : (
          <>
            <button className="btn btn-outline" onClick={(e) => submit(e, false)} disabled={busy}>{editing ? lang === 'ar' ? 'حفظ تغييرات المسودة' : 'Save draft changes' : lang === 'ar' ? 'حفظ كمسودة' : 'Save as draft'}</button>
            <button className="btn btn-primary" onClick={(e) => submit(e, true)} disabled={busy}>{busy ? 'Saving…' : 'Save & approve'}</button>
          </>
        )}
      </>}>
      {error && <div className="form-error">{error}</div>}
      {amendingApproved && (
        <Field label="Amendment reason" required hint="Stored with the change in the record's amendment history. The original content is preserved.">
          <input className="input" value={f.amendment_reason} onChange={(e) => setF({ ...f, amendment_reason: e.target.value })} maxLength={500} placeholder="e.g. Diagnosis refined after vitality test" required />
        </Field>
      )}
      <div className="form-row">
        <Field label="Patient" required>
          {f.patient ? (
            <div className="combo-selected">{f.patient.first_name} {f.patient.last_name} {f.patient.mrn && <span className="muted small">· {f.patient.mrn}</span>}</div>
          ) : (
            <div className="combo">
              <input className="input" placeholder="Search patient…" value={f.search} onChange={(e) => searchPatients(e.target.value)} />
              {f.results.length > 0 && (
                <div className="combo-list">
                  {f.results.map((p) => (
                    <div key={p.id} className="combo-item" onClick={() => setF({ ...f, patient: p, results: [] })}>
                      <span>{p.first_name} {p.last_name}</span><span className="sub">{p.mrn}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </Field>
        <div className="form-row">
          <Field label="Visit date" required><input type="date" className="input" value={f.visit_date} onChange={set('visit_date')} required /></Field>
          {!isDoctor && !editing && (
            <Field label="Doctor" required>
              <select className="select" value={f.doctor_id} onChange={set('doctor_id')}>
                {doctors.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </Field>
          )}
        </div>
      </div>
      <Field label="Symptoms"><textarea className="textarea" rows={2} value={f.symptoms} onChange={set('symptoms')} /></Field>
      <Field label="Examination findings"><textarea className="textarea" rows={2} value={f.examination} onChange={set('examination')} /></Field>
      <div className="form-row">
        <Field label="Diagnosis"><textarea className="textarea" rows={2} value={f.diagnosis} onChange={set('diagnosis')} /></Field>
        <Field label="Treatment"><textarea className="textarea" rows={2} value={f.treatment} onChange={set('treatment')} /></Field>
      </div>
      <Field label="Follow-up instructions"><textarea className="textarea" rows={2} value={f.follow_up} onChange={set('follow_up')} /></Field>

      <div className="divider" />
      <div className="flex-between mb-12">
        <b style={{ fontSize: 13.5 }}>Prescriptions</b>
        <button type="button" className="btn btn-outline btn-sm" onClick={() => setF({ ...f, prescriptions: [...f.prescriptions, { ...EMPTY_RX }] })}>
          <IconPlus size={14}/> Add medication
        </button>
      </div>
      {f.prescriptions.length === 0 && <div className="muted small">No medications — add one if the visit requires a prescription.</div>}
      {f.prescriptions.map((rx, i) => (
        <div key={rx.id || i} className="card card-pad mb-12" style={{ background: 'var(--surface-2)' }}>
          <div className="form-row">
            <Field label="Medication" required><input className="input" value={rx.medication} onChange={setRx(i, 'medication')} required maxLength={200} /></Field>
            <Field label="Dosage"><input className="input" value={rx.dosage} onChange={setRx(i, 'dosage')} placeholder="e.g. 1 tablet" /></Field>
          </div>
          <div className="form-row-3">
            <Field label="Frequency"><input className="input" value={rx.frequency} onChange={setRx(i, 'frequency')} placeholder="3× daily" /></Field>
            <Field label="Duration"><input className="input" value={rx.duration} onChange={setRx(i, 'duration')} placeholder="7 days" /></Field>
            <div style={{ display: 'flex', alignItems: 'flex-end' }}>
              <button type="button" className="btn btn-danger-outline btn-sm"
                onClick={() => setF({ ...f, prescriptions: f.prescriptions.filter((_, j) => j !== i) })}>Remove</button>
            </div>
          </div>
        </div>
      ))}
    </Modal>
  );
}

/** Secure attachment manager for a medical record (upload / download / soft-delete). */
function RecordAttachments({ recordId, canEdit, onChanged }) {
  const { lang } = useI18n();
  const [items, setItems] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);
  const toast = useToast();

  async function load() {
    try {
      const res = await api(`/attachments?entity_type=medical_record&entity_id=${recordId}`);
      setItems(res.attachments);
    } catch (e) { setError(e.message); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [recordId]);

  async function upload(ev) {
    const file = ev.target.files?.[0];
    if (!file) return;
    setBusy(true);
    const fd = new FormData();
    fd.append('entity_type', 'medical_record');
    fd.append('entity_id', String(recordId));
    fd.append('file', file);
    try {
      const res = await fetch('/api/attachments', { method: 'POST', credentials: 'same-origin', body: fd });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error?.message || `Upload failed (${res.status})`);
      toast.success(lang === 'ar' ? 'تم رفع المرفق.' : 'Attachment uploaded.');
      load(); onChanged?.();
    } catch (e) { toast.error(e.message); } finally { setBusy(false); if (fileRef.current) fileRef.current.value = ''; }
  }

  async function remove(a) {
    try {
      await api(`/attachments/${a.id}`, { method: 'DELETE' });
      toast.success(lang === 'ar' ? 'تم إزالة المرفق.' : 'Attachment removed.');
      load(); onChanged?.();
    } catch (e) { toast.error(e.message); }
  }

  return (
    <>
      <div className="divider" />
      <div className="flex-between mb-12">
        <b style={{ fontSize: 13.5, display: 'flex', gap: 7, alignItems: 'center' }}><IconPaperclip size={16}/> Attachments</b>
        {canEdit && (
          <label className="btn btn-outline btn-sm" style={{ cursor: 'pointer' }}>
            <IconPlus size={14}/> {busy ? lang === 'ar' ? 'جارٍ الرفع…' : 'Uploading…' : lang === 'ar' ? 'رفع ملف' : 'Upload file'}
            <input ref={fileRef} type="file" accept=".pdf,.jpg,.jpeg,.png,.webp" hidden onChange={upload} disabled={busy} />
          </label>
        )}
      </div>
      {error && <div className="form-error">{error}</div>}
      {!items ? <Spinner /> : items.length === 0 ? (
        <div className="muted small">No files attached. PDF, JPEG, PNG and WEBP up to 10 MB are allowed.</div>
      ) : items.map((a) => (
        <div key={a.id} className="flex-between" style={{ padding: '7px 0', borderBottom: '1px solid var(--line)' }}>
          <span className="small" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            📎 <b>{a.original_name}</b> <span className="muted">· {(a.size_bytes / 1024).toFixed(0)} KB · {fmtDateShort(a.created_at)}</span>
          </span>
          <span className="flex" style={{ gap: 6 }}>
            <a className="btn btn-outline btn-sm" href={`/api/attachments/${a.id}/download`}>Download</a>
            {canEdit && <button className="btn btn-danger-outline btn-sm" onClick={() => remove(a)}>Remove</button>}
          </span>
        </div>
      ))}
    </>
  );
}

/**
 * Requirement 7 — after an encounter is completed (record approved) the dentist
 * gets explicit next actions. Booking is never automatic: the next unscheduled
 * plan session is only PREFILLED into the appointment form.
 */
function NextActions({ rec, onClose }) {
  const { lang } = useI18n();
  const navigate = useNavigate();
  const toast = useToast();
  const [next, setNext] = useState(undefined); // undefined=loading | null=none | {plan,session}
  const [showBook, setShowBook] = useState(false);
  const [booked, setBooked] = useState(null);

  const loadNext = () => {
    api(`/plans?patient_id=${rec.patient_id}`)
      .then((r) => {
        const plans = (r.plans || []).filter((p) => ['approved', 'in_progress'].includes(p.status));
        for (const p of plans) {
          const sess = p.sessions.find((x) => x.status === 'planned' && !x.appointment_id);
          if (sess) { setNext({ plan: p, session: sess }); return; }
        }
        setNext(null);
      })
      .catch(() => setNext(null));
  };
  useEffect(() => { loadNext(); /* eslint-disable-next-line */ }, [rec.patient_id]);

  const go = (path) => { onClose?.(); navigate(path); };
  const [first, ...rest] = String(rec.patient_name || '').split(' ');

  return (
    <>
      <div className="divider" />
      <b style={{ fontSize: 13.5 }}>Next actions</b>
      {booked && (
        <div className="form-success mt-12" role="status">
          Appointment booked{next?.session ? ` — session “${next.session.title}” is now Scheduled` : ''}.{' '}
          <button type="button" className="link-btn-inline" onClick={() => go(`/appointments?patient_id=${rec.patient_id}`)}>Open calendar</button>
          {' · '}
          <button type="button" className="link-btn-inline" onClick={() => { setBooked(null); loadNext(); }}>Book another</button>
        </div>
      )}
      <div className="next-actions mt-12">
        <button type="button" className="btn btn-primary" onClick={() => setShowBook(true)}>
          <IconPlus size={15} /> {next ? `Book next: ${next.session.title}` : lang === 'ar' ? 'حجز موعد متابعة' : 'Book follow-up appointment'}
        </button>
        <button type="button" className="btn btn-outline" onClick={() => go(`/patients/${rec.patient_id}?tab=plans`)}>
          {next ? 'Open plan & sessions' : 'Continue / new plan'}
        </button>
        <button type="button" className="btn btn-outline" onClick={() => go(`/patients/${rec.patient_id}?tab=plans`)}>New plan</button>
        <button type="button" className="btn btn-outline" onClick={() => go(`/patients/${rec.patient_id}`)}>Outstanding balance</button>
        <button type="button" className="btn btn-outline" onClick={() => go(`/invoices?patient_id=${rec.patient_id}${rec.appointment_id ? `&appointment_id=${rec.appointment_id}` : ''}`)}>Create invoice</button>
      </div>
      {next && (
        <div className="muted small mt-8">
          Next unscheduled session: <b>{next.session.title}</b> of plan “{next.plan.title}” ·{' '}
          {next.session.item_count} procedure(s) · est. {next.session.estimated_min} min. Explicit booking required — nothing is scheduled automatically.
        </div>
      )}
      {next === null && <div className="muted small mt-8">No open plan sessions — the follow-up booking starts unlinked.</div>}
      {showBook && (
        <AppointmentModal
          mode="create"
          initial={{
            patient: { id: rec.patient_id, first_name: first || '', last_name: rest.join(' ') || '', mrn: '' },
            doctor_id: rec.doctor_id || undefined,
            appointment_type: next ? 'procedure' : 'follow_up',
            duration_min: next?.session?.estimated_min || undefined,
            treatment_session_id: next?.session?.id,
            session_title: next?.session?.title,
            plan_title: next?.plan?.title,
            plan_id: next?.plan?.id,
          }}
          onClose={() => setShowBook(false)}
          onSaved={(a) => { setShowBook(false); setBooked(a); toast.success(lang === 'ar' ? 'تم حجز الموعد التالي.' : 'Next appointment booked.'); onChanged?.(); }}
        />
      )}
    </>
  );
}

export function RecordDetail({ id, onClose, onEdit, onChanged }) {
  const { lang } = useI18n();
  const { user } = useAuth();
  const { doctorProfile } = useClinicMeta();
  const toast = useToast();
  const confirm = useConfirm();
  const [rec, setRec] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function load() {
    try { setRec((await api(`/records/${id}`)).record); }
    catch (e) { setError(e.message); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [id]);

  const isAuthor = rec && user.role === 'doctor' && doctorProfile && rec.doctor_id === doctorProfile.id;
  const canWrite = rec && (user.role === 'owner' || isAuthor);

  async function approve() {
    const ok = await confirm({
      title: lang === 'ar' ? 'اعتماد السجل' : 'Approve record',
      message: lang === 'ar' ? 'الاعتماد يُنهي هذا السجل: من الآن فصاعداً كل تعديل للمحتوى يُسجل كتعديل مع سبب إلزامي، مع الحفاظ على السجل الكامل. متابعة؟' : 'Approving finalizes this record: from now on every content edit is recorded as an amendment with a mandatory reason, preserving the full history. Continue?',
      confirmLabel: 'Approve & finalize',
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api(`/records/${id}`, { method: 'PUT', body: { status: 'approved' } });
      toast.success(lang === 'ar' ? 'تم اعتماد السجل وإنهاؤه.' : 'Record approved and finalized.');
      invalidateTimelines();
      load(); onChanged?.();
    } catch (e) { toast.error(e.message); } finally { setBusy(false); }
  }

  return (
    <Modal title="Clinical record" onClose={onClose}
      footer={<>
        <button className="btn btn-outline" onClick={onClose}>Close</button>
        {rec?.status === 'draft' && canWrite && (
          <button className="btn btn-outline" disabled={busy} onClick={() => onEdit(rec)}><IconEdit size={15}/> Edit draft</button>
        )}
        {rec?.status === 'draft' && canWrite && (
          <button className="btn btn-primary" disabled={busy} onClick={approve}><IconCheck size={15}/> Approve</button>
        )}
        {rec?.status === 'approved' && canWrite && (
          <button className="btn btn-outline" disabled={busy} onClick={() => onEdit(rec)}><IconEdit size={15}/> Amend</button>
        )}
      </>}>
      {error && <div className="form-error">{error}</div>}
      {!rec ? <Spinner /> : (
        <>
          <div className="flex-between mb-12">
            <RecordStatusBadge status={rec.status} />
            {rec.status === 'approved' && (
              <span className="muted small">
                Finalized{rec.finalized_at ? ` ${new Date(rec.finalized_at).toLocaleString()}` : ''} — edits are kept as amendments
              </span>
            )}
          </div>
          <div className="appt-detail-row"><span className="k">Patient</span><span className="v"><Link to={`/patients/${rec.patient_id}`}>{rec.patient_name}</Link></span></div>
          <div className="appt-detail-row"><span className="k">Visit date</span><span className="v">{rec.visit_date}</span></div>
          <div className="appt-detail-row"><span className="k">Doctor</span><span className="v">{rec.doctor_name}</span></div>
          {rec.appointment_id && <div className="appt-detail-row"><span className="k">Appointment</span><span className="v muted">#{rec.appointment_id}</span></div>}
          {[[lang === 'ar' ? 'الأعراض' : 'Symptoms', rec.symptoms], [lang === 'ar' ? 'الفحص' : 'Examination', rec.examination], [lang === 'ar' ? 'التشخيص' : 'Diagnosis', rec.diagnosis], [lang === 'ar' ? 'العلاج' : 'Treatment', rec.treatment], [lang === 'ar' ? 'المتابعة' : 'Follow-up', rec.follow_up]].map(([k, v]) =>
            v ? <div className="appt-detail-row" key={k}><span className="k">{k}</span><span className="v">{v}</span></div> : null)}
          {rec.prescriptions.length > 0 && (
            <>
              <div className="divider" />
              <b style={{ fontSize: 13.5, display: 'flex', gap: 7, alignItems: 'center' }}><IconPill size={16}/> Prescriptions</b>
              {rec.prescriptions.map((rx) => (
                <div key={rx.id} className="card card-pad mt-12" style={{ background: 'var(--surface-2)' }}>
                  <b>{rx.medication}</b>
                  <div className="muted small">{[rx.dosage, rx.frequency, rx.duration].filter(Boolean).join(' · ')}</div>
                  {rx.notes && <div className="small mt-12">{rx.notes}</div>}
                </div>
              ))}
            </>
          )}
          {rec.amendments?.length > 0 && (
            <>
              <div className="divider" />
              <b style={{ fontSize: 13.5 }}>Amendment history</b>
              {rec.amendments.map((a) => {
                let changes = {};
                try { changes = JSON.parse(a.changes || '{}'); } catch { changes = {}; }
                return (
                  <div key={a.id} className="card card-pad mt-12" style={{ background: 'var(--surface-2)' }}>
                    <div className="flex-between">
                      <b style={{ fontSize: 13 }}>{a.amended_by_name || lang === 'ar' ? 'غير معروف' : 'Unknown'}</b>
                      <span className="muted small">{new Date(a.amended_at).toLocaleString()}</span>
                    </div>
                    <div className="small mt-12"><b>Reason:</b> {a.reason}</div>
                    {Object.entries(changes).map(([field, diff]) => (
                      <div className="small mt-12" key={field}>
                        <span className="muted">{field}:</span>{' '}
                        <s style={{ color: 'var(--muted)' }}>{diff.before || '—'}</s>{' → '}{diff.after || '—'}
                      </div>
                    ))}
                  </div>
                );
              })}
            </>
          )}
          <RecordAttachments recordId={rec.id} canEdit={canWrite} onChanged={onChanged} />
          {rec.status === 'approved' && <NextActions rec={rec} onClose={onClose} />}
        </>
      )}
    </Modal>
  );
}

export default function Records() {
  const { user } = useAuth();
  const { doctors } = useClinicMeta();
  const [params, setParams] = useSearchParams();
  const { t, lang } = useI18n();
  const toast = useToast();
  const [records, setRecords] = useState(null);
  const [error, setError] = useState('');
  const [doctorFilter, setDoctorFilter] = useState('all');
  const [showNew, setShowNew] = useState(false);
  const [openId, setOpenId] = useState(null);
  const [editRec, setEditRec] = useState(null);
  const canWrite = ['owner', 'doctor'].includes(user.role);

  // Visit workflow deep-link: /records?new=1&patient_id=&appointment_id=
  const workflowPatientId = params.get('patient_id');
  const workflowApptId = params.get('appointment_id');
  const wantsNew = params.get('new') === '1' && canWrite;
  const [presetPatient, setPresetPatient] = useState(null);

  useEffect(() => {
    if (!wantsNew || !workflowPatientId) return;
    (async () => {
      try { setPresetPatient((await api(`/patients/${workflowPatientId}`)).patient); }
      catch { /* fall back to manual patient pick */ }
    })();
  }, [wantsNew, workflowPatientId]);

  function clearWorkflowParams() {
    setParams({}, { replace: true });
  }

  // Edit deep-link: /records?edit=<id>&patient_id= (sent by the patient profile's Edit button)
  const editParam = params.get('edit');
  useEffect(() => {
    if (!editParam) return;
    (async () => {
      try {
        if (!canWrite) throw Object.assign(new Error('forbidden'), { code: 'forbidden' });
        const res = await api(`/records/${Number(editParam)}`);
        setEditRec(res.record);
      } catch (e) {
        toast.error(e && e.code === 'forbidden' ? t('records.editDenied') : t('records.editFailed'));
      } finally {
        const next = new URLSearchParams(params);
        next.delete('edit');
        setParams(next, { replace: true });
      }
    })();
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [editParam]);

  async function load(force = false) {
    setError('');
    try {
      const qs = new URLSearchParams();
      if (doctorFilter !== 'all') qs.set('doctor_id', doctorFilter);
      if (workflowPatientId && !wantsNew) qs.set('patient_id', workflowPatientId);
      const path = `/records${qs.toString() ? `?${qs}` : ''}`;
      const res = (await cachedGet(path, { force })).data;
      setRecords(res.records);
    } catch (e) { setError(e.message); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [doctorFilter, params]);

  return (
    <div className="page">
      {workflowApptId && (
        <div className="card card-pad" style={{ marginBottom: 12, display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <span className="small muted">{t('records.visitContext')}</span>
          <Link className="btn btn-outline btn-sm" to={`/visits/${workflowApptId}`}>{t('visit.backToWorkspace')}</Link>
        </div>
      )}
      <div className="page-head">
        <div>
          <h1>Medical Records</h1>
          <div className="desc">Clinical notes and prescriptions. {user.role === 'doctor' ? lang === 'ar' ? 'ترى السجلات التي أنتَ مؤلفها.' : 'You see records you authored.' : ''} Access is restricted to authorized staff.</div>
        </div>
        {canWrite && <button className="btn btn-primary" onClick={() => setShowNew(true)}><IconPlus size={16}/> New record</button>}
      </div>

      <div className="card">
        <div className="flex" style={{ padding: '14px 16px', borderBottom: '1px solid var(--line)' }}>
          <select className="select" style={{ width: 'auto' }} value={doctorFilter} onChange={(e) => setDoctorFilter(e.target.value)}>
            <option value="all">All doctors</option>
            {doctors.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </div>
        {error && <div className="form-error" style={{ margin: 14 }}>{error}</div>}
        {!records ? <Spinner label="Loading records…" /> : records.length === 0 ? (
          <EmptyState icon="📝" title="No clinical records">
            {canWrite ? lang === 'ar' ? 'أنشئ أول سجل بعد استشارة.' : 'Create the first record after a consultation.' : lang === 'ar' ? 'تظهر السجلات هنا بعد الاستشارات.' : 'Records appear here after consultations.'}
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>Visit</th><th>Patient</th><th className="hide-sm">Doctor</th><th>Diagnosis</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {records.map((r) => (
                  <tr key={r.id} className="row-link" tabIndex={canWrite ? 0 : -1} role="button"
                    onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && canWrite) { e.preventDefault(); setOpenId(r.id); } }}
                    onClick={() => canWrite && setOpenId(r.id)}>
                    <td className="mono">{r.visit_date}</td>
                    <td><b>{r.patient_name}</b></td>
                    <td className="hide-sm">{r.doctor_name}</td>
                    <td>{r.diagnosis || <span className="muted">—</span>}</td>
                    <td><RecordStatusBadge status={r.status} /></td>
                    <td className="num">{canWrite && <button className="btn btn-outline btn-sm" onClick={(e) => { e.stopPropagation(); setOpenId(r.id); }}>Open</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {(showNew || wantsNew) && (
        <RecordModal
          onClose={() => { setShowNew(false); if (wantsNew) clearWorkflowParams(); }}
          onSaved={() => { setShowNew(false); clearWorkflowParams(); invalidate('/records'); invalidateTimelines(); load(true); }}
          presetPatient={presetPatient}
          presetAppointmentId={workflowApptId}
        />
      )}
      {openId && !editRec && (
        <RecordDetail
          id={openId}
          onClose={() => setOpenId(null)}
          onEdit={(rec) => setEditRec(rec)}
          onChanged={load}
        />
      )}
      {editRec && (
        <RecordModal
          editRecord={editRec}
          onClose={() => setEditRec(null)}
          onSaved={() => { setEditRec(null); setOpenId(null); invalidate('/records'); invalidateTimelines(); load(true); }}
        />
      )}
    </div>
  );
}
