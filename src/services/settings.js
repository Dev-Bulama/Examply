'use strict';

const { db } = require('../config/db');
const { getEnv } = require('../config/env');
const { encrypt, decrypt } = require('../utils/crypto');

/**
 * Typed key/value settings. Every key used anywhere must be declared here with a type and default.
 * Encrypted keys are stored AES-256-GCM encrypted and are never rendered back in full.
 */
const DEFINITIONS = {
  // General
  'general.site_name': { type: 'string', default: 'Skillscore Assess' },
  'general.tagline': { type: 'string', default: 'Professional assessment & certification practice' },
  'general.logo_path': { type: 'string', default: '' },
  'general.favicon_path': { type: 'string', default: '' },
  'general.timezone': { type: 'string', default: () => getEnv().DEFAULT_TIMEZONE },
  'general.date_format': { type: 'string', default: 'D MMM YYYY' },
  'general.contact_email': { type: 'string', default: '' },
  'general.currency': { type: 'string', default: 'NGN' },
  // Branding
  'branding.primary_color': { type: 'string', default: '#1f4fd1' },
  'branding.secondary_color': { type: 'string', default: '#0f9d7a' },
  'branding.default_theme': { type: 'string', default: 'system' },
  // Security
  'security.require_2fa_admin': { type: 'boolean', default: true },
  'security.password_min_length': { type: 'number', default: 10 },
  'security.password_require_mixed_case': { type: 'boolean', default: true },
  'security.password_require_number': { type: 'boolean', default: true },
  'security.password_require_symbol': { type: 'boolean', default: false },
  'security.session_idle_minutes': { type: 'number', default: 60 },
  'security.remember_me_days': { type: 'number', default: 30 },
  'security.registration_open': { type: 'boolean', default: true },
  // Auth providers
  'auth.google_enabled': { type: 'boolean', default: false },
  'auth.google_client_id': { type: 'string', default: '' },
  'auth.google_client_secret': { type: 'string', default: '', encrypted: true },
  // Email (SMTP)
  'email.smtp_host': { type: 'string', default: '' },
  'email.smtp_port': { type: 'number', default: 587 },
  'email.smtp_secure': { type: 'boolean', default: false },
  'email.smtp_user': { type: 'string', default: '' },
  'email.smtp_password': { type: 'string', default: '', encrypted: true },
  'email.from_name': { type: 'string', default: '' },
  'email.from_address': { type: 'string', default: '' },
  // AI question generation
  'ai.enabled': { type: 'boolean', default: false },
  'ai.default_provider': { type: 'string', default: 'anthropic' },
  'ai.anthropic_api_key': { type: 'string', default: '', encrypted: true },
  'ai.anthropic_model': { type: 'string', default: 'claude-opus-5-5' },
  'ai.anthropic_effort': { type: 'string', default: 'high' },
  'ai.openai_api_key': { type: 'string', default: '', encrypted: true },
  'ai.openai_model': { type: 'string', default: '' },
  'ai.openai_base_url': { type: 'string', default: 'https://api.openai.com/v1' },
  'ai.max_questions_per_run': { type: 'number', default: 100 },
  // Maintenance
  'maintenance.enabled': { type: 'boolean', default: false },
  'maintenance.message': { type: 'string', default: 'We are performing scheduled maintenance and will be back shortly.' },
  // SEO
  'seo.meta_description': { type: 'string', default: 'Pre-training diagnostics, certification mock exams and past-question practice.' },
  'seo.og_image_path': { type: 'string', default: '' },
  // Internal
  'system.installed_at': { type: 'string', default: '' },
};

let cache = null;

function definition(key) {
  const def = DEFINITIONS[key];
  if (!def) throw new Error(`Unknown setting: ${key}`);
  return def;
}

function defaultFor(def) {
  return typeof def.default === 'function' ? def.default() : def.default;
}

function castFromDb(def, raw) {
  if (raw === null || raw === undefined) return defaultFor(def);
  switch (def.type) {
    case 'boolean':
      return raw === '1' || raw === 'true';
    case 'number': {
      const n = Number(raw);
      return Number.isFinite(n) ? n : defaultFor(def);
    }
    case 'json':
      try {
        return JSON.parse(raw);
      } catch {
        return defaultFor(def);
      }
    default:
      return String(raw);
  }
}

function castToDb(def, value) {
  if (value === null || value === undefined) return null;
  switch (def.type) {
    case 'boolean':
      return value ? '1' : '0';
    case 'number':
      return String(Number(value));
    case 'json':
      return JSON.stringify(value);
    default:
      return String(value);
  }
}

async function load(knex = db()) {
  const rows = await knex('settings').select('key', 'value', 'is_encrypted');
  const map = new Map();
  for (const row of rows) {
    let { value } = row;
    if (row.is_encrypted && value) {
      try {
        value = decrypt(value);
      } catch {
        value = null; // APP_KEY changed; treat as unset rather than crash
      }
    }
    map.set(row.key, value);
  }
  cache = map;
  return map;
}

async function ensureLoaded() {
  if (!cache) await load();
  return cache;
}

/** Synchronous read from the warm cache (call ensureLoaded/load first, e.g. in middleware). */
function getSync(key) {
  const def = definition(key);
  if (!cache) return defaultFor(def);
  return castFromDb(def, cache.has(key) ? cache.get(key) : null);
}

async function get(key) {
  await ensureLoaded();
  return getSync(key);
}

async function getMany(prefix) {
  await ensureLoaded();
  const out = {};
  for (const key of Object.keys(DEFINITIONS)) {
    if (key.startsWith(prefix)) out[key] = getSync(key);
  }
  return out;
}

async function isSet(key) {
  await ensureLoaded();
  const v = cache.get(key);
  return v !== null && v !== undefined && v !== '';
}

/** Saves several settings at once. Returns {before, after} with encrypted values masked, for audit logs. */
async function setMany(values, { userId = null, knex = db() } = {}) {
  await ensureLoaded();
  const before = {};
  const after = {};
  await knex.transaction(async (trx) => {
    for (const [key, value] of Object.entries(values)) {
      const def = definition(key);
      const stored = castToDb(def, value);
      before[key] = def.encrypted ? (cache.get(key) ? '[set]' : '[empty]') : getSync(key);
      after[key] = def.encrypted ? (stored ? '[set]' : '[empty]') : castFromDb(def, stored);
      const dbValue = def.encrypted && stored ? encrypt(stored) : stored;
      await trx.raw(
        'INSERT INTO settings (`key`, `value`, is_encrypted, updated_by) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`), is_encrypted = VALUES(is_encrypted), updated_by = VALUES(updated_by)',
        [key, dbValue, def.encrypted ? 1 : 0, userId],
      );
    }
  });
  for (const [key, value] of Object.entries(values)) {
    cache.set(key, castToDb(definition(key), value));
  }
  return { before, after };
}

const set = (key, value, opts) => setMany({ [key]: value }, opts);

function invalidate() {
  cache = null;
}

module.exports = { DEFINITIONS, load, ensureLoaded, get, getSync, getMany, isSet, set, setMany, invalidate };
