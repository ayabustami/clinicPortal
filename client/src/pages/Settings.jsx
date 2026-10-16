import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useClinicMeta } from '../auth.jsx';
import { useI18n } from '../i18n.jsx';
import { Spinner, Field, useToast, useConfirm } from '../components/ui.jsx';
import { IconPlus } from '../components/icons.jsx';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const CURRENCY_NAMES = {
  ILS: 'ILS — Israeli New Shekel (₪)',
  JOD: 'JOD — Jordanian Dinar (JD)',
  USD: 'USD — US Dollar ($)',
  EUR: 'EUR — Euro (€)',
  GBP: 'GBP — Pound Sterling (£)',
  SAR: 'SAR — Saudi Riyal',
  AED: 'AED — UAE Dirham',
  EGP: 'EGP — Egyptian Pound',
};

export default function Settings() {
  const { clinic, allBranches: branches, refreshMeta } = useClinicMeta();
  const { lang } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const [settings, setSettings] = useState(null);
  const [branchesList, setBranchesList] = useState(branches);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [newBranch, setNewBranch] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const res = await api('/clinics/settings');
        setSettings(res.clinic);
      } catch (e) { setError(e.message); }
    })();
  }, []);

  useEffect(() => { setBranchesList(branches); }, [branches]);

  if (error) return <div className="page"><div className="form-error">{error}</div></div>;
  if (!settings) return <div className="page"><Spinner label={lang === 'ar' ? 'جارٍ تحميل الإعدادات…' : 'Loading settings…'} /></div>;

  const set = (k) => (e) => setSettings({ ...settings, [k]: e.target.value });
  const setDay = (day, field) => (e) => {
    const wh = { ...settings.working_hours };
    if (e.target.checked) wh[day] = { start: '08:00', end: '17:00' };
    else delete wh[day];
    setSettings({ ...settings, working_hours: wh });
  };
  const setDayTime = (day, field) => (e) => {
    const wh = { ...settings.working_hours };
    wh[day] = { ...wh[day], [field]: e.target.value };
    setSettings({ ...settings, working_hours: wh });
  };

  async function save() {
    setBusy(true); setError('');
    try {
      const { id, slug, ...body } = settings;
      await api('/clinics/settings', { method: 'PUT', body });
      await refreshMeta();
      toast.success(lang === 'ar' ? 'تم حفظ إعدادات العيادة. تم تحديث ساعات عمل التقويم.' : 'Clinic settings saved. Calendar working hours updated.');
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  async function addBranch(e) {
    e.preventDefault();
    if (!newBranch.trim()) return;
    try {
      await api('/branches', { method: 'POST', body: { name: newBranch.trim() } });
      setNewBranch('');
      await refreshMeta();
      toast.success(lang === 'ar' ? 'تمت إضافة الفرع.' : 'Branch added.');
    } catch (err) { toast.error(err.message); }
  }

  async function toggleBranch(b) {
    const ok = await confirm({
      title: b.is_active ? (lang === 'ar' ? 'إلغاء تفعيل الفرع' : 'Deactivate branch') : (lang === 'ar' ? 'إعادة تفعيل الفرع' : 'Reactivate branch'),
      message: `${b.is_active ? (lang === 'ar' ? 'إلغاء تفعيل' : 'Deactivate') : (lang === 'ar' ? 'إعادة تفعيل' : 'Reactivate')} "${b.name}"?`,
      confirmLabel: b.is_active ? (lang === 'ar' ? 'إلغاء تفعيل' : 'Deactivate') : (lang === 'ar' ? 'إعادة تفعيل' : 'Reactivate'),
      danger: b.is_active,
    });
    if (!ok) return;
    try {
      await api(`/branches/${b.id}`, { method: 'PUT', body: { is_active: !b.is_active } });
      await refreshMeta();
      toast.success(lang === 'ar' ? 'تم تحديث الفرع.' : 'Branch updated.');
    } catch (err) { toast.error(err.message); }
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{lang === 'ar' ? 'إعدادات العيادة' : 'Clinic Settings'}</h1>
          <div className="desc">{lang === 'ar' ? 'الملف الشخصي، ساعات العمل وقواعد الجدولة. يفرض التقويم هذه على الخادم.' : 'Profile, working hours and scheduling rules. The calendar enforces these on the server.'}</div>
        </div>
        <button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? (lang === 'ar' ? 'جارٍ الحفظ…' : 'Saving…') : (lang === 'ar' ? 'حفظ التغييرات' : 'Save changes')}</button>
      </div>
      {error && <div className="form-error">{error}</div>}

      <div className="grid-2">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="card card-pad">
            <div className="card-title">{lang === 'ar' ? 'ملف العيادة' : 'Clinic profile'}</div>
            <Field label={lang === 'ar' ? 'اسم العيادة' : 'Clinic name'}><input className="input" value={settings.name} onChange={set('name')} maxLength={120} /></Field>
            <div className="form-row">
              <Field label={lang === 'ar' ? 'البريد الإلكتروني' : 'Email'}><input type="email" className="input" value={settings.email || ''} onChange={set('email')} /></Field>
              <Field label={lang === 'ar' ? 'الهاتف' : 'Phone'}><input className="input" value={settings.phone || ''} onChange={set('phone')} maxLength={40} /></Field>
            </div>
            <Field label={lang === 'ar' ? 'العنوان' : 'Address'}><input className="input" value={settings.address || ''} onChange={set('address')} maxLength={200} /></Field>
            <div className="form-row">
              <Field label={lang === 'ar' ? 'المنطقة الزمنية (IANA)' : 'Timezone (IANA)'} hint={lang === 'ar' ? 'تُستخدم للتحقق من ساعات العمل.' : 'Used to validate working hours.'}>
                <input className="input" value={settings.timezone} onChange={set('timezone')} placeholder="Asia/Hebron" />
              </Field>
              <Field label={lang === 'ar' ? 'طول الموعد الافتراضي (دقائق)' : 'Default slot length (minutes)'} hint={lang === 'ar' ? '15–120، يُستخدم في شبكة الجدولة.' : '15–120, used by the scheduler grid.'}>
                <input type="number" min="15" max="120" className="input" value={settings.slot_minutes} onChange={set('slot_minutes')} />
              </Field>
            </div>
            <Field label={lang === 'ar' ? 'العملة' : 'Currency'} hint={lang === 'ar' ? 'تُطبق على الفواتير الجديدة وجميع عروض الإيرادات. الفواتير الحالية تحتفظ بعملتها.' : 'Applied to new invoices and all revenue displays. Existing invoices keep the currency they were issued with.'}>
              <select className="select" value={settings.currency || 'ILS'} onChange={set('currency')}>
                {['ILS', 'JOD', 'USD', 'EUR', 'GBP', 'SAR', 'AED', 'EGP'].map((c) => (
                  <option key={c} value={c}>{CURRENCY_NAMES[c] || c}</option>
                ))}
              </select>
            </Field>
          </div>

          <div className="card card-pad">
            <div className="card-title">{lang === 'ar' ? 'الفروع / المواقع' : 'Branches / locations'}</div>
            {branchesList.length === 0 && <div className="muted small mb-12">{lang === 'ar' ? 'لم يتم تعريف فروع بعد.' : 'No branches defined yet.'}</div>}
            {branchesList.map((b) => (
              <div key={b.id} className="flex-between" style={{ padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
                <span><b>{b.name}</b> {b.address && <span className="muted small">· {b.address}</span>}</span>
                <button className={`btn btn-sm ${b.is_active ? 'btn-danger-outline' : 'btn-outline'}`} onClick={() => toggleBranch(b)}>
                  {b.is_active ? (lang === 'ar' ? 'إلغاء تفعيل' : 'Deactivate') : (lang === 'ar' ? 'إعادة تفعيل' : 'Reactivate')}
                </button>
              </div>
            ))}
            <form onSubmit={addBranch} className="flex mt-12">
              <input className="input" placeholder={lang === 'ar' ? 'اسم فرع جديد…' : 'New branch name…'} value={newBranch} onChange={(e) => setNewBranch(e.target.value)} maxLength={120} />
              <button className="btn btn-outline" type="submit"><IconPlus size={14}/> {lang === 'ar' ? 'إضافة' : 'Add'}</button>
            </form>
          </div>
        </div>

        <div className="card card-pad">
          <div className="card-title">{lang === 'ar' ? 'ساعات العمل' : 'Working hours'}</div>
          <div className="muted small mb-12">
            {lang === 'ar' ? 'يتم رفض المواعيد خارج هذه النوافذ (بما في ذلك الأيام المغلقة). الأوقات حسب المنطقة الزمنية للعيادة.' : "Appointments are rejected outside these windows (including closed days). Times are local to the clinic's timezone."}
          </div>
          {DAYS.map((name, day) => {
            const open = !!settings.working_hours[String(day)];
            const w = settings.working_hours[String(day)] || { start: '08:00', end: '17:00' };
            return (
              <div key={day} className={`wh-row${open ? '' : ' closed'}`}>
                <span className="day">
                  <label className="flex" style={{ gap: 8 }}>
                    <input type="checkbox" checked={open} onChange={setDay(String(day))} style={{ accentColor: 'var(--accent)' }} />
                    {name}
                  </label>
                </span>
                <span className="small muted">{open ? (lang === 'ar' ? 'مفتوح' : 'Open') : (lang === 'ar' ? 'مغلق' : 'Closed')}</span>
                <input type="time" className="input" disabled={!open} value={w.start} onChange={setDayTime(String(day), 'start')} />
                <input type="time" className="input" disabled={!open} value={w.end} onChange={setDayTime(String(day), 'end')} />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
