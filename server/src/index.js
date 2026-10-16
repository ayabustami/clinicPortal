'use strict';
const config = require('./config');
const { migrate } = require('./migrate');
const { createApp } = require('./app');
const { closeDb } = require('./db');

async function main() {
  // Apply pending PostgreSQL migrations before accepting traffic.
  await migrate();

  const app = createApp();
  const server = app.listen(config.port, '0.0.0.0', () => {
    console.log(`[server] Clinic Portal API listening on http://0.0.0.0:${config.port} (${config.env})`);
  });

  // Graceful shutdown: stop accepting connections, then close the pg pool.
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[server] ${signal} received — shutting down`);
    server.close(async () => {
      try { await closeDb(); } catch { /* pool already closed */ }
      process.exit(0);
    });
    // Force-exit if connections refuse to drain (Neon compute may be slow to release).
    setTimeout(async () => {
      try { await closeDb(); } catch { /* ignore */ }
      process.exit(1);
    }, 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  // Connection/migration failures are reported without leaking the DSN.
  console.error('[server] failed to start:', err.message);
  process.exit(1);
});
