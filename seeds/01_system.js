'use strict';

/**
 * System data (always safe to run): permissions, roles, email templates, and the Super Admin from .env
 * when SUPERADMIN_EMAIL / SUPERADMIN_PASSWORD are set. Demo content lives in later seed files.
 */
const fs = require('fs');
const { getEnv } = require('../src/config/env');
const { installLockPath, ensureStorage } = require('../src/config/paths');
const system = require('../src/services/system');
const users = require('../src/services/auth/users');
const rbac = require('../src/services/rbac');
const settings = require('../src/services/settings');

exports.seed = async function seed(knex) {
  ensureStorage();
  await system.syncSystemData(knex);
  const env = getEnv();
  if (env.SUPERADMIN_EMAIL && env.SUPERADMIN_PASSWORD) {
    let admin = await users.findByEmail(env.SUPERADMIN_EMAIL, knex);
    if (!admin) {
      admin = await users.createUser(
        { email: env.SUPERADMIN_EMAIL, password: env.SUPERADMIN_PASSWORD, fullName: env.SUPERADMIN_NAME || 'Super Admin', roles: ['super_admin'], emailVerified: true },
        knex,
      );
    } else {
      await rbac.assignRole(admin.id, 'super_admin', knex);
    }
    if (!fs.existsSync(installLockPath())) {
      settings.invalidate();
      await settings.setMany({ 'system.installed_at': new Date().toISOString() }, { userId: admin.id, knex });
      fs.writeFileSync(installLockPath(), JSON.stringify({ installed_at: new Date().toISOString(), admin: admin.email, via: 'seed' }, null, 2));
    }
  }
};
