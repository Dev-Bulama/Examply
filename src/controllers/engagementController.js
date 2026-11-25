'use strict';

const { db } = require('../config/db');
const { parseJson } = require('../utils/json');
const { notFound } = require('../utils/errors');
const { sanitizeRich } = require('../utils/html');
const audit = require('../services/audit');
const mail = require('../services/mail');
const E = require('../services/engagement');
const { clearFooterCache } = require('../middleware/engagement');
const { DEFAULT_TEMPLATES } = require('../services/mail/templates');

const fail = (req, res, err, back) => {
  if (!(err instanceof E.EngagementError)) throw err;
  req.setFormState(req.body, err.fields || {});
  req.flash('danger', err.message);
  return res.redirect(back);
};
const adminCrumbs = (label, href, extra) => [{ label: 'Admin', href: '/admin' }, { label, href }, ...(extra ? [extra] : [])];

// ================================================================ Notifications

async function notifications(req, res) {
  const rows = await E.listNotifications(req.user.id, { limit: 100 });
  res.render('engagement/notifications', { title: 'Notifications', layout: 'layouts/app', rows, breadcrumbs: [{ label: 'Notifications' }] });
}

async function openNotification(req, res) {
  const n = await db()('notifications').where({ id: Number(req.params.id), user_id: req.user.id }).first();
  if (!n) throw notFound();
  await E.markRead(req.user.id, n.id);
  const url = n.url && /^\/(?!\/)/.test(n.url) ? n.url : '/notifications'; // internal links only
  res.redirect(url);
}

async function readAll(req, res) {
  await E.markRead(req.user.id);
  req.flash('success', 'All notifications marked as read.');
  res.redirect('/notifications');
}

// ================================================================ Help centre & pages

async function help(req, res) {
  const faqs = await db()('faqs').where({ is_published: true }).orderBy([{ column: 'category' }, { column: 'display_order' }, { column: 'id' }]);
  const groups = [];
  for (const f of faqs) {
    const name = f.category || 'General';
    let g = groups.find((x) => x.name === name);
    if (!g) groups.push((g = { name, items: [] }));
    g.items.push(f);
  }
  res.render('engagement/help', { title: 'Help centre', layout: 'layouts/public', groups });
}

async function page(req, res) {
  const p = await db()('pages').where({ slug: String(req.params.slug), is_published: true }).first();
  if (!p) throw notFound();
  res.render('engagement/page', { title: p.meta_title || p.title, metaDescription: p.meta_description, layout: 'layouts/public', p });
}

// ================================================================ Support (requesters)

async function supportHome(req, res) {
  const mine = req.user ? await db()('support_tickets').where({ user_id: req.user.id }).orderBy('updated_at', 'desc').limit(50) : [];
  res.render('engagement/support', { title: 'Contact support', layout: req.user ? 'layouts/app' : 'layouts/public', mine, breadcrumbs: [{ label: 'Help & support' }] });
}

async function supportCreate(req, res) {
  try {
    const { ticket, token } = await E.openTicket({ user: req.user || null, name: req.body.name, email: req.body.email, subject: req.body.subject, body: req.body.body });
    req.flash('success', `Thanks — ticket ${ticket.ticket_no} is open. ${token ? 'We emailed you a private link to follow it.' : 'We will reply here and by email.'}`);
    return res.redirect(`/support/tickets/${ticket.ticket_no}${token ? `?t=${token}` : ''}`);
  } catch (err) {
    return fail(req, res, err, '/support');
  }
}

async function loadRequesterTicket(req) {
  const token = String(req.query.t || req.body.t || '');
  const t = await E.ticketForRequester(req.params.no, { user: req.user || null, token });
  if (!t) throw notFound('Ticket not found. Use the link from your email, or sign in with the account that opened it.');
  return { t, token };
}

async function ticketView(req, res) {
  const { t, token } = await loadRequesterTicket(req);
  res.render('engagement/ticket', { title: `Ticket ${t.ticket_no}`, layout: req.user ? 'layouts/app' : 'layouts/public', t, token, msgs: await E.messages(t.id), staff: false, breadcrumbs: [{ label: 'Help & support', href: '/support' }, { label: t.ticket_no }] });
}

async function ticketReply(req, res) {
  const { t, token } = await loadRequesterTicket(req);
  const back = `/support/tickets/${t.ticket_no}${token ? `?t=${token}` : ''}`;
  try {
    await E.reply(t, { user: req.user || null, isStaff: false, body: req.body.body });
    req.flash('success', 'Reply sent.');
    return res.redirect(back);
  } catch (err) {
    return fail(req, res, err, back);
  }
}

// ================================================================ Admin: support

async function adminTickets(req, res) {
  const status = E.STATUSES.includes(req.query.status) ? req.query.status : null;
  const q = db()('support_tickets as t').leftJoin('users as a', 'a.id', 't.assigned_to').orderByRaw("field(t.status, 'open', 'pending', 'resolved', 'closed')").orderBy('t.updated_at', 'desc').limit(200).select('t.*', 'a.full_name as assignee');
  if (status) q.where('t.status', status);
  const counts = Object.fromEntries((await db()('support_tickets').select('status').count('* as n').groupBy('status')).map((r) => [r.status, Number(r.n)]));
  res.render('admin/support/index', { title: 'Support tickets', layout: 'layouts/app', rows: await q, status, counts, STATUSES: E.STATUSES, breadcrumbs: adminCrumbs('Support tickets', '/admin/support') });
}

async function adminTicket(req, res) {
  const t = await db()('support_tickets').where({ id: Number(req.params.id) }).first();
  if (!t) throw notFound();
  const staff = await db()('users as u').join('user_roles as ur', 'ur.user_id', 'u.id').join('role_permissions as rp', 'rp.role_id', 'ur.role_id').join('permissions as p', 'p.id', 'rp.permission_id').where('p.key', 'support.manage').whereNull('u.deleted_at').distinct('u.id', 'u.full_name');
  res.render('engagement/ticket', { title: `Ticket ${t.ticket_no}`, layout: 'layouts/app', t, token: null, msgs: await E.messages(t.id), staff: true, staffList: staff, STATUSES: E.STATUSES, PRIORITIES: E.PRIORITIES, breadcrumbs: adminCrumbs('Support tickets', '/admin/support', { label: t.ticket_no }) });
}

async function adminTicketReply(req, res) {
  const t = await db()('support_tickets').where({ id: Number(req.params.id) }).first();
  if (!t) throw notFound();
  try {
    if (String(req.body.body || '').trim()) await E.reply(t, { user: req.user, isStaff: true, body: req.body.body, status: req.body.status });
    await E.updateTicket(t.id, { status: String(req.body.body || '').trim() ? undefined : req.body.status, priority: req.body.priority, assigned_to: req.body.assigned_to });
    await audit.record(req, 'support.update', { entityType: 'support_ticket', entityId: t.id, after: { status: req.body.status, priority: req.body.priority } });
    req.flash('success', String(req.body.body || '').trim() ? 'Reply sent to the requester.' : 'Ticket updated.');
    return res.redirect(`/admin/support/${t.id}`);
  } catch (err) {
    return fail(req, res, err, `/admin/support/${t.id}`);
  }
}

// ================================================================ Admin: announcements

async function adminAnnouncements(req, res) {
  const rows = await db()('announcements').orderBy('id', 'desc');
  res.render('admin/announcements/index', { title: 'Announcements', layout: 'layouts/app', rows, breadcrumbs: adminCrumbs('Announcements', '/admin/announcements') });
}

async function adminAnnouncementForm(req, res) {
  const id = Number(req.params.id) || null;
  const a = id ? await db()('announcements').where({ id }).first() : { level: 'info', target: 'all', is_active: 1, dismissible: 1 };
  if (!a) throw notFound();
  const [roles, orgs] = await Promise.all([db()('roles').orderBy('name').select('slug', 'name'), db()('organisations').whereNull('deleted_at').orderBy('name').select('id', 'name')]);
  res.render('admin/announcements/form', { title: id ? 'Edit announcement' : 'New announcement', layout: 'layouts/app', a: { ...a, target_ids: parseJson(a.target_ids, []) }, id, roles, orgs, LEVELS: E.LEVELS, TARGETS: E.TARGETS, breadcrumbs: adminCrumbs('Announcements', '/admin/announcements', { label: id ? 'Edit' : 'New' }) });
}

async function adminAnnouncementSave(req, res) {
  const id = Number(req.params.id) || null;
  try {
    const saved = await E.saveAnnouncement(id, req.body, req.user.id);
    E.clearAnnouncementCache();
    await audit.record(req, id ? 'announcement.update' : 'announcement.create', { entityType: 'announcement', entityId: saved });
    req.flash('success', 'Announcement saved.');
    return res.redirect('/admin/announcements');
  } catch (err) {
    return fail(req, res, err, id ? `/admin/announcements/${id}/edit` : '/admin/announcements/new');
  }
}

async function adminAnnouncementDelete(req, res) {
  await db()('announcements').where({ id: Number(req.params.id) }).del();
  E.clearAnnouncementCache();
  await audit.record(req, 'announcement.delete', { entityType: 'announcement', entityId: Number(req.params.id) });
  req.flash('success', 'Announcement deleted.');
  res.redirect('/admin/announcements');
}

// ================================================================ Admin: pages & FAQ

async function adminPages(req, res) {
  const [pages, faqs] = await Promise.all([db()('pages').orderBy('display_order').orderBy('title'), db()('faqs').orderBy('category').orderBy('display_order')]);
  res.render('admin/pages/index', { title: 'Pages & FAQ', layout: 'layouts/app', pages, faqs, breadcrumbs: adminCrumbs('Pages & FAQ', '/admin/pages') });
}

async function adminPageForm(req, res) {
  const id = Number(req.params.id) || null;
  const p = id ? await db()('pages').where({ id }).first() : { is_published: 1, show_in_footer: 1, display_order: 0 };
  if (!p) throw notFound();
  res.render('admin/pages/form', { title: id ? 'Edit page' : 'New page', layout: 'layouts/app', p, id, breadcrumbs: adminCrumbs('Pages & FAQ', '/admin/pages', { label: id ? p.title : 'New page' }) });
}

async function adminPageSave(req, res) {
  const id = Number(req.params.id) || null;
  try {
    const saved = await E.savePage(id, req.body);
    clearFooterCache();
    await audit.record(req, id ? 'page.update' : 'page.create', { entityType: 'page', entityId: saved });
    req.flash('success', 'Page saved.');
    return res.redirect('/admin/pages');
  } catch (err) {
    return fail(req, res, err, id ? `/admin/pages/${id}/edit` : '/admin/pages/new');
  }
}

async function adminPageDelete(req, res) {
  await db()('pages').where({ id: Number(req.params.id) }).del();
  clearFooterCache();
  req.flash('success', 'Page deleted.');
  res.redirect('/admin/pages');
}

async function adminFaqForm(req, res) {
  const id = Number(req.params.id) || null;
  const f = id ? await db()('faqs').where({ id }).first() : { is_published: 1, display_order: 0 };
  if (!f) throw notFound();
  const categories = await db()('faqs').whereNotNull('category').distinct('category').pluck('category');
  res.render('admin/pages/faq', { title: id ? 'Edit FAQ' : 'New FAQ', layout: 'layouts/app', f, id, categories, breadcrumbs: adminCrumbs('Pages & FAQ', '/admin/pages', { label: id ? 'Edit FAQ' : 'New FAQ' }) });
}

async function adminFaqSave(req, res) {
  const id = Number(req.params.id) || null;
  try {
    await E.saveFaq(id, req.body);
    req.flash('success', 'FAQ saved.');
    return res.redirect('/admin/pages');
  } catch (err) {
    return fail(req, res, err, id ? `/admin/faqs/${id}/edit` : '/admin/faqs/new');
  }
}

async function adminFaqDelete(req, res) {
  await db()('faqs').where({ id: Number(req.params.id) }).del();
  req.flash('success', 'FAQ deleted.');
  res.redirect('/admin/pages');
}

// ================================================================ Admin: email templates

async function adminTemplates(req, res) {
  const rows = await db()('email_templates').orderBy('name');
  res.render('admin/templates/index', { title: 'Email templates', layout: 'layouts/app', rows, breadcrumbs: adminCrumbs('Email templates', '/admin/email-templates') });
}

async function adminTemplateForm(req, res) {
  const t = await db()('email_templates').where({ key: req.params.key }).first();
  if (!t) throw notFound();
  const sample = Object.fromEntries((parseJson(t.variables, []) || []).map((v) => [v, /url/.test(v) ? 'https://example.com/link' : `[${v}]`]));
  const preview = await mail.render(t.key, { ...sample, name: 'Ada' }).catch(() => null);
  res.render('admin/templates/form', { title: `Email · ${t.name}`, layout: 'layouts/app', t, variables: parseJson(t.variables, []) || [], preview, hasDefault: DEFAULT_TEMPLATES.some((d) => d.key === t.key), breadcrumbs: adminCrumbs('Email templates', '/admin/email-templates', { label: t.name }) });
}

async function adminTemplateSave(req, res) {
  const t = await db()('email_templates').where({ key: req.params.key }).first();
  if (!t) throw notFound();
  if (req.body.reset === '1') {
    const def = DEFAULT_TEMPLATES.find((d) => d.key === t.key);
    if (def) await db()('email_templates').where({ id: t.id }).update({ subject: def.subject, body_html: def.body_html, updated_by: req.user.id });
    req.flash('success', 'Template reset to the default.');
    return res.redirect(`/admin/email-templates/${t.key}`);
  }
  const subject = String(req.body.subject || '').trim().slice(0, 255);
  const body = sanitizeRich(req.body.body_html || '');
  if (subject.length < 3 || body.length < 10) {
    req.setFormState(req.body, { subject: subject.length < 3 ? 'Enter a subject.' : undefined, body_html: body.length < 10 ? 'Enter the email body.' : undefined });
    req.flash('danger', 'Please correct the highlighted fields.');
    return res.redirect(`/admin/email-templates/${t.key}`);
  }
  await db()('email_templates').where({ id: t.id }).update({ subject, body_html: body, updated_by: req.user.id, updated_at: new Date() });
  await audit.record(req, 'email_template.update', { entityType: 'email_template', entityId: t.id });
  req.flash('success', 'Template saved.');
  return res.redirect(`/admin/email-templates/${t.key}`);
}

module.exports = {
  notifications,
  openNotification,
  readAll,
  help,
  page,
  supportHome,
  supportCreate,
  ticketView,
  ticketReply,
  adminTickets,
  adminTicket,
  adminTicketReply,
  adminAnnouncements,
  adminAnnouncementForm,
  adminAnnouncementSave,
  adminAnnouncementDelete,
  adminPages,
  adminPageForm,
  adminPageSave,
  adminPageDelete,
  adminFaqForm,
  adminFaqSave,
  adminFaqDelete,
  adminTemplates,
  adminTemplateForm,
  adminTemplateSave,
};
