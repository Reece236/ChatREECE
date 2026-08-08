'use strict';

// End-to-end check against a real server on a scratch database.
//   npm run smoke

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 4187;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_KEY = 'test-owner-key-1234';
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chatreece-smoke-'));

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function jar() {
  const cookies = new Map();
  return {
    header() {
      return [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    },
    absorb(res) {
      for (const raw of res.headers.getSetCookie?.() || []) {
        const [pair] = raw.split(';');
        const eq = pair.indexOf('=');
        const name = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        if (value === '') cookies.delete(name);
        else cookies.set(name, value);
      }
    },
  };
}

async function call(cookieJar, method, urlPath, body) {
  const res = await fetch(BASE + urlPath, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookieJar.header() ? { Cookie: cookieJar.header() } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  cookieJar.absorb(res);
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json().catch(() => null) : await res.text();
  return { status: res.status, data };
}

function waitForServer(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start in time')), 15000);
    child.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('is running on')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on('data', (c) => process.stderr.write(c));
    child.on('exit', (code) => reject(new Error(`server exited early (${code})`)));
  });
}

/** Opens an SSE stream and resolves with the first event of the given name. */
function firstEvent(cookieJar, urlPath, eventName, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`no "${eventName}" event within ${timeoutMs}ms`));
    }, timeoutMs);

    fetch(BASE + urlPath, {
      headers: { Cookie: cookieJar.header(), Accept: 'text/event-stream' },
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`stream returned ${res.status}`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let split;
          while ((split = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);
            const lines = block.split('\n');
            const name = lines.find((l) => l.startsWith('event: '));
            const data = lines.find((l) => l.startsWith('data: '));
            if (name && name.slice(7) === eventName && data) {
              clearTimeout(timer);
              controller.abort();
              resolve(JSON.parse(data.slice(6)));
              return;
            }
          }
        }
      })
      .catch((err) => {
        if (err.name === 'AbortError') return;
        clearTimeout(timer);
        reject(err);
      });
  });
}

(async function run() {
  const child = spawn(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server', 'index.js')],
    {
      env: { ...process.env, PORT: String(PORT), DATA_DIR, ADMIN_KEY, NOTIFY_WEBHOOK_URL: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  try {
    await waitForServer(child);
    console.log('\nChatREECE smoke test\n');

    // --- signing up -------------------------------------------------------
    const alice = jar();
    const created = await call(alice, 'POST', '/api/auth/signup', {
      username: 'Alice',
      password: 'correct horse battery',
    });
    check('a visitor can sign up', created.status === 200, JSON.stringify(created.data));
    check('the username is kept as typed', created.data?.user?.username === 'Alice');

    const dupe = await call(jar(), 'POST', '/api/auth/signup', {
      username: 'alice',
      password: 'another password',
    });
    check('usernames are taken case-insensitively', dupe.status === 409);

    const shortPass = await call(jar(), 'POST', '/api/auth/signup', {
      username: 'bobby',
      password: 'short',
    });
    check('short passwords are refused', shortPass.status === 400);

    const badName = await call(jar(), 'POST', '/api/auth/signup', {
      username: 'not a username!',
      password: 'a good long password',
    });
    check('invalid usernames are refused', badName.status === 400);

    const me = await call(alice, 'GET', '/api/me');
    check('signing up signs you in', me.status === 200);

    // --- chatting ---------------------------------------------------------
    const convo = await call(alice, 'POST', '/api/conversations');
    const conversationId = convo.data.conversation.id;
    check('a conversation can be started', convo.status === 200);

    const sent = await call(alice, 'POST', `/api/conversations/${conversationId}/messages`, {
      body: 'Do you take on freelance work?',
    });
    check('a question sends', sent.status === 200 && sent.data.message.role === 'user');
    check(
      'the thread titles itself from the question',
      sent.data.title === 'Do you take on freelance work?',
      sent.data.title,
    );

    // --- owner ------------------------------------------------------------
    const reece = jar();
    const ownerLogin = await call(reece, 'POST', '/api/auth/owner', { key: ADMIN_KEY });
    check('the owner key opens the desk', ownerLogin.status === 200 && ownerLogin.data.owner);

    const wrongOwner = await call(jar(), 'POST', '/api/auth/owner', { key: 'nope-nope-111' });
    check('a wrong owner key is refused', wrongOwner.status === 401);

    const inbox = await call(reece, 'GET', '/api/owner/inbox');
    check('the question reaches the inbox', inbox.data.conversations.length === 1);
    check('it is marked unread', inbox.data.conversations[0].unread === 1);
    check('the inbox shows who asked', inbox.data.conversations[0].username === 'Alice');

    const incoming = firstEvent(alice, '/api/events', 'message');
    await new Promise((r) => setTimeout(r, 300));
    const replied = await call(reece, 'POST', `/api/owner/conversations/${conversationId}/messages`, {
      body: 'Yes — tell me about the project.',
    });
    check('the owner can reply', replied.status === 200 && replied.data.message.role === 'owner');

    const live = await incoming;
    check(
      'the reply arrives over the live stream',
      live.message.body === 'Yes — tell me about the project.',
    );

    // --- signing back in --------------------------------------------------
    const returning = jar();
    const wrongPass = await call(returning, 'POST', '/api/auth/login', {
      username: 'alice',
      password: 'not the password',
    });
    check('a wrong password is refused', wrongPass.status === 401);

    const unknown = await call(jar(), 'POST', '/api/auth/login', {
      username: 'nobody-here',
      password: 'not the password',
    });
    check(
      'an unknown username gives the same error as a wrong password',
      unknown.status === 401 && unknown.data.error === wrongPass.data.error,
    );

    const backIn = await call(returning, 'POST', '/api/auth/login', {
      username: 'ALICE',
      password: 'correct horse battery',
    });
    check('signing in is case-insensitive on the username', backIn.status === 200);

    const history = await call(returning, 'GET', `/api/conversations/${conversationId}`);
    check('the conversation is still there', history.data.messages.length === 2);

    // --- changing password ------------------------------------------------
    const changed = await call(returning, 'POST', '/api/me/password', {
      currentPassword: 'correct horse battery',
      newPassword: 'a brand new password',
    });
    check('the password can be changed', changed.status === 200);

    const oldPass = await call(jar(), 'POST', '/api/auth/login', {
      username: 'alice',
      password: 'correct horse battery',
    });
    check('the old password stops working', oldPass.status === 401);

    // --- isolation --------------------------------------------------------
    const bob = jar();
    await call(bob, 'POST', '/api/auth/signup', { username: 'bob', password: 'bobs long password' });
    const peek = await call(bob, 'GET', `/api/conversations/${conversationId}`);
    check("one person cannot read another's chat", peek.status === 404);

    const noOwner = await call(bob, 'GET', '/api/owner/inbox');
    check('a visitor cannot reach the owner inbox', noOwner.status === 401);

    const anon = await call(jar(), 'GET', '/api/conversations');
    check('signed-out visitors get a 401', anon.status === 401);

    // --- notifications ----------------------------------------------------
    const vapid = await call(jar(), 'GET', '/api/push/key');
    check(
      'a VAPID public key is published',
      vapid.status === 200 && typeof vapid.data.publicKey === 'string' && vapid.data.publicKey.length > 20,
    );

    const subscribed = await call(bob, 'POST', '/api/push/subscribe', {
      endpoint: 'https://push.example.com/abc123',
      keys: { p256dh: 'BExampleKeyMaterialHere', auth: 'authSecretHere' },
    });
    check('a visitor can subscribe to notifications', subscribed.status === 200);

    const bobMe = await call(bob, 'GET', '/api/me');
    check('the subscription is remembered', bobMe.data.pushEnabled === true);

    const junk = await call(bob, 'POST', '/api/push/subscribe', { endpoint: 'not-a-url' });
    check('a malformed subscription is refused', junk.status === 400);

    const ownerSub = await call(reece, 'POST', '/api/owner/push/subscribe', {
      endpoint: 'https://push.example.com/owner1',
      keys: { p256dh: 'BOwnerKeyMaterial', auth: 'ownerAuthSecret' },
    });
    check('the owner can subscribe to notifications', ownerSub.status === 200);

    const anonSub = await call(jar(), 'POST', '/api/push/subscribe', {
      endpoint: 'https://push.example.com/xyz',
      keys: { p256dh: 'k', auth: 'a' },
    });
    check('a signed-out visitor cannot subscribe', anonSub.status === 401);

    // --- validation -------------------------------------------------------
    const blank = await call(returning, 'POST', `/api/conversations/${conversationId}/messages`, {
      body: '   ',
    });
    check('empty messages are refused', blank.status === 400);

    // --- echo dedupe (last: it adds a message) ----------------------------
    const echo = firstEvent(returning, '/api/events', 'message');
    await new Promise((r) => setTimeout(r, 300));
    await call(returning, 'POST', `/api/conversations/${conversationId}/messages`, {
      body: 'Also, what are your rates?',
      clientId: 'abc-123',
    });
    const echoed = await echo;
    check('the stream echoes the sender clientId back', echoed.message.clientId === 'abc-123');
  } catch (err) {
    failed += 1;
    console.log(`  FAIL ${err.message}`);
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
})();
