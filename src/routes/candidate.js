'use strict';

const express = require('express');
const { db } = require('../config/db');
const { requireAuth } = require('../middleware/auth');
const { appNav } = require('../middleware/nav');
const { asyncHandler: h } = require('../utils/errors');

const router = express.Router();

const PROFILE_CHECKS = [
  ['full_name', 'Full name'],
  ['phone', 'Phone number'],
  ['country', 'Country'],
  ['organisation_name', 'Organisation'],
  ['job_title', 'Job title'],
  ['years_experience', 'Years of experience'],
  ['photo_path', 'Profile photo'],
];

router.get(
  '/dashboard',
  requireAuth,
  appNav('candidate'),
  h(async (req, res) => {
    const u = req.user;
    const missing = PROFILE_CHECKS.filter(([k]) => u[k] === null || u[k] === undefined || u[k] === '').map(([, label]) => label);
    const completeness = Math.round(((PROFILE_CHECKS.length - missing.length) / PROFILE_CHECKS.length) * 100);
    const [inProgress, results, certificates] = await Promise.all([
      db()('attempts as a').join('exams as e', 'e.id', 'a.exam_id').where({ 'a.user_id': u.id, 'a.status': 'in_progress' }).count('* as n').first(),
      db()('results').where({ user_id: u.id }).count('* as n').first(),
      db()('certificates').where({ user_id: u.id }).whereNull('revoked_at').count('* as n').first(),
    ]);
    const recent = await db()('attempts as a')
      .join('exams as e', 'e.id', 'a.exam_id')
      .leftJoin('results as r', 'r.attempt_id', 'a.id')
      .where('a.user_id', u.id)
      .orderBy('a.id', 'desc')
      .limit(6)
      .select('a.uuid', 'a.status', 'a.mode', 'a.attempt_no', 'a.started_at', 'a.expires_at', 'e.title', 'r.percent', 'r.passed', 'r.band', 'r.release_status', 'r.has_pending_manual');
    const suggested = await db()('exams').where({ status: 'published', visibility: 'public' }).whereNull('deleted_at').whereNull('organisation_id').orderBy('published_at', 'desc').limit(3).select('slug', 'title', 'type', 'duration_minutes', 'is_paid');
    const assigned = await require('../services/workspaces').assignmentsFor(u.id);
    res.render('candidate/dashboard', {
      assigned,
      recent,
      suggested,
      title: 'Dashboard',
      layout: 'layouts/app',
      completeness,
      missing,
      counts: { inProgress: Number(inProgress.n), results: Number(results.n), certificates: Number(certificates.n) },
      breadcrumbs: [{ label: 'Dashboard' }],
    });
  }),
);

module.exports = router;
