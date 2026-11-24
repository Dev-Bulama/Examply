'use strict';

const fs = require('fs');
const path = require('path');
const { getEnv } = require('./env');

const SUBDIRS = ['uploads', 'uploads/private', 'uploads/public', 'logs', 'pdf', 'imports', 'backups', 'mail-outbox', 'tmp'];

function storagePath(...parts) {
  return path.join(getEnv().storageDir, ...parts);
}

/** Create every writable directory under storage/ if missing. Returns the list of problems (empty = OK). */
function ensureStorage() {
  const problems = [];
  const root = getEnv().storageDir;
  for (const dir of ['', ...SUBDIRS]) {
    const full = path.join(root, dir);
    try {
      fs.mkdirSync(full, { recursive: true });
      fs.accessSync(full, fs.constants.W_OK);
    } catch (err) {
      problems.push(`${full}: ${err.code || err.message}`);
    }
  }
  return problems;
}

const installLockPath = () => storagePath('installed.lock');

module.exports = { storagePath, ensureStorage, installLockPath, SUBDIRS };
