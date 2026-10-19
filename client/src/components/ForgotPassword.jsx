import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useI18n } from '../i18n.jsx';
import { Modal, Field } from './ui.jsx';
import { IconMail } from './icons.jsx';

/**
 * Forgot-password flow (single form, works from the login page or via the
 * ?flow=reset deep link inside a setup/reset email):
 *   1. enter the account email → "Send verification code"
 *   2. enter the code + a new password → "Reset password"
 * The server accepts codes issued for password reset AND first-time account
 * setup, so one surface covers both.
 */
export default function ForgotPassword({ initialEmail = '', onClose }) {
  const { t } = useI18n();
  const [email, setEmail] = useState(initialEmail);
  const [code, setCode] = useState('');
  const [pw1, setPw1] = useState('');
  const [pw2, setPw2] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [sentTo, setSentTo] = useState('');
  const [devCode, setDevCode] = useState('');
  const [deliveryIssue, setDeliveryIssue] = useState('');
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return undefined;
    const id = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(id);
  }, [cooldown]);

  async function sendCode() {
    if (!email.trim()) { setError(t('login.email')); return; }
    setError(''); setSending(true); setDeliveryIssue('');
    try {
      const res = await api('/auth/forgot-password', { method: 'POST', body: { email: email.trim() } });
      setSentTo(res.sent_to || email.trim());
      setDevCode(res.dev_code || '');
      const delivery = res.email_delivery || null;
      if (delivery && delivery.deliverable === false) {
        // Never claim "sent" when the server could not hand the message to a
        // mail provider (or the address is a demo/reserved domain).
        setInfo('');
        setDeliveryIssue(delivery.reason || 'misconfigured');
      } else {
        setInfo(t('login.codeSent').replace('{email}', res.sent_to || email.trim()));
      }
      setCooldown(60);
    } catch (err) {
      setError(err.message);
    } finally {
      setSending(false);
    }
  }

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (!/^\d{6}$/.test(code.trim())) { setError(t('login.codeRequired')); return; }
    if (pw1.length < 8) { setError(t('login.passwordTooShort')); return; }
    if (pw1 !== pw2) { setError(t('login.passwordMismatch')); return; }
    setBusy(true);
    try {
      await api('/auth/reset-password', {
        method: 'POST',
        body: { email: email.trim(), code: code.trim(), new_password: pw1 },
      });
      setDone(true);
      setInfo('');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={t('login.forgotTitle')}
      onClose={onClose}
      footer={
        done ? (
          <button className="btn btn-primary" onClick={onClose}>{t('login.backToSignIn')}</button>
        ) : (
          <>
            <button type="button" className="btn btn-outline" onClick={onClose}>{t('visit.cancel')}</button>
            <button type="submit" form="forgot-pw-form" className="btn btn-primary" disabled={busy || sending}>
              {busy ? t('login.resetting') : t('login.resetSubmit')}
            </button>
          </>
        )
      }
    >
      {done ? (
        <div className="form-success" role="status">{t('login.resetDone')}</div>
      ) : (
        <form id="forgot-pw-form" onSubmit={submit}>
          <div className="muted small mb-12">{t('login.forgotSub')}</div>
          {error && <div className="form-error" role="alert">{error}</div>}
          {deliveryIssue && (
            <div className="form-warn" role="alert">
              {t(deliveryIssue === 'no_provider' ? 'login.mailNoProvider'
                : deliveryIssue === 'undeliverable_recipient' ? 'login.mailDemoRecipient'
                  : 'login.mailMisconfigured')}
            </div>
          )}
          {info && <div className="form-info" role="status">{info}</div>}
          {devCode && (
            <div className="form-info form-info-dev" role="status">
              {t('login.devCodeHint').replace('{code}', devCode)}
            </div>
          )}

          <Field label={t('login.email')}>
            <div className="input-wrap">
              <span className="in-ico"><IconMail size={16} /></span>
              <input
                className="input" type="email" autoComplete="username" dir="ltr" required
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setDeliveryIssue('');
                  setInfo('');
                  setSentTo('');
                  setDevCode('');
                }}
                placeholder="you@clinic.com"
              />
            </div>
          </Field>

          <div className="code-row">
            <Field label={t('login.code')}>
              <input
                className="input code-input" inputMode="numeric" dir="ltr" maxLength={6}
                autoComplete="one-time-code" placeholder="000000"
                value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              />
            </Field>
            <button
              type="button" className="btn btn-outline code-send"
              disabled={sending || cooldown > 0 || !email.trim()}
              onClick={sendCode}
            >
              {sending ? t('login.sending')
                : cooldown > 0 ? t('login.resendIn').replace('{s}', cooldown)
                  : sentTo && !deliveryIssue ? t('login.resent') : t('login.sendCode')}
            </button>
          </div>
          {sentTo && !deliveryIssue && <div className="field-hint">{t('login.codeSent').replace('{email}', sentTo)}</div>}

          <div className="form-row">
            <Field label={t('login.newPassword')}>
              <input
                className="input" type="password" dir="ltr" required minLength={8}
                autoComplete="new-password" placeholder="••••••••"
                value={pw1} onChange={(e) => setPw1(e.target.value)}
              />
            </Field>
            <Field label={t('login.confirmPassword')}>
              <input
                className="input" type="password" dir="ltr" required minLength={8}
                autoComplete="new-password" placeholder="••••••••"
                value={pw2} onChange={(e) => setPw2(e.target.value)}
              />
            </Field>
          </div>
        </form>
      )}
    </Modal>
  );
}
