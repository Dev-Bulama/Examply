'use strict';

const { timestamps, createdAt, softDelete, tableDefaults } = require('../src/utils/migration');

/** Organisations, cohorts, seats; categories, certifications, domains, training programmes. */
exports.up = async function up(knex) {
  await knex.schema.createTable('organisations', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.string('name', 150).notNullable();
    t.string('slug', 160).notNullable().unique();
    t.string('logo_path', 255).nullable();
    t.string('contact_name', 150).nullable();
    t.string('contact_email', 191).nullable();
    t.string('contact_phone', 40).nullable();
    t.integer('seat_balance').notNullable().defaultTo(0);
    t.string('join_code', 20).nullable().unique();
    t.boolean('join_enabled').notNullable().defaultTo(false);
    t.enu('status', ['active', 'suspended']).notNullable().defaultTo('active');
    softDelete(t);
    timestamps(knex, t);
  });

  await knex.schema.createTable('organisation_users', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.integer('organisation_id').unsigned().notNullable().references('id').inTable('organisations').onDelete('CASCADE');
    t.integer('user_id').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.enu('role', ['manager', 'member']).notNullable().defaultTo('member');
    t.integer('invited_by').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    t.datetime('joined_at').nullable();
    timestamps(knex, t);
    t.unique(['organisation_id', 'user_id']);
    t.index(['user_id']);
  });

  await knex.schema.createTable('organisation_invitations', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.integer('organisation_id').unsigned().notNullable().references('id').inTable('organisations').onDelete('CASCADE');
    t.string('email', 191).notNullable();
    t.string('token_hash', 64).notNullable().unique();
    t.integer('cohort_id').unsigned().nullable();
    t.integer('invited_by').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    t.datetime('expires_at').notNullable();
    t.datetime('accepted_at').nullable();
    createdAt(knex, t);
    t.index(['organisation_id', 'email']);
  });

  await knex.schema.createTable('cohorts', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.integer('organisation_id').unsigned().notNullable().references('id').inTable('organisations').onDelete('CASCADE');
    t.string('name', 150).notNullable();
    t.text('description').nullable();
    t.date('starts_on').nullable();
    t.date('ends_on').nullable();
    softDelete(t);
    timestamps(knex, t);
  });

  await knex.schema.alterTable('organisation_invitations', (t) => {
    t.foreign('cohort_id').references('id').inTable('cohorts').onDelete('SET NULL');
  });

  await knex.schema.createTable('cohort_members', (t) => {
    tableDefaults(t);
    t.integer('cohort_id').unsigned().notNullable().references('id').inTable('cohorts').onDelete('CASCADE');
    t.integer('user_id').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.primary(['cohort_id', 'user_id']);
    createdAt(knex, t);
  });

  await knex.schema.createTable('seat_ledger', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.integer('organisation_id').unsigned().notNullable().references('id').inTable('organisations').onDelete('CASCADE');
    t.integer('delta').notNullable();
    t.enu('source', ['purchase', 'admin', 'consume', 'refund', 'release']).notNullable();
    t.string('reason', 255).nullable();
    t.integer('order_id').unsigned().nullable();
    t.integer('user_id').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    t.integer('actor_id').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    t.integer('balance_after').notNullable();
    createdAt(knex, t);
    t.index(['organisation_id', 'created_at']);
  });

  await knex.schema.createTable('categories', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.integer('parent_id').unsigned().nullable().references('id').inTable('categories').onDelete('SET NULL');
    t.string('name', 150).notNullable();
    t.string('slug', 160).notNullable().unique();
    t.string('icon', 60).nullable();
    t.string('image_path', 255).nullable();
    t.text('description').nullable();
    t.integer('display_order').notNullable().defaultTo(0);
    t.boolean('is_active').notNullable().defaultTo(true);
    timestamps(knex, t);
    t.index(['parent_id', 'display_order']);
  });

  await knex.schema.createTable('author_categories', (t) => {
    tableDefaults(t);
    t.integer('user_id').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.integer('category_id').unsigned().notNullable().references('id').inTable('categories').onDelete('CASCADE');
    t.primary(['user_id', 'category_id']);
  });

  await knex.schema.createTable('certifications', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.integer('category_id').unsigned().notNullable().references('id').inTable('categories').onDelete('RESTRICT');
    t.string('name', 180).notNullable();
    t.string('slug', 190).notNullable().unique();
    t.string('issuing_body', 150).nullable();
    t.string('exam_code', 60).nullable();
    t.decimal('official_passing_score', 8, 2).nullable();
    t.string('official_score_scale', 40).nullable();
    t.integer('official_duration_minutes').unsigned().nullable();
    t.integer('official_question_count').unsigned().nullable();
    t.string('external_url', 500).nullable();
    t.text('description').nullable();
    t.string('image_path', 255).nullable();
    t.integer('display_order').notNullable().defaultTo(0);
    t.boolean('is_active').notNullable().defaultTo(true);
    timestamps(knex, t);
    t.index(['category_id']);
  });

  await knex.schema.createTable('certification_domains', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.integer('certification_id').unsigned().notNullable().references('id').inTable('certifications').onDelete('CASCADE');
    t.string('code', 30).nullable();
    t.string('name', 200).notNullable();
    t.decimal('weight_percent', 5, 2).notNullable().defaultTo(0);
    t.text('description').nullable();
    t.integer('display_order').notNullable().defaultTo(0);
    timestamps(knex, t);
    t.index(['certification_id', 'display_order']);
  });

  await knex.schema.createTable('training_programmes', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.string('name', 180).notNullable();
    t.string('slug', 190).notNullable().unique();
    t.text('description').nullable();
    t.json('levels').nullable();
    t.integer('category_id').unsigned().nullable().references('id').inTable('categories').onDelete('SET NULL');
    t.boolean('is_active').notNullable().defaultTo(true);
    timestamps(knex, t);
  });

  await knex.schema.createTable('programme_bands', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.integer('programme_id').unsigned().notNullable().references('id').inTable('training_programmes').onDelete('CASCADE');
    t.string('band', 40).notNullable();
    t.string('course_title', 200).nullable();
    t.string('course_url', 500).nullable();
    t.text('message').nullable();
    t.integer('display_order').notNullable().defaultTo(0);
    timestamps(knex, t);
    t.unique(['programme_id', 'band']);
  });
};

exports.down = async function down(knex) {
  for (const table of [
    'programme_bands',
    'training_programmes',
    'certification_domains',
    'certifications',
    'author_categories',
    'categories',
    'seat_ledger',
    'cohort_members',
    'organisation_invitations',
    'cohorts',
    'organisation_users',
    'organisations',
  ]) {
    await knex.schema.dropTableIfExists(table);
  }
};
