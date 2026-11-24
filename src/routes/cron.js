'use strict';

const express = require('express');
const { getEnv } = require('../config/env');
const { timingSafeEqualStr } = require('../utils/crypto');
const { runScheduled } = require('../services/jobs/scheduler');
const system = require('../services/system');
const { webhookLimiter } = require('../middleware/rateLimit');

const router = express.Router();

/**
 * GET /cron/run?token=CRON_TOKEN — called by the hPanel Cron Job every 5 minutes (in case the Node process
 * was idle-suspended). Runs due scheduled tasks and drains the job queue.
 */
router.get('/run', webhookLimiter(), async (req, res) => {
  const token = String(req.query.token || '');
  if (!token || !timingSafeEqualStr(token, getEnv().CRON_TOKEN)) return res.status(403).json({ error: 'Invalid token' });
  if (!system.isInstalled()) return res.status(409).json({ error: 'Not installed yet' });
  try {
    const report = await runScheduled({ timeBudgetMs: 25000 });
    return res.json({ ok: true, ...report });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
