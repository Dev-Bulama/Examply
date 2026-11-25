'use strict';

/** Original quick-fire questions for the demo live quiz (cyber security and IT fundamentals). */
const sc = (stem, options, correct, explanation, difficulty = 2) => ({
  difficulty,
  q: { type: 'single_choice', marks: 1, stem_html: `<p>${stem}</p>`, options: options.map((t, i) => ({ text: t, correct: i === correct })), explanation_html: `<p>${explanation}</p>` },
});
const tf = (stem, correct, explanation) => ({ difficulty: 1, q: { type: 'true_false', marks: 1, stem_html: `<p>${stem}</p>`, correct, explanation_html: `<p>${explanation}</p>` } });

module.exports = [
  sc('Which port does HTTPS use by default?', ['80', '443', '22', '3389'], 1, 'HTTPS listens on TCP 443; plain HTTP uses 80.', 1),
  sc('A message that pressures you to "verify your account now" through a link is most likely…', ['Spear phishing', 'A firmware update', 'A DNS change', 'A backup reminder'], 0, 'Urgency plus a link to "verify" is the classic phishing pattern.'),
  tf('Multi-factor authentication still protects an account when its password has been leaked.', true, 'The attacker also needs the second factor (an app code, key or SMS).'),
  sc('Which command shows the listening ports on a modern Linux server?', ['ls -l', 'ss -tulpn', 'chmod 755', 'top'], 1, '<code>ss -tulpn</code> lists TCP/UDP listening sockets with their processes.'),
  sc('What does the principle of least privilege mean?', ['Everyone shares one admin account', 'Users get only the access they need for their job', 'Passwords never expire', 'All ports are open by default'], 1, 'Grant the minimum access needed, and nothing more.'),
  tf('A strong password policy makes regular, tested backups unnecessary.', false, 'Backups protect against ransomware, hardware failure and mistakes; passwords do not.'),
  sc('Which of these is a symmetric encryption algorithm?', ['RSA', 'AES', 'Diffie-Hellman', 'ECDSA'], 1, 'AES uses the same key to encrypt and decrypt; the others are asymmetric.', 3),
  sc('In SQL, which clause filters rows AFTER grouping?', ['WHERE', 'ORDER BY', 'HAVING', 'LIMIT'], 2, '<code>HAVING</code> filters groups produced by <code>GROUP BY</code>.'),
  sc('What is the first step of incident response in most frameworks?', ['Eradication', 'Preparation', 'Lessons learned', 'Recovery'], 1, 'NIST: Preparation → Detection & Analysis → Containment, Eradication & Recovery → Post-incident activity.', 3),
  tf('Using a public Wi-Fi network is safe for online banking as long as the site uses HTTPS.', true, 'HTTPS encrypts the traffic end to end; still avoid ignoring certificate warnings.'),
];
