'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs');

// Load .env before anything reads process.env at require time.
try {
  process.loadEnvFile(path.join(__dirname, '..', '.env'));
} catch {
  // No .env file is fine — everything has a default.
}

const express = require('express');
const store = require('./db');
const events = require('./events');
const {
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
} = require('./auth');

const PORT = Number(process.env.PORT) || 3000;
const SITE_NAME = process.env.SITE_NAME || 'ChatREECE';
const OWNER_NAME = process.env.OWNER_NAME || 'Reece';
const TRUST_PROXY = process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true';
const NOTIFY_WEBHOOK_URL = process.env.NOTIFY_WEBHOOK_URL || '';
const EMBED_ORIGINS = (process.env.EMBED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const VISITOR_COOKIE = 'cr_sid';
const OWNER_COOKIE = 'cr_owner';
const SESSION_TTL_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;
const MAX_MESSAGE_CHARS = 4000;
const MAX_NAME_CHARS = 40;

const PEPPER = loadPepper(store.DATA_DIR);

// ---------------------------------------------------------------------------
// Owner key
// ---------------------------------------------------------------------------

function resolveOwnerKey() {
  const fromEnv = (process.env.ADMIN_KEY || '').trim();
  if (fromEnv) return { key: fromEnv, generated: false };

  const file = path.join(store.DATA_DIR, 'admin-key.txt');
  if (fs.existsSync(file)) {
    const saved = fs.readFileSync(file, 'utf8').trim();
    if (saved) return { key: saved, generated: true };
  }
  // Four parts instead of the visitors' three: this one key opens every
  // conversation on the site, so it earns the extra word.
  const key = `${generateKey()}-${generateKey().split('-')[1]}`;
  fs.writeFileSync(file, `${key}\n`, { mode: 0o600 });
  return { key, generated: true };
}

const owner = resolveOwnerKey();
const OWNER_KEY_NORMALIZED = normalizeKey(owner.key);
const OWNER_KEY_HASH = crypto.createHmac('sha256', PEPPER).update(OWNER_KEY_NORMALIZED).digest('hex');

// If the owner key changed since last boot, old owner cookies must stop working.
if (store.getSetting('owner_key_hash') !== OWNER_KEY_HASH) {
  store.destroyAllOwnerSessions();
  store.setSetting('owner_key_hash', OWNER_KEY_HASH);
}

function isOwnerKey(normalized) {
  const a = Buffer.from(normalized);
  const b = Buffer.from(OWNER_KEY_NORMALIZED);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = express();
if (TRUST_PROXY) app.set('trust proxy', true);
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

const frameAncestors = ["'self'", ...EMBED_ORIGINS].join(' ');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "base-uri 'none'",
      "form-action 'self'",
      `frame-ancestors ${frameAncestors}`,
    ].join('; '),
  );
  next();
});

const isSecure = (req) => req.secure || req.headers['x-forwarded-proto'] === 'https';

// ---------------------------------------------------------------------------
// Rate limits
// ---------------------------------------------------------------------------

const loginLimiter = new RateLimiter({ limit: 12, windowMs: 15 * 60 * 1000 });
const signupLimiter = new RateLimiter({ limit: 8, windowMs: 60 * 60 * 1000 });
const messageLimiter = new RateLimiter({ limit: 40, windowMs: 5 * 60 * 1000 });
const conversationLimiter = new RateLimiter({ limit: 20, windowMs: 60 * 60 * 1000 });

setInterval(() => {
  loginLimiter.sweep();
  signupLimiter.sweep();
  messageLimiter.sweep();
  conversationLimiter.sweep();
  store.purgeExpiredSessions();
}, 10 * 60 * 1000).unref();

function limited(res, retryAfter, message) {
  res.setHeader('Retry-After', String(retryAfter));
  res.status(429).json({ error: message, retryAfter });
}

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

function readCookie(req, name) {
  if (!req._cookies) req._cookies = parseCookies(req.headers.cookie);
  return req._cookies[name];
}

function currentVisitor(req) {
  const token = readCookie(req, VISITOR_COOKIE);
  if (!token) return null;
  const session = store.getSession(tokenHash(token));
  if (!session) return null;
  const user = store.getUser(session.user_id);
  if (!user || user.blocked) return null;
  return user;
}

function currentOwner(req) {
  const token = readCookie(req, OWNER_COOKIE);
  if (!token) return false;
  return Boolean(store.getOwnerSession(tokenHash(token)));
}

function requireVisitor(req, res, next) {
  const user = currentVisitor(req);
  if (!user) return res.status(401).json({ error: 'Sign in with your key to continue.' });
  req.user = user;
  next();
}

function requireOwner(req, res, next) {
  if (!currentOwner(req)) return res.status(401).json({ error: 'Owner key required.' });
  next();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cleanText(value, max) {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    // Strip control characters but keep newlines and tabs.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, max);
}

function titleFrom(body) {
  const oneLine = body.replace(/\s+/g, ' ').trim();
  if (!oneLine) return 'New chat';
  return oneLine.length > 48 ? `${oneLine.slice(0, 47)}…` : oneLine;
}

function publicUser(user) {
  return {
    id: user.id,
    displayName: user.display_name,
    createdAt: user.created_at,
  };
}

function notifyOwner(user, conversation, message) {
  if (!NOTIFY_WEBHOOK_URL) return;
  const who = user.display_name || 'A visitor';
  const text = `${who} asked on ${SITE_NAME}: ${message.body.slice(0, 400)}`;
  // Fire and forget — a broken webhook must never block someone's question.
  fetch(NOTIFY_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      content: text,
      site: SITE_NAME,
      conversationId: conversation.id,
      userId: user.id,
      displayName: user.display_name,
      message: message.body,
    }),
  }).catch((err) => console.warn('[notify] webhook failed:', err.message));
}

function conversationForUser(req, res) {
  const conversation = store.getConversation(req.params.id);
  if (!conversation || conversation.user_id !== req.user.id) {
    res.status(404).json({ error: 'Chat not found.' });
    return null;
  }
  return conversation;
}

// ---------------------------------------------------------------------------
// Public config
// ---------------------------------------------------------------------------

app.get('/api/config', (req, res) => {
  res.json({
    siteName: SITE_NAME,
    ownerName: OWNER_NAME,
    keyDigits: KEY_DIGITS,
    ownerOnline: events.hasListeners(events.OWNER_CHANNEL),
  });
});

// ---------------------------------------------------------------------------
// Auth routes
// ---------------------------------------------------------------------------

app.post('/api/auth/new', (req, res) => {
  const wait = signupLimiter.check(req.ip);
  if (wait) return limited(res, wait, 'Too many keys made from this connection. Try again later.');

  const displayName = cleanText(req.body?.displayName, MAX_NAME_CHARS);

  let key = null;
  let lookup = null;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const candidate = generateKey();
    const candidateLookup = lookupHash(normalizeKey(candidate), PEPPER);
    if (!store.findUserByLookup(candidateLookup) && !isOwnerKey(normalizeKey(candidate))) {
      key = candidate;
      lookup = candidateLookup;
      break;
    }
  }
  if (!key) return res.status(503).json({ error: 'Could not make a key right now. Try again.' });

  const user = store.createUser({
    lookupHash: lookup,
    keyHash: hashKey(normalizeKey(key)),
    displayName,
  });

  const token = newSessionToken();
  store.createSession(user.id, tokenHash(token), SESSION_TTL_MS);
  setSessionCookie(res, VISITOR_COOKIE, token, { secure: isSecure(req) });

  res.json({ key, user: publicUser(user) });
});

app.post('/api/auth/login', (req, res) => {
  const wait = loginLimiter.check(req.ip);
  if (wait) return limited(res, wait, 'Too many tries. Wait a bit and try your key again.');

  const normalized = normalizeKey(req.body?.key);
  if (normalized.length < 6) return res.status(401).json({ error: 'That key does not look right.' });

  if (isOwnerKey(normalized)) {
    const token = newSessionToken();
    store.createOwnerSession(tokenHash(token), SESSION_TTL_MS);
    setSessionCookie(res, OWNER_COOKIE, token, { secure: isSecure(req) });
    loginLimiter.reset(req.ip);
    return res.json({ owner: true, redirect: '/admin' });
  }

  const user = store.findUserByLookup(lookupHash(normalized, PEPPER));
  if (!user || !verifyKey(normalized, user.key_hash)) {
    return res.status(401).json({ error: 'No chat found for that key. Check the spelling.' });
  }
  if (user.blocked) return res.status(403).json({ error: 'This key is no longer active.' });

  store.touchUser(user.id);
  const token = newSessionToken();
  store.createSession(user.id, tokenHash(token), SESSION_TTL_MS);
  setSessionCookie(res, VISITOR_COOKIE, token, { secure: isSecure(req) });
  loginLimiter.reset(req.ip);

  res.json({ user: publicUser(user), redirect: '/chat' });
});

app.post('/api/auth/logout', (req, res) => {
  const visitorToken = readCookie(req, VISITOR_COOKIE);
  if (visitorToken) store.destroySession(tokenHash(visitorToken));
  const ownerToken = readCookie(req, OWNER_COOKIE);
  if (ownerToken) store.destroyOwnerSession(tokenHash(ownerToken));
  clearSessionCookie(res, VISITOR_COOKIE, { secure: isSecure(req) });
  clearSessionCookie(res, OWNER_COOKIE, { secure: isSecure(req) });
  res.json({ ok: true });
});

app.get('/api/me', requireVisitor, (req, res) => {
  store.touchUser(req.user.id);
  res.json({
    user: publicUser(req.user),
    ownerName: OWNER_NAME,
    ownerOnline: events.hasListeners(events.OWNER_CHANNEL),
  });
});

app.patch('/api/me', requireVisitor, (req, res) => {
  const displayName = cleanText(req.body?.displayName, MAX_NAME_CHARS);
  store.setDisplayName(req.user.id, displayName);
  events.publish(events.OWNER_CHANNEL, 'user', { userId: req.user.id, displayName });
  res.json({ user: publicUser({ ...req.user, display_name: displayName }) });
});

// ---------------------------------------------------------------------------
// Visitor chat routes
// ---------------------------------------------------------------------------

app.get('/api/conversations', requireVisitor, (req, res) => {
  res.json({ conversations: store.listConversations(req.user.id) });
});

app.post('/api/conversations', requireVisitor, (req, res) => {
  const wait = conversationLimiter.check(req.user.id);
  if (wait) return limited(res, wait, 'That is a lot of new chats. Give it a minute.');
  const conversation = store.createConversation(req.user.id);
  res.json({ conversation: { ...conversation, unread: 0, preview: '' } });
});

app.get('/api/conversations/:id', requireVisitor, (req, res) => {
  const conversation = conversationForUser(req, res);
  if (!conversation) return;
  store.markUserRead(conversation.id);
  res.json({ conversation, messages: store.listMessages(conversation.id) });
});

app.patch('/api/conversations/:id', requireVisitor, (req, res) => {
  const conversation = conversationForUser(req, res);
  if (!conversation) return;
  const title = cleanText(req.body?.title, 80) || 'New chat';
  store.setTitle(conversation.id, title);
  events.publish(events.OWNER_CHANNEL, 'conversation', { conversationId: conversation.id, title });
  res.json({ ok: true, title });
});

app.delete('/api/conversations/:id', requireVisitor, (req, res) => {
  const conversation = conversationForUser(req, res);
  if (!conversation) return;
  store.deleteConversation(conversation.id);
  events.publish(events.OWNER_CHANNEL, 'removed', { conversationId: conversation.id });
  res.json({ ok: true });
});

app.post('/api/conversations/:id/read', requireVisitor, (req, res) => {
  const conversation = conversationForUser(req, res);
  if (!conversation) return;
  store.markUserRead(conversation.id);
  res.json({ ok: true });
});

app.post('/api/conversations/:id/messages', requireVisitor, (req, res) => {
  const conversation = conversationForUser(req, res);
  if (!conversation) return;

  const body = cleanText(req.body?.body, MAX_MESSAGE_CHARS);
  if (!body) return res.status(400).json({ error: 'Type a question first.' });

  const wait = messageLimiter.check(req.user.id);
  if (wait) return limited(res, wait, 'Slow down a moment — too many messages at once.');

  const isFirst = store.messageCount(conversation.id) === 0;
  const stored = store.addMessage(conversation.id, 'user', body);
  if (isFirst) store.setTitle(conversation.id, titleFrom(body));

  // The sender draws its own message immediately, then also receives it back
  // over the event stream (that stream is what keeps a visitor's other tabs in
  // sync). Echoing the sender's own id lets each client recognise its own
  // message and skip it instead of drawing it twice.
  const message = { ...stored, clientId: cleanText(req.body?.clientId, 64) || null };

  const updated = store.getConversation(conversation.id);
  events.publish(events.OWNER_CHANNEL, 'message', {
    conversationId: conversation.id,
    userId: req.user.id,
    displayName: req.user.display_name,
    title: updated.title,
    message,
  });
  events.publish(`user:${req.user.id}`, 'message', {
    conversationId: conversation.id,
    title: updated.title,
    message,
  });

  notifyOwner(req.user, conversation, message);

  res.json({ message, title: updated.title, ownerOnline: events.hasListeners(events.OWNER_CHANNEL) });
});

app.post('/api/conversations/:id/typing', requireVisitor, (req, res) => {
  const conversation = conversationForUser(req, res);
  if (!conversation) return;
  events.publish(events.OWNER_CHANNEL, 'typing', {
    conversationId: conversation.id,
    who: 'user',
  });
  res.json({ ok: true });
});

app.get('/api/events', requireVisitor, (req, res) => {
  req.socket.setTimeout(0);
  events.subscribe(`user:${req.user.id}`, res);
});

// ---------------------------------------------------------------------------
// Owner routes
// ---------------------------------------------------------------------------

app.get('/api/owner/me', requireOwner, (req, res) => {
  res.json({
    ownerName: OWNER_NAME,
    siteName: SITE_NAME,
    users: store.countUsers(),
    unread: store.adminUnreadTotal(),
  });
});

app.get('/api/owner/inbox', requireOwner, (req, res) => {
  res.json({ conversations: store.adminInbox(300), unread: store.adminUnreadTotal() });
});

app.get('/api/owner/conversations/:id', requireOwner, (req, res) => {
  const conversation = store.getConversation(req.params.id);
  if (!conversation) return res.status(404).json({ error: 'Chat not found.' });
  const user = store.getUser(conversation.user_id);
  store.markAdminRead(conversation.id);
  res.json({
    conversation,
    messages: store.listMessages(conversation.id),
    user: user
      ? {
          id: user.id,
          displayName: user.display_name,
          note: user.note,
          blocked: Boolean(user.blocked),
          createdAt: user.created_at,
          lastSeenAt: user.last_seen_at,
        }
      : null,
  });
});

app.post('/api/owner/conversations/:id/messages', requireOwner, (req, res) => {
  const conversation = store.getConversation(req.params.id);
  if (!conversation) return res.status(404).json({ error: 'Chat not found.' });

  const body = cleanText(req.body?.body, MAX_MESSAGE_CHARS);
  if (!body) return res.status(400).json({ error: 'Nothing to send.' });

  const stored = store.addMessage(conversation.id, 'owner', body);
  const message = { ...stored, clientId: cleanText(req.body?.clientId, 64) || null };

  events.publish(`user:${conversation.user_id}`, 'message', {
    conversationId: conversation.id,
    message,
  });
  events.publish(events.OWNER_CHANNEL, 'message', {
    conversationId: conversation.id,
    userId: conversation.user_id,
    message,
  });
  res.json({ message });
});

app.post('/api/owner/conversations/:id/typing', requireOwner, (req, res) => {
  const conversation = store.getConversation(req.params.id);
  if (!conversation) return res.status(404).json({ error: 'Chat not found.' });
  events.publish(`user:${conversation.user_id}`, 'typing', {
    conversationId: conversation.id,
    who: 'owner',
  });
  res.json({ ok: true });
});

app.post('/api/owner/conversations/:id/read', requireOwner, (req, res) => {
  const conversation = store.getConversation(req.params.id);
  if (!conversation) return res.status(404).json({ error: 'Chat not found.' });
  store.markAdminRead(conversation.id);
  res.json({ ok: true });
});

app.delete('/api/owner/conversations/:id', requireOwner, (req, res) => {
  const conversation = store.getConversation(req.params.id);
  if (!conversation) return res.status(404).json({ error: 'Chat not found.' });
  store.deleteConversation(conversation.id);
  events.publish(`user:${conversation.user_id}`, 'removed', { conversationId: conversation.id });
  res.json({ ok: true });
});

app.patch('/api/owner/users/:id', requireOwner, (req, res) => {
  const user = store.getUser(req.params.id);
  if (!user) return res.status(404).json({ error: 'Visitor not found.' });
  if (typeof req.body?.note === 'string') store.setNote(user.id, cleanText(req.body.note, 500));
  if (typeof req.body?.displayName === 'string') {
    store.setDisplayName(user.id, cleanText(req.body.displayName, MAX_NAME_CHARS));
  }
  if (typeof req.body?.blocked === 'boolean') store.setBlocked(user.id, req.body.blocked);
  const fresh = store.getUser(user.id);
  res.json({
    user: {
      id: fresh.id,
      displayName: fresh.display_name,
      note: fresh.note,
      blocked: Boolean(fresh.blocked),
    },
  });
});

app.get('/api/owner/events', requireOwner, (req, res) => {
  req.socket.setTimeout(0);
  const wasOnline = events.hasListeners(events.OWNER_CHANNEL);
  const unsubscribe = events.subscribe(events.OWNER_CHANNEL, res);

  // Flip everyone's "away" badge the moment the desk is staffed, and back
  // again when the last owner tab closes.
  if (!wasOnline) events.broadcastToVisitors('presence', { ownerOnline: true });

  const announceDeparture = () => {
    unsubscribe();
    if (!events.hasListeners(events.OWNER_CHANNEL)) {
      events.broadcastToVisitors('presence', { ownerOnline: false });
    }
  };
  res.on('close', announceDeparture);
});

// ---------------------------------------------------------------------------
// Pages and static files
// ---------------------------------------------------------------------------

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC_DIR, { extensions: [], index: false, maxAge: '1h' }));

const page = (file) => (req, res) => res.sendFile(path.join(PUBLIC_DIR, file));
app.get('/', page('index.html'));
app.get('/chat', page('chat.html'));
app.get('/admin', page('admin.html'));

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found.' });
  res.status(404).sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Something went wrong on our side.' });
});

// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  const combos = keyspaceSize().toLocaleString('en-US');
  console.log(`\n  ${SITE_NAME} is running on http://localhost:${PORT}`);
  console.log(`  Visitors:  http://localhost:${PORT}/`);
  console.log(`  Your desk: http://localhost:${PORT}/admin`);
  console.log(`  Keys look like "meadow-drifting-${'4'.repeat(KEY_DIGITS)}" (${combos} possible)`);
  if (owner.generated) {
    console.log(`\n  Your owner key (also saved in ${path.join(store.DATA_DIR, 'admin-key.txt')}):`);
    console.log(`      ${owner.key}`);
    console.log('  Set ADMIN_KEY in .env to choose your own.\n');
  } else {
    console.log('  Owner key: loaded from ADMIN_KEY.\n');
  }
});
