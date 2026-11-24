'use strict';

const { ADMIN_NAV, CANDIDATE_NAV, WORKSPACE_NAV, visible } = require('../config/navigation');

/** Sets the sidebar for the app layout. */
const appNav = (area) => (req, res, next) => {
  if (req.user) {
    res.locals.area = area;
    if ((area === 'admin' || area === 'org') && req.workspace) {
      res.locals.area = 'admin';
      res.locals.navSections = visible(WORKSPACE_NAV, req.user);
    } else res.locals.navSections = visible(area === 'admin' ? ADMIN_NAV : CANDIDATE_NAV, req.user);
    if (area === 'candidate' && req.workspace) res.locals.navSections = [...res.locals.navSections, { heading: null, items: [{ label: `Workspace · ${req.workspace.name}`, href: '/org', icon: 'computer' }] }];
  }
  next();
};

module.exports = { appNav };
