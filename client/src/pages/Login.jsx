import React, { useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { useI18n } from '../i18n.jsx';
import { Field } from '../components/ui.jsx';
import { resolveCredentials } from '../loginCredentials.js';
import { IconTooth, IconCalendar, IconUsers, IconInvoice, IconGlobe } from '../components/icons.jsx';

const DEMO_ACCOUNTS = [
  { label: 'Receptionist', email: 'reception@alamal.demo', clinic: 'Al Amal Clinic' },
  { label: 'Doctor', email: 'lina@alamal.demo', clinic: 'Al Amal Clinic' },
  { label: 'Clinic Owner', email: 'owner@alamal.demo', clinic: 'Al Amal Clinic' },
  { label: 'Accountant', email: 'accounting@alamal.demo', clinic: 'Al Amal Clinic' },
  { label: 'Owner (2nd clinic)', email: 'owner@cedar.demo', clinic: 'Cedar Heights' },
  { label: 'Platform Admin', email: 'admin@clinicportal.local', clinic: 'Platform' },
];

export default function Login() {
  const { user, login } = useAuth();
  const { t, lang, setLang } = useI18n();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = params.get('next');
  // Only allow same-origin relative paths as the post-login destination.
  const safeNext = next && next.startsWith('/') && !next.startsWith('//') ? next : null;

  if (user) return <Navigate to={safeNext || '/'} replace />;

  async function submit(e) {
    e.preventDefault();
    setError('');
    // Read the live form values first: autofill can fill the inputs without
    // updating React state (see loginCredentials.js).
    const creds = resolveCredentials({ formData: new FormData(e.currentTarget), email, password });
    // Keep the controlled inputs in sync with what is actually submitted, so a
    // re-render after an error does not blank autofilled fields.
    setEmail(creds.email);
    setPassword(creds.password);
    if (creds.missing.length) {
      setError(t('login.missingFields'));
      return;
    }
    setBusy(true);
    try {
      const u = await login(creds.email, creds.password);
      const dest = safeNext || (u.role === 'platform_admin' ? '/admin/clinics' : u.role === 'doctor' ? '/my-day' : '/');
      navigate(dest, { replace: true });
    } catch (err) {
      setError(err.code === 'session_not_established' ? t('login.sessionBlocked') : (err.message || t('login.failed')));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <div className="login-hero">
        <div>
          <div className="brand" style={{ padding: 0, marginBottom: 34 }}>
            <div className="brand-mark"><IconTooth size={20} /></div>
            <div className="brand-text">
              <div className="t1" style={{ fontSize: 18 }}>Denti Clinics</div>
              <div className="t2" style={{ color: '#8fb0c7' }}>Management Suite</div>
            </div>
          </div>
          <h1>Run your clinic with calm, organized software.</h1>
          <p>Appointments, patients, clinical notes and billing — one secure workspace for every role in your clinic.</p>
          <div className="hero-feats">
            <div className="hero-feat"><span className="fico"><IconCalendar size={16}/></span>Google-Calendar-style scheduling with conflict protection</div>
            <div className="hero-feat"><span className="fico"><IconUsers size={16}/></span>Per-clinic data isolation for multi-location practices</div>
            <div className="hero-feat"><span className="fico"><IconInvoice size={16}/></span>Invoices, payments and reports that stay accurate</div>
          </div>
        </div>
        <div style={{ color: '#7e97ad', fontSize: 12 }}>Demo environment — all patients and staff are fictional.</div>
      </div>

      <div className="login-panel">
        <div className="login-card">
          <div className="flex-between mb-12">
            <h2 style={{ margin: 0 }}>{t('login.title')}</h2>
            <button type="button" className="btn btn-outline btn-sm" onClick={() => setLang(lang === 'ar' ? 'en' : 'ar')}>
              <IconGlobe size={15} /> {lang === 'ar' ? 'English' : 'العربية'}
            </button>
          </div>
          <div className="sub">{t('login.subtitle')}</div>
          {error && <div className="form-error" role="alert">{error}</div>}
          <form onSubmit={submit}>
            <Field label={t('login.email')}>
              <input className="input" type="email" name="email" autoComplete="username" value={email}
                inputMode="email" autoCapitalize="none" autoCorrect="off" spellCheck={false}
                onChange={(e) => setEmail(e.target.value)} placeholder="you@clinic.demo" required dir="ltr" />
            </Field>
            <Field label={t('login.password')}>
              <input className="input" type="password" name="password" autoComplete="current-password" value={password}
                autoCapitalize="none" autoCorrect="off" spellCheck={false}
                onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" required dir="ltr" />
            </Field>
            <button className="btn btn-primary btn-lg btn-block" disabled={busy}>
              {busy ? t('login.signingIn') : t('login.submit')}
            </button>
          </form>
          
        </div>
      </div>
    </div>
  );
}
