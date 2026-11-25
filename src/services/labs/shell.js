'use strict';

/**
 * The lab shell: runs one command line against a machine state (see machine.js) and returns the output.
 * Supports quotes, $VARS, pipes (|), redirection (> >> <), sequences (; && ||), sudo, and about 50 commands
 * that cover Linux hardening and incident-response tasks. Unknown commands fail like bash does.
 */
const crypto = require('crypto');
const M = require('./machine');

const MAX_OUTPUT = 20000;

class ExitError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------- Parsing

/** Splits a line into tokens, honouring quotes and expanding $VARS (not inside single quotes). */
function tokenize(line, env) {
  const tokens = [];
  let cur = '';
  let has = false;
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '$' && quote === '"') {
        const m = /^\$(\w+|\{\w+\})/.exec(line.slice(i));
        if (m) {
          cur += env[m[1].replace(/[{}]/g, '')] || '';
          i += m[0].length - 1;
        } else cur += c;
      } else if (c === '\\' && quote === '"' && i + 1 < line.length) cur += line[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      has = true;
    } else if (c === '\\' && i + 1 < line.length) {
      cur += line[++i];
      has = true;
    } else if (c === '$') {
      const m = /^\$(\w+|\{\w+\}|\?)/.exec(line.slice(i));
      if (m) {
        cur += env[m[1].replace(/[{}]/g, '')] || '';
        i += m[0].length - 1;
        has = true;
      } else {
        cur += c;
        has = true;
      }
    } else if (/\s/.test(c)) {
      if (has) tokens.push(cur);
      cur = '';
      has = false;
    } else if (c === '|' || c === ';' || c === '&' || c === '>' || c === '<') {
      if (has) tokens.push(cur);
      cur = '';
      has = false;
      const two = line.slice(i, i + 2);
      if (two === '&&' || two === '||' || two === '>>') {
        tokens.push({ op: two });
        i += 1;
      } else tokens.push({ op: c });
    } else {
      cur += c;
      has = true;
    }
  }
  if (quote) throw new ExitError('bash: unexpected EOF while looking for matching quote', 2);
  if (has) tokens.push(cur);
  return tokens;
}

/** Groups tokens into a list of { cond, pipeline: [{ argv, redirects }] }. */
function parse(tokens) {
  const list = [];
  let cond = null;
  let pipeline = [];
  let cmd = { argv: [], redirects: [] };
  const endCmd = () => {
    if (cmd.argv.length || cmd.redirects.length) pipeline.push(cmd);
    cmd = { argv: [], redirects: [] };
  };
  const endPipeline = (nextCond) => {
    endCmd();
    if (pipeline.length) list.push({ cond, pipeline });
    pipeline = [];
    cond = nextCond;
  };
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (typeof t === 'string') cmd.argv.push(t);
    else if (t.op === '|') endCmd();
    else if (t.op === ';') endPipeline(null);
    else if (t.op === '&&') endPipeline('and');
    else if (t.op === '||') endPipeline('or');
    else if (t.op === '&') endPipeline(null);
    else if (t.op === '>' || t.op === '>>' || t.op === '<') {
      const target = tokens[i + 1];
      if (typeof target !== 'string') throw new ExitError("bash: syntax error near unexpected token `newline'", 2);
      cmd.redirects.push({ op: t.op, target });
      i += 1;
    }
  }
  endPipeline(null);
  return list;
}

// ---------------------------------------------------------------- Helpers

function flags(argv, known = '') {
  const opts = {};
  const args = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--') {
      args.push(...argv.slice(i + 1));
      break;
    }
    if (/^-[a-zA-Z]+$/.test(a) && !/^-\d+$/.test(a)) {
      for (const ch of a.slice(1)) {
        if (known.includes(`${ch}:`)) {
          opts[ch] = a.length > 2 && a.indexOf(ch) < a.length - 1 ? a.slice(a.indexOf(ch) + 1) : argv[++i];
          break;
        }
        opts[ch] = true;
      }
    } else if (/^--[\w-]+(=.*)?$/.test(a)) {
      const [k, v] = a.slice(2).split('=');
      opts[k] = v === undefined ? true : v;
    } else args.push(a);
  }
  return { opts, args };
}

function readFile(state, p) {
  const node = M.stat(state, p);
  if (!node) throw new ExitError(`${p}: No such file or directory`);
  if (node.type === 'dir') throw new ExitError(`${p}: Is a directory`);
  if (!M.canRead(state, node)) throw new ExitError(`${p}: Permission denied`);
  return node.content;
}

/** Input text for filters: named files, or stdin. */
function inputOf(state, args, stdin, name) {
  if (!args.length) return stdin;
  return args
    .map((a) => {
      try {
        return readFile(state, M.norm(state.cwd, a));
      } catch (e) {
        throw new ExitError(`${name}: ${e.message}`);
      }
    })
    .join('');
}

const lines = (t) => (t === '' ? [] : t.replace(/\n$/, '').split('\n'));
const join = (arr) => (arr.length ? `${arr.join('\n')}\n` : '');

function globToRegExp(g) {
  return new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
}

/** Expands * and ? in arguments against the file system (bash-style; no match = literal). */
function expandGlobs(state, argv) {
  const out = [];
  for (const a of argv) {
    if (!/[*?]/.test(a) || a.startsWith('-')) {
      out.push(a);
      continue;
    }
    const abs = M.norm(state.cwd, a);
    const dir = M.parentOf(abs);
    const re = globToRegExp(abs.slice(dir === '/' ? 1 : dir.length + 1));
    const matches = M.children(state, dir).filter((n) => re.test(n) && !n.startsWith('.'));
    if (!matches.length) out.push(a);
    else out.push(...matches.map((n) => (a.startsWith('/') ? `${dir === '/' ? '' : dir}/${n}` : `${a.includes('/') ? a.slice(0, a.lastIndexOf('/') + 1) : ''}${n}`)));
  }
  return out;
}

const needRoot = (state, cmd) => {
  if (state.user !== 'root') throw new ExitError(`${cmd}: Permission denied (are you root? try sudo)`);
};

function parseMode(spec, current) {
  if (/^[0-7]{3,4}$/.test(spec)) return parseInt(spec, 8);
  const m = /^([ugoa]*)([+-=])([rwxt]+)$/.exec(spec);
  if (!m) throw new ExitError(`chmod: invalid mode: '${spec}'`);
  const who = m[1] || 'a';
  let bits = 0;
  for (const p of m[3]) {
    if (p === 't') {
      bits |= 0o1000;
      continue;
    }
    const v = { r: 4, w: 2, x: 1 }[p];
    if (who.includes('u') || who.includes('a')) bits |= v << 6;
    if (who.includes('g') || who.includes('a')) bits |= v << 3;
    if (who.includes('o') || who.includes('a')) bits |= v;
  }
  if (m[2] === '+') return current | bits;
  if (m[2] === '-') return current & ~bits;
  return bits;
}

// ---------------------------------------------------------------- Commands

const COMMANDS = {
  help: () => `Common commands: ls cd pwd cat less head tail grep sed find wc sort uniq cut awk echo touch mkdir rm cp mv chmod chown stat
users & auth: whoami id passwd usermod userdel useradd groups last sudo
services: ps kill systemctl ss netstat ufw iptables crontab journalctl
network: nmap curl ping hostname ip
tools: sha256sum md5sum base64 history clear env export which date uname
Submit an answer you found (a flag, an IP address…) with:  submit <answer>
`,
  pwd: (st) => `${st.cwd}\n`,
  whoami: (st) => `${st.user}\n`,
  hostname: (st) => `${st.hostname}\n`,
  id: (st, a) => {
    const name = a[0] || st.user;
    const u = st.users[name];
    if (!u) throw new ExitError(`id: '${name}': no such user`);
    return `uid=${u.uid}(${name}) gid=${u.uid}(${name}) groups=${u.groups.map((g) => g).join(',')}\n`;
  },
  groups: (st, a) => {
    const name = a[0] || st.user;
    if (!st.users[name]) throw new ExitError(`groups: '${name}': no such user`);
    return `${name} : ${st.users[name].groups.join(' ')}\n`;
  },
  uname: (st, a) => (a.includes('-a') ? `Linux ${st.hostname} 6.1.0-18-amd64 #1 SMP Debian 6.1.76-1 x86_64 GNU/Linux\n` : 'Linux\n'),
  date: () => `${new Date().toUTCString().replace('GMT', 'UTC')}\n`,
  clear: () => '\u001b[2J\u001b[H',
  echo: (st, a) => {
    const n = a[0] === '-n';
    const text = (n ? a.slice(1) : a).join(' ');
    return n ? text : `${text}\n`;
  },
  env: (st) => join(Object.entries(st.env).map(([k, v]) => `${k}=${v}`)),
  export: (st, a) => {
    for (const kv of a) {
      const [k, ...v] = kv.split('=');
      if (/^\w+$/.test(k)) st.env[k] = v.join('=');
    }
    return '';
  },
  which: (st, a) => join(a.filter((c) => COMMANDS[c]).map((c) => `/usr/bin/${c}`)),
  history: (st) => join(st.history.map((h, i) => `${String(i + 1).padStart(5)}  ${h}`)),
  cd: (st, a) => {
    const target = M.norm(st.cwd, a[0] || st.env.HOME);
    const node = M.stat(st, target);
    if (!node) throw new ExitError(`cd: ${a[0]}: No such file or directory`);
    if (node.type !== 'dir') throw new ExitError(`cd: ${a[0]}: Not a directory`);
    if (!M.canRead(st, node)) throw new ExitError(`cd: ${a[0]}: Permission denied`);
    st.cwd = target;
    return '';
  },
  ls: (st, argv) => {
    const { opts, args } = flags(argv);
    const all = opts.a || opts.A;
    const long = opts.l;
    const targets = args.length ? args : ['.'];
    const out = [];
    for (const t of targets) {
      const p = M.norm(st.cwd, t);
      const node = M.stat(st, p);
      if (!node) throw new ExitError(`ls: cannot access '${t}': No such file or directory`, 2);
      if (node.type === 'dir' && !M.canRead(st, node)) throw new ExitError(`ls: cannot open directory '${t}': Permission denied`, 2);
      const names = node.type === 'dir' ? M.children(st, p).filter((n) => all || !n.startsWith('.')) : [t];
      if (targets.length > 1) out.push(`${t}:`);
      const full = (n) => (node.type === 'dir' ? (p === '/' ? `/${n}` : `${p}/${n}`) : p);
      if (long) {
        if (node.type === 'dir') out.push(`total ${names.length * 4}`);
        for (const n of names) {
          const f = M.stat(st, full(n));
          out.push(`${M.modeString(f)} 1 ${f.owner.padEnd(8)} ${f.group.padEnd(8)} ${String(f.type === 'dir' ? 4096 : f.content.length).padStart(6)} Nov 24 09:14 ${n}`);
        }
      } else out.push(names.join('  '));
    }
    return join(out.filter((x) => x !== ''));
  },
  /** sed: s/find/replace/[gi] and /pattern/d expressions, with -i to edit files in place. */
  sed: (st, argv, stdin) => {
    const inPlace = argv.includes('-i');
    const rest = argv.filter((x) => x !== '-i' && x !== '-e' && x !== '-E');
    const expr = rest.shift();
    if (!expr) throw new ExitError('Usage: sed [-i] \'s/find/replace/g\' [file]');
    let apply;
    const sub = /^s(.)(.*?)\1(.*?)\1([gi]*)$/.exec(expr);
    const del = /^\/(.*)\/d$/.exec(expr);
    try {
      if (sub) {
        const re = new RegExp(sub[2], sub[4].includes('i') ? 'i' : '');
        const reG = new RegExp(sub[2], `g${sub[4].includes('i') ? 'i' : ''}`);
        const to = sub[3].replace(/\\\//g, '/').replace(/&/g, '$$&');
        apply = (text) => lines(text).map((l) => l.replace(sub[4].includes('g') ? reG : re, to));
      } else if (del) {
        const re = new RegExp(del[1]);
        apply = (text) => lines(text).filter((l) => !re.test(l));
      } else throw new Error('x');
    } catch {
      throw new ExitError(`sed: -e expression #1: unknown command: \`${expr}'`);
    }
    if (!inPlace) return join(apply(inputOf(st, rest, stdin, 'sed')));
    if (!rest.length) throw new ExitError('sed: no input files');
    for (const f of rest) {
      const full = M.norm(st.cwd, f);
      let text;
      try {
        text = readFile(st, full);
      } catch (e) {
        throw new ExitError(`sed: ${e.message}`);
      }
      try {
        M.writeFile(st, full, join(apply(text)));
      } catch (e) {
        throw new ExitError(`sed: couldn't edit ${f}: ${e.message.replace(/^.*: /, '')}`);
      }
    }
    return '';
  },
  cat: (st, a, stdin) => inputOf(st, a.filter((x) => x !== '-n'), stdin, 'cat'),
  less: (st, a, stdin) => inputOf(st, a, stdin, 'less'),
  more: (st, a, stdin) => inputOf(st, a, stdin, 'more'),
  head: (st, argv, stdin) => {
    const { opts, args } = flags(argv.map((x) => (/^-\d+$/.test(x) ? `-n${x.slice(1)}` : x)), 'n:');
    return join(lines(inputOf(st, args, stdin, 'head')).slice(0, Number(opts.n) || 10));
  },
  tail: (st, argv, stdin) => {
    const { opts, args } = flags(argv.map((x) => (/^-\d+$/.test(x) ? `-n${x.slice(1)}` : x)), 'n:');
    const n = Number(opts.n) || 10;
    return join(lines(inputOf(st, args, stdin, 'tail')).slice(-n));
  },
  wc: (st, argv, stdin) => {
    const { opts, args } = flags(argv);
    const t = inputOf(st, args, stdin, 'wc');
    const l = (t.match(/\n/g) || []).length;
    const w = t.split(/\s+/).filter(Boolean).length;
    if (opts.l) return `${l}\n`;
    if (opts.w) return `${w}\n`;
    if (opts.c) return `${t.length}\n`;
    return `${l} ${w} ${t.length}\n`;
  },
  sort: (st, argv, stdin) => {
    const { opts, args } = flags(argv);
    let arr = lines(inputOf(st, args, stdin, 'sort'));
    arr = opts.n ? arr.sort((x, y) => parseFloat(x) - parseFloat(y)) : arr.sort();
    if (opts.r) arr.reverse();
    if (opts.u) arr = [...new Set(arr)];
    return join(arr);
  },
  uniq: (st, argv, stdin) => {
    const { opts, args } = flags(argv);
    const arr = lines(inputOf(st, args, stdin, 'uniq'));
    const out = [];
    for (const l of arr) {
      if (out.length && out[out.length - 1].l === l) out[out.length - 1].n += 1;
      else out.push({ l, n: 1 });
    }
    return join(out.map((o) => (opts.c ? `${String(o.n).padStart(7)} ${o.l}` : o.l)));
  },
  cut: (st, argv, stdin) => {
    const { opts, args } = flags(argv, 'd:f:');
    const d = opts.d || '\t';
    const fields = String(opts.f || '1').split(',').map(Number);
    return join(lines(inputOf(st, args, stdin, 'cut')).map((l) => fields.map((f) => l.split(d)[f - 1] || '').join(d)));
  },
  awk: (st, argv, stdin) => {
    const { opts, args } = flags(argv, 'F:');
    const prog = args.shift() || '';
    const m = /^\s*(?:\/(.*)\/\s*)?\{\s*print\s+([^}]*)\}\s*$/.exec(prog);
    if (!m) throw new ExitError("awk: only patterns like '/regex/ {print $1, $3}' are supported in this lab");
    const re = m[1] ? new RegExp(m[1]) : null;
    const sep = opts.F ? new RegExp(opts.F.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) : /\s+/;
    const cols = m[2].split(',').map((x) => x.trim());
    return join(
      lines(inputOf(st, args, stdin, 'awk'))
        .filter((l) => !re || re.test(l))
        .map((l) => {
          const f = l.trim().split(sep);
          return cols.map((c) => (c === '$0' ? l : /^\$\d+$/.test(c) ? f[Number(c.slice(1)) - 1] || '' : c === 'NF' ? String(f.length) : c.replace(/^"|"$/g, ''))).join(' ');
        }),
    );
  },
  grep: (st, argv, stdin) => {
    const { opts, args } = flags(argv, 'e:');
    const pattern = opts.e || args.shift();
    if (pattern === undefined) throw new ExitError('Usage: grep [OPTION]... PATTERNS [FILE]...', 2);
    let re;
    try {
      re = new RegExp(opts.F ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : pattern.replace(/\\\|/g, '|'), opts.i ? 'i' : '');
    } catch {
      throw new ExitError('grep: Invalid regular expression', 2);
    }
    const out = [];
    let count = 0;
    const scan = (text, label) => {
      lines(text).forEach((l, i) => {
        if (re.test(l) !== !!opts.v) {
          count += 1;
          if (!opts.c && !opts.l) out.push(`${label ? `${label}:` : ''}${opts.n ? `${i + 1}:` : ''}${l}`);
        }
      });
    };
    if (!args.length) scan(stdin, '');
    else {
      const files = [];
      for (const a of args) {
        const p = M.norm(st.cwd, a);
        const node = M.stat(st, p);
        if (!node) throw new ExitError(`grep: ${a}: No such file or directory`, 2);
        if (node.type === 'dir') {
          if (!(opts.r || opts.R)) throw new ExitError(`grep: ${a}: Is a directory`, 2);
          files.push(...M.descendants(st, p).filter((k) => st.fs[k].type === 'file' && M.canRead(st, st.fs[k])));
        } else files.push(p);
      }
      const multi = files.length > 1 || opts.r || opts.R;
      for (const f of files) {
        const before = count;
        scan(readFile(st, f), multi ? f : '');
        if (opts.l && count > before) out.push(f);
      }
    }
    if (opts.c) return `${count}\n`;
    if (!count) throw new ExitError('', 1);
    return join(out);
  },
  find: (st, argv) => {
    const start = argv[0] && !argv[0].startsWith('-') ? argv[0] : '.';
    const rest = argv[0] && !argv[0].startsWith('-') ? argv.slice(1) : argv;
    const root = M.norm(st.cwd, start);
    if (!M.stat(st, root)) throw new ExitError(`find: '${start}': No such file or directory`);
    const crit = {};
    for (let i = 0; i < rest.length; i += 1) crit[rest[i].replace(/^-/, '')] = rest[i + 1] && !rest[i + 1].startsWith('-') ? rest[++i] : true;
    const nameRe = crit.name ? globToRegExp(crit.name) : null;
    const all = [root, ...M.descendants(st, root)].filter((k) => st.fs[k]);
    const res = all.filter((k) => {
      const n = st.fs[k];
      if (crit.type && (crit.type === 'f' ? n.type !== 'file' : n.type !== 'dir')) return false;
      if (nameRe && !nameRe.test(k.split('/').pop())) return false;
      if (crit.user && n.owner !== crit.user) return false;
      if (crit.perm) {
        const want = String(crit.perm);
        if (want.startsWith('-')) {
          const bits = parseInt(want.slice(1), 8);
          if ((n.mode & bits) !== bits) return false;
        } else if (want.startsWith('/')) {
          if (!(n.mode & parseInt(want.slice(1), 8))) return false;
        } else if (n.mode !== parseInt(want, 8)) return false;
      }
      return true;
    });
    return join(res.map((k) => (start.startsWith('/') ? k : k === root ? start : `${start === '.' ? '.' : start}${k.slice(root === '/' ? 0 : root.length)}`)));
  },
  touch: (st, a) => {
    for (const f of a) {
      const p = M.norm(st.cwd, f);
      if (!M.stat(st, p)) M.writeFile(st, p, '');
    }
    return '';
  },
  mkdir: (st, argv) => {
    const { opts, args } = flags(argv);
    for (const d of args) {
      const p = M.norm(st.cwd, d);
      if (M.stat(st, p)) {
        if (!opts.p) throw new ExitError(`mkdir: cannot create directory '${d}': File exists`);
        continue;
      }
      const parent = M.stat(st, M.parentOf(p));
      if (!parent) {
        if (!opts.p) throw new ExitError(`mkdir: cannot create directory '${d}': No such file or directory`);
        COMMANDS.mkdir(st, ['-p', M.parentOf(p)]);
      } else if (!M.canWrite(st, parent)) throw new ExitError(`mkdir: cannot create directory '${d}': Permission denied`);
      st.fs[p] = { type: 'dir', mode: 0o755, owner: st.user, group: st.user };
    }
    return '';
  },
  rm: (st, argv) => {
    const { opts, args } = flags(argv);
    for (const f of args) {
      const p = M.norm(st.cwd, f);
      const node = M.stat(st, p);
      if (!node) {
        if (opts.f) continue;
        throw new ExitError(`rm: cannot remove '${f}': No such file or directory`);
      }
      if (p === '/' || ['/etc', '/bin', '/usr', '/var', '/root', '/home'].includes(p)) throw new ExitError(`rm: refusing to remove '${f}' in this lab`);
      const parent = M.stat(st, M.parentOf(p));
      if (!M.canWrite(st, parent)) throw new ExitError(`rm: cannot remove '${f}': Permission denied`);
      if (node.type === 'dir') {
        if (!(opts.r || opts.R)) throw new ExitError(`rm: cannot remove '${f}': Is a directory`);
        for (const k of M.descendants(st, p)) delete st.fs[k];
      }
      delete st.fs[p];
    }
    return '';
  },
  cp: (st, argv) => {
    const { args } = flags(argv);
    if (args.length < 2) throw new ExitError('cp: missing destination file operand');
    const dest = M.norm(st.cwd, args.pop());
    for (const s of args) {
      const content = readFile(st, M.norm(st.cwd, s));
      const target = M.stat(st, dest) && M.stat(st, dest).type === 'dir' ? `${dest}/${s.split('/').pop()}` : dest;
      M.writeFile(st, target, content);
    }
    return '';
  },
  mv: (st, argv) => {
    const { args } = flags(argv);
    if (args.length !== 2) throw new ExitError('mv: missing destination file operand');
    const from = M.norm(st.cwd, args[0]);
    const node = M.stat(st, from);
    if (!node) throw new ExitError(`mv: cannot stat '${args[0]}': No such file or directory`);
    let to = M.norm(st.cwd, args[1]);
    if (M.stat(st, to) && M.stat(st, to).type === 'dir') to = `${to}/${from.split('/').pop()}`;
    if (!M.canWrite(st, M.stat(st, M.parentOf(from)))) throw new ExitError(`mv: cannot move '${args[0]}': Permission denied`);
    for (const k of [from, ...M.descendants(st, from)]) {
      st.fs[to + k.slice(from.length)] = st.fs[k];
      delete st.fs[k];
    }
    return '';
  },
  chmod: (st, argv) => {
    const { opts, args } = flags(argv);
    const spec = args.shift();
    for (const f of args) {
      const p = M.norm(st.cwd, f);
      const node = M.stat(st, p);
      if (!node) throw new ExitError(`chmod: cannot access '${f}': No such file or directory`);
      if (st.user !== 'root' && node.owner !== st.user) throw new ExitError(`chmod: changing permissions of '${f}': Operation not permitted`);
      for (const k of opts.R ? [p, ...M.descendants(st, p)] : [p]) st.fs[k].mode = parseMode(spec, st.fs[k].mode);
    }
    return '';
  },
  chown: (st, argv) => {
    needRoot(st, 'chown');
    const { opts, args } = flags(argv);
    const [owner, group] = String(args.shift() || '').split(':');
    if (owner && !st.users[owner]) throw new ExitError(`chown: invalid user: '${owner}'`);
    for (const f of args) {
      const p = M.norm(st.cwd, f);
      if (!M.stat(st, p)) throw new ExitError(`chown: cannot access '${f}': No such file or directory`);
      for (const k of opts.R ? [p, ...M.descendants(st, p)] : [p]) {
        if (owner) st.fs[k].owner = owner;
        if (group) st.fs[k].group = group;
      }
    }
    return '';
  },
  stat: (st, a) =>
    join(
      a.map((f) => {
        const p = M.norm(st.cwd, f);
        const n = M.stat(st, p);
        if (!n) throw new ExitError(`stat: cannot statx '${f}': No such file or directory`);
        return `  File: ${p}\n  Size: ${n.type === 'dir' ? 4096 : n.content.length}\t${n.type === 'dir' ? 'directory' : 'regular file'}\nAccess: (0${(n.mode & 0o7777).toString(8)}/${M.modeString(n)})  Uid: ( ${st.users[n.owner] ? st.users[n.owner].uid : 0}/ ${n.owner})   Gid: (${n.group})`;
      }),
    ),
  sha256sum: (st, a, stdin) => (a.length ? join(a.map((f) => `${crypto.createHash('sha256').update(readFile(st, M.norm(st.cwd, f))).digest('hex')}  ${f}`)) : `${crypto.createHash('sha256').update(stdin).digest('hex')}  -\n`),
  md5sum: (st, a, stdin) => (a.length ? join(a.map((f) => `${crypto.createHash('md5').update(readFile(st, M.norm(st.cwd, f))).digest('hex')}  ${f}`)) : `${crypto.createHash('md5').update(stdin).digest('hex')}  -\n`),
  base64: (st, argv, stdin) => {
    const { opts, args } = flags(argv);
    const t = inputOf(st, args, stdin, 'base64');
    return opts.d ? Buffer.from(t.trim(), 'base64').toString('utf8') : `${Buffer.from(t).toString('base64')}\n`;
  },
  // ---- users
  passwd: (st, argv) => {
    const { opts, args } = flags(argv);
    const name = args[0] || st.user;
    if (name !== st.user) needRoot(st, 'passwd');
    if (!st.users[name]) throw new ExitError(`passwd: user '${name}' does not exist`);
    if (opts.l) {
      st.users[name].locked = true;
      M.writePasswd(st);
      return `passwd: password for ${name} locked\n`;
    }
    if (opts.u) {
      st.users[name].locked = false;
      M.writePasswd(st);
      return `passwd: password for ${name} unlocked\n`;
    }
    return 'passwd: password changes are not possible in this lab (use -l to lock an account)\n';
  },
  usermod: (st, argv) => {
    needRoot(st, 'usermod');
    const { opts, args } = flags(argv, 's:G:');
    const u = st.users[args[0]];
    if (!u) throw new ExitError(`usermod: user '${args[0]}' does not exist`, 6);
    if (opts.L) u.locked = true;
    if (opts.U) u.locked = false;
    if (opts.s) u.shell = opts.s;
    if (opts.G) u.groups = opts.a ? [...new Set([...u.groups, ...opts.G.split(',')])] : [args[0], ...opts.G.split(',')];
    M.writePasswd(st);
    return '';
  },
  gpasswd: (st, argv) => {
    needRoot(st, 'gpasswd');
    const { opts, args } = flags(argv, 'd:a:');
    const group = args[0];
    const name = opts.d || opts.a;
    if (!st.users[name]) throw new ExitError(`gpasswd: user '${name}' does not exist`);
    st.users[name].groups = opts.d ? st.users[name].groups.filter((g) => g !== group) : [...new Set([...st.users[name].groups, group])];
    return opts.d ? `Removing user ${name} from group ${group}\n` : `Adding user ${name} to group ${group}\n`;
  },
  deluser: (st, argv, stdin) => COMMANDS.userdel(st, argv, stdin),
  userdel: (st, argv) => {
    needRoot(st, 'userdel');
    const { opts, args } = flags(argv);
    const name = args[0];
    if (!st.users[name]) throw new ExitError(`userdel: user '${name}' does not exist`, 6);
    if (name === 'root') throw new ExitError('userdel: cannot remove root');
    if (st.processes.some((p) => p.user === name)) throw new ExitError(`userdel: user ${name} is currently used by process ${st.processes.find((p) => p.user === name).pid}`, 8);
    const home = st.users[name].home;
    delete st.users[name];
    if (opts.r) for (const k of [home, ...M.descendants(st, home)]) delete st.fs[k];
    delete st.crontab[name];
    M.writePasswd(st);
    return '';
  },
  useradd: (st, argv) => {
    needRoot(st, 'useradd');
    const { opts, args } = flags(argv, 's:G:');
    const name = args[0];
    if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(name || '')) throw new ExitError('useradd: invalid user name');
    if (st.users[name]) throw new ExitError(`useradd: user '${name}' already exists`, 9);
    const uid = Math.max(...Object.values(st.users).map((u) => u.uid)) + 1;
    st.users[name] = { uid, groups: [name, ...(opts.G ? opts.G.split(',') : [])], shell: opts.s || '/bin/sh', locked: true, home: `/home/${name}` };
    if (opts.m) st.fs[`/home/${name}`] = { type: 'dir', mode: 0o750, owner: name, group: name };
    M.writePasswd(st);
    return '';
  },
  last: (st) => join([...st.logins].reverse().map((l) => `${l.user.padEnd(9)}pts/0        ${String(l.from).padEnd(17)}${l.at}`).concat(['', 'wtmp begins Mon Nov 17 06:02:11 2026'])),
  who: (st) => `${st.user}     pts/0        2026-11-24 09:10 (10.0.0.2)\n`,
  w: (st) => COMMANDS.who(st),
  // ---- processes & services
  ps: (st) => join(['USER         PID %CPU COMMAND', ...st.processes.map((p) => `${p.user.padEnd(12)}${String(p.pid).padStart(4)} ${String(p.cpu.toFixed(1)).padStart(4)} ${p.command}`)]),
  kill: (st, argv) => {
    const { args } = flags(argv.filter((x) => !/^-(9|15|KILL|TERM|s)$/.test(x)));
    for (const a of args) {
      const pid = Number(a);
      const i = st.processes.findIndex((p) => p.pid === pid);
      if (i < 0) throw new ExitError(`kill: (${a}) - No such process`);
      if (st.user !== 'root' && st.processes[i].user !== st.user) throw new ExitError(`kill: (${a}) - Operation not permitted`);
      const [proc] = st.processes.splice(i, 1);
      if (proc.service && st.services[proc.service]) st.services[proc.service].active = false;
    }
    return '';
  },
  pkill: (st, argv) => {
    const name = argv.filter((x) => !x.startsWith('-'))[0];
    const victims = st.processes.filter((p) => p.command.includes(name));
    if (!victims.length) throw new ExitError('', 1);
    return COMMANDS.kill(st, victims.map((p) => String(p.pid)));
  },
  systemctl: (st, argv) => {
    const [action, unitRaw] = argv.filter((x) => !x.startsWith('-'));
    const unit = String(unitRaw || '').replace(/\.service$/, '');
    if (action === 'list-units' || action === 'list-unit-files' || !action) return join(Object.entries(st.services).map(([n, s]) => `${(`${n}.service`).padEnd(28)}${s.enabled ? 'enabled ' : 'disabled'}  ${s.active ? 'active (running)' : 'inactive (dead)'}`));
    const svc = st.services[unit];
    if (!svc) throw new ExitError(`Unit ${unit}.service could not be found.`, 4);
    if (action === 'status' || action === 'is-active' || action === 'is-enabled') {
      if (action === 'is-active') return `${svc.active ? 'active' : 'inactive'}\n`;
      if (action === 'is-enabled') return `${svc.enabled ? 'enabled' : 'disabled'}\n`;
      return `● ${unit}.service - ${svc.description}\n     Loaded: loaded (/lib/systemd/system/${unit}.service; ${svc.enabled ? 'enabled' : 'disabled'})\n     Active: ${svc.active ? 'active (running)' : 'inactive (dead)'}\n${svc.port ? `     Listen: 0.0.0.0:${svc.port}\n` : ''}`;
    }
    needRoot(st, 'systemctl');
    if (action === 'stop' || action === 'start' || action === 'restart') {
      svc.active = action !== 'stop';
      st.processes = st.processes.filter((p) => p.service !== unit);
      if (svc.active) st.processes.push({ pid: 900 + st.processes.length, user: 'root', command: svc.process, service: unit, cpu: 0.0 });
      return '';
    }
    if (action === 'enable' || action === 'disable') {
      svc.enabled = action === 'enable';
      if (argv.includes('--now')) COMMANDS.systemctl(st, [action === 'enable' ? 'start' : 'stop', unit]);
      return action === 'disable' ? `Removed /etc/systemd/system/multi-user.target.wants/${unit}.service.\n` : `Created symlink /etc/systemd/system/multi-user.target.wants/${unit}.service.\n`;
    }
    if (action === 'mask') {
      svc.enabled = false;
      svc.active = false;
      st.processes = st.processes.filter((p) => p.service !== unit);
      return `Created symlink /etc/systemd/system/${unit}.service → /dev/null.\n`;
    }
    throw new ExitError(`Unknown command verb ${action}.`);
  },
  service: (st, argv) => COMMANDS.systemctl(st, [argv[1], argv[0]]),
  ss: (st) => join(['State   Recv-Q  Send-Q   Local Address:Port   Process', ...Object.entries(st.services).filter(([, s]) => s.active && s.port).map(([n, s]) => `LISTEN  0       128          0.0.0.0:${String(s.port).padEnd(8)}users:(("${n}"))`)]),
  netstat: (st) => join(['Proto Local Address           State       PID/Program name', ...Object.entries(st.services).filter(([, s]) => s.active && s.port).map(([n, s]) => `tcp   0.0.0.0:${String(s.port).padEnd(17)}LISTEN      -/${n}`)]),
  ufw: (st, argv) => {
    const [action, ...rest] = argv;
    if (action === 'status') return `Status: ${st.firewall.enabled ? 'active' : 'inactive'}\n${st.firewall.enabled && st.firewall.rules.length ? `\nTo                         Action      From\n--                         ------      ----\n${st.firewall.rules.map((r) => `${`${r.port}/${r.proto}`.padEnd(27)}${r.action.toUpperCase().padEnd(12)}Anywhere`).join('\n')}\n` : ''}`;
    needRoot(st, 'ufw');
    if (action === 'enable') {
      st.firewall.enabled = true;
      return 'Firewall is active and enabled on system startup\n';
    }
    if (action === 'disable') {
      st.firewall.enabled = false;
      return 'Firewall stopped and disabled on system startup\n';
    }
    if (action === 'allow' || action === 'deny' || action === 'reject') {
      const m = /^(\d+)(?:\/(tcp|udp))?$/.exec(rest[0] || '');
      const known = { ssh: 22, http: 80, https: 443, telnet: 23, ftp: 21, mysql: 3306 };
      const port = m ? Number(m[1]) : known[rest[0]];
      if (!port) throw new ExitError('ERROR: Could not find a profile matching that port');
      st.firewall.rules = st.firewall.rules.filter((r) => r.port !== port);
      st.firewall.rules.push({ action: action === 'allow' ? 'allow' : 'deny', port, proto: (m && m[2]) || 'tcp' });
      return 'Rule added\n';
    }
    if (action === 'delete') {
      const port = Number(String(rest[1] || '').split('/')[0]);
      st.firewall.rules = st.firewall.rules.filter((r) => r.port !== port);
      return 'Rule deleted\n';
    }
    throw new ExitError('ERROR: Invalid syntax');
  },
  iptables: (st, argv) => {
    if (argv.includes('-L')) return `Chain INPUT (policy ACCEPT)\ntarget     prot opt source               destination\n${st.firewall.rules.map((r) => `${r.action === 'allow' ? 'ACCEPT' : 'DROP'}       ${r.proto}  --  anywhere             anywhere             ${r.proto} dpt:${r.port}`).join('\n')}\n`;
    needRoot(st, 'iptables');
    const i = argv.indexOf('--dport');
    const j = argv.indexOf('-j');
    if (i < 0 || j < 0) throw new ExitError('iptables: only "-A INPUT -p tcp --dport PORT -j DROP|ACCEPT|REJECT" is supported in this lab');
    st.firewall.enabled = true;
    const port = Number(argv[i + 1]);
    st.firewall.rules = st.firewall.rules.filter((r) => r.port !== port);
    st.firewall.rules.push({ action: argv[j + 1] === 'ACCEPT' ? 'allow' : 'deny', port, proto: 'tcp' });
    return '';
  },
  crontab: (st, argv) => {
    const { opts } = flags(argv, 'u:');
    const who = opts.u || st.user;
    if (who !== st.user) needRoot(st, 'crontab');
    if (opts.r) {
      delete st.crontab[who];
      return '';
    }
    if (opts.l) {
      const c = st.crontab[who];
      if (!c || !c.length) throw new ExitError(`no crontab for ${who}`);
      return join(c);
    }
    throw new ExitError('crontab: use -l to list or -r to remove (editing is not available in this lab)');
  },
  journalctl: (st, argv) => {
    const { opts } = flags(argv, 'u:n:');
    const log = st.fs['/var/log/syslog'] ? st.fs['/var/log/syslog'].content : '';
    let arr = lines(log);
    if (opts.u) arr = arr.filter((l) => l.includes(String(opts.u).replace(/\.service$/, '')));
    if (opts.n) arr = arr.slice(-Number(opts.n));
    return join(arr.length ? arr : ['-- No entries --']);
  },
  // ---- network
  ip: () => '1: lo: <LOOPBACK,UP> mtu 65536\n    inet 127.0.0.1/8 scope host lo\n2: eth0: <BROADCAST,MULTICAST,UP> mtu 1500\n    inet 10.0.0.10/24 brd 10.0.0.255 scope global eth0\n',
  ifconfig: (st) => COMMANDS.ip(st),
  ping: (st, a) => {
    const host = a.filter((x) => !x.startsWith('-')).pop();
    if (!host) throw new ExitError('ping: usage error: Destination address required', 2);
    const known = host === 'localhost' || host === '127.0.0.1' || st.hosts[host] || Object.values(st.hosts).some((h) => h.name === host);
    if (!known) throw new ExitError(`ping: ${host}: Name or service not known`, 2);
    return `PING ${host}: 56 data bytes\n64 bytes from ${host}: icmp_seq=1 ttl=64 time=0.42 ms\n--- ${host} ping statistics ---\n1 packets transmitted, 1 received, 0% packet loss\n`;
  },
  nmap: (st, argv) => {
    const target = argv.filter((x) => !x.startsWith('-')).pop();
    if (!target) throw new ExitError('nmap: no target specified');
    const local = target === 'localhost' || target === '127.0.0.1' || target === st.hostname || target === '10.0.0.10';
    let ports;
    if (local) ports = Object.entries(st.services).filter(([, s]) => s.port && M.portOpen(st, s.port)).map(([n, s]) => ({ port: s.port, service: n }));
    else {
      const h = st.hosts[target] || Object.values(st.hosts).find((x) => x.name === target);
      if (!h) return `Starting Nmap 7.93\nNote: Host seems down.\nNmap done: 1 IP address (0 hosts up)\n`;
      ports = h.ports || [];
    }
    const sv = argv.includes('-sV');
    return `Starting Nmap 7.93\nNmap scan report for ${target}\nPORT     STATE SERVICE${sv ? '  VERSION' : ''}\n${ports.map((p) => `${`${p.port}/tcp`.padEnd(9)}open  ${String(p.service).padEnd(8)}${sv && p.version ? ` ${p.version}` : ''}`).join('\n')}\n\nNmap done: 1 IP address (1 host up)\n`;
  },
  curl: (st, argv) => {
    const url = argv.filter((x) => !x.startsWith('-')).pop() || '';
    const m = /^https?:\/\/([^/:]+)(?::(\d+))?(\/.*)?$/.exec(url);
    if (!m) throw new ExitError(`curl: (3) URL rejected: ${url}`, 3);
    const h = st.hosts[m[1]] || Object.values(st.hosts).find((x) => x.name === m[1]);
    const page = h && h.http ? h.http[m[3] || '/'] : null;
    if (!h) throw new ExitError(`curl: (6) Could not resolve host: ${m[1]}`, 6);
    if (page === undefined || page === null) return '<html><body><h1>404 Not Found</h1></body></html>\n';
    return `${page}\n`;
  },
  // ---- lab
  submit: (st, a) => {
    const flag = a.join(' ').trim();
    if (!flag) throw new ExitError('usage: submit <answer>');
    if (!st.submitted.includes(flag)) st.submitted.push(flag);
    return `Flag recorded: ${flag}\n(It will be checked when you submit the exam.)\n`;
  },
};

// ---------------------------------------------------------------- Run a line

/**
 * Runs one command line. Mutates `state`. Returns { output, exit }.
 * Output is capped; the history keeps the last 500 commands (used by "command_ran" checks).
 */
function run(state, rawLine) {
  const line = String(rawLine || '').slice(0, 2000);
  if (!line.trim()) return { output: '', exit: 0 };
  state.history.push(line);
  if (state.history.length > 500) state.history.shift();
  let out = '';
  let last = 0;
  try {
    const list = parse(tokenize(line, { ...state.env, '?': String(state.lastExit || 0) }));
    for (const { cond, pipeline } of list) {
      if ((cond === 'and' && last !== 0) || (cond === 'or' && last === 0)) continue;
      let stdin = '';
      for (let i = 0; i < pipeline.length; i += 1) {
        const { argv: raw, redirects } = pipeline[i];
        let argv = expandGlobs(state, raw);
        let asRoot = false;
        if (argv[0] === 'sudo') {
          argv = argv.slice(1).filter((x, j) => !(j === 0 && x === '-i'));
          if (state.user !== 'root') {
            const u = state.users[state.user];
            if (!u || !u.groups.includes('sudo')) throw new ExitError(`${state.user} is not in the sudoers file.  This incident will be reported.`);
          }
          asRoot = true;
        }
        const name = argv[0];
        const fn = COMMANDS[name];
        for (const r of redirects) if (r.op === '<') stdin = readFile(state, M.norm(state.cwd, r.target));
        let result;
        const prevUser = state.user;
        if (asRoot) state.user = 'root';
        try {
          if (!name) result = '';
          else if (!fn) throw new ExitError(`${name}: command not found`, 127);
          else result = fn(state, argv.slice(1), stdin) || '';
          last = 0;
        } catch (e) {
          if (!(e instanceof ExitError)) {
            result = '';
            out += `${name}: ${e.message}\n`;
            last = 1;
          } else {
            if (e.message) out += `${/^\w[\w-]*:/.test(e.message) || name === 'sudo' ? '' : `${name}: `}${e.message}\n`;
            result = '';
            last = e.code;
          }
        } finally {
          if (asRoot) state.user = prevUser;
        }
        const write = redirects.find((r) => r.op === '>' || r.op === '>>');
        if (write) {
          if (asRoot) state.user = 'root';
          try {
            M.writeFile(state, M.norm(state.cwd, write.target), result, write.op === '>>');
          } catch (e) {
            out += `bash: ${write.target}: ${e.message.split(': ').pop()}\n`;
            last = 1;
          } finally {
            if (asRoot) state.user = prevUser;
          }
          result = '';
        }
        if (i < pipeline.length - 1) stdin = result;
        else out += result;
      }
    }
  } catch (e) {
    if (!(e instanceof ExitError)) throw e;
    out += `${e.message}\n`;
    last = e.code;
  }
  state.lastExit = last;
  if (out.length > MAX_OUTPUT) out = `${out.slice(0, MAX_OUTPUT)}\n[output truncated]\n`;
  return { output: out, exit: last };
}

const prompt = (state) => `${state.user}@${state.hostname}:${state.cwd.replace(new RegExp(`^${(state.env.HOME || '/root').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), '~')}${state.user === 'root' ? '#' : '$'} `;

module.exports = { run, prompt, tokenize, parse, COMMANDS, ExitError };
