'use strict';
/**
 * Outbound-email diagnostic.
 *
 * Usage:
 *   npm --prefix server run email:check                       # status only
 *   npm --prefix server run email:check -- --to you@example.com
 *
 * Prints the effective transport, From address, blocking problems and
 * warnings — never an API key or SMTP password. With --to it sends a real
 * test message through the configured provider and reports the outcome.
 *
 * Exit codes: 0 = configured to deliver (and the test send succeeded),
 *             1 = not configured / delivery failed,
 *             2 = bad usage.
 */
const { emailStatus, logEmailConfig, sendMail, undeliverableReason } = require('../src/services/email');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : '';
}

async function main() {
  const to = arg('--to');
  const status = emailStatus();

  console.log('[email-check] effective configuration');
  console.log(`  transport : ${status.transport}`);
  console.log(`  from      : ${status.from}`);
  console.log(`  delivers  : ${status.delivers ? 'YES' : 'NO'}`);
  for (const p of status.problems) console.log(`  PROBLEM   : ${p}`);
  for (const w of status.warnings) console.log(`  warning   : ${w}`);

  if (!to) {
    console.log('');
    logEmailConfig();
    if (!status.delivers) {
      console.log('\n[email-check] Nothing will reach an inbox. In development the code is in the server log; in production configure the EMAIL_* variables (see server/.env.example).');
      process.exit(1);
    }
    console.log('\n[email-check] Ready. Re-run with -- --to you@example.com to send a test message.');
    return;
  }

  const problem = undeliverableReason(to);
  if (problem) {
    console.error(`\n[email-check] refusing to send: ${problem}`);
    process.exit(1);
  }

  console.log(`\n[email-check] sending a test message to ${to} …`);
  const text = [
    'Denti Clinics — email delivery test',
    '',
    'This is a test message from server/scripts/email-check.js.',
    'If you can read it, password-reset and verification emails can be delivered.',
  ].join('\n');
  const sent = await sendMail({
    to,
    subject: 'Denti Clinics — email delivery test',
    text,
    html: `<p>${text.replace(/\n/g, '<br/>')}</p>`,
  });

  if (!sent) {
    console.error('[email-check] FAILED — the provider did not accept the message (see the [email] log lines).');
    process.exit(1);
  }
  console.log('[email-check] accepted by the transport. Check the inbox (and the spam folder).');
  if (status.transport === 'console') {
    console.log('[email-check] NOTE: transport=console — the message was printed to the log, not emailed.');
  }
}

main().catch((err) => {
  console.error('[email-check] unexpected error:', err.message);
  process.exit(1);
});
