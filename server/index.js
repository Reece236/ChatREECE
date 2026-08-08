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
const push = require('./push');
const {
  PASSWORD_MIN,
  RateLimiter,
  SESSION_DAYS,
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
  const key = generateKey(3);
  fs.writeFileSync(file, `${key}\n`, { mode: 0o600 });
  return { key, generated: true };
}

const owner = resolveOwnerKey();
const OWNER_KEY_NORMALIZED = normalizeKey(owner.key);
const OWNER_KEY_HASH = crypto
  .createHmac('sha256', PEPPER)
  .update(OWNER_KEY_NORMALIZED)
  .digest('hex');

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
      "style-src 'self'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "worker-src 'self'",
      "manifest-src 'self'",
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

const loginLimiter = new RateLimiter({ limit: 10, windowMs: 15 * 60 * 1000 });
const accountLimiter = new RateLimiter({ limit: 10, windowMs: 60 * 60 * 1000 });
// Counts only accounts actually created, so a shared office or family NAT has
// room to sign several people up.
const signupLimiter = new RateLimiter({ limit: 10, windowMs: 60 * 60 * 1000 });
const messageLimiter = new RateLimiter({ limit: 40, windowMs: 5 * 60 * 1000 });
const conversationLimiter = new RateLimiter({ limit: 20, windowMs: 60 * 60 * 1000 });

setInterval(() => {
  for (const l of [loginLimiter, accountLimiter, signupLimiter, messageLimiter, conversationLimiter]) {
    l.sweep();
  }
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

function requireVisitor(req, res, next) {
  const user = currentVisitor(req);
  if (!user) return res.status(401).json({ error: 'Sign in to continue.' });
  req.user = user;
  next();
}

function requireOwner(req, res, next) {
  const token = readCookie(req, OWNER_COOKIE);
  if (!token || !store.getOwnerSession(tokenHash(token))) {
    return res.status(401).json({ error: 'Owner key required.' });
  }
  next();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cleanText(value, max) {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    // Strip control characters, keeping newlines and tabs.
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
  return { id: user.id, username: user.username, createdAt: user.created_at };
}

function startSession(res, req, userId) {
  const token = newSessionToken();
  store.createSession(userId, tokenHash(token), SESSION_TTL_MS);
  setSessionCookie(res, VISITOR_COOKIE, token, { secure: isSecure(req) });
}

function fireWebhook(user, conversation, message) {
  if (!NOTIFY_WEBHOOK_URL) return;
  const text = `${user.username} asked on ${SITE_NAME}: ${message.body.slice(0, 400)}`;
  fetch(NOTIFY_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      content: text,
      site: SITE_NAME,
      conversationId: conversation.id,
      username: user.username,
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
// Config
// ---------------------------------------------------------------------------

app.get('/api/config', (req, res) => {
  res.json({
    siteName: SITE_NAME,
    ownerName: OWNER_NAME,
    passwordMin: PASSWORD_MIN,
    ownerOnline: events.hasListeners(events.OWNER_CHANNEL),
  });
});

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

app.post('/api/auth/signup', (req, res) => {
  // Validation runs before the rate limit on purpose. Counting rejected
  // attempts would mean a few fat-fingered passwords locks someone out of
  // signing up for an hour; only accounts that actually get created count.
  const username = validateUsername(req.body?.username);
  if (!username.ok) return res.status(400).json({ error: username.error, field: 'username' });

  const password = validatePassword(req.body?.password);
  if (!password.ok) return res.status(400).json({ error: password.error, field: 'password' });

  if (store.findUserByUsername(username.lookup)) {
    return res.status(409).json({ error: 'That username is taken.', field: 'username' });
  }

  const wait = signupLimiter.check(req.ip);
  if (wait) return limited(res, wait, 'Too many accounts from this connection. Try again later.');

  const user = store.createUser({
    username: username.display,
    usernameKey: username.lookup,
    passwordHash: hashPassword(password.password),
  });

  startSession(res, req, user.id);
  res.json({ user: publicUser(user), redirect: '/chat' });
});

app.post('/api/auth/login', (req, res) => {
  const wait = loginLimiter.check(req.ip);
  if (wait) return limited(res, wait, 'Too many tries. Wait a few minutes and try again.');

  const lookup = normalizeUsername(req.body?.username);
  const password = String(req.body?.password || '');

  const user = lookup ? store.findUserByUsername(lookup) : null;
  if (!user) {
    // Spend the same time as a real check so a missing username and a wrong
    // password are indistinguishable from the outside.
    wasteTime(password);
    return res.status(401).json({ error: 'Wrong username or password.' });
  }
  if (!verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Wrong username or password.' });
  }
  if (user.blocked) return res.status(403).json({ error: 'This account has been disabled.' });

  store.touchUser(user.id);
  startSession(res, req, user.id);
  loginLimiter.reset(req.ip);
  res.json({ user: publicUser(user), redirect: '/chat' });
});

app.post('/api/auth/owner', (req, res) => {
  const wait = loginLimiter.check(req.ip);
  if (wait) return limited(res, wait, 'Too many tries. Wait a few minutes and try again.');

  if (!isOwnerKey(normalizeKey(req.body?.key))) {
    return res.status(401).json({ error: 'That key is not right.' });
  }
  const token = newSessionToken();
  store.createOwnerSession(tokenHash(token), SESSION_TTL_MS);
  setSessionCookie(res, OWNER_COOKIE, token, { secure: isSecure(req) });
  loginLimiter.reset(req.ip);
  res.json({ owner: true, redirect: '/admin' });
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
    pushEnabled: store.hasPushForUser(req.user.id),
  });
});

app.post('/api/me/password', requireVisitor, (req, res) => {
  const wait = accountLimiter.check(req.user.id);
  if (wait) return limited(res, wait, 'Too many attempts. Try again later.');

  if (!verifyPassword(String(req.body?.currentPassword || ''), req.user.password_hash)) {
    return res.status(401).json({ error: 'Current password is wrong.' });
  }
  const next = validatePassword(req.body?.newPassword);
  if (!next.ok) return res.status(400).json({ error: next.error });

  store.setPassword(req.user.id, hashPassword(next.password));
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Push notifications
// ---------------------------------------------------------------------------

app.get('/api/push/key', (req, res) => {
  res.json({ publicKey: push.publicKey });
});

function readSubscription(body) {
  const endpoint = String(body?.endpoint || '');
  const p256dh = String(body?.keys?.p256dh || '');
  const auth = String(body?.keys?.auth || '');
  if (!/^https:\/\//.test(endpoint) || !p256dh || !auth) return null;
  return { endpoint, p256dh, auth };
}

app.post('/api/push/subscribe', requireVisitor, (req, res) => {
  const sub = readSubscription(req.body);
  if (!sub) return res.status(400).json({ error: 'That subscription looks wrong.' });
  store.savePushSubscription({ ...sub, userId: req.user.id, isOwner: false });
  res.json({ ok: true });
});

app.post('/api/push/unsubscribe', (req, res) => {
  const endpoint = String(req.body?.endpoint || '');
  if (endpoint) store.deletePushSubscription(endpoint);
  res.json({ ok: true });
});

app.post('/api/owner/push/subscribe', requireOwner, (req, res) => {
  const sub = readSubscription(req.body);
  if (!sub) return res.status(400).json({ error: 'That subscription looks wrong.' });
  store.savePushSubscription({ ...sub, userId: null, isOwner: true });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Visitor chat
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

  // The sender draws its own message immediately and also receives it back on
  // its event stream (which is what syncs their other tabs). Echoing the
  // sender's id lets that tab recognise its own message instead of drawing it
  // twice.
  const message = { ...stored, clientId: cleanText(req.body?.clientId, 64) || null };
  const updated = store.getConversation(conversation.id);

  events.publish(events.OWNER_CHANNEL, 'message', {
    conversationId: conversation.id,
    userId: req.user.id,
    username: req.user.username,
    title: updated.title,
    message,
  });
  events.publish(`user:${req.user.id}`, 'message', {
    conversationId: conversation.id,
    title: updated.title,
    message,
  });

  fireWebhook(req.user, conversation, message);
  // Skip the push if a desk tab is already streaming — it would arrive
  // alongside the message appearing on screen.
  if (!events.hasListeners(events.OWNER_CHANNEL)) {
    push
      .notifyOwner({
        title: `${req.user.username} asked a question`,
        body: body.slice(0, 160),
        conversationId: conversation.id,
      })
      .catch((err) => console.warn('[push] owner notify failed:', err.message));
  }

  res.json({ message, title: updated.title, ownerOnline: events.hasListeners(events.OWNER_CHANNEL) });
});

app.post('/api/conversations/:id/typing', requireVisitor, (req, res) => {
  const conversation = conversationForUser(req, res);
  if (!conversation) return;
  events.publish(events.OWNER_CHANNEL, 'typing', { conversationId: conversation.id });
  res.json({ ok: true });
});

app.get('/api/events', requireVisitor, (req, res) => {
  req.socket.setTimeout(0);
  events.subscribe(`user:${req.user.id}`, res);
});

// ---------------------------------------------------------------------------
// Owner
// ---------------------------------------------------------------------------

app.get('/api/owner/me', requireOwner, (req, res) => {
  res.json({
    ownerName: OWNER_NAME,
    siteName: SITE_NAME,
    users: store.countUsers(),
    unread: store.adminUnreadTotal(),
    pushEnabled: store.hasPushForOwner(),
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
          username: user.username,
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

  // The whole point of notifying someone is that they are not looking. If
  // their tab is live they are about to see it anyway.
  if (!events.hasListeners(`user:${conversation.user_id}`)) {
    push
      .notifyUser(conversation.user_id, {
        title: `${OWNER_NAME} replied`,
        body: body.slice(0, 160),
        conversationId: conversation.id,
      })
      .catch((err) => console.warn('[push] user notify failed:', err.message));
  }

  res.json({ message });
});

app.post('/api/owner/conversations/:id/typing', requireOwner, (req, res) => {
  const conversation = store.getConversation(req.params.id);
  if (!conversation) return res.status(404).json({ error: 'Chat not found.' });
  events.publish(`user:${conversation.user_id}`, 'typing', { conversationId: conversation.id });
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
  if (!user) return res.status(404).json({ error: 'Person not found.' });
  if (typeof req.body?.note === 'string') store.setNote(user.id, cleanText(req.body.note, 500));
  if (typeof req.body?.blocked === 'boolean') store.setBlocked(user.id, req.body.blocked);
  const fresh = store.getUser(user.id);
  res.json({
    user: {
      id: fresh.id,
      username: fresh.username,
      note: fresh.note,
      blocked: Boolean(fresh.blocked),
    },
  });
});

app.get('/api/owner/events', requireOwner, (req, res) => {
  req.socket.setTimeout(0);
  const wasOnline = events.hasListeners(events.OWNER_CHANNEL);
  const unsubscribe = events.subscribe(events.OWNER_CHANNEL, res);
  if (!wasOnline) events.broadcastToVisitors('presence', { ownerOnline: true });

  res.on('close', () => {
    unsubscribe();
    if (!events.hasListeners(events.OWNER_CHANNEL)) {
      events.broadcastToVisitors('presence', { ownerOnline: false });
    }
  });
});

// ---------------------------------------------------------------------------
// Pages and static files
// ---------------------------------------------------------------------------

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// The service worker must not be cached aggressively, or a fix to it could
// take a day to reach people. It also has to be served from the root for its
// scope to cover the whole site.
app.get('/sw.js', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Service-Worker-Allowed', '/');
  res.sendFile(path.join(PUBLIC_DIR, 'sw.js'));
});

app.use(express.static(PUBLIC_DIR, { index: false, maxAge: '1h' }));

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

app.listen(PORT, () => {
  console.log(`\n  ${SITE_NAME} is running on http://localhost:${PORT}`);
  console.log(`  Visitors:  http://localhost:${PORT}/`);
  console.log(`  Your desk: http://localhost:${PORT}/admin`);
  if (owner.generated) {
    console.log(`\n  Your owner key (also in ${path.join(store.DATA_DIR, 'admin-key.txt')}):`);
    console.log(`      ${owner.key}`);
    console.log('  Set ADMIN_KEY in .env to choose your own.\n');
  } else {
    console.log('  Owner key: loaded from ADMIN_KEY.\n');
  }
});
