'use strict';

const { timestamps, createdAt, softDelete, tableDefaults } = require('../src/utils/migration');

/** Exams, builder structures, attempts, proctoring, results, certificates. */
exports.up = async function up(knex) {
  await knex.schema.createTable('exams', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.uuid('uuid').notNullable().unique();
    t.string('title', 200).notNullable();
    t.string('slug', 210).notNullable().unique();
    t.enu('type', ['pre_training', 'post_training', 'practice', 'mock', 'past_questions', 'live_quiz', 'assignment']).notNullable();
    t.integer('category_id').unsigned().nullable().references('id').inTable('categories').onDelete('SET NULL');
    t.integer('certification_id').unsigned().nullable().references('id').inTable('certifications').onDelete('SET NULL');
    t.integer('programme_id').unsigned().nullable().references('id').inTable('training_programmes').onDelete('SET NULL');
    t.string('cover_path', 255).nullable();
    t.string('short_description', 300).nullable();
    t.specificType('description_html', 'mediumtext').nullable();
    t.string('language', 10).notNullable().defaultTo('en');
    t.string('difficulty_label', 40).nullable();
    t.enu('visibility', ['public', 'unlisted', 'org_private', 'invite_code']).notNullable().defaultTo('public');
    t.string('invite_code', 40).nullable();
    t.integer('organisation_id').unsigned().nullable().references('id').inTable('organisations').onDelete('SET NULL');
    t.enu('status', ['draft', 'published', 'archived']).notNullable().defaultTo('draft');
    t.enu('content_mode', ['fixed', 'blueprint']).notNullable().defaultTo('fixed');
    // Timing
    t.integer('duration_minutes').unsigned().nullable();
    t.integer('grace_seconds').unsigned().notNullable().defaultTo(0);
    t.integer('per_question_seconds').unsigned().nullable();
    t.datetime('available_from').nullable();
    t.datetime('available_until').nullable();
    t.string('timezone', 64).nullable();
    // Attempts & access
    t.integer('max_attempts').unsigned().nullable();
    t.integer('cooldown_minutes').unsigned().notNullable().defaultTo(0);
    t.enu('score_policy', ['best', 'latest', 'average', 'first']).notNullable().defaultTo('best');
    t.boolean('is_paid').notNullable().defaultTo(false);
    t.integer('price_kobo').unsigned().notNullable().defaultTo(0);
    t.integer('sale_price_kobo').unsigned().nullable();
    t.string('currency', 3).notNullable().defaultTo('NGN');
    t.integer('access_days').unsigned().nullable();
    t.boolean('require_verified_email').notNullable().defaultTo(false);
    t.boolean('require_org').notNullable().defaultTo(false);
    t.integer('prerequisite_exam_id').unsigned().nullable().references('id').inTable('exams').onDelete('SET NULL');
    t.boolean('allow_buy_attempts').notNullable().defaultTo(false);
    t.integer('extra_attempt_price_kobo').unsigned().nullable();
    // Scoring
    t.decimal('pass_mark', 8, 2).nullable();
    t.enu('pass_mark_type', ['percent', 'raw']).notNullable().defaultTo('percent');
    t.decimal('negative_marking', 5, 2).notNullable().defaultTo(0);
    t.boolean('partial_credit').notNullable().defaultTo(false);
    t.enu('result_release', ['full_review', 'score_breakdown', 'score_only', 'after_window', 'manual']).notNullable().defaultTo('full_review');
    // Certificate
    t.boolean('certificate_enabled').notNullable().defaultTo(false);
    t.string('certificate_template', 60).nullable();
    // Everything else (delivery, integrity, scaling, custom instruction notes) lives in settings JSON.
    t.json('settings').nullable();
    t.integer('version').unsigned().notNullable().defaultTo(1);
    t.decimal('rating_avg', 3, 2).nullable();
    t.integer('rating_count').unsigned().notNullable().defaultTo(0);
    t.datetime('published_at').nullable();
    t.integer('created_by').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    t.integer('updated_by').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    softDelete(t);
    timestamps(knex, t);
    t.index(['status', 'visibility', 'type']);
    t.index(['category_id', 'status']);
    t.index(['certification_id', 'status']);
  });

  await knex.schema.alterTable('imports', (t) => {
    t.foreign('target_exam_id').references('id').inTable('exams').onDelete('SET NULL');
    t.foreign('created_exam_id').references('id').inTable('exams').onDelete('SET NULL');
  });

  await knex.schema.createTable('exam_versions', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.integer('exam_id').unsigned().notNullable().references('id').inTable('exams').onDelete('CASCADE');
    t.integer('version_no').unsigned().notNullable();
    t.json('snapshot').notNullable();
    t.string('note', 255).nullable();
    t.integer('created_by').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    createdAt(knex, t);
    t.unique(['exam_id', 'version_no']);
  });

  await knex.schema.createTable('exam_sections', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.integer('exam_id').unsigned().notNullable().references('id').inTable('exams').onDelete('CASCADE');
    t.string('title', 200).notNullable();
    t.text('instructions_html').nullable();
    t.integer('time_limit_minutes').unsigned().nullable();
    t.decimal('min_score_percent', 5, 2).nullable();
    t.integer('display_order').notNullable().defaultTo(0);
    timestamps(knex, t);
    t.index(['exam_id', 'display_order']);
  });

  await knex.schema.createTable('exam_questions', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.integer('exam_id').unsigned().notNullable().references('id').inTable('exams').onDelete('CASCADE');
    t.integer('section_id').unsigned().nullable().references('id').inTable('exam_sections').onDelete('SET NULL');
    t.integer('question_id').unsigned().notNullable().references('id').inTable('questions').onDelete('CASCADE');
    t.decimal('marks', 6, 2).nullable();
    t.integer('display_order').notNullable().defaultTo(0);
    createdAt(knex, t);
    t.unique(['exam_id', 'question_id']);
    t.index(['exam_id', 'section_id', 'display_order']);
  });

  await knex.schema.createTable('exam_blueprint_rules', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.integer('exam_id').unsigned().notNullable().references('id').inTable('exams').onDelete('CASCADE');
    t.integer('section_id').unsigned().nullable().references('id').inTable('exam_sections').onDelete('SET NULL');
    t.integer('question_count').unsigned().notNullable();
    t.integer('category_id').unsigned().nullable().references('id').inTable('categories').onDelete('SET NULL');
    t.integer('certification_id').unsigned().nullable().references('id').inTable('certifications').onDelete('SET NULL');
    t.integer('domain_id').unsigned().nullable().references('id').inTable('certification_domains').onDelete('SET NULL');
    t.integer('tag_id').unsigned().nullable().references('id').inTable('tags').onDelete('SET NULL');
    t.tinyint('difficulty_min').unsigned().nullable();
    t.tinyint('difficulty_max').unsigned().nullable();
    t.json('question_types').nullable();
    t.decimal('marks', 6, 2).nullable();
    t.integer('display_order').notNullable().defaultTo(0);
    timestamps(knex, t);
  });

  await knex.schema.createTable('exam_bands', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.integer('exam_id').unsigned().notNullable().references('id').inTable('exams').onDelete('CASCADE');
    t.string('name', 60).notNullable();
    t.decimal('min_percent', 5, 2).notNullable();
    t.decimal('max_percent', 5, 2).notNullable();
    t.integer('programme_id').unsigned().nullable().references('id').inTable('training_programmes').onDelete('SET NULL');
    t.string('course_url', 500).nullable();
    t.text('message').nullable();
    t.integer('display_order').notNullable().defaultTo(0);
    timestamps(knex, t);
  });

  await knex.schema.createTable('exam_access_rules', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.integer('exam_id').unsigned().notNullable().references('id').inTable('exams').onDelete('CASCADE');
    t.enu('rule_type', ['ip_allow', 'organisation', 'cohort']).notNullable();
    t.string('value', 191).notNullable();
    createdAt(knex, t);
    t.index(['exam_id', 'rule_type']);
  });

  await knex.schema.createTable('exam_attempt_overrides', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.integer('exam_id').unsigned().notNullable().references('id').inTable('exams').onDelete('CASCADE');
    t.integer('user_id').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.integer('extra_attempts').notNullable();
    t.boolean('reset_cooldown').notNullable().defaultTo(false);
    t.string('reason', 500).notNullable();
    t.enu('source', ['admin', 'purchase']).notNullable().defaultTo('admin');
    t.integer('order_id').unsigned().nullable();
    t.integer('granted_by').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    createdAt(knex, t);
    t.index(['exam_id', 'user_id']);
  });

  await knex.schema.createTable('exam_instruction_cache', (t) => {
    tableDefaults(t);
    t.integer('exam_id').unsigned().primary().references('id').inTable('exams').onDelete('CASCADE');
    t.string('settings_hash', 64).notNullable();
    t.json('content').notNullable();
    t.datetime('generated_at').notNullable();
  });

  await knex.schema.createTable('cohort_assignments', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.integer('cohort_id').unsigned().notNullable().references('id').inTable('cohorts').onDelete('CASCADE');
    t.integer('exam_id').unsigned().notNullable().references('id').inTable('exams').onDelete('CASCADE');
    t.enu('kind', ['pre', 'post', 'general']).notNullable().defaultTo('general');
    t.datetime('due_at').nullable();
    t.datetime('reminder_sent_at').nullable();
    t.integer('created_by').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    timestamps(knex, t);
    t.unique(['cohort_id', 'exam_id', 'kind']);
  });

  await knex.schema.createTable('assignments', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.integer('exam_id').unsigned().notNullable().references('id').inTable('exams').onDelete('CASCADE');
    t.string('title', 200).notNullable();
    t.string('code', 12).notNullable().unique();
    t.integer('cohort_id').unsigned().nullable().references('id').inTable('cohorts').onDelete('SET NULL');
    t.integer('live_session_id').unsigned().nullable();
    t.datetime('due_at').nullable();
    t.integer('created_by').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    timestamps(knex, t);
  });

  await knex.schema.createTable('attempts', (t) => {
    tableDefaults(t);
    t.bigIncrements('id');
    t.uuid('uuid').notNullable().unique();
    t.integer('exam_id').unsigned().notNullable().references('id').inTable('exams').onDelete('CASCADE');
    t.integer('user_id').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.integer('attempt_no').unsigned().notNullable();
    t.enu('mode', ['exam', 'practice', 'study', 'mock', 'homework']).notNullable().defaultTo('exam');
    t.integer('pack_id').unsigned().nullable();
    t.integer('assignment_id').unsigned().nullable().references('id').inTable('assignments').onDelete('SET NULL');
    t.enu('status', ['in_progress', 'submitted', 'expired', 'graded', 'pending_manual']).notNullable().defaultTo('in_progress');
    t.datetime('started_at').notNullable();
    t.datetime('expires_at').nullable();
    t.datetime('submitted_at').nullable();
    t.datetime('graded_at').nullable();
    t.enu('submit_reason', ['candidate', 'timeout', 'sweeper', 'integrity', 'admin']).nullable();
    t.smallint('extra_time_percent').unsigned().notNullable().defaultTo(0);
    t.integer('exam_version').unsigned().notNullable().defaultTo(1);
    t.string('ip', 45).nullable();
    t.string('user_agent', 255).nullable();
    t.string('session_token_hash', 64).nullable();
    t.datetime('instructions_accepted_at').nullable();
    t.smallint('integrity_score').unsigned().notNullable().defaultTo(100);
    t.smallint('tab_switches').unsigned().notNullable().defaultTo(0);
    t.smallint('fullscreen_exits').unsigned().notNullable().defaultTo(0);
    t.decimal('raw_score', 10, 2).nullable();
    t.decimal('max_score', 10, 2).nullable();
    t.decimal('percent', 6, 2).nullable();
    t.decimal('scaled_score', 8, 2).nullable();
    t.boolean('passed').nullable();
    t.string('band', 60).nullable();
    t.json('state').nullable();
    timestamps(knex, t);
    t.index(['user_id', 'exam_id']);
    t.index(['exam_id', 'status']);
    t.index(['status', 'expires_at']);
  });

  await knex.schema.createTable('attempt_items', (t) => {
    tableDefaults(t);
    t.bigIncrements('id');
    t.bigInteger('attempt_id').unsigned().notNullable().references('id').inTable('attempts').onDelete('CASCADE');
    t.bigInteger('parent_item_id').unsigned().nullable();
    t.integer('question_id').unsigned().notNullable().references('id').inTable('questions').onDelete('CASCADE');
    t.integer('question_version_id').unsigned().notNullable().references('id').inTable('question_versions').onDelete('RESTRICT');
    t.integer('section_id').unsigned().nullable().references('id').inTable('exam_sections').onDelete('SET NULL');
    t.integer('display_order').notNullable();
    t.json('option_order').nullable();
    t.decimal('marks_possible', 6, 2).notNullable();
    t.json('response').nullable();
    t.decimal('marks_awarded', 6, 2).nullable();
    t.boolean('is_correct').nullable();
    t.enu('grading_status', ['ungraded', 'auto', 'pending_manual', 'manual']).notNullable().defaultTo('ungraded');
    t.integer('grader_id').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    t.text('grader_feedback').nullable();
    t.datetime('graded_at').nullable();
    t.integer('time_spent_sec').unsigned().notNullable().defaultTo(0);
    t.boolean('flagged').notNullable().defaultTo(false);
    t.boolean('checked').notNullable().defaultTo(false);
    t.datetime('answered_at').nullable();
    t.index(['attempt_id', 'display_order']);
    t.index(['question_id']);
  });

  await knex.schema.createTable('attempt_events', (t) => {
    tableDefaults(t);
    t.bigIncrements('id');
    t.bigInteger('attempt_id').unsigned().notNullable().references('id').inTable('attempts').onDelete('CASCADE');
    t.string('type', 40).notNullable();
    t.json('details').nullable();
    t.string('ip', 45).nullable();
    createdAt(knex, t);
    t.index(['attempt_id', 'created_at']);
  });

  await knex.schema.createTable('attempt_snapshots', (t) => {
    tableDefaults(t);
    t.bigIncrements('id');
    t.bigInteger('attempt_id').unsigned().notNullable().references('id').inTable('attempts').onDelete('CASCADE');
    t.string('path', 255).notNullable();
    t.datetime('captured_at').notNullable();
    t.index(['attempt_id']);
  });

  await knex.schema.createTable('results', (t) => {
    tableDefaults(t);
    t.bigIncrements('id');
    t.bigInteger('attempt_id').unsigned().notNullable().unique().references('id').inTable('attempts').onDelete('CASCADE');
    t.integer('user_id').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.integer('exam_id').unsigned().notNullable().references('id').inTable('exams').onDelete('CASCADE');
    t.decimal('raw_score', 10, 2).notNullable();
    t.decimal('max_score', 10, 2).notNullable();
    t.decimal('percent', 6, 2).notNullable();
    t.decimal('scaled_score', 8, 2).nullable();
    t.boolean('passed').nullable();
    t.string('band', 60).nullable();
    t.decimal('percentile', 5, 2).nullable();
    t.boolean('has_pending_manual').notNullable().defaultTo(false);
    t.json('breakdown').notNullable();
    t.enu('release_status', ['released', 'withheld']).notNullable().defaultTo('released');
    t.datetime('released_at').nullable();
    t.integer('regrade_count').unsigned().notNullable().defaultTo(0);
    timestamps(knex, t);
    t.index(['exam_id', 'percent']);
    t.index(['user_id', 'created_at']);
  });

  await knex.schema.createTable('certificates', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.string('code', 24).notNullable().unique();
    t.integer('user_id').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.integer('exam_id').unsigned().notNullable().references('id').inTable('exams').onDelete('CASCADE');
    t.bigInteger('attempt_id').unsigned().notNullable().unique().references('id').inTable('attempts').onDelete('CASCADE');
    t.string('holder_name', 150).notNullable();
    t.string('exam_title', 200).notNullable();
    t.decimal('percent', 6, 2).notNullable();
    t.string('band', 60).nullable();
    t.string('template', 60).nullable();
    t.string('pdf_path', 255).nullable();
    t.datetime('issued_at').notNullable();
    t.datetime('revoked_at').nullable();
    t.string('revoke_reason', 255).nullable();
    timestamps(knex, t);
    t.index(['user_id']);
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('imports', (t) => {
    t.dropForeign('target_exam_id');
    t.dropForeign('created_exam_id');
  });
  for (const table of [
    'certificates',
    'results',
    'attempt_snapshots',
    'attempt_events',
    'attempt_items',
    'attempts',
    'assignments',
    'cohort_assignments',
    'exam_instruction_cache',
    'exam_attempt_overrides',
    'exam_access_rules',
    'exam_bands',
    'exam_blueprint_rules',
    'exam_questions',
    'exam_sections',
    'exam_versions',
    'exams',
  ]) {
    await knex.schema.dropTableIfExists(table);
  }
};
