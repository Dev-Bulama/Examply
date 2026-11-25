'use strict';

const { loadEnv } = require('../../src/config/env');
const { PERMISSIONS, ROLES, ALL_KEYS } = require('../../src/config/permissions');
const { ADMIN_NAV } = require('../../src/config/navigation');
const theme = require('../../src/services/theme');
const passwords = require('../../src/services/auth/passwords');
const { interpolate } = require('../../src/services/mail');
const { DEFAULT_TEMPLATES } = require('../../src/services/mail/templates');

describe('environment validation', () => {
  const good = { APP_KEY: Buffer.alloc(32, 1).toString('base64'), SESSION_SECRET: 'x'.repeat(40), CRON_TOKEN: 'y'.repeat(30), DB_USER: 'u', DB_NAME: 'd' };
  test('accepts a complete configuration with defaults', () => {
    const env = loadEnv(good);
    expect(env.PORT).toBe(3000);
    expect(env.DEFAULT_TIMEZONE).toBe('Africa/Lagos');
    expect(env.RUN_SCHEDULER).toBe(true);
  });
  test('explains every missing or invalid variable', () => {
    expect(() => loadEnv({ ...good, APP_KEY: 'short' })).toThrow(/APP_KEY must be 32 bytes/);
    // Database settings may come from the /install wizard instead, so they are optional here.
    expect(loadEnv({ ...good, DB_USER: undefined }).dbConfigured).toBe(false);
    expect(loadEnv(good).dbConfigured).toBe(true);
    expect(() => loadEnv({ ...good, DEFAULT_TIMEZONE: 'Nowhere/City' })).toThrow(/timezone/);
    expect(() => loadEnv({ ...good, PORT: 'abc' })).toThrow(/PORT/);
  });
});

describe('permission catalogue', () => {
  test('keys are unique and every role references real permissions', () => {
    expect(new Set(ALL_KEYS).size).toBe(PERMISSIONS.length);
    for (const role of ROLES) for (const k of role.permissions) expect(ALL_KEYS).toContain(k);
  });
  test('admin cannot see the Paystack secret, change roles or read the audit log', () => {
    const admin = ROLES.find((r) => r.slug === 'admin');
    expect(admin.permissions).not.toEqual(expect.arrayContaining(['settings.payments.secret']));
    expect(admin.permissions).not.toContain('roles.manage');
    expect(admin.permissions).not.toContain('audit.view');
    expect(admin.permissions).toContain('questions.import');
  });
  test('every admin navigation item is permission-gated', () => {
    for (const s of ADMIN_NAV) for (const i of s.items) expect(i.any || i.all).toBeTruthy();
  });
});

describe('theme', () => {
  test('generates a full palette of CSS variables', () => {
    const css = theme.themeCss({ primary: '#1f4fd1', secondary: '#0f9d7a' });
    expect(css).toContain('--c-primary-600: 31 79 209;');
    expect(css).toContain('--c-secondary-50:');
    expect(css).toContain('--c-on-primary: 255 255 255;');
  });
  test('picks dark text on light brand colours', () => {
    expect(theme.themeCss({ primary: '#fde047', secondary: '#000000' })).toContain('--c-on-primary: 15 23 42;');
  });
  test('rejects invalid colours', () => {
    expect(theme.isHexColor('#abc')).toBe(true);
    expect(theme.isHexColor('red')).toBe(false);
  });
});

describe('password policy', () => {
  const policy = { minLength: 10, mixedCase: true, number: true, symbol: false };
  test('accepts a strong password', () => expect(passwords.check('Lagos-Exam-2026', policy)).toEqual([]));
  test('reports every problem', () => {
    const p = passwords.check('short', policy);
    expect(p).toEqual(expect.arrayContaining(['Use at least 10 characters.', 'Use both upper- and lower-case letters.', 'Include at least one number.']));
  });
  test('rejects passwords containing the email name', () => {
    expect(passwords.check('Adaobi-2026-Strong', policy, { email: 'adaobi@example.com' })).toContain('Do not include your email address in the password.');
  });
  test('symbol rule and description', () => {
    expect(passwords.check('Abcdefgh12', { ...policy, symbol: true })).toContain('Include at least one symbol.');
    expect(passwords.describe(policy)).toBe('Use at least 10 characters, upper- and lower-case letters and a number.');
  });
});

describe('email templates', () => {
  test('interpolation escapes HTML', () => {
    expect(interpolate('Hi {{name}}', { name: '<b>x</b>' })).toBe('Hi &lt;b&gt;x&lt;/b&gt;');
    expect(interpolate('{{missing}}!', {})).toBe('!');
  });
  test('every template declares the variables it uses', () => {
    for (const t of DEFAULT_TEMPLATES) {
      const used = [...`${t.subject} ${t.body_html}`.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)].map((m) => m[1]);
      for (const v of used) expect(['site_name', 'site_url', 'year', 'brand_color', ...t.variables]).toContain(v);
    }
  });
});

describe('audit scrubbing', () => {
  const { scrub } = require('../../src/services/audit');
  test('redacts secrets but keeps policy values', () => {
    expect(
      scrub({ 'security.password_min_length': 12, 'email.smtp_password': 'x', 'auth.google_client_secret': 'y', token_hash: 't', totp_secret_enc: 'e', nested: { current_password: 'c', name: 'ok' } }),
    ).toEqual({
      'security.password_min_length': 12,
      'email.smtp_password': '[redacted]',
      'auth.google_client_secret': '[redacted]',
      token_hash: '[redacted]',
      totp_secret_enc: '[redacted]',
      nested: { current_password: '[redacted]', name: 'ok' },
    });
  });
});

describe('runtime config file', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const runtime = require('../../src/config/runtime');
  let dir;
  let saved;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-'));
    saved = { ...process.env };
    process.env.RUNTIME_CONFIG = path.join(dir, 'app.env');
  });
  afterEach(() => {
    process.env = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('generates missing secrets once and keeps them private', () => {
    delete process.env.APP_KEY;
    delete process.env.SESSION_SECRET;
    delete process.env.CRON_TOKEN;
    expect(runtime.ensureSecrets().sort()).toEqual(['APP_KEY', 'CRON_TOKEN', 'SESSION_SECRET']);
    const key = process.env.APP_KEY;
    expect(Buffer.from(key, 'base64')).toHaveLength(32);
    expect(runtime.ensureSecrets()).toEqual([]);
    expect(runtime.read().APP_KEY).toBe(key);
    expect(fs.statSync(process.env.RUNTIME_CONFIG).mode & 0o077).toBe(0);
  });

  test('round-trips values with spaces and symbols; never overrides real env vars', () => {
    runtime.write({ DB_PASSWORD: 'p@ss "w=rd" #1', DB_NAME: 'u1_examply' });
    expect(runtime.read()).toMatchObject({ DB_PASSWORD: 'p@ss "w=rd" #1', DB_NAME: 'u1_examply' });
    process.env.DB_NAME = 'from-env';
    runtime.apply();
    expect(process.env.DB_NAME).toBe('from-env');
  });
});
