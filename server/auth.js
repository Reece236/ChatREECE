'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { NOUNS, ACTIONS } = require('./words');

const KEY_DIGITS = Math.min(4, Math.max(2, Number(process.env.KEY_DIGITS) || 3));
const SESSION_DAYS = 365;

// ---------------------------------------------------------------------------
// Pepper
//
// Keys have no username attached, so a login has to find the account from the
// key alone. Scanning every row and running a slow hash against each one would
// make login cost grow with the user count, so each key also gets a fast keyed
// digest that we can look up on an index. The pepper keeps that digest useless
// to anyone who walks off with just the database file.
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
// Keys
// ---------------------------------------------------------------------------

/**
 * Strips a typed key down to the form we actually hash, so "Dog Jumping 472",
 * "dog-jumping-472" and "dogjumping472" are all the same key. People retype
 * these from a sticky note; punctuation and capitals should never be the
 * reason someone can't get back into their chat.
 */
function normalizeKey(input) {
  return String(input || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Generates a key like "dog-jumping-472". */
function generateKey() {
  const noun = NOUNS[crypto.randomInt(NOUNS.length)];
  const action = ACTIONS[crypto.randomInt(ACTIONS.length)];
  const min = 10 ** (KEY_DIGITS - 1);
  const number = crypto.randomInt(min, 10 ** KEY_DIGITS);
  return `${noun}-${action}-${number}`;
}

/** Total number of distinct keys the generator can produce. */
function keyspaceSize() {
  const min = 10 ** (KEY_DIGITS - 1);
  return NOUNS.length * ACTIONS.length * (10 ** KEY_DIGITS - min);
}

function lookupHash(normalized, pepper) {
  return crypto.createHmac('sha256', pepper).update(normalized).digest('hex');
}

function hashKey(normalized) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(normalized, salt, 32);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

function verifyKey(normalized, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  let derived;
  try {
    derived = crypto.scryptSync(normalized, salt, expected.length);
  } catch {
    return false;
  }
  return crypto.timingSafeEqual(derived, expected);
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
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  const bits = [
    `${name}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
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
//
// A key is the whole credential and there is no username to target, so every
// guess is a guess against all accounts at once. Slowing guesses down is what
// makes short, friendly keys safe to use.
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

  /** Called after a success so honest users don't burn through their budget. */
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
  KEY_DIGITS,
  SESSION_DAYS,
  RateLimiter,
  clearSessionCookie,
  generateKey,
  hashKey,
  keyspaceSize,
  loadPepper,
  lookupHash,
  newSessionToken,
  normalizeKey,
  parseCookies,
  setSessionCookie,
  tokenHash,
  verifyKey,
};
