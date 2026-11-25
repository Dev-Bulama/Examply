'use strict';

/** Anti-cheat: live quiz integrity events, per-player flag counts and time away. Idempotent. */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('live_players', 'flags'))) {
    await knex.schema.alterTable('live_players', (t) => {
      t.integer('flags').unsigned().notNullable().defaultTo(0);
      t.integer('away_ms').unsigned().notNullable().defaultTo(0);
    });
  }
  if (!(await knex.schema.hasTable('live_integrity_events'))) {
    await knex.schema.createTable('live_integrity_events', (t) => {
      t.engine('InnoDB');
      t.charset('utf8mb4');
      t.bigIncrements('id');
      t.integer('session_id').unsigned().notNullable().references('id').inTable('live_sessions').onDelete('CASCADE');
      t.integer('player_id').unsigned().notNullable().references('id').inTable('live_players').onDelete('CASCADE');
      t.string('type', 30).notNullable();
      t.json('details').nullable();
      t.datetime('created_at').notNullable().defaultTo(knex.fn.now());
      t.index(['session_id', 'created_at']);
    });
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('live_integrity_events');
  if (await knex.schema.hasColumn('live_players', 'flags')) await knex.schema.alterTable('live_players', (t) => t.dropColumn('flags').dropColumn('away_ms'));
};
