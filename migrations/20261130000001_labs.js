'use strict';

/**
 * Phase 5A — cyber security labs:
 *  - 'lab' question type;
 *  - lab_sessions: the simulated machine of one candidate for one lab item (or a staff preview).
 */
const BEFORE = ['single_choice', 'multiple_response', 'true_false', 'fill_blank', 'numeric', 'matching', 'ordering', 'hotspot', 'short_answer', 'essay', 'case_study', 'sql'];
const AFTER = [...BEFORE, 'lab'];
const list = (l) => l.map((v) => `'${v}'`).join(',');

exports.up = async function up(knex) {
  await knex.raw(`ALTER TABLE questions MODIFY type ENUM(${list(AFTER)}) NOT NULL`);
  await knex.raw(`ALTER TABLE question_versions MODIFY type ENUM(${list(AFTER)}) NOT NULL`);
  if (!(await knex.schema.hasTable('lab_sessions'))) {
    await knex.schema.createTable('lab_sessions', (t) => {
      t.engine('InnoDB');
      t.charset('utf8mb4');
      t.collate('utf8mb4_unicode_ci');
      t.bigIncrements('id');
      t.string('owner_key', 80).notNullable().unique(); // "item:<attempt_item_id>" or "preview:<user>:<version>"
      t.bigInteger('attempt_item_id').unsigned().nullable().references('id').inTable('attempt_items').onDelete('CASCADE');
      t.integer('question_version_id').unsigned().notNullable().references('id').inTable('question_versions').onDelete('CASCADE');
      t.integer('user_id').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE');
      t.specificType('state', 'mediumtext').notNullable();
      t.text('transcript').nullable();
      t.integer('commands').unsigned().notNullable().defaultTo(0);
      t.datetime('created_at').notNullable().defaultTo(knex.fn.now());
      t.datetime('updated_at').notNullable().defaultTo(knex.fn.now());
    });
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('lab_sessions');
  await knex('questions').where('type', 'lab').del();
  await knex.raw(`ALTER TABLE question_versions MODIFY type ENUM(${list(BEFORE)}) NOT NULL`);
  await knex.raw(`ALTER TABLE questions MODIFY type ENUM(${list(BEFORE)}) NOT NULL`);
};
