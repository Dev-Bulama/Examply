'use strict';

const { getEnv } = require('../config/env');
const { db } = require('../config/db');
const settings = require('../services/settings');
const theme = require('../services/theme');
const time = require('../utils/time');
const { formatMoney } = require('../utils/money');

/** Loads settings into cache and exposes view helpers. Runs after loadUser. */
async function locals(req, res, next) {
  try {
    await settings.ensureLoaded();
    const env = getEnv();
    const site = {
      name: settings.getSync('general.site_name'),
      tagline: settings.getSync('general.tagline'),
      logo: settings.getSync('general.logo_path'),
      favicon: settings.getSync('general.favicon_path'),
      timezone: settings.getSync('general.timezone'),
      dateFormat: settings.getSync('general.date_format'),
      currency: settings.getSync('general.currency'),
      metaDescription: settings.getSync('seo.meta_description'),
      ogImage: settings.getSync('seo.og_image_path'),
      registrationOpen: settings.getSync('security.registration_open'),
      googleEnabled: settings.getSync('auth.google_enabled') && !!settings.getSync('auth.google_client_id'),
      defaultTheme: settings.getSync('branding.default_theme'),
      url: env.APP_URL,
    };
    const brand = { primary: settings.getSync('branding.primary_color'), secondary: settings.getSync('branding.secondary_color') };
    site.themeVersion = theme.themeVersion(brand);
    res.locals.site = site;

    const tz = (req.user && req.user.timezone) || site.timezone;
    const dateOpts = { timezone: tz, format: site.dateFormat };
    res.locals.fmt = {
      date: (d) => time.formatDate(d, dateOpts),
      dateTime: (d) => time.formatDateTime(d, dateOpts),
      relative: (d) => time.relativeTime(d),
      money: (minor, currency) => formatMoney(minor, currency || site.currency),
      number: (n, digits = 0) => Number(n || 0).toLocaleString('en-NG', { maximumFractionDigits: digits }),
      tz,
    };
    res.locals.currentPath = req.path;
    res.locals.isActive = (prefix, exact = false) => (exact ? req.path === prefix : req.path === prefix || req.path.startsWith(`${prefix}/`));
    res.locals.can = (...keys) => !!(req.user && req.user.can(...keys));
    res.locals.canAny = (...keys) => !!(req.user && req.user.canAny(...keys));
    res.locals.title = res.locals.title || site.name;

    // Accessibility accommodations apply site-wide (large font, high contrast) and to every attempt (extra time).
    res.locals.htmlClasses = [];
    if (req.user) {
      const acc = await db()('user_accommodations').where({ user_id: req.user.id }).first();
      req.user.accommodations = acc || { extra_time_percent: 0, large_font: false, high_contrast: false };
      if (acc && acc.large_font) res.locals.htmlClasses.push('font-large');
      if (acc && acc.high_contrast) res.locals.htmlClasses.push('high-contrast');
      res.locals.themePref = req.user.theme;
    } else {
      res.locals.themePref = site.defaultTheme;
    }
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { locals };
