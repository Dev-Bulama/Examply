'use strict';

/**
 * Lab sessions: one simulated machine per candidate per lab item (or per staff member per question version for
 * previews), persisted in lab_sessions so a refresh, reconnect or another device continues exactly where it was.
 */
const { db } = require('../../config/db');
const { parseJson, toJson } = require('../../utils/json');
const machine = require('./machine');
const shell = require('./shell');
const scenarioLib = require('./scenario');

const MAX_STATE = 4 * 1024 * 1024;
const MAX_TRANSCRIPT = 200000;
const MAX_COMMANDS = 3000;

class LabError extends Error {
  constructor(message, status = 422) {
    super(message);
    this.status = status;
  }
}

async function scenarioFor(versionId, knex = db()) {
  const row = await knex('question_answers').where({ question_version_id: versionId }).first('answer');
  return (parseJson(row && row.answer, {}) || {}).scenario || null;
}

/** Loads (or creates from the scenario) the session for owner_key. */
async function session({ ownerKey, versionId, userId, attemptItemId = null }, knex = db()) {
  let row = await knex('lab_sessions').where({ owner_key: ownerKey }).first();
  if (!row) {
    const scenario = await scenarioFor(versionId, knex);
    if (!scenario) throw new LabError('This lab is not available.', 404);
    const state = machine.build(scenario);
    await knex('lab_sessions').insert({ owner_key: ownerKey, attempt_item_id: attemptItemId, question_version_id: versionId, user_id: userId, state: JSON.stringify(state), transcript: '' }).onConflict('owner_key').ignore();
    row = await knex('lab_sessions').where({ owner_key: ownerKey }).first();
  }
  return { ...row, state: parseJson(row.state, {}) };
}

/** Runs one command line and persists the machine. Returns { output, prompt, exit }. */
async function exec(sess, line, knex = db()) {
  if (sess.commands >= MAX_COMMANDS) throw new LabError('This lab has reached its command limit.');
  const state = sess.state;
  const { output, exit } = shell.run(state, line);
  const json = JSON.stringify(state);
  if (json.length > MAX_STATE) throw new LabError('The lab machine is out of space. Remove some files and try again.');
  const p = shell.prompt(state);
  let transcript = `${sess.transcript || ''}${shell.prompt({ ...state, cwd: state.cwd })}${String(line).slice(0, 2000)}\n${output}`;
  if (transcript.length > MAX_TRANSCRIPT) transcript = transcript.slice(-MAX_TRANSCRIPT);
  await knex('lab_sessions').where({ id: sess.id }).update({ state: json, transcript, commands: sess.commands + 1, updated_at: new Date() });
  sess.transcript = transcript;
  sess.commands += 1;
  return { output, prompt: p, exit };
}

/** Welcome banner + prompt for a fresh terminal (or the transcript tail when resuming). */
function greeting(sess, brief) {
  const st = sess.state;
  if (sess.transcript) return { replay: sess.transcript.slice(-20000), prompt: shell.prompt(st) };
  return { replay: `Welcome to ${brief.title || 'the lab'} (${st.hostname})\nType "help" for the commands you can use. Submit answers you find with: submit <answer>\n\n`, prompt: shell.prompt(st) };
}

async function reset(ownerKey, knex = db()) {
  await knex('lab_sessions').where({ owner_key: ownerKey }).del();
}

/** Lab state for grading an attempt item (null when the candidate never opened the lab). */
async function stateForItem(itemId, knex = db()) {
  const row = await knex('lab_sessions').where({ owner_key: `item:${itemId}` }).first('state');
  return row ? parseJson(row.state, null) : null;
}

module.exports = { session, exec, greeting, reset, stateForItem, scenarioFor, LabError, toJson, scenarioLib };
