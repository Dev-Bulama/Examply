'use strict';

/**
 * When the platform is installed but its database is unreachable (wrong or lost credentials, server down),
 * every page shows a clear "reconnect" screen (503) instead of a generic error. The owner fixes it with the
 * SETUP_TOKEN; without one, the page explains how to set the DB_* variables in hPanel.
 */
const system = require('../services/system');
const dbHealth = require('../services/dbHealth');
const { getEnv } = require('../config/env');

const PASS = [/^\/(css|js|vendor|fonts|img)\//, /^\/favicon\.ico$/, /^\/healthz$/, /^\/theme\.css$/];

async function dbGuard(req, res, next) {
  if (!system.isInstalled() || PASS.some((re) => re.test(req.path))) return next();
  const h = await dbHealth.check();
  if (h.ok) return next();
  if (req.method === 'POST' && req.path === '/install/database') return next();
  const env = getEnv();
  res.status(503).set('Retry-After', '60');
  if (/json/.test(req.get('accept') || '')) return res.json({ ok: false, error: 'The database is unavailable. Please try again shortly.' });
  return res.render('install/db-down', {
    layout: 'layouts/install',
    title: 'Database unavailable',
    code: h.code,
    reason: dbHealth.explain(h.code),
    canReconnect: !!env.SETUP_TOKEN,
    dbDefaults: { db_host: env.DB_HOST || 'localhost', db_port: env.DB_PORT || 3306, db_name: env.DB_NAME, db_user: env.DB_USER },
  });
}

module.exports = { dbGuard };
