'use strict';

const crypto = require('crypto');
const { authenticator } = require('otplib');
const QRCode = require('qrcode');
const bcrypt = require('bcryptjs');
const { encrypt, decrypt } = require('../../utils/crypto');

authenticator.options = { step: 30, window: 1, digits: 6 };

function generateSecret() {
  return authenticator.generateSecret(20);
}

async function qrDataUrl({ secret, email, issuer }) {
  const uri = authenticator.keyuri(email, issuer, secret);
  return { uri, dataUrl: await QRCode.toDataURL(uri, { margin: 1, width: 220 }) };
}

/**
 * Returns the matched time-step (integer) for a valid code, or null. Pass `lastStep` (the last accepted step for
 * this user) to reject a code that was already used — prevents replaying a code inside its 30-second window.
 */
function matchStep(secret, code, lastStep = null) {
  const clean = String(code || '').replace(/\s+/g, '');
  if (!secret || !/^\d{6}$/.test(clean)) return null;
  let delta;
  try {
    delta = authenticator.checkDelta(clean, secret);
  } catch {
    return null;
  }
  if (delta === null || delta === undefined) return null;
  const step = Math.floor(Date.now() / 1000 / authenticator.options.step) + delta;
  if (lastStep !== null && lastStep !== undefined && step <= Number(lastStep)) return null;
  return step;
}

function verifyCode(secret, code, lastStep = null) {
  return matchStep(secret, code, lastStep) !== null;
}

function encryptSecret(secret) {
  return encrypt(secret);
}

function decryptSecret(enc) {
  return enc ? decrypt(enc) : null;
}

/** 8 one-time recovery codes like "4f9k-2m7q". Returns { codes, hashes }. */
async function generateRecoveryCodes(count = 8) {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const codes = [];
  for (let i = 0; i < count; i += 1) {
    const bytes = crypto.randomBytes(8);
    const chars = [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
    codes.push(`${chars.slice(0, 4)}-${chars.slice(4, 8)}`);
  }
  const hashes = await Promise.all(codes.map((c) => bcrypt.hash(c, 10)));
  return { codes, hashes };
}

/** Returns the remaining hashes if `code` matched one (it is consumed), otherwise null. */
async function useRecoveryCode(hashes, code) {
  const clean = String(code || '').trim().toLowerCase();
  if (!/^[a-z0-9]{4}-[a-z0-9]{4}$/.test(clean)) return null;
  for (let i = 0; i < hashes.length; i += 1) {
    if (await bcrypt.compare(clean, hashes[i])) return hashes.filter((_, j) => j !== i);
  }
  return null;
}

module.exports = { generateSecret, qrDataUrl, verifyCode, matchStep, encryptSecret, decryptSecret, generateRecoveryCodes, useRecoveryCode, authenticator };
