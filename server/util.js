'use strict';
/* ─── Small shared utilities ─────────────────────────────────────────────── */
const crypto = require('crypto');

function rid(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

function nowIso() {
  return new Date().toISOString();
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const candidate = crypto.scryptSync(password, salt, 32).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(candidate, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function token() {
  return crypto.randomBytes(24).toString('hex');
}

/** Escape user text for safe HTML embedding. */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Replace {{placeholders}} — leaves unknown vars visible so admins spot typos. */
function applyVars(text, vars) {
  return String(text == null ? '' : text).replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (m, key) => {
    return key in vars && vars[key] != null ? String(vars[key]) : m;
  });
}

module.exports = { rid, nowIso, hashPassword, verifyPassword, token, esc, applyVars };
