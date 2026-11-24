'use strict';

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { authenticator } = require('otplib');

/** Boots the app as "installed" against the test DB. */
async function bootApp({ installed = true } = {}) {
  const { installLockPath, ensureStorage } = require('../../src/config/paths');
  ensureStorage();
  const system = require('../../src/services/system');
  await system.syncSystemData();
  if (installed) fs.writeFileSync(installLockPath(), '{"test":true}');
  system.resetInstalledCache();
  require('../../src/services/settings').invalidate();
  require('../../src/services/jobs').registerAll();
  const { createApp } = require('../../src/app');
  return createApp();
}

let seq = 0;
const uniqueEmail = (prefix = 'user') => `${prefix}.${process.env._RUN_ID}.${process.pid}.${Date.now()}.${(seq += 1)}@example.test`;

async function createUser({ roles = ['candidate'], password = 'Correct-Horse-9', email, fullName = 'Test User', verified = true } = {}) {
  const users = require('../../src/services/auth/users');
  return users.createUser({ email: email || uniqueEmail(roles[0]), password, fullName, roles, emailVerified: verified });
}

/** Extracts the CSRF token from the <meta name="csrf-token"> tag of an HTML page. */
async function csrf(agent, url = '/login') {
  const res = await agent.get(url);
  const m = /<meta name="csrf-token" content="([^"]+)"/.exec(res.text);
  if (!m) throw new Error(`No CSRF token on ${url} (status ${res.status})`);
  return m[1];
}

/** Signs in through the real login form; handles 2FA when `totpSecret` is given. */
async function login(app, { email, password = 'Correct-Horse-9', totpSecret, remember } = {}) {
  const agent = request.agent(app);
  const token = await csrf(agent, '/login');
  const res = await agent.post('/login').type('form').send({ _csrf: token, email, password, ...(remember ? { remember: '1' } : {}) });
  if (res.status !== 302) throw new Error(`Login failed with status ${res.status}`);
  if (res.headers.location === '/login/2fa') {
    const t2 = await csrf(agent, '/login/2fa');
    const r2 = await agent.post('/login/2fa').type('form').send({ _csrf: t2, code: authenticator.generate(totpSecret) });
    if (r2.status !== 302 || r2.headers.location === '/login/2fa') throw new Error('2FA step failed');
  }
  return agent;
}

/** Enables 2FA directly in the DB (for admin-role tests); returns the plain secret. */
async function enable2fa(userId) {
  const { db } = require('../../src/config/db');
  const totp = require('../../src/services/auth/totp');
  const secret = totp.generateSecret();
  const { hashes, codes } = await totp.generateRecoveryCodes(2);
  await db()('users').where({ id: userId }).update({ totp_secret_enc: totp.encryptSecret(secret), totp_enabled_at: new Date(), totp_recovery_codes: JSON.stringify(hashes) });
  return { secret, codes };
}

/** Delivers queued emails into storage/mail-outbox and returns the parsed messages for `to`. */
async function deliveredMail(to) {
  const { runDueJobs } = require('../../src/services/jobs/queue');
  await runDueJobs({ limit: 100 });
  const { storagePath } = require('../../src/config/paths');
  const dir = storagePath('mail-outbox');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
    .filter((m) => m.to === to);
}

async function closeAll(app) {
  if (app && app.locals.closeSessionStore) await app.locals.closeSessionStore();
  await require('../../src/config/db').closeDb();
}

module.exports = { bootApp, createUser, uniqueEmail, csrf, login, enable2fa, deliveredMail, closeAll };
