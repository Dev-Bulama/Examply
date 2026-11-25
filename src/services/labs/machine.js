'use strict';

/**
 * A simulated Linux machine for cyber-security labs. Pure JavaScript, JSON-serialisable state, no access to the real
 * server. Every candidate gets their own copy, built from the question's scenario.
 *
 * state = {
 *   hostname, user, cwd, env, history[],
 *   fs: { '/etc/passwd': { type: 'file', content, mode: 0o644, owner, group } , '/var/log': { type: 'dir', mode, owner, group } },
 *   users: { root: { uid, groups[], shell, locked, home } },
 *   services: { ssh: { active, enabled, port, process } },
 *   processes: [{ pid, user, command, cpu }],
 *   firewall: { enabled, rules: [{ action: 'deny'|'allow', port, proto }] },
 *   crontab: { root: ['* * * * * /tmp/.x/beacon.sh'] },
 *   hosts: { '10.0.0.5': { name, ports: [{ port, service, version }] } },
 *   logins: [{ user, from, at }],
 *   submitted: [flag]
 * }
 */
const path = require('path').posix;

const MAX_FILE = 200000;
const MAX_FILES = 3000;

function norm(cwd, p) {
  if (!p) return cwd;
  let s = String(p);
  if (s === '~' || s.startsWith('~/')) s = `/root${s.slice(1)}`;
  const abs = s.startsWith('/') ? s : path.join(cwd, s);
  const out = path.normalize(abs);
  return out.length > 1 ? out.replace(/\/$/, '') : out;
}

function parentOf(p) {
  return path.dirname(p);
}

/** Builds a machine from a scenario (see services/labs/scenario.js for the format). */
function build(scenario) {
  const s = scenario;
  const user = s.user || 'root';
  const state = {
    hostname: s.hostname || 'lab',
    user,
    cwd: user === 'root' ? '/root' : `/home/${user}`,
    env: { HOME: user === 'root' ? '/root' : `/home/${user}`, USER: user, PATH: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin', SHELL: '/bin/bash' },
    history: [],
    fs: {},
    users: {},
    services: {},
    processes: [],
    firewall: { enabled: !!(s.firewall && s.firewall.enabled), rules: ((s.firewall && s.firewall.rules) || []).map((r) => ({ action: r.action, port: Number(r.port), proto: r.proto || 'tcp' })) },
    crontab: JSON.parse(JSON.stringify(s.crontab || {})),
    hosts: JSON.parse(JSON.stringify(s.hosts || {})),
    logins: JSON.parse(JSON.stringify(s.logins || [])),
    submitted: [],
  };
  const dir = (p, owner = 'root', mode = 0o755) => {
    if (!state.fs[p]) state.fs[p] = { type: 'dir', mode, owner, group: owner };
  };
  for (const d of ['/', '/bin', '/etc', '/home', '/root', '/tmp', '/var', '/var/log', '/var/www', '/usr', '/usr/bin', '/opt', '/etc/ssh', '/etc/cron.d']) dir(d, 'root', d === '/tmp' ? 0o1777 : d === '/root' ? 0o700 : 0o755);
  const users = { root: { uid: 0, groups: ['root'], shell: '/bin/bash', locked: false, home: '/root' }, ...(s.users || {}) };
  let uid = 1000;
  for (const [name, u] of Object.entries(users)) {
    state.users[name] = { uid: u.uid !== undefined ? u.uid : uid++, groups: u.groups || [name], shell: u.shell || '/bin/bash', locked: !!u.locked, home: u.home || (name === 'root' ? '/root' : `/home/${name}`) };
    dir(state.users[name].home, name, 0o750);
  }
  for (const [p, f] of Object.entries(s.files || {})) {
    const full = norm('/', p);
    let d = parentOf(full);
    const chain = [];
    while (!state.fs[d]) {
      chain.unshift(d);
      d = parentOf(d);
    }
    chain.forEach((c) => dir(c));
    if (f.type === 'dir') dir(full, f.owner || 'root', f.mode !== undefined ? Number(f.mode) : 0o755);
    else state.fs[full] = { type: 'file', content: String(f.content || ''), mode: f.mode !== undefined ? (typeof f.mode === 'string' ? parseInt(f.mode, 8) : f.mode) : 0o644, owner: f.owner || 'root', group: f.group || f.owner || 'root' };
  }
  writePasswd(state);
  let pid = 400;
  for (const [name, svc] of Object.entries(s.services || {})) {
    state.services[name] = { active: svc.active !== false, enabled: svc.enabled !== false, port: svc.port ? Number(svc.port) : null, description: svc.description || name, process: svc.process || `/usr/sbin/${name}` };
    if (state.services[name].active) state.processes.push({ pid: pid++, user: svc.user || 'root', command: state.services[name].process, service: name, cpu: 0.1 });
  }
  for (const p of s.processes || []) state.processes.push({ pid: p.pid || pid++, user: p.user || 'root', command: p.command, cpu: p.cpu || 0.0 });
  state.processes.sort((a, b) => a.pid - b.pid);
  return state;
}

/** Keeps /etc/passwd and /etc/shadow in step with state.users (the files are what candidates inspect). */
function writePasswd(state) {
  const lines = Object.entries(state.users).map(([n, u]) => `${n}:x:${u.uid}:${u.uid}:${n}:${u.home}:${u.shell}`);
  const shadow = Object.entries(state.users).map(([n, u]) => `${n}:${u.locked ? '!' : ''}$6$${Buffer.from(n).toString('base64').slice(0, 8)}$hash:19700:0:99999:7:::`);
  const prev = state.fs['/etc/shadow'];
  state.fs['/etc/passwd'] = { type: 'file', content: `${lines.join('\n')}\n`, mode: 0o644, owner: 'root', group: 'root' };
  state.fs['/etc/shadow'] = { type: 'file', content: `${shadow.join('\n')}\n`, mode: prev ? prev.mode : 0o640, owner: 'root', group: prev ? prev.group : 'shadow' };
}

// ---------------------------------------------------------------- File system helpers

function stat(state, p) {
  return state.fs[p] || null;
}

function children(state, dirPath) {
  const prefix = dirPath === '/' ? '/' : `${dirPath}/`;
  return Object.keys(state.fs)
    .filter((k) => k !== dirPath && k.startsWith(prefix) && !k.slice(prefix.length).includes('/'))
    .map((k) => k.slice(prefix.length))
    .sort();
}

function descendants(state, dirPath) {
  const prefix = dirPath === '/' ? '/' : `${dirPath}/`;
  return Object.keys(state.fs).filter((k) => k.startsWith(prefix));
}

function canRead(state, node) {
  if (state.user === 'root') return true;
  if (node.owner === state.user) return (node.mode & 0o400) !== 0;
  const u = state.users[state.user] || { groups: [] };
  if (u.groups.includes(node.group)) return (node.mode & 0o040) !== 0;
  return (node.mode & 0o004) !== 0;
}

function canWrite(state, node) {
  if (state.user === 'root') return true;
  if (node.owner === state.user) return (node.mode & 0o200) !== 0;
  return (node.mode & 0o002) !== 0;
}

function writeFile(state, p, content, append = false) {
  const existing = state.fs[p];
  const parent = state.fs[parentOf(p)];
  if (!parent || parent.type !== 'dir') throw new Error(`${p}: No such file or directory`);
  if (existing && existing.type === 'dir') throw new Error(`${p}: Is a directory`);
  if (existing && !canWrite(state, existing)) throw new Error(`${p}: Permission denied`);
  if (!existing && !canWrite(state, parent)) throw new Error(`${p}: Permission denied`);
  if (!existing && Object.keys(state.fs).length >= MAX_FILES) throw new Error('No space left on device');
  const text = append && existing ? existing.content + content : content;
  if (text.length > MAX_FILE) throw new Error('File too large');
  state.fs[p] = existing ? { ...existing, content: text } : { type: 'file', content: text, mode: 0o644, owner: state.user, group: state.user };
}

function modeString(node) {
  const m = node.mode;
  const t = node.type === 'dir' ? 'd' : '-';
  const bits = ['r', 'w', 'x'];
  let out = t;
  for (let i = 8; i >= 0; i -= 1) out += m & (1 << i) ? bits[(8 - i) % 3] : '-';
  if (m & 0o1000) out = `${out.slice(0, 9)}t`;
  return out;
}

/** Is a TCP port reachable from outside (service listening and not blocked by an enabled firewall)? */
function portOpen(state, port) {
  const svc = Object.values(state.services).find((s) => s.port === Number(port) && s.active);
  if (!svc) return false;
  if (!state.firewall.enabled) return true;
  const rule = [...state.firewall.rules].reverse().find((r) => r.port === Number(port));
  return !!rule && rule.action === 'allow';
}

module.exports = { build, writePasswd, norm, parentOf, stat, children, descendants, canRead, canWrite, writeFile, modeString, portOpen, MAX_FILE };
