'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { appNav } = require('../middleware/nav');
const { formLimiter } = require('../middleware/rateLimit');
const { asyncHandler: h } = require('../utils/errors');
const c = require('../controllers/orgController');

const router = express.Router();
const nav = appNav('org');

// Company workspace portal (managers; authors see the overview)
router.get('/org', requireAuth, nav, h(c.overview));
router.post('/org/switch', requireAuth, h(c.switchWorkspace));
router.get('/org/members', requireAuth, nav, h(c.members));
router.post('/org/members/invite', requireAuth, formLimiter(), h(c.inviteMembers));
router.post('/org/members/:userId(\\d+)/role', requireAuth, h(c.changeRole));
router.post('/org/members/:userId(\\d+)/remove', requireAuth, h(c.removeMember));
router.post('/org/invitations/:id(\\d+)/cancel', requireAuth, h(c.cancelInvite));
router.post('/org/join-code', requireAuth, h(c.joinCode));
router.get('/org/cohorts', requireAuth, nav, h(c.cohorts));
router.post('/org/cohorts', requireAuth, h(c.createCohort));
router.get('/org/cohorts/:id(\\d+)', requireAuth, nav, h(c.cohortShow));
router.get('/org/cohorts/:id(\\d+)/export.csv', requireAuth, h(c.cohortCsv));
router.post('/org/cohorts/:id(\\d+)/members', requireAuth, h(c.cohortMembers));
router.post('/org/cohorts/:id(\\d+)/assign', requireAuth, h(c.cohortAssign));
router.post('/org/cohorts/:id(\\d+)/assignments/:aid(\\d+)/delete', requireAuth, h(c.unassign));
router.get('/org/reports', requireAuth, nav, h(c.reports));
router.get('/org/settings', requireAuth, nav, h(c.settingsForm));
router.post('/org/settings', requireAuth, h(c.settingsSave));

// Joining an organisation
router.get('/join', requireAuth, h(c.joinForm));
router.post('/join', requireAuth, formLimiter(), h(c.joinWithCode));
router.get('/join/:token([0-9a-f]{48})', h(c.invitationPage));
router.post('/join/:token([0-9a-f]{48})', requireAuth, h(c.acceptInvitation));

module.exports = router;
