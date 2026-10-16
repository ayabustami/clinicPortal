import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { DateTime } from 'luxon';
import { api } from '../api.js';
import { useAuth, useClinicMeta } from '../auth.jsx';
import { useI18n } from '../i18n.jsx';
import { Spinner, EmptyState, StatusBadge, useToast } from '../components/ui.jsx';
import { fmtTime, STATUS_META } from '../format.js';
import { IconFileText, IconInvoice, IconCheck, IconClock } from '../components/icons.jsx';

/**
 * "My Day" — the doctor's personal queue for today in the clinic's timezone.
 * One screen: what's booked, who's checked in, who's in the room, and the
 * one-click path into the clinical note and visit completion.
 */
export default function MyDay() {
  const { user } = useAuth();
  const { clinic, doctorProfile } = useClinicMeta();
  const { lang } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const [appts, setAppts] = useState(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);

  const tz = clinic?.timezone || 'local';
  const today = DateTime.now().setZone(tz);

  const load = useCallback(async () => {
    if (!doctorProfile) return;
    setError('');
    try {
      const start = today.startOf('day').toUTC().toISO();
      const end = today.plus({ days: 1 }).startOf('day').toUTC().toISO();
      const res = await api(`/appointments?doctor_id=${doctorProfile.id}&start=${start}&end=${end}`);
      setAppts(res.appointments);
    } catch (e) { setError(e.message); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doctorProfile?.id, tz, today.toISODate()]);

  useEffect(() => { load(); }, [load]);

  if (user.role !== 'doctor' || !doctorProfile) {
    return (
      <div className="page">
        <EmptyState icon="🩺" title={lang === 'ar' ? 'للأطباء فقط' : 'Doctors only'}>
          {lang === 'ar' ? '«يومي» هو قائمة الانتظار الشخصية لحسابات الأطباء المرتبطة بملف طبيب.' : 'My Day is the personal queue for doctor accounts linked to a doctor profile.'}
        </EmptyState>
      </div>
    );
  }

  async function setStatus(a, status) {
    setBusyId(a.id);
    try {
      await api(`/appointments/${a.id}/status`, { method: 'PATCH', body: { status } });
      toast.success(`${a.patient_name}: ${STATUS_META[status].label.toLowerCase()}.`);
      load();
    } catch (e) { toast.error(e.message); } finally { setBusyId(null); }
  }

  const active = (appts || []).filter((a) => !['cancelled', 'no_show'].includes(a.status));
  const counts = {
    booked: active.filter((a) => ['scheduled', 'confirmed'].includes(a.status)).length,
    waiting: active.filter((a) => a.status === 'checked_in').length,
    withYou: active.filter((a) => a.status === 'in_progress').length,
    done: active.filter((a) => a.status === 'completed').length,
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{lang === 'ar' ? 'يومي' : 'My Day'} · {doctorProfile.name}</h1>
          <div className="desc">{lang === 'ar' ? today.toFormat('cccc, d LLLL yyyy') : today.toFormat('cccc, d LLLL yyyy')} · {tz.replace('_', ' ')}</div>
        </div>
      </div>

      <div className="stat-grid mb-12">
        {[[lang === 'ar' ? 'محجوز' : 'Booked', counts.booked, '#3b82f6'], [lang === 'ar' ? 'انتظار' : 'Waiting', counts.waiting, '#f59e0b'], [lang === 'ar' ? 'معك' : 'With you', counts.withYou, '#8b5cf6'], [lang === 'ar' ? 'مكتمل' : 'Completed', counts.done, '#65a30d']].map(([lbl, v, c]) => (
          <div key={lbl} className="card stat-card">
            <span className="stat-ico" style={{ background: `${c}1a`, color: c }}><IconClock /></span>
            <span className="lbl">{lbl}</span>
            <span className="val">{v}</span>
          </div>
        ))}
      </div>

      <div className="card">
        {error && <div className="form-error" style={{ margin: 14 }}>{error}</div>}
        {!error && (!appts ? <Spinner label={lang === 'ar' ? 'جارٍ تحميل يومك…' : 'Loading your day…'} /> : active.length === 0 ? (
          <EmptyState icon="🗓" title={lang === 'ar' ? 'لا توجد مواعيد اليوم' : 'No appointments today'}>{lang === 'ar' ? 'استمتع بالهدوء.' : 'Enjoy the quiet.'}</EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>{lang === 'ar' ? 'الوقت' : 'Time'}</th><th>{lang === 'ar' ? 'المريض' : 'Patient'}</th><th className="hide-sm">{lang === 'ar' ? 'الخدمة' : 'Service'}</th><th>{lang === 'ar' ? 'الحالة' : 'Status'}</th><th></th></tr></thead>
              <tbody>
                {active.map((a) => (
                  <tr key={a.id}>
                    <td className="mono"><b>{fmtTime(a.start_at)}</b><div className="muted small">{a.duration_min} min</div></td>
                    <td><b>{a.patient_name}</b></td>
                    <td className="hide-sm">{a.service_name || '—'}</td>
                    <td><StatusBadge status={a.status} /></td>
                    <td className="num">
                      <div className="flex" style={{ gap: 6, justifyContent: 'flex-end' }}>
                        {['scheduled', 'confirmed'].includes(a.status) && (
                          <button className="btn btn-sm btn-outline" disabled={busyId === a.id} onClick={() => setStatus(a, 'checked_in')}>{lang === 'ar' ? 'تسجيل وصول' : 'Check in'}</button>
                        )}
                        {a.status === 'checked_in' && (
                          <button className="btn btn-sm btn-primary" disabled={busyId === a.id} onClick={() => setStatus(a, 'in_progress')}>{lang === 'ar' ? 'بدء الزيارة' : 'Start visit'}</button>
                        )}
                        {a.status === 'in_progress' && (
                          <>
                            <button className="btn btn-sm btn-outline" onClick={() => navigate(`/records?patient_id=${a.patient_id}&appointment_id=${a.id}&new=1`)}>
                              <IconFileText size={14}/> {lang === 'ar' ? 'ملاحظة' : 'Note'}
                            </button>
                            <button className="btn btn-sm btn-primary" disabled={busyId === a.id} onClick={() => setStatus(a, 'completed')}>
                              <IconCheck size={14}/> {lang === 'ar' ? 'إكمال' : 'Complete'}
                            </button>
                          </>
                        )}
                        {a.status === 'completed' && (
                          <button className="btn btn-sm btn-outline" onClick={() => navigate(`/records?patient_id=${a.patient_id}`)}>
                            <IconFileText size={14}/> {lang === 'ar' ? 'السجلات' : 'Records'}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
      <div className="muted small" style={{ marginTop: 10 }}>
        <IconInvoice size={13} /> {lang === 'ar' ? 'تُعالج الفوترة من قبل موظفي الاستقبال — إكمال الزيارة يُحدّث قائمتهم.' : 'Invoicing is handled by the front desk — completing a visit keeps their queue up to date.'}
      </div>
    </div>
  );
}
