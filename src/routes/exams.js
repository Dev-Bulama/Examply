'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { appNav } = require('../middleware/nav');
const { answerLimiter, sqlLimiter, formLimiter } = require('../middleware/rateLimit');
const { asyncHandler: h } = require('../utils/errors');
const c = require('../controllers/examController');

const router = express.Router();
const UUID = '[0-9a-f-]{36}';

// Public catalogue & verification
router.get('/exams', h(c.catalogueIndex));
router.get('/exams/:slug([a-z0-9-]+)', h(c.examShow));
router.post('/exams/:slug([a-z0-9-]+)/invite', requireAuth, formLimiter(), h(c.redeemInvite));
router.post('/exams/:slug([a-z0-9-]+)/start', requireAuth, h(c.start));
router.get('/verify', h(c.verifyPage));
router.get('/verify/:code([A-Za-z0-9-]{6,24})', h(c.verifyPage));

// Taking an exam (owner only; checked in the controller)
router.get(`/attempts/:uuid(${UUID})`, requireAuth, h(c.player));
router.post(`/attempts/:uuid(${UUID})/take-over`, requireAuth, h(c.takeOver));
router.patch(`/attempts/:uuid(${UUID})/answers`, requireAuth, answerLimiter(), h(c.saveAnswers));
router.post(`/attempts/:uuid(${UUID})/events`, requireAuth, answerLimiter(), h(c.event));
router.post(`/attempts/:uuid(${UUID})/section/finish`, requireAuth, h(c.finishSection));
router.post(`/attempts/:uuid(${UUID})/submit`, requireAuth, h(c.submit));
router.post(`/attempts/:uuid(${UUID})/items/:itemId(\\d+)/sql`, requireAuth, sqlLimiter(), h(c.runSql));
router.post(`/attempts/:uuid(${UUID})/items/:itemId(\\d+)/lab`, requireAuth, answerLimiter(), h(c.labCommand));

// Results & certificates
router.get(`/results/:uuid(${UUID})`, requireAuth, appNav('candidate'), h(c.resultPage));
router.get(`/results/:uuid(${UUID})/slip.pdf`, requireAuth, h(c.slip));
router.post(`/results/:uuid(${UUID})/practice-weak`, requireAuth, h(c.practiceWeak));
router.get('/my/results', requireAuth, appNav('candidate'), h(c.myResults));
router.get('/my/certificates', requireAuth, appNav('candidate'), h(c.myCertificates));
router.get('/certificates/:code([A-Za-z0-9-]{6,24}).pdf', requireAuth, h(c.certificatePdf));

module.exports = router;
