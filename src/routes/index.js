'use strict';

const express = require('express');
const settings = require('../services/settings');
const theme = require('../services/theme');
const system = require('../services/system');
const { storagePath } = require('../config/paths');
const { getEnv } = require('../config/env');

const MEDIA_DIRS = new Set(['avatars', 'branding']);
const SAFE_FILE = /^[a-zA-Z0-9_-]{8,80}\.(png|jpe?g|webp|svg|ico)$/;

/** Routes that need no session or body parsing (cheap, cacheable). */
function mountPreSession(app) {
  app.get('/theme.css', async (req, res, next) => {
    try {
      let brand = { primary: settings.DEFINITIONS['branding.primary_color'].default, secondary: settings.DEFINITIONS['branding.secondary_color'].default };
      if (system.isInstalled()) {
        await settings.ensureLoaded();
        brand = { primary: settings.getSync('branding.primary_color'), secondary: settings.getSync('branding.secondary_color') };
      }
      res.type('text/css').set('Cache-Control', getEnv().isProduction ? 'public, max-age=31536000, immutable' : 'no-cache');
      res.send(theme.themeCss(brand));
    } catch (err) {
      next(err);
    }
  });

  // Public uploaded media (avatars, logos). Private uploads are served by authorised routes only.
  app.get('/media/:dir/:file', (req, res, next) => {
    const { dir, file } = req.params;
    if (!MEDIA_DIRS.has(dir) || !SAFE_FILE.test(file)) return next();
    const full = storagePath('uploads', 'public', dir, file);
    res.set('X-Content-Type-Options', 'nosniff');
    if (file.endsWith('.svg')) res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    return res.sendFile(full, { maxAge: getEnv().isProduction ? '7d' : 0, root: '/' }, (err) => {
      if (err) next();
    });
  });

  app.use('/cron', require('./cron'));
  app.use('/webhooks', express.Router()); // payment webhooks are added in the commerce module
}

function mountInstall(app) {
  app.use(require('./install'));
}

function mountMain(app) {
  app.use(require('./public'));
  app.use(require('./auth'));
  app.use('/account', require('./account'));
  app.use(require('./candidate'));
  app.use('/admin', require('./admin'));
}

module.exports = { mountPreSession, mountInstall, mountMain };
