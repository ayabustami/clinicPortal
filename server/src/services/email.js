'use strict';
/**
 * Outbound email — pluggable transport, zero new dependencies.
 *
 * Transports (EMAIL_TRANSPORT):
 *   console (default) — logs the full message to the server console. Useful in
 *                       development/tests and as an operational fallback (the
 *                       operator can read the code from the server logs).
 *   http              — POST JSON to EMAIL_HTTP_URL with
 *                       `Authorization: Bearer EMAIL_HTTP_API_KEY`.
 *                       The payload is Resend-compatible
 *                       ({ from, to: [..], subject, text, html }), so pointing
 *                       EMAIL_HTTP_URL at https://api.resend.com/emails just
 *                       works with a Resend API key.
 *
 * EMAIL_FROM sets the From header (verified sender with your provider).
 * Sending failures are logged and reported to the caller — they never throw
 * into request handlers.
 */
const config = require('../config');

const FROM = process.env.EMAIL_FROM || 'Denti Clinics <no-reply@clinicportal.local>';
const TRANSPORT = String(
  process.env.EMAIL_TRANSPORT || (process.env.EMAIL_HTTP_URL ? 'http' : 'console')
).toLowerCase();

/** Public app origin used for links inside emails. */
function appUrl() {
  const raw = process.env.APP_URL
    || String(config.clientOrigin || '').split(',')[0].trim().replace(/\/+$/, '');
  return raw || 'http://localhost:5173';
}

async function sendMail({ to, subject, text, html }) {
  if (!to) return false;
  try {
    if (TRANSPORT === 'http') {
      const res = await fetch(process.env.EMAIL_HTTP_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.EMAIL_HTTP_API_KEY || ''}`,
        },
        body: JSON.stringify({ from: FROM, to: [to], subject, text, html }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        console.error(`[email] http transport failed: ${res.status} ${String(detail).slice(0, 300)}`);
        return false;
      }
      return true;
    }
    // console transport
    console.log(`[email:console] ----------------\nTo: ${to}\nFrom: ${FROM}\nSubject: ${subject}\n\n${text}\n----------------`);
    return true;
  } catch (err) {
    console.error('[email] send failed:', err.message);
    return false;
  }
}

/* ---------------- verification-code templates (EN + AR) ---------------- */

const PURPOSE_COPY = {
  password_reset: {
    subject: 'Your Denti Clinics password reset code',
    title: 'Password reset code',
    introEn: 'We received a request to reset the password for this email address.',
    introAr: 'تلقينا طلباً لإعادة تعيين كلمة المرور الخاصة بهذا البريد الإلكتروني.',
  },
  password_change: {
    subject: 'Confirm your Denti Clinics password change',
    title: 'Password change confirmation',
    introEn: 'A password change was requested for your account. Enter this code to confirm it is you.',
    introAr: 'تم طلب تغيير كلمة المرور لحسابك. أدخل هذا الكود لتأكيد أنك أنت.',
  },
  account_setup: {
    subject: 'Welcome to Denti Clinics — set up your account',
    title: 'Set up your account',
    introEn: 'An account has been created for you. Use this code to verify your email and set your own password.',
    introAr: 'تم إنشاء حساب لك. استخدم هذا الكود لتأكيد بريدك الإلكتروني وتعيين كلمة المرور الخاصة بك.',
  },
};

const CODE_TTL_MIN = 15;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/**
 * Send a verification-code email. Returns true when handed to the transport.
 * `purpose` selects the copy; the code itself is language-neutral.
 */
async function sendVerificationEmail({ to, code, purpose, name, clinicName }) {
  const copy = PURPOSE_COPY[purpose] || PURPOSE_COPY.password_reset;
  const who = esc(name ? `${name}` : to);
  const clinic = esc(clinicName || 'Denti Clinics');
  const loginUrl = `${appUrl()}/login?flow=reset`;
  const text = [
    copy.subject,
    '',
    `${who} — ${copy.introEn}`,
    `Your verification code: ${code}`,
    `This code expires in ${CODE_TTL_MIN} minutes and can be used once.`,
    '',
    `${copy.introAr}`,
    `رمز التحقق الخاص بك: ${code}`,
    `صالح لمدة ${CODE_TTL_MIN} دقائق ويمكن استخدامه مرة واحدة.`,
    '',
    `Set a new password: ${loginUrl}`,
    'If you did not request this, you can safely ignore this email.',
    'إذا لم تطلب هذا، يمكنك تجاهل هذا البريد بأمان.',
    '',
    `— ${clinic} · Denti Clinics Management Suite`,
  ].join('\n');

  const html = `<!doctype html>
<html dir="ltr"><head><meta charset="utf-8"><meta name="color-scheme" content="light"></head>
<body style="margin:0;padding:24px;background:#f1f5f9;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e2e8f0">
    <div style="background:linear-gradient(155deg,#0b2035,#0d3b3a);padding:22px 28px;color:#fff">
      <div style="font-size:15px;font-weight:700;letter-spacing:.2px">Denti Clinics</div>
      <div style="font-size:11.5px;color:#9db6ca;margin-top:2px">Management Suite</div>
    </div>
    <div style="padding:28px">
      <h2 style="margin:0 0 6px;font-size:18px;color:#0f172a">${esc(copy.title)}</h2>
      <p style="margin:0 0 4px;font-size:13.5px;color:#475569;line-height:1.65">${who} — ${copy.introEn}</p>
      <p style="margin:0 0 18px;font-size:13.5px;color:#475569;line-height:1.65" dir="rtl">${copy.introAr}</p>
      <div style="background:#f0fdfa;border:1px solid #99f6e4;border-radius:12px;padding:18px;text-align:center;margin:0 0 18px">
        <div style="font-size:11px;color:#0f766e;text-transform:uppercase;letter-spacing:.12em;margin-bottom:6px">Verification code · رمز التحقق</div>
        <div style="font-size:34px;font-weight:700;letter-spacing:.32em;color:#0b2035;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">${esc(code)}</div>
        <div style="font-size:11.5px;color:#64748b;margin-top:8px">Valid for ${CODE_TTL_MIN} minutes · one-time use · صالح لمدة ${CODE_TTL_MIN} دقائق</div>
      </div>
      <p style="margin:0 0 16px;font-size:12.5px;color:#64748b;line-height:1.7">
        Set a new password: <a href="${esc(loginUrl)}" style="color:#0d8f7e">${esc(loginUrl)}</a><br/>
        If you did not request this, you can safely ignore this email. · إذا لم تطلب هذا، يمكنك تجاهل هذا البريد بأمان.
      </p>
    </div>
    <div style="padding:16px 28px;border-top:1px solid #e2e8f0;font-size:11px;color:#94a3b8">
      ${clinic} · Denti Clinics Management Suite — secure clinic operations
    </div>
  </div>
</body></html>`;

  return sendMail({ to, subject: copy.subject, text, html });
}

module.exports = { sendMail, sendVerificationEmail, appUrl };
