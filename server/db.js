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

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    lookup_hash   TEXT NOT NULL UNIQUE,
    key_hash      TEXT NOT NULL,
    display_name  TEXT NOT NULL DEFAULT '',
    note          TEXT NOT NULL DEFAULT '',
    blocked       INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL,
    last_seen_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash  TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

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
`);

const now = () => Date.now();
const newId = () => crypto.randomUUID();

// node:sqlite hands back null-prototype rows. Copying them into ordinary
// objects keeps downstream code (and JSON serialisation) unsurprising.
const plain = (row) => (row ? { ...row } : null);
const plainAll = (rows) => rows.map((row) => ({ ...row }));

const q = {
  insertUser: db.prepare(`
    INSERT INTO users (id, lookup_hash, key_hash, display_name, created_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  userByLookup: db.prepare('SELECT * FROM users WHERE lookup_hash = ?'),
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  touchUser: db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?'),
  setDisplayName: db.prepare('UPDATE users SET display_name = ? WHERE id = ?'),
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
  conversationsForUser: db.prepare(`
    SELECT * FROM conversations WHERE user_id = ? ORDER BY updated_at DESC
  `),
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
  recentUserMessageCount: db.prepare(`
    SELECT COUNT(*) AS n FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE c.user_id = ? AND m.role = 'user' AND m.created_at > ?
  `),
};

// The admin inbox needs a row per conversation with the visitor attached and a
// preview of the latest message, sorted so the things waiting on an answer
// float to the top.
const adminInboxStmt = db.prepare(`
  SELECT
    c.id,
    c.title,
    c.user_id,
    c.created_at,
    c.updated_at,
    c.admin_read_at,
    u.display_name,
    u.blocked,
    u.note,
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

  createUser({ lookupHash, keyHash, displayName }) {
    const id = newId();
    const ts = now();
    q.insertUser.run(id, lookupHash, keyHash, displayName || '', ts, ts);
    return plain(q.userById.get(id));
  },

  findUserByLookup(lookupHash) {
    return plain(q.userByLookup.get(lookupHash));
  },

  getUser(id) {
    return plain(q.userById.get(id));
  },

  touchUser(id) {
    q.touchUser.run(now(), id);
  },

  setDisplayName(id, name) {
    q.setDisplayName.run(name, id);
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

  /** Used when the admin key changes, so old browsers stop counting as the owner. */
  destroyAllOwnerSessions() {
    q.deleteAllOwnerSessions.run();
  },

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
    return plainAll(q.conversationsForUser.all(userId)).map((c) => ({
      ...c,
      unread: db
        .prepare(
          `SELECT COUNT(*) AS n FROM messages
           WHERE conversation_id = ? AND role = 'owner' AND created_at > ?`,
        )
        .get(c.id, c.user_read_at).n,
      preview: this.previewOf(c.id),
    }));
  },

  previewOf(conversationId) {
    const row = db
      .prepare(
        `SELECT body FROM messages WHERE conversation_id = ?
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(conversationId);
    return row ? String(row.body).slice(0, 120) : '';
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
    // Whoever just spoke has by definition seen everything up to this point.
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

  recentUserMessageCount(userId, sinceMs) {
    return q.recentUserMessageCount.get(userId, now() - sinceMs).n;
  },

  markAdminRead(id) {
    q.markAdminRead.run(now(), id);
  },

  markUserRead(id) {
    q.markUserRead.run(now(), id);
  },

  adminInbox(limit = 200) {
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
};

module.exports = store;
