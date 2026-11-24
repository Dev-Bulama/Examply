'use strict';

const express = require('express');
const { requireAuth, can } = require('../../middleware/auth');
const { appNav } = require('../../middleware/nav');
const { memoryUpload } = require('../../services/uploads');
const { asyncHandler: h } = require('../../utils/errors');
const dashboard = require('../../controllers/admin/dashboardController');
const usersC = require('../../controllers/admin/usersController');
const roles = require('../../controllers/admin/rolesController');
const settingsC = require('../../controllers/admin/settingsController');
const system = require('../../controllers/admin/systemController');

const router = express.Router();

// Every admin route: signed in + admin.access + the specific permission below.
router.use(requireAuth, can('admin.access'), appNav('admin'));

router.get('/', h(dashboard.index));

// Users
router.get('/users', can('users.view'), h(usersC.index));
router.get('/users/new', can('users.manage'), h(usersC.newForm));
router.post('/users', can('users.manage'), h(usersC.create));
router.get('/users/:id(\\d+)', can('users.view'), h(usersC.show));
router.post('/users/:id(\\d+)', can('users.manage'), h(usersC.update));
router.post('/users/:id(\\d+)/accommodations', can('users.accommodations'), h(usersC.updateAccommodations));
router.post('/users/:id(\\d+)/:action(verify-email|send-reset|reset-2fa|delete)', can('users.manage'), h(usersC.action));

// Roles
router.get('/roles', can('roles.manage'), h(roles.index));
router.get('/roles/new', can('roles.manage'), h(roles.form));
router.post('/roles', can('roles.manage'), h(roles.save));
router.get('/roles/:id(\\d+)/edit', can('roles.manage'), h(roles.form));
router.post('/roles/:id(\\d+)', can('roles.manage'), h(roles.save));
router.post('/roles/:id(\\d+)/delete', can('roles.manage'), h(roles.destroy));

// Settings
router.get('/settings', can('settings.manage'), (req, res) => res.redirect('/admin/settings/general'));
router.get('/settings/:section', can('settings.manage'), h(settingsC.show));
router.post('/settings/email/test', can('settings.manage'), h(settingsC.testEmail));
router.post('/settings/branding/upload/:key', can('settings.manage'), memoryUpload({ field: 'file', maxBytes: 1024 * 1024 }), h(settingsC.upload));
router.post('/settings/branding/remove/:key', can('settings.manage'), h(settingsC.removeUpload));
router.post('/settings/:section', can('settings.manage'), h(settingsC.save));

// Audit log & jobs
router.get('/audit', can('audit.view'), h(system.auditIndex));
router.get('/audit/:id(\\d+)', can('audit.view'), h(system.auditShow));
router.get('/jobs', can('jobs.view'), h(system.jobsIndex));
router.post('/jobs/run', can('jobs.view'), h(system.jobsRunNow));
router.post('/jobs/:id(\\d+)/retry', can('jobs.view'), h(system.jobRetry));

module.exports = router;
