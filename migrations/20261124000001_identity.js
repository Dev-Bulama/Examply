'use strict';

const { timestamps, createdAt, softDelete, tableDefaults } = require('../src/utils/migration');

/** Users, roles, permissions, auth tokens, accommodations, login history, session store table. */
exports.up = async function up(knex) {
  await knex.schema.createTable('roles', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.string('name', 100).notNullable();
    t.string('slug', 100).notNullable().unique();
    t.string('description', 255).nullable();
    t.boolean('is_system').notNullable().defaultTo(false);
    timestamps(knex, t);
  });

  await knex.schema.createTable('permissions', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.string('key', 100).notNullable().unique();
    t.string('group', 60).notNullable();
    t.string('description', 255).notNullable();
    createdAt(knex, t);
  });

  await knex.schema.createTable('role_permissions', (t) => {
    tableDefaults(t);
    t.integer('role_id').unsigned().notNullable().references('id').inTable('roles').onDelete('CASCADE');
    t.integer('permission_id').unsigned().notNullable().references('id').inTable('permissions').onDelete('CASCADE');
    t.primary(['role_id', 'permission_id']);
  });

  await knex.schema.createTable('users', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.uuid('uuid').notNullable().unique();
    t.string('email', 191).notNullable().unique();
    t.string('password_hash', 100).nullable();
    t.string('full_name', 150).notNullable();
    t.string('phone', 40).nullable();
    t.string('country', 2).nullable();
    t.string('organisation_name', 150).nullable();
    t.string('job_title', 120).nullable();
    t.smallint('years_experience').unsigned().nullable();
    t.string('photo_path', 255).nullable();
    t.string('timezone', 64).nullable();
    t.string('locale', 10).notNullable().defaultTo('en');
    t.enu('theme', ['system', 'light', 'dark']).notNullable().defaultTo('system');
    t.enu('status', ['active', 'suspended']).notNullable().defaultTo('active');
    t.datetime('email_verified_at').nullable();
    t.text('totp_secret_enc').nullable();
    t.datetime('totp_enabled_at').nullable();
    t.json('totp_recovery_codes').nullable();
    // Last accepted TOTP time-step: a code can never be used twice (replay protection).
    t.bigInteger('totp_last_step').unsigned().nullable();
    t.string('google_id', 64).nullable().unique();
    t.datetime('password_changed_at').nullable();
    // Incremented on password change / reset / admin security actions; sessions with an older value are signed out.
    t.integer('auth_version').unsigned().notNullable().defaultTo(0);
    t.datetime('last_login_at').nullable();
    t.string('last_login_ip', 45).nullable();
    t.datetime('deletion_requested_at').nullable();
    t.string('deletion_reason', 500).nullable();
    t.integer('created_by').unsigned().nullable();
    softDelete(t);
    timestamps(knex, t);
    t.index(['status']);
  });

  await knex.schema.createTable('user_roles', (t) => {
    tableDefaults(t);
    t.integer('user_id').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.integer('role_id').unsigned().notNullable().references('id').inTable('roles').onDelete('CASCADE');
    t.primary(['user_id', 'role_id']);
    createdAt(knex, t);
  });

  await knex.schema.createTable('password_resets', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.integer('user_id').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('token_hash', 64).notNullable().unique();
    t.datetime('expires_at').notNullable();
    t.datetime('used_at').nullable();
    t.string('ip', 45).nullable();
    createdAt(knex, t);
  });

  await knex.schema.createTable('email_verifications', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.integer('user_id').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('email', 191).notNullable();
    t.string('token_hash', 64).notNullable().unique();
    t.datetime('expires_at').notNullable();
    t.datetime('used_at').nullable();
    createdAt(knex, t);
  });

  await knex.schema.createTable('user_accommodations', (t) => {
    tableDefaults(t);
    t.integer('user_id').unsigned().primary().references('id').inTable('users').onDelete('CASCADE');
    t.smallint('extra_time_percent').unsigned().notNullable().defaultTo(0);
    t.boolean('large_font').notNullable().defaultTo(false);
    t.boolean('high_contrast').notNullable().defaultTo(false);
    t.string('notes', 500).nullable();
    t.integer('granted_by').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    timestamps(knex, t);
  });

  await knex.schema.createTable('login_history', (t) => {
    tableDefaults(t);
    t.bigIncrements('id');
    t.integer('user_id').unsigned().nullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('email', 191).notNullable();
    t.string('ip', 45).nullable();
    t.string('user_agent', 255).nullable();
    t.boolean('success').notNullable();
    t.string('reason', 60).nullable();
    createdAt(knex, t);
    t.index(['email', 'ip', 'created_at']);
    t.index(['user_id', 'created_at']);
  });

  // Same structure express-mysql-session expects (it is the session store's table).
  await knex.schema.createTable('sessions', (t) => {
    t.engine('InnoDB');
    t.charset('utf8mb4');
    t.collate('utf8mb4_bin');
    t.string('session_id', 128).notNullable().primary();
    t.integer('expires').unsigned().notNullable().index();
    t.specificType('data', 'mediumtext').nullable();
  });
};

exports.down = async function down(knex) {
  for (const table of [
    'sessions',
    'login_history',
    'user_accommodations',
    'email_verifications',
    'password_resets',
    'user_roles',
    'users',
    'role_permissions',
    'permissions',
    'roles',
  ]) {
    await knex.schema.dropTableIfExists(table);
  }
};
