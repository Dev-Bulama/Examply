'use strict';

/** Rebrand: sites still on the old default name/colours move to EXAMPLY navy + gold. Custom values are kept. */
const swap = [
  ['general.site_name', 'Skillscore Assess', 'EXAMPLY'],
  ['branding.primary_color', '#1f4fd1', '#1f3a5f'],
  ['branding.secondary_color', '#0f9d7a', '#a8822e'],
];

exports.up = async function up(knex) {
  for (const [key, from, to] of swap) {
    for (const v of [from, JSON.stringify(from)]) await knex('settings').where({ key, value: v }).update({ value: v.startsWith('"') ? JSON.stringify(to) : to });
  }
};

exports.down = async function down() {};
