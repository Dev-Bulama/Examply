'use strict';

const request = require('supertest');
const { bootApp, closeAll } = require('../helpers/app');
const dbHealth = require('../../src/services/dbHealth');

let app;

beforeAll(async () => {
  app = await bootApp();
});
afterAll(async () => closeAll(app));
afterEach(() => {
  jest.restoreAllMocks();
  dbHealth.reset();
});

describe('database outage', () => {
  test('healthz reports the database state', async () => {
    const res = await request(app).get('/healthz');
    expect(res.body).toMatchObject({ ok: true, installed: true, database: 'ok' });
  });

  test('pages show the reconnect screen (503) instead of a 500; static assets still load', async () => {
    jest.spyOn(dbHealth, 'check').mockResolvedValue({ ok: false, code: 'ER_ACCESS_DENIED_ERROR', at: Date.now() });
    jest.spyOn(dbHealth, 'current').mockReturnValue({ ok: false, code: 'ER_ACCESS_DENIED_ERROR', at: Date.now() });
    const home = await request(app).get('/');
    expect(home.status).toBe(503);
    expect(home.text).toContain('The database user name or password was rejected');
    expect((await request(app).get('/exams')).status).toBe(503);
    expect((await request(app).get('/css/app.css')).status).toBe(200);
    expect((await request(app).get('/theme.css')).status).toBe(200);
    const h = await request(app).get('/healthz');
    expect(h.body).toMatchObject({ ok: false, database: 'ER_ACCESS_DENIED_ERROR' });
  });

  test('reconnecting an installed site needs a configured SETUP_TOKEN', async () => {
    jest.spyOn(dbHealth, 'check').mockResolvedValue({ ok: false, code: 'NOT_CONFIGURED', at: Date.now() });
    jest.spyOn(dbHealth, 'current').mockReturnValue({ ok: false, code: 'NOT_CONFIGURED', at: Date.now() });
    const agent = request.agent(app);
    const page = await agent.get('/');
    const token = /name="_csrf" value="([^"]+)"/.exec(page.text);
    const res = await agent.post('/install/database').type('form').send({ _csrf: token ? token[1] : '', db_host: 'localhost', db_port: '3306', db_name: 'x', db_user: 'x', db_password: 'x' });
    expect(res.status).toBe(403); // no SETUP_TOKEN in the test environment
  });

  test('with the database up, the install routes stay closed', async () => {
    expect((await request(app).get('/install')).status).toBe(404);
    expect((await request(app).post('/install/database')).status).toBeGreaterThanOrEqual(403);
  });
});
