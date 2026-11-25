'use strict';

const system = require('../services/system');

const ALWAYS = [/^\/install(\/|$)/, /^\/(css|js|vendor|fonts|img)\//, /^\/favicon\.ico$/, /^\/healthz$/, /^\/theme\.css$/];

/** Until installed, every request goes to /install. After install, /install is gone (404). */
function installGuard(req, res, next) {
  const installed = system.isInstalled();
  if (!installed && !ALWAYS.some((re) => re.test(req.path))) return res.redirect('/install');
  const reconnect = req.method === 'POST' && req.path === '/install/database' && !require('../services/dbHealth').current().ok;
  if (installed && !reconnect && /^\/install(\/|$)/.test(req.path)) return res.status(404).render('errors/404', { title: 'Not found', layout: 'layouts/public' });
  return next();
}

module.exports = { installGuard };
