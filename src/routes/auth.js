'use strict';

const express = require('express');
const c = require('../controllers/authController');
const { guestOnly, requireAuth } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimit');
const { asyncHandler: h } = require('../utils/errors');

const router = express.Router();
const limit = authLimiter();

router.get('/login', guestOnly, c.showLogin);
router.post('/login', limit, guestOnly, h(c.login));
router.get('/login/2fa', c.show2fa);
router.post('/login/2fa', limit, h(c.verify2fa));
router.post('/logout', c.logout);

router.get('/register', guestOnly, h(c.showRegister));
router.post('/register', limit, guestOnly, h(c.register));
router.get('/verify-email/:token', h(c.verifyEmail));
router.post('/account/verify-email/resend', limit, requireAuth, h(c.resendVerification));

router.get('/forgot-password', guestOnly, c.showForgot);
router.post('/forgot-password', limit, guestOnly, h(c.forgot));
router.get('/reset-password/:token', h(c.showReset));
router.post('/reset-password/:token', limit, h(c.reset));

router.get('/auth/google', limit, guestOnly, c.googleStart);
router.get('/auth/google/callback', limit, h(c.googleCallback));

module.exports = router;
