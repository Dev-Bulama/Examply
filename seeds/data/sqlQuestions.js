'use strict';

/** Original SQL lab sample questions (SQLite dialect) on two small datasets. */
const HR_SCHEMA = `CREATE TABLE departments (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  city TEXT NOT NULL
);
CREATE TABLE employees (
  id INTEGER PRIMARY KEY,
  full_name TEXT NOT NULL,
  department_id INTEGER REFERENCES departments(id),
  manager_id INTEGER REFERENCES employees(id),
  job_title TEXT NOT NULL,
  salary INTEGER NOT NULL,
  hired_on TEXT NOT NULL
);`;

const HR_SEED = `INSERT INTO departments VALUES
  (1, 'Engineering', 'Lagos'), (2, 'Sales', 'Abuja'), (3, 'Finance', 'Lagos'), (4, 'Legal', 'Port Harcourt');
INSERT INTO employees VALUES
  (1, 'Adaeze Okafor', 1, NULL, 'CTO', 1450000, '2018-02-01'),
  (2, 'Bola Adeyemi', 1, 1, 'Senior Engineer', 980000, '2019-06-17'),
  (3, 'Chidi Eze', 1, 2, 'Engineer', 720000, '2021-03-08'),
  (4, 'Damilola Bello', 1, 2, 'Engineer', 705000, '2022-09-12'),
  (5, 'Emeka Nwosu', 2, NULL, 'Sales Director', 1100000, '2017-11-20'),
  (6, 'Fatima Sule', 2, 5, 'Account Manager', 560000, '2020-01-06'),
  (7, 'Gbenga Ojo', 2, 5, 'Account Manager', 540000, '2023-04-03'),
  (8, 'Halima Yusuf', 3, NULL, 'Finance Manager', 890000, '2019-08-19'),
  (9, 'Ifeanyi Obi', 3, 8, 'Accountant', 480000, '2024-02-26'),
  (10, 'Jumoke Alabi', NULL, NULL, 'Contractor', 400000, '2025-01-13');`;

const SHOP_SCHEMA = `CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, state TEXT NOT NULL);
CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id), ordered_on TEXT NOT NULL, status TEXT NOT NULL);
CREATE TABLE order_items (order_id INTEGER NOT NULL REFERENCES orders(id), product TEXT NOT NULL, quantity INTEGER NOT NULL, unit_price INTEGER NOT NULL);`;

const SHOP_SEED = `INSERT INTO customers VALUES (1,'Kemi Stores','Lagos'),(2,'Musa Traders','Kano'),(3,'Nkem Ventures','Enugu'),(4,'Ola & Sons','Lagos');
INSERT INTO orders VALUES (101,1,'2026-01-04','delivered'),(102,1,'2026-02-11','delivered'),(103,2,'2026-02-15','cancelled'),(104,3,'2026-03-02','delivered'),(105,2,'2026-03-09','delivered'),(106,1,'2026-03-21','pending');
INSERT INTO order_items VALUES (101,'Printer paper',10,3500),(101,'Toner',2,42000),(102,'Stapler',5,2500),(103,'Toner',4,42000),(104,'Printer paper',20,3500),(104,'Desk lamp',3,18000),(105,'Stapler',12,2500),(106,'Toner',1,42000);`;

const base = { cert: 'oracle', category: 'oracle', domain: 'SQL', tags: ['sql', 'sql-lab'] };

module.exports = [
  {
    ...base,
    difficulty: 2,
    topic: 'Filtering',
    q: {
      type: 'sql',
      marks: 2,
      stem_html: '<p>List the <strong>full name and salary</strong> of every employee in the <code>Engineering</code> department who earns more than ₦700,000, highest salary first.</p>',
      mode: 'query',
      schema_sql: HR_SCHEMA,
      seed_sql: HR_SEED,
      starter_sql: '-- Write your query here\nSELECT ',
      solution_sql: "SELECT e.full_name, e.salary FROM employees e JOIN departments d ON d.id = e.department_id WHERE d.name = 'Engineering' AND e.salary > 700000 ORDER BY e.salary DESC;",
      order_matters: true,
      explanation_html: '<p>Join employees to departments, filter on the department name and salary, then <code>ORDER BY salary DESC</code>.</p>',
    },
  },
  {
    ...base,
    difficulty: 3,
    topic: 'Aggregation',
    q: {
      type: 'sql',
      marks: 3,
      stem_html: '<p>For each department, show the department <code>name</code>, the number of employees as <code>headcount</code> and the average salary rounded to the nearest naira as <code>avg_salary</code>. Include only departments with at least two employees.</p>',
      mode: 'query',
      schema_sql: HR_SCHEMA,
      seed_sql: HR_SEED,
      solution_sql: 'SELECT d.name, COUNT(*) AS headcount, ROUND(AVG(e.salary)) AS avg_salary FROM departments d JOIN employees e ON e.department_id = d.id GROUP BY d.id, d.name HAVING COUNT(*) >= 2;',
      column_names_matter: true,
      numeric_tolerance: 1,
      explanation_html: '<p><code>GROUP BY</code> the department, then filter groups with <code>HAVING COUNT(*) &gt;= 2</code> — <code>WHERE</code> cannot filter on an aggregate.</p>',
    },
  },
  {
    ...base,
    difficulty: 3,
    topic: 'Outer joins',
    q: {
      type: 'sql',
      marks: 2,
      stem_html: '<p>Which departments have <strong>no employees</strong>? Return the department name only.</p>',
      mode: 'query',
      schema_sql: HR_SCHEMA,
      seed_sql: HR_SEED,
      solution_sql: 'SELECT d.name FROM departments d LEFT JOIN employees e ON e.department_id = d.id WHERE e.id IS NULL;',
      explanation_html: '<p>A <code>LEFT JOIN</code> keeps every department; those with no matching employee have <code>NULL</code> employee columns. <code>NOT EXISTS</code> works too.</p>',
    },
  },
  {
    ...base,
    difficulty: 4,
    topic: 'Self joins',
    q: {
      type: 'sql',
      marks: 3,
      stem_html: '<p>Show each employee who has a manager, with columns <code>employee</code> and <code>manager</code> (both full names), ordered by employee name.</p>',
      mode: 'query',
      schema_sql: HR_SCHEMA,
      seed_sql: HR_SEED,
      solution_sql: 'SELECT e.full_name AS employee, m.full_name AS manager FROM employees e JOIN employees m ON m.id = e.manager_id ORDER BY e.full_name;',
      order_matters: true,
      column_names_matter: true,
      explanation_html: '<p>Join the <code>employees</code> table to itself: one alias for the employee and one for the manager.</p>',
    },
  },
  {
    ...base,
    difficulty: 4,
    topic: 'Data modification',
    q: {
      type: 'sql',
      marks: 3,
      stem_html: '<p>Give every <strong>Finance</strong> employee a 10% pay rise. Salaries are whole naira: round the new salary to the nearest naira.</p>',
      mode: 'modify',
      schema_sql: HR_SCHEMA,
      seed_sql: HR_SEED,
      starter_sql: 'UPDATE employees\nSET ',
      solution_sql: "UPDATE employees SET salary = ROUND(salary * 1.1) WHERE department_id = (SELECT id FROM departments WHERE name = 'Finance');",
      check_sql: 'SELECT id, salary FROM employees ORDER BY id;',
      explanation_html: '<p>Use a subquery (or the known id) to target Finance only — an <code>UPDATE</code> without the right <code>WHERE</code> changes everyone’s salary.</p>',
    },
  },
  {
    ...base,
    difficulty: 3,
    topic: 'Joins & totals',
    q: {
      type: 'sql',
      marks: 3,
      stem_html: '<p>Using the shop database, show each customer’s <code>name</code> and total spend on <strong>delivered</strong> orders as <code>total</code> (quantity × unit price), largest first. Customers with no delivered orders should not appear.</p>',
      mode: 'query',
      schema_sql: SHOP_SCHEMA,
      seed_sql: SHOP_SEED,
      solution_sql: "SELECT c.name, SUM(i.quantity * i.unit_price) AS total FROM customers c JOIN orders o ON o.customer_id = c.id AND o.status = 'delivered' JOIN order_items i ON i.order_id = o.id GROUP BY c.id, c.name ORDER BY total DESC;",
      order_matters: true,
      explanation_html: '<p>Join customers → orders → items, keep delivered orders, <code>SUM(quantity * unit_price)</code> per customer and sort descending.</p>',
    },
  },
];
