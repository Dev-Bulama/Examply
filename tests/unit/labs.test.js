'use strict';

const machine = require('../../src/services/labs/machine');
const shell = require('../../src/services/labs/shell');
const scenario = require('../../src/services/labs/scenario');
const demo = require('../../seeds/data/labQuestions');

const fresh = (i = 0) => machine.build(demo[i].q.scenario);
const run = (st, line) => shell.run(st, line);

describe('lab shell', () => {
  test('tokenises quotes, pipes, redirects and && / ||', () => {
    const st = fresh();
    expect(run(st, 'echo "a b" | wc -w').output.trim()).toBe('2');
    expect(run(st, 'echo hi > /home/analyst/n.txt && cat /home/analyst/n.txt').output).toBe('hi\n');
    expect(run(st, 'false || echo fallback').output).toContain('fallback');
    expect(run(st, 'nosuchcmd').exit).toBe(127);
  });

  test('permissions apply until sudo is used', () => {
    const st = fresh();
    expect(run(st, 'cat /var/log/auth.log').exit).toBe(0); // analyst is in adm
    expect(run(st, 'usermod -L sysupd').exit).not.toBe(0);
    expect(run(st, 'sudo usermod -L sysupd').exit).toBe(0);
    expect(st.users.sysupd.locked).toBe(true);
    expect(st.user).toBe('analyst'); // sudo does not leave a root shell behind
  });

  test('sed edits files in place and supports /re/d', () => {
    const st = fresh();
    expect(run(st, "sudo sed -i 's/^PermitRootLogin yes/PermitRootLogin no/' /etc/ssh/sshd_config").exit).toBe(0);
    run(st, 'sudo sed -i /X11/d /etc/ssh/sshd_config');
    const cfg = st.fs['/etc/ssh/sshd_config'].content;
    expect(cfg).toContain('PermitRootLogin no');
    expect(cfg).not.toContain('X11');
  });

  test('systemctl disable --now stops the service and frees the port', () => {
    const st = fresh();
    expect(machine.portOpen(st, 23)).toBe(true);
    run(st, 'sudo systemctl disable --now telnet');
    expect(st.services.telnet).toMatchObject({ active: false, enabled: false });
    expect(machine.portOpen(st, 23)).toBe(false);
  });

  test('history and output are bounded', () => {
    const st = fresh();
    for (let i = 0; i < 5; i += 1) run(st, `echo ${i}`);
    expect(st.history).toHaveLength(5);
    expect(run(st, 'history').output).toContain('echo 4');
  });
});

describe('lab scenarios', () => {
  test('demo scenarios are valid and start with every task failing', () => {
    for (const d of demo) {
      expect(scenario.validate(d.q.scenario)).toEqual([]);
      const g = scenario.grade(d.q.scenario, machine.build(d.q.scenario));
      expect(g.awarded).toBe(0);
    }
  });

  test('the model solution passes every incident-response task', () => {
    const st = fresh();
    for (const c of ['submit 185.220.101.4', 'sudo usermod -L sysupd', 'sudo gpasswd -d deploy sudo', 'sudo pkill miner', 'sudo crontab -r', 'sudo systemctl disable --now telnet', 'sudo ufw enable', 'sudo ufw deny 23', "sudo sed -i 's/^PermitRootLogin yes/PermitRootLogin no/' /etc/ssh/sshd_config"]) run(st, c);
    const g = scenario.grade(demo[0].q.scenario, st);
    expect(g.allPassed).toBe(true);
    expect(g.awarded).toBe(g.total);
  });

  test('partial work earns task marks only', () => {
    const st = fresh(1);
    run(st, 'sudo chmod 640 /etc/shadow');
    run(st, 'sudo rm /opt/app/backup.sql');
    const g = scenario.grade(demo[1].q.scenario, st);
    expect(g.awarded).toBe(2);
    expect(g.allPassed).toBe(false);
  });

  test('validate rejects unknown checks and tasks that already pass', () => {
    const s = { title: 't', tasks: [{ id: 'a', title: 'A', marks: 1, check: { type: 'nope' } }, { id: 'b', title: 'B', marks: 1, check: { type: 'file_absent', path: '/nothing' } }] };
    const errors = scenario.validate(s).map((e) => e.message || String(e)).join(' ');
    expect(errors).toMatch(/nope|unknown/i);
    expect(errors).toMatch(/already/i);
  });

  test('candidate brief never includes checks or flags', () => {
    const brief = JSON.stringify(scenario.candidateBrief(demo[0].q.scenario));
    expect(brief).not.toContain('185.220.101.4');
    expect(brief).not.toContain('check');
    expect(brief).toContain('rogue UID 0');
  });
});
