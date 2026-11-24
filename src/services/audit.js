'use strict';

const { db } = require('../config/db');
const { toJson } = require('../utils/json');

// Redact values whose key NAME holds a secret (e.g. smtp_password, client_secret, totp_secret_enc),
// but keep policy settings such as security.password_min_length visible.
const SENSITIVE = /(^|[._])(password|password_hash|password_confirmation|current_password|secret|[a-z]*_secret(_enc)?|token(_hash)?|[a-z]*_token(_hash)?|totp_recovery_codes|recovery_codes)$/i;

function scrub(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(scrub);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE.test(k) ? '[redacted]' : scrub(v);
    return out;
  }
  return value;
}

/**
 * Records an admin action. `req` supplies actor, IP and user agent.
 * audit.record(req, 'user.update', { entityType: 'user', entityId: 5, before, after })
 */
async function record(req, action, { entityType = null, entityId = null, before = null, after = null, userId, knex = db() } = {}) {
  await knex('audit_logs').insert({
    user_id: userId !== undefined ? userId : req?.user?.id || null,
    action,
    entity_type: entityType,
    entity_id: entityId === null || entityId === undefined ? null : String(entityId),
    before: before === null ? null : toJson(scrub(before)),
    after: after === null ? null : toJson(scrub(after)),
    ip: req?.ip || null,
    user_agent: req?.get ? (req.get('user-agent') || '').slice(0, 255) : null,
  });
}

module.exports = { record, scrub };
