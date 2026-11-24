'use strict';

/**
 * Default email templates. They are copied into `email_templates` on install so admins can edit them
 * (Admin → Email templates). Variables use {{name}} and are HTML-escaped when rendered.
 * {{site_name}}, {{site_url}} and {{year}} are always available.
 */
const BTN = (urlVar, label) =>
  `<p style="margin:28px 0"><a href="{{${urlVar}}}" style="background:{{brand_color}};color:#ffffff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">${label}</a></p>`;

const LINK_FALLBACK = (urlVar) =>
  `<p style="font-size:13px;color:#64748b">If the button does not work, copy this link into your browser:<br><span style="word-break:break-all">{{${urlVar}}}</span></p>`;

const DEFAULT_TEMPLATES = [
  {
    key: 'verify_email',
    name: 'Welcome & verify email',
    subject: 'Welcome to {{site_name}} — please verify your email',
    variables: ['name', 'verify_url', 'expires_hours'],
    body_html: `<p>Hi {{name}},</p><p>Welcome to {{site_name}}. Please confirm your email address so you can take paid and proctored exams.</p>${BTN('verify_url', 'Verify my email')}${LINK_FALLBACK('verify_url')}<p>This link expires in {{expires_hours}} hours.</p>`,
  },
  {
    key: 'password_reset',
    name: 'Password reset',
    subject: 'Reset your {{site_name}} password',
    variables: ['name', 'reset_url', 'expires_minutes', 'ip'],
    body_html: `<p>Hi {{name}},</p><p>We received a request to reset your password from IP address {{ip}}.</p>${BTN('reset_url', 'Choose a new password')}${LINK_FALLBACK('reset_url')}<p>The link works once and expires in {{expires_minutes}} minutes. If you did not ask for this, you can ignore this email — your password will not change.</p>`,
  },
  {
    key: 'account_created',
    name: 'Account created by an administrator',
    subject: 'Your {{site_name}} account is ready',
    variables: ['name', 'set_password_url', 'expires_minutes', 'created_by'],
    body_html: `<p>Hi {{name}},</p><p>{{created_by}} has created an account for you on {{site_name}}. Choose a password to start using it.</p>${BTN('set_password_url', 'Set my password')}${LINK_FALLBACK('set_password_url')}<p>This link works once and expires in {{expires_minutes}} minutes. If it expires, use “Forgot password” on the sign-in page.</p>`,
  },
  {
    key: 'password_changed',
    name: 'Password changed notice',
    subject: 'Your {{site_name}} password was changed',
    variables: ['name', 'ip', 'time'],
    body_html: `<p>Hi {{name}},</p><p>Your password was changed on {{time}} from IP address {{ip}}.</p><p>If this was not you, reset your password immediately and contact support.</p>`,
  },
  {
    key: 'purchase_receipt',
    name: 'Purchase receipt',
    subject: 'Receipt for order {{order_no}}',
    variables: ['name', 'order_no', 'total', 'items', 'library_url'],
    body_html: `<p>Hi {{name}},</p><p>Thank you for your purchase. Order <strong>{{order_no}}</strong> has been paid ({{total}}).</p><p>{{items}}</p>${BTN('library_url', 'Open my library')}`,
  },
  {
    key: 'exam_assigned',
    name: 'Exam assigned',
    subject: 'New assessment: {{exam_title}}',
    variables: ['name', 'exam_title', 'due_date', 'exam_url', 'assigned_by'],
    body_html: `<p>Hi {{name}},</p><p>{{assigned_by}} has assigned you <strong>{{exam_title}}</strong>. Please complete it by {{due_date}}.</p>${BTN('exam_url', 'Start the assessment')}`,
  },
  {
    key: 'deadline_reminder',
    name: 'Deadline reminder',
    subject: 'Reminder: {{exam_title}} is due {{due_date}}',
    variables: ['name', 'exam_title', 'due_date', 'exam_url'],
    body_html: `<p>Hi {{name}},</p><p>This is a reminder that <strong>{{exam_title}}</strong> is due on {{due_date}} and you have not completed it yet.</p>${BTN('exam_url', 'Take it now')}`,
  },
  {
    key: 'result_available',
    name: 'Result available',
    subject: 'Your result for {{exam_title}} is ready',
    variables: ['name', 'exam_title', 'score', 'result_url'],
    body_html: `<p>Hi {{name}},</p><p>Your result for <strong>{{exam_title}}</strong> is now available. Score: {{score}}.</p>${BTN('result_url', 'View my result')}`,
  },
  {
    key: 'essay_graded',
    name: 'Essay graded',
    subject: 'Your written answers for {{exam_title}} have been graded',
    variables: ['name', 'exam_title', 'score', 'result_url'],
    body_html: `<p>Hi {{name}},</p><p>The written answers in <strong>{{exam_title}}</strong> have been graded. Your final score is {{score}}.</p>${BTN('result_url', 'View my result')}`,
  },
  {
    key: 'certificate_issued',
    name: 'Certificate issued',
    subject: 'Congratulations — your {{exam_title}} certificate',
    variables: ['name', 'exam_title', 'certificate_url', 'verify_url', 'certificate_id'],
    body_html: `<p>Hi {{name}},</p><p>Congratulations on passing <strong>{{exam_title}}</strong>. Your certificate ID is <strong>{{certificate_id}}</strong>.</p>${BTN('certificate_url', 'Download certificate')}<p>Anyone can verify it at {{verify_url}}.</p>`,
  },
  {
    key: 'org_invitation',
    name: 'Organisation invitation',
    subject: '{{organisation}} has invited you to {{site_name}}',
    variables: ['name', 'organisation', 'invite_url', 'invited_by', 'expires_days'],
    body_html: `<p>Hello,</p><p>{{invited_by}} has invited you to join <strong>{{organisation}}</strong> on {{site_name}}.</p>${BTN('invite_url', 'Accept invitation')}${LINK_FALLBACK('invite_url')}<p>The invitation expires in {{expires_days}} days.</p>`,
  },
  {
    key: 'test_email',
    name: 'SMTP test email',
    subject: '{{site_name}} SMTP test',
    variables: ['name', 'time'],
    body_html: `<p>Hi {{name}},</p><p>This is a test email sent at {{time}}. Your SMTP settings work.</p>`,
  },
];

module.exports = { DEFAULT_TEMPLATES };
