'use strict';

const { db } = require('../../config/db');
const audit = require('../../services/audit');
const queue = require('../../services/jobs/queue');
const { paginate } = require('../../utils/paginate');
const { parseJson } = require('../../utils/json');
const { notFound } = require('../../utils/errors');

// ---------------------------------------------------------------- Audit log

async function auditIndex(req, res) {
  const { action = '', user = '', entity = '', from = '', to = '' } = req.query;
  const q = db()('audit_logs as a').leftJoin('users as u', 'u.id', 'a.user_id');
  if (action) q.where('a.action', 'like', `${String(action).replace(/[%_\\]/g, '\\$&')}%`);
  if (user) q.where((w) => w.where('u.email', 'like', `%${user}%`).orWhere('u.full_name', 'like', `%${user}%`));
  if (entity) q.where('a.entity_type', entity);
  if (/^\d{4}-\d{2}-\d{2}$/.test(from)) q.where('a.created_at', '>=', new Date(`${from}T00:00:00Z`));
  if (/^\d{4}-\d{2}-\d{2}$/.test(to)) q.where('a.created_at', '<', new Date(new Date(`${to}T00:00:00Z`).getTime() + 86400000));
  q.orderBy('a.created_at', 'desc').orderBy('a.id', 'desc').select('a.id', 'a.action', 'a.entity_type', 'a.entity_id', 'a.ip', 'a.created_at', 'u.full_name', 'u.email');
  const pager = await paginate(q, { page: req.query.page, perPage: 50 });
  const entities = await db()('audit_logs').distinct('entity_type').whereNotNull('entity_type').orderBy('entity_type').pluck('entity_type');
  res.render('admin/audit/index', {
    title: 'Audit log',
    layout: 'layouts/app',
    pager,
    entities,
    filters: { action, user, entity, from, to },
    query: req.query,
    breadcrumbs: [{ label: 'Admin', href: '/admin' }, { label: 'Audit log' }],
  });
}

async function auditShow(req, res) {
  const row = await db()('audit_logs as a').leftJoin('users as u', 'u.id', 'a.user_id').where('a.id', req.params.id).first('a.*', 'u.full_name', 'u.email');
  if (!row) throw notFound('That audit entry does not exist.');
  const before = parseJson(row.before);
  const after = parseJson(row.after);
  const keys = [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])];
  const diff = keys.map((k) => ({
    key: k,
    before: before ? before[k] : undefined,
    after: after ? after[k] : undefined,
    changed: JSON.stringify(before ? before[k] : undefined) !== JSON.stringify(after ? after[k] : undefined),
  }));
  res.render('admin/audit/show', {
    title: `Audit #${row.id}`,
    layout: 'layouts/app',
    row,
    diff,
    breadcrumbs: [{ label: 'Admin', href: '/admin' }, { label: 'Audit log', href: '/admin/audit' }, { label: `#${row.id}` }],
  });
}

// ---------------------------------------------------------------- Background jobs

async function jobsIndex(req, res) {
  const status = ['pending', 'running', 'completed', 'failed'].includes(req.query.status) ? req.query.status : '';
  const q = db()('jobs');
  if (status) q.where({ status });
  q.orderBy('id', 'desc').select('id', 'type', 'status', 'attempts', 'max_attempts', 'run_at', 'last_error', 'created_at', 'completed_at', 'payload');
  const pager = await paginate(q, { page: req.query.page, perPage: 30 });
  for (const j of pager.rows) {
    const p = parseJson(j.payload, {});
    j.summary = j.type === 'email.send' ? `${p.template} → ${p.to}` : '';
  }
  const counts = await db()('jobs').groupBy('status').select('status', db().raw('COUNT(*) as n'));
  res.render('admin/jobs/index', {
    title: 'Background jobs',
    layout: 'layouts/app',
    pager,
    status,
    counts: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])),
    query: req.query,
    breadcrumbs: [{ label: 'Admin', href: '/admin' }, { label: 'Background jobs' }],
  });
}

async function jobRetry(req, res) {
  const job = await db()('jobs').where({ id: req.params.id }).first();
  if (!job) throw notFound('That job does not exist.');
  if (job.status !== 'failed') {
    req.flash('info', 'Only failed jobs can be retried.');
    return res.redirect('/admin/jobs');
  }
  await db()('jobs').where({ id: job.id }).update({ status: 'pending', attempts: 0, run_at: new Date(), last_error: null });
  await audit.record(req, 'job.retry', { entityType: 'job', entityId: job.id });
  req.flash('success', `Job #${job.id} queued again.`);
  return res.redirect('/admin/jobs?status=failed');
}

async function jobsRunNow(req, res) {
  const result = await queue.runDueJobs({ limit: 50, timeBudgetMs: 20000 });
  req.flash('success', `Processed ${result.processed} job${result.processed === 1 ? '' : 's'}${result.failed ? ` (${result.failed} failed)` : ''}.`);
  return res.redirect('/admin/jobs');
}

module.exports = { auditIndex, auditShow, jobsIndex, jobRetry, jobsRunNow };
