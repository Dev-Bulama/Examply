'use strict';

const { encrypt, decrypt, maskSecret, hmacSha512, timingSafeEqualStr, sha256 } = require('../../src/utils/crypto');
const { toMinor, toMajor, formatMoney } = require('../../src/utils/money');
const time = require('../../src/utils/time');
const { slugify } = require('../../src/utils/slug');
const { sanitizeRich, toPlainText, escapeHtml } = require('../../src/utils/html');
const { parseJson } = require('../../src/utils/json');
const { pageUrl } = require('../../src/utils/paginate');

describe('crypto (AES-256-GCM)', () => {
  test('round-trips and uses a fresh IV each time', () => {
    const a = encrypt('sk_live_abcdef1234');
    const b = encrypt('sk_live_abcdef1234');
    expect(a).not.toEqual(b);
    expect(a.startsWith('v1:')).toBe(true);
    expect(decrypt(a)).toBe('sk_live_abcdef1234');
  });
  test('detects tampering', () => {
    const parts = encrypt('secret').split(':');
    const data = Buffer.from(parts[3], 'base64');
    data[0] ^= 1;
    parts[3] = data.toString('base64');
    expect(() => decrypt(parts.join(':'))).toThrow();
  });
  test('fails with a different key', () => {
    const other = Buffer.alloc(32, 7).toString('base64');
    expect(() => decrypt(encrypt('x'), other)).toThrow();
  });
  test('masks secrets', () => {
    expect(maskSecret('sk_live_1234567890abcd')).toBe('sk_live_••••abcd');
    expect(maskSecret('')).toBe('');
  });
  test('hmac / hashing helpers', () => {
    expect(hmacSha512('k', 'body')).toHaveLength(128);
    expect(sha256('a')).toBe('ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb');
    expect(timingSafeEqualStr('abc', 'abc')).toBe(true);
    expect(timingSafeEqualStr('abc', 'abd')).toBe(false);
    expect(timingSafeEqualStr('abc', 'abcd')).toBe(false);
  });
});

describe('money (kobo)', () => {
  test.each([
    ['5000', 500000],
    ['5,000.50', 500050],
    [12.5, 1250],
    ['0.05', 5],
    ['', 0],
  ])('toMinor(%p) = %p', (input, expected) => expect(toMinor(input)).toBe(expected));
  test('rejects invalid amounts', () => {
    expect(() => toMinor('12.345')).toThrow();
    expect(() => toMinor('abc')).toThrow();
  });
  test('formats naira', () => {
    expect(toMajor(500000)).toBe(5000);
    expect(formatMoney(500000)).toMatch(/₦\s?5,000/);
  });
});

describe('time', () => {
  test('timezone offset and local day boundaries', () => {
    const d = new Date('2026-11-24T23:30:00Z'); // 00:30 on 25 Nov in Lagos
    expect(time.tzOffsetMs(d, 'Africa/Lagos')).toBe(3600000);
    expect(time.startOfDay('Africa/Lagos', d).toISOString()).toBe('2026-11-24T23:00:00.000Z');
    expect(time.startOfMonth('Africa/Lagos', d).toISOString()).toBe('2026-10-31T23:00:00.000Z');
    expect(time.startOfDay('UTC', d).toISOString()).toBe('2026-11-24T00:00:00.000Z');
  });
  test('formats in the requested timezone', () => {
    expect(time.formatDate('2026-11-24T23:30:00Z', { timezone: 'Africa/Lagos', format: 'YYYY-MM-DD' })).toBe('2026-11-25');
    expect(time.formatDate('2026-11-24T23:30:00Z', { timezone: 'UTC', format: 'DD/MM/YYYY' })).toBe('24/11/2026');
  });
  test('validates timezones', () => {
    expect(time.isValidTimezone('Africa/Lagos')).toBe(true);
    expect(time.isValidTimezone('Mars/Olympus')).toBe(false);
  });
});

describe('text helpers', () => {
  test('slugify', () => {
    expect(slugify('Oracle 19c DBA & Admin!')).toBe('oracle-19c-dba-and-admin');
    expect(slugify('  Ñandú  ')).toBe('nandu');
  });
  test('sanitizeRich removes scripts and event handlers but keeps formatting', () => {
    const out = sanitizeRich('<p onclick="x()">Hi <strong>there</strong><script>alert(1)</script><img src="javascript:alert(1)"><a href="https://a.b" target="_blank">l</a></p>');
    expect(out).not.toMatch(/script|onclick|javascript:/);
    expect(out).toContain('<strong>there</strong>');
    expect(out).toContain('rel="noopener noreferrer nofollow"');
  });
  test('toPlainText and escapeHtml', () => {
    expect(toPlainText('<p>a&nbsp;<b>b</b></p>\n<p>c</p>')).toBe('a b c');
    expect(escapeHtml('<a href="x">\'&')).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
  });
  test('parseJson handles MySQL objects and MariaDB strings', () => {
    expect(parseJson({ a: 1 })).toEqual({ a: 1 });
    expect(parseJson('{"a":1}')).toEqual({ a: 1 });
    expect(parseJson('not json', [])).toEqual([]);
    expect(parseJson(null, 'x')).toBe('x');
  });
  test('pageUrl keeps filters and drops empty params', () => {
    expect(pageUrl('/admin/users', { q: 'ada', role: '', page: '3' }, 2)).toBe('/admin/users?q=ada&page=2');
    expect(pageUrl('/admin/users', { q: 'ada' }, 1)).toBe('/admin/users?q=ada');
  });
});
