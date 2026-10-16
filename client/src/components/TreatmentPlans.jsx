import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { cachedGet, prime, invalidateTimelines } from '../apiCache.js';
import { useAuth, useClinicMeta } from '../auth.jsx';
import { Modal, Field, Spinner, EmptyState, useToast, useConfirm } from './ui.jsx';
import AppointmentModal from './AppointmentModal.jsx';
import { money } from '../format.js';
import { IconPlus } from './icons.jsx';

const SURFACES = ['M', 'D', 'O', 'B', 'L'];
const FDI = [
  [18, 17, 16, 15, 14, 13, 12, 11], [21, 22, 23, 24, 25, 26, 27, 28],
  [48, 47, 46, 45, 44, 43, 42, 41], [31, 32, 33, 34, 35, 36, 37, 38],
  [55, 54, 53, 52, 51], [61, 62, 63, 64, 65],
  [85, 84, 83, 82, 81], [71, 72, 73, 74, 75],
].flat().sort((a, b) => a - b);

const PLAN_STATUS_LABEL = {
  draft: lang === 'ar' ? 'مسودة' : 'Draft', pending_approval: 'Pending approval', approved: 'Approved',
  in_progress: 'In progress', completed: 'Completed', cancelled: 'Cancelled',
};
const SESSION_LABEL = (lang) => lang === 'ar'
  ? { planned: 'مخطط', scheduled: 'مجدول', in_progress: 'قيد التنفيذ', completed: 'مكتمل', cancelled: 'ملغى' }
  : { planned: 'Planned', scheduled: 'Scheduled', in_progress: 'In progress', completed: 'Completed', cancelled: 'Cancelled' };
const ITEM_LABEL = (lang) => lang === 'ar'
  ? { proposed: 'مقترح', approved: 'معتمد', scheduled: 'مجدول', completed: 'مكتمل', cancelled: 'ملغى', postponed: 'مؤجل' }
  : { proposed: 'Proposed', approved: 'Approved', scheduled: 'Scheduled', completed: 'Completed', cancelled: 'Cancelled', postponed: 'Postponed' };
const ITEM_PRIORITY_LABEL = (lang) => lang === 'ar'
  ? { urgent: 'عاجل', high: 'عالي', routine: 'روتيني', low: 'منخفض' }
  : { urgent: 'Urgent', high: 'High', routine: 'Routine', low: 'Low' };
const PRIORITY_STYLE = {
  urgent:  { bg: '#fdecea', fg: '#991b1b', bd: '#f3c1c1' },
  high:    { bg: '#fff7e6', fg: '#a16207', bd: '#fde4ad' },
  routine: { bg: '#f1f5f9', fg: '#475569', bd: '#dbe2ea' },
  low:     { bg: '#f1f5f9', fg: '#64748b', bd: '#e2e8f0' },
};
function PriorityBadge({ p }) {
  if (!p) return null;
  const st = PRIORITY_STYLE[p] || PRIORITY_STYLE.routine;
  return <span className="badge" style={{ background: st.bg, color: st.fg, borderColor: st.bd }}>{ITEM_PRIORITY_LABEL(lang)[p] || p}</span>;
}
/** E: group procedures by tooth (FDI order); tooth-less items land in "Full mouth / general". */
function groupByTooth(items) {
  const byTooth = new Map();
  for (const it of items) {
    const key = it.tooth_number ? `#${it.tooth_number}` : '__general__';
    if (!byTooth.has(key)) byTooth.set(key, []);
    byTooth.get(key).push(it);
  }
  const entries = [...byTooth.entries()].sort((a, b) => {
    if (a[0] === '__general__') return 1;
    if (b[0] === '__general__') return -1;
    return Number(a[0].slice(1)) - Number(b[0].slice(1));
  });
  return entries;
}
function lineCents(it) { return Number(it.line_total_cents ?? (Number(it.price_cents) || 0) * (Number(it.quantity) || 1)); }
const PILL = {
  draft:            { bg: '#f1f5f9', fg: '#475569', bd: '#dbe2ea', c: '#94a3b8' },
  pending_approval: { bg: '#fff7e6', fg: '#a16207', bd: '#fde4ad', c: '#f59e0b' },
  approved:         { bg: '#eff6ff', fg: '#1e5fd6', bd: '#bfdbfe', c: '#3b82f6' },
  scheduled:        { bg: '#eff6ff', fg: '#1e5fd6', bd: '#bfdbfe', c: '#3b82f6' },
  in_progress:      { bg: '#f4efff', fg: '#6d3bd6', bd: '#ddd0fb', c: '#8b5cf6' },
  completed:        { bg: '#f2f8e5', fg: '#42650b', bd: '#d5e8b2', c: '#65a30d' },
  cancelled:        { bg: '#f1f5f9', fg: '#475569', bd: '#dbe2ea', c: '#94a3b8' },
  proposed:         { bg: '#f1f5f9', fg: '#475569', bd: '#dbe2ea', c: '#94a3b8' },
  planned:          { bg: '#f1f5f9', fg: '#475569', bd: '#dbe2ea', c: '#94a3b8' },
  postponed:        { bg: '#fff7e6', fg: '#a16207', bd: '#fde4ad', c: '#f59e0b' },
};

function StatusPill({ map, status }) {
  const s = PILL[status] || PILL.draft;
  return <span className="badge" style={{ background: s.bg, color: s.fg, borderColor: s.bd }}><span className="bdot" style={{ background: s.c }} />{map[status] || status}</span>;
}

/* ------------------------------------------------------------------ */
/* Plan builder: a brand-new draft plan (title + items + sessions)     */
/* ------------------------------------------------------------------ */
function PlanBuilder({ patientId, defaultAppointmentId, onClose, onCreated }) {
  const { user } = useAuth();
  const { lang } = useI18n();
  const { doctors, services } = useClinicMeta();
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [doctorId, setDoctorId] = useState(user?.doctor_id ? String(user.doctor_id) : (doctors[0] ? String(doctors[0].id) : ''));
  const [priority, setPriority] = useState('routine');
  const [notes, setNotes] = useState('');
  const [sessions, setSessions] = useState([]);
  const [items, setItems] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  function blankItem() {
    return { service_id: '', tooth_number: '', surfaces: [], procedure_label: '', duration_min: '', price_cents: '', quantity: '1', priority: 'routine', session_index: '' };
  }
  const [draftItem, setDraftItem] = useState(blankItem);

  function onPickService(id) {
    const svc = services.find((s) => String(s.id) === id);
    setDraftItem((d) => ({
      ...d, service_id: id,
      procedure_label: d.procedure_label || svc?.name || '',
      duration_min: svc?.duration_min ? String(svc.duration_min) : d.duration_min,
      price_cents: svc?.price_cents ? String(svc.price_cents) : d.price_cents,
    }));
  }

  function addItem() {
    if (!draftItem.procedure_label.trim() && !draftItem.service_id) { toast.error(lang === 'ar' ? 'اختر خدمة أو اكتب اسم إجراء.' : 'Choose a service or type a procedure name.'); return; }
    // duplicate guard (client-side mirror of the server rule)
    const dup = items.find((it) => String(it.service_id || '') === String(draftItem.service_id || '')
      && String(it.tooth_number || '') === String(draftItem.tooth_number || '')
      && (it.surfaces || []).slice().sort().join('') === (draftItem.surfaces || []).slice().sort().join('')
      && String(it.session_index || '') === String(draftItem.session_index || ''));
    if (dup) {
      toast.error(lang === 'ar' ? 'هذا الإجراء (نفس الخدمة، السن، الأسطح، الجلسة) موجود بالفعل في الخطة. غيّر الكمية في السطر الموجود أو عدّل السن/الأسطح.' : 'That exact procedure (same service, tooth, surfaces, session) is already on the plan. Change the quantity on the existing line or adjust tooth/surfaces instead.');
      return;
    }
    setItems((xs) => [...xs, { ...draftItem, _k: Math.random().toString(36).slice(2) }]);
    setDraftItem(blankItem());
  }

  const qtyOf = (it) => Math.max(1, Math.min(99, Number(it.quantity) || 1));
  const itemsTotal = items.reduce((a, it) => a + (Number(it.price_cents) || 0) * qtyOf(it), 0);
  const itemsMinutes = items.reduce((a, it) => a + (Number(it.duration_min) || 0) * qtyOf(it), 0);

  async function create() {
    setError('');
    if (!title.trim()) { setError(lang === 'ar' ? 'عنوان الخطة مطلوب.' : 'A plan title is required.'); return; }
    if (!items.length) { setError(lang === 'ar' ? 'أضف إجراءً واحداً على الأقل إلى الخطة.' : 'Add at least one procedure to the plan.'); return; }
    setBusy(true);
    try {
      const res = await api('/plans', {
        method: 'POST',
        body: {
          patient_id: patientId,
          ...(defaultAppointmentId ? { appointment_id: Number(defaultAppointmentId) } : {}),
          title: title.trim(),
          responsible_doctor_id: doctorId ? Number(doctorId) : undefined,
          priority,
          notes: notes.trim() || undefined,
          sessions: sessions.map((t2) => ({ title: t2 })),
          items: items.map((it) => ({
            service_id: it.service_id ? Number(it.service_id) : null,
            tooth_number: it.tooth_number ? Number(it.tooth_number) : null,
            surfaces: (it.surfaces || []).join(''),
            procedure_label: it.procedure_label.trim(),
            duration_min: it.duration_min !== '' ? Number(it.duration_min) : undefined,
            price_cents: it.price_cents !== '' ? Number(it.price_cents) : undefined,
            quantity: qtyOf(it),
            priority: it.priority || 'routine',
            session_index: it.session_index !== '' ? Number(it.session_index) : undefined,
          })),
        },
      });
      toast.success(lang === 'ar' ? 'تم إنشاء مسودة خطة العلاج.' : 'Draft treatment plan created.');
      onCreated(res.plan);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  return (
    <Modal title="New treatment plan" onClose={onClose} wide footer={
      <>
        <button className="btn btn-outline" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn btn-primary" onClick={create} disabled={busy}>{busy ? (lang === 'ar' ? 'جارٍ الإنشاء…' : 'Creating…') : (lang === 'ar' ? 'إنشاء مسودة خطة' : 'Create draft plan')}</button>
      </>
    }>
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="form-row">
        <Field label="Plan title" required>
          <input className="input" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Full mouth rehabilitation" />
        </Field>
        <Field label="Responsible dentist">
          <select className="select" aria-label="Responsible dentist" value={doctorId} onChange={(e) => setDoctorId(e.target.value)}>
            <option value="">— Unassigned —</option>
            {doctors.map((d) => <option key={d.id} value={String(d.id)}>{d.name}</option>)}
          </select>
        </Field>
        <Field label="Priority">
          <select className="select" aria-label="Priority" value={priority} onChange={(e) => setPriority(e.target.value)}>
            <option value="urgent">Urgent</option>
            <option value="high">High</option>
            <option value="routine">Routine</option>
            <option value="low">Low</option>
          </select>
        </Field>
      </div>
      <Field label="Notes"><textarea className="textarea" rows={2} value={notes} maxLength={2000} onChange={(e) => setNotes(e.target.value)} /></Field>

      <div className="card-title mt-12">Sessions (optional split)</div>
      <div className="flex" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        {sessions.map((st, i) => (
          <span key={i} className="badge bg-info">
            #{i + 1} {st}
            <button type="button" className="icon-btn" aria-label={`Remove session ${st}`} style={{ marginLeft: 6, width: 20, height: 20 }}
              onClick={() => { setSessions((xs) => xs.filter((_, j) => j !== i)); setItems((xs) => xs.map((it) => (it.session_index === String(i) ? { ...it, session_index: '' } : it))); }}>×</button>
          </span>
        ))}
        <button type="button" className="btn btn-outline btn-sm" onClick={() => {
          const n = prompt(lang === 'ar' ? 'عنوان الجلسة' : 'Session title', `Session ${sessions.length + 1}`);
          if (n && n.trim()) setSessions((xs) => [...xs, n.trim()]);
        }}><IconPlus size={13} /> Add session</button>
      </div>

      <div className="card-title mt-12">Procedures</div>
      {items.length > 0 && (
        <table className="tbl" style={{ marginBottom: 10 }}>
          <thead><tr><th>Procedure</th><th>Tooth</th><th>Session</th><th>Priority</th><th style={{ textAlign: 'right' }}>Min</th><th style={{ textAlign: 'right' }}>Qty</th><th style={{ textAlign: 'right' }}>Unit price</th><th style={{ textAlign: 'right' }}>Line total</th><th /></tr></thead>
          <tbody>
            {items.map((it) => (
              <tr key={it._k}>
                <td>{it.procedure_label || services.find((s) => String(s.id) === it.service_id)?.name || '—'}</td>
                <td className="mono">{it.tooth_number ? `#${it.tooth_number} ${(it.surfaces || []).join('')}` : ''}</td>
                <td>{it.session_index !== '' ? `#${Number(it.session_index) + 1} ${sessions[Number(it.session_index)]}` : lang === 'ar' ? 'غير مُسنَد' : 'Unassigned'}</td>
                <td><PriorityBadge p={it.priority} /></td>
                <td style={{ textAlign: 'right' }} className="mono">{it.duration_min ? Number(it.duration_min) * qtyOf(it) : '—'}</td>
                <td style={{ textAlign: 'right' }}>
                  <input className="input" type="number" min="1" max="99" aria-label={`Quantity for ${it.procedure_label || 'item'}`}
                    style={{ width: 58, padding: '2px 6px', fontSize: 12.5, textAlign: 'right' }} value={qtyOf(it)}
                    onChange={(e) => setItems((xs) => xs.map((x) => (x._k === it._k ? { ...x, quantity: e.target.value } : x)))} />
                </td>
                <td style={{ textAlign: 'right' }} className="mono">{money(Number(it.price_cents) || 0)}</td>
                <td style={{ textAlign: 'right' }} className="mono"><b>{money((Number(it.price_cents) || 0) * qtyOf(it))}</b></td>
                <td><button type="button" className="icon-btn" aria-label="Remove item" onClick={() => setItems((xs) => xs.filter((x) => x._k !== it._k))}>✕</button></td>
              </tr>
            ))}
            <tr>
              <td colSpan={4}><b>Total estimate</b> <span className="muted small">· invoicing happens separately, from performed work</span></td>
              <td style={{ textAlign: 'right' }} className="mono"><b>{itemsMinutes}</b></td>
              <td colSpan={2} />
              <td style={{ textAlign: 'right' }} className="mono"><b>{money(itemsTotal)}</b></td>
              <td />
            </tr>
          </tbody>
        </table>
      )}

      <div className="card card-pad" style={{ background: 'var(--surface-2)' }}>
        <div className="form-row">
          <Field label="Service (catalog)">
            <select className="select" aria-label="Service catalog" value={draftItem.service_id} onChange={(e) => onPickService(e.target.value)}>
              <option value="">— Custom procedure —</option>
              {services.map((s) => <option key={s.id} value={String(s.id)}>{s.name}{s.price_cents ? ` · ${money(s.price_cents)}` : ''}</option>)}
            </select>
          </Field>
          <Field label="Procedure label">
            <input className="input" value={draftItem.procedure_label} maxLength={200} onChange={(e) => setDraftItem({ ...draftItem, procedure_label: e.target.value })} />
          </Field>
          <Field label="Tooth (FDI)">
            <select className="select" aria-label="Tooth number" value={draftItem.tooth_number} onChange={(e) => setDraftItem({ ...draftItem, tooth_number: e.target.value })}>
              <option value="">— None —</option>
              {FDI.map((n) => <option key={n} value={String(n)}>{n}</option>)}
            </select>
          </Field>
        </div>
        <div className="form-row">
          <Field label="Surfaces">
            <div className="surface-chips" role="group" aria-label="Surfaces">
              {SURFACES.map((sf) => (
                <label key={sf} className={`surface-chip${draftItem.surfaces.includes(sf) ? ' on' : ''}`}>
                  <input type="checkbox" checked={draftItem.surfaces.includes(sf)}
                    onChange={(e) => setDraftItem((d) => ({ ...d, surfaces: e.target.checked ? [...d.surfaces, sf] : d.surfaces.filter((x) => x !== sf) }))} />
                  <b>{sf}</b>
                </label>
              ))}
            </div>
          </Field>
          <Field label="Duration (min)">
            <input className="input" type="number" min="5" max="480" value={draftItem.duration_min} onChange={(e) => setDraftItem({ ...draftItem, duration_min: e.target.value })} />
          </Field>
          <Field label="Price (cents)">
            <input className="input" type="number" min="0" value={draftItem.price_cents} onChange={(e) => setDraftItem({ ...draftItem, price_cents: e.target.value })} />
          </Field>
          <Field label="Quantity">
            <input className="input" type="number" min="1" max="99" value={draftItem.quantity} onChange={(e) => setDraftItem({ ...draftItem, quantity: e.target.value })} />
          </Field>
          <Field label="Priority">
            <select className="select" aria-label="Item priority" value={draftItem.priority} onChange={(e) => setDraftItem({ ...draftItem, priority: e.target.value })}>
              {Object.entries(ITEM_PRIORITY_LABEL(lang)).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </Field>
          <Field label="Session">
            <select className="select" aria-label="Session assignment" value={draftItem.session_index} onChange={(e) => setDraftItem({ ...draftItem, session_index: e.target.value })}>
              <option value="">— Unassigned —</option>
              {sessions.map((st, i) => <option key={i} value={String(i)}>#{i + 1} {st}</option>)}
            </select>
          </Field>
        </div>
        <button type="button" className="btn btn-outline" onClick={addItem}><IconPlus size={14} /> Add procedure to plan</button>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Session completion dialog — explicit performed / postponed choices  */
/* ------------------------------------------------------------------ */
function CompleteSessionDialog({ plan, session, onClose, onDone }) {
  const toast = useToast();
  const openItems = plan.items.filter((i) => i.session_id === session.id && !['completed', 'cancelled'].includes(i.status));
  const [choices, setChoices] = useState({}); // itemId -> 'performed' | 'postponed' | undefined
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    const performed = Object.entries(choices).filter(([, v]) => v === 'performed').map(([k]) => Number(k));
    const postponed = Object.entries(choices).filter(([, v]) => v === 'postponed').map(([k]) => Number(k));
    if (!performed.length && !postponed.length) { setError(lang === 'ar' ? 'علّم إجراءً واحداً على الأقل كمنفذ أو مؤجل.' : 'Mark at least one procedure as performed or postponed.'); return; }
    setBusy(true);
    setError('');
    try {
      const res = await api(`/plans/${plan.id}/sessions/${session.id}/complete`, {
        method: 'POST', body: { performed, postponed, note: note.trim() || undefined },
      });
      toast.success(`Session “${session.title}” completed.`);
      onDone(res.plan);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  return (
    <Modal title={`Complete “${session.title}”`} onClose={onClose} footer={
      <>
        <button className="btn btn-outline" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn btn-primary" onClick={submit} disabled={busy}>{busy ? (lang === 'ar' ? 'جارٍ الحفظ…' : 'Saving…') : (lang === 'ar' ? 'تأكيد الإكمال' : 'Confirm completion')}</button>
      </>
    }>
      {error && <div className="form-error" role="alert">{error}</div>}
      <p className="muted small">
        Only explicitly confirmed procedures are recorded as performed. Tooth procedures also require the completed
        dental-chart treatment; cancelled or postponed items never change the chart.
      </p>
      {openItems.length === 0 && <EmptyState icon="✓" title="Nothing open in this session" />}
      {openItems.map((it) => (
        <div key={it.id} className="dash-list-item" style={{ alignItems: 'flex-start' }}>
          <span className="who" style={{ minWidth: 0 }}>
            <b>{it.procedure_label || it.service_name}</b>
            <span>{it.tooth_number ? `Tooth ${it.tooth_number}${it.surfaces ? ` · ${it.surfaces}` : ''} · ` : ''}{money(it.price_cents)} · {ITEM_LABEL(lang)[it.status]}</span>
          </span>
          <span className="flex" style={{ gap: 6 }} role="radiogroup" aria-label={`Outcome for ${it.procedure_label}`}>
            <button type="button" role="radio" aria-checked={choices[it.id] === 'performed'}
              className={`btn btn-sm ${choices[it.id] === 'performed' ? 'btn-primary' : 'btn-outline'}`}
              onClick={() => setChoices((c) => ({ ...c, [it.id]: c[it.id] === 'performed' ? undefined : 'performed' }))}>Performed</button>
            <button type="button" role="radio" aria-checked={choices[it.id] === 'postponed'}
              className={`btn btn-sm ${choices[it.id] === 'postponed' ? 'btn-danger-outline' : 'btn-outline'}`}
              onClick={() => setChoices((c) => ({ ...c, [it.id]: c[it.id] === 'postponed' ? undefined : 'postponed' }))}>Postpone</button>
          </span>
        </div>
      ))}
      <Field label="Session note (optional)"><textarea className="textarea" rows={2} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} /></Field>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* One plan item row (used inside sessions and the unassigned list)    */
/* ------------------------------------------------------------------ */
function ItemRow({ it, plan, canClinical, busyAction, moveItem, onChanged }) {
  const qty = Number(it.quantity) || 1;
  const editableNow = canClinical && !['completed', 'cancelled'].includes(it.status) && ['draft', 'pending_approval', 'approved', 'in_progress'].includes(plan.status);
  async function put(body) {
    try {
      const res = await api(`/plans/${plan.id}/items/${it.id}`, { method: 'PUT', body });
      onChanged(res.plan);
    } catch (e) { /* surfaced by caller toast if needed */ }
  }
  return (
    <div className="dash-list-item" style={{ alignItems: 'flex-start' }} draggable={editableNow}
      onDragStart={(e) => e.dataTransfer.setData('text/plain', String(it.id))}>
      <span className="who" style={{ minWidth: 0, flex: 1 }}>
        <b>{it.procedure_label || it.service_name || '—'}</b>
        <span>
          {it.tooth_number ? `Tooth ${it.tooth_number}${it.surfaces ? ` · ${it.surfaces}` : ''} · ` : ''}
          {qty > 1 ? `${qty} × ` : ''}{money(it.price_cents)}{qty > 1 ? ` = ${money(lineCents(it))}` : ''} · {it.duration_min ? `${Number(it.duration_min) * qty} min` : '—'} · {ITEM_LABEL(lang)[it.status] || it.status}
        </span>
      </span>
      <span className="flex" style={{ gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <PriorityBadge p={it.priority} />
        {editableNow && qty > 1 && (
          <select className="select" style={{ width: 'auto', padding: '3px 6px', fontSize: 12 }} aria-label={`Quantity for ${it.procedure_label || 'item'}`}
            value={String(qty)} disabled={!!busyAction}
            onChange={(e) => put({ quantity: Number(e.target.value) })}>
            {Array.from({ length: Math.min(99, Math.max(qty, 10)) }, (_, i) => i + 1).map((n) => <option key={n} value={String(n)}>{n}×</option>)}
          </select>
        )}
        {editableNow && (
          <select className="select" style={{ width: 'auto', padding: '3px 6px', fontSize: 12 }} aria-label={`Priority for ${it.procedure_label || 'item'}`}
            value={it.priority || 'routine'} disabled={!!busyAction}
            onChange={(e) => put({ priority: e.target.value })}>
            {Object.entries(ITEM_PRIORITY_LABEL(lang)).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        )}
        {editableNow && (
          <select className="select" style={{ width: 'auto', padding: '3px 6px', fontSize: 12 }} aria-label={`Move ${it.procedure_label || 'item'} to session`}
            value={String(it.session_id || '')} disabled={busyAction === `move-${it.id}`}
            onChange={(e) => moveItem(it, e.target.value ? Number(e.target.value) : null)}>
            <option value="">Unassigned</option>
            {plan.sessions.filter((x) => x.status !== 'completed').map((x) => <option key={x.id} value={String(x.id)}>#{x.position} {x.title}</option>)}
          </select>
        )}
      </span>
    </div>
  );
}

/** Tooth-grouped rendering of an item list. */
function ToothGroups({ items, ...rowProps }) {
  return groupByTooth(items).map(([toothKey, its]) => (
    <div key={toothKey}>
      <div className="muted small" style={{ fontWeight: 700, letterSpacing: '.02em', margin: '6px 0 2px' }}>
        {toothKey === '__general__' ? lang === 'ar' ? 'الفم بالكامل / عام' : 'Full mouth / general' : lang === 'ar' ? `سن ${toothKey}` : `Tooth ${toothKey}`}
        <span style={{ fontWeight: 400 }}> · {its.length} procedure(s){its.length > 1 ? ` · ${money(its.reduce((a, x) => a + lineCents(x), 0))}` : ''}</span>
      </div>
      {its.map((it) => <ItemRow key={it.id} it={it} {...rowProps} />)}
    </div>
  ));
}

/* ------------------------------------------------------------------ */
/* Session detail dialog — everything recorded for one treatment session */
/* ------------------------------------------------------------------ */
function SessionDetailDialog({ plan, session, onClose }) {
  const sItems = plan.items.filter((i) => i.session_id === session.id);
  return (
    <Modal title={`Session #${session.position} · ${session.title}`} onClose={onClose}
      footer={<button className="btn btn-outline" onClick={onClose}>Close</button>}>
      <div className="flex" style={{ gap: 8, alignItems: 'center', marginBottom: 10 }}>
        <StatusPill map={SESSION_LABEL(lang)} status={session.status} />
        <span className="muted small">
          {session.item_count} procedure(s) · {session.completed_items} completed · {money(session.subtotal_cents)} · est. {session.estimated_min} min
        </span>
      </div>
      {session.appointment_id
        ? <div className="muted small mb-12">Linked appointment #{session.appointment_id} — open the Calendar for slot details.</div>
        : <div className="muted small mb-12">No appointment linked yet.</div>}
      {sItems.length === 0 ? <EmptyState icon="🗓" title="No procedures in this session" /> : (
        <div>
          {sItems.map((it) => (
            <div key={it.id} className="dash-list-item" style={{ alignItems: 'flex-start' }}>
              <span className="who" style={{ minWidth: 0 }}>
                <b>{it.procedure_label || it.service_name || '—'}</b>
                <span>
                  {it.tooth_number ? `Tooth ${it.tooth_number}${it.surfaces ? ` · ${it.surfaces}` : ''} · ` : ''}
                  {(Number(it.quantity) || 1) > 1 ? `${it.quantity} × ${money(it.price_cents)} = ${money(lineCents(it))}` : money(it.price_cents)} · {ITEM_LABEL(lang)[it.status] || it.status}
                </span>
              </span>
              <PriorityBadge p={it.priority} />
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* One plan card                                                       */
/* ------------------------------------------------------------------ */
function PlanCard({ plan, focus, onReplace, onChanged }) {
  const { user } = useAuth();
  const { lang } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const [open, setOpen] = useState(Boolean(focus));
  const [addingItem, setAddingItem] = useState(false);
  const [completing, setCompleting] = useState(null); // session
  const [scheduling, setScheduling] = useState(null); // session
  const [sessionDetail, setSessionDetail] = useState(null); // session (read-only details)
  const [busyAction, setBusyAction] = useState('');
  const canClinical = ['owner', 'doctor'].includes(user?.role);
  const editable = ['draft', 'pending_approval', 'approved', 'in_progress'].includes(plan.status);

  async function act(path, method = 'POST', body, okMsg) {
    setBusyAction(path);
    try {
      const res = await api(path, { method, body });
      toast.success(okMsg || lang === 'ar' ? 'تم تحديث الخطة.' : 'Plan updated.');
      if (res?.plan) onReplace(res.plan);
      invalidateTimelines();
      onChanged?.();
    } catch (e) { toast.error(e.message); } finally { setBusyAction(''); }
  }

  async function cancelPlan() {
    const reason = await promptReason(lang === 'ar' ? 'إلغاء خطة العلاج' : 'Cancel treatment plan', `Why is “${plan.title}” being cancelled? (kept in the plan history)`);
    if (!reason) return;
    act(`/plans/${plan.id}/cancel`, 'POST', { reason }, lang === 'ar' ? 'تم إلغاء الخطة.' : 'Plan cancelled.');
  }
  function promptReason(title, msg) {
    return new Promise((resolve) => {
      const v = window.prompt(`${title}\n${msg}`); // simple, non-destructive input
      resolve(v && v.trim() ? v.trim() : null);
    });
  }

  async function moveItem(item, sessionId) {
    setBusyAction(`move-${item.id}`);
    try {
      const res = await api(`/plans/${plan.id}/items/${item.id}`, { method: 'PUT', body: { session_id: sessionId } });
      toast.success(lang === 'ar' ? 'تم نقل الإجراء.' : 'Procedure moved.');
      onReplace(res.plan);
    } catch (e) { toast.error(e.message); } finally { setBusyAction(''); }
  }

  async function reorderSession(session, dir) {
    const target = plan.sessions.find((s) => s.position === session.position + dir);
    if (!target) return;
    setBusyAction(`reorder-${session.id}`);
    try {
      const r1 = await api(`/plans/${plan.id}/sessions/${session.id}`, { method: 'PUT', body: { position: target.position } });
      await api(`/plans/${plan.id}/sessions/${target.id}`, { method: 'PUT', body: { position: session.position } });
      const res = await api(`/plans/${plan.id}`);
      toast.success(lang === 'ar' ? 'تم تحديث ترتيب الجلسات.' : 'Session order updated.');
      onReplace(res.plan || r1.plan);
    } catch (e) { toast.error(e.message); } finally { setBusyAction(''); }
  }

  const unassigned = plan.items.filter((i) => !i.session_id && !['cancelled'].includes(i.status));

  return (
    <div className="card mb-12" id={`plan-${plan.id}`}>
      <button type="button" className="card-pad flex-between" style={{ width: '100%', background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'start' }}
        aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span style={{ minWidth: 0 }}>
          <b style={{ fontSize: 14 }}>{plan.title}</b>{' '}
          <StatusPill map={PLAN_STATUS_LABEL} status={plan.status} />{' '}
          {plan.revision_of ? <span className="badge" style={{ background: "#f1f5f9", color: "#475569", borderColor: "#dbe2ea" }}>rev of #{plan.revision_of}</span> : null}
          <div className="muted small" style={{ marginTop: 3 }}>
            {plan.responsible_doctor_name || lang === 'ar' ? 'غير مُسنَد' : 'Unassigned'} · {plan.progress.completed_items}/{plan.progress.total_items} procedures ·{' '}
            {money(plan.estimated_total_cents)}{plan.discount_cents ? ` (−${money(plan.discount_cents)} discount)` : ''} · est. {plan.estimated_min} min
          </div>
          <div className="progress" role="progressbar" aria-valuenow={plan.progress.percent} aria-valuemin={0} aria-valuemax={100} aria-label="Plan progress" style={{ marginTop: 6 }}>
            <span style={{ width: `${plan.progress.percent}%` }} />
          </div>
        </span>
        <span className="muted">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="card-pad" style={{ borderTop: '1px solid var(--line)', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {plan.notes && <div className="muted small">{plan.notes}</div>}

          {canClinical && (
            <div className="flex" style={{ gap: 8, flexWrap: 'wrap' }}>
              {plan.status === 'draft' && (
                <>
                  <button className="btn btn-outline btn-sm" disabled={!!busyAction} onClick={() => act(`/plans/${plan.id}/submit`, 'POST', undefined, lang === 'ar' ? 'تم تقديم الخطة للاعتماد.' : 'Plan submitted for approval.')}>Submit for approval</button>
                  <button className="btn btn-primary btn-sm" disabled={!!busyAction} onClick={async () => {
                    const ok = await confirm({ title: lang === 'ar' ? 'اعتماد خطة العلاج' : 'Approve treatment plan', message: `Approve “${plan.title}” (estimate ${money(plan.estimated_total_cents)})? Approved plans can be scheduled and performed.`, confirmLabel: lang === 'ar' ? 'اعتماد الخطة' : 'Approve plan' });
                    if (ok) act(`/plans/${plan.id}/approve`, 'POST', undefined, lang === 'ar' ? 'تم اعتماد الخطة.' : 'Plan approved.');
                  }}>Approve</button>
                </>
              )}
              {plan.status === 'pending_approval' && (
                <button className="btn btn-primary btn-sm" disabled={!!busyAction} onClick={async () => {
                  const ok = await confirm({ title: lang === 'ar' ? 'اعتماد خطة العلاج' : 'Approve treatment plan', message: `Approve “${plan.title}” (estimate ${money(plan.estimated_total_cents)})? Approved plans can be scheduled and performed.`, confirmLabel: lang === 'ar' ? 'اعتماد الخطة' : 'Approve plan' });
                  if (ok) act(`/plans/${plan.id}/approve`, 'POST', undefined, lang === 'ar' ? 'تم اعتماد الخطة.' : 'Plan approved.');
                }}>Approve plan</button>
              )}
              {editable && <button className="btn btn-outline btn-sm" onClick={() => setAddingItem(true)}><IconPlus size={13} /> Add procedure</button>}
              {editable && <button className="btn btn-outline btn-sm" disabled={!!busyAction}
                onClick={() => act(`/plans/${plan.id}/sessions`, 'POST', { title: `Session ${plan.sessions.length + 1}` }, lang === 'ar' ? 'تمت إضافة الجلسة.' : 'Session added.')}>
                <IconPlus size={13} /> Split into new session
              </button>}
              {['approved', 'completed', 'cancelled'].includes(plan.status) && plan.status !== 'cancelled' && (
                <button className="btn btn-outline btn-sm" disabled={!!busyAction} onClick={() => act(`/plans/${plan.id}/revision`, 'POST', undefined, lang === 'ar' ? 'تم إنشاء مسودة مراجعة.' : 'Revision draft created.')}>Create revision</button>
              )}
              {!['completed', 'cancelled'].includes(plan.status) && (
                <button className="btn btn-danger-outline btn-sm" disabled={busyAction === 'cancel'} onClick={cancelPlan}>Cancel plan</button>
              )}
            </div>
          )}

          {/* sessions */}
          <div>
            <div className="card-title">Sessions</div>
            {plan.sessions.length === 0 && <div className="muted small">No sessions — this is a single-visit plan.</div>}
            {plan.sessions.map((s) => {
              const sItems = plan.items.filter((i) => i.session_id === s.id && i.status !== 'cancelled');
              return (
                <div key={s.id} className="session-box mb-12" onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => { const id = Number(e.dataTransfer.getData('text/plain')); const it = plan.items.find((x) => x.id === id); if (it && it.session_id !== s.id && !['completed', 'cancelled'].includes(it.status)) moveItem(it, s.id); }}>
                  <div className="flex-between" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <span role="button" tabIndex={0} className="row-link" style={{ minWidth: 0 }}
                      onClick={() => setSessionDetail(s)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSessionDetail(s); } }}>
                      <b>#{s.position} {s.title}</b> <StatusPill map={SESSION_LABEL(lang)} status={s.status} />
                      <div className="muted small">{s.item_count} procedure(s) · {s.completed_items} completed · {money(s.subtotal_cents)} · est. {s.estimated_min} min{s.appointment_id ? ` · appointment #${s.appointment_id} linked` : ''} · <u>details ▸</u></div>
                    </span>
                    {canClinical && (
                      <span className="flex" style={{ gap: 6, flexWrap: 'wrap' }}>
                        <button className="icon-btn" aria-label="Move session earlier" disabled={s.status === 'completed' || !!busyAction} onClick={() => reorderSession(s, -1)}>↑</button>
                        <button className="icon-btn" aria-label="Move session later" disabled={s.status === 'completed' || !!busyAction} onClick={() => reorderSession(s, 1)}>↓</button>
                        {['planned'].includes(s.status) && !s.appointment_id && (
                          <button className="btn btn-primary btn-sm" onClick={() => setScheduling(s)}>Schedule appointment</button>
                        )}
                        {s.appointment_id && ['scheduled', 'in_progress'].includes(s.status) && (
                          <span className="badge" style={{ background: "#f2f8e5", color: "#42650b", borderColor: "#d5e8b2" }}>Linked to booking</span>
                        )}
                        {['scheduled', 'in_progress', 'planned'].includes(s.status) && sItems.some((i) => !['completed', 'cancelled'].includes(i.status)) && (
                          <button className="btn btn-outline btn-sm" onClick={() => setCompleting(s)}>Complete session</button>
                        )}
                      </span>
                    )}
                  </div>
                  {sItems.length > 0 && <ToothGroups items={sItems} plan={plan} canClinical={canClinical} busyAction={busyAction} moveItem={moveItem} onChanged={onReplace} />}
                  {sItems.length === 0 && <div className="muted small">Empty session — drag procedures here or use the session selector.</div>}
                </div>
              );
            })}
            {unassigned.length > 0 && (
              <div className="session-box">
                <b>Unassigned procedures</b>
                <div className="muted small mb-8">Assign to a session (drag &amp; drop or the selector) or keep as single-visit work.</div>
                <ToothGroups items={unassigned} plan={plan} canClinical={canClinical} busyAction={busyAction} moveItem={moveItem} onChanged={onReplace} />
              </div>
            )}
          </div>

          <div className="flex-between muted small">
            <span>Estimate total: <b className="mono">{money(plan.estimated_gross_cents)}</b>{plan.discount_cents ? <> − discount <b className="mono">{money(plan.discount_cents)}</b> = <b className="mono">{money(plan.estimated_total_cents)}</b></> : null}</span>
            <span>Plan totals are estimates — invoices are raised separately from performed work.</span>
          </div>
        </div>
      )}

      {addingItem && <AddItemDialog plan={plan} onClose={() => setAddingItem(false)} onDone={(p2) => { setAddingItem(false); onReplace(p2); }} />}
      {sessionDetail && <SessionDetailDialog plan={plan} session={sessionDetail} onClose={() => setSessionDetail(null)} />}
      {completing && <CompleteSessionDialog plan={plan} session={completing} onClose={() => setCompleting(null)} onDone={(p2) => { setCompleting(null); onReplace(p2); onChanged?.(); }} />}
      {scheduling && (
        <AppointmentModal
          mode="create"
          initial={{
            patient: { id: plan.patient_id },
            doctor_id: plan.responsible_doctor_id || undefined,
            appointment_type: 'procedure',
            treatment_session_id: scheduling.id,
            session_title: scheduling.title,
            plan_title: plan.title,
            plan_id: plan.id,
          }}
          onClose={() => setScheduling(null)}
          onSaved={() => { setScheduling(null); refreshOne(plan.id, onReplace); onChanged?.(); }}
        />
      )}
    </div>
  );
}

function refreshOne(planId, onReplace) {
  api(`/plans/${planId}`).then((r) => onReplace(r.plan)).catch(() => {});
}

/* add a single procedure to an existing plan */
function AddItemDialog({ plan, onClose, onDone }) {
  const { services } = useClinicMeta();
  const toast = useToast();
  const [f, setF] = useState({ service_id: '', tooth_number: '', surfaces: [], procedure_label: '', duration_min: '', price_cents: '', quantity: '1', priority: 'routine', session_id: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit() {
    setBusy(true); setError('');
    try {
      const res = await api(`/plans/${plan.id}/items`, {
        method: 'POST',
        body: {
          service_id: f.service_id ? Number(f.service_id) : null,
          tooth_number: f.tooth_number ? Number(f.tooth_number) : null,
          surfaces: f.surfaces.join(''),
          procedure_label: f.procedure_label.trim(),
          duration_min: f.duration_min !== '' ? Number(f.duration_min) : undefined,
          price_cents: f.price_cents !== '' ? Number(f.price_cents) : undefined,
          quantity: Math.max(1, Math.min(99, Number(f.quantity) || 1)),
          priority: f.priority || 'routine',
          session_id: f.session_id ? Number(f.session_id) : undefined,
        },
      });
      toast.success(lang === 'ar' ? 'تمت إضافة الإجراء إلى الخطة.' : 'Procedure added to the plan.');
      onDone(res.plan);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  function onPickService(id) {
    const svc = services.find((s) => String(s.id) === id);
    setF((d) => ({ ...d, service_id: id, procedure_label: d.procedure_label || svc?.name || '', duration_min: svc?.duration_min ? String(svc.duration_min) : d.duration_min, price_cents: svc?.price_cents ? String(svc.price_cents) : d.price_cents }));
  }
  return (
    <Modal title={`Add procedure — ${plan.title}`} onClose={onClose} wide footer={
      <>
        <button className="btn btn-outline" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn btn-primary" onClick={submit} disabled={busy}>{busy ? (lang === 'ar' ? 'جارٍ الإضافة…' : 'Adding…') : (lang === 'ar' ? 'إضافة إجراء' : 'Add procedure')}</button>
      </>
    }>
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="form-row">
        <Field label="Service (catalog)">
          <select className="select" aria-label="Service catalog" value={f.service_id} onChange={(e) => onPickService(e.target.value)}>
            <option value="">— Custom procedure —</option>
            {services.map((s) => <option key={s.id} value={String(s.id)}>{s.name}{s.price_cents ? ` · ${money(s.price_cents)}` : ''}</option>)}
          </select>
        </Field>
        <Field label="Procedure label">
          <input className="input" value={f.procedure_label} maxLength={200} onChange={(e) => setF({ ...f, procedure_label: e.target.value })} />
        </Field>
        <Field label="Tooth (FDI)">
          <select className="select" aria-label="Tooth number" value={f.tooth_number} onChange={(e) => setF({ ...f, tooth_number: e.target.value })}>
            <option value="">— None —</option>
            {FDI.map((n) => <option key={n} value={String(n)}>{n}</option>)}
          </select>
        </Field>
      </div>
      <div className="form-row">
        <Field label="Surfaces">
          <div className="surface-chips" role="group" aria-label="Surfaces">
            {SURFACES.map((sf) => (
              <label key={sf} className={`surface-chip${f.surfaces.includes(sf) ? ' on' : ''}`}>
                <input type="checkbox" checked={f.surfaces.includes(sf)}
                  onChange={(e) => setF((d) => ({ ...d, surfaces: e.target.checked ? [...d.surfaces, sf] : d.surfaces.filter((x) => x !== sf) }))} />
                <b>{sf}</b>
              </label>
            ))}
          </div>
        </Field>
        <Field label="Duration (min)">
          <input className="input" type="number" min="5" max="480" value={f.duration_min} onChange={(e) => setF({ ...f, duration_min: e.target.value })} />
        </Field>
        <Field label="Price (cents)">
          <input className="input" type="number" min="0" value={f.price_cents} onChange={(e) => setF({ ...f, price_cents: e.target.value })} />
        </Field>
        <Field label="Quantity">
          <input className="input" type="number" min="1" max="99" value={f.quantity} onChange={(e) => setF({ ...f, quantity: e.target.value })} />
        </Field>
        <Field label="Priority">
          <select className="select" aria-label="Item priority" value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>
            {Object.entries(ITEM_PRIORITY_LABEL(lang)).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </Field>
        <Field label="Session">
          <select className="select" aria-label="Session assignment" value={f.session_id} onChange={(e) => setF({ ...f, session_id: e.target.value })}>
            <option value="">— Unassigned —</option>
            {plan.sessions.filter((s) => s.status !== 'completed').map((s) => <option key={s.id} value={String(s.id)}>#{s.position} {s.title}</option>)}
          </select>
        </Field>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Plans panel for a patient                                           */
/* ------------------------------------------------------------------ */
export default function TreatmentPlans({ patientId, focusPlanId, defaultAppointmentId, onChanged }) {
  const { user } = useAuth();
  const { lang } = useI18n();
  const [plans, setPlans] = useState(null);
  const [error, setError] = useState('');
  const [building, setBuilding] = useState(false);
  const canClinical = ['owner', 'doctor'].includes(user?.role);

  const listKey = `/plans?patient_id=${patientId}&limit=50`;
  const load = useCallback(async (force = false) => {
    try {
      // cachedGet: StrictMode double-mount and tab revisits share one request;
      // a fresh cache hit renders instantly with zero network.
      const r = (await cachedGet(listKey, { force })).data;
      setPlans(r.plans || r.items || []);
      setError('');
    } catch (e) { setError(e.message); }
  }, [listKey]);
  useEffect(() => { load(); }, [load]);

  // After a mutation the server returns the updated plan — write it straight
  // into the cache so any other view of this list starts fresh, not stale.
  const replace = (p) => setPlans((xs) => {
    const next = (xs || []).map((x) => (x.id === p.id ? p : x));
    prime(listKey, { plans: next });
    return next;
  });

  if (error && !plans) {
    return (
      <div>
        <div className="form-error" role="alert">{error}</div>
        <button className="btn btn-outline mt-12" onClick={() => load(true)}>Retry</button>
      </div>
    );
  }
  if (!plans) return <Spinner label="Loading treatment plans…" />;

  return (
    <div>
      <div className="flex-between mb-12">
        <div className="muted small">Plan totals are estimates. Invoicing is always separate and based on performed work.</div>
        {canClinical && <button className="btn btn-primary" onClick={() => setBuilding(true)}><IconPlus size={15} /> New plan</button>}
      </div>
      {plans.length === 0 && <EmptyState icon="🗂" title="No treatment plans yet">{canClinical ? lang === 'ar' ? 'أنشئ أول خطة من كتالوج الخدمات.' : 'Create the first plan from the service catalog.' : ''}</EmptyState>}
      {plans.map((p) => (
        <PlanCard key={p.id} plan={p} focus={focusPlanId ? Number(focusPlanId) === p.id : p.status !== 'completed' && p.status !== 'cancelled'}
          onReplace={replace} onChanged={load} />
      ))}
      {building && <PlanBuilder patientId={patientId} defaultAppointmentId={defaultAppointmentId} onClose={() => setBuilding(false)} onCreated={(p) => { setBuilding(false); setPlans((xs) => { const next = [p, ...(xs || [])]; prime(listKey, { plans: next }); return next; }); onChanged?.(); }} />}
    </div>
  );
}
