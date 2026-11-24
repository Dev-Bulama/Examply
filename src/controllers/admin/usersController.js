'use strict';

const { db } = require('../../config/db');
const { getEnv } = require('../../config/env');
const audit = require('../../services/audit');
const users = require('../../services/auth/users');
const tokens = require('../../services/auth/tokens');
const passwords = require('../../services/auth/passwords');
const mail = require('../../services/mail');
const { paginate } = require('../../utils/paginate');
const { notFound, forbidden } = require('../../utils/errors');
const { fieldErrors } = require('../../middleware/validate');
const { z, trimmed, email, checkbox } = require('../../validators/common');
const { TIMEZONES } = require('../../utils/time');

/**
 * Privilege rules (no escalation):
 * - An actor may assign a role only if they already hold every permission that role grants.
 * - Only a Super Admin may assign or remove the Super Admin role, or edit a Super Admin.
 * - An actor may not edit a user who holds a role the actor could not assign.
 * - The last active Super Admin cannot be demoted, suspended or deleted.
 */
async function rolesWithPermissions(knex = db()) {
  const roles = await knex('roles').orderBy('is_system', 'desc').orderBy('name').select('id', 'slug', 'name', 'description', 'is_system');
  const grants = await knex('role_permissions as rp').join('permissions as p', 'p.id', 'rp.permission_id').select('rp.role_id', 'p.key');
  for (const r of roles) r.permissions = grants.filter((g) => g.role_id === r.id).map((g) => g.key);
  return roles;
}

function canAssignRole(actor, role) {
  if (role.slug === 'super_admin') return actor.hasRole('super_admin');
  return role.permissions.every((k) => actor.permissions.has(k));
}

async function loadTarget(req) {
  const target = await db()('users').where({ id: req.params.id }).whereNull('deleted_at').first();
  if (!target) throw notFound('That user does not exist.');
  target.roles = await db()('user_roles as ur').join('roles as r', 'r.id', 'ur.role_id').where('ur.user_id', target.id).select('r.id', 'r.slug', 'r.name');
  return target;
}

async function assertCanManage(actor, target) {
  const allRoles = await rolesWithPermissions();
  const targetRoles = allRoles.filter((r) => target.roles.some((tr) => tr.id === r.id));
  if (target.id !== actor.id && targetRoles.some((r) => !canAssignRole(actor, r))) {
    throw forbidden('This user holds a role above your own permissions, so you cannot change their account.');
  }
  return allRoles;
}

async function activeSuperAdminCount(knex = db()) {
  const row = await knex('user_roles as ur')
    .join('roles as r', 'r.id', 'ur.role_id')
    .join('users as u', 'u.id', 'ur.user_id')
    .where('r.slug', 'super_admin')
    .whereNull('u.deleted_at')
    .where('u.status', 'active')
    .count('* as n')
    .first();
  return Number(row.n);
}

const STATUS_FILTERS = {
  active: (q) => q.where('u.status', 'active'),
  suspended: (q) => q.where('u.status', 'suspended'),
  unverified: (q) => q.whereNull('u.email_verified_at'),
  deletion: (q) => q.whereNotNull('u.deletion_requested_at'),
};

async function index(req, res) {
  const { q = '', role = '', status = '' } = req.query;
  const query = db()('users as u').whereNull('u.deleted_at');
  if (q) {
    const like = `%${String(q).trim().replace(/[%_\\]/g, '\\$&')}%`;
    query.where((w) => w.where('u.full_name', 'like', like).orWhere('u.email', 'like', like).orWhere('u.organisation_name', 'like', like));
  }
  if (role) query.whereExists((s) => s.select(1).from('user_roles as ur').join('roles as r', 'r.id', 'ur.role_id').whereRaw('ur.user_id = u.id').where('r.slug', role));
  if (STATUS_FILTERS[status]) STATUS_FILTERS[status](query);
  query.orderBy('u.created_at', 'desc').select('u.id', 'u.full_name', 'u.email', 'u.status', 'u.email_verified_at', 'u.totp_enabled_at', 'u.last_login_at', 'u.created_at', 'u.deletion_requested_at', 'u.organisation_name');
  const pager = await paginate(query, { page: req.query.page, perPage: 25 });
  const ids = pager.rows.map((r) => r.id);
  const roleRows = ids.length ? await db()('user_roles as ur').join('roles as r', 'r.id', 'ur.role_id').whereIn('ur.user_id', ids).select('ur.user_id', 'r.name', 'r.slug') : [];
  for (const row of pager.rows) row.roles = roleRows.filter((r) => r.user_id === row.id);
  const roles = await db()('roles').orderBy('name').select('slug', 'name');
  res.render('admin/users/index', {
    title: 'Users',
    layout: 'layouts/app',
    pager,
    roles,
    filters: { q, role, status },
    query: req.query,
    breadcrumbs: [{ label: 'Admin', href: '/admin' }, { label: 'Users' }],
  });
}

async function newForm(req, res) {
  const roles = (await rolesWithPermissions()).filter((r) => canAssignRole(req.user, r));
  res.render('admin/users/new', {
    title: 'Add user',
    layout: 'layouts/app',
    roles,
    policyText: passwords.describe(await passwords.policy()),
    breadcrumbs: [{ label: 'Admin', href: '/admin' }, { label: 'Users', href: '/admin/users' }, { label: 'Add user' }],
  });
}

const createSchema = z.object({
  full_name: trimmed(150, 2),
  email,
  roles: z.union([z.string(), z.array(z.string())]).optional().transform((v) => (v === undefined ? [] : Array.isArray(v) ? v : [v])),
  password_mode: z.enum(['invite', 'set']),
  password: z.string().max(200).optional(),
  email_verified: checkbox,
});

async function create(req, res) {
  const parsed = createSchema.safeParse(req.body);
  const errors = parsed.success ? {} : fieldErrors(parsed.error);
  const v = parsed.success ? parsed.data : null;
  const allRoles = await rolesWithPermissions();
  if (v) {
    if (await users.findByEmail(v.email)) errors.email = 'A user with this email already exists.';
    for (const slug of v.roles) {
      const role = allRoles.find((r) => r.slug === slug);
      if (!role || !canAssignRole(req.user, role)) errors.roles = 'You cannot assign one of the selected roles.';
    }
    if (!v.roles.length) errors.roles = 'Choose at least one role.';
    if (v.password_mode === 'set') {
      const problems = passwords.check(v.password || '', await passwords.policy(), { email: v.email, name: v.full_name });
      if (problems.length) errors.password = problems.join(' ');
    }
  }
  if (Object.keys(errors).length) {
    req.setFormState(req.body, errors);
    req.flash('danger', 'Please correct the highlighted fields.');
    return res.redirect('/admin/users/new');
  }
  const user = await users.createUser({
    email: v.email,
    password: v.password_mode === 'set' ? v.password : null,
    fullName: v.full_name,
    roles: v.roles,
    emailVerified: v.email_verified,
    createdBy: req.user.id,
  });
  if (v.password_mode === 'invite') {
    const token = await tokens.createPasswordReset(user, req.ip, { minutes: tokens.ACCOUNT_SETUP_MINUTES });
    await mail.queue({
      to: user.email,
      template: 'account_created',
      vars: { name: user.full_name, set_password_url: `${getEnv().APP_URL}/reset-password/${token}`, expires_minutes: tokens.ACCOUNT_SETUP_MINUTES, created_by: req.user.full_name },
    });
  }
  await audit.record(req, 'user.create', { entityType: 'user', entityId: user.id, after: { email: user.email, full_name: user.full_name, roles: v.roles } });
  req.flash('success', v.password_mode === 'invite' ? `${user.full_name} was added and emailed a link to set a password.` : `${user.full_name} was added.`);
  return res.redirect(`/admin/users/${user.id}`);
}

async function show(req, res) {
  const target = await loadTarget(req);
  const allRoles = await rolesWithPermissions();
  const assignable = allRoles.filter((r) => canAssignRole(req.user, r));
  let canManage = true;
  try {
    await assertCanManage(req.user, target);
  } catch {
    canManage = false;
  }
  const isAuthor = target.roles.some((r) => r.slug === 'question_author');
  const authorCategories = isAuthor ? await db()('author_categories').where({ user_id: target.id }).pluck('category_id') : [];
  const categoryTree = isAuthor ? await require('../../services/catalogue').categoryTree() : [];
  const [accommodations, history, auditRows] = await Promise.all([
    db()('user_accommodations').where({ user_id: target.id }).first(),
    db()('login_history').where({ user_id: target.id }).orderBy('created_at', 'desc').limit(10),
    req.user.can('audit.view') ? db()('audit_logs').where({ entity_type: 'user', entity_id: String(target.id) }).orderBy('created_at', 'desc').limit(10) : [],
  ]);
  res.render('admin/users/show', {
    title: target.full_name,
    layout: 'layouts/app',
    target,
    allRoles,
    assignable,
    canManage,
    accommodations: accommodations || { extra_time_percent: 0, large_font: false, high_contrast: false, notes: '' },
    history,
    auditRows,
    timezones: TIMEZONES,
    isAuthor,
    authorCategories,
    categoryTree,
    breadcrumbs: [{ label: 'Admin', href: '/admin' }, { label: 'Users', href: '/admin/users' }, { label: target.full_name }],
  });
}

const updateSchema = z.object({
  full_name: trimmed(150, 2),
  email,
  status: z.enum(['active', 'suspended']),
  roles: z.union([z.string(), z.array(z.string())]).optional().transform((v) => (v === undefined ? [] : Array.isArray(v) ? v : [v])),
});

async function update(req, res) {
  const target = await loadTarget(req);
  const allRoles = await assertCanManage(req.user, target);
  const back = `/admin/users/${target.id}`;
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    req.setFormState(req.body, fieldErrors(parsed.error));
    req.flash('danger', 'Please correct the highlighted fields.');
    return res.redirect(back);
  }
  const v = parsed.data;
  const errors = {};
  const other = await users.findByEmail(v.email);
  if (other && other.id !== target.id) errors.email = 'Another user already uses this email.';
  if (!v.roles.length) errors.roles = 'Choose at least one role.';

  const currentSlugs = target.roles.map((r) => r.slug);
  const added = v.roles.filter((s) => !currentSlugs.includes(s));
  const removed = currentSlugs.filter((s) => !v.roles.includes(s));
  for (const slug of [...added, ...removed]) {
    const role = allRoles.find((r) => r.slug === slug);
    if (!role || !canAssignRole(req.user, role)) errors.roles = `You cannot assign or remove the "${role ? role.name : slug}" role.`;
  }
  const losingSuper = currentSlugs.includes('super_admin') && (removed.includes('super_admin') || v.status !== 'active');
  if (losingSuper && (await activeSuperAdminCount()) <= 1) errors.roles = 'This is the last active Super Admin. Make someone else a Super Admin first.';
  if (target.id === req.user.id && v.status !== 'active') errors.status = 'You cannot suspend your own account.';
  if (Object.keys(errors).length) {
    req.setFormState(req.body, errors);
    req.flash('danger', 'The user was not saved.');
    return res.redirect(back);
  }

  const before = { full_name: target.full_name, email: target.email, status: target.status, roles: currentSlugs };
  await db().transaction(async (trx) => {
    const patch = { full_name: v.full_name, email: v.email, status: v.status };
    if (v.status !== target.status || removed.length) patch.auth_version = trx.raw('auth_version + 1');
    if (v.email !== target.email) patch.email_verified_at = null;
    await trx('users').where({ id: target.id }).update(patch);
    const ids = allRoles.filter((r) => v.roles.includes(r.slug)).map((r) => r.id);
    await trx('user_roles').where({ user_id: target.id }).del();
    await trx('user_roles').insert(ids.map((role_id) => ({ user_id: target.id, role_id })));
  });
  await audit.record(req, 'user.update', { entityType: 'user', entityId: target.id, before, after: { full_name: v.full_name, email: v.email, status: v.status, roles: v.roles } });
  req.flash('success', 'User saved.');
  return res.redirect(back);
}

const accommodationsSchema = z.object({
  extra_time: z.enum(['0', '25', '50', 'custom']),
  extra_time_custom: z.coerce.number().int().min(1).max(300).optional().or(z.literal('').transform(() => undefined)),
  large_font: checkbox,
  high_contrast: checkbox,
  notes: z.string().trim().max(500).optional(),
});

async function updateAccommodations(req, res) {
  const target = await loadTarget(req);
  const back = `/admin/users/${target.id}#accommodations`;
  const parsed = accommodationsSchema.safeParse(req.body);
  if (!parsed.success || (parsed.data.extra_time === 'custom' && !parsed.data.extra_time_custom)) {
    req.setFormState(req.body, parsed.success ? { extra_time_custom: 'Enter a percentage between 1 and 300.' } : fieldErrors(parsed.error));
    req.flash('danger', 'Accommodations were not saved.');
    return res.redirect(back);
  }
  const v = parsed.data;
  const extra = v.extra_time === 'custom' ? v.extra_time_custom : Number(v.extra_time);
  const before = await db()('user_accommodations').where({ user_id: target.id }).first();
  const row = { extra_time_percent: extra, large_font: v.large_font, high_contrast: v.high_contrast, notes: v.notes || null, granted_by: req.user.id };
  await db()('user_accommodations').insert({ user_id: target.id, ...row }).onConflict('user_id').merge();
  await audit.record(req, 'user.accommodations', { entityType: 'user', entityId: target.id, before: before || null, after: row });
  req.flash('success', 'Accommodations saved. They apply to every future attempt.');
  return res.redirect(back);
}

async function action(req, res) {
  const target = await loadTarget(req);
  await assertCanManage(req.user, target);
  const back = `/admin/users/${target.id}`;
  const act = req.params.action;
  switch (act) {
    case 'verify-email':
      await db()('users').where({ id: target.id }).update({ email_verified_at: new Date() });
      req.flash('success', 'Email marked as verified.');
      break;
    case 'send-reset': {
      const token = await tokens.createPasswordReset(target, req.ip);
      await mail.queue({ to: target.email, template: 'password_reset', vars: { name: target.full_name, reset_url: `${getEnv().APP_URL}/reset-password/${token}`, expires_minutes: tokens.RESET_MINUTES, ip: req.ip } });
      req.flash('success', `A password reset link was emailed to ${target.email}.`);
      break;
    }
    case 'reset-2fa':
      await db()('users').where({ id: target.id }).update({ totp_secret_enc: null, totp_enabled_at: null, totp_recovery_codes: null, totp_last_step: null });
      await users.bumpAuthVersion(target.id);
      req.flash('success', 'Two-factor authentication was reset. The user must set it up again at next sign-in if their role requires it.');
      break;
    case 'delete': {
      if (target.id === req.user.id) {
        req.flash('danger', 'You cannot delete your own account here.');
        return res.redirect(back);
      }
      if (target.roles.some((r) => r.slug === 'super_admin') && (await activeSuperAdminCount()) <= 1) {
        req.flash('danger', 'This is the last active Super Admin and cannot be deleted.');
        return res.redirect(back);
      }
      // Anonymise: keep the row (results, orders and certificates reference it) but remove personal data.
      await db().transaction(async (trx) => {
        await trx('users')
          .where({ id: target.id })
          .update({
            email: `deleted-${target.id}-${Date.now()}@deleted.invalid`,
            full_name: 'Deleted user',
            password_hash: null,
            phone: null,
            country: null,
            organisation_name: null,
            job_title: null,
            years_experience: null,
            photo_path: null,
            google_id: null,
            totp_secret_enc: null,
            totp_enabled_at: null,
            totp_recovery_codes: null,
            status: 'suspended',
            deleted_at: new Date(),
          });
        await trx('user_accommodations').where({ user_id: target.id }).del();
        await trx('login_history').where({ user_id: target.id }).del();
      });
      await audit.record(req, 'user.delete', { entityType: 'user', entityId: target.id, before: { email: target.email, full_name: target.full_name, deletion_requested_at: target.deletion_requested_at } });
      req.flash('success', `${target.full_name}'s account was deleted and personal data anonymised.`);
      return res.redirect('/admin/users');
    }
    default:
      throw notFound();
  }
  await audit.record(req, `user.${act}`, { entityType: 'user', entityId: target.id });
  return res.redirect(back);
}

module.exports = { index, newForm, create, show, update, updateAccommodations, action, rolesWithPermissions, canAssignRole };
