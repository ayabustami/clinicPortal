import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useClinicMeta } from '../auth.jsx';
import { useI18n } from '../i18n.jsx';
import { Spinner, EmptyState, Modal, Field, useToast, useConfirm } from '../components/ui.jsx';
import { ROLES } from '../format.js';
import { IconPlus } from '../components/icons.jsx';

function DoctorModal({ doctor, onClose, onSaved }) {
  const toast = useToast();
  const { lang } = useI18n();
  const [f, setF] = useState({ name: doctor?.name || '', specialty: doctor?.specialty || '', color: doctor?.color || '#0e9384' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault(); setBusy(true); setError('');
    try {
      const res = doctor
        ? await api(`/staff/doctors/${doctor.id}`, { method: 'PUT', body: f })
        : await api('/staff/doctors', { method: 'POST', body: f });
      toast.success(doctor ? (lang === 'ar' ? 'تم تحديث الطبيب.' : 'Doctor updated.') : (lang === 'ar' ? 'تمت إضافة الطبيب.' : 'Doctor added.'));
      onSaved();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  return (
    <Modal title={doctor ? (lang === 'ar' ? 'تعديل طبيب' : 'Edit doctor') : (lang === 'ar' ? 'إضافة طبيب' : 'Add doctor')} onClose={onClose}
      footer={<><button className="btn btn-outline" onClick={onClose}>{lang === 'ar' ? 'إلغاء' : 'Cancel'}</button>
        <button className="btn btn-primary" onClick={submit} disabled={busy}>{busy ? (lang === 'ar' ? 'جارٍ الحفظ…' : 'Saving…') : (lang === 'ar' ? 'حفظ' : 'Save')}</button></>}>
      {error && <div className="form-error">{error}</div>}
      <Field label={lang === 'ar' ? 'الاسم الكامل' : 'Full name'} required><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={120} placeholder={lang === 'ar' ? 'د. …' : 'Dr. …'} /></Field>
      <div className="form-row">
        <Field label={lang === 'ar' ? 'التخصص' : 'Specialty'}><input className="input" value={f.specialty} onChange={(e) => setF({ ...f, specialty: e.target.value })} maxLength={120} /></Field>
        <Field label={lang === 'ar' ? 'لون التقويم' : 'Calendar color'}><input type="color" className="input" style={{ height: 38, padding: 4 }} value={f.color} onChange={(e) => setF({ ...f, color: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}

function UserModal({ account, onClose, onSaved }) {
  const toast = useToast();
  const { lang } = useI18n();
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
        toast.success(lang === 'ar' ? 'تم تحديث الموظف.' : 'Staff member updated.');
      } else {
        await api('/staff/users', { method: 'POST', body: f });
        toast.success(lang === 'ar' ? 'تم إنشاء الموظف.' : 'Staff member created.');
      }
      onSaved();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  return (
    <Modal title={account ? (lang === 'ar' ? `تعديل موظف — ${account.full_name}` : `Edit staff — ${account.full_name}`) : (lang === 'ar' ? 'إضافة موظف' : 'Add staff member')} onClose={onClose}
      footer={<><button className="btn btn-outline" onClick={onClose}>{lang === 'ar' ? 'إلغاء' : 'Cancel'}</button>
        <button className="btn btn-primary" onClick={submit} disabled={busy}>{busy ? (lang === 'ar' ? 'جارٍ الحفظ…' : 'Saving…') : (lang === 'ar' ? 'حفظ' : 'Save')}</button></>}>
      {error && <div className="form-error">{error}</div>}
      <div className="form-row">
        <Field label={lang === 'ar' ? 'الاسم الكامل' : 'Full name'} required><input className="input" value={f.full_name} onChange={(e) => setF({ ...f, full_name: e.target.value })} required maxLength={120} /></Field>
        <Field label={lang === 'ar' ? 'الدور' : 'Role'}>
          <select className="select" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
            <option value="receptionist">Receptionist</option>
            <option value="doctor">Doctor</option>
            <option value="accountant">Accountant</option>
            <option value="owner">Clinic Owner</option>
          </select>
        </Field>
      </div>
      <div className="form-row">
        <Field label={lang === 'ar' ? 'البريد الإلكتروني' : 'Email'} required><input type="email" className="input" value={f.email} disabled={!!account} onChange={(e) => setF({ ...f, email: e.target.value })} required /></Field>
        <Field label={lang === 'ar' ? 'الهاتف' : 'Phone'}><input className="input" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} maxLength={40} /></Field>
      </div>
      <Field label={account ? (lang === 'ar' ? 'كلمة مرور جديدة (اتركها فارغة للإبقاء على الحالية)' : 'New password (leave blank to keep current)') : (lang === 'ar' ? 'كلمة المرور' : 'Password')} required={!account}
        hint={lang === 'ar' ? '8 أحرف كحد أدنى. حسابات الأطباء تحصل تلقائياً على ملف طبيب للجدولة.' : 'Minimum 8 characters. Doctor accounts automatically get a doctor profile for scheduling.'}>
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
  const { lang } = useI18n();

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
      title: `${action === 'deactivate' ? (lang === 'ar' ? 'إلغاء تفعيل' : 'Deactivate') : (lang === 'ar' ? 'إعادة تفعيل' : 'Reactivate')} ${lang === 'ar' ? 'طبيب' : 'doctor'}`,
      message: `${action === 'deactivate' ? (lang === 'ar' ? 'إلغاء تفعيل' : 'Deactivate') : (lang === 'ar' ? 'إعادة تفعيل' : 'Reactivate')} ${d.name}? ${d.is_active ? (lang === 'ar' ? 'لن يظهر بعد الآن في الجدولة.' : 'They will no longer appear in scheduling.') : (lang === 'ar' ? 'سيصبح متاحاً للجدولة مرة أخرى.' : 'They will become available for scheduling again.')}`,
      confirmLabel: action === 'deactivate' ? (lang === 'ar' ? 'إلغاء تفعيل' : 'Deactivate') : (lang === 'ar' ? 'إعادة تفعيل' : 'Reactivate'),
      danger: d.is_active,
    });
    if (!ok) return;
    try {
      await api(`/staff/doctors/${d.id}`, { method: 'PUT', body: { is_active: !d.is_active } });
      toast.success(lang === 'ar' ? `تم ${action === 'deactivate' ? 'إلغاء تفعيل' : 'إعادة تفعيل'} الطبيب.` : `Doctor ${action}d.`);
      load();
      refreshMeta(); // keep calendar doctor filters/colors in sync
    } catch (e) { toast.error(e.message); }
  }

  async function toggleUser(u) {
    const ok = await confirm({
      title: u.is_active ? (lang === 'ar' ? 'إلغاء تفعيل الحساب' : 'Deactivate account') : (lang === 'ar' ? 'إعادة تفعيل الحساب' : 'Reactivate account'),
      message: `${u.is_active ? (lang === 'ar' ? 'إلغاء تفعيل' : 'Deactivate') : (lang === 'ar' ? 'إعادة تفعيل' : 'Reactivate')} ${lang === 'ar' ? 'تسجيل دخول' : 'login'} ${u.full_name}؟`,
      confirmLabel: u.is_active ? (lang === 'ar' ? 'إلغاء تفعيل' : 'Deactivate') : (lang === 'ar' ? 'إعادة تفعيل' : 'Reactivate'),
      danger: u.is_active,
    });
    if (!ok) return;
    try {
      await api(`/staff/users/${u.id}`, { method: 'PUT', body: { is_active: !u.is_active } });
      toast.success(lang === 'ar' ? 'تم تحديث الحساب.' : 'Account updated.');
      load();
    } catch (e) { toast.error(e.message); }
  }

  if (error) return <div className="page"><div className="form-error">{error}</div></div>;
  if (!doctors || !users) return <div className="page"><Spinner label={lang === 'ar' ? 'جارٍ تحميل الموظفين…' : 'Loading staff…'} /></div>;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{lang === 'ar' ? 'الأطباء والموظفون' : 'Doctors & Staff'}</h1>
          <div className="desc">{lang === 'ar' ? 'أدر فريق الرعاية الذي يظهر في الجدولة، والحسابات التي يسجل بها الموظفون.' : 'Manage the care team that appears in scheduling, and the accounts your staff sign in with.'}</div>
        </div>
        {tab === 'doctors'
          ? <button className="btn btn-primary" onClick={() => setDoctorModal({})}><IconPlus size={16}/> {lang === 'ar' ? 'إضافة طبيب' : 'Add doctor'}</button>
          : <button className="btn btn-primary" onClick={() => setUserModal({})}><IconPlus size={16}/> {lang === 'ar' ? 'إضافة موظف' : 'Add staff member'}</button>}
      </div>

      <div className="tabs">
        <button className={`tab${tab === 'doctors' ? ' on' : ''}`} onClick={() => setTab('doctors')}>{lang === 'ar' ? 'الأطباء' : 'Doctors'} ({doctors.length})</button>
        <button className={`tab${tab === 'users' ? ' on' : ''}`} onClick={() => setTab('users')}>{lang === 'ar' ? 'حسابات الموظفين' : 'Staff accounts'} ({users.length})</button>
      </div>

      {tab === 'doctors' ? (
        <div className="card">
          {doctors.length === 0 ? <EmptyState icon="🩺" title={lang === 'ar' ? 'لا يوجد أطباء بعد' : 'No doctors yet'} action={<button className="btn btn-primary btn-sm" onClick={() => setDoctorModal({})}>{lang === 'ar' ? 'إضافة طبيب' : 'Add doctor'}</button>} /> : (
            <div className="table-wrap">
              <table className="tbl">
                <thead><tr><th>{lang === 'ar' ? 'الطبيب' : 'Doctor'}</th><th className="hide-sm">{lang === 'ar' ? 'التخصص' : 'Specialty'}</th><th className="hide-sm">{lang === 'ar' ? 'تسجيل الدخول' : 'Login'}</th><th className="num">{lang === 'ar' ? 'المواعيد' : 'Appointments'}</th><th>{lang === 'ar' ? 'الحالة' : 'Status'}</th><th></th></tr></thead>
                <tbody>
                  {doctors.map((d) => (
                    <tr key={d.id}>
                      <td><span className="flex" style={{ gap: 9 }}><span style={{ width: 12, height: 12, borderRadius: 4, background: d.color, flexShrink: 0 }} /><b>{d.name}</b></span></td>
                      <td className="hide-sm">{d.specialty || <span className="muted">—</span>}</td>
                      <td className="hide-sm">{d.user_email || <span className="muted">{lang === 'ar' ? 'لا يوجد تسجيل دخول' : 'no login'}</span>}</td>
                      <td className="num">{d.appointment_count}</td>
                      <td>{d.is_active ? <span className="badge" style={{ background: 'var(--ok-soft)', color: 'var(--ok)', borderColor: '#d5e8b2' }}>Active</span>
                        : <span className="badge" style={{ background: '#f1f5f9', color: '#475569', borderColor: '#dbe2ea' }}>Inactive</span>}</td>
                      <td className="num">
                        <div className="flex" style={{ justifyContent: 'flex-end' }}>
                          <button className="btn btn-outline btn-sm" onClick={() => setDoctorModal(d)}>{lang === 'ar' ? 'تعديل' : 'Edit'}</button>
                          <button className={`btn btn-sm ${d.is_active ? 'btn-danger-outline' : 'btn-outline'}`} onClick={() => toggleDoctor(d)}>
                            {d.is_active ? (lang === 'ar' ? 'إلغاء تفعيل' : 'Deactivate') : (lang === 'ar' ? 'إعادة تفعيل' : 'Reactivate')}
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
              <thead><tr><th>{lang === 'ar' ? 'الاسم' : 'Name'}</th><th className="hide-sm">{lang === 'ar' ? 'البريد الإلكتروني' : 'Email'}</th><th>{lang === 'ar' ? 'الدور' : 'Role'}</th><th>{lang === 'ar' ? 'الحالة' : 'Status'}</th><th></th></tr></thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td><b>{u.full_name}</b></td>
                    <td className="hide-sm">{u.email}</td>
                    <td>{ROLES[u.role]}</td>
                    <td>{u.is_active ? <span className="badge" style={{ background: 'var(--ok-soft)', color: 'var(--ok)', borderColor: '#d5e8b2' }}>{lang === 'ar' ? 'نشط' : 'Active'}</span>
                      : <span className="badge" style={{ background: '#f1f5f9', color: '#475569', borderColor: '#dbe2ea' }}>Disabled</span>}</td>
                    <td className="num">
                      <div className="flex" style={{ justifyContent: 'flex-end' }}>
                        <button className="btn btn-outline btn-sm" onClick={() => setUserModal(u)}>{lang === 'ar' ? 'تعديل' : 'Edit'}</button>
                        <button className={`btn btn-sm ${u.is_active ? 'btn-danger-outline' : 'btn-outline'}`} onClick={() => toggleUser(u)}>
                          {u.is_active ? (lang === 'ar' ? 'إلغاء تفعيل' : 'Deactivate') : (lang === 'ar' ? 'إعادة تفعيل' : 'Reactivate')}
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
