'use strict';

const { db } = require('../../config/db');
const audit = require('../../services/audit');
const { PERMISSIONS } = require('../../config/permissions');
const { slugify } = require('../../utils/slug');
const { notFound } = require('../../utils/errors');
const { fieldErrors } = require('../../middleware/validate');
const { z, trimmed, optionalTrimmed } = require('../../validators/common');

function groupedPermissions() {
  const groups = new Map();
  for (const [key, group, description] of PERMISSIONS) {
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push({ key, description });
  }
  return [...groups.entries()].map(([name, items]) => ({ name, items }));
}

async function index(req, res) {
  const roles = await db()('roles as r')
    .leftJoin('user_roles as ur', 'ur.role_id', 'r.id')
    .leftJoin('users as u', function joinUsers() {
      this.on('u.id', 'ur.user_id').andOnNull('u.deleted_at');
    })
    .groupBy('r.id')
    .orderBy('r.is_system', 'desc')
    .orderBy('r.name')
    .select('r.*', db().raw('COUNT(u.id) as user_count'));
  const permCounts = await db()('role_permissions').groupBy('role_id').select('role_id', db().raw('COUNT(*) as n'));
  for (const r of roles) r.permission_count = r.slug === 'super_admin' ? PERMISSIONS.length : Number((permCounts.find((p) => p.role_id === r.id) || {}).n || 0);
  res.render('admin/roles/index', { title: 'Roles & permissions', layout: 'layouts/app', roles, breadcrumbs: [{ label: 'Admin', href: '/admin' }, { label: 'Roles' }] });
}

async function form(req, res) {
  let role = { id: null, name: '', description: '', slug: '', is_system: false };
  let granted = [];
  if (req.params.id) {
    role = await db()('roles').where({ id: req.params.id }).first();
    if (!role) throw notFound('That role does not exist.');
    granted = await db()('role_permissions as rp').join('permissions as p', 'p.id', 'rp.permission_id').where('rp.role_id', role.id).pluck('p.key');
  }
  res.render('admin/roles/form', {
    title: role.id ? `Edit role: ${role.name}` : 'New role',
    layout: 'layouts/app',
    role,
    granted: res.locals.old.permissions ? [].concat(res.locals.old.permissions) : granted,
    groups: groupedPermissions(),
    locked: role.slug === 'super_admin',
    breadcrumbs: [{ label: 'Admin', href: '/admin' }, { label: 'Roles', href: '/admin/roles' }, { label: role.id ? role.name : 'New role' }],
  });
}

const schema = z.object({
  name: trimmed(100, 2),
  description: optionalTrimmed(255),
  permissions: z.union([z.string(), z.array(z.string())]).optional().transform((v) => (v === undefined ? [] : Array.isArray(v) ? v : [v])),
});

async function save(req, res) {
  const editing = req.params.id ? await db()('roles').where({ id: req.params.id }).first() : null;
  if (req.params.id && !editing) throw notFound('That role does not exist.');
  if (editing && editing.slug === 'super_admin') {
    req.flash('danger', 'The Super Admin role always has every permission and cannot be edited.');
    return res.redirect('/admin/roles');
  }
  const back = editing ? `/admin/roles/${editing.id}/edit` : '/admin/roles/new';
  const parsed = schema.safeParse(req.body);
  const errors = parsed.success ? {} : fieldErrors(parsed.error);
  const v = parsed.success ? parsed.data : null;
  const validKeys = new Set(PERMISSIONS.map(([k]) => k));
  if (v && v.permissions.some((k) => !validKeys.has(k))) errors.permissions = 'Unknown permission selected.';
  if (v && !editing) {
    const slug = slugify(v.name).replace(/-/g, '_');
    if (!slug) errors.name = 'Use letters or numbers in the name.';
    else if (await db()('roles').where({ slug }).first()) errors.name = 'A role with this name already exists.';
  }
  if (Object.keys(errors).length) {
    req.setFormState(req.body, errors);
    req.flash('danger', 'Please correct the highlighted fields.');
    return res.redirect(back);
  }
  const permIds = v.permissions.length ? await db()('permissions').whereIn('key', v.permissions).pluck('id') : [];
  let roleId;
  let before = null;
  await db().transaction(async (trx) => {
    if (editing) {
      roleId = editing.id;
      before = {
        name: editing.name,
        description: editing.description,
        permissions: await trx('role_permissions as rp').join('permissions as p', 'p.id', 'rp.permission_id').where('rp.role_id', roleId).pluck('p.key'),
      };
      await trx('roles').where({ id: roleId }).update({ name: v.name, description: v.description });
      await trx('role_permissions').where({ role_id: roleId }).del();
    } else {
      [roleId] = await trx('roles').insert({ name: v.name, slug: slugify(v.name).replace(/-/g, '_'), description: v.description, is_system: false });
    }
    if (permIds.length) await trx('role_permissions').insert(permIds.map((permission_id) => ({ role_id: roleId, permission_id })));
  });
  await audit.record(req, editing ? 'role.update' : 'role.create', { entityType: 'role', entityId: roleId, before, after: { name: v.name, description: v.description, permissions: v.permissions } });
  req.flash('success', `Role “${v.name}” saved.`);
  return res.redirect('/admin/roles');
}

async function destroy(req, res) {
  const role = await db()('roles').where({ id: req.params.id }).first();
  if (!role) throw notFound('That role does not exist.');
  if (role.is_system) {
    req.flash('danger', 'Built-in roles cannot be deleted.');
    return res.redirect('/admin/roles');
  }
  const inUse = await db()('user_roles').where({ role_id: role.id }).first();
  if (inUse) {
    req.flash('danger', 'Remove this role from every user before deleting it.');
    return res.redirect('/admin/roles');
  }
  await db()('roles').where({ id: role.id }).del();
  await audit.record(req, 'role.delete', { entityType: 'role', entityId: role.id, before: { name: role.name } });
  req.flash('success', `Role “${role.name}” deleted.`);
  return res.redirect('/admin/roles');
}

module.exports = { index, form, save, destroy, groupedPermissions };
