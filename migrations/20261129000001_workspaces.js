'use strict';

/**
 * Phase 7 — company workspaces:
 *  - organisation_users.role gains "author" (staff who write questions and exams; counts as a staff seat);
 *  - organisations: brand colour for certificates and the workspace;
 *  - organisation_invitations: role to grant on acceptance;
 *  - cohort_members: when they joined (for reports).
 */
exports.up = async function up(knex) {
  await knex.raw("ALTER TABLE organisation_users MODIFY role ENUM('manager','author','member') NOT NULL DEFAULT 'member'");
  // Idempotent: MySQL DDL is not transactional, so a re-run after a partial failure must not trip over itself.
  if (!(await knex.schema.hasColumn('organisations', 'primary_color'))) {
    await knex.schema.alterTable('organisations', (t) => t.string('primary_color', 7).nullable());
  }
  if (!(await knex.schema.hasColumn('organisation_invitations', 'role'))) {
    await knex.schema.alterTable('organisation_invitations', (t) => t.enu('role', ['manager', 'author', 'member']).notNullable().defaultTo('member'));
  }
  const [idx] = await knex.raw("SHOW INDEX FROM organisation_invitations WHERE Key_name = 'organisation_invitations_organisation_id_email_index'");
  if (!idx.length) await knex.schema.alterTable('organisation_invitations', (t) => t.index(['organisation_id', 'email']));
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('organisation_invitations', (t) => {
    t.dropIndex(['organisation_id', 'email']);
    t.dropColumn('role');
  });
  await knex.schema.alterTable('organisations', (t) => t.dropColumn('primary_color'));
  await knex('organisation_users').where('role', 'author').update({ role: 'member' });
  await knex.raw("ALTER TABLE organisation_users MODIFY role ENUM('manager','member') NOT NULL DEFAULT 'member'");
};
