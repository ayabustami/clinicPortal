import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, Link, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useI18n } from '../i18n.jsx';
import { Spinner, EmptyState, Modal, Field, useToast, useConfirm } from '../components/ui.jsx';
import Odontogram, { DentalLegend, toothTypeKey, TOOTH_NAME_KEY, CONDITIONS, PROCEDURE_TAG } from '../components/Odontogram.jsx';
import { fmtDateShort, fmtTime } from '../format.js';
import { IconCheck, IconX, IconEdit, IconPlus, IconAlert, IconClock, IconFileText } from '../components/icons.jsx';

const SURFACES = ['M', 'D', 'O', 'B', 'L'];
const PROCEDURES = ['filling', 'crown', 'extraction', 'root_canal', 'implant', 'bridge', 'cleaning', 'fluoride', 'other'];
/** Suggested clinical result when completing a procedure (explicit — never applied silently). */
const PROCEDURE_RESULT = {
  filling: 'filled', crown: 'crown', extraction: 'extracted', root_canal: 'root_canal', implant: 'implant',
  bridge: '', cleaning: '', fluoride: '', other: '',
};
const CONSEQUENTIAL = ['missing', 'extracted'];
const EVENT_ICONS = {
  finding_created: '🦷', finding_updated: '✏️', finding_resolved: '✔️', correction: '⚠️',
  treatment_planned: '🗓️', treatment_completed: '✅', treatment_cancelled: '🚫', treatment_reopened: '↩️', chart_config: '⚙️',
};

function quadrantKey(tooth) {
  const q = Math.floor(tooth / 10);
  return { 1: 'ur', 5: 'ur', 2: 'ul', 6: 'ul', 3: 'll', 7: 'll', 4: 'lr', 8: 'lr' }[q];
}

export default function DentalChart() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  // Visit context: opened from the Visit Workspace with ?appointment_id= —
  // every new finding/treatment is linked to that visit automatically.
  const visitApptId = params.get('appointment_id') || '';
  const { user } = useAuth();
  const { t, dir } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const clinical = ['owner', 'doctor'].includes(user.role);

  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [links, setLinks] = useState({ visits: [], records: [] });
  const [layers, setLayers] = useState({ current: true, planned: true, completed: true });
  const [jump, setJump] = useState('');
  const [jumpError, setJumpError] = useState('');
  const [selected, setSelected] = useState(() => {
    const n = Number(params.get('tooth'));
    return Number.isInteger(n) && n > 0 ? n : null;
  });
  const [history, setHistory] = useState([]);        // selected tooth history
  const [timeline, setTimeline] = useState([]);      // patient-level timeline
  const [showLegend, setShowLegend] = useState(true);

  const load = useCallback(async () => {
    try {
      const d = await api(`/patients/${id}/dental`);
      setData(d);
      setError('');
      const [h, appts, recs] = await Promise.all([
        api(`/patients/${id}/dental/history?limit=60`),
        api(`/appointments?patient_id=${id}&limit=30`).catch(() => ({ appointments: [] })),
        api(`/records?patient_id=${id}&limit=30`).catch(() => ({ records: [] })),
      ]);
      setTimeline(h.events);
      setLinks({ visits: appts.appointments || [], records: recs.records || [] });
    } catch (e) { setError(e.message); }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  // load selected-tooth history whenever the selection changes
  useEffect(() => {
    if (!selected) { setHistory([]); return; }
    let cancelled = false;
    (async () => {
      try {
        const h = await api(`/patients/${id}/dental/history?tooth=${selected}&limit=100`);
        if (!cancelled) setHistory(h.events);
      } catch { if (!cancelled) setHistory([]); }
    })();
    return () => { cancelled = true; };
  }, [selected, id, data]);

  const selectTooth = useCallback((tooth) => {
    setSelected(tooth);
    // preserve the visit context parameter while navigating teeth
    const next = {};
    const appt = params.get('appointment_id');
    if (appt) next.appointment_id = appt;
    if (tooth) next.tooth = String(tooth);
    setParams(next, { replace: true });
  }, [setParams, params]);

  const dentition = data?.chart?.dentition || 'permanent';
  const suggested = data?.chart?.dentition_suggested;
  const findings = useMemo(() => data?.findings || [], [data]);
  const treatments = useMemo(() => data?.treatments || [], [data]);

  async function changeDentition(next) {
    try {
      await api(`/patients/${id}/dental/config`, { method: 'PUT', body: { dentition: next } });
      await load();
      toast.success(t('dental.dentitionSaved'));
    } catch (e) { toast.error(e.message); }
  }

  function doJump(e) {
    e.preventDefault();
    const n = Number(jump);
    const valid = Number.isInteger(n) && (
      (Math.floor(n / 10) >= 1 && Math.floor(n / 10) <= 4 && n % 10 >= 1 && n % 10 <= 8) ||
      (Math.floor(n / 10) >= 5 && Math.floor(n / 10) <= 8 && n % 10 >= 1 && n % 10 <= 5)
    );
    if (!valid) { setJumpError(t('dental.invalidTooth')); return; }
    setJumpError(''); setJump(''); selectTooth(n);
  }

  if (error) return <div className="page"><div className="form-error" role="alert">{t('dental.loadError')} {error}</div><Link to={`/patients/${id}`}>← {t('dental.backToPatient')}</Link></div>;
  if (!data) return <div className="page"><Spinner label={t('dental.loading')} /></div>;

  const toothData = selected ? {
    findings: findings.filter((f) => f.tooth_number === selected),
    treatments: treatments.filter((tr) => tr.tooth_number === selected),
  } : null;

  return (
    <div className="page">
      {visitApptId && (
        <div className="card card-pad" style={{ marginBottom: 12, display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <span className="small muted">{t('chart.visitContext')}</span>
          <Link className="btn btn-outline btn-sm" to={`/visits/${visitApptId}`}>{t('visit.backToWorkspace')}</Link>
        </div>
      )}
      <div className="page-head">
        <div>
          <Link to={`/patients/${id}`} className="small muted">← {t('dental.backToPatient')}</Link>
          <h1>🦷 {t('dental.title')} <span className="muted" style={{ fontWeight: 500, fontSize: 15 }}>· {data.patient.first_name} {data.patient.last_name} · {data.patient.mrn}</span></h1>
          <div className="desc">
            {t('dental.counts')}: {data.counts.active_findings} {t('dental.findings').toLowerCase()} · {data.counts.planned} {t('dental.planned').toLowerCase()} · {data.counts.completed} {t('dental.completed').toLowerCase()}
          </div>
        </div>
      </div>

      {/* controls */}
      <div className="card card-pad mb-12 dental-controls">
        <div className="dental-control-group">
          <span className="dental-control-label">{t('dental.dentition')}</span>
          <div className="view-switch" role="tablist" aria-label={t('dental.dentition')}>
            {['permanent', 'primary', 'mixed'].map((dkey) => (
              <button key={dkey} role="tab" aria-selected={dentition === dkey}
                className={dentition === dkey ? 'on' : ''}
                onClick={() => dkey !== dentition && changeDentition(dkey)}>
                {t(`dental.dentition_${dkey}`)}
              </button>
            ))}
          </div>
          {suggested && suggested !== dentition && !data.chart.persisted && (
            <span className="field-hint" style={{ marginInlineStart: 8 }}>
              <IconAlert size={12} /> {t('dental.suggestedHint')} ({t(`dental.dentition_${suggested}`)})
            </span>
          )}
        </div>

        <div className="dental-control-group">
          <span className="dental-control-label">{t('dental.layers')}</span>
          {['current', 'planned', 'completed'].map((lk) => (
            <label key={lk} className="check-chip">
              <input type="checkbox" checked={layers[lk]} onChange={(e) => setLayers({ ...layers, [lk]: e.target.checked })} />
              {t(`dental.layer_${lk}`)}
            </label>
          ))}
        </div>

        <form className="dental-control-group" onSubmit={doJump}>
          <label className="dental-control-label" htmlFor="tooth-jump">{t('dental.jumpTooth')}</label>
          <input id="tooth-jump" className="input" style={{ width: 74 }} inputMode="numeric" maxLength={2}
            value={jump} onChange={(e) => setJump(e.target.value.replace(/\D/g, ''))} placeholder="16" />
          <button className="btn btn-outline btn-sm" type="submit">{t('dental.jump')}</button>
          {jumpError && <span className="small" style={{ color: 'var(--danger)' }} role="alert">{jumpError}</span>}
        </form>

        <div className="dental-control-group">
          <button className="btn btn-outline btn-sm" onClick={() => setShowLegend((v) => !v)} aria-expanded={showLegend}>
            {t('dental.legend')}
          </button>
        </div>
      </div>

      {showLegend && (
        <div className="card card-pad mb-12">
          <DentalLegend t={t} />
        </div>
      )}

      {/* the chart(s) — always LTR: anatomy must not mirror in RTL */}
      <div className="card card-pad mb-12" dir="ltr">
        <div className="odont-scroll" tabIndex={-1}>
        {(dentition === 'primary' || dentition === 'mixed') && (
          <section aria-label={t('dental.chartPrimary')} style={dentition === 'mixed' ? { marginBottom: 10 } : undefined}>
            {dentition === 'mixed' && <div className="dental-section-title" dir={dir}>{t('dental.dentition_primary')} — {t('dental.chartPrimary')}</div>}
            <Odontogram dentition="primary" findings={findings} treatments={treatments}
              layers={layers} selected={selected} onSelect={selectTooth} t={t} />
          </section>
        )}
        {(dentition === 'permanent' || dentition === 'mixed') && (
          <section aria-label={t('dental.chartPermanent')}>
            {dentition === 'mixed' && <div className="dental-section-title" dir={dir}>{t('dental.dentition_permanent')} — {t('dental.chartPermanent')}</div>}
            <Odontogram dentition="permanent" findings={findings} treatments={treatments}
              layers={layers} selected={selected} onSelect={selectTooth} t={t} />
          </section>
        )}
        </div>
        <div className="field-hint odont-hint" dir={dir}>{t('dental.scrollHint')}</div>
        <div className="field-hint" dir={dir} style={{ marginTop: 6 }}>{t('dental.notAssessedHint')}</div>
      </div>

      {/* patient-level timeline */}
      <div className="card card-pad">
        <div className="card-title">{t('dental.timeline')}</div>
        {timeline.length === 0
          ? <EmptyState icon="🦷" title={t('dental.emptyChart')} />
          : (
            <div className="timeline">
              {timeline.map((ev) => (
                <div key={ev.id} className="tl-item">
                  <span className="tl-ico">{EVENT_ICONS[ev.event_type] || '•'}</span>
                  <span className="tl-body">
                    <b>
                      {ev.tooth_number ? `${t('dental.toothLabel')} ${ev.tooth_number} — ` : ''}{t(`dental.event.${ev.event_type}`)}
                    </b>
                    <span className="tl-detail">
                      {describeEvent(ev, t)}
                    </span>
                  </span>
                  <span className="tl-meta">
                    <span className="muted small">{ev.user_name}</span>
                    <span className="muted small mono">{fmtDateShort(ev.created_at)} {fmtTime(ev.created_at)}</span>
                  </span>
                </div>
              ))}
            </div>
          )}
      </div>

      {/* tooth detail drawer */}
      {selected && (
        <ToothDrawer
          key={selected}
          tooth={selected}
          findings={toothData.findings}
          treatments={toothData.treatments}
          history={history}
          links={links}
          canEdit={clinical}
          t={t}
          onClose={() => selectTooth(null)}
          onChanged={load}
          visitApptId={visitApptId}
          toast={toast}
          confirm={confirm}
          patientId={id}
        />
      )}
    </div>
  );
}

function describeEvent(ev, t) {
  const parts = [];
  const nv = ev.new_value || {};
  const ov = ev.old_value || {};
  // History JSON may store surfaces as an array or as the legacy "M,O" string.
  const surf = (s) => (Array.isArray(s) ? s : typeof s === 'string' && s.trim() ? s.split(',').filter(Boolean) : []);
  if (nv.condition) parts.push(`${t(`dental.cond.${nv.condition}`)}${surf(nv.surfaces).length ? ` (${surf(nv.surfaces).join(',')})` : ''}`);
  if (nv.procedure) parts.push(t(`dental.proc.${nv.procedure}`));
  if (ov.condition && ov.condition !== nv.condition) parts.push(`${t('dental.was')}: ${t(`dental.cond.${ov.condition}`)}`);
  if (ov.status && nv.status && ov.status !== nv.status) parts.push(`${ov.status} → ${nv.status}`);
  if (ev.reason) parts.push(`${t('dental.reason')}: ${ev.reason}`);
  if (ev.note) parts.push(ev.note);
  return parts.join(' · ');
}

/* ================================================================== */
/* Tooth detail drawer                                                 */
/* ================================================================== */

function ToothDrawer({ tooth, findings, treatments, history, links, canEdit, t, onClose, onChanged, toast, confirm, patientId, visitApptId = '' }) {
  const [tab, setTab] = useState('findings');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');
  const [dirty, setDirty] = useState(false);

  const active = findings.filter((f) => f.status === 'active');
  const resolved = findings.filter((f) => f.status === 'resolved');
  const planned = treatments.filter((x) => x.status === 'planned');
  const done = treatments.filter((x) => x.status === 'completed');
  const cancelled = treatments.filter((x) => x.status === 'cancelled');

  /* --- add finding form --- */
  const [nf, setNf] = useState({ condition: 'caries', surfaces: [], note: '', appointment_id: visitApptId, record_id: '' });
  /* --- plan treatment form --- */
  const [nt, setNt] = useState({ procedure: 'filling', surfaces: [], note: '', appointment_id: visitApptId, record_id: '' });
  /* --- completion form --- */
  const [completing, setCompleting] = useState(null); // treatment being completed
  const [cf, setCf] = useState({ completion_note: '', apply_condition: '', apply_surfaces: [], resolve: [] });
  /* --- resolve / correct --- */
  const [resolving, setResolving] = useState(null);   // finding id
  const [resolveReason, setResolveReason] = useState('');
  const [correcting, setCorrecting] = useState(null); // finding being corrected
  const [corr, setCorr] = useState({ condition: '', surfaces: [], note: '', reason: '' });

  const kind = toothTypeKey(tooth);

  async function requestClose() {
    if (dirty) {
      const ok = await confirm({ title: t('dental.unsavedTitle'), message: t('dental.unsavedMsg'), confirmLabel: t('dental.discard'), danger: true });
      if (!ok) return;
    }
    onClose();
  }

  function markDirty() { setDirty(true); }

  async function run(fn, successMsg) {
    setBusy(true); setFormError('');
    try {
      await fn();
      setDirty(false);
      toast.success(successMsg);
      await onChanged();
    } catch (e) {
      setFormError(e.message); // server messages are explicit — never a false success
    } finally {
      setBusy(false);
    }
  }

  async function addFinding(e) {
    e.preventDefault();
    if (nf.condition === 'other' && !nf.note.trim()) { setFormError(t('dental.otherNeedsNote')); return; }
    if (CONSEQUENTIAL.includes(nf.condition)) {
      const ok = await confirm({
        title: t('dental.consequentialTitle'),
        message: `${t('dental.consequentialMsg')} ${tooth} — ${t(`dental.cond.${nf.condition}`)}.`,
        confirmLabel: t('dental.confirmRecord'), danger: true,
      });
      if (!ok) return;
    }
    await run(() => api(`/patients/${patientId}/dental/findings`, {
      method: 'POST',
      body: {
        tooth_number: tooth, condition: nf.condition, surfaces: nf.surfaces,
        note: nf.note || undefined,
        appointment_id: nf.appointment_id || undefined, record_id: nf.record_id || undefined,
      },
    }), t('dental.findingSaved'));
    setNf({ condition: 'caries', surfaces: [], note: '', appointment_id: visitApptId, record_id: '' });
  }

  async function addTreatment(e) {
    e.preventDefault();
    if (nt.procedure === 'other' && !nt.note.trim()) { setFormError(t('dental.otherNeedsNote')); return; }
    if (nt.procedure === 'extraction') {
      const ok = await confirm({
        title: t('dental.consequentialTitle'),
        message: `${t('dental.planExtractionMsg')} ${tooth}.`,
        confirmLabel: t('dental.confirmRecord'), danger: true,
      });
      if (!ok) return;
    }
    await run(() => api(`/patients/${patientId}/dental/treatments`, {
      method: 'POST',
      body: {
        tooth_number: tooth, procedure: nt.procedure, surfaces: nt.surfaces,
        note: nt.note || undefined,
        appointment_id: nt.appointment_id || undefined, record_id: nt.record_id || undefined,
      },
    }), t('dental.treatmentPlanned'));
    setNt({ procedure: 'filling', surfaces: [], note: '', appointment_id: visitApptId, record_id: '' });
  }

  function openCompletion(tr) {
    setCompleting(tr);
    const result = PROCEDURE_RESULT[tr.procedure] || '';
    // Never pre-propose documenting a state the tooth already has — the
    // duplicate-finding guard would (correctly) reject the completion.
    const alreadyDocumented = result && active.some((f) => f.condition === result);
    setCf({
      completion_note: '',
      apply_condition: alreadyDocumented ? '' : result,
      apply_surfaces: tr.surfaces || [],
      resolve: active.filter((f) => f.condition === 'caries' && tr.procedure === 'filling').map((f) => f.condition),
    });
  }

  async function submitCompletion(e) {
    e.preventDefault();
    const body = { status: 'completed', completion_note: cf.completion_note || undefined };
    if (cf.apply_condition) body.apply = { condition: cf.apply_condition, surfaces: cf.apply_surfaces, note: undefined };
    if (cf.resolve.length) body.resolve = cf.resolve;
    await run(() => api(`/patients/${patientId}/dental/treatments/${completing.id}/status`, { method: 'PATCH', body }), t('dental.treatmentCompleted'));
    setCompleting(null);
  }

  async function cancelTreatment(tr) {
    const reason = window.prompt(t('dental.reasonRequiredPrompt'));
    if (!reason || !reason.trim()) return;
    await run(() => api(`/patients/${patientId}/dental/treatments/${tr.id}/status`, { method: 'PATCH', body: { status: 'cancelled', reason: reason.trim() } }), t('dental.treatmentCancelled'));
  }

  async function reopenTreatment(tr) {
    const ok = await confirm({
      title: t('dental.reopenTitle'), message: t('dental.reopenMsg'),
      confirmLabel: t('dental.reopen'), danger: true,
    });
    if (!ok) return;
    const reason = window.prompt(t('dental.reasonRequiredPrompt'));
    if (!reason || !reason.trim()) return;
    await run(() => api(`/patients/${patientId}/dental/treatments/${tr.id}/status`, { method: 'PATCH', body: { status: 'planned', reason: reason.trim() } }), t('dental.treatmentReopened'));
  }

  async function submitResolve(e) {
    e.preventDefault();
    if (!resolveReason.trim()) { setFormError(t('dental.reasonRequired')); return; }
    await run(() => api(`/patients/${patientId}/dental/findings/${resolving}/resolve`, { method: 'POST', body: { reason: resolveReason.trim() } }), t('dental.findingResolved'));
    setResolving(null); setResolveReason('');
  }

  function openCorrection(f) {
    setCorrecting(f);
    setCorr({ condition: f.condition, surfaces: f.surfaces || [], note: f.note || '', reason: '' });
  }

  async function submitCorrection(e) {
    e.preventDefault();
    const changed = corr.condition !== correcting.condition || (corr.surfaces || []).join() !== (correcting.surfaces || []).join();
    if (changed && !corr.reason.trim()) { setFormError(t('dental.reasonRequired')); return; }
    if (corr.condition === 'other' && !corr.note.trim()) { setFormError(t('dental.otherNeedsNote')); return; }
    await run(() => api(`/patients/${patientId}/dental/findings/${correcting.id}`, {
      method: 'PUT',
      body: { condition: corr.condition, surfaces: corr.surfaces, note: corr.note || undefined, reason: corr.reason || undefined },
    }), t('dental.findingUpdated'));
    setCorrecting(null);
  }

  const surfacesPicker = (value, onChange) => (
    <div className="surface-chips" role="group" aria-label={t('dental.surfaces')}>
      {SURFACES.map((s) => (
        <label key={s} className={`surface-chip${value.includes(s) ? ' on' : ''}`}>
          <input type="checkbox" checked={value.includes(s)}
            onChange={(e) => { onChange(e.target.checked ? [...value, s] : value.filter((v) => v !== s)); markDirty(); }} />
          <b>{s}</b><span>{t(`dental.surface.${s}`)}</span>
        </label>
      ))}
      <span className="field-hint">{value.length === 0 ? t('dental.wholeTooth') : ''}</span>
    </div>
  );

  const linkPickers = (form, setForm) => (
    <div className="form-row">
      <Field label={t('dental.linkVisit')}>
        <select className="select" value={form.appointment_id} onChange={(e) => { setForm({ ...form, appointment_id: e.target.value }); markDirty(); }}>
          <option value="">—</option>
          {links.visits.map((v) => (
            <option key={v.id} value={v.id}>{fmtDateShort(v.start_at)} {fmtTime(v.start_at)} · {v.doctor_name} · {v.status}</option>
          ))}
        </select>
      </Field>
      <Field label={t('dental.linkRecord')}>
        <select className="select" value={form.record_id} onChange={(e) => { setForm({ ...form, record_id: e.target.value }); markDirty(); }}>
          <option value="">—</option>
          {links.records.map((r) => (
            <option key={r.id} value={r.id}>{r.visit_date} · {r.doctor_name}{r.diagnosis ? ` · ${r.diagnosis}` : ''}</option>
          ))}
        </select>
      </Field>
    </div>
  );

  return (
    <Modal
      title={`${t('dental.toothLabel')} ${tooth} — ${t(TOOTH_NAME_KEY[kind])}`}
      onClose={requestClose} wide
      footer={
        <>
          <span className="muted small" style={{ marginInlineEnd: 'auto' }}>
            {t(`dental.quadrant.${quadrantKey(tooth)}`)} · {Math.floor(tooth / 10) >= 5 ? t('dental.dentition_primary') : t('dental.dentition_permanent')} · FDI
          </span>
          <button className="btn btn-outline" onClick={requestClose}>{t('common.close')}</button>
        </>
      }
    >
      <div className="view-switch mb-12" style={{ width: 'fit-content' }} role="tablist">
        <button role="tab" aria-selected={tab === 'findings'} className={tab === 'findings' ? 'on' : ''} onClick={() => setTab('findings')}>
          {t('dental.findings')} ({active.length})
        </button>
        <button role="tab" aria-selected={tab === 'treatments'} className={tab === 'treatments' ? 'on' : ''} onClick={() => setTab('treatments')}>
          {t('dental.treatments')} ({planned.length + done.length})
        </button>
        <button role="tab" aria-selected={tab === 'history'} className={tab === 'history' ? 'on' : ''} onClick={() => setTab('history')}>
          {t('dental.history')} ({history.length})
        </button>
      </div>

      {formError && <div className="form-error" role="alert">{formError}</div>}

      {tab === 'findings' && (
        <>
          {active.length === 0 && resolved.length === 0 && (
            <EmptyState icon="🦷" title={t('dental.noFindings')} />
          )}
          {active.map((f) => (
            <div key={f.id} className="dash-list-item dental-item">
              <span className="who">
                <b>{t(`dental.cond.${f.condition}`)}{f.surfaces?.length ? ` · ${f.surfaces.map((s) => t(`dental.surface.${s}`)).join(', ')}` : ` · ${t('dental.wholeTooth')}`}</b>
                <span>{f.note || ''}{f.note && ' · '}{f.created_by_name} · {fmtDateShort(f.created_at)}</span>
              </span>
              {canEdit && (
                <span className="flex" style={{ gap: 6 }}>
                  <button className="btn btn-outline btn-sm" onClick={() => openCorrection(f)} disabled={busy}><IconEdit size={13} /> {t('dental.correct')}</button>
                  <button className="btn btn-outline btn-sm" onClick={() => { setResolving(f.id); setResolveReason(''); }} disabled={busy}><IconCheck size={13} /> {t('dental.resolve')}</button>
                </span>
              )}
            </div>
          ))}
          {resolved.length > 0 && (
            <details className="muted small" style={{ margin: '8px 0' }}>
              <summary>{t('dental.resolved')} ({resolved.length})</summary>
              {resolved.map((f) => (
                <div key={f.id} className="dash-list-item dental-item" style={{ opacity: 0.75 }}>
                  <span className="who">
                    <b><s>{t(`dental.cond.${f.condition}`)}</s> · {t('dental.resolvedTag')}</b>
                    <span>{f.updated_by_name} · {fmtDateShort(f.updated_at)}</span>
                  </span>
                </div>
              ))}
            </details>
          )}

          {canEdit && (
            <form onSubmit={addFinding} className="card card-pad dental-form" style={{ marginTop: 12 }}>
              <div className="card-title"><IconPlus size={14} /> {t('dental.addFinding')}</div>
              <Field label={t('dental.condition')} required>
                <select className="select" value={nf.condition} onChange={(e) => { setNf({ ...nf, condition: e.target.value }); markDirty(); }} required>
                  {CONDITIONS.map((c) => <option key={c} value={c}>{t(`dental.cond.${c}`)}</option>)}
                </select>
              </Field>
              <Field label={t('dental.surfaces')} hint={t('dental.surfacesHint')}>
                {surfacesPicker(nf.surfaces, (v) => setNf({ ...nf, surfaces: v }))}
              </Field>
              <Field label={t('dental.note')}>
                <textarea className="textarea" rows={2} maxLength={2000} value={nf.note}
                  onChange={(e) => { setNf({ ...nf, note: e.target.value }); markDirty(); }} />
              </Field>
              {linkPickers(nf, setNf)}
              <button className="btn btn-primary btn-sm" disabled={busy} type="submit">
                {busy ? t('dental.saving') : t('dental.saveFinding')}
              </button>
            </form>
          )}
        </>
      )}

      {tab === 'treatments' && (
        <>
          {planned.length === 0 && done.length === 0 && cancelled.length === 0 && (
            <EmptyState icon="🗓️" title={t('dental.noTreatments')} />
          )}
          {planned.length > 0 && <div className="dental-layer-title">{t('dental.planned')}</div>}
          {planned.map((tr) => (
            <div key={tr.id} className="dash-list-item dental-item">
              <span className="who">
                <b>{t(`dental.proc.${tr.procedure}`)}{tr.surfaces?.length ? ` · ${tr.surfaces.join(',')}` : ''}</b>
                <span>{tr.note || ''}{tr.note && ' · '}{tr.planned_by_name} · {fmtDateShort(tr.planned_at)}</span>
              </span>
              {canEdit && (
                <span className="flex" style={{ gap: 6 }}>
                  <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => openCompletion(tr)}><IconCheck size={13} /> {t('dental.complete')}</button>
                  <button className="btn btn-outline btn-sm" disabled={busy} onClick={() => cancelTreatment(tr)}><IconX size={13} /> {t('common.cancel')}</button>
                </span>
              )}
            </div>
          ))}
          {done.length > 0 && <div className="dental-layer-title">{t('dental.completed')}</div>}
          {done.map((tr) => (
            <div key={tr.id} className="dash-list-item dental-item">
              <span className="who">
                <b>✅ {t(`dental.proc.${tr.procedure}`)}</b>
                <span>{tr.completion_note || ''}{tr.completion_note && ' · '}{tr.completed_by_name} · {fmtDateShort(tr.completed_at)} {fmtTime(tr.completed_at)}</span>
              </span>
              {canEdit && (
                <button className="btn btn-outline btn-sm" disabled={busy} onClick={() => reopenTreatment(tr)} title={t('dental.reopenMsg')}>
                  <IconClock size={13} /> {t('dental.reopen')}
                </button>
              )}
            </div>
          ))}
          {cancelled.length > 0 && (
            <details className="muted small" style={{ margin: '8px 0' }}>
              <summary>{t('dental.cancelled')} ({cancelled.length})</summary>
              {cancelled.map((tr) => (
                <div key={tr.id} className="dash-list-item dental-item" style={{ opacity: 0.75 }}>
                  <span className="who"><b><s>{t(`dental.proc.${tr.procedure}`)}</s></b><span>{tr.planned_by_name} · {fmtDateShort(tr.planned_at)}</span></span>
                </div>
              ))}
            </details>
          )}

          {canEdit && (
            <form onSubmit={addTreatment} className="card card-pad dental-form" style={{ marginTop: 12 }}>
              <div className="card-title"><IconPlus size={14} /> {t('dental.planTreatment')}</div>
              <Field label={t('dental.procedure')} required>
                <select className="select" value={nt.procedure} onChange={(e) => { setNt({ ...nt, procedure: e.target.value }); markDirty(); }} required>
                  {PROCEDURES.map((p) => <option key={p} value={p}>{t(`dental.proc.${p}`)}</option>)}
                </select>
              </Field>
              <Field label={t('dental.surfaces')} hint={t('dental.surfacesHint')}>
                {surfacesPicker(nt.surfaces, (v) => setNt({ ...nt, surfaces: v }))}
              </Field>
              <Field label={t('dental.note')}>
                <textarea className="textarea" rows={2} maxLength={2000} value={nt.note}
                  onChange={(e) => { setNt({ ...nt, note: e.target.value }); markDirty(); }} />
              </Field>
              {linkPickers(nt, setNt)}
              <button className="btn btn-primary btn-sm" disabled={busy} type="submit">
                {busy ? t('dental.saving') : t('dental.savePlan')}
              </button>
            </form>
          )}
        </>
      )}

      {tab === 'history' && (
        <>
          {history.length === 0 && <EmptyState icon="🕐" title={t('dental.noHistory')} />}
          <div className="timeline">
            {history.map((ev) => (
              <div key={ev.id} className="tl-item">
                <span className="tl-ico">{EVENT_ICONS[ev.event_type] || '•'}</span>
                <span className="tl-body">
                  <b>{t(`dental.event.${ev.event_type}`)}</b>
                  <span className="tl-detail">{describeEvent(ev, t)}</span>
                </span>
                <span className="tl-meta">
                  <span className="muted small">{ev.user_name}</span>
                  <span className="muted small mono">{fmtDateShort(ev.created_at)} {fmtTime(ev.created_at)}</span>
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      {/* completion dialog */}
      {completing && (
        <Modal title={`${t('dental.completeTitle')} — ${t(`dental.proc.${completing.procedure}`)} (${t('dental.toothLabel')} ${tooth})`}
          onClose={() => !busy && setCompleting(null)}
          footer={
            <>
              <button className="btn btn-outline" disabled={busy} onClick={() => setCompleting(null)}>{t('common.cancel')}</button>
              <button className="btn btn-primary" disabled={busy} form="completion-form" type="submit">
                {busy ? t('dental.saving') : t('dental.confirmComplete')}
              </button>
            </>
          }
        >
          <form id="completion-form" onSubmit={submitCompletion}>
            <div className="field-hint mb-12"><IconAlert size={13} /> {t('dental.completionHint')}</div>
            <Field label={t('dental.completionNote')}>
              <textarea className="textarea" rows={2} maxLength={2000} value={cf.completion_note}
                onChange={(e) => setCf({ ...cf, completion_note: e.target.value })} />
            </Field>
            <Field label={t('dental.applyFinding')} hint={t('dental.applyHint')}>
              <select className="select" value={cf.apply_condition} onChange={(e) => setCf({ ...cf, apply_condition: e.target.value })}>
                <option value="">— {t('dental.applyNone')} —</option>
                {CONDITIONS.filter((c) => c !== 'healthy').map((c) => <option key={c} value={c}>{t(`dental.cond.${c}`)}</option>)}
              </select>
            </Field>
            {cf.apply_condition && (
              <Field label={t('dental.surfaces')}>
                {surfacesPicker(cf.apply_surfaces, (v) => setCf({ ...cf, apply_surfaces: v }))}
              </Field>
            )}
            {active.length > 0 && (
              <Field label={t('dental.resolveFindings')} hint={t('dental.resolveFindingsHint')}>
                <div className="surface-chips">
                  {active.map((f) => (
                    <label key={f.id} className={`surface-chip${cf.resolve.includes(f.condition) ? ' on' : ''}`}>
                      <input type="checkbox" checked={cf.resolve.includes(f.condition)}
                        onChange={(e) => setCf({
                          ...cf,
                          resolve: e.target.checked
                            ? [...new Set([...cf.resolve, f.condition])]
                            : cf.resolve.filter((c) => c !== f.condition),
                        })} />
                      <b>{t(`dental.cond.${f.condition}`)}</b>
                    </label>
                  ))}
                </div>
              </Field>
            )}
          </form>
        </Modal>
      )}

      {/* resolve dialog */}
      {resolving !== null && (
        <Modal title={t('dental.resolveTitle')} onClose={() => !busy && setResolving(null)}
          footer={
            <>
              <button className="btn btn-outline" disabled={busy} onClick={() => setResolving(null)}>{t('common.cancel')}</button>
              <button className="btn btn-primary" disabled={busy} form="resolve-form" type="submit">{busy ? t('dental.saving') : t('dental.resolve')}</button>
            </>
          }
        >
          <form id="resolve-form" onSubmit={submitResolve}>
            <Field label={t('dental.reason')} required hint={t('dental.resolveHint')}>
              <input className="input" value={resolveReason} maxLength={500} required
                onChange={(e) => setResolveReason(e.target.value)} />
            </Field>
          </form>
        </Modal>
      )}

      {/* correction dialog */}
      {correcting && (
        <Modal title={`${t('dental.correct')} — ${t(`dental.cond.${correcting.condition}`)}`} onClose={() => !busy && setCorrecting(null)}
          footer={
            <>
              <button className="btn btn-outline" disabled={busy} onClick={() => setCorrecting(null)}>{t('common.cancel')}</button>
              <button className="btn btn-primary" disabled={busy} form="corr-form" type="submit">{busy ? t('dental.saving') : t('dental.saveCorrection')}</button>
            </>
          }
        >
          <form id="corr-form" onSubmit={submitCorrection}>
            <div className="field-hint mb-12"><IconFileText size={13} /> {t('dental.correctionHint')}</div>
            <Field label={t('dental.condition')}>
              <select className="select" value={corr.condition} onChange={(e) => setCorr({ ...corr, condition: e.target.value })}>
                {CONDITIONS.map((c) => <option key={c} value={c}>{t(`dental.cond.${c}`)}</option>)}
              </select>
            </Field>
            <Field label={t('dental.surfaces')}>
              {surfacesPicker(corr.surfaces, (v) => setCorr({ ...corr, surfaces: v }))}
            </Field>
            <Field label={t('dental.note')}>
              <textarea className="textarea" rows={2} maxLength={2000} value={corr.note} onChange={(e) => setCorr({ ...corr, note: e.target.value })} />
            </Field>
            <Field label={t('dental.reason')} hint={t('dental.reasonIfChanged')} required>
              <input className="input" value={corr.reason} maxLength={500} onChange={(e) => setCorr({ ...corr, reason: e.target.value })} />
            </Field>
          </form>
        </Modal>
      )}
    </Modal>
  );
}
