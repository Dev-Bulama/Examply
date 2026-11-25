'use strict';

const fs = require('fs');
const path = require('path');
const { bootApp, closeAll } = require('../helpers/app');
const { db } = require('../../src/config/db');
const { storagePath, installLockPath } = require('../../src/config/paths');
const system = require('../../src/services/system');
const fileStore = require('../../src/services/fileStore');
const { createUser } = require('../helpers/app');

let app;
beforeAll(async () => {
  app = await bootApp();
});
afterAll(async () => closeAll(app));

describe('surviving a redeploy that wipes the file system', () => {
  test('uploaded files are backed up to the database and restored when missing', async () => {
    const file = storagePath('uploads', 'public', 'branding', `${Date.now().toString(16).padStart(32, '0')}.png`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from('89504e470d0a1a0a', 'hex'));
    expect(await fileStore.persist(file)).toBe(true);
    fs.rmSync(file);
    expect(await fileStore.restoreMissing()).toBeGreaterThanOrEqual(1);
    expect(fs.readFileSync(file).toString('hex')).toBe('89504e470d0a1a0a');
    await fileStore.remove(file);
    expect(await db()('stored_files').where({ path: fileStore.relative(file) }).first()).toBeUndefined();
    expect(fileStore.relative('/etc/passwd')).toBeNull(); // only files inside storage
  });

  test('an existing installation is recognised from the database', async () => {
    const admin = await createUser({ roles: ['super_admin'] });
    await db()('settings').insert({ key: 'system.installed_at', value: new Date().toISOString(), is_encrypted: false }).onConflict('key').merge();
    fs.rmSync(installLockPath(), { force: true });
    system.resetInstalledCache();
    expect(system.isInstalled()).toBe(false);
    expect(await system.detectInstalled()).toBe(true);
    expect(system.isInstalled()).toBe(true);
    expect(fs.existsSync(installLockPath())).toBe(true);
    expect(admin.id).toBeTruthy();
  });
});
