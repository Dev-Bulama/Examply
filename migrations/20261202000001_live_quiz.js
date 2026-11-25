'use strict';

/** Live quiz: per-player question clock (player-paced / homework mode). Idempotent. */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('live_players', 'question_started_at'))) {
    await knex.schema.alterTable('live_players', (t) => {
      t.datetime('question_started_at').nullable();
    });
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasColumn('live_players', 'question_started_at')) await knex.schema.alterTable('live_players', (t) => t.dropColumn('question_started_at'));
};
