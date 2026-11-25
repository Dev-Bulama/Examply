'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { appNav } = require('../middleware/nav');
const { formLimiter } = require('../middleware/rateLimit');
const { asyncHandler: h } = require('../utils/errors');
const c = require('../controllers/engagementController');

const router = express.Router();

router.get('/notifications', requireAuth, appNav('candidate'), h(c.notifications));
router.post('/notifications/read-all', requireAuth, h(c.readAll));
router.get('/notifications/:id(\\d+)', requireAuth, h(c.openNotification));

router.get('/help', h(c.help));
router.get('/p/:slug([a-z0-9-]{1,120})', h(c.page));

const nav = (req, res, next) => (req.user ? appNav('candidate')(req, res, next) : next());
router.get('/support', nav, h(c.supportHome));
router.post('/support', formLimiter(), h(c.supportCreate));
router.get('/support/tickets/:no(T-[A-Z0-9]{4,12})', nav, h(c.ticketView));
router.post('/support/tickets/:no(T-[A-Z0-9]{4,12})/reply', formLimiter(), h(c.ticketReply));

module.exports = router;
