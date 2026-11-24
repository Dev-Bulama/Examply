'use strict';

const { timestamps, createdAt, softDelete, tableDefaults } = require('../src/utils/migration');

const QUESTION_TYPES = [
  'single_choice',
  'multiple_response',
  'true_false',
  'fill_blank',
  'numeric',
  'matching',
  'ordering',
  'hotspot',
  'short_answer',
  'essay',
  'case_study',
];

/** Question bank (versioned), tags, media, reports, imports. */
exports.up = async function up(knex) {
  await knex.schema.createTable('tags', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.string('name', 80).notNullable();
    t.string('slug', 90).notNullable().unique();
    createdAt(knex, t);
  });

  await knex.schema.createTable('imports', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.uuid('uuid').notNullable().unique();
    t.integer('user_id').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    t.string('original_name', 255).notNullable();
    t.string('stored_path', 255).notNullable();
    t.enu('format', ['xlsx', 'csv', 'json', 'aiken', 'gift', 'docx', 'zip']).notNullable();
    t.enu('status', ['uploaded', 'parsing', 'parsed', 'importing', 'completed', 'failed', 'undone']).notNullable().defaultTo('uploaded');
    t.json('options').nullable();
    t.integer('total_rows').unsigned().notNullable().defaultTo(0);
    t.integer('valid_rows').unsigned().notNullable().defaultTo(0);
    t.integer('warning_rows').unsigned().notNullable().defaultTo(0);
    t.integer('error_rows').unsigned().notNullable().defaultTo(0);
    t.integer('imported_count').unsigned().notNullable().defaultTo(0);
    t.integer('skipped_count').unsigned().notNullable().defaultTo(0);
    t.integer('failed_count').unsigned().notNullable().defaultTo(0);
    t.tinyint('progress').unsigned().notNullable().defaultTo(0);
    t.string('error_report_path', 255).nullable();
    t.integer('target_exam_id').unsigned().nullable();
    t.integer('created_exam_id').unsigned().nullable();
    t.datetime('completed_at').nullable();
    t.datetime('undo_expires_at').nullable();
    t.datetime('undone_at').nullable();
    t.text('last_error').nullable();
    timestamps(knex, t);
    t.index(['status', 'created_at']);
  });

  await knex.schema.createTable('questions', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.uuid('uuid').notNullable().unique();
    t.enu('type', QUESTION_TYPES).notNullable();
    t.integer('parent_id').unsigned().nullable().references('id').inTable('questions').onDelete('CASCADE');
    t.integer('category_id').unsigned().nullable().references('id').inTable('categories').onDelete('SET NULL');
    t.integer('certification_id').unsigned().nullable().references('id').inTable('certifications').onDelete('SET NULL');
    t.integer('domain_id').unsigned().nullable().references('id').inTable('certification_domains').onDelete('SET NULL');
    t.string('topic', 150).nullable();
    t.tinyint('difficulty').unsigned().notNullable().defaultTo(3);
    t.enu('bloom_level', ['remember', 'understand', 'apply', 'analyze', 'evaluate', 'create']).nullable();
    t.decimal('default_marks', 6, 2).notNullable().defaultTo(1);
    t.integer('est_time_sec').unsigned().notNullable().defaultTo(60);
    t.enu('status', ['draft', 'in_review', 'published', 'retired']).notNullable().defaultTo('draft');
    t.integer('current_version_id').unsigned().nullable();
    t.integer('version').unsigned().notNullable().defaultTo(1);
    t.integer('display_order').notNullable().defaultTo(0);
    t.text('stem_text').nullable();
    t.string('content_hash', 64).nullable().index();
    t.integer('author_id').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    t.integer('reviewer_id').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    t.datetime('reviewed_at').nullable();
    t.string('review_note', 1000).nullable();
    t.datetime('published_at').nullable();
    t.integer('import_id').unsigned().nullable().references('id').inTable('imports').onDelete('SET NULL');
    softDelete(t);
    timestamps(knex, t);
    t.index(['category_id', 'status', 'difficulty']);
    t.index(['certification_id', 'domain_id', 'status']);
    t.index(['status', 'type']);
    t.index(['import_id']);
  });
  await knex.raw('ALTER TABLE questions ADD FULLTEXT INDEX questions_stem_fulltext (stem_text)');

  await knex.schema.createTable('question_versions', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.integer('question_id').unsigned().notNullable().references('id').inTable('questions').onDelete('CASCADE');
    t.integer('version_no').unsigned().notNullable();
    t.enu('type', QUESTION_TYPES).notNullable();
    t.specificType('stem_html', 'mediumtext').notNullable();
    t.text('stem_text').nullable();
    t.specificType('explanation_html', 'mediumtext').nullable();
    t.string('reference', 500).nullable();
    t.json('settings').nullable();
    t.decimal('marks', 6, 2).notNullable().defaultTo(1);
    t.string('content_hash', 64).nullable();
    t.integer('created_by').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    t.string('change_note', 500).nullable();
    createdAt(knex, t);
    t.unique(['question_id', 'version_no']);
  });

  await knex.schema.alterTable('questions', (t) => {
    t.foreign('current_version_id').references('id').inTable('question_versions').onDelete('SET NULL');
  });

  await knex.schema.createTable('question_options', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.integer('question_version_id').unsigned().notNullable().references('id').inTable('question_versions').onDelete('CASCADE');
    t.string('option_key', 40).notNullable();
    t.text('content_html').notNullable();
    t.text('feedback_html').nullable();
    t.boolean('is_correct').notNullable().defaultTo(false);
    t.boolean('pin_last').notNullable().defaultTo(false);
    t.string('side', 10).nullable(); // matching: 'left' | 'right'
    t.json('region').nullable(); // hotspot region {x,y,w,h} in % of image
    t.integer('display_order').notNullable().defaultTo(0);
    t.unique(['question_version_id', 'option_key']);
  });

  await knex.schema.createTable('question_answers', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.integer('question_version_id').unsigned().notNullable().unique().references('id').inTable('question_versions').onDelete('CASCADE');
    t.json('answer').notNullable();
  });

  await knex.schema.createTable('question_tags', (t) => {
    tableDefaults(t);
    t.integer('question_id').unsigned().notNullable().references('id').inTable('questions').onDelete('CASCADE');
    t.integer('tag_id').unsigned().notNullable().references('id').inTable('tags').onDelete('CASCADE');
    t.primary(['question_id', 'tag_id']);
    t.index(['tag_id']);
  });

  await knex.schema.createTable('question_media', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.uuid('uuid').notNullable().unique();
    t.integer('question_id').unsigned().nullable().references('id').inTable('questions').onDelete('SET NULL');
    t.integer('uploaded_by').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    t.integer('import_id').unsigned().nullable().references('id').inTable('imports').onDelete('SET NULL');
    t.string('path', 255).notNullable();
    t.string('original_name', 255).nullable();
    t.string('mime', 100).notNullable();
    t.integer('size_bytes').unsigned().notNullable();
    t.integer('width').unsigned().nullable();
    t.integer('height').unsigned().nullable();
    t.string('alt', 255).nullable();
    createdAt(knex, t);
  });

  await knex.schema.createTable('import_rows', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.integer('import_id').unsigned().notNullable().references('id').inTable('imports').onDelete('CASCADE');
    t.integer('row_number').unsigned().notNullable();
    t.string('row_ref', 60).notNullable();
    t.enu('status', ['valid', 'warning', 'error']).notNullable();
    t.json('messages').nullable();
    t.json('source').nullable();
    t.json('payload').nullable();
    t.string('content_hash', 64).nullable();
    t.integer('duplicate_of_question_id').unsigned().nullable();
    t.enu('decision', ['import', 'skip', 'overwrite', 'new']).notNullable().defaultTo('import');
    t.enu('result', ['pending', 'imported', 'overwritten', 'skipped', 'failed']).notNullable().defaultTo('pending');
    t.integer('result_question_id').unsigned().nullable();
    t.integer('previous_version_id').unsigned().nullable();
    t.string('previous_status', 20).nullable();
    t.text('result_error').nullable();
    t.index(['import_id', 'row_number']);
    t.index(['import_id', 'status']);
  });

  await knex.schema.createTable('question_reports', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.integer('question_id').unsigned().notNullable().references('id').inTable('questions').onDelete('CASCADE');
    t.integer('question_version_id').unsigned().nullable().references('id').inTable('question_versions').onDelete('SET NULL');
    t.integer('user_id').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    t.bigInteger('attempt_id').unsigned().nullable();
    t.enu('reason', ['wrong_key', 'typo', 'unclear', 'other']).notNullable();
    t.text('message').nullable();
    t.enu('status', ['open', 'resolved', 'dismissed']).notNullable().defaultTo('open');
    t.integer('resolved_by').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    t.text('resolution_note').nullable();
    t.datetime('resolved_at').nullable();
    timestamps(knex, t);
    t.index(['status', 'created_at']);
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('questions', (t) => t.dropForeign('current_version_id'));
  for (const table of [
    'question_reports',
    'import_rows',
    'question_media',
    'question_tags',
    'question_answers',
    'question_options',
    'question_versions',
    'questions',
    'imports',
    'tags',
  ]) {
    await knex.schema.dropTableIfExists(table);
  }
};
