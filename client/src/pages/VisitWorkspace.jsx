import React, { useMemo, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { invalidate } from '../apiCache.js';
import { useApi } from '../useApi.js';
import { useAuth } from '../auth.jsx';
import { useI18n } from '../i18n.jsx';
import { Spinner, EmptyState, Modal, Field, StatusBadge, useToast, useConfirm } from '../components/ui.jsx';
import { money, fmtDate, fmtTime, ageFromDob } from '../format.js';
import { IconChevL, IconCheck, IconClock, IconFileText, IconTooth, IconGrid, IconInvoice, IconPlus, IconAlert } from '../components/icons.jsx';
import { deriveSteps, deriveActions, visitRecords, visitTreatments, visitPlans } from '../visitState.js';
import { RecordModal, RecordDetail } from './Records.jsx';
import TreatmentPlans from '../components/TreatmentPlans.jsx';
import AppointmentModal from '../components/AppointmentModal.jsx';

/**
 * Unified Visit Workspace — one coherent screen orchestrating the EXISTING
 * clinical systems (appointments, encounters, odontogram, plans, performed
 * procedures, billing) through their existing authorized APIs.
 *
 * The server remains authoritative: every badge/action here mirrors persisted
 * state, every mutation goes through the existing endpoints, and permissions
 * are re-enforced server-side (this page only adapts the experience).
 */

const STEP_STATUS_META = {
  not_started: { cls: 'step-todo', labelKey: 'visit.status.notStarted' },
  in_progress: { cls: 'step-progress', labelKey: 'visit.status.inProgress' },
  awaiting: { cls: 'step-awaiting', labelKey: 'visit.status.awaiting' },
  completed: { cls: 'step-done', labelKey: 'visit.status.completed' },
  not_applicable: { cls: 'step-na', labelKey: 'visit.status.notApplicable' },
  unknown: { cls: 'step-unknown', labelKey: 'visit.status.unknown' },
};

export default function VisitWorkspace() {
  const { appointmentId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { t } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();

  const idNum = Number(appointmentId);
  const idValid = Number.isInteger(idNum) && idNum > 0;

  const role = user?.role;
  const roles = useMemo(() => ({
    clinical: ['owner', 'doctor'].includes(role),
    scheduling: ['owner', 'receptionist', 'doctor'].includes(role),
    financial: ['owner', 'accountant', 'doctor'].includes(role),
  }), [role]);

  /* ---------------- data (existing endpoints, cached + deduped) ---------------- */
  const apptQ = useApi(idValid ? `/appointments/${idNum}` : null, { skip: !idValid });
  const appt = apptQ.data?.appointment && apptQ.data.appointment.id === idNum ? apptQ.data.appointment : null;
  const pid = appt?.patient_id || null;

  const patientQ = useApi(pid ? `/patients/${pid}` : null, { skip: !pid });
  const recordsQ = useApi(pid && roles.clinical ? `/records?patient_id=${pid}` : null, { skip: !(pid && roles.clinical) });
  const dentalQ = useApi(pid ? `/patients/${pid}/dental` : null, { skip: !pid });
  const plansQ = useApi(pid ? `/plans?patient_id=${pid}` : null, { skip: !pid });
  const invoicesQ = useApi(pid && roles.financial ? `/invoices?patient_id=${pid}&limit=100` : null, { skip: !(pid && roles.financial) });

  const patient = patientQ.data?.patient || null;
  const records = recordsQ.data?.records;
  const dental = dentalQ.data;
  const plans = plansQ.data?.plans;
  const invoices = invoicesQ.data?.invoices;

  /* ---------------- derived presentation model ---------------- */
  const visitRecs = useMemo(() => visitRecords(records, idNum), [records, idNum]);
  const treats = useMemo(() => visitTreatments(dental, { appointmentId: idNum, recordIds: visitRecs.map((r) => r.id) }), [dental, idNum, visitRecs]);
  const vPlans = useMemo(() => visitPlans(plans, { appointmentId: idNum, treatmentIds: treats.map((x) => x.id) }), [plans, idNum, treats]);
  const steps = useMemo(() => deriveSteps({ appointment: appt, records: roles.clinical ? records : undefined, dental, plans, invoices: roles.financial ? invoices : undefined, canViewBilling: roles.financial }), [appt, records, dental, plans, invoices, roles]);
  const actions = useMemo(() => deriveActions({ appointment: appt, steps, roles, invoices: roles.financial ? invoices : undefined }), [appt, steps, roles, invoices]);
  const visitInvoices = useMemo(() => (invoices || []).filter((i) => i.appointment_id === idNum), [invoices, idNum]);

  /* ---------------- mutation plumbing (busy guards, invalidation) ---------------- */
  const [busy, setBusy] = useState('');
  const [modal, setModal] = useState(null); // {kind:'record-new'} | {kind:'record-open', id} | {kind:'complete', treatment} | {kind:'followup'} | {kind:'plans'}
  const refreshAll = () => {
    invalidate(`/appointments/${idNum}`);
    invalidate('/appointments?');
    invalidate('/records?');
    invalidate('/records');
    if (pid) invalidate(`/patients/${pid}/dental`);
    invalidate('/plans?');
    invalidate('/invoices?');
    invalidate('/waiting-room');
    // invalidation drops cache entries; each hook must refetch to repopulate
    apptQ.refetch();
    patientQ.refetch();
    recordsQ.refetch();
    dentalQ.refetch();
    plansQ.refetch();
    invoicesQ.refetch();
  };

  async function runStatus(status) {
    if (busy) return;
    if (status === 'completed') {
      const ok = await confirm({ title: t('visit.action.completeVisit'), message: t('visit.confirm.complete'), confirmLabel: t('visit.action.completeVisit') });
      if (!ok) return;
    }
    setBusy(`status-${status}`);
    try {
      await api(`/appointments/${idNum}/status`, { method: 'PATCH', body: { status } });
      toast.success(t('visit.toast.statusUpdated'));
      refreshAll();
    } catch (err) { toast.error(err.message); } finally { setBusy(''); }
  }

  async function completeTreatment(treatment, note) {
    if (busy) return;
    setBusy(`complete-${treatment.id}`);
    try {
      await api(`/patients/${pid}/dental/treatments/${treatment.id}/status`, {
        method: 'PATCH', body: { status: 'completed', completion_note: note || undefined },
      });
      toast.success(t('visit.toast.procedureCompleted'));
      setModal(null);
      refreshAll();
    } catch (err) { toast.error(err.message); /* server truth: dup 409, contradictions 400 */ } finally { setBusy(''); }
  }

  /* ---------------- render guards: loading / error / not-found / forbidden ---------------- */
  if (!idValid) {
    return <div className="page"><EmptyState icon="🧭" title={t('visit.error.invalidId')} action={<Link className="btn btn-outline" to="/appointments">{t('visit.back.appointments')}</Link>} /></div>;
  }
  if (apptQ.isLoading) {
    return (
      <div className="page" aria-busy="true">
        <div className="skeleton skeleton-title" />
        <div className="skeleton skeleton-line" style={{ width: '40%' }} />
        <div className="grid-2 mt-12"><div className="skeleton skeleton-card" /><div className="skeleton skeleton-card" /></div>
      </div>
    );
  }
  if (apptQ.error && !appt) {
    const forbidden = /403|permission|forbidden/i.test(apptQ.error);
    return (
      <div className="page">
        <EmptyState icon={forbidden ? '🔒' : '🧭'} title={forbidden ? t('visit.error.forbidden') : t('visit.error.notFound')}>
          <div className="muted small">{apptQ.error}</div>
          <div className="flex mt-12" style={{ gap: 8 }}>
            <button className="btn btn-outline" onClick={() => apptQ.refetch()}>{t('visit.retry')}</button>
            <Link className="btn btn-outline" to="/appointments">{t('visit.back.appointments')}</Link>
          </div>
        </EmptyState>
      </div>
    );
  }
  if (!appt) return <div className="page"><Spinner label={t('visit.loading')} /></div>;

  const patientName = appt.patient_name || '—';
  const cancelled = appt.status === 'cancelled';
  const noShow = appt.status === 'no_show';
  const plannedTreats = treats.filter((x) => x.status === 'planned');
  const completedTreats = treats.filter((x) => x.status === 'completed');
  const drafts = visitRecs.filter((r) => r.status === 'draft');

  return (
    <div className="page">
      {/* ---------------- A. Visit header ---------------- */}
      <div className="page-head">
        <div>
          <div className="flex" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="icon-btn" aria-label={t('visit.back.appointments')} onClick={() => navigate('/appointments')}><IconChevL size={16} /></button>
            <h1 style={{ margin: 0 }}>{t('visit.title')}</h1>
            <StatusBadge status={appt.status} />
          </div>
          <div className="desc">
            <Link to={`/patients/${pid}`}>{patientName}</Link>
            {appt.patient_mrn ? <span className="muted"> · {appt.patient_mrn}</span> : null}
            {patient?.dob ? <span className="muted"> · {ageFromDob(patient.dob)} {t('visit.years')}</span> : null}
            {' · '}{fmtDate(appt.start_at)} {fmtTime(appt.start_at)} · {appt.duration_min} {t('visit.min')}
            {' · '}{appt.doctor_name || '—'}
          </div>
        </div>
        <div className="flex" style={{ gap: 8, flexWrap: 'wrap' }}>
          {actions.filter((a) => a.kind === 'status').map((a) => (
            <button key={a.id} className={`btn ${a.id === 'complete-visit' ? 'btn-primary' : 'btn-outline'}`}
              disabled={!!busy} onClick={() => runStatus(a.status)}>
              {busy === `status-${a.status}` ? '…' : t(a.labelKey)}
            </button>
          ))}
        </div>
      </div>

      {(cancelled || noShow) && (
        <div className="form-error" role="alert" style={{ margin: '0 0 12px' }}>
          {cancelled ? t('visit.banner.cancelled') : t('visit.banner.noShow')}
        </div>
      )}

      {/* patient alerts: only real stored data */}
      {patient && (patient.allergies || patient.medical_info) && (
        <div className="card card-pad mb-12" style={{ borderColor: 'var(--warn, #b45309)', background: 'var(--warn-soft, #fff7ed)' }} role="note">
          <b style={{ display: 'flex', gap: 6, alignItems: 'center' }}><IconAlert size={15} /> {t('visit.alerts')}</b>
          {patient.allergies && <div className="small mt-12"><b>{t('visit.allergies')}:</b> {patient.allergies}</div>}
          {patient.medical_info && <div className="small mt-12"><b>{t('visit.medicalInfo')}:</b> {patient.medical_info}</div>}
        </div>
      )}

      {/* booked services snapshot */}
      <div className="card card-pad mb-12">
        <b style={{ fontSize: 13.5 }}>{t('visit.services')}</b>
        <div className="flex mt-12" style={{ gap: 8, flexWrap: 'wrap' }}>
          {(appt.services || []).length === 0 && <span className="muted small">{t('visit.noServices')}</span>}
          {(appt.services || []).map((s) => (
            <span key={s.service_id} className="badge" style={{ background: 'var(--surface-2)' }}>
              {s.name} · {s.duration_min} {t('visit.min')} · {money(s.price_cents)}
            </span>
          ))}
          {appt.notes && <span className="muted small">· {appt.notes}</span>}
        </div>
      </div>

      {/* ---------------- B. Progress overview ---------------- */}
      <div className="card card-pad mb-12">
        <b style={{ fontSize: 13.5 }}>{t('visit.progress')}</b>
        <div className="flex mt-12" style={{ gap: 8, flexWrap: 'wrap' }} role="list" aria-label={t('visit.progress')}>
          {steps.map((s) => {
            const meta = STEP_STATUS_META[s.status] || STEP_STATUS_META.unknown;
            return (
              <div key={s.key} role="listitem" className={`visit-step ${meta.cls}`}>
                <span className="visit-step-dot" aria-hidden="true" />
                <span className="visit-step-label">{t(`visit.step.${s.key}`)}</span>
                <span className="visit-step-status">{t(meta.labelKey)}</span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="visit-grid">
        {/* ---------------- C. Clinical assessment ---------------- */}
        <section className="card card-pad" aria-labelledby="vw-assessment">
          <div className="flex-between">
            <b id="vw-assessment" style={{ fontSize: 13.5, display: 'flex', gap: 7, alignItems: 'center' }}><IconFileText size={16} /> {t('visit.section.assessment')}</b>
            {roles.clinical && (
              <button className="btn btn-sm btn-outline" onClick={() => setModal({ kind: 'record-new' })}><IconPlus size={13} /> {t('visit.action.newRecord')}</button>
            )}
          </div>
          {!roles.clinical ? (
            <div className="muted small mt-12">{t('visit.restricted.clinical')}</div>
          ) : recordsQ.isLoading ? <div className="skeleton skeleton-line mt-12" />
            : visitRecs.length === 0 ? <div className="muted small mt-12">{t('visit.empty.records')}</div>
              : visitRecs.map((r) => (
                <div key={r.id} className="dash-list-item row-link mt-12" role="button" tabIndex={0}
                  onClick={() => setModal({ kind: 'record-open', id: r.id })}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setModal({ kind: 'record-open', id: r.id }); } }}>
                  <span className="badge" style={r.status === 'approved' ? { background: 'var(--ok-soft)', color: 'var(--ok)' } : { background: 'var(--surface-2)' }}>
                    {r.status === 'approved' ? t('visit.record.finalized') : t('visit.record.draft')}
                  </span>
                  <span className="who"><b>{r.diagnosis || t('visit.record.noDx')}</b><span>{r.visit_date} · {r.doctor_name}</span></span>
                </div>
              ))}
        </section>

        {/* ---------------- D. Dental chart (compact, links to full) ---------------- */}
        <section className="card card-pad" aria-labelledby="vw-chart">
          <div className="flex-between">
            <b id="vw-chart" style={{ fontSize: 13.5, display: 'flex', gap: 7, alignItems: 'center' }}><IconTooth size={16} /> {t('visit.section.chart')}</b>
            <Link className="btn btn-sm btn-outline" to={`/patients/${pid}/dental?appointment_id=${idNum}`}>{t('visit.action.openChart')}</Link>
          </div>
          {dentalQ.isLoading ? <div className="skeleton skeleton-line mt-12" />
            : dentalQ.error ? <div className="muted small mt-12" role="alert">{dentalQ.error} <button className="btn btn-sm btn-outline" onClick={() => dentalQ.refetch()}>{t('visit.retry')}</button></div>
              : (
                <>
                  <div className="flex mt-12" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <span className="badge" style={{ background: 'var(--surface-2)' }}>{t('visit.chart.activeFindings')}: {dental?.summary?.active_findings ?? 0}</span>
                    <span className="badge" style={{ background: 'var(--surface-2)' }}>{t('visit.chart.planned')}: {plannedTreats.length}</span>
                    <span className="badge" style={{ background: 'var(--ok-soft)', color: 'var(--ok)' }}>{t('visit.chart.completed')}: {completedTreats.length}</span>
                  </div>
                  {treats.length === 0 && <div className="muted small mt-12">{t('visit.empty.chart')}</div>}
                  {plannedTreats.map((tr) => (
                    <div key={tr.id} className="dash-list-item mt-12">
                      <span className="badge" style={{ background: 'var(--surface-2)' }}>{t('visit.chart.plannedTag')}</span>
                      <span className="who"><b>{t('visit.tooth')} {tr.tooth_number} · {tr.procedure}</b><span>{tr.surfaces || '—'}</span></span>
                      {roles.clinical && !cancelled && (
                        <button className="btn btn-sm btn-primary" disabled={!!busy} onClick={() => setModal({ kind: 'complete', treatment: tr })}>
                          {t('visit.action.markPerformed')}
                        </button>
                      )}
                    </div>
                  ))}
                  {completedTreats.map((tr) => (
                    <div key={tr.id} className="dash-list-item mt-12">
                      <span className="badge" style={{ background: 'var(--ok-soft)', color: 'var(--ok)' }}>{t('visit.chart.performedTag')}</span>
                      <span className="who"><b>{t('visit.tooth')} {tr.tooth_number} · {tr.procedure}</b><span>{tr.completed_at ? fmtDate(tr.completed_at) : ''} {tr.completion_note ? `· ${tr.completion_note}` : ''}</span></span>
                    </div>
                  ))}
                </>
              )}
        </section>

        {/* ---------------- E. Treatment plans & sessions ---------------- */}
        <section className="card card-pad" aria-labelledby="vw-plans">
          <div className="flex-between">
            <b id="vw-plans" style={{ fontSize: 13.5, display: 'flex', gap: 7, alignItems: 'center' }}><IconGrid size={16} /> {t('visit.section.plans')}</b>
            <button className="btn btn-sm btn-outline" onClick={() => setModal({ kind: 'plans' })}>{t('visit.action.planManager')}</button>
          </div>
          {plansQ.isLoading ? <div className="skeleton skeleton-line mt-12" />
            : vPlans.length === 0 ? <div className="muted small mt-12">{t('visit.empty.plans')}</div>
              : vPlans.map((p) => (
                <div key={p.id} className="card card-pad mt-12" style={{ background: 'var(--surface-2)' }}>
                  <div className="flex-between">
                    <b style={{ fontSize: 13 }}>{p.title}</b>
                    <span className="badge" style={{ background: 'var(--surface)' }}>{p.status}</span>
                  </div>
                  <div className="muted small mt-12">
                    {t('visit.plan.items')}: {(p.items || []).length} · {t('visit.plan.completed')}: {(p.items || []).filter((i) => i.status === 'completed').length} · {t('visit.plan.sessions')}: {(p.sessions || []).length}
                  </div>
                  {(p.sessions || []).map((s) => (
                    <div key={s.id} className="small mt-12" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <span className="badge" style={{ background: 'var(--surface)' }}>{s.status}</span>
                      <span>{s.title || `#${s.id}`}</span>
                      {s.appointment_id
                        ? (s.appointment_id === idNum ? <span className="muted">· {t('visit.plan.thisVisit')}</span> : <Link to={`/visits/${s.appointment_id}`}>· {t('visit.plan.linkedVisit')}</Link>)
                        : null}
                    </div>
                  ))}
                </div>
              ))}
        </section>

        {/* ---------------- F+G. Performed / next actions ---------------- */}
        <section className="card card-pad" aria-labelledby="vw-next">
          <b id="vw-next" style={{ fontSize: 13.5, display: 'flex', gap: 7, alignItems: 'center' }}><IconCheck size={16} /> {t('visit.section.next')}</b>
          <div className="muted small mt-12">{t('visit.performedNote')}</div>
          <div className="flex mt-12" style={{ gap: 8, flexWrap: 'wrap' }}>
            {actions.filter((a) => a.kind !== 'status').length === 0 && <span className="muted small">{t('visit.empty.actions')}</span>}
            {actions.filter((a) => a.kind !== 'status').map((a) => (
              <button key={a.id} className="btn btn-sm btn-outline" disabled={!!busy} onClick={() => onAction(a)}>
                {t(a.labelKey)}
              </button>
            ))}
          </div>
        </section>

        {/* ---------------- H. Billing summary (authorized roles only) ---------------- */}
        {roles.financial && (
          <section className="card card-pad" aria-labelledby="vw-billing">
            <b id="vw-billing" style={{ fontSize: 13.5, display: 'flex', gap: 7, alignItems: 'center' }}><IconInvoice size={16} /> {t('visit.section.billing')}</b>
            {invoicesQ.isLoading ? <div className="skeleton skeleton-line mt-12" />
              : visitInvoices.length === 0 ? <div className="muted small mt-12">{t('visit.empty.invoices')}</div>
                : visitInvoices.map((i) => (
                  <Link key={i.id} to={`/invoices/${i.id}`} className="dash-list-item row-link mt-12" style={{ textDecoration: 'none' }}>
                    <span className="badge" style={{ background: 'var(--surface-2)' }}>{i.status}</span>
                    <span className="who">
                      <b>#{i.id} · {money(i.total_cents)}</b>
                      <span>{t('visit.billing.paid')}: {money(i.paid_cents)} · {t('visit.billing.balance')}: {money(i.balance_cents)}</span>
                    </span>
                  </Link>
                ))}
          </section>
        )}
      </div>

      {/* ---------------- modals ---------------- */}
      {modal?.kind === 'record-new' && (
        <RecordModal
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); refreshAll(); }}
          presetPatient={{ id: pid, first_name: patient?.first_name || patientName.split(' ')[0] || '', last_name: patient?.last_name || patientName.split(' ').slice(1).join(' ') || '', mrn: appt.patient_mrn || '' }}
          presetAppointmentId={idNum}
        />
      )}
      {modal?.kind === 'record-open' && (
        <RecordDetail id={modal.id} onClose={() => setModal(null)} onEdit={(rec) => setModal({ kind: 'record-edit', rec })} onChanged={refreshAll} />
      )}
      {modal?.kind === 'record-edit' && (
        <RecordModal editRecord={modal.rec} onClose={() => setModal({ kind: 'record-open', id: modal.rec.id })} onSaved={() => { setModal({ kind: 'record-open', id: modal.rec.id }); refreshAll(); }} />
      )}
      {modal?.kind === 'complete' && (
        <CompleteModal treatment={modal.treatment} busy={busy} onCancel={() => setModal(null)} onSubmit={(note) => completeTreatment(modal.treatment, note)} t={t} />
      )}
      {modal?.kind === 'followup' && (
        <AppointmentModal
          mode="create"
          initial={{ patient: { id: pid, first_name: patient?.first_name || '', last_name: patient?.last_name || '', mrn: appt.patient_mrn || '' }, doctor_id: appt.doctor_id, appointment_type: 'follow_up' }}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); refreshAll(); }}
        />
      )}
      {modal?.kind === 'plans' && (
        <Modal title={t('visit.action.planManager')} onClose={() => setModal(null)} wide>
          <TreatmentPlans patientId={pid} defaultAppointmentId={idNum} onChanged={refreshAll} />
        </Modal>
      )}
    </div>
  );

  function onAction(a) {
    switch (a.kind) {
      case 'record-new': setModal({ kind: 'record-new' }); break;
      case 'record-open-draft': setModal({ kind: 'record-open', id: drafts[0]?.id }); break;
      case 'link':
        if (a.to === 'dental') navigate(`/patients/${pid}/dental?appointment_id=${idNum}`);
        else if (a.to === 'plans' || a.to === 'plans-new') setModal({ kind: 'plans' });
        else if (a.to === 'invoices') navigate(`/invoices?patient_id=${pid}&appointment_id=${idNum}`);
        else if (a.to === 'invoices-new') navigate(`/invoices?patient_id=${pid}&appointment_id=${idNum}`);
        break;
      case 'book-followup': setModal({ kind: 'followup' }); break;
      default: break;
    }
  }
}

/** Completion note dialog — server validates, dedupes (409) and transactions. */
function CompleteModal({ treatment, busy, onCancel, onSubmit, t }) {
  const [note, setNote] = useState('');
  return (
    <Modal title={`${t('visit.action.markPerformed')} — ${t('visit.tooth')} ${treatment.tooth_number} ${treatment.procedure}`}
      onClose={onCancel}
      footer={<>
        <button className="btn btn-outline" onClick={onCancel} disabled={!!busy}>{t('visit.cancel')}</button>
        <button className="btn btn-primary" disabled={!!busy} onClick={() => onSubmit(note.trim())}>{busy ? '…' : t('visit.confirm.markPerformed')}</button>
      </>}>
      <Field label={t('visit.completionNote')} hint={t('visit.completionHint')}>
        <textarea className="input" rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
      </Field>
      <div className="muted small">{t('visit.completionWarning')}</div>
    </Modal>
  );
}
