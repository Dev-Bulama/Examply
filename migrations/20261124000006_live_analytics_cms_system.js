'use strict';

const { timestamps, createdAt, tableDefaults } = require('../src/utils/migration');

/** Live quiz, item/exam statistics, notifications, CMS, support, settings, audit log, job queue. */
exports.up = async function up(knex) {
  await knex.schema.createTable('live_sessions', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.string('pin', 6).notNullable();
    t.integer('exam_id').unsigned().notNullable().references('id').inTable('exams').onDelete('CASCADE');
    t.integer('host_id').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.enu('mode', ['host_paced', 'player_paced']).notNullable().defaultTo('host_paced');
    t.enu('status', ['lobby', 'running', 'paused', 'finished', 'cancelled']).notNullable().defaultTo('lobby');
    t.boolean('allow_guests').notNullable().defaultTo(false);
    t.json('settings').nullable();
    t.json('question_ids').nullable();
    t.integer('current_index').notNullable().defaultTo(-1);
    t.enu('phase', ['lobby', 'question', 'reveal', 'leaderboard', 'podium']).notNullable().defaultTo('lobby');
    t.datetime('question_started_at').nullable();
    t.datetime('started_at').nullable();
    t.datetime('ended_at').nullable();
    timestamps(knex, t);
    t.index(['pin', 'status']);
    t.index(['host_id', 'created_at']);
  });

  await knex.schema.alterTable('assignments', (t) => {
    t.foreign('live_session_id').references('id').inTable('live_sessions').onDelete('SET NULL');
  });

  await knex.schema.createTable('live_players', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.integer('session_id').unsigned().notNullable().references('id').inTable('live_sessions').onDelete('CASCADE');
    t.integer('user_id').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    t.string('nickname', 40).notNullable();
    t.string('token_hash', 64).notNullable();
    t.integer('score').notNullable().defaultTo(0);
    t.integer('streak').unsigned().notNullable().defaultTo(0);
    t.integer('current_index').notNullable().defaultTo(0);
    t.json('powerups').nullable();
    t.boolean('connected').notNullable().defaultTo(false);
    t.boolean('kicked').notNullable().defaultTo(false);
    t.datetime('finished_at').nullable();
    timestamps(knex, t);
    t.unique(['session_id', 'nickname']);
  });

  await knex.schema.createTable('live_answers', (t) => {
    tableDefaults(t);
    t.bigIncrements('id');
    t.integer('session_id').unsigned().notNullable().references('id').inTable('live_sessions').onDelete('CASCADE');
    t.integer('player_id').unsigned().notNullable().references('id').inTable('live_players').onDelete('CASCADE');
    t.integer('question_index').unsigned().notNullable();
    t.integer('question_id').unsigned().notNullable().references('id').inTable('questions').onDelete('CASCADE');
    t.integer('question_version_id').unsigned().notNullable().references('id').inTable('question_versions').onDelete('RESTRICT');
    t.json('response').nullable();
    t.boolean('is_correct').notNullable();
    t.integer('points').notNullable().defaultTo(0);
    t.integer('response_ms').unsigned().notNullable();
    createdAt(knex, t);
    t.unique(['player_id', 'question_index']);
    t.index(['session_id', 'question_index']);
  });

  await knex.schema.createTable('item_statistics', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.integer('question_id').unsigned().notNullable().references('id').inTable('questions').onDelete('CASCADE');
    t.integer('exam_id').unsigned().nullable().references('id').inTable('exams').onDelete('CASCADE');
    t.integer('responses').unsigned().notNullable().defaultTo(0);
    t.decimal('p_value', 6, 4).nullable();
    t.decimal('point_biserial', 6, 4).nullable();
    t.decimal('discrimination_27', 6, 4).nullable();
    t.json('distractors').nullable();
    t.decimal('avg_time_sec', 8, 2).nullable();
    t.json('flags').nullable();
    t.datetime('computed_at').notNullable();
    t.unique(['question_id', 'exam_id']);
  });

  await knex.schema.createTable('exam_statistics', (t) => {
    tableDefaults(t);
    t.integer('exam_id').unsigned().primary().references('id').inTable('exams').onDelete('CASCADE');
    t.integer('attempts').unsigned().notNullable().defaultTo(0);
    t.integer('completed').unsigned().notNullable().defaultTo(0);
    t.decimal('completion_rate', 6, 4).nullable();
    t.decimal('pass_rate', 6, 4).nullable();
    t.decimal('avg_percent', 6, 2).nullable();
    t.decimal('avg_time_sec', 10, 2).nullable();
    t.decimal('kr20', 6, 4).nullable();
    t.decimal('cronbach_alpha', 6, 4).nullable();
    t.json('histogram').nullable();
    t.json('dropoff').nullable();
    t.datetime('computed_at').notNullable();
  });

  await knex.schema.createTable('notifications', (t) => {
    tableDefaults(t);
    t.bigIncrements('id');
    t.integer('user_id').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('type', 50).notNullable();
    t.string('title', 200).notNullable();
    t.text('body').nullable();
    t.string('url', 500).nullable();
    t.datetime('read_at').nullable();
    createdAt(knex, t);
    t.index(['user_id', 'read_at', 'created_at']);
  });

  await knex.schema.createTable('email_templates', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.string('key', 60).notNullable().unique();
    t.string('name', 120).notNullable();
    t.string('subject', 255).notNullable();
    t.specificType('body_html', 'mediumtext').notNullable();
    t.json('variables').nullable();
    t.integer('updated_by').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    timestamps(knex, t);
  });

  await knex.schema.createTable('announcements', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.string('title', 200).notNullable();
    t.text('body_html').nullable();
    t.enu('level', ['info', 'success', 'warning', 'danger']).notNullable().defaultTo('info');
    t.enu('target', ['all', 'guests', 'role', 'organisation', 'cohort']).notNullable().defaultTo('all');
    t.json('target_ids').nullable();
    t.datetime('starts_at').nullable();
    t.datetime('ends_at').nullable();
    t.boolean('is_active').notNullable().defaultTo(true);
    t.boolean('dismissible').notNullable().defaultTo(true);
    t.integer('created_by').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    timestamps(knex, t);
  });

  await knex.schema.createTable('support_tickets', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.string('ticket_no', 20).notNullable().unique();
    t.integer('user_id').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    t.string('name', 150).notNullable();
    t.string('email', 191).notNullable();
    t.string('subject', 200).notNullable();
    t.enu('status', ['open', 'pending', 'resolved', 'closed']).notNullable().defaultTo('open');
    t.enu('priority', ['low', 'normal', 'high']).notNullable().defaultTo('normal');
    t.integer('assigned_to').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    t.string('access_token_hash', 64).nullable();
    timestamps(knex, t);
    t.index(['status', 'updated_at']);
  });

  await knex.schema.createTable('ticket_messages', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.integer('ticket_id').unsigned().notNullable().references('id').inTable('support_tickets').onDelete('CASCADE');
    t.integer('user_id').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    t.boolean('is_staff').notNullable().defaultTo(false);
    t.text('body').notNullable();
    createdAt(knex, t);
    t.index(['ticket_id', 'created_at']);
  });

  await knex.schema.createTable('settings', (t) => {
    tableDefaults(t);
    t.string('key', 150).primary();
    t.specificType('value', 'mediumtext').nullable();
    t.boolean('is_encrypted').notNullable().defaultTo(false);
    t.integer('updated_by').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    t.datetime('updated_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));
  });

  await knex.schema.createTable('pages', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.string('slug', 120).notNullable().unique();
    t.string('title', 200).notNullable();
    t.specificType('body_html', 'mediumtext').nullable();
    t.string('meta_title', 200).nullable();
    t.string('meta_description', 300).nullable();
    t.boolean('is_published').notNullable().defaultTo(true);
    t.boolean('show_in_footer').notNullable().defaultTo(false);
    t.integer('display_order').notNullable().defaultTo(0);
    timestamps(knex, t);
  });

  await knex.schema.createTable('faqs', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.string('category', 100).nullable();
    t.string('question', 300).notNullable();
    t.text('answer_html').notNullable();
    t.integer('display_order').notNullable().defaultTo(0);
    t.boolean('is_published').notNullable().defaultTo(true);
    timestamps(knex, t);
  });

  await knex.schema.createTable('homepage_blocks', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.enu('type', ['hero', 'featured_certifications', 'featured_exams', 'testimonials', 'stats', 'partners', 'cta']).notNullable();
    t.string('title', 200).nullable();
    t.json('data').nullable();
    t.integer('display_order').notNullable().defaultTo(0);
    t.boolean('is_active').notNullable().defaultTo(true);
    timestamps(knex, t);
  });

  await knex.schema.createTable('audit_logs', (t) => {
    tableDefaults(t);
    t.bigIncrements('id');
    t.integer('user_id').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    t.string('action', 100).notNullable();
    t.string('entity_type', 60).nullable();
    t.string('entity_id', 64).nullable();
    t.json('before').nullable();
    t.json('after').nullable();
    t.string('ip', 45).nullable();
    t.string('user_agent', 255).nullable();
    createdAt(knex, t);
    t.index(['entity_type', 'entity_id']);
    t.index(['user_id', 'created_at']);
    t.index(['action', 'created_at']);
  });

  await knex.schema.createTable('jobs', (t) => {
    tableDefaults(t);
    t.bigIncrements('id');
    t.string('type', 60).notNullable();
    t.json('payload').nullable();
    t.enu('status', ['pending', 'running', 'completed', 'failed']).notNullable().defaultTo('pending');
    t.integer('attempts').unsigned().notNullable().defaultTo(0);
    t.integer('max_attempts').unsigned().notNullable().defaultTo(3);
    t.datetime('run_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
    t.datetime('locked_at').nullable();
    t.string('locked_by', 64).nullable();
    t.text('last_error').nullable();
    t.json('result').nullable();
    t.datetime('completed_at').nullable();
    timestamps(knex, t);
    t.index(['status', 'run_at']);
    t.index(['type', 'status']);
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('assignments', (t) => t.dropForeign('live_session_id'));
  for (const table of [
    'jobs',
    'audit_logs',
    'homepage_blocks',
    'faqs',
    'pages',
    'settings',
    'ticket_messages',
    'support_tickets',
    'announcements',
    'email_templates',
    'notifications',
    'exam_statistics',
    'item_statistics',
    'live_answers',
    'live_players',
    'live_sessions',
  ]) {
    await knex.schema.dropTableIfExists(table);
  }
};
