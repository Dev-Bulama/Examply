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
    node: { ok: major >= 20, value: process.versions.node, need: '20 or 22 (22 recommended)' },
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

/**
 * The database is the source of truth: if it already holds an EXAMPLY installation, mark this server as
 * installed (hosts that wipe the file system on every deploy would otherwise show the installer again).
 */
async function detectInstalled(knex = db()) {
  if (isInstalled()) return true;
  if (!require('../config/env').getEnv().dbConfigured) return false;
  try {
    if (!(await knex.schema.hasTable('settings'))) return false;
    const row = await knex('settings').where({ key: 'system.installed_at' }).first('value');
    const admin = await knex('user_roles as ur').join('roles as r', 'r.id', 'ur.role_id').where('r.slug', 'super_admin').first('ur.user_id');
    if (!row || !admin) return false;
    try {
      ensureStorage();
      fs.writeFileSync(installLockPath(), JSON.stringify({ installed_at: new Date().toISOString(), via: 'database' }, null, 2));
    } catch {
      /* read-only storage: the in-memory flag below still applies */
    }
    installedCache = true;
    return true;
  } catch {
    return false;
  }
}

module.exports = { detectInstalled, isInstalled, resetInstalledCache, syncSystemData, requirements, install };
