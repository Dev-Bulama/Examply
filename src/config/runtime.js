'use strict';

/**
 * Runtime configuration file — settings the app writes for itself so a fresh deployment works with no manual
 * environment setup:
 *   - secrets generated on first boot (APP_KEY, SESSION_SECRET, CRON_TOKEN) when the environment has none;
 *   - database credentials entered in the /install wizard;
 *   - INSTALLED_AT, so a redeploy that wipes the app folder (and storage/installed.lock) is still "installed".
 *
 * It lives OUTSIDE the application folder by default (~/.examply/app.env) so Git/ZIP redeploys never erase it.
 * Override with RUNTIME_CONFIG=/absolute/path/app.env. Real environment variables and .env always win.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');

function candidates() {
  if (process.env.RUNTIME_CONFIG) return [path.resolve(process.env.RUNTIME_CONFIG)];
  const list = [];
  try {
    list.push(path.join(os.homedir(), '.examply', 'app.env'));
  } catch {
    /* no home directory */
  }
  list.push(path.join(ROOT, 'storage', 'app.env'));
  return list;
}

/** The file in use: the first one that exists, else the first location we can write to. */
function filePath() {
  const list = candidates();
  const existing = list.find((p) => fs.existsSync(p));
  if (existing) return existing;
  for (const p of list) {
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
      fs.accessSync(path.dirname(p), fs.constants.W_OK);
      return p;
    } catch {
      /* try the next location */
    }
  }
  return null;
}

function parse(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if (/^".*"$/.test(v)) v = JSON.parse(v);
    out[m[1]] = v;
  }
  return out;
}

function read() {
  const p = filePath();
  if (!p || !fs.existsSync(p)) return {};
  try {
    return parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

/** Merges values into the file (0600) and into process.env. Returns false when nothing is writable. */
function write(values) {
  const p = filePath();
  if (!p) return false;
  const merged = { ...read(), ...values };
  const body = [
    '# Written by Examply. Keep a backup: APP_KEY must never change after install.',
    ...Object.entries(merged)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${k}=${/[\s#"'=]/.test(String(v)) || String(v) === '' ? JSON.stringify(String(v)) : v}`),
    '',
  ].join('\n');
  try {
    fs.writeFileSync(p, body, { mode: 0o600 });
  } catch {
    return false;
  }
  for (const [k, v] of Object.entries(values)) process.env[k] = String(v);
  return true;
}

/** Applies the file to process.env without overriding variables that are already set. */
function apply() {
  for (const [k, v] of Object.entries(read())) if (process.env[k] === undefined || process.env[k] === '') process.env[k] = v;
}

const GENERATORS = {
  APP_KEY: () => crypto.randomBytes(32).toString('base64'),
  SESSION_SECRET: () => crypto.randomBytes(48).toString('hex'),
  CRON_TOKEN: () => crypto.randomBytes(24).toString('hex'),
};

/** Generates and stores any missing secret. Returns the names generated. */
function ensureSecrets() {
  const missing = Object.keys(GENERATORS).filter((k) => !process.env[k]);
  if (!missing.length) return [];
  const values = Object.fromEntries(missing.map((k) => [k, GENERATORS[k]()]));
  if (!write(values)) for (const [k, v] of Object.entries(values)) process.env[k] = v; // in-memory only
  return missing;
}

module.exports = { filePath, read, write, apply, ensureSecrets, parse };
