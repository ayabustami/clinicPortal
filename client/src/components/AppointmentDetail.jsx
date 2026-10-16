import React, { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth, useClinicMeta } from '../auth.jsx';
import { useI18n } from '../i18n.jsx';
import { Modal, StatusBadge, useToast, useConfirm } from './ui.jsx';
import { fmtDate, fmtTime, STATUS_META } from '../format.js';
import { IconEdit, IconCheck, IconClock, IconAlert, IconFileText, IconInvoice, IconSteth } from './icons.jsx';

/**
 * Read/detail view of an appointment with quick status actions and the
 * unified visit workflow: check in -> start visit (in_progress) -> clinical
 * note -> complete -> invoice.
 * props: appointment, onClose, onChanged(appointment|null), onEdit(appointment)
 */
const TYPE_LABEL = { new_visit: 'New visit', follow_up: 'Follow-up', consultation: 'Consultation', procedure: 'Procedure', emergency: 'Emergency' };
const TYPE_LABEL_AR = { new_visit: 'زيارة جديدة', follow_up: 'متابعة', consultation: 'استشارة', procedure: 'إجراء', emergency: 'طوارئ' };

export default function AppointmentDetail({ appointment: appt, onClose, onChanged, onEdit }) {
  const { user } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const { t, lang } = useI18n();
  const [busy, setBusy] = useState(false);
  const { doctorProfile } = useClinicMeta();

  if (!appt) return null;
  const end = new Date(new Date(appt.start_at).getTime() + appt.duration_min * 60000);
  // Doctors may only manage appointments assigned to their own profile —
  const EV_KEY = {
    'appointment.create': 'appt.ev.create',
    'appointment.update': 'appt.ev.update',
    'appointment.status.confirmed': 'appt.ev.confirmed',
    'appointment.status.checked_in': 'appt.ev.checked_in',
    'appointment.status.in_progress': 'appt.ev.in_progress',
    'appointment.status.completed': 'appt.ev.completed',
    'appointment.status.cancelled': 'appt.ev.cancelled',
    'appointment.status.scheduled': 'appt.ev.scheduled',
    'appointment.status.no_show': 'appt.ev.no_show',
  };
  // mirror the server's assertCanManage so unauthorized actions never render.
  const isOwn = user.role !== 'doctor' || (doctorProfile && appt.doctor_id === doctorProfile.id);
  const canManage = ['owner', 'receptionist', 'doctor'].includes(user.role) && isOwn;
  const startPassed = new Date(appt.start_at).getTime() <= Date.now();
  const canComplete = ['owner', 'doctor'].includes(user.role) && isOwn; // clinical roles, own rows for doctors
  const canInvoice = ['owner', 'accountant'].includes(user.role); // financial roles

  // Reschedule/status/cancel history from the server audit trail (read-only).
  const [history, setHistory] = useState(null);
  useEffect(() => {
    let live = true;
    api(`/appointments/${appt.id}/history`).then((r) => { if (live) setHistory(r.events || []); }).catch(() => { if (live) setHistory([]); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appt.id]);

  async function setStatus(status, verb, { silent = false } = {}) {
    let reason;
    if (!silent) {
      const proceed = await confirm({
        title: verb,
        message: `${verb} the appointment for ${appt.patient_name} with ${appt.doctor_name} on ${fmtDate(appt.start_at)} at ${fmtTime(appt.start_at)}?`,
        confirmLabel: verb,
        danger: status === 'cancelled' || status === 'no_show',
        ...(status === 'cancelled' ? { prompt: { label: t('appt.cancelPrompt'), placeholder: t('appt.cancelPlaceholder') } } : {}),
      });
      if (proceed === false) return false;
      if (status === 'cancelled' && typeof proceed === 'string' && proceed) reason = proceed;
    }
    setBusy(true);
    try {
      const res = await api(`/appointments/${appt.id}/status`, { method: 'PATCH', body: { status, ...(reason ? { reason } : {}) } });
      toast.success(`Appointment marked as ${STATUS_META[status].label.toLowerCase()}.`);
      onChanged(res.appointment);
      return true;
    } catch (err) {
      toast.error(err.message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  /** Start visit: checked_in -> in_progress, then jump into the clinical note. */
  async function startVisit() {
    let ok = appt.status === 'in_progress';
    if (!ok) ok = await setStatus('in_progress', lang === 'ar' ? 'بدء الزيارة' : 'Start visit', { silent: true });
    if (ok) navigate(`/records?patient_id=${appt.patient_id}&appointment_id=${appt.id}&new=1`);
  }

  /** Complete the visit, then offer invoicing (financial roles). */
  async function completeAndInvoice() {
    const ok = await setStatus('completed', lang === 'ar' ? 'إكمال الزيارة' : 'Complete visit', { silent: true });
    if (ok && canInvoice) navigate(`/invoices?patient_id=${appt.patient_id}&appointment_id=${appt.id}`);
  }

  const next = {
    scheduled: [
      ['confirmed', lang === 'ar' ? 'تأكيد' : 'Confirm', 'btn-primary'],
      ['checked_in', lang === 'ar' ? 'تسجيل وصول' : 'Check in', 'btn-outline'],
    ],
    confirmed: [
      ['checked_in', lang === 'ar' ? 'تسجيل وصول' : 'Check in', 'btn-primary'],
    ],
    checked_in: canComplete ? [['in_progress', lang === 'ar' ? 'بدء الزيارة' : 'Start visit', 'btn-primary']] : [],
    in_progress: canComplete ? [['completed', lang === 'ar' ? 'إكمال الزيارة' : 'Complete visit', 'btn-primary']] : [],
    cancelled: [['scheduled', lang === 'ar' ? 'استعادة إلى مجدول' : 'Restore to scheduled', 'btn-outline']],
  }[appt.status] || [];

  return (
    <Modal title="Appointment details" onClose={onClose}
      footer={
        <>
          <button className="btn btn-primary" onClick={() => navigate(`/visits/${appt.id}`)}><IconSteth size={15} /> {t('visit.openWorkspace')}</button>
          <button className="btn btn-outline" onClick={onClose}>Close</button>
          {canManage && !['completed', 'no_show', 'in_progress'].includes(appt.status) && (
            <button className="btn btn-outline" onClick={() => onEdit(appt)} disabled={busy}>
              <IconEdit size={15} /> Edit / Reschedule
            </button>
          )}
        </>
      }
    >
      <div className="flex-between mb-12">
        <div className="flex" style={{ gap: 12 }}>
          <div style={{ fontSize: 16, fontWeight: 680 }}>
            {['owner', 'receptionist', 'doctor'].includes(user.role) && appt.patient_id ? (
              <Link to={`/patients/${appt.patient_id}`} onClick={onClose} className="link">{appt.patient_name || (lang === 'ar' ? 'مريض' : 'Patient')}</Link>
            ) : (appt.patient_name || 'Patient')}
          </div>
          <StatusBadge status={appt.status} />
        </div>
        {/* clinical data links only for clinical roles — server enforces access anyway */}
        {['owner', 'doctor'].includes(user.role) && (
          <button className="btn btn-outline btn-sm" onClick={() => navigate(`/records?patient_id=${appt.patient_id}`)}>
            <IconFileText size={14} /> Medical records
          </button>
        )}
      </div>

      <div className="flex" style={{ gap: 6, flexWrap: 'wrap', margin: '0 0 10px' }} aria-label={t('appt.lifecycle')}>
        <span className="badge" style={{ background: 'var(--surface-2)' }}>{t('appt.arrival')}: {appt.arrival_status ? appt.arrival_status.replace('_', ' ') : 'not arrived'}</span>
        <span className="badge" style={{ background: 'var(--surface-2)' }}>{t('appt.clinicalVisit')}: {appt.visit_status ? appt.visit_status.replace('_', ' ') : 'not started'}</span>
        <span className="badge" style={{ background: 'var(--surface-2)' }}>{t('appt.source')}: {appt.booking_source || 'reception'}</span>
      </div>
      {appt.status === 'cancelled' && appt.cancelled_reason && (
        <div className="appt-detail-row"><span className="k">{t('appt.cancelledReason')}</span>
          <span className="v">{appt.cancelled_reason}{appt.cancelled_at ? ` · ${fmtDate(appt.cancelled_at)}` : ''}</span></div>
      )}
      <div className="appt-detail-row"><span className="k">When</span>
        <span className="v"><b>{fmtDate(appt.start_at)}</b> · {fmtTime(appt.start_at)} – {fmtTime(end)} ({appt.duration_min} min)</span></div>
      {appt.patient_phone && <div className="appt-detail-row"><span className="k">Phone</span><span className="v" dir="ltr">{appt.patient_phone}</span></div>}
      <div className="appt-detail-row"><span className="k">Doctor</span><span className="v">{appt.doctor_name}</span></div>
      {appt.service_name && <div className="appt-detail-row"><span className="k">Service</span><span className="v">{appt.service_name}</span></div>}
      {appt.appointment_type && <div className="appt-detail-row"><span className="k">{lang === 'ar' ? 'النوع' : 'Type'}</span><span className="v">{(lang === 'ar' ? TYPE_LABEL_AR[appt.appointment_type] : TYPE_LABEL[appt.appointment_type]) || appt.appointment_type}</span></div>}
      {appt.treatment_session_id && (
        <div className="appt-detail-row"><span className="k">Plan session</span>
          <span className="v"><Link to={`/patients/${appt.patient_id}?tab=plans`}>Linked to session #{appt.treatment_session_id}</Link></span>
        </div>
      )}
      {appt.branch_name && <div className="appt-detail-row"><span className="k">Branch</span><span className="v">{appt.branch_name}</span></div>}
      {appt.notes && <div className="appt-detail-row"><span className="k">Notes</span><span className="v">{appt.notes}</span></div>}
      <div className="appt-detail-row"><span className="k">Reference</span><span className="v muted">#{appt.id} · created {fmtDate(appt.created_at)}</span></div>

      {history && history.length > 0 && (
        <details className="card" style={{ padding: '8px 12px', margin: '0 0 10px' }}>
          <summary className="small" style={{ cursor: 'pointer', fontWeight: 600 }}>{t('appt.history')} ({history.length})</summary>
          <ul className="dash-list" style={{ margin: '8px 0 0', padding: 0, listStyle: 'none' }}>
            {history.slice(-8).reverse().map((ev) => (
              <li key={ev.id} className="small muted" style={{ padding: '3px 0' }}>
                <b style={{ color: 'var(--ink-2)' }}>{t(EV_KEY[ev.action] || 'appt.ev.other')}</b>
                {' · '}{fmtDate(ev.at)} {fmtTime(ev.at)}{ev.actor ? ` · ${ev.actor}` : ''}
                {ev.details && ev.details.reason ? ` — ${ev.details.reason}` : ''}
              </li>
            ))}
          </ul>
        </details>
      )}
      {canManage && (
        <div className="detail-actions">
          {next.map(([status, label, cls]) => (
            <button key={status} className={`btn btn-sm ${cls}`} disabled={busy}
              onClick={() => (status === 'in_progress' ? startVisit() : setStatus(status, label))}>
              <IconCheck size={14} /> {label}
            </button>
          ))}
          {appt.status === 'in_progress' && canComplete && (
            <>
              <button className="btn btn-sm btn-outline" disabled={busy} onClick={() => navigate(`/records?patient_id=${appt.patient_id}&appointment_id=${appt.id}&new=1`)}>
                <IconFileText size={14} /> Write clinical note
              </button>
              <button className="btn btn-sm btn-primary" disabled={busy} onClick={completeAndInvoice}>
                <IconInvoice size={14} /> Complete & invoice
              </button>
            </>
          )}
          {appt.status === 'checked_in' && !canComplete && (
            <span className="muted small">Only a doctor can start or complete the visit.</span>
          )}
          {appt.status === 'completed' && canInvoice && (
            <button className="btn btn-sm btn-outline" onClick={() => navigate(`/invoices?patient_id=${appt.patient_id}&appointment_id=${appt.id}`)}>
              <IconInvoice size={14} /> Create invoice
            </button>
          )}
          {canManage && ['scheduled', 'confirmed'].includes(appt.status) && (
            <button className="btn btn-sm btn-danger-outline" disabled={busy} onClick={() => setStatus('cancelled', lang === 'ar' ? 'إلغاء' : 'Cancel')}>
              <IconAlert size={14} /> {lang === 'ar' ? 'إلغاء الموعد' : 'Cancel appointment'}
            </button>
          )}
          {canManage && startPassed && ['scheduled', 'confirmed'].includes(appt.status) && (
            <button className="btn btn-sm btn-outline" disabled={busy} onClick={() => setStatus('no_show', lang === 'ar' ? 'تسجيل عدم حضور' : 'Mark no-show')}>
              <IconClock size={14} /> No-show
            </button>
          )}
        </div>
      )}
    </Modal>
  );
}
