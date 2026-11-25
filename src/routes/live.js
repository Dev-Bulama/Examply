'use strict';

const express = require('express');
const { formLimiter } = require('../middleware/rateLimit');
const { asyncHandler: h } = require('../utils/errors');
const c = require('../controllers/liveController');

const router = express.Router();

// Players: join with a PIN (guests only when the host allows it), then the play screen.
router.get('/play', h(c.joinForm));
router.post('/play', formLimiter(), h(c.join));
router.get('/play/:pin(\\d{6})', h(c.play));

module.exports = router;
