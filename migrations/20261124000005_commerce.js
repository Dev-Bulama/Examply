'use strict';

const { timestamps, createdAt, softDelete, tableDefaults } = require('../src/utils/migration');

/** Products, packs, entitlements, coupons, orders, payments (Paystack + bank transfer), subscriptions, reviews. */
exports.up = async function up(knex) {
  await knex.schema.createTable('past_question_packs', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.integer('certification_id').unsigned().nullable().references('id').inTable('certifications').onDelete('SET NULL');
    t.string('title', 200).notNullable();
    t.string('slug', 210).notNullable().unique();
    t.text('description').nullable();
    t.string('cover_path', 255).nullable();
    t.string('years_covered', 120).nullable();
    t.json('mock_blueprint').nullable();
    t.integer('mock_duration_minutes').unsigned().nullable();
    t.enu('status', ['draft', 'published', 'archived']).notNullable().defaultTo('draft');
    softDelete(t);
    timestamps(knex, t);
  });

  await knex.schema.createTable('pack_questions', (t) => {
    tableDefaults(t);
    t.integer('pack_id').unsigned().notNullable().references('id').inTable('past_question_packs').onDelete('CASCADE');
    t.integer('question_id').unsigned().notNullable().references('id').inTable('questions').onDelete('CASCADE');
    t.boolean('is_preview').notNullable().defaultTo(false);
    t.integer('display_order').notNullable().defaultTo(0);
    t.primary(['pack_id', 'question_id']);
  });

  await knex.schema.alterTable('attempts', (t) => {
    t.foreign('pack_id').references('id').inTable('past_question_packs').onDelete('SET NULL');
  });

  await knex.schema.createTable('products', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.enu('type', ['exam', 'pack', 'bundle', 'attempts', 'seats', 'plan']).notNullable();
    t.string('name', 200).notNullable();
    t.string('slug', 210).notNullable().unique();
    t.text('description').nullable();
    t.integer('exam_id').unsigned().nullable().references('id').inTable('exams').onDelete('SET NULL');
    t.integer('pack_id').unsigned().nullable().references('id').inTable('past_question_packs').onDelete('SET NULL');
    t.integer('quantity').unsigned().nullable(); // attempts or seats per unit
    t.integer('price_kobo').unsigned().notNullable();
    t.integer('sale_price_kobo').unsigned().nullable();
    t.string('currency', 3).notNullable().defaultTo('NGN');
    t.integer('access_days').unsigned().nullable(); // null = lifetime
    t.string('paystack_plan_code', 60).nullable();
    t.enu('plan_interval', ['monthly', 'quarterly', 'biannually', 'annually']).nullable();
    t.boolean('is_active').notNullable().defaultTo(true);
    softDelete(t);
    timestamps(knex, t);
    t.index(['type', 'is_active']);
    t.index(['exam_id']);
    t.index(['pack_id']);
  });

  await knex.schema.createTable('product_items', (t) => {
    tableDefaults(t);
    t.integer('bundle_product_id').unsigned().notNullable().references('id').inTable('products').onDelete('CASCADE');
    t.integer('product_id').unsigned().notNullable().references('id').inTable('products').onDelete('CASCADE');
    t.primary(['bundle_product_id', 'product_id']);
  });

  await knex.schema.createTable('coupons', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.string('code', 40).notNullable().unique();
    t.enu('discount_type', ['percent', 'fixed']).notNullable();
    t.integer('value').unsigned().notNullable(); // percent (1–100) or kobo
    t.integer('max_uses').unsigned().nullable();
    t.integer('max_uses_per_user').unsigned().nullable();
    t.integer('used_count').unsigned().notNullable().defaultTo(0);
    t.integer('min_order_kobo').unsigned().nullable();
    t.datetime('starts_at').nullable();
    t.datetime('expires_at').nullable();
    t.json('product_ids').nullable(); // null = any product
    t.boolean('is_active').notNullable().defaultTo(true);
    timestamps(knex, t);
  });

  await knex.schema.createTable('orders', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.string('order_no', 24).notNullable().unique();
    t.integer('user_id').unsigned().notNullable().references('id').inTable('users').onDelete('RESTRICT');
    t.integer('organisation_id').unsigned().nullable().references('id').inTable('organisations').onDelete('SET NULL');
    t.enu('status', ['pending', 'awaiting_transfer', 'paid', 'failed', 'cancelled', 'refunded']).notNullable().defaultTo('pending');
    t.enu('payment_method', ['paystack', 'bank_transfer', 'free', 'admin']).notNullable();
    t.integer('subtotal_kobo').unsigned().notNullable();
    t.integer('discount_kobo').unsigned().notNullable().defaultTo(0);
    t.integer('total_kobo').unsigned().notNullable();
    t.string('currency', 3).notNullable().defaultTo('NGN');
    t.integer('coupon_id').unsigned().nullable().references('id').inTable('coupons').onDelete('SET NULL');
    t.datetime('paid_at').nullable();
    t.datetime('fulfilled_at').nullable();
    t.datetime('refunded_at').nullable();
    t.string('refund_reason', 500).nullable();
    t.integer('refunded_by').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    // Bank transfer
    t.string('transfer_proof_path', 255).nullable();
    t.string('transfer_reference', 120).nullable();
    t.text('transfer_note').nullable();
    t.datetime('transfer_submitted_at').nullable();
    t.integer('reviewed_by').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    t.datetime('reviewed_at').nullable();
    t.string('review_note', 500).nullable();
    t.datetime('expires_at').nullable();
    timestamps(knex, t);
    t.index(['user_id', 'created_at']);
    t.index(['status', 'created_at']);
  });

  await knex.schema.createTable('order_items', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.integer('order_id').unsigned().notNullable().references('id').inTable('orders').onDelete('CASCADE');
    t.integer('product_id').unsigned().notNullable().references('id').inTable('products').onDelete('RESTRICT');
    t.string('name', 200).notNullable();
    t.integer('quantity').unsigned().notNullable().defaultTo(1);
    t.integer('unit_price_kobo').unsigned().notNullable();
    t.integer('total_kobo').unsigned().notNullable();
    t.json('meta').nullable();
  });

  await knex.schema.alterTable('exam_attempt_overrides', (t) => {
    t.foreign('order_id').references('id').inTable('orders').onDelete('SET NULL');
  });
  await knex.schema.alterTable('seat_ledger', (t) => {
    t.foreign('order_id').references('id').inTable('orders').onDelete('SET NULL');
  });

  await knex.schema.createTable('coupon_redemptions', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.integer('coupon_id').unsigned().notNullable().references('id').inTable('coupons').onDelete('CASCADE');
    t.integer('user_id').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.integer('order_id').unsigned().notNullable().unique().references('id').inTable('orders').onDelete('CASCADE');
    t.integer('discount_kobo').unsigned().notNullable();
    createdAt(knex, t);
    t.index(['coupon_id', 'user_id']);
  });

  await knex.schema.createTable('payments', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.integer('order_id').unsigned().nullable().references('id').inTable('orders').onDelete('SET NULL');
    t.enu('provider', ['paystack', 'bank_transfer']).notNullable();
    t.string('reference', 100).notNullable().unique();
    t.integer('amount_kobo').unsigned().notNullable();
    t.string('currency', 3).notNullable();
    t.enu('status', ['initialized', 'success', 'failed', 'abandoned', 'reversed', 'refunded']).notNullable().defaultTo('initialized');
    t.string('channel', 40).nullable();
    t.json('raw_payload').nullable();
    t.datetime('verified_at').nullable();
    timestamps(knex, t);
    t.index(['order_id']);
  });

  await knex.schema.createTable('webhook_events', (t) => {
    tableDefaults(t);
    t.bigIncrements('id');
    t.string('provider', 30).notNullable();
    t.string('event', 60).notNullable();
    t.string('reference', 100).nullable();
    t.boolean('signature_valid').notNullable();
    t.json('payload').nullable();
    t.enu('outcome', ['processed', 'duplicate', 'ignored', 'rejected', 'error']).notNullable();
    t.text('error').nullable();
    createdAt(knex, t);
    t.index(['provider', 'reference']);
  });

  await knex.schema.createTable('entitlements', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.integer('user_id').unsigned().nullable().references('id').inTable('users').onDelete('CASCADE');
    t.integer('organisation_id').unsigned().nullable().references('id').inTable('organisations').onDelete('CASCADE');
    t.integer('product_id').unsigned().notNullable().references('id').inTable('products').onDelete('CASCADE');
    t.datetime('starts_at').notNullable();
    t.datetime('expires_at').nullable();
    t.integer('source_order_id').unsigned().nullable().references('id').inTable('orders').onDelete('SET NULL');
    t.enu('source', ['purchase', 'admin', 'subscription', 'organisation', 'bundle']).notNullable().defaultTo('purchase');
    t.datetime('revoked_at').nullable();
    t.string('revoke_reason', 255).nullable();
    timestamps(knex, t);
    t.index(['user_id', 'product_id', 'expires_at']);
    t.index(['organisation_id', 'product_id']);
  });

  await knex.schema.createTable('subscriptions', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.integer('user_id').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.integer('product_id').unsigned().notNullable().references('id').inTable('products').onDelete('RESTRICT');
    t.string('subscription_code', 80).nullable().unique();
    t.string('customer_code', 80).nullable();
    t.string('email_token', 80).nullable();
    t.enu('status', ['active', 'non_renewing', 'attention', 'cancelled', 'completed']).notNullable().defaultTo('active');
    t.datetime('current_period_end').nullable();
    t.datetime('cancelled_at').nullable();
    t.json('raw_payload').nullable();
    timestamps(knex, t);
    t.index(['user_id', 'status']);
  });

  await knex.schema.createTable('reviews', (t) => {
    tableDefaults(t);
    t.increments('id');
    t.integer('user_id').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.integer('product_id').unsigned().notNullable().references('id').inTable('products').onDelete('CASCADE');
    t.tinyint('rating').unsigned().notNullable();
    t.string('title', 150).nullable();
    t.text('body').nullable();
    t.enu('status', ['pending', 'approved', 'rejected']).notNullable().defaultTo('pending');
    t.integer('moderated_by').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    t.datetime('moderated_at').nullable();
    timestamps(knex, t);
    t.unique(['user_id', 'product_id']);
    t.index(['product_id', 'status']);
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('exam_attempt_overrides', (t) => t.dropForeign('order_id'));
  await knex.schema.alterTable('seat_ledger', (t) => t.dropForeign('order_id'));
  await knex.schema.alterTable('attempts', (t) => t.dropForeign('pack_id'));
  for (const table of [
    'reviews',
    'subscriptions',
    'entitlements',
    'webhook_events',
    'payments',
    'coupon_redemptions',
    'order_items',
    'orders',
    'coupons',
    'product_items',
    'products',
    'pack_questions',
    'past_question_packs',
  ]) {
    await knex.schema.dropTableIfExists(table);
  }
};
