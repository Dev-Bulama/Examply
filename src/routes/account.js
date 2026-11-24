'use strict';

const express = require('express');
const c = require('../controllers/accountController');
const { requireAuth } = require('../middleware/auth');
const { appNav } = require('../middleware/nav');
const { authLimiter } = require('../middleware/rateLimit');
const { memoryUpload } = require('../services/uploads');
const { asyncHandler: h } = require('../utils/errors');

const router = express.Router();
router.use(requireAuth, appNav('candidate'));

router.get('/', h(c.profile));
router.post('/profile', h(c.updateProfile));
router.post('/photo', memoryUpload({ field: 'photo', maxBytes: 2 * 1024 * 1024 }), h(c.uploadPhoto));
router.post('/photo/remove', h(c.removePhoto));
router.post('/preferences', h(c.preferences));

router.get('/security', h(c.security));
router.post('/security/password', authLimiter(), h(c.changePassword));
router.get('/security/2fa', h(c.twoFactorSetup));
router.post('/security/2fa', authLimiter(), h(c.twoFactorEnable));
router.post('/security/2fa/disable', authLimiter(), h(c.twoFactorDisable));
router.post('/security/2fa/recovery-codes', authLimiter(), h(c.regenerateRecoveryCodes));

router.get('/data-export', authLimiter(), h(c.exportData));
router.post('/delete-request', authLimiter(), h(c.requestDeletion));
router.post('/delete-request/cancel', h(c.cancelDeletion));

module.exports = router;
