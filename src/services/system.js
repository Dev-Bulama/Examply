'use strict';

const fs = require('fs');
const { db, checkConnection } = require('../config/db');
const { installLockPath, ensureStorage } = require('../config/paths');
const rbac = require('./rbac');
const mail = require('./mail');
const settings = require('./settings');
const users = require('./auth/users');

let installedCache = null;

function isInstalled() {
  if (installedCache === true) return true;
  // The runtime config survives redeploys that replace the app folder (and storage/installed.lock with it).
  installedCache = fs.existsSync(installLockPath()) || (!process.env.JEST_WORKER_ID && !!require('../config/runtime').read().INSTALLED_AT);
  return installedCache;
}

function resetInstalledCache() {
  installedCache = null;
}

/** Idempotent: permissions, system roles, email templates. Runs on install, seed and every boot. */
async function syncSystemData(knex = db()) {
  await rbac.syncPermissions(knex);
  await mail.seedTemplates(knex);
}

/** Pre-install checks shown by the /install wizard. */
async function requirements() {
  const [major] = process.versions.node.split('.').map(Number);
  const storageProblems = ensureStorage();
  const dbError = await checkConnection();
  let dbVersion = null;
  if (!dbError) {
    const [rows] = await db().raw('select version() as v');
    dbVersion = rows[0].v;
  }
  return {
    node: { ok: major >= 18, value: process.versions.node, need: '18, 20 or 22' },
    storage: { ok: storageProblems.length === 0, problems: storageProblems },
    database: { ok: !dbError, error: dbError, version: dbVersion },
  };
}

/**
 * Runs migrations, system data, creates the Super Admin, stores the site name/timezone and writes the lock file.
 */
async function install({ siteName, timezone, adminName, adminEmail, adminPassword }, knex = db()) {
  if (isInstalled()) throw new Error('The platform is already installed.');
  await knex.migrate.latest();
  await syncSystemData(knex);
  settings.invalidate();
  const existing = await users.findByEmail(adminEmail, knex);
  let admin;
  if (existing) {
    await users.setPassword(existing.id, adminPassword, knex);
    await rbac.assignRole(existing.id, 'super_admin', knex);
    admin = existing;
  } else {
    admin = await users.createUser({ email: adminEmail, password: adminPassword, fullName: adminName, roles: ['super_admin'], emailVerified: true }, knex);
  }
  await settings.setMany({ 'general.site_name': siteName, 'general.timezone': timezone, 'general.contact_email': adminEmail, 'system.installed_at': new Date().toISOString() }, { userId: admin.id, knex });
  fs.writeFileSync(installLockPath(), JSON.stringify({ installed_at: new Date().toISOString(), admin: admin.email }, null, 2));
  if (!process.env.JEST_WORKER_ID) require('../config/runtime').write({ INSTALLED_AT: new Date().toISOString() });
  installedCache = true;
  return admin;
}

module.exports = { isInstalled, resetInstalledCache, syncSystemData, requirements, install };
