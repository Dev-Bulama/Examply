'use strict';

const path = require('path');
const { z } = require('zod');

const runtime = require('./runtime');

/**
 * Sources, highest priority first: real environment variables → .env → runtime config (written by the app:
 * generated secrets, installer database settings) → deploy/defaults.env (committed production defaults).
 */
function loadSources() {
  require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });
  runtime.apply();
  if (process.env.NODE_ENV !== 'test') {
    require('dotenv').config({ path: path.join(__dirname, '..', '..', 'deploy', 'defaults.env'), quiet: true });
    runtime.ensureSecrets();
  }
}
loadSources();

const bool = (def) =>
  z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) => {
      if (v === undefined || v === '') return def;
      if (typeof v === 'boolean') return v;
      return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
    });

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  APP_URL: z
    .string()
    .url('APP_URL must be a full URL, e.g. https://assess.example.com')
    .default('http://localhost:3000')
    .transform((v) => v.replace(/\/+$/, '')),
  APP_KEY: z
    .string({ error: 'APP_KEY is required. Run `npm run key:generate`.' })
    .refine((v) => {
      try {
        return Buffer.from(v, 'base64').length === 32;
      } catch {
        return false;
      }
    }, 'APP_KEY must be 32 bytes encoded as base64. Run `npm run key:generate`.'),
  SESSION_SECRET: z
    .string({ error: 'SESSION_SECRET is required. Run `npm run key:generate`.' })
    .min(32, 'SESSION_SECRET must be at least 32 characters.'),
  CRON_TOKEN: z
    .string({ error: 'CRON_TOKEN is required. Run `npm run key:generate`.' })
    .min(24, 'CRON_TOKEN must be at least 24 characters.'),
  DB_HOST: z.string().default('127.0.0.1'),
  DB_PORT: z.coerce.number().int().positive().default(3306),
  DB_USER: z.string().default(''),
  DB_PASSWORD: z.string().default(''),
  DB_NAME: z.string().default(''),
  SETUP_TOKEN: optionalString,
  APP_NAME: optionalString,
  DB_POOL_MAX: z.coerce.number().int().min(2).max(100).default(10),
  DEFAULT_TIMEZONE: z
    .string()
    .default('Africa/Lagos')
    .refine((tz) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, 'DEFAULT_TIMEZONE must be a valid IANA timezone, e.g. Africa/Lagos.'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  STORAGE_PATH: optionalString,
  RUN_SCHEDULER: bool(true),
  SUPERADMIN_EMAIL: optionalString,
  SUPERADMIN_PASSWORD: optionalString,
  SUPERADMIN_NAME: optionalString,
});

function loadEnv(source = process.env) {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.') || 'env'}: ${i.message}`);
    const err = new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
    err.code = 'ENV_INVALID';
    throw err;
  }
  const env = parsed.data;
  env.isProduction = env.NODE_ENV === 'production';
  env.isTest = env.NODE_ENV === 'test';
  env.dbConfigured = !!(env.DB_USER && env.DB_NAME);
  env.rootDir = path.join(__dirname, '..', '..');
  // "~/examply-storage" keeps uploads, receipts and certificates outside the app folder, so redeploys never erase them.
  const sp = env.STORAGE_PATH && env.STORAGE_PATH.startsWith('~/') ? path.join(require('os').homedir(), env.STORAGE_PATH.slice(2)) : env.STORAGE_PATH;
  env.storageDir = sp ? path.resolve(sp) : path.join(env.rootDir, 'storage');
  return Object.freeze(env);
}

let cached;
function getEnv() {
  if (!cached) cached = loadEnv();
  return cached;
}

/** Re-reads the sources after the installer saved new settings (e.g. database credentials). */
function reloadEnv() {
  cached = undefined;
  runtime.apply();
  return getEnv();
}

module.exports = { getEnv, loadEnv, reloadEnv, schema };
