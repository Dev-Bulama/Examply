'use strict';

/**
 * Creates (or promotes) a Super Admin from the command line.
 *   node scripts/create-admin.js "Ada Obi" ada@example.com 'Str0ng-Passw0rd' [--reset-2fa]
 * --reset-2fa also clears two-factor authentication (they will enrol again at next sign-in).
 * Falls back to SUPERADMIN_NAME / SUPERADMIN_EMAIL / SUPERADMIN_PASSWORD from the environment.
 */
const { getEnv } = require('../src/config/env');
const { db, closeDb } = require('../src/config/db');
const system = require('../src/services/system');
const users = require('../src/services/auth/users');
const rbac = require('../src/services/rbac');
const passwords = require('../src/services/auth/passwords');
const settings = require('../src/services/settings');

(async () => {
  const env = getEnv();
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const reset2fa = process.argv.includes('--reset-2fa');
  const [name = env.SUPERADMIN_NAME, email = env.SUPERADMIN_EMAIL, password = env.SUPERADMIN_PASSWORD] = args;
  if (!name || !email || !password) {
    process.stderr.write('Usage: node scripts/create-admin.js "Full Name" email@example.com "password"\n');
    process.exit(1);
  }
  await db().migrate.latest();
  await system.syncSystemData();
  const problems = passwords.check(password, await passwords.policy(), { email, name });
  if (problems.length) throw new Error(`Password rejected: ${problems.join(' ')}`);
  let user = await users.findByEmail(email);
  if (user) {
    await users.setPassword(user.id, password);
    await rbac.assignRole(user.id, 'super_admin');
    if (reset2fa) {
      await db()('users').where({ id: user.id }).update({ totp_secret_enc: null, totp_enabled_at: null, totp_recovery_codes: null, totp_last_step: null });
      process.stdout.write('Two-factor authentication cleared.\n');
    }
    process.stdout.write(`Promoted ${email} to Super Admin and reset the password (other sessions signed out).\n`);
  } else {
    user = await users.createUser({ email, password, fullName: name, roles: ['super_admin'], emailVerified: true });
    process.stdout.write(`Created Super Admin ${email}.\n`);
  }
  if (!system.isInstalled()) {
    const fs = require('fs');
    const { installLockPath } = require('../src/config/paths');
    await settings.setMany({ 'system.installed_at': new Date().toISOString() }, { userId: user.id });
    fs.writeFileSync(installLockPath(), JSON.stringify({ installed_at: new Date().toISOString(), admin: email, via: 'cli' }, null, 2));
    process.stdout.write('Installation lock written; /install is now disabled.\n');
  }
  await closeDb();
})().catch(async (err) => {
  process.stderr.write(`${err.message}\n`);
  await closeDb();
  process.exit(1);
});
