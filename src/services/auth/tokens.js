'use strict';

const { db } = require('../../config/db');
const { randomToken, sha256 } = require('../../utils/crypto');

const VERIFY_HOURS = 48;
const RESET_MINUTES = 60;
const ACCOUNT_SETUP_MINUTES = 72 * 60;

/** Creates an email verification token; returns the raw token (only the hash is stored). */
async function createEmailVerification(user, knex = db()) {
  const token = randomToken();
  await knex('email_verifications').where({ user_id: user.id }).whereNull('used_at').update({ used_at: new Date() });
  await knex('email_verifications').insert({
    user_id: user.id,
    email: user.email,
    token_hash: sha256(token),
    expires_at: new Date(Date.now() + VERIFY_HOURS * 3600000),
  });
  return token;
}

/** Consumes a verification token. Returns the user id, or null if invalid/expired/used. */
async function consumeEmailVerification(token, knex = db()) {
  if (!token || token.length > 100) return null;
  return knex.transaction(async (trx) => {
    const row = await trx('email_verifications').where({ token_hash: sha256(token) }).forUpdate().first();
    if (!row || row.used_at || row.expires_at < new Date()) return null;
    const user = await trx('users').where({ id: row.user_id }).whereNull('deleted_at').first();
    if (!user || user.email !== row.email) return null;
    await trx('email_verifications').where({ id: row.id }).update({ used_at: new Date() });
    await trx('users').where({ id: user.id }).update({ email_verified_at: user.email_verified_at || new Date() });
    return user.id;
  });
}

async function createPasswordReset(user, ip, { minutes = RESET_MINUTES, knex = db() } = {}) {
  const token = randomToken();
  await knex('password_resets').where({ user_id: user.id }).whereNull('used_at').update({ used_at: new Date() });
  await knex('password_resets').insert({
    user_id: user.id,
    token_hash: sha256(token),
    expires_at: new Date(Date.now() + minutes * 60000),
    ip,
  });
  return token;
}

/** Looks up a valid, unused reset token without consuming it. */
async function findPasswordReset(token, knex = db()) {
  if (!token || token.length > 100) return null;
  const row = await knex('password_resets').where({ token_hash: sha256(token) }).first();
  if (!row || row.used_at || row.expires_at < new Date()) return null;
  return row;
}

/** Marks the token used inside `trx`; returns false if it was already consumed (single use). */
async function consumePasswordReset(id, trx) {
  const n = await trx('password_resets').where({ id }).whereNull('used_at').update({ used_at: new Date() });
  return n === 1;
}

module.exports = {
  createEmailVerification,
  consumeEmailVerification,
  createPasswordReset,
  findPasswordReset,
  consumePasswordReset,
  VERIFY_HOURS,
  RESET_MINUTES,
  ACCOUNT_SETUP_MINUTES,
};
