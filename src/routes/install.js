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
  })
  .superRefine((v, ctx) => {
    for (const problem of passwords.check(v.admin_password, DEFAULT_POLICY, { email: v.admin_email, name: v.admin_name }))
      ctx.addIssue({ code: 'custom', path: ['admin_password'], message: problem });
    if (v.admin_password !== v.admin_password_confirmation)
      ctx.addIssue({ code: 'custom', path: ['admin_password_confirmation'], message: 'The passwords do not match.' });
  });

router.get(
  '/install',
  asyncHandler(async (req, res) => {
    const checks = await system.requirements();
    const ready = checks.node.ok && checks.storage.ok && checks.database.ok;
    res.render('install/index', {
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
