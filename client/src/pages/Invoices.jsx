import React, { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { cachedGet, invalidate } from '../apiCache.js';
import { useAuth, useClinicMeta } from '../auth.jsx';
import { useI18n } from '../i18n.jsx';
import { Spinner, EmptyState, Modal, Field, Pagination, useToast } from '../components/ui.jsx';
import { money } from '../format.js';
import { IconPlus } from '../components/icons.jsx';

const INV_BADGE = {
  paid: { bg: 'var(--ok-soft)', fg: 'var(--ok)', border: '#d5e8b2', label: 'Paid' },
  partial: { bg: 'var(--warn-soft)', fg: 'var(--warn)', border: '#fde4ad', label: 'Partially paid' },
  unpaid: { bg: '#f1f5f9', fg: '#475569', border: '#dbe2ea', label: 'Unpaid' },
};

export function InvoiceStatusBadge({ status }) {
  const { lang } = useI18n();
  const m = INV_BADGE[status] || INV_BADGE.unpaid;
  const label = lang === 'ar' ? ({ paid: 'مدفوع', partial: 'مدفوع جزئياً', unpaid: 'غير مدفوع' }[status] || m.label) : m.label;
  return <span className="badge" style={{ background: m.bg, color: m.fg, borderColor: m.border }}>{label}</span>;
}

export function InvoiceFormModal({ onClose, onSaved, presetPatientId, presetAppointmentId }) {
  const { services } = useClinicMeta();
  const toast = useToast();
  const { lang } = useI18n();
  const [patient, setPatient] = useState(null);
  const [search, setSearch] = useState('');
  const [results, setResults] = useState([]);
  const [items, setItems] = useState([{ service_id: '', description: '', quantity: 1, unit_price: '' }]);

  // Visit billing shortcut: when the modal is opened for a specific visit,
  // prefill the line items from the booked-services snapshot (server prices).
  const visitServicesLoaded = useRef(false);
  useEffect(() => {
    if (!presetAppointmentId || visitServicesLoaded.current) return;
    visitServicesLoaded.current = true;
    api(`/appointments/${presetAppointmentId}`)
      .then((r) => {
        const svcs = r.appointment && r.appointment.services;
        if (Array.isArray(svcs) && svcs.length) {
          setItems(svcs.map((sv) => ({
            service_id: sv.service_id, description: sv.name, quantity: 1,
            unit_price: (Number(sv.price_cents) / 100).toFixed(2),
          })));
        }
      })
      .catch(() => { /* visit gone: leave manual entry */ });
  }, [presetAppointmentId]);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (presetPatientId) api(`/patients/${presetPatientId}`).then((d) => setPatient(d.patient)).catch(() => {});
  }, [presetPatientId]);

  async function searchPatients(q) {
    setSearch(q);
    if (!q) return setResults([]);
    try { const res = await api(`/patients?search=${encodeURIComponent(q)}&limit=6`); setResults(res.items); }
    catch { setResults([]); }
  }

  const setItem = (i, k, v) => {
    const list = [...items];
    list[i] = { ...list[i], [k]: v };
    if (k === 'service_id') {
      const svc = services.find((s) => String(s.id) === v);
      if (svc) { list[i].description = svc.name; list[i].unit_price = (svc.price_cents / 100).toFixed(2); }
    }
    setItems(list);
  };

  const total = items.reduce((s, it) => {
    const q = Math.max(1, parseInt(it.quantity, 10) || 1);
    const p = parseFloat(it.unit_price || '0');
    return s + (Number.isFinite(p) ? q * p : 0);
  }, 0);

  async function submit(e) {
    e.preventDefault(); setError('');
    if (!patient) { setError(lang === 'ar' ? 'اختر مريضاً.' : 'Select a patient.'); return; }
    setBusy(true);
    try {
      const body = {
        patient_id: patient.id, notes: notes || null,
        appointment_id: presetAppointmentId ? Number(presetAppointmentId) : undefined,
        items: items.map((it) => ({
          service_id: it.service_id ? Number(it.service_id) : null,
          description: it.description || null,
          quantity: Math.max(1, parseInt(it.quantity, 10) || 1),
          unit_price: it.unit_price === '' ? undefined : it.unit_price,
        })),
      };
      const res = await api('/invoices', { method: 'POST', body });
      toast.success(lang === 'ar' ? `تم إنشاء الفاتورة ${res.invoice.invoice_no}.` : `Invoice ${res.invoice.invoice_no} created.`);
      onSaved(res.invoice);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  return (
    <Modal title={lang === 'ar' ? 'فاتورة جديدة' : 'New invoice'} onClose={onClose} wide
      footer={<>
        <span className="muted small" style={{ marginRight: 'auto' }}>{lang === 'ar' ? 'المجموع:' : 'Total:'} <b className="mono" style={{ color: 'var(--ink)' }}>{money(Math.round(total * 100))}</b></span>
        <button className="btn btn-outline" onClick={onClose}>{lang === 'ar' ? 'إلغاء' : 'Cancel'}</button>
        <button className="btn btn-primary" onClick={submit} disabled={busy}>{busy ? (lang === 'ar' ? 'جارٍ الإنشاء…' : 'Creating…') : (lang === 'ar' ? 'إنشاء فاتورة' : 'Create invoice')}</button>
      </>}>
      {error && <div className="form-error">{error}</div>}
      <Field label={lang === 'ar' ? 'المريض' : 'Patient'} required>
        {patient ? (
          <div className="combo-selected">{patient.first_name} {patient.last_name} <span className="muted small">· {patient.mrn}</span></div>
        ) : (
          <div className="combo">
            <input className="input" placeholder={lang === 'ar' ? 'بحث عن مريض…' : 'Search patient…'} value={search} onChange={(e) => searchPatients(e.target.value)} />
            {results.length > 0 && (
              <div className="combo-list">
                {results.map((p) => (
                  <div key={p.id} className="combo-item" onClick={() => { setPatient(p); setResults([]); }}>
                    <span>{p.first_name} {p.last_name}</span><span className="sub">{p.mrn}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </Field>

      <div className="flex-between mb-12">
        <b style={{ fontSize: 13.5 }}>{lang === 'ar' ? 'بنود الفاتورة' : 'Line items'}</b>
        <button type="button" className="btn btn-outline btn-sm" onClick={() => setItems([...items, { service_id: '', description: '', quantity: 1, unit_price: '' }])}>
          <IconPlus size={14}/> {lang === 'ar' ? 'إضافة بند' : 'Add line'}
        </button>
      </div>
      {items.map((it, i) => (
        <div key={i} className="form-row inv-line-row">
          <Field label={i === 0 ? (lang === 'ar' ? 'الخدمة' : 'Service') : ''}>
            <select className="select" value={it.service_id} onChange={(e) => setItem(i, 'service_id', e.target.value)}>
              <option value="">{lang === 'ar' ? 'مخصص' : 'Custom'}</option>
              {services.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
          <Field label={i === 0 ? (lang === 'ar' ? 'الوصف' : 'Description') : ''}><input className="input" value={it.description} onChange={(e) => setItem(i, 'description', e.target.value)} maxLength={200} /></Field>
          <Field label={i === 0 ? (lang === 'ar' ? 'الكمية' : 'Qty') : ''}><input type="number" min="1" className="input" value={it.quantity} onChange={(e) => setItem(i, 'quantity', e.target.value)} /></Field>
          <Field label={i === 0 ? (lang === 'ar' ? 'سعر الوحدة' : 'Unit price') : ''}><input className="input" placeholder="0.00" value={it.unit_price} onChange={(e) => setItem(i, 'unit_price', e.target.value)} /></Field>
          <button type="button" className="btn btn-danger-outline btn-sm" style={{ marginBottom: 14 }}
            disabled={items.length === 1} onClick={() => setItems(items.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      <Field label={lang === 'ar' ? 'ملاحظات' : 'Notes'}><textarea className="textarea" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
    </Modal>
  );
}

export default function Invoices() {
  const { user } = useAuth();
  const { lang } = useI18n();
  const [invoices, setInvoices] = useState(null);
  const [meta, setMeta] = useState({ page: 1, pages: 1, total: 0 });
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [showNew, setShowNew] = useState(false);
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  // Visit workflow deep-link: /invoices?patient_id=&appointment_id=
  const prefillPatient = params.get('patient_id');
  const prefillAppt = params.get('appointment_id');
  useEffect(() => {
    if (prefillPatient || params.get('new') === '1') setShowNew(true);
  }, [prefillPatient, params]);

  async function load(page = 1, force = false) {
    setError('');
    try {
      const res = (await cachedGet(`/invoices?status=${status}&page=${page}&limit=15`, { force })).data;
      setInvoices(res.invoices);
      setMeta({ page: res.page, pages: res.pages, total: res.total });
    } catch (e) { setError(e.message); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [status]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{lang === 'ar' ? 'الفوترة' : 'Billing'}</h1>
          <div className="desc">{lang === 'ar' ? 'أنشئ فواتير للزيارات والخدمات، وسجّل المدفوعات، وتتبع الأرصدة المستحقة.' : 'Create invoices for visits and services, record payments, and track outstanding balances.'}</div>
        </div>
        {['owner', 'accountant', 'doctor'].includes(user?.role) && (
          <button className="btn btn-primary" onClick={() => setShowNew(true)}><IconPlus size={16}/> {lang === 'ar' ? 'فاتورة جديدة' : 'New invoice'}</button>
        )}
      </div>

      <div className="card">
        <div className="flex" style={{ padding: '14px 16px', borderBottom: '1px solid var(--line)' }}>
          {[['', lang === 'ar' ? 'الكل' : 'All'], ['unpaid', lang === 'ar' ? 'غير مدفوع' : 'Unpaid'], ['partial', lang === 'ar' ? 'جزئي' : 'Partial'], ['paid', lang === 'ar' ? 'مدفوع' : 'Paid']].map(([v, l]) => (
            <button key={v} className={`btn btn-sm ${status === v ? 'btn-navy' : 'btn-outline'}`} onClick={() => setStatus(v)}>{l}</button>
          ))}
        </div>
        {error && <div className="form-error" style={{ margin: 14 }}>{error}</div>}
        {!error && (!invoices ? <Spinner label={lang === 'ar' ? 'جارٍ تحميل الفواتير…' : 'Loading invoices…'} /> : invoices.length === 0 ? (
          <EmptyState icon="🧾" title={lang === 'ar' ? 'لا توجد فواتير في هذا العرض' : 'No invoices in this view'}>{lang === 'ar' ? 'أنشئ فاتورة بعد زيارة مكتملة.' : 'Create an invoice after a completed visit.'}</EmptyState>
        ) : (
          <>
            <div className="table-wrap">
              <table className="tbl">
                <thead><tr><th>{lang === 'ar' ? 'الفاتورة' : 'Invoice'}</th><th>{lang === 'ar' ? 'المريض' : 'Patient'}</th><th>{lang === 'ar' ? 'تاريخ الإصدار' : 'Issued'}</th><th className="num">{lang === 'ar' ? 'المجموع' : 'Total'}</th><th className="num">{lang === 'ar' ? 'الرصيد' : 'Balance'}</th><th>{lang === 'ar' ? 'الحالة' : 'Status'}</th></tr></thead>
                <tbody>
                  {invoices.map((inv) => (
                    <tr key={inv.id} className="row-link" onClick={() => navigate(`/invoices/${inv.id}`)}>
                      <td className="mono"><b>{inv.invoice_no}</b></td>
                      <td>{inv.patient_name}</td>
                      <td>{inv.issue_date}</td>
                      <td className="num mono">{money(inv.total_cents, inv.currency)}</td>
                      <td className="num mono" style={{ color: inv.balance_cents ? 'var(--danger)' : 'var(--muted)' }}>{money(inv.balance_cents, inv.currency)}</td>
                      <td><InvoiceStatusBadge status={inv.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={meta.page} pages={meta.pages} total={meta.total} onPage={load} />
          </>
        ))}
      </div>

      {showNew && (
        <InvoiceFormModal
          presetPatientId={prefillPatient}
          presetAppointmentId={prefillAppt}
          onClose={() => { setShowNew(false); if (prefillPatient) setParams({}, { replace: true }); }}
          onSaved={(inv) => { setShowNew(false); setParams({}, { replace: true }); invalidate('/invoices'); navigate(`/invoices/${inv.id}`); }}
        />
      )}
    </div>
  );
}
