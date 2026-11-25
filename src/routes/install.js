'use strict';

const express = require('express');
const { z, trimmed, email, timezone } = require('../validators/common');
const { fieldErrors } = require('../middleware/validate');
const system = require('../services/system');
const passwords = require('../services/auth/passwords');
const settings = require('../services/settings');
const { TIMEZONES } = require('../utils/time');
const { getEnv } = require('../config/env');
const { asyncHandler } = require('../utils/errors');
const { authLimiter } = require('../middleware/rateLimit');
const crypto = require('crypto');
const knexFactory = require('knex');
const { db, knexConfig, checkConnection, closeDb } = require('../config/db');
const { reloadEnv } = require('../config/env');
const runtime = require('../config/runtime');

const router = express.Router();

const DEFAULT_POLICY = {
  minLength: settings.DEFINITIONS['security.password_min_length'].default,
  mixedCase: settings.DEFINITIONS['security.password_require_mixed_case'].default,
  number: settings.DEFINITIONS['security.password_require_number'].default,
  symbol: settings.DEFINITIONS['security.password_require_symbol'].default,
};

const schema = z
  .object({
    site_name: trimmed(120, 2),
    timezone,
    admin_name: trimmed(150, 2),
    admin_email: email,
    admin_password: z.string().min(1, 'Choose a password.'),
    admin_password_confirmation: z.string(),
    demo: z.any().optional(),
  })
  .superRefine((v, ctx) => {
    for (const problem of passwords.check(v.admin_password, DEFAULT_POLICY, { email: v.admin_email, name: v.admin_name }))
      ctx.addIssue({ code: 'custom', path: ['admin_password'], message: problem });
    if (v.admin_password !== v.admin_password_confirmation)
      ctx.addIssue({ code: 'custom', path: ['admin_password_confirmation'], message: 'The passwords do not match.' });
  });

/** When SETUP_TOKEN is set, the installer needs it once per browser session (?token=… or the form field). */
function tokenOk(req) {
  const want = getEnv().SETUP_TOKEN;
  if (!want) return true;
  const given = String((req.body && req.body.setup_token) || req.query.token || '');
  if (given && crypto.timingSafeEqual(crypto.createHash('sha256').update(given).digest(), crypto.createHash('sha256').update(want).digest())) req.session.setupOk = true;
  return !!req.session.setupOk;
}

const dbSchema = z.object({
  db_host: trimmed(255, 1),
  db_port: z.coerce.number().int().min(1).max(65535),
  db_name: trimmed(64, 1),
  db_user: trimmed(64, 1),
  db_password: z.string().max(255).optional().default(''),
});

router.post(
  '/install/database',
  authLimiter(),
  asyncHandler(async (req, res) => {
    const installed = system.isInstalled();
    const home = installed ? '/' : '/install';
    // Reconnecting an installed site always needs the SETUP_TOKEN (never open to anonymous visitors).
    if (installed && !getEnv().SETUP_TOKEN) return res.status(403).send('Set SETUP_TOKEN in the environment to reconnect from the browser.');
    if (!tokenOk(req)) {
      req.flash('danger', 'That setup token is not correct.');
      return res.redirect(home);
    }
    if (req.body.setup_token && !req.body.db_host && !installed) return res.redirect(home);
    const parsed = dbSchema.safeParse(req.body);
    if (!parsed.success) {
      req.setFormState(req.body, fieldErrors(parsed.error));
      req.flash('danger', 'Please fill in every database field.');
      return res.redirect(home);
    }
    const v = parsed.data;
    const probe = knexFactory(knexConfig({ ...getEnv(), DB_HOST: v.db_host, DB_PORT: v.db_port, DB_USER: v.db_user, DB_PASSWORD: v.db_password, DB_NAME: v.db_name, DB_POOL_MAX: 2 }));
    const error = await checkConnection(probe);
    await probe.destroy();
    if (error) {
      req.setFormState({ ...req.body, db_password: '' }, {});
      req.flash('danger', `Could not connect: ${error}`);
      return res.redirect(home);
    }
    const saved = runtime.write({ DB_HOST: v.db_host, DB_PORT: v.db_port, DB_USER: v.db_user, DB_PASSWORD: v.db_password, DB_NAME: v.db_name });
    if (!saved) {
      req.flash('danger', 'Connected, but the settings could not be saved: no writable location for the runtime config. Add the DB_* variables in hPanel → Node.js → Environment variables instead.');
      return res.redirect(home);
    }
    await closeDb();
    reloadEnv();
    require('../services/dbHealth').reset();
    if (req.app.locals.resetSessionStore) await req.app.locals.resetSessionStore();
    if (installed) {
      try {
        await db().migrate.latest();
        await system.syncSystemData();
      } catch (err) {
        req.log && req.log.error({ err: err.message }, 'post-reconnect sync failed');
      }
    }
    req.flash('success', installed ? 'Database reconnected. The site is back.' : 'Database connected and saved.');
    return res.redirect(home);
  }),
);

router.get(
  '/install',
  asyncHandler(async (req, res) => {
    if (!tokenOk(req)) return res.render('install/token', { layout: 'layouts/install', title: 'Install' });
    const checks = await system.requirements();
    const ready = checks.node.ok && checks.storage.ok && checks.database.ok;
    const env = getEnv();
    res.render('install/index', {
      dbDefaults: { db_host: env.DB_HOST || 'localhost', db_port: env.DB_PORT || 3306, db_name: env.DB_NAME, db_user: env.DB_USER },
      appUrl: env.APP_URL,
      siteName: env.APP_NAME || 'EXAMPLY',
      layout: 'layouts/install',
      title: 'Install',
      checks,
      ready,
      timezones: TIMEZONES,
      defaultTimezone: getEnv().DEFAULT_TIMEZONE,
      policyText: passwords.describe(DEFAULT_POLICY),
    });
  }),
);

router.post(
  '/install',
  authLimiter(),
  asyncHandler(async (req, res) => {
    if (!tokenOk(req)) return res.redirect('/install');
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      req.setFormState(req.body, fieldErrors(parsed.error));
      req.flash('danger', 'Please correct the highlighted fields.');
      return res.redirect('/install');
    }
    const checks = await system.requirements();
    if (!checks.database.ok || !checks.storage.ok) {
      req.flash('danger', 'The server requirements are not met yet. Fix the items marked in red and try again.');
      return res.redirect('/install');
    }
    const v = parsed.data;
    try {
      await system.install({ siteName: v.site_name, timezone: v.timezone, adminName: v.admin_name, adminEmail: v.admin_email, adminPassword: v.admin_password });
      if (v.demo) {
        try {
          await db().seed.run(); // catalogue, sample questions, SQL + cyber labs, demo exams, plans
        } catch (err) {
          req.log && req.log.error({ err }, 'demo content failed');
        }
      }
    } catch (err) {
      req.log && req.log.error({ err }, 'install failed');
      req.flash('danger', `Installation failed: ${err.message}`);
      return res.redirect('/install');
    }
    // The session store switches from memory to MySQL now, so pass the notice in the URL.
    return res.redirect('/login?installed=1');
  }),
);

module.exports = router;
