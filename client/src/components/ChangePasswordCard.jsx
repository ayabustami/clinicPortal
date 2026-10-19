import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useI18n } from '../i18n.jsx';
import { Field, useToast } from './ui.jsx';
import { IconShield } from './icons.jsx';

/**
 * Email-verified change-password card (My account + Settings).
 * Flow: "Send verification code" → emailed 6-digit code → submit current
 * password + new password + code. Success re-issues this session and signs
 * out every other session (server-enforced).
 */
export default function ChangePasswordCard({ userEmail }) {
  const { t } = useI18n();
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [pw1, setPw1] = useState('');
  const [pw2, setPw2] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [sentTo, setSentTo] = useState('');
  const [devCode, setDevCode] = useState('');
  const [deliveryIssue, setDeliveryIssue] = useState('');
  const [cooldown, setCooldown] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (cooldown <= 0) return undefined;
    const id = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(id);
  }, [cooldown]);

  async function sendCode() {
    setError(''); setSending(true); setDeliveryIssue('');
    try {
      const res = await api('/auth/change-password/request-code', { method: 'POST', body: {} });
      setSentTo(res.sent_to || userEmail || '');
      setDevCode(res.dev_code || '');
      setCooldown(60);
      const delivery = res.email_delivery || null;
      if (delivery && delivery.deliverable === false) {
        setDeliveryIssue(delivery.reason || 'misconfigured');
      } else {
        toast.success(t('sec.codeSent').replace('{email}', res.sent_to || userEmail || ''));
      }
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
    if (pw1.length < 8) { setError(t('sec.tooShort')); return; }
    if (pw1 !== pw2) { setError(t('sec.mismatch')); return; }
    setBusy(true);
    try {
      await api('/auth/change-password', {
        method: 'POST',
        body: { current_password: current, new_password: pw1, code: code.trim() },
      });
      toast.success(t('sec.success'));
      setCurrent(''); setPw1(''); setPw2(''); setCode('');
      setSentTo(''); setDevCode(''); setDeliveryIssue(''); setCooldown(0);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card card-pad">
      <div className="card-title"><IconShield size={16} /> {t('sec.title')}</div>
      <div className="muted small mb-12">{t('sec.desc')}</div>
      {error && <div className="form-error" role="alert">{error}</div>}
      {deliveryIssue && (
        <div className="form-warn" role="alert">
          {t(deliveryIssue === 'no_provider' ? 'login.mailNoProvider'
            : deliveryIssue === 'undeliverable_recipient' ? 'login.mailDemoRecipient'
              : 'login.mailMisconfigured')}
        </div>
      )}
      {devCode && (
        <div className="form-info form-info-dev" role="status">
          {t('sec.devCodeHint').replace('{code}', devCode)}
        </div>
      )}

      <form onSubmit={submit}>
        <Field label={t('sec.current')}>
          <input
            className="input" type="password" dir="ltr" required autoComplete="current-password"
            value={current} onChange={(e) => setCurrent(e.target.value)} placeholder="••••••••"
          />
        </Field>
        <div className="form-row">
          <Field label={t('sec.new')}>
            <input
              className="input" type="password" dir="ltr" required minLength={8} autoComplete="new-password"
              value={pw1} onChange={(e) => setPw1(e.target.value)} placeholder="••••••••"
            />
          </Field>
          <Field label={t('sec.confirm')}>
            <input
              className="input" type="password" dir="ltr" required minLength={8} autoComplete="new-password"
              value={pw2} onChange={(e) => setPw2(e.target.value)} placeholder="••••••••"
            />
          </Field>
        </div>

        <div className="code-row">
          <Field label={t('sec.code')}>
            <input
              className="input code-input" inputMode="numeric" dir="ltr" maxLength={6}
              autoComplete="one-time-code" placeholder="000000"
              value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            />
          </Field>
          <button
            type="button" className="btn btn-outline code-send"
            disabled={sending || cooldown > 0}
            onClick={sendCode}
          >
            {sending ? t('login.sending')
              : cooldown > 0 ? t('sec.resendIn').replace('{s}', cooldown)
                : sentTo && !deliveryIssue ? t('login.resent') : t('sec.sendCode')}
          </button>
        </div>
        {sentTo && !deliveryIssue && <div className="field-hint">{t('sec.codeSent').replace('{email}', sentTo)}</div>}

        <button className="btn btn-primary mt-12" disabled={busy}>
          {busy ? t('login.resetting') : t('sec.change')}
        </button>
      </form>
    </div>
  );
}
