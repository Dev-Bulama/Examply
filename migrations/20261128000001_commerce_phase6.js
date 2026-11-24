'use strict';

/**
 * Phase 6:
 *  - subscriptions belong to an organisation (company plans) as well as the paying user;
 *  - orders remember Paystack's access code (resume checkout) and the plan buyer's organisation name;
 *  - products: display copy for the shop.
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('subscriptions', (t) => {
    t.integer('organisation_id').unsigned().nullable().references('id').inTable('organisations').onDelete('CASCADE');
    t.integer('order_id').unsigned().nullable().references('id').inTable('orders').onDelete('SET NULL');
    t.index(['organisation_id', 'status']);
  });
  await knex.schema.alterTable('orders', (t) => {
    t.string('paystack_access_code', 80).nullable();
    t.string('buyer_note', 200).nullable();
  });
  await knex.schema.alterTable('payments', (t) => {
    t.string('authorization_url', 255).nullable();
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('payments', (t) => t.dropColumn('authorization_url'));
  await knex.schema.alterTable('orders', (t) => {
    t.dropColumn('paystack_access_code');
    t.dropColumn('buyer_note');
  });
  await knex.schema.alterTable('subscriptions', (t) => {
    t.dropForeign('organisation_id');
    t.dropForeign('order_id');
    t.dropIndex(['organisation_id', 'status']);
    t.dropColumn('organisation_id');
    t.dropColumn('order_id');
  });
};
