'use strict';

/**
 * Phase 4:
 *  - 'sql' question type (SQL lab).
 *  - Exams: the AI generation that produced them, a draft autosave stamp.
 *  - ai_generations: kind ('questions' | 'exam') and the exam created.
 */
const OLD = ['single_choice', 'multiple_response', 'true_false', 'fill_blank', 'numeric', 'matching', 'ordering', 'hotspot', 'short_answer', 'essay', 'case_study'];
const NEW = [...OLD, 'sql'];
const enumSql = (list) => list.map((v) => `'${v}'`).join(',');

exports.up = async function up(knex) {
  await knex.raw(`ALTER TABLE questions MODIFY type ENUM(${enumSql(NEW)}) NOT NULL`);
  await knex.raw(`ALTER TABLE question_versions MODIFY type ENUM(${enumSql(NEW)}) NOT NULL`);
  await knex.schema.alterTable('ai_generations', (t) => {
    t.enu('kind', ['questions', 'exam']).notNullable().defaultTo('questions');
    t.integer('exam_id').unsigned().nullable().references('id').inTable('exams').onDelete('SET NULL');
  });
  await knex.schema.alterTable('exams', (t) => {
    t.integer('ai_generation_id').unsigned().nullable();
    t.index(['organisation_id', 'status']);
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('exams', (t) => {
    t.dropIndex(['organisation_id', 'status']);
    t.dropColumn('ai_generation_id');
  });
  await knex.schema.alterTable('ai_generations', (t) => {
    t.dropForeign('exam_id');
    t.dropColumn('exam_id');
    t.dropColumn('kind');
  });
  await knex('questions').where('type', 'sql').del();
  await knex.raw(`ALTER TABLE question_versions MODIFY type ENUM(${enumSql(OLD)}) NOT NULL`);
  await knex.raw(`ALTER TABLE questions MODIFY type ENUM(${enumSql(OLD)}) NOT NULL`);
};
