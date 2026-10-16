import React, { useCallback, useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../api.js';
import { invalidate, invalidateTimelines } from '../apiCache.js';
import { useAuth, useClinicMeta } from '../auth.jsx';
import { useI18n } from '../i18n.jsx';
import { Spinner, Modal, Field, useToast, Breadcrumb } from '../components/ui.jsx';
import { InvoiceStatusBadge } from './Invoices.jsx';
import { money, fmtDate, fmtTime } from '../format.js';
import { IconPrint, IconPlus } from '../components/icons.jsx';

function PaymentModal({ invoice, onClose, onSaved }) {
  const toast = useToast();
  const { lang } = useI18n();
  const [f, setF] = useState({ amount: (invoice.balance_cents / 100).toFixed(2), method: 'cash', reference: '', type: 'payment' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // one key per dialog instance: retries of the same submit are idempotent,
  // a genuinely new entry (dialog reopened) gets a fresh key.
  const [idempotencyKey] = useState(() => (window.crypto?.randomUUID ? window.crypto.randomUUID() : `pay-${Date.now()}-${Math.random().toString(36).slice(2)}`));
  const isCredit = f.type !== 'payment';
  const creditMax = Number(invoice.gross_paid_cents ?? 0) - Number(invoice.refunded_cents ?? 0);
  async function submit(e) {
    e?.preventDefault?.(); setBusy(true); setError('');
    try {
      const res = await api(`/invoices/${invoice.id}/payments`, { method: 'POST', body: { ...f, idempotency_key: idempotencyKey } });
      if (res?.idempotent) toast.info(lang === 'ar' ? 'تم التسجيل مسبقاً (تم تجاهل الإرسال المكرر).' : 'Already recorded (duplicate submit ignored).');
      else toast.success(f.type === 'payment' ? (lang === 'ar' ? 'تم تسجيل الدفع.' : 'Payment recorded.') : f.type === 'refund' ? (lang === 'ar' ? 'تم تسجيل الاسترداد.' : 'Refund recorded.') : (lang === 'ar' ? 'تم تسجيل التسوية.' : 'Adjustment recorded.'));
      onSaved();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  return (
    <Modal title={`${isCredit ? (lang === 'ar' ? 'تسجيل استرداد / تسوية' : 'Record refund / adjustment') : (lang === 'ar' ? 'تسجيل دفع' : 'Record payment')} — ${invoice.invoice_no}`} onClose={onClose}
      footer={<><button className="btn btn-outline" onClick={onClose}>{lang === 'ar' ? 'إلغاء' : 'Cancel'}</button>
        <button className="btn btn-primary" onClick={submit} disabled={busy}>{busy ? (lang === 'ar' ? 'جارٍ التسجيل…' : 'Recording…') : isCredit ? (lang === 'ar' ? 'تسجيل إدخال ائتماني' : 'Record credit entry') : (lang === 'ar' ? 'تسجيل دفع' : 'Record payment')}</button></>}>
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="muted small mb-12">
        {lang === 'ar' ? 'الرصيد المستحق:' : 'Outstanding balance:'} <b style={{ color: 'var(--ink)' }}>{money(invoice.balance_cents)}</b>
        {isCredit && <> · {lang === 'ar' ? 'قابل للاسترداد (صافي المدفوع):' : 'refundable (net paid):'} <b style={{ color: 'var(--ink)' }}>{money(Math.max(0, creditMax))}</b></>}
      </div>
      <div className="form-row">
        <Field label={lang === 'ar' ? 'نوع الإدخال' : 'Entry type'}>
          <select className="select" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
            <option value="payment">{lang === 'ar' ? 'دفع (أموال واردة)' : 'Payment (money in)'}</option>
            <option value="refund">{lang === 'ar' ? 'استرداد (أموال مرتجعة)' : 'Refund (money back)'}</option>
            <option value="adjustment">{lang === 'ar' ? 'تسوية (تصحيح)' : 'Adjustment (correction)'}</option>
          </select>
        </Field>
        <Field label={isCredit ? (lang === 'ar' ? 'مبلغ الائتمان' : 'Credit amount') : (lang === 'ar' ? 'المبلغ' : 'Amount')} required>
          <input className="input" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} required pattern="^\d+(\.\d{1,2})?$" inputMode="decimal" />
        </Field>
        <Field label={lang === 'ar' ? 'الطريقة' : 'Method'}>
          <select className="select" value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>
            <option value="cash">{lang === 'ar' ? 'نقداً' : 'Cash'}</option><option value="card">{lang === 'ar' ? 'بطاقة' : 'Card'}</option>
            <option value="bank_transfer">{lang === 'ar' ? 'تحويل بنكي' : 'Bank transfer'}</option><option value="insurance">{lang === 'ar' ? 'تأمين' : 'Insurance'}</option><option value="other">{lang === 'ar' ? 'أخرى' : 'Other'}</option>
          </select>
        </Field>
      </div>
      <Field label={isCredit ? (lang === 'ar' ? 'السبب / المرجع (مطلوب بموجب سياسة التدقيق)' : 'Reason / reference (required by audit policy)') : (lang === 'ar' ? 'المرجع (اختياري)' : 'Reference (optional)')}>
        <input className="input" value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} maxLength={120} required={isCredit} />
      </Field>
      <div className="field-hint mt-8">{lang === 'ar' ? 'الائتمانات لا تؤثر على السجلات السريرية — تؤثر فقط على رصيد الفاتورة. كل إدخال مُدقَّق مع المستخدم والطابع الزمني.' : 'Credits never touch clinical records — they only affect the invoice balance. Every entry is audited with user and timestamp.'}</div>
    </Modal>
  );
}

export default function InvoiceDetail() {
  const { user } = useAuth();
  const { id } = useParams();
  const { clinic } = useClinicMeta();
  const [inv, setInv] = useState(null);
  const [error, setError] = useState('');
  const [showPay, setShowPay] = useState(false);
  const toast = useToast();
  const { lang } = useI18n();

  const load = useCallback(async () => {
    try { setInv((await api(`/invoices/${id}`)).invoice); setError(''); }
    catch (e) { setError(e.message); }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  if (error) return <div className="page"><div className="form-error">{error}</div><Link to="/invoices">{lang === 'ar' ? '← العودة إلى الفوترة' : '← Back to billing'}</Link></div>;
  if (!inv) return <div className="page"><Spinner label={lang === 'ar' ? 'جارٍ تحميل الفاتورة…' : 'Loading invoice…'} /></div>;

  return (
    <div className="page">
      <Breadcrumb items={[{ label: lang === 'ar' ? 'الفوترة' : 'Invoices', to: '/invoices' }, { label: inv.invoice_no }]} />
      <div className="page-head">
        <div>
          <h1>{lang === 'ar' ? 'فاتورة' : 'Invoice'} {inv.invoice_no} <InvoiceStatusBadge status={inv.status} /></h1>
          <div className="desc">{lang === 'ar' ? 'أُصدرت' : 'Issued'} {inv.issue_date}{inv.due_date ? (lang === 'ar' ? ` · مستحقة ${inv.due_date}` : ` · due ${inv.due_date}`) : ''}</div>
        </div>
        <div className="flex">
          <button className="btn btn-outline" onClick={() => window.print()}><IconPrint size={16}/> {lang === 'ar' ? 'طباعة' : 'Print'}</button>
          {inv.balance_cents > 0 && ['owner', 'accountant'].includes(user?.role) && (
            <button className="btn btn-primary" onClick={() => setShowPay(true)}><IconPlus size={16}/> {lang === 'ar' ? 'تسجيل دفع' : 'Record payment'}</button>
          )}
        </div>
      </div>

      <div className="grid-2">
        <div className="card card-pad">
          <div className="card-title">{lang === 'ar' ? 'بنود الفاتورة' : 'Line items'}</div>
          <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>{lang === 'ar' ? 'الوصف' : 'Description'}</th><th className="num">{lang === 'ar' ? 'الكمية' : 'Qty'}</th><th className="num hide-sm">{lang === 'ar' ? 'الوحدة' : 'Unit'}</th><th className="num">{lang === 'ar' ? 'المبلغ' : 'Amount'}</th></tr></thead>
            <tbody>
              {inv.items.map((it) => (
                <tr key={it.id}>
                  <td>{it.description}</td>
                  <td className="num">{it.quantity}</td>
                  <td className="num mono">{money(it.unit_price_cents)}</td>
                  <td className="num mono">{money(it.amount_cents)}</td>
                </tr>
              ))}
              <tr><td colSpan={3} style={{ textAlign: 'right' }}><b>{lang === 'ar' ? 'المجموع الفرعي' : 'Subtotal'}</b></td><td className="num mono"><b>{money(inv.subtotal_cents)}</b></td></tr>
              <tr><td colSpan={3} style={{ textAlign: 'right' }}><b>{lang === 'ar' ? 'المجموع' : 'Total'}</b></td><td className="num mono"><b>{money(inv.total_cents)}</b></td></tr>
              {Number(inv.gross_paid_cents || 0) !== Number(inv.paid_cents || 0) && (
                <>
                  <tr><td colSpan={3} style={{ textAlign: 'right' }}>{lang === 'ar' ? 'إجمالي المدفوع' : 'Gross paid'}</td><td className="num mono">{money(inv.gross_paid_cents)}</td></tr>
                  <tr><td colSpan={3} style={{ textAlign: 'right' }}>{lang === 'ar' ? 'المسترَد / المسوّى' : 'Refunded / adjusted'}</td><td className="num mono" style={{ color: 'var(--danger)' }}>−{money(inv.refunded_cents)}</td></tr>
                </>
              )}
              <tr><td colSpan={3} style={{ textAlign: 'right' }}>{lang === 'ar' ? 'المدفوع (صافي)' : 'Paid (net)'}</td><td className="num mono" style={{ color: 'var(--ok)' }}>{money(inv.paid_cents)}</td></tr>
              <tr><td colSpan={3} style={{ textAlign: 'right' }}><b>{lang === 'ar' ? 'الرصيد المستحق' : 'Balance due'}</b></td>
                <td className="num mono" style={{ color: inv.balance_cents ? 'var(--danger)' : 'var(--ok)' }}><b>{money(inv.balance_cents)}</b></td></tr>
            </tbody>
          </table>
          </div>
          {inv.notes && <><div className="divider" /><div className="small muted">{inv.notes}</div></>}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="card card-pad">
            <div className="card-title">{lang === 'ar' ? 'مفوترة إلى' : 'Billed to'}</div>
            <Link to={`/patients/${inv.patient_id}`}><b>{inv.patient_name}</b></Link>
            <div className="muted small">{inv.patient_mrn}</div>
            {inv.created_by_name && <div className="muted small mt-12">{lang === 'ar' ? 'أنشأها' : 'Created by'} {inv.created_by_name}</div>}
          </div>
          <div className="card card-pad">
            <div className="card-title">{lang === 'ar' ? 'المدفوعات' : 'Payments'} ({inv.payments.length})</div>
            {inv.payments.length === 0 ? <div className="muted small">{lang === 'ar' ? 'لم يتم تسجيل مدفوعات بعد.' : 'No payments recorded yet.'}</div> : (
              inv.payments.map((p) => (
                <div key={p.id} className="dash-list-item">
                  <span className="dash-time" style={{ width: 100 }}>{fmtDate(p.paid_at, { year: undefined, month: 'short', day: 'numeric' })}</span>
                  <span className="who">
                    <b>{p.type && p.type !== 'payment' ? '−' : ''}{money(p.amount_cents)}</b>
                    <span>
                      {p.type === 'refund' ? (lang === 'ar' ? 'استرداد' : 'Refund') : p.type === 'adjustment' ? (lang === 'ar' ? 'تسوية' : 'Adjustment') : (lang === 'ar' ? 'دفع' : 'Payment')}
                      {p.method ? ` · ${String(p.method).replace('_', ' ')}` : ''}
                      {p.reference ? ` · ${p.reference}` : ''}{p.received_by_name ? ` · by ${p.received_by_name}` : ''}
                    </span>
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Printable document */}
      <div className="print-area">
        <div className="invoice-doc">
          <div className="doc-head">
            <div>
              <h2>{clinic?.name}</h2>
              <div>{clinic?.address}</div>
              <div>{clinic?.phone} · {clinic?.email}</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <h2>{lang === 'ar' ? 'فاتورة' : 'INVOICE'}</h2>
              <div>{inv.invoice_no}</div>
              <div>{lang === 'ar' ? 'أُصدرت:' : 'Issued:'} {inv.issue_date}</div>
            </div>
          </div>
          <p><b>Billed to:</b> {inv.patient_name} ({inv.patient_mrn})</p>
          <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>Description</th><th>Qty</th><th className="hide-sm">Unit price</th><th style={{ textAlign: 'right' }}>Amount</th></tr></thead>
            <tbody>
              {inv.items.map((it) => (
                <tr key={it.id}><td>{it.description}</td><td>{it.quantity}</td><td>{money(it.unit_price_cents)}</td><td style={{ textAlign: 'right' }}>{money(it.amount_cents)}</td></tr>
              ))}
            </tbody>
          </table>
          </div>
          <p style={{ textAlign: 'right' }}>
            {lang === 'ar' ? 'المجموع:' : 'Total:'} <b>{money(inv.total_cents)}</b><br />
            {lang === 'ar' ? 'المدفوع:' : 'Paid:'} {money(inv.paid_cents)}<br />
            {lang === 'ar' ? 'الرصيد المستحق:' : 'Balance due:'} <b>{money(inv.balance_cents)}</b>
          </p>
          <p className="muted">{lang === 'ar' ? 'طُبع' : 'Printed'} {fmtDate(new Date())} {fmtTime(new Date())} — Clinic Portal</p>
        </div>
      </div>

      {showPay && <PaymentModal invoice={inv} onClose={() => setShowPay(false)} onSaved={() => { setShowPay(false); invalidate('/invoices'); invalidateTimelines(); load(); }} />}
    </div>
  );
}
