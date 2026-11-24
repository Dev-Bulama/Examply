'use strict';

const path = require('path');
const { z } = require('zod');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });

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
    .string({ required_error: 'APP_KEY is required. Run `npm run key:generate`.' })
    .refine((v) => {
      try {
        return Buffer.from(v, 'base64').length === 32;
      } catch {
        return false;
      }
    }, 'APP_KEY must be 32 bytes encoded as base64. Run `npm run key:generate`.'),
  SESSION_SECRET: z
    .string({ required_error: 'SESSION_SECRET is required. Run `npm run key:generate`.' })
    .min(32, 'SESSION_SECRET must be at least 32 characters.'),
  CRON_TOKEN: z
    .string({ required_error: 'CRON_TOKEN is required. Run `npm run key:generate`.' })
    .min(24, 'CRON_TOKEN must be at least 24 characters.'),
  DB_HOST: z.string().default('127.0.0.1'),
  DB_PORT: z.coerce.number().int().positive().default(3306),
  DB_USER: z.string({ required_error: 'DB_USER is required.' }).min(1),
  DB_PASSWORD: z.string().default(''),
  DB_NAME: z.string({ required_error: 'DB_NAME is required.' }).min(1),
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
  env.rootDir = path.join(__dirname, '..', '..');
  env.storageDir = env.STORAGE_PATH ? path.resolve(env.STORAGE_PATH) : path.join(env.rootDir, 'storage');
  return Object.freeze(env);
}

let cached;
function getEnv() {
  if (!cached) cached = loadEnv();
  return cached;
}

module.exports = { getEnv, loadEnv, schema };
