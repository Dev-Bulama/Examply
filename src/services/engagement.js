'use strict';

/**
 * Engagement: in-app notifications, announcements, CMS pages & FAQ, and support tickets.
 * Every write is validated here; controllers stay thin.
 */
const crypto = require('crypto');
const { db } = require('../config/db');
const { getEnv } = require('../config/env');
const { getLogger } = require('../config/logger');
const { parseJson, toJson } = require('../utils/json');
const { sanitizeRich, toPlainText } = require('../utils/html');

class EngagementError extends Error {
  constructor(message, fields = {}) {
    super(message);
    this.fields = fields;
    this.status = 422;
  }
}

const base = () => String(getEnv().APP_URL).replace(/\/$/, '');
const sha = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const str = (v, max) => String(v === undefined || v === null ? '' : v).trim().slice(0, max);

// ================================================================ Notifications

/** Never throws: a failed notification must not break the action that triggered it. */
async function notify(userId, { type, title, body = null, url = null }, knex = db()) {
  if (!userId) return;
  try {
    await knex('notifications').insert({ user_id: userId, type: str(type, 50), title: str(title, 200), body: body ? str(body, 2000) : null, url: url ? str(url, 500) : null });
  } catch (err) {
    getLogger().warn({ err: err.message }, 'notification not stored');
  }
}

async function unreadCount(userId, knex = db()) {
  return Number((await knex('notifications').where({ user_id: userId }).whereNull('read_at').count('* as n').first()).n);
}

async function listNotifications(userId, { limit = 50 } = {}, knex = db()) {
  return knex('notifications').where({ user_id: userId }).orderBy('id', 'desc').limit(limit);
}

async function markRead(userId, id = null, knex = db()) {
  const q = knex('notifications').where({ user_id: userId }).whereNull('read_at');
  if (id) q.where({ id });
  await q.update({ read_at: new Date() });
}

// ================================================================ Announcements

const LEVELS = ['info', 'success', 'warning', 'danger'];
const TARGETS = ['all', 'guests', 'role', 'organisation'];

function readAnnouncement(input) {
  const errors = {};
  const a = {
    title: str(input.title, 200),
    body_html: input.body_html ? sanitizeRich(input.body_html) : null,
    level: LEVELS.includes(input.level) ? input.level : 'info',
    target: TARGETS.includes(input.target) ? input.target : 'all',
    target_ids: null,
    starts_at: input.starts_at ? new Date(input.starts_at) : null,
    ends_at: input.ends_at ? new Date(input.ends_at) : null,
    is_active: [].concat(input.is_active || []).includes('1'),
    dismissible: [].concat(input.dismissible || []).includes('1'),
  };
  if (a.title.length < 3) errors.title = 'Give the announcement a short title.';
  for (const k of ['starts_at', 'ends_at']) if (a[k] && Number.isNaN(a[k].getTime())) errors[k] = 'Enter a valid date and time.';
  if (a.starts_at && a.ends_at && a.ends_at <= a.starts_at) errors.ends_at = 'The end must be after the start.';
  if (a.target === 'role' || a.target === 'organisation') {
    const ids = [].concat(input.target_ids || []).flatMap((x) => String(x).split(',')).map((x) => x.trim()).filter(Boolean);
    if (!ids.length) errors.target_ids = a.target === 'role' ? 'Choose at least one role.' : 'Choose at least one organisation.';
    a.target_ids = toJson(a.target === 'organisation' ? ids.map(Number).filter(Boolean) : ids.slice(0, 20));
  }
  if (Object.keys(errors).length) throw new EngagementError('Please correct the highlighted fields.', errors);
  return a;
}

async function saveAnnouncement(id, input, userId, knex = db()) {
  const a = readAnnouncement(input);
  if (id) {
    await knex('announcements').where({ id }).update({ ...a, updated_at: new Date() });
    return id;
  }
  const [newId] = await knex('announcements').insert({ ...a, created_by: userId });
  return newId;
}

let cache = { at: 0, rows: [] };
/** Active announcements visible to this viewer (60-second cache of the active list). */
async function announcementsFor(user, knex = db()) {
  if (Date.now() - cache.at > 60000) {
    const now = new Date();
    const rows = await knex('announcements')
      .where({ is_active: true })
      .where((w) => w.whereNull('starts_at').orWhere('starts_at', '<=', now))
      .where((w) => w.whereNull('ends_at').orWhere('ends_at', '>', now))
      .orderBy('id', 'desc')
      .limit(5);
    cache = { at: Date.now(), rows: rows.map((r) => ({ ...r, target_ids: parseJson(r.target_ids, []) })) };
  }
  let orgIds = null;
  const out = [];
  for (const a of cache.rows) {
    if (a.target === 'all') out.push(a);
    else if (a.target === 'guests' && !user) out.push(a);
    else if (a.target === 'role' && user && a.target_ids.some((r) => (user.roleSlugs || []).includes(r))) out.push(a);
    else if (a.target === 'organisation' && user) {
      if (orgIds === null) orgIds = await knex('organisation_users').where({ user_id: user.id }).pluck('organisation_id');
      if (a.target_ids.some((id) => orgIds.includes(Number(id)))) out.push(a);
    }
  }
  return out.map((a) => ({ id: a.id, title: a.title, body_html: a.body_html, level: a.level, dismissible: !!a.dismissible }));
}
const clearAnnouncementCache = () => {
  cache = { at: 0, rows: [] };
};

// ================================================================ CMS pages & FAQ

const RESERVED = new Set(['admin', 'login', 'register', 'exams', 'play', 'help', 'support', 'pricing', 'verify', 'install', 'org', 'join']);
function readPage(input) {
  const errors = {};
  const slug = str(input.slug, 120).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  const p = {
    slug,
    title: str(input.title, 200),
    body_html: sanitizeRich(input.body_html || ''),
    meta_title: str(input.meta_title, 200) || null,
    meta_description: str(input.meta_description, 300) || null,
    is_published: [].concat(input.is_published || []).includes('1'),
    show_in_footer: [].concat(input.show_in_footer || []).includes('1'),
    display_order: Number.parseInt(input.display_order, 10) || 0,
  };
  if (!slug) errors.slug = 'Use letters, numbers and dashes, e.g. terms-of-service.';
  if (RESERVED.has(slug)) errors.slug = 'That address is used by the platform. Choose another.';
  if (p.title.length < 2) errors.title = 'Give the page a title.';
  if (Object.keys(errors).length) throw new EngagementError('Please correct the highlighted fields.', errors);
  return p;
}

async function savePage(id, input, knex = db()) {
  const p = readPage(input);
  const clash = await knex('pages').where({ slug: p.slug }).whereNot('id', id || 0).first('id');
  if (clash) throw new EngagementError('Please correct the highlighted fields.', { slug: 'Another page already uses that address.' });
  if (id) {
    await knex('pages').where({ id }).update({ ...p, updated_at: new Date() });
    return id;
  }
  const [newId] = await knex('pages').insert(p);
  return newId;
}

async function footerPages(knex = db()) {
  return knex('pages').where({ is_published: true, show_in_footer: true }).orderBy('display_order').select('slug', 'title');
}

function readFaq(input) {
  const errors = {};
  const f = { category: str(input.category, 100) || null, question: str(input.question, 300), answer_html: sanitizeRich(input.answer_html || ''), display_order: Number.parseInt(input.display_order, 10) || 0, is_published: [].concat(input.is_published || []).includes('1') };
  if (f.question.length < 5) errors.question = 'Write the question.';
  if (toPlainText(f.answer_html).length < 2) errors.answer_html = 'Write the answer.';
  if (Object.keys(errors).length) throw new EngagementError('Please correct the highlighted fields.', errors);
  return f;
}

async function saveFaq(id, input, knex = db()) {
  const f = readFaq(input);
  if (id) {
    await knex('faqs').where({ id }).update({ ...f, updated_at: new Date() });
    return id;
  }
  const [newId] = await knex('faqs').insert(f);
  return newId;
}

// ================================================================ Support tickets

const STATUSES = ['open', 'pending', 'resolved', 'closed'];
const PRIORITIES = ['low', 'normal', 'high'];

async function ticketNo(knex) {
  for (let i = 0; i < 10; i += 1) {
    const no = `T-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    if (!(await knex('support_tickets').where({ ticket_no: no }).first('id'))) return no;
  }
  return `T-${Date.now().toString(36).toUpperCase()}`;
}

const ticketUrl = (t, token) => `${base()}/support/tickets/${t.ticket_no}${token ? `?t=${token}` : ''}`;

/** Opens a ticket (signed-in user, or guest with name + email). Returns { ticket, token } (token only for guests). */
async function openTicket({ user = null, name, email, subject, body }, knex = db()) {
  const errors = {};
  const n = user ? user.full_name : str(name, 150);
  const e = user ? user.email : str(email, 191).toLowerCase();
  const s = str(subject, 200);
  const b = str(body, 10000);
  if (!user && n.length < 2) errors.name = 'Enter your name.';
  if (!user && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) errors.email = 'Enter a valid email address.';
  if (s.length < 4) errors.subject = 'Add a short subject.';
  if (b.length < 10) errors.body = 'Tell us a little more (at least 10 characters).';
  if (Object.keys(errors).length) throw new EngagementError('Please correct the highlighted fields.', errors);
  const token = user ? null : crypto.randomBytes(18).toString('hex');
  const no = await ticketNo(knex);
  const id = await knex.transaction(async (trx) => {
    const [tid] = await trx('support_tickets').insert({ ticket_no: no, user_id: user ? user.id : null, name: n, email: e, subject: s, status: 'open', priority: 'normal', access_token_hash: token ? sha(token) : null });
    await trx('ticket_messages').insert({ ticket_id: tid, user_id: user ? user.id : null, is_staff: false, body: b });
    return tid;
  });
  const ticket = await knex('support_tickets').where({ id }).first();
  await require('./mail').queue({ to: e, template: 'support_received', vars: { name: n.split(' ')[0], ticket_no: no, subject: s, ticket_url: ticketUrl(ticket, token) } }, knex).catch(() => {});
  return { ticket, token };
}

/** Loads a ticket for its owner (signed in) or for a guest holding the access token. */
async function ticketForRequester(no, { user = null, token = null }, knex = db()) {
  const t = await knex('support_tickets').where({ ticket_no: str(no, 20).toUpperCase() }).first();
  if (!t) return null;
  if (user && t.user_id === user.id) return t;
  if (token && t.access_token_hash && crypto.timingSafeEqual(Buffer.from(sha(token)), Buffer.from(t.access_token_hash))) return t;
  return null;
}

async function messages(ticketId, knex = db()) {
  return knex('ticket_messages as m').leftJoin('users as u', 'u.id', 'm.user_id').where('m.ticket_id', ticketId).orderBy('m.id').select('m.*', 'u.full_name as author');
}

/** Adds a reply. Staff replies email the requester and set status "pending" (waiting on them). */
async function reply(ticket, { user = null, isStaff = false, body, status = null, token = null }, knex = db()) {
  const b = str(body, 10000);
  if (b.length < 2) throw new EngagementError('Write a reply first.', { body: 'Write a reply first.' });
  if (!isStaff && ticket.status === 'closed') throw new EngagementError('This ticket is closed. Open a new one if you still need help.');
  await knex('ticket_messages').insert({ ticket_id: ticket.id, user_id: user ? user.id : null, is_staff: !!isStaff, body: b });
  const next = isStaff ? (STATUSES.includes(status) ? status : 'pending') : 'open';
  await knex('support_tickets').where({ id: ticket.id }).update({ status: next, updated_at: new Date() });
  if (isStaff) {
    await require('./mail').queue({ to: ticket.email, template: 'support_reply', vars: { name: ticket.name.split(' ')[0], ticket_no: ticket.ticket_no, subject: ticket.subject, reply: b, ticket_url: ticketUrl(ticket, token) } }, knex).catch(() => {});
    if (ticket.user_id) await notify(ticket.user_id, { type: 'support', title: `New reply on ${ticket.ticket_no}`, body: b.slice(0, 160), url: `/support/tickets/${ticket.ticket_no}` }, knex);
  }
}

async function updateTicket(id, { status, priority, assigned_to }, knex = db()) {
  const patch = { updated_at: new Date() };
  if (STATUSES.includes(status)) patch.status = status;
  if (PRIORITIES.includes(priority)) patch.priority = priority;
  if (assigned_to !== undefined) patch.assigned_to = Number(assigned_to) || null;
  await knex('support_tickets').where({ id }).update(patch);
}

module.exports = {
  EngagementError,
  notify,
  unreadCount,
  listNotifications,
  markRead,
  LEVELS,
  TARGETS,
  saveAnnouncement,
  announcementsFor,
  clearAnnouncementCache,
  savePage,
  footerPages,
  saveFaq,
  STATUSES,
  PRIORITIES,
  openTicket,
  ticketForRequester,
  messages,
  reply,
  updateTicket,
};
