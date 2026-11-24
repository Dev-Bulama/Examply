'use strict';

/**
 * Phase 2 additions:
 * - question_versions.published_at: a version that has ever been live is immutable; editing creates a new version.
 * - question_versions.authoring: the canonical authoring model (JSON) the version was saved from — used to reopen
 *   the editor and for exports, so every type round-trips exactly.
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('question_versions', (t) => {
    t.datetime('published_at').nullable();
    t.json('authoring').nullable();
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('question_versions', (t) => {
    t.dropColumn('published_at');
    t.dropColumn('authoring');
  });
};
