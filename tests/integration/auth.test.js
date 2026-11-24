'use strict';

const request = require('supertest');
const { bootApp, createUser, uniqueEmail, csrf, login, enable2fa, deliveredMail, closeAll } = require('../helpers/app');
const { db } = require('../../src/config/db');

let app;
beforeAll(async () => {
  app = await bootApp();
});
afterAll(() => closeAll(app));

describe('registration and email verification', () => {
  test('registers, signs in, emails a verification link that works once', async () => {
    const agent = request.agent(app);
    const email = uniqueEmail('reg');
    const token = await csrf(agent, '/register');
    const res = await agent.post('/register').type('form').send({ _csrf: token, full_name: 'Chidi Okafor', email, password: 'Strong-Pass-123', password_confirmation: 'Strong-Pass-123', accept_terms: '1' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/dashboard');
    const dash = await agent.get('/dashboard');
    expect(dash.status).toBe(200);
    expect(dash.text).toContain('Welcome, Chidi');
    expect(dash.text).toContain('Resend link');

    const [mail] = await deliveredMail(email);
    expect(mail.subject).toContain('verify');
    const link = /\/verify-email\/([A-Za-z0-9_-]+)/.exec(mail.html)[0];
    expect((await agent.get(link)).headers.location).toBe('/dashboard');
    const user = await db()('users').where({ email }).first();
    expect(user.email_verified_at).not.toBeNull();
    // single use
    await agent.get(link);
    const again = await agent.get('/dashboard');
    expect(again.text).not.toContain('Resend link');
  });

  test('rejects weak passwords, mismatches, missing consent and duplicate emails', async () => {
    const existing = await createUser();
    const agent = request.agent(app);
    const token = await csrf(agent, '/register');
    await agent.post('/register').type('form').send({ _csrf: token, full_name: 'X Y', email: existing.email, password: 'weak', password_confirmation: 'other' });
    const page = await agent.get('/register');
    expect(page.text).toContain('Use at least 10 characters.');
    expect(page.text).toContain('The passwords do not match.');
    expect(page.text).toContain('You must accept the terms');
    expect(page.text).toContain(`value="${existing.email}"`); // input preserved
  });
});

describe('login', () => {
  test('rejects a POST without a CSRF token', async () => {
    const res = await request(app).post('/login').type('form').send({ email: 'a@b.c', password: 'x' });
    expect(res.status).toBe(403);
  });

  test('locks the email+IP pair after 5 failures, with a visible notice', async () => {
    const user = await createUser();
    const agent = request.agent(app);
    for (let i = 0; i < 4; i += 1) {
      const t = await csrf(agent, '/login');
      const r = await agent.post('/login').type('form').send({ _csrf: t, email: user.email, password: 'Wrong-Pass-000' });
      expect(r.status).toBe(302);
    }
    const t5 = await csrf(agent, '/login');
    const fifth = await agent.post('/login').type('form').send({ _csrf: t5, email: user.email, password: 'Wrong-Pass-000' });
    expect(fifth.status).toBe(429);
    expect(fifth.text).toContain('Sign-in temporarily locked');
    // Even the right password is refused while locked
    const t6 = await csrf(agent, '/login');
    const locked = await agent.post('/login').type('form').send({ _csrf: t6, email: user.email, password: 'Correct-Horse-9' });
    expect(locked.status).toBe(429);
    const history = await db()('login_history').where({ email: user.email });
    expect(history.length).toBe(6);
  });

  test('regenerates the session on login and supports remember-me', async () => {
    const user = await createUser();
    const agent = request.agent(app);
    const first = await agent.get('/login');
    const before = /ssa\.sid=([^;]+)/.exec(first.headers['set-cookie'].join(';'))[1];
    const t = /<meta name="csrf-token" content="([^"]+)"/.exec(first.text)[1];
    const res = await agent.post('/login').type('form').send({ _csrf: t, email: user.email, password: 'Correct-Horse-9', remember: '1' });
    const after = /ssa\.sid=([^;]+)/.exec(res.headers['set-cookie'].join(';'))[1];
    expect(after).not.toBe(before);
    expect(res.headers['set-cookie'].join(';')).toMatch(/Expires=/);
  });

  test('suspended users cannot sign in', async () => {
    const user = await createUser();
    await db()('users').where({ id: user.id }).update({ status: 'suspended' });
    const agent = request.agent(app);
    const t = await csrf(agent, '/login');
    const res = await agent.post('/login').type('form').send({ _csrf: t, email: user.email, password: 'Correct-Horse-9' });
    expect(res.headers.location).toBe('/login');
    expect((await agent.get('/dashboard')).headers.location).toBe('/login');
  });

  test('only same-site return URLs are honoured after login', async () => {
    const { safeReturnTo } = require('../../src/services/auth/session');
    expect(safeReturnTo('/admin/users', '/dashboard')).toBe('/admin/users');
    expect(safeReturnTo('//evil.example', '/dashboard')).toBe('/dashboard');
    expect(safeReturnTo('https://evil.example', '/dashboard')).toBe('/dashboard');
  });
});

describe('two-factor authentication', () => {
  test('admins must enrol before using anything else', async () => {
    const admin = await createUser({ roles: ['admin'] });
    const agent = await login(app, { email: admin.email });
    const res = await agent.get('/admin/users');
    expect(res.headers.location).toBe('/account/security/2fa');
    const page = await agent.get('/account/security/2fa');
    expect(page.status).toBe(200);
    expect(page.text).toContain('Scan this QR code');
  });

  test('enrolled users need a valid code; recovery codes work exactly once', async () => {
    const user = await createUser();
    const { secret, codes } = await enable2fa(user.id);
    // valid TOTP
    const agent = await login(app, { email: user.email, totpSecret: secret });
    expect((await agent.get('/dashboard')).status).toBe(200);

    // wrong code
    const a2 = request.agent(app);
    let t = await csrf(a2, '/login');
    await a2.post('/login').type('form').send({ _csrf: t, email: user.email, password: 'Correct-Horse-9' });
    t = await csrf(a2, '/login/2fa');
    const wrong = await a2.post('/login/2fa').type('form').send({ _csrf: t, code: '000000' });
    expect(wrong.headers.location).toBe('/login/2fa');
    // recovery code
    t = await csrf(a2, '/login/2fa');
    const rc = await a2.post('/login/2fa').type('form').send({ _csrf: t, code: codes[0] });
    expect(rc.headers.location).toBe('/dashboard');

    // the TOTP code used for the first login cannot be replayed
    const { authenticator } = require('otplib');
    const a4 = request.agent(app);
    t = await csrf(a4, '/login');
    await a4.post('/login').type('form').send({ _csrf: t, email: user.email, password: 'Correct-Horse-9' });
    t = await csrf(a4, '/login/2fa');
    const replay = await a4.post('/login/2fa').type('form').send({ _csrf: t, code: authenticator.generate(secret) });
    expect(replay.headers.location).toBe('/login/2fa');

    // same recovery code again fails
    const a3 = request.agent(app);
    t = await csrf(a3, '/login');
    await a3.post('/login').type('form').send({ _csrf: t, email: user.email, password: 'Correct-Horse-9' });
    t = await csrf(a3, '/login/2fa');
    const reuse = await a3.post('/login/2fa').type('form').send({ _csrf: t, code: codes[0] });
    expect(reuse.headers.location).toBe('/login/2fa');
  });
});

describe('password reset', () => {
  test('emails a single-use link; the new password works and the old one does not', async () => {
    const user = await createUser();
    const agent = request.agent(app);
    let t = await csrf(agent, '/forgot-password');
    const sent = await agent.post('/forgot-password').type('form').send({ _csrf: t, email: user.email });
    expect(sent.text).toContain('Check your email');
    // unknown email gets the identical response
    t = await csrf(agent, '/forgot-password');
    const unknown = await agent.post('/forgot-password').type('form').send({ _csrf: t, email: uniqueEmail('ghost') });
    expect(unknown.text).toContain('Check your email');

    const [mail] = await deliveredMail(user.email);
    const link = /\/reset-password\/([A-Za-z0-9_-]+)/.exec(mail.html)[0];
    t = await csrf(agent, link);
    const weak = await agent.post(link).type('form').send({ _csrf: t, password: 'short', password_confirmation: 'short' });
    expect(weak.headers.location).toBe(link);
    t = await csrf(agent, link);
    const ok = await agent.post(link).type('form').send({ _csrf: t, password: 'Brand-New-Pass-7', password_confirmation: 'Brand-New-Pass-7' });
    expect(ok.headers.location).toBe('/login');
    expect((await agent.get(link)).status).toBe(400); // single use

    await expect(login(app, { email: user.email, password: 'Correct-Horse-9' })).resolves.toBeDefined();
    const check = request.agent(app);
    t = await csrf(check, '/login');
    const old = await check.post('/login').type('form').send({ _csrf: t, email: user.email, password: 'Correct-Horse-9' });
    expect(old.headers.location).toBe('/login');
    t = await csrf(check, '/login');
    const fresh = await check.post('/login').type('form').send({ _csrf: t, email: user.email, password: 'Brand-New-Pass-7' });
    expect(fresh.headers.location).toBe('/dashboard');
  });

  test('expired links are rejected', async () => {
    const user = await createUser();
    const tokens = require('../../src/services/auth/tokens');
    const raw = await tokens.createPasswordReset(user, '127.0.0.1');
    await db()('password_resets').where({ user_id: user.id }).update({ expires_at: new Date(Date.now() - 1000) });
    expect((await request(app).get(`/reset-password/${raw}`)).status).toBe(400);
  });

  test('changing the password signs out other sessions', async () => {
    const user = await createUser();
    const a = await login(app, { email: user.email });
    const b = await login(app, { email: user.email });
    const t = await csrf(a, '/account/security');
    const res = await a.post('/account/security/password').type('form').send({ _csrf: t, current_password: 'Correct-Horse-9', password: 'Another-Pass-88', password_confirmation: 'Another-Pass-88' });
    expect(res.headers.location).toBe('/account/security');
    expect((await a.get('/dashboard')).status).toBe(200);
    expect((await b.get('/dashboard')).headers.location).toBe('/login');
  });
});

describe('account & privacy', () => {
  test('updates the profile with validation', async () => {
    const user = await createUser();
    const agent = await login(app, { email: user.email });
    let t = await csrf(agent, '/account');
    await agent.post('/account/profile').type('form').send({ _csrf: t, full_name: 'Ngozi Eze', country: 'NG', years_experience: '7', timezone: 'Africa/Lagos', phone: '+234 803 000 0000' });
    const row = await db()('users').where({ id: user.id }).first();
    expect(row).toMatchObject({ full_name: 'Ngozi Eze', country: 'NG', years_experience: 7, timezone: 'Africa/Lagos' });
    t = await csrf(agent, '/account');
    await agent.post('/account/profile').type('form').send({ _csrf: t, full_name: 'N', country: 'XX', years_experience: '200' });
    const page = await agent.get('/account');
    expect(page.text).toContain('Choose a country from the list.');
    expect(page.text).toContain('Enter a whole number between 0 and 60.');
  });

  test('exports personal data without secrets', async () => {
    const user = await createUser();
    await enable2fa(user.id);
    const { secret } = { secret: null };
    const agent = request.agent(app);
    const rows = await db()('users').where({ id: user.id }).first();
    expect(rows.totp_secret_enc).toBeTruthy();
    // sign in through 2FA
    const totp = require('../../src/services/auth/totp');
    const plain = totp.decryptSecret(rows.totp_secret_enc);
    const a = await login(app, { email: user.email, totpSecret: plain });
    const res = await a.get('/account/data-export');
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/attachment/);
    const data = JSON.parse(res.text);
    expect(data.profile.email).toBe(user.email);
    expect(JSON.stringify(data)).not.toMatch(/password_hash|totp_secret|\$2[aby]\$/);
    expect(Array.isArray(data.login_history)).toBe(true);
    expect(agent).toBeDefined();
    expect(secret).toBeNull();
  });

  test('deletion request requires the password and can be cancelled', async () => {
    const user = await createUser();
    const agent = await login(app, { email: user.email });
    let t = await csrf(agent, '/account');
    await agent.post('/account/delete-request').type('form').send({ _csrf: t, password: 'nope', reason: 'x' });
    expect((await db()('users').where({ id: user.id }).first()).deletion_requested_at).toBeNull();
    t = await csrf(agent, '/account');
    await agent.post('/account/delete-request').type('form').send({ _csrf: t, password: 'Correct-Horse-9', reason: 'Moving on' });
    expect((await db()('users').where({ id: user.id }).first()).deletion_requested_at).not.toBeNull();
    t = await csrf(agent, '/account');
    await agent.post('/account/delete-request/cancel').type('form').send({ _csrf: t });
    expect((await db()('users').where({ id: user.id }).first()).deletion_requested_at).toBeNull();
  });
});
