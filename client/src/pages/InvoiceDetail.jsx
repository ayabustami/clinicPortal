import React, { useCallback, useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../api.js';
import { invalidate, invalidateTimelines } from '../apiCache.js';
import { useAuth, useClinicMeta } from '../auth.jsx';
import { Spinner, Modal, Field, useToast } from '../components/ui.jsx';
import { InvoiceStatusBadge } from './Invoices.jsx';
import { money, fmtDate, fmtTime } from '../format.js';
import { IconPrint, IconPlus } from '../components/icons.jsx';

function PaymentModal({ invoice, onClose, onSaved }) {
  const toast = useToast();
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
      if (res?.idempotent) toast.info('Already recorded (duplicate submit ignored).');
      else toast.success(f.type === 'payment' ? 'Payment recorded.' : f.type === 'refund' ? 'Refund recorded.' : 'Adjustment recorded.');
      onSaved();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  return (
    <Modal title={`${isCredit ? 'Record refund / adjustment' : 'Record payment'} — ${invoice.invoice_no}`} onClose={onClose}
      footer={<><button className="btn btn-outline" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={submit} disabled={busy}>{busy ? 'Recording…' : isCredit ? 'Record credit entry' : 'Record payment'}</button></>}>
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="muted small mb-12">
        Outstanding balance: <b style={{ color: 'var(--ink)' }}>{money(invoice.balance_cents)}</b>
        {isCredit && <> · refundable (net paid): <b style={{ color: 'var(--ink)' }}>{money(Math.max(0, creditMax))}</b></>}
      </div>
      <div className="form-row">
        <Field label="Entry type">
          <select className="select" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
            <option value="payment">Payment (money in)</option>
            <option value="refund">Refund (money back)</option>
            <option value="adjustment">Adjustment (correction)</option>
          </select>
        </Field>
        <Field label={isCredit ? 'Credit amount' : 'Amount'} required>
          <input className="input" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} required pattern="^\d+(\.\d{1,2})?$" inputMode="decimal" />
        </Field>
        <Field label="Method">
          <select className="select" value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>
            <option value="cash">Cash</option><option value="card">Card</option>
            <option value="bank_transfer">Bank transfer</option><option value="insurance">Insurance</option><option value="other">Other</option>
          </select>
        </Field>
      </div>
      <Field label={isCredit ? 'Reason / reference (required by audit policy)' : 'Reference (optional)'}>
        <input className="input" value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} maxLength={120} required={isCredit} />
      </Field>
      <div className="field-hint mt-8">Credits never touch clinical records — they only affect the invoice balance. Every entry is audited with user and timestamp.</div>
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

  const load = useCallback(async () => {
    try { setInv((await api(`/invoices/${id}`)).invoice); setError(''); }
    catch (e) { setError(e.message); }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  if (error) return <div className="page"><div className="form-error">{error}</div><Link to="/invoices">← Back to billing</Link></div>;
  if (!inv) return <div className="page"><Spinner label="Loading invoice…" /></div>;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Invoice {inv.invoice_no} <InvoiceStatusBadge status={inv.status} /></h1>
          <div className="desc">Issued {inv.issue_date}{inv.due_date ? ` · due ${inv.due_date}` : ''}</div>
        </div>
        <div className="flex">
          <button className="btn btn-outline" onClick={() => window.print()}><IconPrint size={16}/> Print</button>
          {inv.balance_cents > 0 && ['owner', 'accountant'].includes(user?.role) && (
            <button className="btn btn-primary" onClick={() => setShowPay(true)}><IconPlus size={16}/> Record payment</button>
          )}
        </div>
      </div>

      <div className="grid-2">
        <div className="card card-pad">
          <div className="card-title">Line items</div>
          <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>Description</th><th className="num">Qty</th><th className="num hide-sm">Unit</th><th className="num">Amount</th></tr></thead>
            <tbody>
              {inv.items.map((it) => (
                <tr key={it.id}>
                  <td>{it.description}</td>
                  <td className="num">{it.quantity}</td>
                  <td className="num mono">{money(it.unit_price_cents)}</td>
                  <td className="num mono">{money(it.amount_cents)}</td>
                </tr>
              ))}
              <tr><td colSpan={3} style={{ textAlign: 'right' }}><b>Subtotal</b></td><td className="num mono"><b>{money(inv.subtotal_cents)}</b></td></tr>
              <tr><td colSpan={3} style={{ textAlign: 'right' }}><b>Total</b></td><td className="num mono"><b>{money(inv.total_cents)}</b></td></tr>
              {Number(inv.gross_paid_cents || 0) !== Number(inv.paid_cents || 0) && (
                <>
                  <tr><td colSpan={3} style={{ textAlign: 'right' }}>Gross paid</td><td className="num mono">{money(inv.gross_paid_cents)}</td></tr>
                  <tr><td colSpan={3} style={{ textAlign: 'right' }}>Refunded / adjusted</td><td className="num mono" style={{ color: 'var(--danger)' }}>−{money(inv.refunded_cents)}</td></tr>
                </>
              )}
              <tr><td colSpan={3} style={{ textAlign: 'right' }}>Paid (net)</td><td className="num mono" style={{ color: 'var(--ok)' }}>{money(inv.paid_cents)}</td></tr>
              <tr><td colSpan={3} style={{ textAlign: 'right' }}><b>Balance due</b></td>
                <td className="num mono" style={{ color: inv.balance_cents ? 'var(--danger)' : 'var(--ok)' }}><b>{money(inv.balance_cents)}</b></td></tr>
            </tbody>
          </table>
          </div>
          {inv.notes && <><div className="divider" /><div className="small muted">{inv.notes}</div></>}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="card card-pad">
            <div className="card-title">Billed to</div>
            <Link to={`/patients/${inv.patient_id}`}><b>{inv.patient_name}</b></Link>
            <div className="muted small">{inv.patient_mrn}</div>
            {inv.created_by_name && <div className="muted small mt-12">Created by {inv.created_by_name}</div>}
          </div>
          <div className="card card-pad">
            <div className="card-title">Payments ({inv.payments.length})</div>
            {inv.payments.length === 0 ? <div className="muted small">No payments recorded yet.</div> : (
              inv.payments.map((p) => (
                <div key={p.id} className="dash-list-item">
                  <span className="dash-time" style={{ width: 100 }}>{fmtDate(p.paid_at, { year: undefined, month: 'short', day: 'numeric' })}</span>
                  <span className="who">
                    <b>{p.type && p.type !== 'payment' ? '−' : ''}{money(p.amount_cents)}</b>
                    <span>
                      {p.type === 'refund' ? 'Refund' : p.type === 'adjustment' ? 'Adjustment' : 'Payment'}
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
              <h2>INVOICE</h2>
              <div>{inv.invoice_no}</div>
              <div>Issued: {inv.issue_date}</div>
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
            Total: <b>{money(inv.total_cents)}</b><br />
            Paid: {money(inv.paid_cents)}<br />
            Balance due: <b>{money(inv.balance_cents)}</b>
          </p>
          <p className="muted">Printed {fmtDate(new Date())} {fmtTime(new Date())} — Clinic Portal</p>
        </div>
      </div>

      {showPay && <PaymentModal invoice={inv} onClose={() => setShowPay(false)} onSaved={() => { setShowPay(false); invalidate('/invoices'); invalidateTimelines(); load(); }} />}
    </div>
  );
}
