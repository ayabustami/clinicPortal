'use strict';
const fs = require('fs');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const config = require('./config');
const { ApiError } = require('./util/errors');
const { originGuard } = require('./auth');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (config.env === 'production') app.set('trust proxy', 1);

  // Security headers. CSP is disabled at the API level because the SPA is
  // served separately in development; when serving the built SPA (production
  // single-server mode) a strict CSP should be added at the reverse proxy.
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'same-site' } }));

  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  // CSRF defense for cookie-authenticated state-changing requests
  app.use('/api', originGuard);

  // Request logging for errors only (never logs bodies/headers → no secrets in logs)
  app.use((req, res, next) => {
    if (req.path === '/api/health') return next();
    const start = Date.now();
    res.on('finish', () => {
      if (res.statusCode >= 400) {
        console.log(`${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - start}ms)`);
      }
    });
    next();
  });

  // Health check with DB probe (PostgreSQL round-trip; never exposes connection details)
  app.get('/api/health', async (req, res) => {
    let dbOk = false;
    try {
      const { ping } = require('./db');
      dbOk = await ping();
    } catch { dbOk = false; }
    res.status(dbOk ? 200 : 503).json({ ok: dbOk, service: 'clinic-portal-api' });
  });

  app.use('/api/auth', require('./routes/auth.routes'));
  app.use('/api/meta', require('./routes/meta.routes'));
  app.use('/api/dashboard', require('./routes/dashboard.routes'));
  app.use('/api/patients', require('./routes/patients.routes'));
  app.use('/api/staff', require('./routes/staff.routes'));
  app.use('/api/services', require('./routes/services.routes'));
  app.use('/api/branches', require('./routes/branches.routes'));
  app.use('/api/appointments', require('./routes/appointments.routes'));
  app.use('/api/records', require('./routes/records.routes'));
  app.use('/api/invoices', require('./routes/invoices.routes'));
  app.use('/api/reports', require('./routes/reports.routes'));
  app.use('/api/clinics', require('./routes/clinics.routes'));
  app.use('/api/activity', require('./routes/activity.routes'));
  app.use('/api/audit', require('./routes/audit.routes'));
  app.use('/api/schedule', require('./routes/schedule.routes'));
  app.use('/api/plans', require('./routes/plans.routes'));
  app.use('/api/waiting', require('./routes/waiting.routes'));
  app.use('/api/waiting-room', require('./routes/waiting-room.routes'));
  app.use('/api/attachments', require('./routes/attachments.routes'));
  app.use('/api/patients/:patientId/dental', require('./routes/dental.routes'));

  // 404 for unknown API routes
  app.use('/api', (req, res) => res.status(404).json({ error: { message: 'Endpoint not found', code: 'not_found' } }));

  // Production single-server deployment: serve the built SPA if present.
  const distDir = path.join(__dirname, '..', '..', 'client', 'dist');
  if (config.env === 'production' && fs.existsSync(distDir)) {
    app.use(express.static(distDir, { index: false }));
    app.get('*', (req, res) => res.sendFile(path.join(distDir, 'index.html')));
  }

  // Central error handler — never leaks stack traces or SQL details.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof ApiError) {
      return res.status(err.status).json({
        error: { message: err.message, code: err.code, ...(err.fields ? { fields: err.fields } : {}) },
      });
    }
    if (err && err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: { message: 'Invalid JSON in request body', code: 'invalid_json' } });
    }
    console.error('[error]', err);
    res.status(500).json({ error: { message: 'Internal server error', code: 'server_error' } });
  });

  return app;
}

module.exports = { createApp };
