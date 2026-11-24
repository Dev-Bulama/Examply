'use strict';

/**
 * Sidebar navigation. An item is shown only when the user holds at least one of `any` (or every one of `all`).
 * Later phases append their sections here.
 */
const ADMIN_NAV = [
  {
    heading: null,
    items: [{ label: 'Dashboard', href: '/admin', icon: 'home', exact: true, any: ['admin.access'] }],
  },
  {
    heading: 'Content',
    items: [
      { label: 'Exams', href: '/admin/exams', icon: 'document', any: ['exams.view'] },
      { label: 'Attempts & results', href: '/admin/attempts', icon: 'chart', any: ['attempts.view'] },
      { label: 'Grading queue', href: '/admin/grading', icon: 'clipboard', any: ['results.manage'] },
      { label: 'Question bank', href: '/admin/questions', icon: 'clipboard', any: ['questions.view'], exclude: ['/admin/questions/reports'] },
      { label: 'AI generator', href: '/admin/ai/new', icon: 'academic', any: ['ai.generate'] },
      { label: 'Import questions', href: '/admin/imports', icon: 'download', any: ['questions.import'] },
      { label: 'Reported questions', href: '/admin/questions/reports', icon: 'flag', any: ['question_reports.manage'] },
      { label: 'Categories', href: '/admin/catalogue/categories', icon: 'list', any: ['catalogue.manage'] },
      { label: 'Certifications', href: '/admin/catalogue/certifications', icon: 'academic', any: ['catalogue.manage'] },
      { label: 'Training programmes', href: '/admin/catalogue/programmes', icon: 'chart', any: ['catalogue.manage'] },
    ],
  },
  {
    heading: 'Commerce',
    items: [
      { label: 'Orders', href: '/admin/orders', icon: 'banknotes', any: ['orders.view'] },
      { label: 'Products & plans', href: '/admin/products', icon: 'list', any: ['products.manage'] },
      { label: 'Coupons', href: '/admin/coupons', icon: 'key', any: ['coupons.manage'] },
    ],
  },
  {
    heading: 'People',
    items: [
      { label: 'Users', href: '/admin/users', icon: 'users', any: ['users.view'] },
      { label: 'Roles & permissions', href: '/admin/roles', icon: 'key', any: ['roles.manage'] },
    ],
  },
  {
    heading: 'System',
    items: [
      { label: 'Settings', href: '/admin/settings', icon: 'cog', any: ['settings.manage'] },
      { label: 'Audit log', href: '/admin/audit', icon: 'clipboard', any: ['audit.view'] },
      { label: 'Background jobs', href: '/admin/jobs', icon: 'queue', any: ['jobs.view'] },
    ],
  },
];

const CANDIDATE_NAV = [
  {
    heading: null,
    items: [
      { label: 'Dashboard', href: '/dashboard', icon: 'home', exact: true },
      { label: 'Browse exams', href: '/exams', icon: 'search' },
      { label: 'My results', href: '/my/results', icon: 'chart' },
      { label: 'Certificates', href: '/my/certificates', icon: 'academic' },
      { label: 'Orders & library', href: '/my/orders', icon: 'banknotes' },
      { label: 'Profile', href: '/account', icon: 'user', exact: true },
      { label: 'Security', href: '/account/security', icon: 'lock' },
    ],
  },
];

function visible(nav, user) {
  return nav
    .map((section) => ({
      ...section,
      items: section.items.filter((i) => (!i.any || user.canAny(...i.any)) && (!i.all || user.can(...i.all))),
    }))
    .filter((s) => s.items.length);
}

module.exports = { ADMIN_NAV, CANDIDATE_NAV, visible };
