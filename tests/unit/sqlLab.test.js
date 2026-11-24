'use strict';

const lab = require('../../src/services/sql/lab');
const runner = require('../../src/services/sql/runner');

const spec = {
  mode: 'query',
  schema_sql: 'CREATE TABLE departments (id INTEGER PRIMARY KEY, name TEXT); CREATE TABLE employees (id INTEGER PRIMARY KEY, name TEXT, department_id INTEGER, salary REAL);',
  seed_sql: "INSERT INTO departments VALUES (1,'Eng'),(2,'Sales'); INSERT INTO employees VALUES (1,'Ada',1,900),(2,'Bayo',1,700),(3,'Chi',2,500);",
  solution_sql: 'SELECT d.name AS department, COUNT(*) AS headcount FROM departments d JOIN employees e ON e.department_id = d.id GROUP BY d.name ORDER BY headcount DESC',
  check_sql: '',
  order_matters: false,
  column_names_matter: false,
  numeric_tolerance: 0,
};

afterAll(() => runner.shutdown());

describe('SQL lab', () => {
  test('an equivalent query written differently is correct', async () => {
    const r = await lab.check(spec, 'select name, (select count(*) from employees where department_id = departments.id) from departments');
    expect(r).toMatchObject({ correct: true });
  });

  test('row order is ignored unless order_matters', async () => {
    const q = 'SELECT d.name, COUNT(*) FROM departments d JOIN employees e ON e.department_id = d.id GROUP BY d.name ORDER BY 2 ASC';
    expect((await lab.check(spec, q)).correct).toBe(true);
    const r = await lab.check({ ...spec, order_matters: true }, q);
    expect(r.correct).toBe(false);
    expect(r.reason).toMatch(/Row 1 differs/);
  });

  test('column names checked only when required', async () => {
    const q = 'SELECT d.name AS dept, COUNT(*) AS n FROM departments d JOIN employees e ON e.department_id = d.id GROUP BY d.name';
    expect((await lab.check(spec, q)).correct).toBe(true);
    expect((await lab.check({ ...spec, column_names_matter: true }, q)).reason).toMatch(/Column names/);
  });

  test('wrong row count and column count are explained without revealing values', async () => {
    expect((await lab.check(spec, 'SELECT name, 1 FROM departments WHERE id = 1')).reason).toMatch(/returns 1 row/);
    expect((await lab.check(spec, 'SELECT name FROM departments')).reason).toMatch(/1 column; the task needs 2/);
  });

  test('numeric tolerance', async () => {
    const s = { ...spec, solution_sql: 'SELECT AVG(salary) FROM employees' };
    expect((await lab.check(s, 'SELECT 700.004')).correct).toBe(false);
    expect((await lab.check({ ...s, numeric_tolerance: 0.01 }, 'SELECT 700.004')).correct).toBe(true);
  });

  test('syntax errors come back as a reason', async () => {
    const r = await lab.check(spec, 'SELEC * FROM x');
    expect(r.correct).toBe(false);
    expect(r.reason).toMatch(/syntax error/);
  });

  test('modify mode compares the data after the change', async () => {
    const m = { ...spec, mode: 'modify', solution_sql: 'UPDATE employees SET salary = salary * 1.1 WHERE department_id = 1', check_sql: 'SELECT id, salary FROM employees ORDER BY id' };
    expect((await lab.check(m, 'UPDATE employees SET salary = salary + salary / 10 WHERE department_id = (SELECT id FROM departments WHERE name = "Eng")')).correct).toBe(true);
    expect((await lab.check(m, 'UPDATE employees SET salary = salary * 1.1')).correct).toBe(false);
  });

  test('every run starts from a fresh dataset', async () => {
    await lab.preview(spec, 'DELETE FROM employees');
    const r = await lab.preview(spec, 'SELECT COUNT(*) FROM employees');
    expect(r.result.rows[0][0]).toBe(3);
  });

  test('runaway queries are stopped by the time limit and the pool recovers', async () => {
    const r = await lab.preview(spec, 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT COUNT(*) FROM c');
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
    expect((await lab.preview(spec, 'SELECT 1')).ok).toBe(true);
  }, 15000);

  test('ATTACH is blocked', async () => {
    await expect(lab.preview(spec, "ATTACH DATABASE 'x.db' AS x")).rejects.toThrow(/not available/);
  });

  test('describe lists tables and columns', async () => {
    const d = await lab.describe(spec);
    expect(d.tables.map((t) => t.name)).toEqual(['departments', 'employees']);
    expect(d.tables[0].columns[0]).toMatchObject({ name: 'id', pk: true });
  });

  test('verify catches broken datasets and solutions', async () => {
    expect(await lab.verify(spec)).toEqual([]);
    expect((await lab.verify({ ...spec, schema_sql: 'CREATE TABL x' }))[0].field).toBe('schema_sql');
    expect((await lab.verify({ ...spec, solution_sql: 'SELECT nope FROM employees' }))[0].message).toMatch(/model solution failed/);
    expect((await lab.verify({ ...spec, solution_sql: 'DELETE FROM employees' }))[0].field).toBe('solution_sql');
  });
});
