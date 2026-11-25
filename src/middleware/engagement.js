'use strict';

/** Per-page extras for HTML pages: unread notification count, announcement banners, CMS footer links. */
const engagement = require('../services/engagement');

let footerCache = { at: 0, pages: [] };

async function engagementLocals(req, res, next) {
  res.locals.unreadCount = 0;
  res.locals.announcements = [];
  res.locals.footerPages = footerCache.pages;
  if (req.method !== 'GET' || req.xhr || /json/.test(req.get('accept') || '') || /^\/(attempts|play|admin\/live\/\d+$)/.test(req.path)) return next();
  try {
    if (req.user) res.locals.unreadCount = await engagement.unreadCount(req.user.id);
    res.locals.announcements = await engagement.announcementsFor(req.user || null);
    if (Date.now() - footerCache.at > 60000) footerCache = { at: Date.now(), pages: await engagement.footerPages() };
    res.locals.footerPages = footerCache.pages;
  } catch (err) {
    req.log && req.log.warn({ err: err.message }, 'engagement locals failed');
  }
  return next();
}

const clearFooterCache = () => {
  footerCache = { at: 0, pages: [] };
};

module.exports = { engagementLocals, clearFooterCache };
