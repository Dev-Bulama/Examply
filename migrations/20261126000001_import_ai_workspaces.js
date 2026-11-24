'use strict';

const { createdAt, tableDefaults } = require('../src/utils/migration');

/**
 * Phase 3:
 *  - organisation_id on questions / categories / imports so company workspaces own their content.
 *  - imports.source: file upload or AI generation (AI batches reuse the import preview).
 *  - ai_generations: prompt, provider, model, token usage, cost estimate per generation run.
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('questions', (t) => {
    t.integer('organisation_id').unsigned().nullable().references('id').inTable('organisations').onDelete('CASCADE');
    t.index(['organisation_id', 'status']);
  });
  await knex.schema.alterTable('categories', (t) => {
    t.integer('organisation_id').unsigned().nullable().references('id').inTable('organisations').onDelete('CASCADE');
  });
  await knex.schema.alterTable('imports', (t) => {
    t.integer('organisation_id').unsigned().nullable().references('id').inTable('organisations').onDelete('CASCADE');
    t.enu('source', ['file', 'ai']).notNullable().defaultTo('file');
    t.integer('parse_progress').unsigned().notNullable().defaultTo(0);
  });
  await knex.raw("ALTER TABLE imports MODIFY format ENUM('xlsx','csv','json','aiken','gift','docx','zip','ai') NOT NULL");

  await knex.schema.createTable('ai_generations', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.integer('import_id').unsigned().nullable().references('id').inTable('imports').onDelete('SET NULL');
    t.integer('organisation_id').unsigned().nullable().references('id').inTable('organisations').onDelete('CASCADE');
    t.integer('user_id').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    t.enu('provider', ['openai', 'anthropic']).notNullable();
    t.string('model', 80).notNullable();
    t.text('prompt').notNullable();
    t.json('blueprint').nullable();
    t.enu('status', ['queued', 'running', 'completed', 'failed']).notNullable().defaultTo('queued');
    t.integer('requested_count').unsigned().notNullable();
    t.integer('generated_count').unsigned().notNullable().defaultTo(0);
    t.integer('input_tokens').unsigned().notNullable().defaultTo(0);
    t.integer('output_tokens').unsigned().notNullable().defaultTo(0);
    t.text('last_error').nullable();
    createdAt(knex, t);
    t.datetime('completed_at').nullable();
    t.index(['organisation_id', 'created_at']);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('ai_generations');
  await knex.raw("ALTER TABLE imports MODIFY format ENUM('xlsx','csv','json','aiken','gift','docx','zip') NOT NULL");
  await knex.schema.alterTable('imports', (t) => {
    t.dropForeign('organisation_id');
    t.dropColumn('organisation_id');
    t.dropColumn('source');
    t.dropColumn('parse_progress');
  });
  await knex.schema.alterTable('categories', (t) => {
    t.dropForeign('organisation_id');
    t.dropColumn('organisation_id');
  });
  await knex.schema.alterTable('questions', (t) => {
    t.dropForeign('organisation_id');
    t.dropIndex(['organisation_id', 'status']);
    t.dropColumn('organisation_id');
  });
};
