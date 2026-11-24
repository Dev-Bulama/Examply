'use strict';

/** Products for every paid exam, an "extra attempt" product on the paid mock, and a demo coupon. Idempotent. */
const commerce = require('../src/services/commerce');

exports.seed = async function seed(knex) {
  const mock = await knex('exams').where({ slug: 'oracle-1z0-082-certification-mock' }).first('id');
  if (mock) await knex('exams').where({ id: mock.id }).update({ allow_buy_attempts: true, extra_attempt_price_kobo: 250000 });
  for (const id of await knex('exams').whereNull('deleted_at').pluck('id')) await commerce.syncExamProducts(id, knex);
  if (!(await knex('coupons').where({ code: 'WELCOME10' }).first('id'))) {
    await knex('coupons').insert({ code: 'WELCOME10', discount_type: 'percent', value: 10, max_uses_per_user: 1, is_active: true });
  }
};
