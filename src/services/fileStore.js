'use strict';

/**
 * Database-backed copies of uploaded files. Some hosts replace the whole file system on every deploy, so
 * every upload is also saved in `stored_files`, and missing files are written back at start-up.
 * Never throws: a failed backup must not break the upload that triggered it (it is logged instead).
 */
const fs = require('fs');
const path = require('path');
const { db } = require('../config/db');
const { getEnv } = require('../config/env');
const { getLogger } = require('../config/logger');

const MAX_BYTES = 15 * 1024 * 1024;

function relative(absPath) {
  const rel = path.relative(getEnv().storageDir, absPath).split(path.sep).join('/');
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : null;
}

/** Saves (or replaces) the database copy of a file inside the storage folder. */
async function persist(absPath, knex = db()) {
  const rel = relative(absPath);
  if (!rel) return false;
  try {
    const buf = fs.readFileSync(absPath);
    if (buf.length > MAX_BYTES) return false;
    await knex('stored_files').insert({ path: rel, content: buf, size: buf.length, updated_at: new Date() }).onConflict('path').merge();
    return true;
  } catch (err) {
    getLogger().warn({ err: err.message, file: rel }, 'file not backed up to the database');
    return false;
  }
}

async function remove(absPath, knex = db()) {
  const rel = relative(absPath);
  if (!rel) return;
  try {
    await knex('stored_files').where({ path: rel }).del();
  } catch (err) {
    getLogger().warn({ err: err.message, file: rel }, 'file backup not removed');
  }
}

/** Writes back every backed-up file that is missing on disk (after a deploy). Returns the number restored. */
async function restoreMissing(knex = db()) {
  const root = getEnv().storageDir;
  const rows = await knex('stored_files').select('path', 'size');
  let restored = 0;
  for (const r of rows) {
    const full = path.join(root, r.path);
    if (!full.startsWith(root + path.sep) || fs.existsSync(full)) continue;
    const row = await knex('stored_files').where({ path: r.path }).first('content');
    if (!row) continue;
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, row.content);
    restored += 1;
  }
  if (restored) getLogger().info({ restored }, 'restored uploaded files from the database');
  return restored;
}

module.exports = { persist, remove, restoreMissing, relative };
