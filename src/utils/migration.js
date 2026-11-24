'use strict';

/** Shared column helpers for Knex migrations. All datetimes are UTC (connection time_zone = +00:00). */

function timestamps(knex, t) {
  t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
  t.datetime('updated_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));
}

function createdAt(knex, t) {
  t.datetime('created_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP'));
}

function softDelete(t) {
  t.datetime('deleted_at').nullable().index();
}

/** utf8mb4 + InnoDB on every table */
function tableDefaults(t) {
  t.engine('InnoDB');
  t.charset('utf8mb4');
  t.collate('utf8mb4_unicode_ci');
}

module.exports = { timestamps, createdAt, softDelete, tableDefaults };
