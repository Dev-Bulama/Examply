'use strict';

const { ADMIN_NAV, CANDIDATE_NAV, visible } = require('../config/navigation');

/** Sets the sidebar for the app layout. */
const appNav = (area) => (req, res, next) => {
  if (req.user) {
    res.locals.area = area;
    res.locals.navSections = visible(area === 'admin' ? ADMIN_NAV : CANDIDATE_NAV, req.user);
  }
  next();
};

module.exports = { appNav };
