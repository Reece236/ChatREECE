'use strict';

const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'chatreece.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');

// ---------------------------------------------------------------------------
// Migration off the original passkey scheme
//
// The first version of this app identified people by a generated key with no
// username. Those rows cannot be carried into username/password accounts —
// there is no username to assign and no password to derive. Rather than
// deleting anything, the old tables are set aside under a _legacy_keyauth
// suffix so the data is still there to inspect.
// ---------------------------------------------------------------------------

function tableExists(name) {
  return Boolean(
    db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(name),
  );
}

function columnNames(table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

if (tableExists('users') && !columnNames('users').includes('username')) {
  const carried = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  console.warn(
    `[migration] Found ${carried} account(s) from the old passkey scheme. ` +
      'Those tables are being renamed with a _legacy_keyauth suffix; ' +
      'people will need to sign up with a username and password.',
  );
  db.exec('PRAGMA foreign_keys = OFF');
  for (const t of ['messages', 'conversations', 'sessions', 'users']) {
    if (tableExists(t)) db.exec(`ALTER TABLE ${t} RENAME TO ${t}_legacy_keyauth`);
  }
  db.exec('PRAGMA foreign_keys = ON');
}

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    username      TEXT NOT NULL,
    username_key  TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    note          TEXT NOT NULL DEFAULT '',
    blocked       INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL,
    last_seen_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash  TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

  CREATE TABLE IF NOT EXISTS owner_sessions (
    token_hash  TEXT PRIMARY KEY,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title         TEXT NOT NULL DEFAULT 'New chat',
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    admin_read_at INTEGER NOT NULL DEFAULT 0,
    user_read_at  INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC);

  CREATE TABLE IF NOT EXISTS messages (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role            TEXT NOT NULL CHECK (role IN ('user', 'owner')),
    body            TEXT NOT NULL,
    created_at      INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);

  -- One row per browser that has agreed to receive notifications. user_id is
  -- null for the owner's own devices.
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint   TEXT PRIMARY KEY,
    user_id    TEXT REFERENCES users(id) ON DELETE CASCADE,
    is_owner   INTEGER NOT NULL DEFAULT 0,
    p256dh     TEXT NOT NULL,
    auth       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);
  CREATE INDEX IF NOT EXISTS idx_push_owner ON push_subscriptions(is_owner);
`);

const now = () => Date.now();
const newId = () => crypto.randomUUID();

// node:sqlite hands back null-prototype rows; copying them keeps downstream
// code and JSON serialisation unsurprising.
const plain = (row) => (row ? { ...row } : null);
const plainAll = (rows) => rows.map((row) => ({ ...row }));

const q = {
  insertUser: db.prepare(`
    INSERT INTO users (id, username, username_key, password_hash, created_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  userByUsername: db.prepare('SELECT * FROM users WHERE username_key = ?'),
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  touchUser: db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?'),
  setPassword: db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
  setNote: db.prepare('UPDATE users SET note = ? WHERE id = ?'),
  setBlocked: db.prepare('UPDATE users SET blocked = ? WHERE id = ?'),
  countUsers: db.prepare('SELECT COUNT(*) AS n FROM users'),

  insertSession: db.prepare(`
    INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)
  `),
  sessionByHash: db.prepare('SELECT * FROM sessions WHERE token_hash = ?'),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
  deleteExpiredSessions: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),

  insertOwnerSession: db.prepare(`
    INSERT INTO owner_sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)
  `),
  ownerSessionByHash: db.prepare('SELECT * FROM owner_sessions WHERE token_hash = ?'),
  deleteOwnerSession: db.prepare('DELETE FROM owner_sessions WHERE token_hash = ?'),
  deleteExpiredOwnerSessions: db.prepare('DELETE FROM owner_sessions WHERE expires_at < ?'),
  deleteAllOwnerSessions: db.prepare('DELETE FROM owner_sessions'),

  insertConversation: db.prepare(`
    INSERT INTO conversations (id, user_id, title, created_at, updated_at, admin_read_at, user_read_at)
    VALUES (?, ?, ?, ?, ?, 0, ?)
  `),
  conversationById: db.prepare('SELECT * FROM conversations WHERE id = ?'),
  conversationsForUser: db.prepare(
    'SELECT * FROM conversations WHERE user_id = ? ORDER BY updated_at DESC',
  ),
  setTitle: db.prepare('UPDATE conversations SET title = ? WHERE id = ?'),
  touchConversation: db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?'),
  markAdminRead: db.prepare('UPDATE conversations SET admin_read_at = ? WHERE id = ?'),
  markUserRead: db.prepare('UPDATE conversations SET user_read_at = ? WHERE id = ?'),
  deleteConversation: db.prepare('DELETE FROM conversations WHERE id = ?'),

  insertMessage: db.prepare(`
    INSERT INTO messages (id, conversation_id, role, body, created_at) VALUES (?, ?, ?, ?, ?)
  `),
  messagesFor: db.prepare(`
    SELECT id, role, body, created_at FROM messages
    WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC
  `),
  messageCount: db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?'),
  lastMessage: db.prepare(`
    SELECT body, role FROM messages WHERE conversation_id = ?
    ORDER BY created_at DESC, rowid DESC LIMIT 1
  `),
  unreadForUser: db.prepare(`
    SELECT COUNT(*) AS n FROM messages
    WHERE conversation_id = ? AND role = 'owner' AND created_at > ?
  `),

  insertPush: db.prepare(`
    INSERT INTO push_subscriptions (endpoint, user_id, is_owner, p256dh, auth, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET
      user_id = excluded.user_id,
      is_owner = excluded.is_owner,
      p256dh = excluded.p256dh,
      auth = excluded.auth
  `),
  pushForUser: db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?'),
  pushForOwner: db.prepare('SELECT * FROM push_subscriptions WHERE is_owner = 1'),
  deletePush: db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?'),
  countPushForUser: db.prepare(
    'SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?',
  ),
  countPushForOwner: db.prepare(
    'SELECT COUNT(*) AS n FROM push_subscriptions WHERE is_owner = 1',
  ),
};

const adminInboxStmt = db.prepare(`
  SELECT
    c.id, c.title, c.user_id, c.created_at, c.updated_at, c.admin_read_at,
    u.username, u.blocked, u.note,
    (SELECT body FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC, rowid DESC LIMIT 1) AS last_body,
    (SELECT role FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC, rowid DESC LIMIT 1) AS last_role,
    (SELECT COUNT(*) FROM messages
      WHERE conversation_id = c.id AND role = 'user' AND created_at > c.admin_read_at) AS unread
  FROM conversations c
  JOIN users u ON u.id = c.user_id
  WHERE EXISTS (SELECT 1 FROM messages WHERE conversation_id = c.id)
  ORDER BY c.updated_at DESC
  LIMIT ?
`);

const getSettingStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const setSettingStmt = db.prepare(`
  INSERT INTO settings (key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`);

const store = {
  db,
  DATA_DIR,

  getSetting(key) {
    const row = getSettingStmt.get(key);
    return row ? row.value : null;
  },

  setSetting(key, value) {
    setSettingStmt.run(key, String(value));
  },

  // -- users ---------------------------------------------------------------

  createUser({ username, usernameKey, passwordHash }) {
    const id = newId();
    const ts = now();
    q.insertUser.run(id, username, usernameKey, passwordHash, ts, ts);
    return plain(q.userById.get(id));
  },

  findUserByUsername(usernameKey) {
    return plain(q.userByUsername.get(usernameKey));
  },

  getUser(id) {
    return plain(q.userById.get(id));
  },

  touchUser(id) {
    q.touchUser.run(now(), id);
  },

  setPassword(id, passwordHash) {
    q.setPassword.run(passwordHash, id);
  },

  setNote(id, note) {
    q.setNote.run(note, id);
  },

  setBlocked(id, blocked) {
    q.setBlocked.run(blocked ? 1 : 0, id);
  },

  countUsers() {
    return q.countUsers.get().n;
  },

  // -- sessions ------------------------------------------------------------

  createSession(userId, tokenHash, ttlMs) {
    const ts = now();
    q.insertSession.run(tokenHash, userId, ts, ts + ttlMs);
    return tokenHash;
  },

  getSession(tokenHash) {
    const row = plain(q.sessionByHash.get(tokenHash));
    if (!row) return null;
    if (row.expires_at < now()) {
      q.deleteSession.run(tokenHash);
      return null;
    }
    return row;
  },

  destroySession(tokenHash) {
    q.deleteSession.run(tokenHash);
  },

  purgeExpiredSessions() {
    q.deleteExpiredSessions.run(now());
    q.deleteExpiredOwnerSessions.run(now());
  },

  createOwnerSession(tokenHash, ttlMs) {
    const ts = now();
    q.insertOwnerSession.run(tokenHash, ts, ts + ttlMs);
    return tokenHash;
  },

  getOwnerSession(tokenHash) {
    const row = plain(q.ownerSessionByHash.get(tokenHash));
    if (!row) return null;
    if (row.expires_at < now()) {
      q.deleteOwnerSession.run(tokenHash);
      return null;
    }
    return row;
  },

  destroyOwnerSession(tokenHash) {
    q.deleteOwnerSession.run(tokenHash);
  },

  destroyAllOwnerSessions() {
    q.deleteAllOwnerSessions.run();
  },

  // -- conversations -------------------------------------------------------

  createConversation(userId, title = 'New chat') {
    const id = newId();
    const ts = now();
    q.insertConversation.run(id, userId, title, ts, ts, ts);
    return plain(q.conversationById.get(id));
  },

  getConversation(id) {
    return plain(q.conversationById.get(id));
  },

  listConversations(userId) {
    return plainAll(q.conversationsForUser.all(userId)).map((c) => {
      const last = q.lastMessage.get(c.id);
      return {
        ...c,
        unread: q.unreadForUser.get(c.id, c.user_read_at).n,
        preview: last ? String(last.body).slice(0, 120) : '',
      };
    });
  },

  setTitle(id, title) {
    q.setTitle.run(title, id);
  },

  deleteConversation(id) {
    q.deleteConversation.run(id);
  },

  addMessage(conversationId, role, body) {
    const id = newId();
    const ts = now();
    q.insertMessage.run(id, conversationId, role, body, ts);
    q.touchConversation.run(ts, conversationId);
    // Whoever just spoke has by definition seen everything before it.
    if (role === 'user') q.markUserRead.run(ts, conversationId);
    else q.markAdminRead.run(ts, conversationId);
    return { id, role, body, created_at: ts };
  },

  listMessages(conversationId) {
    return plainAll(q.messagesFor.all(conversationId));
  },

  messageCount(conversationId) {
    return q.messageCount.get(conversationId).n;
  },

  markAdminRead(id) {
    q.markAdminRead.run(now(), id);
  },

  markUserRead(id) {
    q.markUserRead.run(now(), id);
  },

  adminInbox(limit = 300) {
    return plainAll(adminInboxStmt.all(limit));
  },

  adminUnreadTotal() {
    return db
      .prepare(
        `SELECT COUNT(*) AS n FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
         WHERE m.role = 'user' AND m.created_at > c.admin_read_at`,
      )
      .get().n;
  },

  // -- push ----------------------------------------------------------------

  savePushSubscription({ endpoint, userId, isOwner, p256dh, auth }) {
    q.insertPush.run(endpoint, userId || null, isOwner ? 1 : 0, p256dh, auth, now());
  },

  pushSubscriptionsForUser(userId) {
    return plainAll(q.pushForUser.all(userId));
  },

  pushSubscriptionsForOwner() {
    return plainAll(q.pushForOwner.all());
  },

  deletePushSubscription(endpoint) {
    q.deletePush.run(endpoint);
  },

  hasPushForUser(userId) {
    return q.countPushForUser.get(userId).n > 0;
  },

  hasPushForOwner() {
    return q.countPushForOwner.get().n > 0;
  },
};

module.exports = store;
