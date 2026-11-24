'use strict';

const express = require('express');
const { requireAuth, can, canAny } = require('../../middleware/auth');
const { appNav } = require('../../middleware/nav');
const { memoryUpload } = require('../../services/uploads');
const { asyncHandler: h } = require('../../utils/errors');
const dashboard = require('../../controllers/admin/dashboardController');
const usersC = require('../../controllers/admin/usersController');
const roles = require('../../controllers/admin/rolesController');
const settingsC = require('../../controllers/admin/settingsController');
const system = require('../../controllers/admin/systemController');
const cat = require('../../controllers/admin/catalogueController');
const qs = require('../../controllers/admin/questionsController');
const imports = require('../../controllers/admin/importsController');
const ai = require('../../controllers/admin/aiController');
const exams = require('../../controllers/admin/examsController');
const att = require('../../controllers/admin/attemptsController');
const sqlLab = require('../../controllers/admin/sqlLabController');
const { uploadLimiter, sqlLimiter } = require('../../middleware/rateLimit');

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

// Catalogue
const catImage = memoryUpload({ field: 'image', maxBytes: 1024 * 1024 });
router.get('/catalogue/categories', can('catalogue.manage'), h(cat.categoriesIndex));
router.get('/catalogue/categories/new', can('catalogue.manage'), h(cat.categoryForm));
router.post('/catalogue/categories', can('catalogue.manage'), catImage, h(cat.categorySave));
router.get('/catalogue/categories/:id(\\d+)/edit', can('catalogue.manage'), h(cat.categoryForm));
router.post('/catalogue/categories/:id(\\d+)', can('catalogue.manage'), catImage, h(cat.categorySave));
router.post('/catalogue/categories/:id(\\d+)/delete', can('catalogue.manage'), h(cat.categoryDelete));
router.get('/catalogue/certifications', can('catalogue.manage'), h(cat.certificationsIndex));
router.get('/catalogue/certifications/new', can('catalogue.manage'), h(cat.certificationForm));
router.post('/catalogue/certifications', can('catalogue.manage'), h(cat.certificationSave));
router.get('/catalogue/certifications/:id(\\d+)/edit', can('catalogue.manage'), h(cat.certificationForm));
router.post('/catalogue/certifications/:id(\\d+)', can('catalogue.manage'), h(cat.certificationSave));
router.post('/catalogue/certifications/:id(\\d+)/delete', can('catalogue.manage'), h(cat.certificationDelete));
router.get('/catalogue/certifications/:id(\\d+)/domains.json', canAny('questions.view', 'catalogue.manage'), h(cat.domainsJson));
router.get('/catalogue/programmes', can('catalogue.manage'), h(cat.programmesIndex));
router.get('/catalogue/programmes/new', can('catalogue.manage'), h(cat.programmeForm));
router.post('/catalogue/programmes', can('catalogue.manage'), h(cat.programmeSave));
router.get('/catalogue/programmes/:id(\\d+)/edit', can('catalogue.manage'), h(cat.programmeForm));
router.post('/catalogue/programmes/:id(\\d+)', can('catalogue.manage'), h(cat.programmeSave));
router.post('/catalogue/programmes/:id(\\d+)/delete', can('catalogue.manage'), h(cat.programmeDelete));

// Imports & export
const importUpload = memoryUpload({ field: 'file', maxBytes: 25 * 1024 * 1024 });
router.get('/imports', can('questions.import'), h(imports.index));
router.get('/imports/new', can('questions.import'), h(imports.newForm));
router.post('/imports', can('questions.import'), uploadLimiter(), importUpload, h(imports.create));
router.get('/imports/templates/:format(xlsx|csv|json|aiken|gift|docx)', can('questions.import'), h(imports.template));
router.get('/imports/:id(\\d+)', can('questions.import'), h(imports.show));
router.get('/imports/:id(\\d+)/status.json', can('questions.import'), h(imports.status));
router.post('/imports/:id(\\d+)/decisions', can('questions.import'), h(imports.decisions));
router.post('/imports/:id(\\d+)/confirm', can('questions.import'), h(imports.confirm));
router.post('/imports/:id(\\d+)/discard', can('questions.import'), h(imports.discard));
router.post('/imports/:id(\\d+)/undo', can('questions.import'), h(imports.undo));
router.get('/imports/:id(\\d+)/error-report', can('questions.import'), h(imports.errorReport));
router.get('/ai/new', can('ai.generate'), h((req, res) => ai.newForm(req, res)));
router.get('/ai/exam', canAny('ai.generate'), h(ai.examForm));
router.post('/ai', can('ai.generate'), h(ai.create));
router.get('/questions/export', can('questions.export'), h(imports.exportQuestions));

// Question bank
router.get('/questions', can('questions.view'), h(qs.index));
router.get('/questions/new/choose', can('questions.create'), h(qs.chooseType));
router.get('/questions/new', can('questions.create'), h(qs.newForm));
router.post('/questions', can('questions.create'), h(qs.create));
router.post('/questions/bulk', canAny('questions.create', 'questions.publish', 'questions.edit_any', 'questions.delete'), h(qs.bulk));
router.get('/questions/duplicates', can('questions.view'), h(qs.duplicates));
router.post('/questions/media', can('questions.create'), uploadLimiter(), memoryUpload({ field: 'file', maxBytes: 5 * 1024 * 1024 }), h(qs.uploadMedia));
router.get('/questions/reports', can('question_reports.manage'), h(qs.reportsIndex));
router.post('/questions/reports/:id(\\d+)/:action(resolve|dismiss)', can('question_reports.manage'), h(qs.reportResolve));
router.get('/questions/:id(\\d+)', can('questions.view'), h(qs.show));
router.get('/questions/:id(\\d+)/edit', canAny('questions.create', 'questions.edit_any'), h(qs.editForm));
router.post('/questions/:id(\\d+)', canAny('questions.create', 'questions.edit_any'), h(qs.update));
router.get('/questions/:id(\\d+)/versions/:vid(\\d+)', can('questions.view'), h(qs.versionShow));
router.post('/questions/:id(\\d+)/transition/:action(submit|approve|reject|publish|retire|to_draft)', canAny('questions.create', 'questions.review', 'questions.publish', 'questions.edit_any'), h(qs.transition));
router.post('/questions/:id(\\d+)/duplicate', can('questions.create'), h(qs.duplicateQuestion));
router.post('/questions/:id(\\d+)/delete', can('questions.delete'), h(qs.destroy));
// SQL lab (editor "Run" and preview)
router.post('/sql/run', canAny('questions.create', 'questions.edit_any'), sqlLimiter(), h(sqlLab.runDraft));
router.post('/questions/:id(\\d+)/sql/run', can('questions.view'), sqlLimiter(), h(sqlLab.runQuestion));

// Attempts, grading and certificates
router.get('/attempts', can('attempts.view'), h(att.index));
router.get('/attempts/:id(\\d+)', can('attempts.view'), h(att.show));
router.post('/attempts/:id(\\d+)/items/:itemId(\\d+)/grade', can('results.manage'), h(att.gradeItem));
router.post('/attempts/:id(\\d+)/regrade', can('results.manage'), h(att.regrade));
router.post('/attempts/:id(\\d+)/release', can('results.manage'), h(att.release));
router.post('/attempts/:id(\\d+)/submit', can('results.manage'), h(att.forceSubmit));
router.post('/exams/:examId(\\d+)/results/release', can('results.manage'), h(att.releaseAll));
router.post('/certificates/:certId(\\d+)/revoke', can('certificates.manage'), h(att.revokeCertificate));
router.get('/grading', can('results.manage'), h(att.queue));

// Exams
router.get('/exams', can('exams.view'), h(exams.index));
router.post('/exams', can('exams.manage'), h(exams.create));
router.get('/exams/:id(\\d+)', can('exams.view'), (req, res) => res.redirect(`/admin/exams/${req.params.id}/basics`));
router.get('/exams/:id(\\d+)/versions/:v(\\d+)', can('exams.view'), h(exams.versionShow));
router.get('/exams/:id(\\d+)/rules/preview.json', can('exams.manage'), h(exams.rulePreview));
router.get('/exams/:id(\\d+)/:tab([a-z]+)', can('exams.view'), h(exams.builder));
router.post('/exams/:id(\\d+)/sections', can('exams.manage'), h(exams.sectionSave));
router.post('/exams/:id(\\d+)/sections/:sid(\\d+)', can('exams.manage'), h(exams.sectionSave));
router.post('/exams/:id(\\d+)/sections/:sid(\\d+)/delete', can('exams.manage'), h(exams.sectionDelete));
router.post('/exams/:id(\\d+)/items/add', can('exams.manage'), h(exams.itemsAdd));
router.post('/exams/:id(\\d+)/items', can('exams.manage'), h(exams.itemsUpdate));
router.post('/exams/:id(\\d+)/rules', can('exams.manage'), h(exams.ruleSave));
router.post('/exams/:id(\\d+)/rules/:rid(\\d+)', can('exams.manage'), h(exams.ruleSave));
router.post('/exams/:id(\\d+)/rules/:rid(\\d+)/delete', can('exams.manage'), h(exams.ruleDelete));
router.post('/exams/:id(\\d+)/bands', can('exams.manage'), h(exams.bandsSave));
router.post('/exams/:id(\\d+)/access', can('exams.manage'), h(exams.accessAdd));
router.post('/exams/:id(\\d+)/access/:rid(\\d+)/delete', can('exams.manage'), h(exams.accessRemove));
router.post('/exams/:id(\\d+)/overrides', can('exams.grant_attempts'), h(exams.grantAttempts));
router.post('/exams/:id(\\d+)/publish', can('exams.publish'), h(exams.publish));
router.post('/exams/:id(\\d+)/:action(unpublish|archive)', can('exams.publish'), h(exams.lifecycle));
router.post('/exams/:id(\\d+)/:action(duplicate|delete)', can('exams.manage'), h(exams.lifecycle));
router.post('/exams/:id(\\d+)/tab/:tab([a-z]+)', can('exams.manage'), h(exams.saveTab));
router.post('/users/:id(\\d+)/author-categories', can('users.manage'), h(qs.setAuthorCategories));

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
router.post('/settings/ai/test/:provider(anthropic|openai)', can('settings.manage'), h(settingsC.testAi));
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
