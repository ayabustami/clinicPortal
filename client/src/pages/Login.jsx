
import React, { useEffect, useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { useI18n } from '../i18n.jsx';
import { Field } from '../components/ui.jsx';
import ForgotPassword from '../components/ForgotPassword.jsx';
import { resolveCredentials } from '../loginCredentials.js';
import {
  IconTooth,
  IconCalendar,
  IconUsers,
  IconInvoice,
  IconGlobe,
  IconMail,
  IconKey,
  IconEye,
  IconEyeOff,
  IconShield,
} from '../components/icons.jsx';

const DEMO_ACCOUNTS = [
  { label: 'Receptionist', email: 'reception@alamal.demo', clinic: 'Al Amal Clinic' },
  { label: 'Doctor', email: 'lina@alamal.demo', clinic: 'Al Amal Clinic' },
  { label: 'Clinic Owner', email: 'owner@alamal.demo', clinic: 'Al Amal Clinic' },
  { label: 'Accountant', email: 'accounting@alamal.demo', clinic: 'Al Amal Clinic' },
  { label: 'Owner (2nd clinic)', email: 'owner@cedar.demo', clinic: 'Cedar Heights' },
  { label: 'Platform Admin', email: 'admin@clinicportal.local', clinic: 'Platform' },
];

const DEMO_PASSWORD = 'Demo1234!';

export default function Login() {
  const { user, login } = useAuth();
  const { t, lang, setLang } = useI18n();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [forgotOpen, setForgotOpen] = useState(false);

  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = params.get('next');

  // Allow only safe, same-origin relative destinations.
  const safeNext =
    next && next.startsWith('/') && !next.startsWith('//')
      ? next
      : null;

  // Open the password reset modal when linked from a reset email.
  useEffect(() => {
    if (params.get('flow') === 'reset') {
      setForgotOpen(true);
    }
  }, [params]);

  if (user) {
    return <Navigate to={safeNext || '/'} replace />;
  }

  async function submit(e) {
    e.preventDefault();
    setError('');

    // Read actual form values to support browser autofill.
    const creds = resolveCredentials({
      formData: new FormData(e.currentTarget),
      email,
      password,
    });

    // Keep React state synchronized with the submitted values.
    setEmail(creds.email);
    setPassword(creds.password);

    if (creds.missing.length) {
      setError(t('login.missingFields'));
      return;
    }

    setBusy(true);

    try {
      const u = await login(creds.email, creds.password);

      const dest =
        safeNext ||
        (u.role === 'platform_admin'
          ? '/admin/clinics'
          : u.role === 'doctor'
            ? '/my-day'
            : '/');

      navigate(dest, { replace: true });
    } catch (err) {
      setError(
        err.code === 'session_not_established'
          ? t('login.sessionBlocked')
          : err.message || t('login.failed')
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <div className="login-hero">
        <div>
          <div
            className="brand"
            style={{ padding: 0, marginBottom: 34 }}
          >
            <div className="brand-mark">
              <IconTooth size={20} />
            </div>

            <div className="brand-text">
              <div className="t1" style={{ fontSize: 18 }}>
                Denti Clinics
              </div>
              <div className="t2" style={{ color: '#8fb0c7' }}>
                Management Suite
              </div>
            </div>
          </div>

          <div className="hero-eyebrow">
            {t('login.heroEyebrow')}
          </div>

          <h1>Run your clinic with calm, organized software.</h1>

          <p>
            Appointments, patients, clinical notes and billing —
            one secure workspace for every role in your clinic.
          </p>

          <div className="hero-feats">
            <div className="hero-feat">
              <span className="fico">
                <IconCalendar size={16} />
              </span>
              Google-Calendar-style scheduling with conflict protection
            </div>

            <div className="hero-feat">
              <span className="fico">
                <IconUsers size={16} />
              </span>
              Per-clinic data isolation for multi-location practices
            </div>

            <div className="hero-feat">
              <span className="fico">
                <IconInvoice size={16} />
              </span>
              Invoices, payments and reports that stay accurate
            </div>
          </div>

          <div className="hero-trust">
            <span>
              <IconShield size={14} /> {t('login.trust1')}
            </span>
            <span>
              <IconShield size={14} /> {t('login.trust2')}
            </span>
            <span>
              <IconShield size={14} /> {t('login.trust3')}
            </span>
          </div>
        </div>

        <div className="hero-foot">
          Demo environment — all patients and staff are fictional.
        </div>
      </div>

      <div className="login-panel">
        <div className="login-card">
          <div className="login-card-top">
            <div className="login-mini-brand">
              <IconTooth size={16} /> Denti Clinics
            </div>

            <button
              type="button"
              className="btn btn-outline btn-sm"
              onClick={() => setLang(lang === 'ar' ? 'en' : 'ar')}
            >
              <IconGlobe size={15} />
              {lang === 'ar' ? 'English' : 'العربية'}
            </button>
          </div>

          <h2 style={{ margin: 0 }}>{t('login.title')}</h2>
          <div className="sub">{t('login.subtitle')}</div>

          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}

          <form onSubmit={submit}>
            <Field label={t('login.email')}>
              <div className="input-wrap">
                <span className="in-ico">
                  <IconMail size={16} />
                </span>

                <input
                  className="input"
                  type="email"
                  name="email"
                  autoComplete="username"
                  inputMode="email"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@clinic.com"
                  required
                  dir="ltr"
                />
              </div>
            </Field>

            <Field label={t('login.password')}>
              <div className="input-wrap">
                <span className="in-ico">
                  <IconKey size={16} />
                </span>

                <input
                  className="input"
                  type={showPw ? 'text' : 'password'}
                  name="password"
                  autoComplete="current-password"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  required
                  dir="ltr"
                />

                <button
                  type="button"
                  className="pw-toggle"
                  aria-label={
                    showPw
                      ? t('login.hidePassword')
                      : t('login.showPassword')
                  }
                  aria-pressed={showPw}
                  onClick={() => setShowPw((v) => !v)}
                >
                  {showPw
                    ? <IconEyeOff size={16} />
                    : <IconEye size={16} />}
                </button>
              </div>
            </Field>

            <div className="login-forgot-row">
              <button
                type="button"
                className="link-btn"
                onClick={() => setForgotOpen(true)}
              >
                {t('login.forgot')}
              </button>
            </div>

            <button
              type="submit"
              className="btn btn-primary btn-lg btn-block"
              disabled={busy}
            >
              {busy
                ? t('login.signingIn')
                : t('login.submit')}
            </button>
          </form>

          <div className="login-help">{t('login.help')}</div>

          <details className="demo-accounts">
            <summary>{t('login.demoHint')}</summary>

            <div className="demo-chip-list">
              {DEMO_ACCOUNTS.map((d) => (
                <button
                  key={d.email}
                  type="button"
                  className="demo-chip"
                  title={`${d.email} · ${DEMO_PASSWORD}`}
                  onClick={() => {
                    setEmail(d.email);
                    setPassword(DEMO_PASSWORD);
                    setError('');
                  }}
                >
                  <b>{d.label}</b>
                  <span className="muted small">{d.clinic}</span>
                </button>
              ))}
            </div>
          </details>

          <div className="login-foot">
            © {new Date().getFullYear()} Denti Clinics — Management Suite
          </div>
        </div>
      </div>

      {forgotOpen && (
        <ForgotPassword
          initialEmail={email}
          onClose={() => {
            setForgotOpen(false);
            setError('');
          }}
        />
      )}
    </div>
  );
}
