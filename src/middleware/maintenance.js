'use strict';

const settings = require('../services/settings');

const ALLOWED = [/^\/login/, /^\/logout$/, /^\/admin(\/|$)/, /^\/account\/security/, /^\/webhooks\//, /^\/cron\/run/, /^\/healthz$/, /^\/theme\.css$/];

/** Maintenance mode: everyone except staff sees the maintenance page; staff can still sign in. */
function maintenance(req, res, next) {
  if (!settings.getSync('maintenance.enabled')) return next();
  res.locals.maintenanceOn = true;
  if (req.user && req.user.isStaff) return next();
  if (ALLOWED.some((re) => re.test(req.path))) return next();
  res.set('Retry-After', '600');
  return res.status(503).render('errors/maintenance', { title: 'Maintenance', layout: 'layouts/public', message: settings.getSync('maintenance.message') });
}

module.exports = { maintenance };
