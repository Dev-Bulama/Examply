'use strict';

const request = require('supertest');
const { bootApp, createUser, csrf, login, enable2fa, deliveredMail, uniqueEmail, closeAll } = require('../helpers/app');
const { db } = require('../../src/config/db');

let app;
let superAgent;
let superAdmin;
beforeAll(async () => {
  app = await bootApp();
  superAdmin = await createUser({ roles: ['super_admin'], fullName: 'Root Admin' });
  const { secret } = await enable2fa(superAdmin.id);
  superAgent = await login(app, { email: superAdmin.email, totpSecret: secret });
});
afterAll(() => closeAll(app));

/** Lists every GET/POST route registered on the /admin router. */
function adminRoutes() {
  const router = require('../../src/routes/admin');
  return router.stack
    .filter((l) => l.route)
    .flatMap((l) => Object.keys(l.route.methods).map((m) => ({ method: m, path: l.route.path === '/' ? '/admin' : `/admin${l.route.path}` })))
    .map((r) => ({
      ...r,
      url: r.path
        .replace(/:[a-zA-Z_]+\(\\\\d\+\)/g, '1')
        .replace(/:[a-zA-Z_]+\(\\d\+\)/g, '1')
        .replace(/:([a-zA-Z_]+)\(([a-z_-]+)[|)][^)]*\)?/g, '$2')
        .replace(/:[a-zA-Z_]+\(\[a-z\]\+\)/g, 'basics')
        .replace(/:section/, 'general')
        .replace(/:key/, 'general.logo_path'),
    }));
}

describe('RBAC', () => {
  test('candidates cannot open the admin area', async () => {
    const user = await createUser();
    const agent = await login(app, { email: user.email });
    expect((await agent.get('/admin')).status).toBe(403);
    expect((await agent.get('/admin/users')).status).toBe(403);
  });

  test('guests are sent to the login page', async () => {
    const res = await request(app).get('/admin/users');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  test('every admin route except the dashboard requires a specific permission', async () => {
    // A custom role holding only admin.access must be refused everywhere else.
    const [roleId] = await db()('roles').insert({ name: `Viewer ${Date.now()}`, slug: `viewer_${Date.now()}`, is_system: false });
    const perm = await db()('permissions').where({ key: 'admin.access' }).first();
    await db()('role_permissions').insert({ role_id: roleId, permission_id: perm.id });
    const role = await db()('roles').where({ id: roleId }).first();
    const user = await createUser({ roles: [role.slug] });
    const agent = await login(app, { email: user.email });
    const routes = adminRoutes();
    expect(routes.length).toBeGreaterThan(20);
    const token = await csrf(agent, '/admin');
    for (const r of routes) {
      const res = r.method === 'get' ? await agent.get(r.url) : await agent.post(r.url).type('form').send({ _csrf: token });
      if (r.url === '/admin') expect(res.status).toBe(200);
      else expect([r.method, r.url, res.status]).toEqual([r.method, r.url, 403]);
    }
  });

  test('Admin role: manages users but cannot manage roles, settings or the audit log', async () => {
    const admin = await createUser({ roles: ['admin'] });
    const { secret } = await enable2fa(admin.id);
    const agent = await login(app, { email: admin.email, totpSecret: secret });
    expect((await agent.get('/admin/users')).status).toBe(200);
    expect((await agent.get('/admin/roles')).status).toBe(403);
    expect((await agent.get('/admin/settings/general')).status).toBe(403);
    expect((await agent.get('/admin/audit')).status).toBe(403);
  });

  test('Question Author sees the admin shell but not users', async () => {
    const author = await createUser({ roles: ['question_author'] });
    const agent = await login(app, { email: author.email });
    expect((await agent.get('/admin')).status).toBe(200);
    expect((await agent.get('/admin/users')).status).toBe(403);
  });
});

describe('privilege escalation is blocked', () => {
  test('an Admin cannot grant Super Admin or edit a Super Admin', async () => {
    const admin = await createUser({ roles: ['admin'] });
    const { secret } = await enable2fa(admin.id);
    const agent = await login(app, { email: admin.email, totpSecret: secret });
    const victim = await createUser();
    let t = await csrf(agent, `/admin/users/${victim.id}`);
    await agent.post(`/admin/users/${victim.id}`).type('form').send({ _csrf: t, full_name: victim.full_name, email: victim.email, status: 'active', roles: ['candidate', 'super_admin'] });
    const roles = await db()('user_roles as ur').join('roles as r', 'r.id', 'ur.role_id').where('ur.user_id', victim.id).pluck('r.slug');
    expect(roles).toEqual(['candidate']);

    t = await csrf(agent, `/admin/users/${superAdmin.id}`);
    const res = await agent.post(`/admin/users/${superAdmin.id}`).type('form').send({ _csrf: t, full_name: 'Hacked', email: superAdmin.email, status: 'suspended', roles: ['candidate'] });
    expect(res.status).toBe(403);
    expect((await db()('users').where({ id: superAdmin.id }).first()).full_name).toBe('Root Admin');
  });

  test('the last active Super Admin cannot demote themselves', async () => {
    const solo = await createUser({ roles: ['super_admin'] });
    // Make every other super admin inactive for this check.
    const others = await db()('user_roles as ur').join('roles as r', 'r.id', 'ur.role_id').where('r.slug', 'super_admin').whereNot('ur.user_id', solo.id).pluck('ur.user_id');
    await db()('users').whereIn('id', others).update({ status: 'suspended' });
    try {
      const { secret } = await enable2fa(solo.id);
      const agent = await login(app, { email: solo.email, totpSecret: secret });
      const t = await csrf(agent, `/admin/users/${solo.id}`);
      await agent.post(`/admin/users/${solo.id}`).type('form').send({ _csrf: t, full_name: solo.full_name, email: solo.email, status: 'active', roles: ['candidate'] });
      const roles = await db()('user_roles as ur').join('roles as r', 'r.id', 'ur.role_id').where('ur.user_id', solo.id).pluck('r.slug');
      expect(roles).toContain('super_admin');
    } finally {
      await db()('users').whereIn('id', others).update({ status: 'active' });
    }
  });
});

describe('user management', () => {
  test('creates a user by invitation, audits it, and the invite link sets a password', async () => {
    const email = uniqueEmail('invitee');
    const t = await csrf(superAgent, '/admin/users/new');
    const res = await superAgent.post('/admin/users').type('form').send({ _csrf: t, full_name: 'Bola Ade', email, roles: ['reviewer'], password_mode: 'invite' });
    expect(res.status).toBe(302);
    const created = await db()('users').where({ email }).first();
    expect(created.password_hash).toBeNull();
    const audit = await db()('audit_logs').where({ action: 'user.create', entity_id: String(created.id) }).first();
    expect(audit.user_id).toBe(superAdmin.id);
    const [mail] = await deliveredMail(email);
    expect(mail.subject).toContain('account is ready');
    const link = /\/reset-password\/([A-Za-z0-9_-]+)/.exec(mail.html)[0];
    const guest = request.agent(app);
    const t2 = await csrf(guest, link);
    await guest.post(link).type('form').send({ _csrf: t2, password: 'Reviewer-Pass-55', password_confirmation: 'Reviewer-Pass-55' });
    await expect(login(app, { email, password: 'Reviewer-Pass-55' })).resolves.toBeDefined();
  });

  test('suspending a user signs them out immediately', async () => {
    const user = await createUser();
    const victimAgent = await login(app, { email: user.email });
    expect((await victimAgent.get('/dashboard')).status).toBe(200);
    const t = await csrf(superAgent, `/admin/users/${user.id}`);
    await superAgent.post(`/admin/users/${user.id}`).type('form').send({ _csrf: t, full_name: user.full_name, email: user.email, status: 'suspended', roles: ['candidate'] });
    expect((await victimAgent.get('/dashboard')).headers.location).toBe('/login');
  });

  test('sets accommodations and records before/after in the audit log', async () => {
    const user = await createUser();
    const t = await csrf(superAgent, `/admin/users/${user.id}`);
    await superAgent.post(`/admin/users/${user.id}/accommodations`).type('form').send({ _csrf: t, extra_time: 'custom', extra_time_custom: '35', large_font: '1', high_contrast: '0' });
    const acc = await db()('user_accommodations').where({ user_id: user.id }).first();
    expect(acc).toMatchObject({ extra_time_percent: 35, large_font: 1, high_contrast: 0 });
    const log = await db()('audit_logs').where({ action: 'user.accommodations', entity_id: String(user.id) }).first();
    expect(log.after).toBeTruthy();
    // The candidate sees the larger-text class and their accommodation on the profile page.
    const agent = await login(app, { email: user.email });
    const page = await agent.get('/account');
    expect(page.text).toContain('font-large');
    expect(page.text).toContain('35% extra time');
  });

  test('deleting a user anonymises personal data', async () => {
    const user = await createUser({ fullName: 'Private Person' });
    const t = await csrf(superAgent, `/admin/users/${user.id}`);
    await superAgent.post(`/admin/users/${user.id}/delete`).type('form').send({ _csrf: t });
    const row = await db()('users').where({ id: user.id }).first();
    expect(row.deleted_at).not.toBeNull();
    expect(row.full_name).toBe('Deleted user');
    expect(row.email).not.toBe(user.email);
    expect(row.password_hash).toBeNull();
  });

  test('searches and filters users with pagination', async () => {
    await createUser({ fullName: 'Zainab Searchable' });
    const res = await superAgent.get('/admin/users?q=Searchable&status=active');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Zainab Searchable');
    const none = await superAgent.get('/admin/users?q=no-such-person-xyz');
    expect(none.text).toContain('No users match these filters');
  });
});

describe('roles', () => {
  test('creates a custom role with ticked permissions and refuses to delete it while in use', async () => {
    const name = `Content Lead ${Date.now()}`;
    const t = await csrf(superAgent, '/admin/roles/new');
    await superAgent.post('/admin/roles').type('form').send({ _csrf: t, name, permissions: ['admin.access', 'questions.view', 'questions.review'] });
    const role = await db()('roles').where({ name }).first();
    const perms = await db()('role_permissions as rp').join('permissions as p', 'p.id', 'rp.permission_id').where('rp.role_id', role.id).pluck('p.key');
    expect(perms.sort()).toEqual(['admin.access', 'questions.review', 'questions.view']);
    const user = await createUser({ roles: [role.slug] });
    const t2 = await csrf(superAgent, '/admin/roles');
    await superAgent.post(`/admin/roles/${role.id}/delete`).type('form').send({ _csrf: t2 });
    expect(await db()('roles').where({ id: role.id }).first()).toBeTruthy();
    await db()('user_roles').where({ user_id: user.id }).del();
    await superAgent.post(`/admin/roles/${role.id}/delete`).type('form').send({ _csrf: t2 });
    expect(await db()('roles').where({ id: role.id }).first()).toBeUndefined();
  });

  test('the Super Admin role cannot be edited and unknown permissions are rejected', async () => {
    const sa = await db()('roles').where({ slug: 'super_admin' }).first();
    const t = await csrf(superAgent, '/admin/roles');
    await superAgent.post(`/admin/roles/${sa.id}`).type('form').send({ _csrf: t, name: 'Hacked', permissions: [] });
    expect((await db()('roles').where({ id: sa.id }).first()).name).toBe('Super Admin');
    const t2 = await csrf(superAgent, '/admin/roles/new');
    await superAgent.post('/admin/roles').type('form').send({ _csrf: t2, name: `Bad ${Date.now()}`, permissions: ['admin.access', 'everything.please'] });
    expect(await db()('roles').where('name', 'like', 'Bad %').first()).toBeUndefined();
  });
});

describe('settings', () => {
  test('saves branding and serves the new palette', async () => {
    const t = await csrf(superAgent, '/admin/settings/branding');
    await superAgent.post('/admin/settings/branding').type('form').send({ _csrf: t, 'branding.primary_color': '#7c2d12', 'branding.secondary_color': '#0f766e', 'branding.default_theme': 'dark' });
    const css = await request(app).get('/theme.css');
    expect(css.text).toContain('--c-primary-600: 124 45 18;');
    const t2 = await csrf(superAgent, '/admin/settings/branding');
    await superAgent.post('/admin/settings/branding').type('form').send({ _csrf: t2, 'branding.primary_color': '#fef08a', 'branding.secondary_color': '#0f766e', 'branding.default_theme': 'dark' });
    expect((await request(app).get('/theme.css')).text).toContain('--c-primary-600: 124 45 18;'); // too-light colour rejected
  });

  test('encrypts the SMTP password at rest and never renders it', async () => {
    const t = await csrf(superAgent, '/admin/settings/email');
    await superAgent.post('/admin/settings/email').type('form').send({
      _csrf: t,
      'email.smtp_host': 'smtp.example.test',
      'email.smtp_port': '465',
      'email.smtp_secure': '1',
      'email.smtp_user': 'mailer@example.test',
      'email.smtp_password': 'super-secret-smtp-pass',
      'email.from_name': 'Assess',
      'email.from_address': 'no-reply@example.test',
    });
    const row = await db()('settings').where({ key: 'email.smtp_password' }).first();
    expect(row.is_encrypted).toBe(1);
    expect(row.value.startsWith('v1:')).toBe(true);
    expect(row.value).not.toContain('super-secret');
    const page = await superAgent.get('/admin/settings/email');
    expect(page.text).not.toContain('super-secret-smtp-pass');
    expect(page.text).toContain('saved — leave blank to keep');
    // blank submission keeps the stored secret
    const t2 = await csrf(superAgent, '/admin/settings/email');
    await superAgent.post('/admin/settings/email').type('form').send({ _csrf: t2, 'email.smtp_host': 'smtp.example.test', 'email.smtp_port': '465', 'email.smtp_user': 'mailer@example.test', 'email.smtp_password': '' });
    expect((await db()('settings').where({ key: 'email.smtp_password' }).first()).value).toBe(row.value);
    // reset so later tests write to the outbox
    const settings = require('../../src/services/settings');
    await settings.setMany({ 'email.smtp_host': '', 'email.smtp_password': '' });
  });

  test('maintenance mode blocks visitors but not staff', async () => {
    const settings = require('../../src/services/settings');
    await settings.set('maintenance.enabled', true);
    try {
      expect((await request(app).get('/')).status).toBe(503);
      expect((await request(app).get('/login')).status).toBe(200);
      expect((await superAgent.get('/')).status).toBe(200);
    } finally {
      await settings.set('maintenance.enabled', false);
    }
  });

  test('validates numbers and records an audit entry', async () => {
    const t = await csrf(superAgent, '/admin/settings/security');
    await superAgent.post('/admin/settings/security').type('form').send({ _csrf: t, 'security.password_min_length': '4', 'security.session_idle_minutes': '30', 'security.remember_me_days': '30' });
    const page = await superAgent.get('/admin/settings/security');
    expect(page.text).toContain('Enter a whole number between 8 and 64.');
    const t2 = await csrf(superAgent, '/admin/settings/security');
    await superAgent.post('/admin/settings/security').type('form').send({ _csrf: t2, 'security.require_2fa_admin': '1', 'security.registration_open': '1', 'security.password_min_length': '12', 'security.password_require_mixed_case': '1', 'security.password_require_number': '1', 'security.session_idle_minutes': '30', 'security.remember_me_days': '30' });
    const log = await db()('audit_logs').where({ action: 'settings.security' }).orderBy('id', 'desc').first();
    expect(require('../../src/utils/json').parseJson(log.after)['security.password_min_length']).toBe(12);
    const settings = require('../../src/services/settings');
    await settings.set('security.password_min_length', 10);
  });
});

describe('audit log, jobs and cron', () => {
  test('audit log lists and shows a diff', async () => {
    const list = await superAgent.get('/admin/audit?action=settings.');
    expect(list.status).toBe(200);
    const id = /\/admin\/audit\/(\d+)/.exec(list.text)[1];
    const detail = await superAgent.get(`/admin/audit/${id}`);
    expect(detail.status).toBe(200);
    expect(detail.text).toContain('Changes');
  });

  test('failed jobs can be retried', async () => {
    const queue = require('../../src/services/jobs/queue');
    const id = await queue.enqueue('unknown.type', {}, { maxAttempts: 1 });
    await queue.runDueJobs();
    expect((await db()('jobs').where({ id }).first()).status).toBe('failed');
    const page = await superAgent.get('/admin/jobs?status=failed');
    expect(page.text).toContain('unknown.type');
    const t = await csrf(superAgent, '/admin/jobs');
    await superAgent.post(`/admin/jobs/${id}/retry`).type('form').send({ _csrf: t });
    expect((await db()('jobs').where({ id }).first()).status).toBe('pending');
    await db()('jobs').where({ id }).del();
  });

  test('/cron/run needs the token and runs scheduled tasks', async () => {
    expect((await request(app).get('/cron/run?token=wrong')).status).toBe(403);
    const ok = await request(app).get(`/cron/run?token=${process.env.CRON_TOKEN}`);
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);
    expect(ok.body.jobs).toHaveProperty('processed');
  });

  test('security headers are present', async () => {
    const res = await request(app).get('/login');
    expect(res.headers['content-security-policy']).toContain("script-src 'self' 'nonce-");
    expect(res.headers['content-security-policy']).toContain('https://js.paystack.co');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['set-cookie'].join(';')).toMatch(/HttpOnly; SameSite=Lax/);
  });
});
