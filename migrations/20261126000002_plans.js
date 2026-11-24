'use strict';

/**
 * Subscription plans for companies (products of type "plan"): marketing copy, feature list and enforceable limits.
 * limits: { candidates, ai_questions_per_month, exams, labs (bool), custom_branding (bool), staff_seats }
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('products', (t) => {
    t.string('tagline', 200).nullable();
    t.json('features').nullable();
    t.json('limits').nullable();
    t.boolean('is_featured').notNullable().defaultTo(false);
    t.integer('display_order').notNullable().defaultTo(0);
    t.enu('audience', ['individual', 'organisation']).notNullable().defaultTo('individual');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('products', (t) => {
    for (const c of ['tagline', 'features', 'limits', 'is_featured', 'display_order', 'audience']) t.dropColumn(c);
  });
};
