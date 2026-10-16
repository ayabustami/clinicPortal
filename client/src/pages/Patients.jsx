import React, { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { cachedGet, invalidate } from '../apiCache.js';
import { useAuth } from '../auth.jsx';
import { useI18n } from '../i18n.jsx';
import { Spinner, EmptyState, Modal, Field, Pagination, useToast } from '../components/ui.jsx';
import { IconPlus, IconSearch } from '../components/icons.jsx';

export function PatientFormModal({ patient, onClose, onSaved }) {
  const toast = useToast();
  const { lang } = useI18n();
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
      toast.success(patient ? (lang === 'ar' ? 'تم تحديث المريض.' : 'Patient updated.') : (lang === 'ar' ? `تم تسجيل المريض (${res.patient.mrn}).` : `Patient registered (${res.patient.mrn}).`));
      onSaved(res.patient);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  return (
    <Modal title={patient ? (lang === 'ar' ? `تعديل مريض — ${patient.mrn}` : `Edit patient — ${patient.mrn}`) : (lang === 'ar' ? 'تسجيل مريض جديد' : 'Register new patient')} onClose={onClose} wide
      footer={
        <>
          <button className="btn btn-outline" onClick={onClose}>{lang === 'ar' ? 'إلغاء' : 'Cancel'}</button>
          <button className="btn btn-primary" onClick={submit} disabled={busy}>{busy ? (lang === 'ar' ? 'جارٍ الحفظ…' : 'Saving…') : patient ? (lang === 'ar' ? 'حفظ التغييرات' : 'Save changes') : (lang === 'ar' ? 'تسجيل مريض' : 'Register patient')}</button>
        </>
      }>
      {error && <div className="form-error">{error}</div>}
      <form onSubmit={submit}>
        <div className="form-row">
          <Field label={lang === 'ar' ? 'الاسم الأول' : 'First name'} required><input className="input" value={f.first_name} onChange={set('first_name')} required maxLength={80} /></Field>
          <Field label={lang === 'ar' ? 'اسم العائلة' : 'Last name'} required><input className="input" value={f.last_name} onChange={set('last_name')} required maxLength={80} /></Field>
        </div>
        <div className="form-row-3">
          <Field label={lang === 'ar' ? 'تاريخ الميلاد' : 'Date of birth'}><input type="date" className="input" value={f.dob} onChange={set('dob')} /></Field>
          <Field label="Gender">
            <select className="select" value={f.gender} onChange={set('gender')}>
              <option value="">—</option><option value="female">{lang === 'ar' ? 'أنثى' : 'Female'}</option><option value="male">{lang === 'ar' ? 'ذكر' : 'Male'}</option><option value="other">{lang === 'ar' ? 'أخرى' : 'Other'}</option>
            </select>
          </Field>
          <Field label={lang === 'ar' ? 'الهاتف' : 'Phone'}><input className="input" value={f.phone} onChange={set('phone')} maxLength={40} /></Field>
        </div>
        <div className="form-row">
          <Field label={lang === 'ar' ? 'البريد الإلكتروني' : 'Email'}><input type="email" className="input" value={f.email} onChange={set('email')} /></Field>
          <Field label={lang === 'ar' ? 'العنوان' : 'Address'}><input className="input" value={f.address} onChange={set('address')} maxLength={200} /></Field>
        </div>
        <Field label={lang === 'ar' ? 'الحساسية' : 'Allergies'} hint={lang === 'ar' ? 'تظهر للفريق السريري في كل زيارة.' : 'Shown to clinical staff on every visit.'}>
          <textarea className="textarea" rows={2} value={f.allergies} onChange={set('allergies')} maxLength={2000} placeholder={lang === 'ar' ? 'مثال: البنسلين' : 'e.g. Penicillin'} />
        </Field>
        <Field label={lang === 'ar' ? 'معلومات طبية ذات صلة' : 'Relevant medical information'}>
          <textarea className="textarea" rows={3} value={f.medical_info} onChange={set('medical_info')} maxLength={4000} placeholder={lang === 'ar' ? 'حالات مزمنة، أدوية مستمرة…' : 'Chronic conditions, ongoing medication…'} />
        </Field>
        <button type="submit" style={{ display: 'none' }} />
      </form>
    </Modal>
  );
}

export default function Patients() {
  const { user } = useAuth();
  const { lang } = useI18n();
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
          <h1>{lang === 'ar' ? 'المرضى' : 'Patients'}</h1>
          <div className="desc">{lang === 'ar' ? 'سجّل المرضى، وحدّث معلومات الاتصال والحساسية، وراجع سجلاتهم.' : 'Register patients, keep their contact and allergy information up to date, and review their history.'}</div>
        </div>
        {canEdit && (
          <button className="btn btn-primary" onClick={() => setShowForm(true)}><IconPlus size={16}/> {lang === 'ar' ? 'تسجيل مريض' : 'Register patient'}</button>
        )}
      </div>

      <div className="card">
        <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--line)' }}>
          <div style={{ position: 'relative', maxWidth: 380 }}>
            <span style={{ position: 'absolute', insetInlineStart: 11, top: 9, color: 'var(--muted)' }}><IconSearch size={16} /></span>
            <input className="input" style={{ paddingInlineStart: 36 }} placeholder={lang === 'ar' ? 'ابحث بالاسم أو رقم المريض أو الهاتف…' : 'Search by name, patient number or phone…'}
              value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </div>
        {error && <div className="form-error" style={{ margin: 14 }}>{error}</div>}
        {!items ? <Spinner label={lang === 'ar' ? 'جارٍ تحميل المرضى…' : 'Loading patients…'} /> : items.length === 0 ? (
          <EmptyState icon="🧑‍🤝‍🧑" title={search ? (lang === 'ar' ? 'لا يوجد مرضى مطابقون للبحث' : 'No patients match your search') : (lang === 'ar' ? 'لا يوجد مرضى مسجلون بعد' : 'No patients registered yet')}>
            {search ? (lang === 'ar' ? 'جرّب اسماً أو رقماً أو جزءاً من الهاتف مختلفاً.' : 'Try a different name, number or phone fragment.') : (lang === 'ar' ? 'سجّل أول مريض لبدء جدولة الزيارات.' : 'Register your first patient to start scheduling visits.')}
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>{lang === 'ar' ? 'الرقم' : 'Number'}</th><th>{lang === 'ar' ? 'الاسم' : 'Name'}</th><th>{lang === 'ar' ? 'الهاتف' : 'Phone'}</th><th className="hide-sm">{lang === 'ar' ? 'تاريخ الميلاد' : 'DOB'}</th><th className="hide-sm">{lang === 'ar' ? 'الجنس' : 'Gender'}</th><th className="num">{lang === 'ar' ? 'الزيارات' : 'Visits'}</th></tr></thead>
              <tbody>
                {items.map((p) => (
                  <tr key={p.id} className="row-link" tabIndex={0} role="link"
                      aria-label={lang === 'ar' ? `فتح مريض ${p.first_name} ${p.last_name}` : `Open patient ${p.first_name} ${p.last_name}`}
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
