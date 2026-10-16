import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth, useClinicMeta } from '../auth.jsx';
import { useI18n } from '../i18n.jsx';
import { Spinner, EmptyState, Modal, Field, useToast, useConfirm } from '../components/ui.jsx';
import { money } from '../format.js';
import { IconPlus } from '../components/icons.jsx';

const CATEGORIES = ['Preventive', 'Restorative', 'Endodontics', 'Surgical', 'Prosthetics', 'Orthodontics', 'Periodontics', 'Consultation'];

const WORKFLOW_FLAGS = [
  ['requires_encounter', 'Clinical note (encounter)'],
  ['requires_chart', 'Odontogram update'],
  ['requires_plan_item', 'Treatment plan item'],
  ['requires_performed', 'Performed-procedure record'],
  ['requires_imaging', 'Imaging / radiology'],
  ['requires_followup', 'Follow-up'],
  ['bills_item', 'Billable invoice item'],
];
const WF_AR = {
  'Clinical note (encounter)': 'ملاحظة سريرية (لقاء)',
  'Odontogram update': 'تحديث مخطط الأسنان',
  'Treatment plan item': 'بند خطة علاج',
  'Performed-procedure record': 'سجل إجراء منفذ',
  'Imaging / radiology': 'التصوير / الأشعة',
  'Follow-up': 'متابعة',
  'Billable invoice item': 'بند فاتورة قابل للفوترة',
};

/**
 * Services catalog management (P8.1 + Stage I configuration). The catalog is
 * the single DB-driven source for booking rules: durations, prices and the
 * per-service workflow requirement flags. Edits and activation are owner-only
 * (server-enforced); deactivation never erases booked history or snapshots.
 */
function ServiceModal({ service, onClose, onSaved }) {
  const toast = useToast();
  const { lang } = useI18n();
  const [f, setF] = useState({
    name: service?.name || '',
    duration_min: service?.duration_min ?? 30,
    price: service ? (service.price_cents / 100).toFixed(2) : '',
    category: service?.category || '',
    preparation: service?.preparation || '',
    provider_qualification: service?.provider_qualification || '',
    requires_encounter: service ? !!service.requires_encounter : true,
    requires_chart: service ? !!service.requires_chart : false,
    requires_plan_item: service ? !!service.requires_plan_item : false,
    requires_performed: service ? !!service.requires_performed : false,
    requires_imaging: service ? !!service.requires_imaging : false,
    requires_followup: service ? !!service.requires_followup : false,
    bills_item: service ? !!service.bills_item : true,
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault(); setBusy(true); setError('');
    try {
      const body = {
        name: f.name, duration_min: Number(f.duration_min), price: f.price === '' ? '0' : f.price,
        category: f.category, preparation: f.preparation, provider_qualification: f.provider_qualification,
        requires_encounter: f.requires_encounter, requires_chart: f.requires_chart,
        requires_plan_item: f.requires_plan_item, requires_performed: f.requires_performed,
        requires_imaging: f.requires_imaging, requires_followup: f.requires_followup, bills_item: f.bills_item,
      };
      if (service) await api(`/services/${service.id}`, { method: 'PUT', body });
      else await api('/services', { method: 'POST', body });
      toast.success(service ? (lang === 'ar' ? 'تم تحديث الخدمة.' : 'Service updated.') : (lang === 'ar' ? 'تمت إضافة الخدمة.' : 'Service added.'));
      onSaved();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  return (
    <Modal title={service ? (lang === 'ar' ? 'تعديل خدمة' : 'Edit service') : (lang === 'ar' ? 'إضافة خدمة' : 'Add service')} onClose={onClose}
      footer={<><button className="btn btn-outline" onClick={onClose}>{lang === 'ar' ? 'إلغاء' : 'Cancel'}</button>
        <button className="btn btn-primary" onClick={submit} disabled={busy}>{busy ? (lang === 'ar' ? 'جارٍ الحفظ…' : 'Saving…') : (lang === 'ar' ? 'حفظ' : 'Save')}</button></>}>
      {error && <div className="form-error">{error}</div>}
      <Field label={lang === 'ar' ? 'اسم الخدمة' : 'Service name'} required><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={120} placeholder={lang === 'ar' ? 'مثال: استشارة عامة' : 'e.g. General consultation'} /></Field>
      <div className="form-row">
        <Field label={lang === 'ar' ? 'المدة الافتراضية (دقائق)' : 'Default duration (minutes)'} required hint={lang === 'ar' ? 'تُستخدم لملء طول الموعد مسبقاً.' : 'Used to pre-fill appointment length.'}>
          <input type="number" min="5" max="480" className="input" value={f.duration_min} onChange={(e) => setF({ ...f, duration_min: e.target.value })} required />
        </Field>
        <Field label={lang === 'ar' ? 'السعر' : 'Price'} required hint={lang === 'ar' ? 'المبلغ المفروض افتراضياً لهذه الخدمة.' : 'Amount charged by default for this service.'}>
          <input className="input" placeholder="0.00" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} required />
        </Field>
      </div>
      <div className="form-row">
        <Field label={lang === 'ar' ? 'الفئة' : 'Category'} hint={lang === 'ar' ? 'تجميع الكتالوج (مثال: وقائي، ترميمي، جراحي).' : 'Groups the catalog (e.g. Preventive, Restorative, Surgical).'}>
          <input className="input" list="service-categories" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} maxLength={60} placeholder={lang === 'ar' ? 'مثال: ترميمي' : 'e.g. Restorative'} />
          <datalist id="service-categories">{CATEGORIES.map((c) => <option key={c} value={c} />)}</datalist>
        </Field>
        <Field label={lang === 'ar' ? 'المؤهل المطلوب' : 'Provider qualification'} hint={lang === 'ar' ? 'من يمكنه أداء هذه الخدمة.' : 'Who may perform this service.'}>
          <input className="input" value={f.provider_qualification} onChange={(e) => setF({ ...f, provider_qualification: e.target.value })} maxLength={120} placeholder={lang === 'ar' ? 'مثال: طبيب أسنان' : 'e.g. Dentist'} />
        </Field>
      </div>
      <Field label={lang === 'ar' ? 'التحضير' : 'Preparation'} hint={lang === 'ar' ? 'يظهر للموظفين عند حجز هذه الخدمة (صيام، مراجعة تخدير، تصوير à apporter…).' : 'Shown to staff when this service is booked (fasting, anesthesia review, imaging to bring…).'}>
        <input className="input" value={f.preparation} onChange={(e) => setF({ ...f, preparation: e.target.value })} maxLength={500} placeholder={lang === 'ar' ? 'مثال: مراجعة خيارات التخدير' : 'e.g. Review anesthesia options'} />
      </Field>
      <fieldset className="fieldset" style={{ border: '1px solid var(--line)', borderRadius: 10, padding: '10px 12px', margin: '4px 0 2px' }}>
        <legend style={{ fontSize: 12, color: 'var(--muted)', padding: '0 6px' }}>{lang === 'ar' ? 'متطلبات سير العمل' : 'Workflow requirements'}</legend>
        <div className="flex" style={{ flexWrap: 'wrap', gap: '8px 18px' }}>
          {WORKFLOW_FLAGS.map(([key, label]) => (
            <label key={key} className="flex" style={{ gap: 6, alignItems: 'center', fontSize: 13, cursor: 'pointer' }}>
              <input type="checkbox" checked={!!f[key]} onChange={(e) => setF({ ...f, [key]: e.target.checked })} />
              {lang === 'ar' ? (WF_AR[label] || label) : label}
            </label>
          ))}
        </div>
      </fieldset>
    </Modal>
  );
}

export default function Services() {
  const { user } = useAuth();
  const { refreshMeta } = useClinicMeta();
  const { lang } = useI18n();
  const [services, setServices] = useState(null);
  const [error, setError] = useState('');
  const [modal, setModal] = useState(null); // null | 'new' | service object
  const toast = useToast();
  const confirm = useConfirm();
  const isOwner = user.role === 'owner';
  const canAdd = user.role === 'owner'; // service catalog is management-only

  async function load() {
    try { setServices((await api('/services')).services); setError(''); }
    catch (e) { setError(e.message); }
  }
  useEffect(() => { load(); }, []);

  async function toggle(s) {
    const ok = await confirm({
      title: s.is_active ? (lang === 'ar' ? 'إلغاء تفعيل الخدمة' : 'Deactivate service') : (lang === 'ar' ? 'إعادة تفعيل الخدمة' : 'Reactivate service'),
      message: `${s.is_active ? (lang === 'ar' ? 'إلغاء تفعيل' : 'Deactivate') : (lang === 'ar' ? 'إعادة تفعيل' : 'Reactivate')} "${s.name}"? ${s.is_active ? (lang === 'ar' ? 'لن تتمكن من اختيارها لمواعيد جديدة.' : 'It can no longer be selected for new appointments.') : (lang === 'ar' ? 'ستصبح قابلة للحجز مرة أخرى.' : 'It becomes bookable again.')}`,
      confirmLabel: s.is_active ? (lang === 'ar' ? 'إلغاء تفعيل' : 'Deactivate') : (lang === 'ar' ? 'إعادة تفعيل' : 'Reactivate'),
      danger: s.is_active,
    });
    if (!ok) return;
    try {
      await api(`/services/${s.id}`, { method: 'PUT', body: { is_active: !s.is_active } });
      toast.success(lang === 'ar' ? 'تم تحديث الخدمة.' : 'Service updated.');
      load(); refreshMeta();
    } catch (e) { toast.error(e.message); }
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{lang === 'ar' ? 'الخدمات' : 'Services'}</h1>
          <div className="desc">{lang === 'ar' ? 'كتالوج خدمات العيادة: المدد والأسعار الافتراضية المستخدمة في الجدولة والفوترة.' : "The clinic's service catalog: default durations and prices used across scheduling and billing."}</div>
        </div>
        {canAdd && <button className="btn btn-primary" onClick={() => setModal('new')}><IconPlus size={16}/> {lang === 'ar' ? 'إضافة خدمة' : 'Add service'}</button>}
      </div>

      <div className="card">
        {error && <div className="form-error" style={{ margin: 14 }}>{error}</div>}
        {!services ? <Spinner label={lang === 'ar' ? 'جارٍ تحميل الخدمات…' : 'Loading services…'} /> : services.length === 0 ? (
          <EmptyState icon="🩺" title={lang === 'ar' ? 'لا توجد خدمات بعد' : 'No services yet'}>{lang === 'ar' ? 'أضف الخدمات التي تقدمها هذه العيادة.' : 'Add the services this clinic offers.'}</EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>{lang === 'ar' ? 'الخدمة' : 'Service'}</th><th className="hide-sm">{lang === 'ar' ? 'الفئة' : 'Category'}</th><th className="num hide-sm">{lang === 'ar' ? 'المدة' : 'Duration'}</th><th className="num">{lang === 'ar' ? 'السعر' : 'Price'}</th><th>{lang === 'ar' ? 'الحالة' : 'Status'}</th><th></th></tr></thead>
              <tbody>
                {services.map((s) => (
                  <tr key={s.id} style={{ opacity: s.is_active ? 1 : 0.55 }}>
                    <td><b>{s.name}</b></td>
                    <td className="hide-sm">{s.category || <span style={{ color: 'var(--muted)' }}>—</span>}</td>
                    <td className="num hide-sm">{s.duration_min} {lang === 'ar' ? 'دقيقة' : 'min'}</td>
                    <td className="num mono">{s.price_cents === null ? '—' : money(s.price_cents)}</td>
                    <td>{s.is_active
                      ? <span className="badge" style={{ background: 'var(--ok-soft)', color: 'var(--ok)', borderColor: '#d5e8b2' }}>{lang === 'ar' ? 'نشط' : 'Active'}</span>
                      : <span className="badge" style={{ background: '#f1f5f9', color: '#475569', borderColor: '#dbe2ea' }}>{lang === 'ar' ? 'غير نشط' : 'Inactive'}</span>}</td>
                    <td className="num">
                      {isOwner && (
                        <div className="flex" style={{ gap: 6, justifyContent: 'flex-end' }}>
                          <button className="btn btn-sm btn-outline" onClick={() => setModal(s)}>{lang === 'ar' ? 'تعديل' : 'Edit'}</button>
                          <button className={`btn btn-sm ${s.is_active ? 'btn-danger-outline' : 'btn-outline'}`} onClick={() => toggle(s)}>
                            {s.is_active ? (lang === 'ar' ? 'إلغاء تفعيل' : 'Deactivate') : (lang === 'ar' ? 'إعادة تفعيل' : 'Reactivate')}
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {modal && (
        <ServiceModal
          service={modal === 'new' ? null : modal}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); load(); refreshMeta(); }}
        />
      )}
    </div>
  );
}
