'use strict';

/** Game mode: badges each live-quiz player has earned (JSON list of codes). Idempotent. */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('live_players', 'badges'))) {
    await knex.schema.alterTable('live_players', (t) => {
      t.text('badges').nullable();
    });
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasColumn('live_players', 'badges')) await knex.schema.alterTable('live_players', (t) => t.dropColumn('badges'));
};
