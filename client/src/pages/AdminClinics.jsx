import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Spinner, Modal, Field, useToast, useConfirm } from '../components/ui.jsx';
import { fmtDateShort } from '../format.js';
import { IconPlus } from '../components/icons.jsx';

function ClinicModal({ onClose, onSaved }) {
  const toast = useToast();
  const [f, setF] = useState({ name: '', email: '', phone: '', address: '', timezone: 'UTC', currency: 'ILS' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault(); setBusy(true); setError('');
    try {
      const res = await api('/clinics', { method: 'POST', body: f });
      toast.success('Clinic created. Provision its owner account next.');
      onSaved(res.clinic);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  return (
    <Modal title="Create clinic" onClose={onClose}
      footer={<><button className="btn btn-outline" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={submit} disabled={busy}>{busy ? 'Creating…' : 'Create clinic'}</button></>}>
      {error && <div className="form-error">{error}</div>}
      <Field label="Clinic name" required><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={120} /></Field>
      <div className="form-row">
        <Field label="Email"><input type="email" className="input" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="Phone"><input className="input" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} maxLength={40} /></Field>
      </div>
      <Field label="Address"><input className="input" value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} maxLength={200} /></Field>
      <div className="form-row">
        <Field label="Timezone (IANA)" hint="e.g. Asia/Hebron, Europe/London"><input className="input" value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })} /></Field>
        <Field label="Currency"><select className="select" value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })}>
          {['ILS', 'JOD', 'USD', 'EUR', 'GBP'].map((c) => <option key={c} value={c}>{c}</option>)}
        </select></Field>
      </div>
      <div className="field-hint">A default Sunday–Thursday 08:00–17:00 working week is applied; the clinic owner can change it in Clinic Settings.</div>
    </Modal>
  );
}

/** Platform admin provisions the first owner of a clinic (also a recovery path). */
function OwnerModal({ clinic, onClose, onDone }) {
  const toast = useToast();
  const [f, setF] = useState({ full_name: '', email: '', phone: '', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault(); setBusy(true); setError('');
    try {
      await api(`/clinics/${clinic.id}/owner`, { method: 'POST', body: f });
      toast.success(`Owner account created for ${clinic.name}.`);
      onDone();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  return (
    <Modal title={`Provision owner · ${clinic.name}`} onClose={onClose}
      footer={<><button className="btn btn-outline" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={submit} disabled={busy}>{busy ? 'Creating…' : 'Create owner account'}</button></>}>
      {error && <div className="form-error">{error}</div>}
      <Field label="Full name" required><input className="input" value={f.full_name} onChange={(e) => setF({ ...f, full_name: e.target.value })} required maxLength={120} /></Field>
      <div className="form-row">
        <Field label="Email" required><input type="email" className="input" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required /></Field>
        <Field label="Phone"><input className="input" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} maxLength={40} /></Field>
      </div>
      <Field label="Temporary password" required hint="Minimum 8 characters. The owner should change it after first sign-in.">
        <input type="text" className="input" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required minLength={8} maxLength={200} />
      </Field>
    </Modal>
  );
}

export default function AdminClinics() {
  const [clinics, setClinics] = useState(null);
  const [error, setError] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [ownerFor, setOwnerFor] = useState(null);
  const toast = useToast();
  const confirm = useConfirm();

  async function load() {
    try { setClinics((await api('/clinics')).clinics); setError(''); }
    catch (e) { setError(e.message); }
  }
  useEffect(() => { load(); }, []);

  async function toggle(c) {
    const suspending = c.status === 'active';
    const ok = await confirm({
      title: suspending ? 'Suspend clinic' : 'Reactivate clinic',
      message: suspending
        ? `Suspend "${c.name}"? Its staff will be unable to sign in until reactivated.`
        : `Reactivate "${c.name}"?`,
      confirmLabel: suspending ? 'Suspend' : 'Reactivate',
      danger: suspending,
    });
    if (!ok) return;
    try {
      await api(`/clinics/${c.id}`, { method: 'PUT', body: { status: suspending ? 'suspended' : 'active' } });
      toast.success('Clinic updated.');
      load();
    } catch (e) { toast.error(e.message); }
  }

  if (error) return <div className="page"><div className="form-error">{error}</div></div>;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Platform · Clinics</h1>
          <div className="desc">Every clinic is an isolated tenant: its own staff, patients, appointments and billing.</div>
        </div>
        <button className="btn btn-primary" onClick={() => setShowNew(true)}><IconPlus size={16}/> Create clinic</button>
      </div>

      <div className="card">
        {!clinics ? <Spinner label="Loading clinics…" /> : (
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>Clinic</th><th>Contact</th><th>Timezone</th><th className="num">Staff</th><th className="num">Patients</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {clinics.map((c) => (
                  <tr key={c.id}>
                    <td><b>{c.name}</b><div className="muted small">{c.address || c.slug}</div></td>
                    <td>{c.email}<div className="muted small">{c.phone}</div></td>
                    <td>{c.timezone}</td>
                    <td className="num">{c.user_count}</td>
                    <td className="num">{c.patient_count}</td>
                    <td>{c.status === 'active'
                      ? <span className="badge" style={{ background: 'var(--ok-soft)', color: 'var(--ok)', borderColor: '#d5e8b2' }}>Active</span>
                      : <span className="badge" style={{ background: 'var(--danger-soft)', color: '#991b1b', borderColor: '#f3c1c1' }}>Suspended</span>}</td>
                    <td className="num">
                      <div className="flex" style={{ gap: 6, justifyContent: 'flex-end' }}>
                        <button className="btn btn-sm btn-outline" onClick={() => setOwnerFor(c)} title="Create an owner login for this clinic">
                          {c.user_count === 0 ? 'Provision owner' : 'Add owner'}
                        </button>
                        <button className={`btn btn-sm ${c.status === 'active' ? 'btn-danger-outline' : 'btn-outline'}`} onClick={() => toggle(c)}>
                          {c.status === 'active' ? 'Suspend' : 'Reactivate'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showNew && <ClinicModal onClose={() => setShowNew(false)} onSaved={(clinic) => { setShowNew(false); load(); if (clinic) setOwnerFor(clinic); }} />}
      {ownerFor && <OwnerModal clinic={ownerFor} onClose={() => setOwnerFor(null)} onDone={() => { setOwnerFor(null); load(); }} />}
    </div>
  );
}
