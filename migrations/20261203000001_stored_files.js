'use strict';

/**
 * Uploaded files are also kept in the database, so hosts that replace the file system on every deploy
 * (e.g. Hostinger Node.js web apps) restore them automatically at start-up. Idempotent.
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('stored_files')) return;
  await knex.schema.createTable('stored_files', (t) => {
    t.engine('InnoDB');
    t.charset('utf8mb4');
    t.string('path', 255).primary(); // relative to the storage folder, e.g. uploads/private/media/abc.png
    t.specificType('content', 'longblob').notNullable();
    t.integer('size').unsigned().notNullable();
    t.datetime('updated_at').notNullable().defaultTo(knex.fn.now());
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('stored_files');
};
