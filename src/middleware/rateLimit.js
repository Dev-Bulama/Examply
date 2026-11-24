'use strict';

const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { getEnv } = require('../config/env');

const MESSAGE = 'Too many requests. Please wait a moment and try again.';

function limiter({ windowMs, limit, keyGenerator, message = MESSAGE }) {
  const env = getEnv();
  return rateLimit({
    windowMs,
    limit: env.isTest ? 10000 : limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator,
    handler: (req, res) => {
      const accept = req.get('accept') || '';
      if (req.xhr || accept.includes('application/json') || req.path.startsWith('/api/')) return res.status(429).json({ error: message });
      return res.status(429).render('errors/429', { title: 'Slow down', layout: 'layouts/public', message });
    },
  });
}

const ip = (req) => ipKeyGenerator(req.ip || '0.0.0.0');

/** Auth endpoints (login, register, forgot password, 2FA): 30 per 15 minutes per IP. */
const authLimiter = () => limiter({ windowMs: 15 * 60000, limit: 30, keyGenerator: ip });
/** Answer autosave: 240 per minute per user/IP. */
const answerLimiter = () => limiter({ windowMs: 60000, limit: 240, keyGenerator: (req) => (req.user ? `u${req.user.id}` : ip(req)) });
/** Import uploads: 20 per hour per user. */
const uploadLimiter = () => limiter({ windowMs: 3600000, limit: 20, keyGenerator: (req) => (req.user ? `u${req.user.id}` : ip(req)) });
/** Webhooks: 300 per minute per IP. */
const webhookLimiter = () => limiter({ windowMs: 60000, limit: 300, keyGenerator: ip });
/** General protection for public forms (contact, join): 20 per 10 minutes. */
const formLimiter = () => limiter({ windowMs: 10 * 60000, limit: 20, keyGenerator: ip });

module.exports = { limiter, authLimiter, answerLimiter, uploadLimiter, webhookLimiter, formLimiter };
