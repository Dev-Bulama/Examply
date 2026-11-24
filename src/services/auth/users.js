'use strict';

const crypto = require('crypto');
const { db } = require('../../config/db');
const passwords = require('./passwords');
const rbac = require('../rbac');

const LOCK_WINDOW_MINUTES = 15;
const LOCK_MAX_FAILURES = 5;

const normaliseEmail = (email) => String(email || '').trim().toLowerCase();

async function findByEmail(email, knex = db()) {
  return knex('users').where({ email: normaliseEmail(email) }).whereNull('deleted_at').first();
}

async function findById(id, knex = db()) {
  return knex('users').where({ id }).whereNull('deleted_at').first();
}

/**
 * Creates a user with the given roles (default: candidate). `password` may be null for Google-only accounts.
 * Returns the inserted row.
 */
async function createUser({ email, password, fullName, roles = ['candidate'], emailVerified = false, createdBy = null, extra = {} }, knex = db()) {
  const row = {
    uuid: crypto.randomUUID(),
    email: normaliseEmail(email),
    password_hash: password ? await passwords.hash(password) : null,
    full_name: String(fullName).trim(),
    email_verified_at: emailVerified ? new Date() : null,
    password_changed_at: password ? new Date() : null,
    created_by: createdBy,
    ...extra,
  };
  return knex.transaction(async (trx) => {
    const [id] = await trx('users').insert(row);
    for (const slug of roles) await rbac.assignRole(id, slug, trx);
    return trx('users').where({ id }).first();
  });
}

async function setPassword(userId, password, knex = db()) {
  await knex('users')
    .where({ id: userId })
    .update({ password_hash: await passwords.hash(password), password_changed_at: new Date(), auth_version: knex.raw('auth_version + 1') });
}

/** Number of failed logins for this email+IP pair inside the lock window. */
async function recentFailures(email, ip, knex = db()) {
  const since = new Date(Date.now() - LOCK_WINDOW_MINUTES * 60000);
  const lastSuccess = await knex('login_history').where({ email: normaliseEmail(email), ip, success: true }).where('created_at', '>=', since).max('created_at as at').first();
  const q = knex('login_history').where({ email: normaliseEmail(email), ip, success: false }).where('created_at', '>=', lastSuccess?.at || since);
  const row = await q.count('* as n').first();
  return Number(row.n);
}

/** Returns minutes until the email+IP pair unlocks, or 0 if not locked. */
async function lockRemainingMinutes(email, ip, knex = db()) {
  const failures = await recentFailures(email, ip, knex);
  if (failures < LOCK_MAX_FAILURES) return 0;
  const since = new Date(Date.now() - LOCK_WINDOW_MINUTES * 60000);
  const rows = await knex('login_history')
    .where({ email: normaliseEmail(email), ip, success: false })
    .where('created_at', '>=', since)
    .orderBy('created_at', 'desc')
    .limit(LOCK_MAX_FAILURES)
    .select('created_at');
  const oldestCounted = rows[rows.length - 1].created_at;
  const unlockAt = new Date(oldestCounted.getTime() + LOCK_WINDOW_MINUTES * 60000);
  return Math.max(1, Math.ceil((unlockAt - Date.now()) / 60000));
}

/** Signs the user out everywhere (every session with an older auth_version is rejected). */
async function bumpAuthVersion(userId, knex = db()) {
  await knex('users').where({ id: userId }).increment('auth_version', 1);
  const row = await knex('users').where({ id: userId }).first('auth_version');
  return row.auth_version;
}

async function recordLogin({ userId = null, email, ip, userAgent, success, reason = null }, knex = db()) {
  await knex('login_history').insert({
    user_id: userId,
    email: normaliseEmail(email).slice(0, 191),
    ip,
    user_agent: (userAgent || '').slice(0, 255),
    success,
    reason,
  });
  if (success && userId) await knex('users').where({ id: userId }).update({ last_login_at: new Date(), last_login_ip: ip });
}

module.exports = {
  normaliseEmail,
  findByEmail,
  findById,
  createUser,
  setPassword,
  recentFailures,
  lockRemainingMinutes,
  recordLogin,
  bumpAuthVersion,
  LOCK_WINDOW_MINUTES,
  LOCK_MAX_FAILURES,
};
