'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { storagePath } = require('../config/paths');
const { badRequest } = require('../utils/errors');

/** Detects the real file type from magic bytes (never trust the client's MIME type or extension). */
function sniff(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { ext: 'png', mime: 'image/png' };
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return { ext: 'gif', mime: 'image/gif' };
  if (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00) return { ext: 'ico', mime: 'image/x-icon' };
  if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) return { ext: 'zip', mime: 'application/zip' };
  if (buf.slice(0, 4).toString() === '%PDF') return { ext: 'pdf', mime: 'application/pdf' };
  const head = buf.slice(0, 512).toString('utf8').trimStart().toLowerCase();
  if ((head.startsWith('<?xml') || head.startsWith('<svg')) && head.includes('<svg')) return { ext: 'svg', mime: 'image/svg+xml' };
  return null;
}

/** Memory-storage multer for small single-file uploads; the caller validates and persists. */
function memoryUpload({ field, maxBytes }) {
  return multer({ storage: multer.memoryStorage(), limits: { fileSize: maxBytes, files: 1, fields: 20 } }).single(field);
}

/**
 * Validates an uploaded buffer against an allow-list of sniffed types and writes it under
 * storage/uploads/<visibility>/<dir>/ with a random name. Returns the stored file name.
 */
function saveImage(file, { dir, allowed = ['png', 'jpg', 'webp'], visibility = 'public' }) {
  if (!file || !file.buffer || !file.size) throw badRequest('Choose a file to upload.');
  const kind = sniff(file.buffer);
  if (!kind || !allowed.includes(kind.ext)) throw badRequest(`That file type is not allowed. Use ${allowed.map((a) => a.toUpperCase()).join(', ')}.`);
  if (kind.ext === 'svg') {
    const text = file.buffer.toString('utf8').toLowerCase();
    if (/<script|on[a-z]+\s*=|javascript:|<foreignobject|<iframe|<embed|<object/.test(text)) throw badRequest('That SVG contains scripts or embedded content and cannot be used.');
  }
  const name = `${crypto.randomBytes(16).toString('hex')}.${kind.ext}`;
  const folder = storagePath('uploads', visibility, dir);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, name), file.buffer, { mode: 0o644 });
  return name;
}

function removeStored(name, { dir, visibility = 'public' }) {
  if (!name || !/^[a-f0-9]{32}\.[a-z]{2,4}$/.test(name)) return;
  fs.rm(storagePath('uploads', visibility, dir, name), { force: true }, () => {});
}

module.exports = { sniff, memoryUpload, saveImage, removeStored };
