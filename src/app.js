'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const expressLayouts = require('express-ejs-layouts');
const compression = require('compression');
const hpp = require('hpp');
const pinoHttp = require('pino-http');

const { getEnv } = require('./config/env');
const { getLogger } = require('./config/logger');
const { ensureStorage } = require('./config/paths');
const { securityHeaders } = require('./middleware/security');
const { createSessionMiddleware } = require('./middleware/session');
const { flash } = require('./middleware/flash');
const { csrfProtection, csrfLocals } = require('./middleware/csrf');
const { installGuard } = require('./middleware/installGuard');
const { loadUser, enforce2faEnrollment } = require('./middleware/auth');
const { locals } = require('./middleware/locals');
const { maintenance } = require('./middleware/maintenance');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');
const system = require('./services/system');
const routes = require('./routes');

function assetVersion(rootDir) {
  try {
    const css = fs.readFileSync(path.join(rootDir, 'public', 'css', 'app.css'));
    const js = fs.readFileSync(path.join(rootDir, 'public', 'js', 'app.js'));
    return crypto.createHash('sha1').update(css).update(js).digest('hex').slice(0, 10);
  } catch {
    return String(Date.now());
  }
}

function createApp() {
  const env = getEnv();
  ensureStorage();
  const app = express();
  const logger = getLogger();

  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.set('view engine', 'ejs');
  app.set('views', path.join(env.rootDir, 'views'));
  app.use(expressLayouts);
  app.set('layout', 'layouts/public');
  app.set('layout extractScripts', true);
  app.set('layout extractStyles', true);
  if (env.isProduction) app.set('view cache', true);

  // Defaults so error pages render even if settings could not be loaded.
  app.locals.assetVersion = assetVersion(env.rootDir);
  app.locals.site = { name: 'EXAMPLY', tagline: '', timezone: env.DEFAULT_TIMEZONE, themeVersion: 'default', url: env.APP_URL, registrationOpen: false };
  app.locals.fmt = { date: (d) => String(d), dateTime: (d) => String(d), relative: (d) => String(d), money: (m) => String(m), number: (n) => String(n) };
  app.locals.flash = [];
  app.locals.old = {};
  app.locals.errors = {};
  app.locals.user = null;
  app.locals.htmlClasses = [];
  app.locals.themePref = 'system';
  app.locals.can = () => false;
  app.locals.canAny = () => false;
  app.locals.isActive = () => false;
  app.locals.currentPath = '/';
  app.locals.csrfToken = '';
  app.locals.pageUrl = require('./utils/paginate').pageUrl;

  if (!env.isTest) {
    app.use(
      pinoHttp({
        logger,
        autoLogging: { ignore: (req) => /^\/(css|js|vendor|fonts|img|theme\.css|favicon)/.test(req.url) || req.url === '/healthz' },
        customLogLevel: (req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
        serializers: { req: (req) => ({ method: req.method, url: req.url, ip: req.remoteAddress }), res: (res) => ({ statusCode: res.statusCode }) },
      }),
    );
  }

  app.use(securityHeaders());
  app.use(compression());

  // Static assets: long cache for versioned files.
  app.use(
    express.static(path.join(env.rootDir, 'public'), {
      maxAge: env.isProduction ? '30d' : 0,
      immutable: env.isProduction,
      index: false,
    }),
  );

  app.get('/healthz', async (req, res) => {
    const installed = system.isInstalled();
    const health = installed ? await require('./services/dbHealth').check() : null;
    res.set('Cache-Control', 'no-store').json({ ok: !health || health.ok, installed, database: health ? (health.ok ? 'ok' : health.code) : 'not installed', node: process.versions.node });
  });
  routes.mountPreSession(app);

  app.use(express.urlencoded({ extended: true, limit: '2mb' }));
  app.use(express.json({ limit: '2mb' }));
  // HPP on query strings only: forms legitimately post arrays (checkbox groups), which zod validates.
  app.use(hpp({ checkBody: false }));

  const sessionMiddleware = createSessionMiddleware();
  app.locals.closeSessionStore = sessionMiddleware.close;
  app.locals.resetSessionStore = sessionMiddleware.reset;
  app.use(sessionMiddleware);
  app.use(flash);
  app.use(csrfLocals);
  app.use(csrfProtection);
  app.use(require('./middleware/dbGuard').dbGuard);
  app.use(installGuard);

  routes.mountInstall(app);

  app.use(loadUser);
  app.use(locals);
  app.use(require('./middleware/engagement').engagementLocals);
  app.use(maintenance);
  app.use(enforce2faEnrollment);

  routes.mountMain(app);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
