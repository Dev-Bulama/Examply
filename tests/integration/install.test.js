'use strict';

const fs = require('fs');
const request = require('supertest');
const { bootApp, csrf, uniqueEmail, closeAll } = require('../helpers/app');

let app;
beforeAll(async () => {
  app = await bootApp({ installed: false });
});
afterAll(() => closeAll(app));

test('everything redirects to /install until installed, then /install is gone', async () => {
  const agent = request.agent(app);
  const home = await agent.get('/');
  expect(home.status).toBe(302);
  expect(home.headers.location).toBe('/install');

  const page = await agent.get('/install');
  expect(page.status).toBe(200);
  expect(page.text).toContain('Database connected');

  const token = await csrf(agent, '/install');
  const bad = await agent.post('/install').type('form').send({ _csrf: token, site_name: 'X', timezone: 'Africa/Lagos', admin_name: 'A', admin_email: 'nope', admin_password: 'a', admin_password_confirmation: 'b' });
  expect(bad.status).toBe(302);
  expect(bad.headers.location).toBe('/install');

  const email = uniqueEmail('owner');
  const ok = await agent
    .post('/install')
    .type('form')
    .send({ _csrf: token, site_name: 'Acme Assess', timezone: 'Africa/Lagos', admin_name: 'Owner Person', admin_email: email, admin_password: 'Lagos-Assess-2026', admin_password_confirmation: 'Lagos-Assess-2026' });
  expect(ok.status).toBe(302);
  expect(ok.headers.location).toBe('/login?installed=1');

  const { installLockPath } = require('../../src/config/paths');
  expect(fs.existsSync(installLockPath())).toBe(true);
  expect((await request(app).get('/install')).status).toBe(404);

  const settings = require('../../src/services/settings');
  settings.invalidate();
  expect(await settings.get('general.site_name')).toBe('Acme Assess');
  const { db } = require('../../src/config/db');
  const roles = await db()('users as u').join('user_roles as ur', 'ur.user_id', 'u.id').join('roles as r', 'r.id', 'ur.role_id').where('u.email', email).pluck('r.slug');
  expect(roles).toEqual(['super_admin']);
});
