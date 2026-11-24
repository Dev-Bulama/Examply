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
    res.render('candidate/dashboard', {
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
