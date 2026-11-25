'use strict';

/**
 * Lab scenarios (the authoring format of the "lab" question type) and their task checks.
 *
 * {
 *   "title": "Harden a compromised web server",
 *   "hostname": "web01", "user": "analyst",
 *   "intro": "You are the on-call engineer…",
 *   "users": { "analyst": { "groups": ["analyst", "sudo"] }, "backdoor": { "uid": 0 } },
 *   "files": { "/var/log/auth.log": { "content": "…", "mode": "640" } },
 *   "services": { "telnet": { "port": 23, "active": true, "enabled": true } },
 *   "processes": [{ "user": "www-data", "command": "/tmp/.x/miner --pool …", "cpu": 97.5 }],
 *   "crontab": { "root": ["* * * * * /tmp/.x/beacon.sh"] },
 *   "firewall": { "enabled": false, "rules": [] },
 *   "hosts": { "10.0.0.5": { "name": "db01", "ports": [{ "port": 3306, "service": "mysql", "version": "MySQL 5.5.62" }] } },
 *   "logins": [{ "user": "backdoor", "from": "185.220.101.4", "at": "Mon Nov 24 02:13 - 02:41" }],
 *   "tasks": [
 *     { "id": "lock", "title": "Lock the backdoor account", "marks": 2, "check": { "type": "user_locked", "user": "backdoor" } },
 *     { "id": "flag", "title": "Find the attacker's IP in the logs", "marks": 1, "check": { "type": "flag_submitted", "flag": "185.220.101.4" } }
 *   ]
 * }
 */
const M = require('./machine');

const CHECKS = {
  file_contains: (st, c) => {
    const f = st.fs[c.path];
    if (!f || f.type !== 'file') return false;
    return c.regex ? new RegExp(c.regex, c.flags || '').test(f.content) : f.content.includes(c.text);
  },
  file_not_contains: (st, c) => {
    const f = st.fs[c.path];
    if (!f || f.type !== 'file') return true;
    return c.regex ? !new RegExp(c.regex, c.flags || '').test(f.content) : !f.content.includes(c.text);
  },
  file_exists: (st, c) => !!st.fs[c.path],
  file_absent: (st, c) => !st.fs[c.path],
  file_mode: (st, c) => {
    const f = st.fs[c.path];
    if (!f) return false;
    const mode = f.mode & 0o7777;
    if (c.mode) return mode === parseInt(c.mode, 8);
    if (c.max) return (mode & ~parseInt(c.max, 8)) === 0; // no permission beyond the maximum
    return false;
  },
  file_owner: (st, c) => !!st.fs[c.path] && st.fs[c.path].owner === c.owner && (!c.group || st.fs[c.path].group === c.group),
  user_absent: (st, c) => !st.users[c.user],
  user_locked: (st, c) => !st.users[c.user] || !!st.users[c.user].locked,
  user_not_in_group: (st, c) => !st.users[c.user] || !st.users[c.user].groups.includes(c.group),
  service_state: (st, c) => {
    const s = st.services[c.service];
    if (!s) return c.active === false && c.enabled !== true;
    return (c.active === undefined || s.active === c.active) && (c.enabled === undefined || s.enabled === c.enabled);
  },
  port_closed: (st, c) => !M.portOpen(st, c.port),
  firewall_enabled: (st) => st.firewall.enabled,
  firewall_denies: (st, c) => {
    if (!st.firewall.enabled) return false;
    const r = [...st.firewall.rules].reverse().find((x) => x.port === Number(c.port));
    return !!r && r.action === 'deny';
  },
  cron_absent: (st, c) => Object.entries(st.crontab).every(([u, lines]) => (c.user && u !== c.user) || !(lines || []).some((l) => l.includes(c.contains))) && !Object.keys(st.fs).some((p) => p.startsWith('/etc/cron.d/') && st.fs[p].type === 'file' && st.fs[p].content.includes(c.contains)),
  process_absent: (st, c) => !st.processes.some((p) => p.command.includes(c.contains)),
  command_ran: (st, c) => st.history.some((h) => new RegExp(c.regex, 'i').test(h)),
  flag_submitted: (st, c) => st.submitted.some((f) => (c.case_sensitive ? f.trim() === c.flag : f.trim().toLowerCase() === String(c.flag).toLowerCase())),
};

function evaluate(state, check) {
  const list = Array.isArray(check) ? check : [check];
  return list.every((c) => {
    const fn = CHECKS[c && c.type];
    try {
      return !!(fn && fn(state, c));
    } catch {
      return false;
    }
  });
}

/** Validates an authoring scenario. Returns [{ field, message }]. */
function validate(scenario) {
  const errs = [];
  const add = (message) => errs.push({ field: 'scenario', message });
  if (!scenario || typeof scenario !== 'object') return [{ field: 'scenario', message: 'The scenario must be a JSON object.' }];
  if (!Array.isArray(scenario.tasks) || !scenario.tasks.length) add('Add at least one task.');
  const ids = new Set();
  (scenario.tasks || []).forEach((t, i) => {
    if (!t.title) add(`Task ${i + 1} needs a title.`);
    if (!(Number(t.marks) > 0)) add(`Task ${i + 1} needs marks greater than 0.`);
    if (!t.id || ids.has(t.id)) add(`Task ${i + 1} needs a unique id.`);
    ids.add(t.id);
    const checks = Array.isArray(t.check) ? t.check : [t.check];
    checks.forEach((c) => {
      if (!c || !CHECKS[c.type]) add(`Task ${i + 1}: unknown check type “${c && c.type}”. Use one of: ${Object.keys(CHECKS).join(', ')}.`);
      if (c && c.regex) {
        try {
          RegExp(c.regex);
        } catch {
          add(`Task ${i + 1}: invalid regular expression.`);
        }
      }
    });
  });
  if (scenario.user && scenario.user !== 'root' && !(scenario.users || {})[scenario.user]) add(`The login user “${scenario.user}” must be listed under "users".`);
  try {
    const st = M.build(scenario);
    // A task that already passes before the candidate does anything is almost always an authoring mistake.
    (scenario.tasks || []).forEach((t, i) => {
      if (t.check && !Array.isArray(t.check) && t.check.type !== 'command_ran' && evaluate(st, t.check)) add(`Task ${i + 1} (“${t.title}”) already passes before the candidate does anything.`);
    });
  } catch (e) {
    add(`The scenario could not be built: ${e.message}`);
  }
  return errs;
}

/** Marks a lab: each task's marks if its check passes (task-based partial credit). */
function grade(scenario, state) {
  const tasks = (scenario.tasks || []).map((t) => ({ id: t.id, title: t.title, marks: Number(t.marks), passed: !!state && evaluate(state, t.check) }));
  const total = tasks.reduce((s, t) => s + t.marks, 0);
  const awarded = tasks.filter((t) => t.passed).reduce((s, t) => s + t.marks, 0);
  return { tasks, total, awarded, allPassed: tasks.length > 0 && tasks.every((t) => t.passed) };
}

/** What a candidate may see: the brief and the task list — never the checks, flags or files. */
function candidateBrief(scenario) {
  return { title: scenario.title || 'Lab', intro: scenario.intro || '', hostname: scenario.hostname || 'lab', user: scenario.user || 'root', tasks: (scenario.tasks || []).map((t) => ({ id: t.id, title: t.title, marks: Number(t.marks) })) };
}

const totalMarks = (scenario) => (scenario.tasks || []).reduce((s, t) => s + (Number(t.marks) || 0), 0);

module.exports = { CHECKS, evaluate, validate, grade, candidateBrief, totalMarks };
