import React, { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { cachedGet, invalidate } from '../apiCache.js';
import { useAuth } from '../auth.jsx';
import { Spinner, EmptyState, Modal, Field, Pagination, useToast } from '../components/ui.jsx';
import { IconPlus, IconSearch } from '../components/icons.jsx';

export function PatientFormModal({ patient, onClose, onSaved }) {
  const toast = useToast();
  const [f, setF] = useState({
    first_name: patient?.first_name || '', last_name: patient?.last_name || '',
    dob: patient?.dob || '', gender: patient?.gender || '', phone: patient?.phone || '',
    email: patient?.email || '', address: patient?.address || '',
    allergies: patient?.allergies || '', medical_info: patient?.medical_info || '',
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const body = { ...f, gender: f.gender || null, dob: f.dob || null };
      const res = patient
        ? await api(`/patients/${patient.id}`, { method: 'PUT', body })
        : await api('/patients', { method: 'POST', body });
      toast.success(patient ? 'Patient updated.' : `Patient registered (${res.patient.mrn}).`);
      onSaved(res.patient);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  return (
    <Modal title={patient ? `Edit patient — ${patient.mrn}` : 'Register new patient'} onClose={onClose} wide
      footer={
        <>
          <button className="btn btn-outline" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={busy}>{busy ? 'Saving…' : patient ? 'Save changes' : 'Register patient'}</button>
        </>
      }>
      {error && <div className="form-error">{error}</div>}
      <form onSubmit={submit}>
        <div className="form-row">
          <Field label="First name" required><input className="input" value={f.first_name} onChange={set('first_name')} required maxLength={80} /></Field>
          <Field label="Last name" required><input className="input" value={f.last_name} onChange={set('last_name')} required maxLength={80} /></Field>
        </div>
        <div className="form-row-3">
          <Field label="Date of birth"><input type="date" className="input" value={f.dob} onChange={set('dob')} /></Field>
          <Field label="Gender">
            <select className="select" value={f.gender} onChange={set('gender')}>
              <option value="">—</option><option value="female">Female</option><option value="male">Male</option><option value="other">Other</option>
            </select>
          </Field>
          <Field label="Phone"><input className="input" value={f.phone} onChange={set('phone')} maxLength={40} /></Field>
        </div>
        <div className="form-row">
          <Field label="Email"><input type="email" className="input" value={f.email} onChange={set('email')} /></Field>
          <Field label="Address"><input className="input" value={f.address} onChange={set('address')} maxLength={200} /></Field>
        </div>
        <Field label="Allergies" hint="Shown to clinical staff on every visit.">
          <textarea className="textarea" rows={2} value={f.allergies} onChange={set('allergies')} maxLength={2000} placeholder="e.g. Penicillin" />
        </Field>
        <Field label="Relevant medical information">
          <textarea className="textarea" rows={3} value={f.medical_info} onChange={set('medical_info')} maxLength={4000} placeholder="Chronic conditions, ongoing medication…" />
        </Field>
        <button type="submit" style={{ display: 'none' }} />
      </form>
    </Modal>
  );
}

export default function Patients() {
  const { user } = useAuth();
  const [items, setItems] = useState(null);
  const [meta, setMeta] = useState({ page: 1, pages: 1, total: 0 });
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [params, setParams] = useSearchParams();
  // Dashboard quick action deep-link: /patients?new=1
  useEffect(() => {
    if (params.get('new') === '1') { setShowForm(true); setParams({}, { replace: true }); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const navigate = useNavigate();
  const canEdit = ['owner', 'receptionist'].includes(user.role);

  const searchSeq = React.useRef(0);
  async function load(page = 1, q = search, force = false) {
    const seq = (searchSeq.current += 1);
    setError('');
    try {
      // cached + de-duplicated: identical list reads in flight share one
      // request, and returning to page 1 of an unchanged search is instant.
      const res = (await cachedGet(`/patients?search=${encodeURIComponent(q)}&page=${page}&limit=15`, { force })).data;
      if (seq !== searchSeq.current) return; // stale response — a newer search is in flight
      setItems(res.items);
      setMeta({ page: res.page, pages: res.pages, total: res.total });
    } catch (e) { if (seq === searchSeq.current) setError(e.message); }
  }

  const firstLoad = React.useRef(true);
  useEffect(() => {
    // First mount fetches immediately; only typing is debounced. The old code
    // delayed even the initial list by 300ms for no reason.
    const delay = firstLoad.current ? 0 : 300;
    firstLoad.current = false;
    const t = setTimeout(() => load(1), delay);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Patients</h1>
          <div className="desc">Register patients, keep their contact and allergy information up to date, and review their history.</div>
        </div>
        {canEdit && (
          <button className="btn btn-primary" onClick={() => setShowForm(true)}><IconPlus size={16}/> Register patient</button>
        )}
      </div>

      <div className="card">
        <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--line)' }}>
          <div style={{ position: 'relative', maxWidth: 380 }}>
            <span style={{ position: 'absolute', insetInlineStart: 11, top: 9, color: 'var(--muted)' }}><IconSearch size={16} /></span>
            <input className="input" style={{ paddingInlineStart: 36 }} placeholder="Search by name, patient number or phone…"
              value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </div>
        {error && <div className="form-error" style={{ margin: 14 }}>{error}</div>}
        {!items ? <Spinner label="Loading patients…" /> : items.length === 0 ? (
          <EmptyState icon="🧑‍🤝‍🧑" title={search ? 'No patients match your search' : 'No patients registered yet'}>
            {search ? 'Try a different name, number or phone fragment.' : 'Register your first patient to start scheduling visits.'}
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>Number</th><th>Name</th><th>Phone</th><th className="hide-sm">DOB</th><th className="hide-sm">Gender</th><th className="num">Visits</th></tr></thead>
              <tbody>
                {items.map((p) => (
                  <tr key={p.id} className="row-link" tabIndex={0} role="link"
                      aria-label={`Open patient ${p.first_name} ${p.last_name}`}
                      onClick={() => navigate(`/patients/${p.id}`)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(`/patients/${p.id}`); } }}>
                    <td className="mono">{p.mrn}</td>
                    <td><b>{p.first_name} {p.last_name}</b></td>
                    <td>{p.phone || <span className="muted">—</span>}</td>
                    <td className="hide-sm">{p.dob || <span className="muted">—</span>}</td>
                    <td className="hide-sm" style={{ textTransform: 'capitalize' }}>{p.gender || '—'}</td>
                    <td className="num">{p.visits}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pagination page={meta.page} pages={meta.pages} total={meta.total} onPage={(p) => load(p)} />
          </div>
        )}
      </div>

      {showForm && (
        <PatientFormModal onClose={() => setShowForm(false)} onSaved={(p) => { setShowForm(false); invalidate('/patients?'); invalidate('/patients/' + p.id); navigate(`/patients/${p.id}`); }} />
      )}
    </div>
  );
}
