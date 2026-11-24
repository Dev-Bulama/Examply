'use strict';

/**
 * Permission catalogue. The database tables `permissions`, `roles`, `role_permissions` are synced from this
 * file on install and on every boot (new permissions are added; existing role grants are never removed).
 * Super Admin implicitly holds every permission.
 */
const PERMISSIONS = [
  // Admin area
  ['admin.access', 'Admin area', 'Open the staff dashboard'],
  ['users.view', 'Users', 'View users and their profiles'],
  ['users.manage', 'Users', 'Create, edit, suspend and delete users; assign roles below own level'],
  ['users.accommodations', 'Users', 'Set accessibility accommodations (extra time, large font, high contrast)'],
  ['roles.manage', 'Users', 'Create and edit roles and their permissions'],
  ['audit.view', 'System', 'View the audit log and login history'],
  ['settings.manage', 'System', 'Change site settings (general, branding, email, security, legal, SEO, maintenance)'],
  ['settings.payments', 'System', 'View and change payment settings (Paystack public key, mode, bank transfer details)'],
  ['settings.payments.secret', 'System', 'Set the Paystack secret key'],
  ['backups.manage', 'System', 'Create and download database backups'],
  ['jobs.view', 'System', 'View background jobs and failures'],
  ['recycle_bin.manage', 'System', 'Restore or permanently delete soft-deleted records'],
  // Catalogue & content
  ['catalogue.manage', 'Catalogue', 'Manage categories, certifications, domains and training programmes'],
  ['questions.view', 'Question bank', 'View the question bank'],
  ['questions.create', 'Question bank', 'Create questions (authors: in assigned categories only)'],
  ['questions.edit_any', 'Question bank', 'Edit any question, regardless of author or category'],
  ['questions.review', 'Question bank', 'Approve or reject questions in review'],
  ['questions.publish', 'Question bank', 'Publish and retire questions directly'],
  ['questions.delete', 'Question bank', 'Delete questions'],
  ['questions.import', 'Question bank', 'Import questions from files'],
  ['questions.export', 'Question bank', 'Export questions to xlsx / JSON / GIFT'],
  ['question_reports.manage', 'Question bank', 'Handle reported questions and re-grade affected attempts'],
  // Exams
  ['exams.view', 'Exams', 'View exams in the admin area'],
  ['exams.manage', 'Exams', 'Create and edit exams, sections, blueprints and bands'],
  ['exams.publish', 'Exams', 'Publish and unpublish exams'],
  ['exams.grant_attempts', 'Exams', 'Grant extra attempts to a candidate'],
  ['attempts.view', 'Results', 'View candidate attempts, integrity timelines and webcam snapshots'],
  ['grading.manual', 'Results', 'Grade essay answers'],
  ['results.manage', 'Results', 'Release results and re-grade attempts'],
  ['results.export', 'Results', 'Export results'],
  ['certificates.manage', 'Results', 'Revoke and re-issue certificates'],
  // Commerce
  ['products.manage', 'Commerce', 'Manage products, past-question packs, bundles and plans'],
  ['coupons.manage', 'Commerce', 'Manage coupons'],
  ['orders.view', 'Commerce', 'View orders and payments'],
  ['orders.manage', 'Commerce', 'Approve bank transfers, refund orders, grant entitlements'],
  ['revenue.view', 'Commerce', 'View the revenue dashboard'],
  ['reviews.moderate', 'Commerce', 'Moderate product reviews'],
  // Organisations
  ['organisations.manage', 'Organisations', 'Manage all organisations, seats and cohorts'],
  ['org.manage_own', 'Organisations', "Manage own organisation's candidates, cohorts, seats and reports"],
  // Live quiz
  ['live.host', 'Live quiz', 'Host live quiz sessions and assign self-paced quizzes'],
  ['live.view_all', 'Live quiz', "View every host's live session reports"],
  // Insights & communication
  ['analytics.view', 'Insights', 'View analytics, item analysis and reports'],
  ['cms.manage', 'Content', 'Edit pages, FAQ, homepage blocks'],
  ['announcements.manage', 'Content', 'Manage announcements'],
  ['email_templates.manage', 'Content', 'Edit email templates'],
  ['support.manage', 'Support', 'Handle support tickets'],
];

const ALL_KEYS = PERMISSIONS.map(([key]) => key);

const ROLES = [
  {
    slug: 'super_admin',
    name: 'Super Admin',
    description: 'Everything, including settings, payment keys, roles and the audit log.',
    permissions: ALL_KEYS,
  },
  {
    slug: 'admin',
    name: 'Admin',
    description: 'Runs the platform day to day. Cannot see the Paystack secret key or change roles.',
    permissions: ALL_KEYS.filter(
      (k) => !['roles.manage', 'settings.manage', 'settings.payments', 'settings.payments.secret', 'audit.view', 'backups.manage'].includes(k),
    ),
  },
  {
    slug: 'question_author',
    name: 'Question Author',
    description: 'Creates and edits questions in assigned categories and submits them for review.',
    permissions: ['admin.access', 'questions.view', 'questions.create'],
  },
  {
    slug: 'reviewer',
    name: 'Reviewer',
    description: 'Approves or rejects questions in review.',
    permissions: ['admin.access', 'questions.view', 'questions.review', 'questions.publish', 'question_reports.manage'],
  },
  {
    slug: 'org_manager',
    name: 'Organisation Manager',
    description: "Manages an organisation's candidates, cohorts, seats and reports.",
    permissions: ['org.manage_own'],
  },
  {
    slug: 'instructor',
    name: 'Instructor / Live Host',
    description: 'Runs live quizzes, assigns self-paced quizzes and views their sessions.',
    permissions: ['admin.access', 'exams.view', 'live.host'],
  },
  {
    slug: 'candidate',
    name: 'Candidate',
    description: 'Takes exams, buys past questions, views results and certificates.',
    permissions: [],
  },
];

/** Roles whose members must use 2FA when Settings → Security → "Require 2FA for admins" is on. */
const TWO_FACTOR_REQUIRED_ROLES = ['super_admin', 'admin'];

module.exports = { PERMISSIONS, ALL_KEYS, ROLES, TWO_FACTOR_REQUIRED_ROLES };
