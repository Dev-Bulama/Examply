'use strict';

const { z } = require('zod');
const { isValidTimezone } = require('../utils/time');

const trimmed = (max, min = 0, message) =>
  z
    .string({ required_error: message || 'This field is required.' })
    .trim()
    .min(min, message || (min > 1 ? `Use at least ${min} characters.` : 'This field is required.'))
    .max(max, `Use at most ${max} characters.`);

const optionalTrimmed = (max) =>
  z
    .string()
    .trim()
    .max(max, `Use at most ${max} characters.`)
    .optional()
    .transform((v) => (v ? v : null));

const email = z
  .string({ required_error: 'Enter your email address.' })
  .trim()
  .toLowerCase()
  .min(1, 'Enter your email address.')
  .max(191, 'That email address is too long.')
  .email('Enter a valid email address, like name@example.com.');

const checkbox = z
  .union([z.literal('1'), z.literal('0'), z.literal('on'), z.array(z.string()), z.boolean()])
  .optional()
  .transform((v) => (Array.isArray(v) ? v.includes('1') || v.includes('on') : v === true || v === '1' || v === 'on'));

const timezone = z.string().trim().refine(isValidTimezone, 'Choose a valid timezone.');

const intOrNull = (min, max) =>
  z
    .union([z.string(), z.number()])
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === null || v === '') return null;
      const n = Number(v);
      if (!Number.isInteger(n) || n < min || n > max) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Enter a whole number between ${min} and ${max}.` });
        return z.NEVER;
      }
      return n;
    });

const id = z.coerce.number().int().positive();

module.exports = { z, trimmed, optionalTrimmed, email, checkbox, timezone, intOrNull, id };
