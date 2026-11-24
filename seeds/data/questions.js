'use strict';

/**
 * Original sample questions written for this platform (not copied from any real exam).
 * Each entry: { cert, domain (code), category, difficulty, bloom, topic, tags, q: <authoring model> }.
 * `image: 'architecture'` on hotspot questions is replaced by a generated diagram at seed time.
 */
module.exports = [
  // ----------------------------------------------------------------- Oracle 1Z0-082
  {
    cert: 'oracle', domain: 'SQL', category: 'oracle', difficulty: 2, bloom: 'understand', topic: 'Aggregation', tags: ['sql', 'group by'],
    q: { type: 'single_choice', stem_html: '<p>Which clause filters groups <em>after</em> aggregation in a <code>SELECT</code> statement?</p>', options: [{ text: '`WHERE`', feedback: 'WHERE filters rows before grouping.' }, { text: '`HAVING`', correct: true }, { text: '`ORDER BY`' }, { text: '`CONNECT BY`' }], explanation_html: '<p><code>HAVING</code> is evaluated after <code>GROUP BY</code>, so it can reference aggregate functions such as <code>COUNT(*)</code>. <code>WHERE</code> is applied to individual rows before grouping.</p>', reference: 'Oracle Database SQL Language Reference — SELECT' },
  },
  {
    cert: 'oracle', domain: 'SQL', category: 'oracle', difficulty: 3, bloom: 'apply', topic: 'Joins', tags: ['sql', 'joins'],
    q: { type: 'single_choice', stem_html: '<p>Table <code>EMP</code> has 14 rows; 2 employees have a <code>NULL</code> department. Table <code>DEPT</code> has 4 departments, one of which has no employees.</p><pre><code>SELECT e.ename, d.dname\nFROM emp e LEFT OUTER JOIN dept d ON e.deptno = d.deptno;</code></pre><p>How many rows does the query return?</p>', options: [{ text: '12' }, { text: '14', correct: true }, { text: '15' }, { text: '16' }], explanation_html: '<p>A left outer join keeps every row from the left table (<code>EMP</code>). Employees with no matching department appear once with <code>NULL</code> department columns, so the result has exactly 14 rows. The empty department is not returned because it is on the right side.</p>' },
  },
  {
    cert: 'oracle', domain: 'ARCH', category: 'oracle', difficulty: 2, bloom: 'remember', topic: 'Background processes', tags: ['architecture', 'processes'],
    q: { type: 'multiple_response', stem_html: '<p>Which of these are mandatory Oracle Database background processes?</p>', options: [{ text: 'DBWn (Database Writer)', correct: true }, { text: 'LGWR (Log Writer)', correct: true }, { text: 'CKPT (Checkpoint)', correct: true }, { text: 'ARCn (Archiver)', feedback: 'ARCn only runs in ARCHIVELOG mode.' }, { text: 'Dnnn (Dispatcher)', feedback: 'Dispatchers are used only with shared server.' }], select_exact: 3, explanation_html: '<p>DBWn, LGWR, CKPT, SMON, PMON and others start with every instance. ARCn runs only when the database is in ARCHIVELOG mode, and dispatchers only in a shared-server configuration.</p>' },
  },
  {
    cert: 'oracle', domain: 'INST', category: 'oracle', difficulty: 1, bloom: 'remember', topic: 'Listener', tags: ['networking', 'listener'],
    q: { type: 'fill_blank', stem_html: '<p>By default the Oracle Net listener accepts connections on TCP port [[1]], and its configuration file is called [[2]].</p>', blanks: [{ variants: ['1521'] }, { variants: ['listener.ora'] }], case_sensitive: false, trim_whitespace: true, explanation_html: '<p>The default listener port is 1521 and the listener is configured in <code>listener.ora</code> (client connect descriptors live in <code>tnsnames.ora</code>).</p>' },
  },
  {
    cert: 'oracle', domain: 'INST', category: 'oracle', difficulty: 3, bloom: 'understand', topic: 'Startup stages', tags: ['instance', 'startup'],
    q: { type: 'ordering', stem_html: '<p>Put the stages of <code>STARTUP</code> in the order the instance passes through them.</p>', items: ['SHUTDOWN', 'NOMOUNT — instance started, parameter file read', 'MOUNT — control file opened', 'OPEN — data files and redo logs opened'], explanation_html: '<p>The instance starts in NOMOUNT (SGA allocated, background processes started), then MOUNT (control files read), then OPEN (data files and online redo logs opened).</p>' },
  },
  {
    cert: 'oracle', domain: 'SEC', category: 'oracle', difficulty: 2, bloom: 'understand', topic: 'Privileges', tags: ['security', 'privileges'],
    q: { type: 'matching', stem_html: '<p>Match each statement to what it does.</p>', pairs: [{ left: '`GRANT CREATE SESSION TO app_user`', right: 'Lets the user connect' }, { left: '`GRANT SELECT ON hr.emp TO app_user`', right: 'Gives an object privilege' }, { left: '`REVOKE dba FROM app_user`', right: 'Removes a role' }, { left: '`ALTER USER app_user ACCOUNT LOCK`', right: 'Prevents the user from logging in' }], distractors: ['Drops the user and their objects'], explanation_html: '<p>CREATE SESSION is the system privilege needed to connect; SELECT ON a table is an object privilege; REVOKE removes privileges or roles; ACCOUNT LOCK blocks logins without dropping anything.</p>' },
  },
  {
    cert: 'oracle', domain: 'STOR', category: 'oracle', difficulty: 2, bloom: 'remember', topic: 'Tablespaces', tags: ['storage'],
    q: { type: 'true_false', stem_html: '<p>The <code>SYSAUX</code> tablespace is optional and can be dropped once the database is open.</p>', correct: false, feedback_true: 'SYSAUX is mandatory.', explanation_html: '<p><code>SYSAUX</code> is a mandatory auxiliary tablespace created with every database (since 10g). It can be taken offline in some circumstances but cannot be dropped.</p>' },
  },
  {
    cert: 'oracle', domain: 'SQL', category: 'oracle', difficulty: 3, bloom: 'apply', topic: 'Functions', tags: ['sql', 'functions'],
    q: { type: 'numeric', stem_html: '<p>What does <code>SELECT ROUND(156.785, -1) FROM dual;</code> return?</p>', value: 160, tolerance: 0, units: '', explanation_html: '<p>A negative precision rounds to the left of the decimal point: −1 rounds to the nearest ten, so 156.785 becomes 160.</p>' },
  },
  // ----------------------------------------------------------------- AWS CLF-C02
  {
    cert: 'aws', domain: 'D1', category: 'aws', difficulty: 1, bloom: 'understand', topic: 'Cloud benefits', tags: ['cloud concepts'],
    q: { type: 'single_choice', stem_html: '<p>A company wants to stop guessing capacity and pay only for the compute it actually uses. Which cloud benefit does this describe?</p>', options: [{ text: 'Trade fixed expense for variable expense', correct: true }, { text: 'Go global in minutes' }, { text: 'Benefit from massive economies of scale' }, { text: 'Increase speed and agility' }], explanation_html: '<p>Paying per use instead of buying servers up front turns capital (fixed) expense into variable expense. The other options are also cloud benefits, but they describe reach, price reductions and speed.</p>' },
  },
  {
    cert: 'aws', domain: 'D2', category: 'aws', difficulty: 2, bloom: 'understand', topic: 'Shared responsibility', tags: ['security', 'shared responsibility'],
    q: { type: 'multiple_response', stem_html: '<p>Under the shared responsibility model, which tasks are the <strong>customer’s</strong> responsibility when using Amazon EC2?</p>', options: [{ text: 'Patching the guest operating system', correct: true }, { text: 'Configuring security groups', correct: true }, { text: 'Physical security of data centres' }, { text: 'Maintaining the hypervisor' }, { text: 'Encrypting data stored on EBS volumes', correct: true }], explanation_html: '<p>AWS is responsible for security <em>of</em> the cloud (facilities, hardware, hypervisor). The customer is responsible for security <em>in</em> the cloud: the guest OS, network rules such as security groups, and data protection choices like encryption.</p>' },
  },
  {
    cert: 'aws', domain: 'D3', category: 'aws', difficulty: 2, bloom: 'remember', topic: 'Core services', tags: ['services'],
    q: { type: 'matching', stem_html: '<p>Match each need to the AWS service that meets it.</p>', pairs: [{ left: 'Object storage for files and backups', right: 'Amazon S3' }, { left: 'Managed relational database', right: 'Amazon RDS' }, { left: 'Run code without managing servers', right: 'AWS Lambda' }, { left: 'DNS and domain registration', right: 'Amazon Route 53' }], distractors: ['Amazon Redshift', 'AWS Snowball'], explanation_html: '<p>S3 stores objects, RDS runs managed relational engines, Lambda is serverless compute, and Route 53 provides DNS. Redshift is a data warehouse; Snowball is a physical data-transfer device.</p>' },
  },
  {
    cert: 'aws', domain: 'D4', category: 'aws', difficulty: 2, bloom: 'apply', topic: 'Pricing', tags: ['billing', 'pricing'],
    q: { type: 'single_choice', stem_html: '<p>A batch job can be interrupted and restarted at any time. Which EC2 purchasing option is usually the cheapest for it?</p>', options: [{ text: 'On-Demand Instances' }, { text: 'Reserved Instances' }, { text: 'Spot Instances', correct: true }, { text: 'Dedicated Hosts' }], explanation_html: '<p>Spot Instances use spare capacity at a large discount and can be reclaimed with short notice, which is acceptable for interruptible, fault-tolerant work.</p>' },
  },
  {
    cert: 'aws', domain: 'D3', category: 'aws', difficulty: 3, bloom: 'analyze', topic: 'Architecture', tags: ['architecture', 'hotspot'],
    q: { type: 'hotspot', stem_html: '<p>In this three-tier web architecture, which tier should hold the Amazon RDS instance in a <strong>private</strong> subnet?</p>', image: 'architecture', regions: [{ label: 'Web tier (public subnet)', x: 4, y: 20, w: 28, h: 60 }, { label: 'Application tier', x: 36, y: 20, w: 28, h: 60 }, { label: 'Data tier', x: 68, y: 20, w: 28, h: 60, correct: true }], explanation_html: '<p>Databases belong in the data tier inside private subnets, reachable only from the application tier’s security group — never directly from the internet.</p>' },
  },
  {
    cert: 'aws', domain: 'D1', category: 'aws', difficulty: 2, bloom: 'remember', topic: 'Global infrastructure', tags: ['infrastructure'],
    q: { type: 'true_false', stem_html: '<p>An AWS Availability Zone consists of one or more discrete data centres with redundant power and networking.</p>', correct: true, explanation_html: '<p>Each Region contains multiple Availability Zones, and each AZ is one or more physically separate data centres with independent power, cooling and networking.</p>' },
  },
  {
    cert: 'aws', domain: 'D2', category: 'aws', difficulty: 3, bloom: 'understand', topic: 'IAM', tags: ['security', 'iam'],
    q: { type: 'short_answer', stem_html: '<p>Name two best practices for protecting the AWS account <strong>root user</strong>.</p>', keywords: [{ terms: ['mfa', 'multi-factor', 'multi factor'], weight: 1 }, { terms: ['do not use', "don't use", 'avoid using', 'daily tasks', 'everyday'], weight: 1 }, { terms: ['access key', 'access keys'], weight: 1 }], threshold: 2, case_sensitive: false, explanation_html: '<p>Enable MFA on the root user, do not use it for everyday tasks (create IAM users or IAM Identity Center users instead), and do not create access keys for it.</p>' },
  },
  // ----------------------------------------------------------------- Lean Six Sigma Green Belt
  {
    cert: 'lss', domain: 'DEF', category: 'lean-six-sigma', difficulty: 1, bloom: 'remember', topic: 'DMAIC', tags: ['dmaic'],
    q: { type: 'ordering', stem_html: '<p>Put the DMAIC phases in order.</p>', items: ['Define', 'Measure', 'Analyze', 'Improve', 'Control'], explanation_html: '<p>DMAIC: Define the problem, Measure current performance, Analyze root causes, Improve the process, Control to sustain the gains.</p>' },
  },
  {
    cert: 'lss', domain: 'MEA', category: 'lean-six-sigma', difficulty: 3, bloom: 'apply', topic: 'Process capability', tags: ['statistics', 'capability'],
    q: { type: 'numeric', stem_html: '<p>A process has 25 defects in 5,000 opportunities. What is its DPMO (defects per million opportunities)?</p>', value: 5000, tolerance: 0, units: 'DPMO', explanation_html: '<p>DPMO = defects ÷ opportunities × 1,000,000 = 25 ÷ 5,000 × 1,000,000 = 5,000.</p>' },
  },
  {
    cert: 'lss', domain: 'MEA', category: 'lean-six-sigma', difficulty: 4, bloom: 'apply', topic: 'Statistics', tags: ['statistics', 'normal distribution'],
    q: { type: 'single_choice', stem_html: '<p>For a normally distributed process, approximately what percentage of output falls within \\( \\mu \\pm 2\\sigma \\)?</p>', options: [{ text: '68.27%' }, { text: '95.45%', correct: true }, { text: '99.73%' }, { text: '99.99966%' }], explanation_html: '<p>The empirical rule: about 68% within ±1σ, 95% within ±2σ and 99.7% within ±3σ. 99.99966% corresponds to the six-sigma (3.4 DPMO) level with a 1.5σ shift.</p>' },
  },
  {
    cert: 'lss', domain: 'ANA', category: 'lean-six-sigma', difficulty: 2, bloom: 'understand', topic: 'Root cause tools', tags: ['tools'],
    q: { type: 'matching', stem_html: '<p>Match each tool to its main purpose.</p>', pairs: [{ left: 'Fishbone (Ishikawa) diagram', right: 'Brainstorm potential causes by category' }, { left: 'Pareto chart', right: 'Focus on the vital few causes' }, { left: '5 Whys', right: 'Drill down to a root cause' }, { left: 'Scatter diagram', right: 'Show a relationship between two variables' }], distractors: ['Track spending against budget'], explanation_html: '<p>Each tool supports root-cause analysis differently: fishbone organises ideas, Pareto prioritises, 5 Whys digs deeper and scatter diagrams test correlation.</p>' },
  },
  {
    cert: 'lss', domain: 'IMP', category: 'lean-six-sigma', difficulty: 2, bloom: 'remember', topic: 'Lean wastes', tags: ['lean', 'waste'],
    q: { type: 'fill_blank', stem_html: '<p>In Lean, the Japanese word for waste is [[1]], and the error-proofing technique is called [[2]].</p>', blanks: [{ variants: ['muda'] }, { variants: ['poka-yoke', 'poka yoke', 'pokayoke'] }], case_sensitive: false, trim_whitespace: true, explanation_html: '<p><em>Muda</em> means waste; <em>poka-yoke</em> means mistake-proofing.</p>' },
  },
  {
    cert: 'lss', domain: 'CTL', category: 'lean-six-sigma', difficulty: 3, bloom: 'evaluate', topic: 'Control plans', tags: ['control'],
    q: { type: 'essay', marks: 10, stem_html: '<p>Your team reduced invoice errors from 4% to 0.8%. Describe how you would design a control plan to sustain the improvement for the next 12 months.</p>', min_words: 120, max_words: 400, rubric_html: '<ul><li>Names the critical metrics and how often they are measured (2 marks)</li><li>Chooses an appropriate control chart and explains its use (3 marks)</li><li>Defines owners and a reaction plan for out-of-control signals (3 marks)</li><li>Mentions standard work / training and a handover to the process owner (2 marks)</li></ul>', explanation_html: '<p>A strong answer covers what is measured, how variation is monitored (for example a p-chart for the error proportion), who reacts and how, and how the new way of working is standardised.</p>' },
  },
  {
    cert: 'lss', domain: 'DEF', category: 'lean-six-sigma', difficulty: 2, bloom: 'apply', topic: 'Project charter', tags: ['define', 'charter'],
    q: { type: 'multiple_response', stem_html: '<p>Which items belong in a Six Sigma project charter?</p>', options: [{ text: 'Problem statement', correct: true }, { text: 'Goal statement', correct: true }, { text: 'Project scope', correct: true }, { text: 'Detailed solution design', feedback: 'Solutions are developed in the Improve phase.' }, { text: 'Final control chart', feedback: 'Control charts come in the Control phase.' }], explanation_html: '<p>The charter, written in Define, sets the problem, goal, scope, business case, team and timeline. Solutions and control charts come later.</p>' },
  },
];

/** A case study with child questions. */
module.exports.caseStudies = [
  {
    cert: 'oracle', category: 'oracle', difficulty: 3, bloom: 'analyze', topic: 'Troubleshooting', tags: ['scenario'],
    q: { type: 'case_study', stem_html: '<p><strong>Scenario.</strong> Users at Acme Logistics report that connections to the <code>ORCL</code> database fail with <code>ORA-12541: TNS:no listener</code>. The database server was rebooted last night. The DBA confirms the instance is <code>OPEN</code>.</p>', explanation_html: '' },
    children: [
      { domain: 'INST', difficulty: 2, q: { type: 'single_choice', stem_html: '<p>What is the most likely cause of the error?</p>', options: [{ text: 'The listener was not restarted after the reboot', correct: true }, { text: 'The users’ passwords have expired' }, { text: 'The SYSTEM tablespace is full' }, { text: 'The control file is corrupt' }], explanation_html: '<p>ORA-12541 means nothing is listening at the address the client used. If the instance is open, the listener process most likely did not start after the reboot.</p>' } },
      { domain: 'INST', difficulty: 2, q: { type: 'fill_blank', stem_html: '<p>The command-line utility used to start the listener is [[1]].</p>', blanks: [{ variants: ['lsnrctl', 'lsnrctl start'] }], explanation_html: '<p><code>lsnrctl start</code> starts the default listener.</p>' } },
    ],
  },
];
