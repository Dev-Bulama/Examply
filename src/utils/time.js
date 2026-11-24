'use strict';

function isValidTimezone(tz) {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const TIMEZONES = (() => {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return ['Africa/Lagos', 'UTC', 'Europe/London', 'America/New_York'];
  }
})();

const FORMATS = {
  'D MMM YYYY': { day: 'numeric', month: 'short', year: 'numeric' },
  'DD/MM/YYYY': { day: '2-digit', month: '2-digit', year: 'numeric' },
  'MM/DD/YYYY': { month: '2-digit', day: '2-digit', year: 'numeric' },
  'YYYY-MM-DD': 'iso',
};

function toDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatDate(value, { timezone = 'Africa/Lagos', format = 'D MMM YYYY' } = {}) {
  const d = toDate(value);
  if (!d) return '';
  const spec = FORMATS[format] || FORMATS['D MMM YYYY'];
  if (spec === 'iso') {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
    return parts;
  }
  const locale = format === 'MM/DD/YYYY' ? 'en-US' : 'en-GB';
  return new Intl.DateTimeFormat(locale, { timeZone: timezone, ...spec }).format(d);
}

function formatDateTime(value, opts = {}) {
  const d = toDate(value);
  if (!d) return '';
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: opts.timezone || 'Africa/Lagos', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  return `${formatDate(d, opts)}, ${time}`;
}

function relativeTime(value, now = new Date()) {
  const d = toDate(value);
  if (!d) return '';
  const diff = (d.getTime() - now.getTime()) / 1000;
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  const units = [
    ['year', 31536000],
    ['month', 2592000],
    ['week', 604800],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
    ['second', 1],
  ];
  for (const [unit, secs] of units) {
    if (Math.abs(diff) >= secs || unit === 'second') return rtf.format(Math.round(diff / secs), unit);
  }
  return '';
}

/** Milliseconds the timezone is ahead of UTC at `date` (e.g. +3600000 for Africa/Lagos). */
function tzOffsetMs(date, timezone) {
  const d = toDate(date);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(d)
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, Number(p.value)]),
  );
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - Math.floor(d.getTime() / 1000) * 1000;
}

/** The UTC instant of local midnight (start of day) in `timezone` for the day containing `date`. */
function startOfDay(timezone, date = new Date()) {
  const d = toDate(date);
  const local = new Date(d.getTime() + tzOffsetMs(d, timezone));
  const midnightLocalAsUtc = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  return new Date(midnightLocalAsUtc - tzOffsetMs(new Date(midnightLocalAsUtc), timezone));
}

/** The UTC instant of the first day of the month (local midnight) in `timezone`. */
function startOfMonth(timezone, date = new Date()) {
  const d = toDate(date);
  const local = new Date(d.getTime() + tzOffsetMs(d, timezone));
  const firstLocalAsUtc = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1);
  return new Date(firstLocalAsUtc - tzOffsetMs(new Date(firstLocalAsUtc), timezone));
}

const addMinutes = (date, minutes) => new Date(toDate(date).getTime() + minutes * 60000);

module.exports = { isValidTimezone, TIMEZONES, formatDate, formatDateTime, relativeTime, addMinutes, toDate, tzOffsetMs, startOfDay, startOfMonth, DATE_FORMATS: Object.keys(FORMATS) };
