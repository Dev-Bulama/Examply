'use strict';

const { db } = require('../../config/db');
const settings = require('../../services/settings');
const { startOfDay, startOfMonth } = require('../../utils/time');

const num = async (q) => Number((await q)?.n || 0);

async function index(req, res) {
  if (req.workspace) return res.redirect('/org');
  const k = db();
  const tz = settings.getSync('general.timezone');
  const today = startOfDay(tz);
  const monthStartLocal = startOfMonth(tz);
  const weekAgo = new Date(Date.now() - 7 * 86400000);
  const monthAgo = new Date(Date.now() - 30 * 86400000);

  const [totalUsers, newUsers7, attemptsToday, graded30, passed30, revenueToday, revenueMtd, pendingEssays, reportedQuestions, failedImports, failedJobs, deletionRequests, pendingTransfers] =
    await Promise.all([
      num(k('users').whereNull('deleted_at').count('* as n').first()),
      num(k('users').whereNull('deleted_at').where('created_at', '>=', weekAgo).count('* as n').first()),
      num(k('attempts').where('started_at', '>=', today).count('* as n').first()),
      num(k('results').where('created_at', '>=', monthAgo).whereNotNull('passed').count('* as n').first()),
      num(k('results').where('created_at', '>=', monthAgo).where('passed', true).count('* as n').first()),
      num(k('orders').where('status', 'paid').where('paid_at', '>=', today).sum('total_kobo as n').first()),
      num(k('orders').where('status', 'paid').where('paid_at', '>=', monthStartLocal).sum('total_kobo as n').first()),
      num(k('attempt_items').where('grading_status', 'pending_manual').count('* as n').first()),
      num(k('question_reports').where('status', 'open').count('* as n').first()),
      num(k('imports').where('status', 'failed').where('created_at', '>=', monthAgo).count('* as n').first()),
      num(k('jobs').where('status', 'failed').count('* as n').first()),
      num(k('users').whereNull('deleted_at').whereNotNull('deletion_requested_at').count('* as n').first()),
      num(k('orders').where('status', 'awaiting_transfer').whereNotNull('transfer_submitted_at').count('* as n').first()),
    ]);

  const recentUsers = req.user.can('users.view')
    ? await k('users').whereNull('deleted_at').orderBy('created_at', 'desc').limit(6).select('id', 'full_name', 'email', 'created_at', 'email_verified_at')
    : [];
  const recentAudit = req.user.can('audit.view')
    ? await k('audit_logs as a').leftJoin('users as u', 'u.id', 'a.user_id').orderBy('a.created_at', 'desc').limit(8).select('a.id', 'a.action', 'a.entity_type', 'a.entity_id', 'a.created_at', 'u.full_name')
    : [];

  res.render('admin/dashboard', {
    title: 'Admin dashboard',
    layout: 'layouts/app',
    kpi: {
      totalUsers,
      newUsers7,
      attemptsToday,
      passRate: graded30 ? Math.round((passed30 / graded30) * 100) : null,
      graded30,
      revenueToday,
      revenueMtd,
      pendingEssays,
      reportedQuestions,
      failedImports,
      failedJobs,
      deletionRequests,
      pendingTransfers,
    },
    recentUsers,
    recentAudit,
    breadcrumbs: [{ label: 'Admin' }, { label: 'Dashboard' }],
  });
}

module.exports = { index };
