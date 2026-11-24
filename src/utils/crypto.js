'use strict';

const crypto = require('crypto');
const { getEnv } = require('../config/env');

const ALGO = 'aes-256-gcm';
const PREFIX = 'v1';

function keyBuffer(appKey = getEnv().APP_KEY) {
  const key = Buffer.from(appKey, 'base64');
  if (key.length !== 32) throw new Error('APP_KEY must decode to 32 bytes');
  return key;
}

/** AES-256-GCM. Output format: v1:<iv b64>:<tag b64>:<ciphertext b64> */
function encrypt(plaintext, appKey) {
  if (plaintext === null || plaintext === undefined) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, keyBuffer(appKey), iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':');
}

function decrypt(payload, appKey) {
  if (payload === null || payload === undefined || payload === '') return null;
  const parts = String(payload).split(':');
  if (parts.length !== 4 || parts[0] !== PREFIX) throw new Error('Malformed encrypted value');
  const [, ivB64, tagB64, dataB64] = parts;
  const decipher = crypto.createDecipheriv(ALGO, keyBuffer(appKey), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

/** URL-safe random token (used for email verification, password reset, invitations). */
function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function hmacSha512(secret, body) {
  return crypto.createHmac('sha512', secret).update(body).digest('hex');
}

function timingSafeEqualStr(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** Masks a secret for display, e.g. sk_live_••••1234 */
function maskSecret(secret) {
  if (!secret) return '';
  const s = String(secret);
  const last4 = s.slice(-4);
  const prefixMatch = s.match(/^(sk_(?:live|test)_|pk_(?:live|test)_)/);
  return `${prefixMatch ? prefixMatch[1] : ''}••••${last4}`;
}

module.exports = { encrypt, decrypt, randomToken, sha256, hmacSha512, timingSafeEqualStr, maskSecret };
