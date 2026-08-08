'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { NOUNS, ACTIONS } = require('./words');

const SESSION_DAYS = 365;
const USERNAME_MIN = 3;
const USERNAME_MAX = 20;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 200;

// ---------------------------------------------------------------------------
// Pepper — used only for the owner key check, so that a stolen database does
// not reveal whether a guessed admin key is correct.
// ---------------------------------------------------------------------------

function loadPepper(dataDir) {
  if (process.env.KEY_PEPPER) return Buffer.from(process.env.KEY_PEPPER, 'utf8');
  const file = path.join(dataDir, 'pepper.key');
  if (fs.existsSync(file)) return fs.readFileSync(file);
  const pepper = crypto.randomBytes(32);
  fs.writeFileSync(file, pepper, { mode: 0o600 });
  return pepper;
}

// ---------------------------------------------------------------------------
// Usernames
// ---------------------------------------------------------------------------

/**
 * Usernames are matched case-insensitively. People do not remember whether they
 * signed up as "Reece" or "reece", and being told "wrong password" because of a
 * capital letter is a miserable way to lose access.
 */
function normalizeUsername(input) {
  return String(input || '').trim().toLowerCase();
}

function validateUsername(input) {
  const raw = String(input || '').trim();
  if (raw.length < USERNAME_MIN) {
    return { ok: false, error: `Username needs at least ${USERNAME_MIN} characters.` };
  }
  if (raw.length > USERNAME_MAX) {
    return { ok: false, error: `Username can be at most ${USERNAME_MAX} characters.` };
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(raw)) {
    return { ok: false, error: 'Use only letters, numbers, dots, dashes or underscores.' };
  }
  if (!/[a-zA-Z0-9]/.test(raw)) {
    return { ok: false, error: 'Username needs at least one letter or number.' };
  }
  return { ok: true, display: raw, lookup: normalizeUsername(raw) };
}

function validatePassword(input) {
  const raw = String(input || '');
  if (raw.length < PASSWORD_MIN) {
    return { ok: false, error: `Password needs at least ${PASSWORD_MIN} characters.` };
  }
  if (raw.length > PASSWORD_MAX) {
    return { ok: false, error: 'That password is too long.' };
  }
  return { ok: true, password: raw };
}

// ---------------------------------------------------------------------------
// Password hashing
// ---------------------------------------------------------------------------

const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, 32, SCRYPT_OPTIONS);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  let derived;
  try {
    derived = crypto.scryptSync(password, salt, expected.length, SCRYPT_OPTIONS);
  } catch {
    return false;
  }
  return crypto.timingSafeEqual(derived, expected);
}

/**
 * Burns roughly the same time as a real password check. Without this, an
 * unknown username returns noticeably faster than a known one with a bad
 * password, which hands out a list of valid usernames.
 */
const DUMMY_HASH = hashPassword('never-matches-anything');
function wasteTime(password) {
  verifyPassword(String(password || ''), DUMMY_HASH);
}

// ---------------------------------------------------------------------------
// Owner key (env-configured, not a signed-up account)
// ---------------------------------------------------------------------------

function normalizeKey(input) {
  return String(input || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function generateKey(parts = 3) {
  const words = [NOUNS[crypto.randomInt(NOUNS.length)]];
  for (let i = 1; i < parts; i += 1) words.push(ACTIONS[crypto.randomInt(ACTIONS.length)]);
  return `${words.join('-')}-${crypto.randomInt(100, 1000)}`;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

function newSessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const piece of String(header).split(';')) {
    const eq = piece.indexOf('=');
    if (eq < 0) continue;
    const name = piece.slice(0, eq).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(piece.slice(eq + 1).trim());
    } catch {
      out[name] = piece.slice(eq + 1).trim();
    }
  }
  return out;
}

function setSessionCookie(res, name, token, { secure }) {
  const bits = [
    `${name}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_DAYS * 24 * 60 * 60}`,
  ];
  if (secure) bits.push('Secure');
  res.append('Set-Cookie', bits.join('; '));
}

function clearSessionCookie(res, name, { secure }) {
  const bits = [`${name}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) bits.push('Secure');
  res.append('Set-Cookie', bits.join('; '));
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

class RateLimiter {
  constructor({ limit, windowMs }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = new Map();
  }

  /** Returns null when allowed, or the seconds to wait when blocked. */
  check(bucket) {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const times = (this.hits.get(bucket) || []).filter((t) => t > cutoff);
    if (times.length >= this.limit) {
      this.hits.set(bucket, times);
      return Math.max(1, Math.ceil((times[0] + this.windowMs - now) / 1000));
    }
    times.push(now);
    this.hits.set(bucket, times);
    return null;
  }

  reset(bucket) {
    this.hits.delete(bucket);
  }

  sweep() {
    const cutoff = Date.now() - this.windowMs;
    for (const [bucket, times] of this.hits) {
      const kept = times.filter((t) => t > cutoff);
      if (kept.length) this.hits.set(bucket, kept);
      else this.hits.delete(bucket);
    }
  }
}

module.exports = {
  PASSWORD_MIN,
  RateLimiter,
  SESSION_DAYS,
  USERNAME_MAX,
  USERNAME_MIN,
  clearSessionCookie,
  generateKey,
  hashPassword,
  loadPepper,
  newSessionToken,
  normalizeKey,
  normalizeUsername,
  parseCookies,
  setSessionCookie,
  tokenHash,
  validatePassword,
  validateUsername,
  verifyPassword,
  wasteTime,
};
