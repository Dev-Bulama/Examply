'use strict';

const bcrypt = require('bcryptjs');
const settings = require('../settings');

const COST = 12;
const COMMON = new Set(['password', 'password1', 'password123', '123456789', '12345678', 'qwerty123', 'letmein123', 'admin12345', 'welcome123', 'iloveyou1']);

async function hash(password) {
  return bcrypt.hash(password, COST);
}

async function verify(password, passwordHash) {
  if (!passwordHash) return false;
  return bcrypt.compare(password, passwordHash);
}

/** Returns the configured policy (Settings → Security). */
async function policy() {
  const s = await settings.getMany('security.password_');
  return {
    minLength: Math.max(8, s['security.password_min_length']),
    mixedCase: s['security.password_require_mixed_case'],
    number: s['security.password_require_number'],
    symbol: s['security.password_require_symbol'],
  };
}

/** Returns an array of human-readable problems; empty when the password is acceptable. */
function check(password, p, { email, name } = {}) {
  const problems = [];
  const pw = String(password || '');
  if (pw.length < p.minLength) problems.push(`Use at least ${p.minLength} characters.`);
  if (pw.length > 128) problems.push('Use at most 128 characters.');
  if (p.mixedCase && !(/[a-z]/.test(pw) && /[A-Z]/.test(pw))) problems.push('Use both upper- and lower-case letters.');
  if (p.number && !/\d/.test(pw)) problems.push('Include at least one number.');
  if (p.symbol && !/[^A-Za-z0-9]/.test(pw)) problems.push('Include at least one symbol.');
  if (COMMON.has(pw.toLowerCase())) problems.push('That password is too common.');
  const local = email ? String(email).split('@')[0].toLowerCase() : '';
  if (local.length >= 4 && pw.toLowerCase().includes(local)) problems.push('Do not include your email address in the password.');
  if (name && name.length >= 4 && pw.toLowerCase().includes(name.toLowerCase().split(' ')[0])) problems.push('Do not include your name in the password.');
  return problems;
}

function describe(p) {
  const parts = [`at least ${p.minLength} characters`];
  if (p.mixedCase) parts.push('upper- and lower-case letters');
  if (p.number) parts.push('a number');
  if (p.symbol) parts.push('a symbol');
  return `Use ${parts.join(', ').replace(/, ([^,]*)$/, ' and $1')}.`;
}

module.exports = { hash, verify, policy, check, describe, COST };
