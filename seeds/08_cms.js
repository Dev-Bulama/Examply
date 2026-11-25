'use strict';

/** Starter pages and help-centre FAQs (edit them in Admin → Pages & FAQ). Idempotent: only adds missing rows. */
const PAGES = [
  {
    slug: 'about',
    title: 'About us',
    show_in_footer: true,
    display_order: 1,
    body_html: '<p>We help professionals, training providers and companies measure real skills — with realistic certification mock exams, hands-on SQL and cyber security labs, live quizzes and certificates anyone can verify.</p><h2>What we believe</h2><ul><li>Assessment should be fair, private and transparent about how it is marked.</li><li>Practice should feel like the real thing, so the real thing feels familiar.</li><li>Results should tell you what to do next, not just a number.</li></ul>',
  },
  {
    slug: 'terms',
    title: 'Terms of use',
    show_in_footer: true,
    display_order: 2,
    body_html: '<p>By creating an account or taking an exam you agree to these terms.</p><h2>Your account</h2><p>Keep your password and two-factor codes private. You are responsible for activity on your account.</p><h2>Exam conduct</h2><p>Do your own work. Do not share, copy or publish exam questions. We may void results where integrity checks show misconduct.</p><h2>Payments and refunds</h2><p>Prices are in Naira and include VAT where it applies. Access is granted when payment is confirmed. Contact support within 7 days if something went wrong with a purchase.</p><h2>Certificates</h2><p>Certificates confirm that you passed an exam on this platform. Unless stated, they are not issued by or affiliated with the owners of the certifications our mocks prepare you for.</p><p><em>Please have these terms reviewed by your legal adviser before launch.</em></p>',
  },
  {
    slug: 'privacy',
    title: 'Privacy policy',
    show_in_footer: true,
    display_order: 3,
    body_html: '<p>We follow the Nigeria Data Protection Act (NDPA) 2023 and collect only what we need to run your exams.</p><h2>What we collect</h2><ul><li>Account details: name, email, and optional profile fields.</li><li>Exam data: answers, timings, scores and integrity events (such as tab switches).</li><li>Payment confirmations from Paystack or your bank-transfer receipt. We never see or store card numbers.</li></ul><h2>How we use it</h2><p>To deliver and mark exams, issue certificates, send the emails you need, and improve question quality with anonymous statistics.</p><h2>Your rights</h2><p>You can download or delete your data from your profile, or ask us through support.</p><p><em>Please have this policy reviewed by your legal adviser before launch.</em></p>',
  },
];

const FAQS = [
  ['Exams', 'How is my exam timed?', '<p>The timer runs on our server, so it keeps going if you close the browser or lose your connection. Your answers are saved as you go; sign in again to continue where you stopped.</p>'],
  ['Exams', 'What happens if my internet drops during an exam?', '<p>Keep going: answers are kept on your device and sent automatically when you are back online. The top of the screen shows whether everything is saved.</p>'],
  ['Exams', 'How do SQL and cyber security lab questions work?', '<p>SQL labs give you a real sample database to query in the browser. Cyber labs give you your own simulated Linux machine in a terminal. Both are marked automatically on what you actually do.</p>'],
  ['Exams', 'Can I play calm music while I take an exam?', '<p>Yes, if the exam allows it: press the music note in the exam header. It is generated in your browser and stays off until you switch it on.</p>'],
  ['Results', 'When will I see my result?', '<p>Most exams are marked instantly. Essays are marked by a person, and some exams release results after the exam window closes; you will get an email and a notification.</p>'],
  ['Results', 'How do employers verify my certificate?', '<p>Every certificate has an ID and a QR code. Anyone can check it at the Verify page without signing in.</p>'],
  ['Payments', 'Which payment methods can I use?', '<p>Cards, bank transfer and USSD through Paystack, or a direct bank transfer with your order number as the narration. Upload the receipt and we confirm it, usually within one working day.</p>'],
  ['Payments', 'I paid but cannot see my exam. What should I do?', '<p>Open <strong>Orders &amp; library</strong> to check the order status. If the payment left your account but the order is still pending after an hour, contact support with the order number.</p>'],
  ['Live quiz', 'How do I join a live quiz?', '<p>Go to the Join a live quiz page, enter the 6-digit PIN shown on the host screen and choose a nickname. Some games ask you to sign in first.</p>'],
  ['Companies', 'Can my company build its own private exams?', '<p>Yes. On a company plan your team gets a private workspace: your own question bank, AI generation from your documents, exams, cohorts and reports.</p>'],
  ['Companies', 'How do we invite our staff?', '<p>Managers invite people by email (one at a time or in bulk) or share a join code. People join only with their consent.</p>'],
  ['Account', 'How do I turn on two-factor authentication?', '<p>Open <strong>Security</strong> in your account menu and scan the QR code with an authenticator app. Keep your recovery codes somewhere safe.</p>'],
];

exports.seed = async function seed(knex) {
  for (const p of PAGES) {
    if (!(await knex('pages').where({ slug: p.slug }).first('id'))) await knex('pages').insert({ ...p, is_published: true });
  }
  if (!(await knex('faqs').first('id'))) {
    await knex('faqs').insert(FAQS.map(([category, question, answer_html], i) => ({ category, question, answer_html, display_order: i, is_published: true })));
  }
};
