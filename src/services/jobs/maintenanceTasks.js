'use strict';

/** Hourly housekeeping: expired tokens, sessions, old completed jobs, old login history. */
async function cleanup({ knex }) {
  const now = new Date();
  const day = 24 * 3600 * 1000;
  const out = {};
  out.passwordResets = await knex('password_resets').where('expires_at', '<', new Date(now - day)).del();
  out.emailVerifications = await knex('email_verifications').where('expires_at', '<', new Date(now - 7 * day)).del();
  out.sessions = await knex('sessions').where('expires', '<', Math.floor(now.getTime() / 1000)).del();
  out.jobs = await knex('jobs').where('status', 'completed').where('completed_at', '<', new Date(now - 14 * day)).del();
  out.loginHistory = await knex('login_history').where('created_at', '<', new Date(now - 365 * day)).del();
  return out;
}

module.exports = { cleanup };
