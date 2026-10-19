'use strict';
/**
 * Outbound email — pluggable transport, zero new dependencies.
 *
 * Transports (EMAIL_TRANSPORT):
 *   console (default) — logs the full message to the server console. This does
 *                       NOT deliver anything to a real inbox. It is useful in
 *                       development/tests and as an operational fallback (the
 *                       operator can read the code from the service logs).
 *   http              — POST JSON to EMAIL_HTTP_URL with
 *                       `Authorization: Bearer EMAIL_HTTP_API_KEY`.
 *                       The payload is Resend-compatible
 *                       ({ from, to: [..], subject, text, html }), so pointing
 *                       EMAIL_HTTP_URL at https://api.resend.com/emails just
 *                       works with a Resend API key.
 *   smtp              — nodemailer with SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS.
 *                       NOTE: Render blocks outbound ports 25/465/587 on free
 *                       services (port 25 is blocked on every plan), so SMTP
 *                       never works there. Use the http transport instead.
 *
 * EMAIL_FROM sets the From header and must be a sender verified with your
 * provider (for Resend: `Denti Clinics <no-reply@your-verified-domain>`).
 *
 * `emailStatus()` / `logEmailConfig()` make misconfiguration visible instead of
 * silently pretending a message was sent; the `/api/health` endpoint exposes a
 * safe subset so an operator can confirm delivery readiness without the logs.
 */
const config = require('../config');
const nodemailer = require('nodemailer');

const DEFAULT_FROM_NAME = 'Denti Clinics';
const HTTP_TIMEOUT_MS = 15000;
const SMTP_TIMEOUT_MS = 15000;

function env(name) {
  return String(process.env[name] || '').trim();
}

function isRender() {
  return env('RENDER') === 'true' || !!env('RENDER_SERVICE_ID');
}

/**
 * Domains that can never receive mail: RFC 2606/6761 reserved names plus the
 * `.demo` pseudo-TLD used by the seeded demo accounts (owner@alamal.demo …).
 * Sending to them is a guaranteed bounce (and wastes provider quota).
 */
function undeliverableReason(address) {
  const s = String(address || '').trim().toLowerCase();
  const at = s.lastIndexOf('@');
  if (at <= 0 || at === s.length - 1) return 'not a valid email address';
  const domain = s.slice(at + 1).replace(/\.$/, '');
  if (
    domain === 'example.com' || domain === 'example.org' || domain === 'example.net'
    || ['.demo', '.local', '.localhost', '.test', '.invalid', '.example'].some((tld) => domain.endsWith(tld))
  ) {
    return `"${domain}" is a demo/reserved domain with no real inbox`;
  }
  return null;
}

function transportName() {
  const explicit = env('EMAIL_TRANSPORT').toLowerCase();
  if (explicit) return explicit;
  return env('EMAIL_HTTP_URL') ? 'http' : 'console';
}

function fromAddress() {
  return env('EMAIL_FROM') || env('SMTP_USER') || DEFAULT_FROM_NAME;
}

/** Public app origin used for links inside emails. */
function appUrl() {
  const raw = env('APP_URL')
    || String(config.clientOrigin || '').split(',')[0].trim().replace(/\/+$/, '');
  return raw || 'http://localhost:5173';
}

/**
 * Current mail configuration. `delivers` is true only when a real provider is
 * configured well enough to accept the message. `problems` are blocking,
 * `warnings` are non-blocking advice (e.g. SMTP on Render, localhost APP_URL).
 */
function emailStatus() {
  const transport = transportName();
  const from = fromAddress();
  const problems = [];
  const warnings = [];

  if (transport === 'http') {
    const url = env('EMAIL_HTTP_URL');
    if (!url) {
      problems.push('EMAIL_HTTP_URL is not set (for Resend use https://api.resend.com/emails)');
    } else {
      try {
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('bad protocol');
      } catch {
        problems.push('EMAIL_HTTP_URL is not a valid http(s) URL');
      }
    }
    if (!env('EMAIL_HTTP_API_KEY')) problems.push('EMAIL_HTTP_API_KEY is not set');
  } else if (transport === 'smtp') {
    if (!env('SMTP_HOST')) problems.push('SMTP_HOST is not set');
    if (!env('SMTP_USER')) problems.push('SMTP_USER is not set');
    if (!env('SMTP_PASS')) problems.push('SMTP_PASS is not set');
    if (isRender()) {
      warnings.push('Render blocks outbound SMTP ports 25, 465 and 587 on free services (port 25 on every plan) — SMTP will time out. Use EMAIL_TRANSPORT=http with a provider HTTP API (Resend) instead.');
    }
  } else if (transport === 'console') {
    problems.push('No mail provider configured (EMAIL_TRANSPORT=console): verification codes are printed to the server log only and are never emailed. Set EMAIL_TRANSPORT=http, EMAIL_HTTP_URL=https://api.resend.com/emails, EMAIL_HTTP_API_KEY=re_… and EMAIL_FROM="Denti Clinics <no-reply@your-verified-domain>".');
  } else {
    problems.push(`Unknown EMAIL_TRANSPORT "${transport}" (expected console, http or smtp)`);
  }

  if (transport !== 'console' && !/@/.test(from)) {
    problems.push('EMAIL_FROM must be a full sender address, e.g. "Denti Clinics <no-reply@your-verified-domain>"');
  }

  if (config.env === 'production' && /(^|[/:.])(localhost|127\.0\.0\.1)([:/]|$)/.test(appUrl())) {
    warnings.push(`APP_URL resolves to ${appUrl()} — reset links inside emails will not work for users. Set APP_URL to the public https origin.`);
  }

  return {
    transport,
    from,
    delivers: (transport === 'http' || transport === 'smtp') && problems.length === 0,
    problems,
    warnings,
  };
}

/** One startup log line (plus details) so a broken mail setup is obvious. */
function logEmailConfig() {
  const s = emailStatus();
  const from = /@/.test(s.from) ? s.from : `"${s.from}" (not an address)`;
  if (s.delivers) {
    console.log(`[email] transport=${s.transport} from=${from} — outbound email enabled`);
  } else {
    console.warn(`[email] transport=${s.transport} from=${from} — OUTBOUND EMAIL IS NOT DELIVERED`);
    for (const p of s.problems) console.warn(`[email]   problem: ${p}`);
  }
  for (const w of s.warnings) console.warn(`[email]   warning: ${w}`);
}

function maskEmail(email) {
  const s = String(email || '');
  const at = s.indexOf('@');
  if (at <= 0) return '***';
  return `${s[0]}${'*'.repeat(Math.max(1, Math.min(4, at - 1)))}${s.slice(at)}`;
}

let smtpTransporter;
let smtpKey;

function getSmtpTransporter() {
  const host = env('SMTP_HOST');
  const port = Number(env('SMTP_PORT') || 587);
  const user = env('SMTP_USER');
  const pass = env('SMTP_PASS');
  const key = `${host}:${port}:${user}:${pass ? pass.length : 0}`;
  if (smtpTransporter && smtpKey === key) return smtpTransporter;

  if (!host || !user || !pass) {
    throw new Error('SMTP configuration is incomplete');
  }

  smtpTransporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    requireTLS: port === 587,
    auth: { user, pass },
    // Blocked SMTP ports blackhole the SYN instead of refusing it, so without
    // explicit timeouts a request would hang for nodemailer's 2-minute default.
    connectionTimeout: SMTP_TIMEOUT_MS,
    greetingTimeout: SMTP_TIMEOUT_MS,
    socketTimeout: SMTP_TIMEOUT_MS * 2,
  });
  smtpKey = key;
  return smtpTransporter;
}

async function postJsonHttp(payload) {
  const url = env('EMAIL_HTTP_URL');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env('EMAIL_HTTP_API_KEY')}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`provider responded ${res.status}: ${String(detail).slice(0, 300)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Send one message. Returns true only when the configured transport accepted
 * it. Never throws into request handlers.
 */
async function sendMail({ to, subject, text, html }) {
  if (!to) return false;
  const status = emailStatus();
  const demo = undeliverableReason(to);

  if (status.transport === 'console') {
    // The console transport is the documented fallback: the whole message
    // (including the verification code) goes to the log so the operator can
    // still complete the flow.
    console.log(
      `[email:console] ----------------\nTo: ${to}\nFrom: ${status.from}\nSubject: ${subject}\n` +
      `${demo ? `NOTE: ${demo} — this message will never reach an inbox.\n` : ''}\n${text}\n----------------`
    );
    if (config.env === 'production') {
      console.warn('[email] NOT DELIVERED — EMAIL_TRANSPORT=console (no mail provider configured). The code above is only available in these server logs.');
    }
    return true;
  }

  if (!status.delivers) {
    console.error(`[email] not sent to ${maskEmail(to)}: ${status.problems.join(' | ')}`);
    return false;
  }

  if (demo) {
    // A real provider would accept this and bounce asynchronously; refusing up
    // front keeps the API honest and avoids burning sender reputation/quota.
    console.error(`[email] not sent to ${maskEmail(to)}: ${demo}`);
    return false;
  }

  try {
    if (status.transport === 'http') {
      await postJsonHttp({ from: status.from, to: [to], subject, text, html });
    } else {
      await getSmtpTransporter().sendMail({ from: status.from, to, subject, text, html });
    }
    console.log(`[email] sent via ${status.transport} to ${maskEmail(to)}`);
    return true;
  } catch (err) {
    const reason = err && err.name === 'AbortError'
      ? `timed out after ${HTTP_TIMEOUT_MS / 1000}s`
      : (err && err.message) || String(err);
    console.error(`[email] send failed via ${status.transport}: ${reason}`);
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

module.exports = {
  sendMail,
  sendVerificationEmail,
  appUrl,
  emailStatus,
  logEmailConfig,
  undeliverableReason,
  maskEmail,
};
