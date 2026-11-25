'use strict';

const request = require('supertest');
const { bootApp, createUser, csrf, login, enable2fa, closeAll } = require('../helpers/app');
const { db } = require('../../src/config/db');
const E = require('../../src/services/engagement');

let app;
let adminAgent;
const stamp = Date.now();

beforeAll(async () => {
  app = await bootApp();
  const a = await createUser({ roles: ['admin'] });
  const { secret } = await enable2fa(a.id);
  adminAgent = await login(app, { email: a.email, totpSecret: secret });
});

afterAll(async () => closeAll(app));

describe('notifications', () => {
  test('the bell counts unread items; opening one marks it read and only follows internal links', async () => {
    const u = await createUser();
    const agent = await login(app, { email: u.email });
    await E.notify(u.id, { type: 'result', title: `Result ${stamp}`, url: '/my/results' });
    await E.notify(u.id, { type: 'x', title: `Evil ${stamp}`, url: 'https://evil.example/' });
    expect((await agent.get('/dashboard')).text).toContain('Notifications (2 unread)');
    const list = await agent.get('/notifications');
    expect(list.text).toContain(`Result ${stamp}`);
    const ids = await db()('notifications').where({ user_id: u.id }).orderBy('id').pluck('id');
    expect((await agent.get(`/notifications/${ids[0]}`)).headers.location).toBe('/my/results');
    expect((await agent.get(`/notifications/${ids[1]}`)).headers.location).toBe('/notifications');
    expect(await E.unreadCount(u.id)).toBe(0);
    // Someone else's notification is not reachable.
    const other = await createUser();
    await E.notify(other.id, { type: 'x', title: 'Private' });
    const theirs = await db()('notifications').where({ user_id: other.id }).first('id');
    expect((await agent.get(`/notifications/${theirs.id}`)).status).toBe(404);
  });
});

describe('announcements', () => {
  test('targeted banners appear only for their audience', async () => {
    const t = await csrf(adminAgent, '/admin/announcements/new');
    await adminAgent.post('/admin/announcements').type('form').send({ _csrf: t, title: `Guests only ${stamp}`, level: 'info', target: 'guests', is_active: ['0', '1'], dismissible: ['0', '1'] });
    await adminAgent.post('/admin/announcements').type('form').send({ _csrf: t, title: `Candidates ${stamp}`, level: 'warning', target: 'role', target_ids: ['candidate'], is_active: ['0', '1'] });
    E.clearAnnouncementCache();
    const guestHome = await request(app).get('/exams');
    expect(guestHome.text).toContain(`Guests only ${stamp}`);
    expect(guestHome.text).not.toContain(`Candidates ${stamp}`);
    const u = await createUser();
    const agent = await login(app, { email: u.email });
    const page = await agent.get('/dashboard');
    expect(page.text).toContain(`Candidates ${stamp}`);
    expect(page.text).not.toContain(`Guests only ${stamp}`);
    // Validation: role targeting needs a role.
    await adminAgent.post('/admin/announcements').type('form').send({ _csrf: t, title: 'Bad', target: 'role', is_active: '1' });
    expect((await adminAgent.get('/admin/announcements/new')).text).toContain('Choose at least one role.');
  });
});

describe('pages and help centre', () => {
  test('pages are sanitised, published at /p/:slug and linked in the footer', async () => {
    const t = await csrf(adminAgent, '/admin/pages/new');
    const r = await adminAgent.post('/admin/pages').type('form').send({ _csrf: t, title: 'Refund policy', slug: `refunds-${stamp}`, body_html: '<p>Fair refunds.</p><script>alert(1)</script>', is_published: ['0', '1'], show_in_footer: ['0', '1'] });
    expect(r.headers.location).toBe('/admin/pages');
    require('../../src/middleware/engagement').clearFooterCache();
    const page = await request(app).get(`/p/refunds-${stamp}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain('Fair refunds.');
    expect(page.text).not.toContain('alert(1)');
    expect((await request(app).get('/exams')).text).toContain(`/p/refunds-${stamp}`);
    // Reserved addresses are refused.
    await adminAgent.post('/admin/pages').type('form').send({ _csrf: t, title: 'Admin', slug: 'admin', body_html: 'x' });
    expect((await adminAgent.get('/admin/pages/new')).text).toContain('used by the platform');
    const ft = await csrf(adminAgent, '/admin/faqs/new');
    await adminAgent.post('/admin/faqs').type('form').send({ _csrf: ft, question: `Where is my certificate ${stamp}?`, answer_html: '<p>Under Certificates.</p>', category: 'Results', is_published: ['0', '1'] });
    expect((await request(app).get('/help')).text).toContain(`Where is my certificate ${stamp}?`);
  });
});

describe('support tickets', () => {
  test('a guest opens a ticket, follows it with the private link, and staff replies by email', async () => {
    const guest = request.agent(app);
    const t = await csrf(guest, '/support');
    const r = await guest.post('/support').type('form').send({ _csrf: t, name: 'Ngozi Ade', email: `ngozi.${stamp}@example.test`, subject: 'Transfer not confirmed', body: 'I paid by transfer yesterday for the Oracle mock.' });
    const m = /^\/support\/tickets\/(T-[A-Z0-9]+)\?t=([0-9a-f]+)$/.exec(r.headers.location);
    expect(m).toBeTruthy();
    const [, no, token] = m;
    expect((await request(app).get(`/support/tickets/${no}`)).status).toBe(404); // no token → nothing
    expect((await request(app).get(`/support/tickets/${no}?t=${'0'.repeat(36)}`)).status).toBe(404);
    const view = await guest.get(`/support/tickets/${no}?t=${token}`);
    expect(view.text).toContain('I paid by transfer yesterday');
    const ticket = await db()('support_tickets').where({ ticket_no: no }).first();
    expect(await db()('jobs').where('payload', 'like', `%${no}%`).where('payload', 'like', '%support_received%').first()).toBeTruthy();

    // Staff reply → status pending, email queued.
    const at = await csrf(adminAgent, `/admin/support/${ticket.id}`);
    await adminAgent.post(`/admin/support/${ticket.id}`).type('form').send({ _csrf: at, body: 'Confirmed — your exam is now in your library.', status: 'pending', priority: 'high' });
    const after = await db()('support_tickets').where({ id: ticket.id }).first();
    expect(after).toMatchObject({ status: 'pending', priority: 'high' });
    expect(await db()('jobs').where('payload', 'like', `%${no}%`).where('payload', 'like', '%support_reply%').first()).toBeTruthy();

    // The guest replies with the token → open again.
    const gt = await csrf(guest, `/support/tickets/${no}?t=${token}`);
    await guest.post(`/support/tickets/${no}/reply`).type('form').send({ _csrf: gt, t: token, body: 'Thank you, I can see it.' });
    expect((await db()('support_tickets').where({ id: ticket.id }).first()).status).toBe('open');
    expect((await adminAgent.get('/admin/support')).text).toContain('Transfer not confirmed');
  });

  test('signed-in users see their own tickets only and get a notification on replies', async () => {
    const u = await createUser();
    const agent = await login(app, { email: u.email });
    const t = await csrf(agent, '/support');
    const r = await agent.post('/support').type('form').send({ _csrf: t, subject: `Login help ${stamp}`, body: 'My 2FA app was reset, what now?' });
    const no = r.headers.location.split('/').pop();
    const ticket = await db()('support_tickets').where({ ticket_no: no }).first();
    await E.reply(ticket, { isStaff: true, body: 'Use a recovery code.', user: null });
    expect(await E.unreadCount(u.id)).toBe(1);
    const stranger = await login(app, { email: (await createUser()).email });
    expect((await stranger.get(`/support/tickets/${no}`)).status).toBe(404);
  });

  test('candidates cannot reach the staff inbox or editors', async () => {
    const agent = await login(app, { email: (await createUser()).email });
    for (const url of ['/admin/support', '/admin/announcements', '/admin/pages', '/admin/email-templates']) expect([302, 403]).toContain((await agent.get(url)).status);
  });
});

describe('email templates', () => {
  test('admins edit, preview and reset a template', async () => {
    const page = await adminAgent.get('/admin/email-templates/result_available');
    expect(page.status).toBe(200);
    expect(page.text).toContain('Preview');
    const t = await csrf(adminAgent, '/admin/email-templates/result_available');
    await adminAgent.post('/admin/email-templates/result_available').type('form').send({ _csrf: t, subject: 'Your {{exam_title}} result is in', body_html: '<p>Hi {{name}}, your score is {{score}}.</p><script>x()</script>' });
    const row = await db()('email_templates').where({ key: 'result_available' }).first();
    expect(row.subject).toBe('Your {{exam_title}} result is in');
    expect(row.body_html).not.toContain('<script>');
    await adminAgent.post('/admin/email-templates/result_available').type('form').send({ _csrf: t, reset: '1' });
    expect((await db()('email_templates').where({ key: 'result_available' }).first()).subject).not.toBe('Your {{exam_title}} result is in');
  });
});

describe('organisations (platform view)', () => {
  test('admins see organisations and can suspend and reactivate one', async () => {
    const [orgId] = await db()('organisations').insert({ name: `Acme ${stamp}`, slug: `acme-${stamp}`, status: 'active' });
    expect((await adminAgent.get('/admin/organisations')).text).toContain(`Acme ${stamp}`);
    const t = await csrf(adminAgent, '/admin/organisations');
    await adminAgent.post(`/admin/organisations/${orgId}/status`).type('form').send({ _csrf: t, status: 'suspended' });
    expect((await db()('organisations').where({ id: orgId }).first()).status).toBe('suspended');
    await adminAgent.post(`/admin/organisations/${orgId}/status`).type('form').send({ _csrf: t, status: 'active' });
    expect((await db()('organisations').where({ id: orgId }).first()).status).toBe('active');
  });
});
