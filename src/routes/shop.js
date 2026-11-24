'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { appNav } = require('../middleware/nav');
const { uploadLimiter, formLimiter } = require('../middleware/rateLimit');
const { memoryUpload } = require('../services/uploads');
const { asyncHandler: h } = require('../utils/errors');
const c = require('../controllers/shopController');

const router = express.Router();
const NO = '[A-Z0-9-]{8,24}';

router.get('/pricing', h(c.pricing));
router.get('/checkout/:slug([a-z0-9-]+)', requireAuth, h(c.checkoutForm));
router.post('/checkout/:slug([a-z0-9-]+)', requireAuth, formLimiter(), h(c.checkout));
router.get('/payments/paystack/callback', requireAuth, h(c.paystackCallback));
router.get('/my/orders', requireAuth, appNav('candidate'), h(c.myOrders));
router.get(`/my/orders/:no(${NO})`, requireAuth, appNav('candidate'), h(c.orderShow));
router.post(`/my/orders/:no(${NO})/transfer`, requireAuth, uploadLimiter(), memoryUpload({ field: 'proof', maxBytes: 5 * 1024 * 1024 }), h(c.submitTransfer));
router.post(`/my/orders/:no(${NO})/pay`, requireAuth, h(c.payAgain));
router.post(`/my/orders/:no(${NO})/cancel`, requireAuth, h(c.cancel));
router.get(`/my/orders/:no(${NO}).pdf`, requireAuth, h(c.invoice));

module.exports = router;
