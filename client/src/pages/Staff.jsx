import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useClinicMeta } from '../auth.jsx';
import { Spinner, EmptyState, Modal, Field, useToast, useConfirm } from '../components/ui.jsx';
import { ROLES } from '../format.js';
import { IconPlus } from '../components/icons.jsx';

function DoctorModal({ doctor, onClose, onSaved }) {
  const toast = useToast();
  const [f, setF] = useState({ name: doctor?.name || '', specialty: doctor?.specialty || '', color: doctor?.color || '#0e9384' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault(); setBusy(true); setError('');
    try {
      const res = doctor
        ? await api(`/staff/doctors/${doctor.id}`, { method: 'PUT', body: f })
        : await api('/staff/doctors', { method: 'POST', body: f });
      toast.success(doctor ? 'Doctor updated.' : 'Doctor added.');
      onSaved();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  return (
    <Modal title={doctor ? 'Edit doctor' : 'Add doctor'} onClose={onClose}
      footer={<><button className="btn btn-outline" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={submit} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button></>}>
      {error && <div className="form-error">{error}</div>}
      <Field label="Full name" required><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={120} placeholder="Dr. …" /></Field>
      <div className="form-row">
        <Field label="Specialty"><input className="input" value={f.specialty} onChange={(e) => setF({ ...f, specialty: e.target.value })} maxLength={120} /></Field>
        <Field label="Calendar color"><input type="color" className="input" style={{ height: 38, padding: 4 }} value={f.color} onChange={(e) => setF({ ...f, color: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}

function UserModal({ account, onClose, onSaved }) {
  const toast = useToast();
  const [f, setF] = useState({
    full_name: account?.full_name || '', email: account?.email || '', role: account?.role || 'receptionist',
    phone: account?.phone || '', password: '',
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault(); setBusy(true); setError('');
    try {
      if (account) {
        const body = { full_name: f.full_name, role: f.role, phone: f.phone };
        if (f.password) body.password = f.password;
        await api(`/staff/users/${account.id}`, { method: 'PUT', body });
        toast.success('Staff member updated.');
      } else {
        await api('/staff/users', { method: 'POST', body: f });
        toast.success('Staff member created.');
      }
      onSaved();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  return (
    <Modal title={account ? `Edit staff — ${account.full_name}` : 'Add staff member'} onClose={onClose}
      footer={<><button className="btn btn-outline" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={submit} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button></>}>
      {error && <div className="form-error">{error}</div>}
      <div className="form-row">
        <Field label="Full name" required><input className="input" value={f.full_name} onChange={(e) => setF({ ...f, full_name: e.target.value })} required maxLength={120} /></Field>
        <Field label="Role">
          <select className="select" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
            <option value="receptionist">Receptionist</option>
            <option value="doctor">Doctor</option>
            <option value="accountant">Accountant</option>
            <option value="owner">Clinic Owner</option>
          </select>
        </Field>
      </div>
      <div className="form-row">
        <Field label="Email" required><input type="email" className="input" value={f.email} disabled={!!account} onChange={(e) => setF({ ...f, email: e.target.value })} required /></Field>
        <Field label="Phone"><input className="input" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} maxLength={40} /></Field>
      </div>
      <Field label={account ? 'New password (leave blank to keep current)' : 'Password'} required={!account}
        hint="Minimum 8 characters. Doctor accounts automatically get a doctor profile for scheduling.">
        <input type="password" className="input" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })}
          required={!account} minLength={8} placeholder="••••••••" />
      </Field>
    </Modal>
  );
}

export default function Staff() {
  const [tab, setTab] = useState('doctors');
  const [doctors, setDoctors] = useState(null);
  const [users, setUsers] = useState(null);
  const [error, setError] = useState('');
  const [doctorModal, setDoctorModal] = useState(null);
  const [userModal, setUserModal] = useState(null);
  const toast = useToast();
  const confirm = useConfirm();
  const { refreshMeta } = useClinicMeta();

  async function load() {
    setError('');
    try {
      const [d, u] = await Promise.all([api('/staff/doctors'), api('/staff/users')]);
      setDoctors(d.doctors); setUsers(u.users);
    } catch (e) { setError(e.message); }
  }
  useEffect(() => { load(); }, []);

  async function toggleDoctor(d) {
    const action = d.is_active ? 'deactivate' : 'reactivate';
    const ok = await confirm({
      title: `${action === 'deactivate' ? 'Deactivate' : 'Reactivate'} doctor`,
      message: `${action === 'deactivate' ? 'Deactivate' : 'Reactivate'} ${d.name}? ${d.is_active ? 'They will no longer appear in scheduling.' : 'They will become available for scheduling again.'}`,
      confirmLabel: action === 'deactivate' ? 'Deactivate' : 'Reactivate',
      danger: d.is_active,
    });
    if (!ok) return;
    try {
      await api(`/staff/doctors/${d.id}`, { method: 'PUT', body: { is_active: !d.is_active } });
      toast.success(`Doctor ${action}d.`);
      load();
      refreshMeta(); // keep calendar doctor filters/colors in sync
    } catch (e) { toast.error(e.message); }
  }

  async function toggleUser(u) {
    const ok = await confirm({
      title: u.is_active ? 'Deactivate account' : 'Reactivate account',
      message: `${u.is_active ? 'Deactivate' : 'Reactivate'} ${u.full_name}'s login?`,
      confirmLabel: u.is_active ? 'Deactivate' : 'Reactivate',
      danger: u.is_active,
    });
    if (!ok) return;
    try {
      await api(`/staff/users/${u.id}`, { method: 'PUT', body: { is_active: !u.is_active } });
      toast.success('Account updated.');
      load();
    } catch (e) { toast.error(e.message); }
  }

  if (error) return <div className="page"><div className="form-error">{error}</div></div>;
  if (!doctors || !users) return <div className="page"><Spinner label="Loading staff…" /></div>;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Doctors & Staff</h1>
          <div className="desc">Manage the care team that appears in scheduling, and the accounts your staff sign in with.</div>
        </div>
        {tab === 'doctors'
          ? <button className="btn btn-primary" onClick={() => setDoctorModal({})}><IconPlus size={16}/> Add doctor</button>
          : <button className="btn btn-primary" onClick={() => setUserModal({})}><IconPlus size={16}/> Add staff member</button>}
      </div>

      <div className="tabs">
        <button className={`tab${tab === 'doctors' ? ' on' : ''}`} onClick={() => setTab('doctors')}>Doctors ({doctors.length})</button>
        <button className={`tab${tab === 'users' ? ' on' : ''}`} onClick={() => setTab('users')}>Staff accounts ({users.length})</button>
      </div>

      {tab === 'doctors' ? (
        <div className="card">
          {doctors.length === 0 ? <EmptyState icon="🩺" title="No doctors yet" action={<button className="btn btn-primary btn-sm" onClick={() => setDoctorModal({})}>Add doctor</button>} /> : (
            <div className="table-wrap">
              <table className="tbl">
                <thead><tr><th>Doctor</th><th className="hide-sm">Specialty</th><th className="hide-sm">Login</th><th className="num">Appointments</th><th>Status</th><th></th></tr></thead>
                <tbody>
                  {doctors.map((d) => (
                    <tr key={d.id}>
                      <td><span className="flex" style={{ gap: 9 }}><span style={{ width: 12, height: 12, borderRadius: 4, background: d.color, flexShrink: 0 }} /><b>{d.name}</b></span></td>
                      <td className="hide-sm">{d.specialty || <span className="muted">—</span>}</td>
                      <td className="hide-sm">{d.user_email || <span className="muted">no login</span>}</td>
                      <td className="num">{d.appointment_count}</td>
                      <td>{d.is_active ? <span className="badge" style={{ background: 'var(--ok-soft)', color: 'var(--ok)', borderColor: '#d5e8b2' }}>Active</span>
                        : <span className="badge" style={{ background: '#f1f5f9', color: '#475569', borderColor: '#dbe2ea' }}>Inactive</span>}</td>
                      <td className="num">
                        <div className="flex" style={{ justifyContent: 'flex-end' }}>
                          <button className="btn btn-outline btn-sm" onClick={() => setDoctorModal(d)}>Edit</button>
                          <button className={`btn btn-sm ${d.is_active ? 'btn-danger-outline' : 'btn-outline'}`} onClick={() => toggleDoctor(d)}>
                            {d.is_active ? 'Deactivate' : 'Reactivate'}
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
      ) : (
        <div className="card">
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>Name</th><th className="hide-sm">Email</th><th>Role</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td><b>{u.full_name}</b></td>
                    <td className="hide-sm">{u.email}</td>
                    <td>{ROLES[u.role]}</td>
                    <td>{u.is_active ? <span className="badge" style={{ background: 'var(--ok-soft)', color: 'var(--ok)', borderColor: '#d5e8b2' }}>Active</span>
                      : <span className="badge" style={{ background: '#f1f5f9', color: '#475569', borderColor: '#dbe2ea' }}>Disabled</span>}</td>
                    <td className="num">
                      <div className="flex" style={{ justifyContent: 'flex-end' }}>
                        <button className="btn btn-outline btn-sm" onClick={() => setUserModal(u)}>Edit</button>
                        <button className={`btn btn-sm ${u.is_active ? 'btn-danger-outline' : 'btn-outline'}`} onClick={() => toggleUser(u)}>
                          {u.is_active ? 'Deactivate' : 'Reactivate'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {doctorModal !== null && (
        <DoctorModal doctor={doctorModal.id ? doctorModal : null} onClose={() => setDoctorModal(null)}
          onSaved={() => { setDoctorModal(null); load(); refreshMeta(); }} />
      )}
      {userModal !== null && (
        <UserModal account={userModal.id ? userModal : null} onClose={() => setUserModal(null)}
          onSaved={() => { setUserModal(null); load(); refreshMeta(); }} />
      )}
    </div>
  );
}
