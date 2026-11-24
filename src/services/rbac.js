'use strict';

const { db } = require('../config/db');
const { PERMISSIONS, ROLES, ALL_KEYS, TWO_FACTOR_REQUIRED_ROLES } = require('../config/permissions');

/** Returns { roles: [{id, slug, name}], permissions: Set<string> } for a user. */
async function loadUserAccess(userId, knex = db()) {
  const roles = await knex('user_roles as ur')
    .join('roles as r', 'r.id', 'ur.role_id')
    .where('ur.user_id', userId)
    .select('r.id', 'r.slug', 'r.name');
  let permissions;
  if (roles.some((r) => r.slug === 'super_admin')) {
    permissions = new Set(ALL_KEYS);
  } else if (roles.length) {
    const rows = await knex('role_permissions as rp')
      .join('permissions as p', 'p.id', 'rp.permission_id')
      .whereIn(
        'rp.role_id',
        roles.map((r) => r.id),
      )
      .distinct('p.key');
    permissions = new Set(rows.map((r) => r.key));
  } else {
    permissions = new Set();
  }
  return { roles, permissions };
}

function requires2fa(roleSlugs) {
  return roleSlugs.some((slug) => TWO_FACTOR_REQUIRED_ROLES.includes(slug));
}

/**
 * Idempotent sync of the permission catalogue and system roles.
 * - Inserts missing permissions and updates descriptions.
 * - Creates missing system roles with their default permissions.
 * - Grants newly-created permissions to system roles that include them by default.
 * Never revokes grants an administrator has made.
 */
async function syncPermissions(knex = db()) {
  const existing = new Map((await knex('permissions').select('id', 'key')).map((p) => [p.key, p.id]));
  const created = new Set();
  for (const [key, group, description] of PERMISSIONS) {
    if (existing.has(key)) {
      await knex('permissions').where({ key }).update({ group, description });
    } else {
      // Two processes booting at once (e.g. parallel workers) may both try to insert: ignore the loser's insert.
      const [id] = await knex('permissions').insert({ key, group, description }).onConflict('key').ignore();
      if (id) created.add(key);
      existing.set(key, id || (await knex('permissions').where({ key }).first('id')).id);
    }
  }
  for (const role of ROLES) {
    let row = await knex('roles').where({ slug: role.slug }).first();
    let grant;
    if (!row) {
      const [id] = await knex('roles').insert({ slug: role.slug, name: role.name, description: role.description, is_system: true }).onConflict('slug').ignore();
      row = { id: id || (await knex('roles').where({ slug: role.slug }).first('id')).id };
      grant = role.permissions;
    } else {
      grant = role.permissions.filter((k) => created.has(k));
    }
    if (grant.length) {
      const rows = grant.map((k) => ({ role_id: row.id, permission_id: existing.get(k) }));
      await knex('role_permissions').insert(rows).onConflict(['role_id', 'permission_id']).ignore();
    }
  }
  return { created: [...created] };
}

async function assignRole(userId, roleSlug, knex = db()) {
  const role = await knex('roles').where({ slug: roleSlug }).first('id');
  if (!role) throw new Error(`Role not found: ${roleSlug}`);
  await knex('user_roles').insert({ user_id: userId, role_id: role.id }).onConflict(['user_id', 'role_id']).ignore();
}

module.exports = { loadUserAccess, requires2fa, syncPermissions, assignRole };
