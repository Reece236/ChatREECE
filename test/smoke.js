'use strict';

// End-to-end check against a real server on a scratch database.
//   npm run smoke
//
// Covers the paths that matter: key generation, coming back with a key,
// typo-tolerant keys, wrong keys, owner access, cross-visitor isolation,
// and a reply arriving over the live event stream.

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

/** Minimal cookie jar so each identity keeps its own session. */
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
    const onData = (chunk) => {
      if (chunk.toString().includes('is running on')) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on('data', onData);
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
            const nameLine = block.split('\n').find((l) => l.startsWith('event: '));
            const dataLine = block.split('\n').find((l) => l.startsWith('data: '));
            if (nameLine && nameLine.slice(7) === eventName && dataLine) {
              clearTimeout(timer);
              controller.abort();
              resolve(JSON.parse(dataLine.slice(6)));
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

    // --- keys ------------------------------------------------------------
    const alice = jar();
    const created = await call(alice, 'POST', '/api/auth/new', {});
    check('a visitor can mint a key', created.status === 200 && Boolean(created.data.key));
    const key = created.data.key;
    check(
      `key looks like "word-word-number" (${key})`,
      /^[a-z]+-[a-z]+-\d{2,4}$/.test(key),
      key,
    );

    const me = await call(alice, 'GET', '/api/me');
    check('the new key is signed in already', me.status === 200);

    // --- chatting --------------------------------------------------------
    const convo = await call(alice, 'POST', '/api/conversations');
    check('a conversation can be started', convo.status === 200);
    const conversationId = convo.data.conversation.id;

    const sent = await call(alice, 'POST', `/api/conversations/${conversationId}/messages`, {
      body: 'Do you take on freelance work?',
    });
    check('a question sends', sent.status === 200 && sent.data.message.role === 'user');
    check(
      'the thread titles itself from the question',
      sent.data.title === 'Do you take on freelance work?',
      sent.data.title,
    );

    // --- owner -----------------------------------------------------------
    const reece = jar();
    const ownerLogin = await call(reece, 'POST', '/api/auth/login', { key: ADMIN_KEY });
    check('the owner key opens the desk', ownerLogin.status === 200 && ownerLogin.data.owner === true);

    const inbox = await call(reece, 'GET', '/api/owner/inbox');
    check('the question shows up in the inbox', inbox.data.conversations.length === 1);
    check('it is marked unread', inbox.data.conversations[0].unread === 1);

    // The visitor is listening; the owner answers; the answer must arrive live.
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
      JSON.stringify(live),
    );

    // --- coming back later ------------------------------------------------
    const returning = jar();
    const messy = await call(returning, 'POST', '/api/auth/login', {
      key: key.replace(/-/g, ' ').toUpperCase(),
    });
    check('the key works with different spacing and case', messy.status === 200);

    const history = await call(returning, 'GET', `/api/conversations/${conversationId}`);
    check('the old conversation is still there', history.data.messages.length === 2);

    const wrong = await call(jar(), 'POST', '/api/auth/login', { key: 'wrong-guess-999' });
    check('a bad key is rejected', wrong.status === 401);

    // --- isolation --------------------------------------------------------
    const bob = jar();
    await call(bob, 'POST', '/api/auth/new', {});
    const peek = await call(bob, 'GET', `/api/conversations/${conversationId}`);
    check("one visitor cannot read another's chat", peek.status === 404);

    const noOwner = await call(bob, 'GET', '/api/owner/inbox');
    check('a visitor cannot reach the owner inbox', noOwner.status === 401);

    // --- validation -------------------------------------------------------
    const blank = await call(alice, 'POST', `/api/conversations/${conversationId}/messages`, {
      body: '   ',
    });
    check('empty messages are refused', blank.status === 400);

    const loggedOut = jar();
    const anon = await call(loggedOut, 'GET', '/api/conversations');
    check('signed-out visitors get a 401', anon.status === 401);

    // --- echo dedupe (last: it adds a message) ----------------------------
    // A sender's own message comes back over its own stream, which is what
    // keeps a visitor's other tabs in sync. Without the echoed clientId the
    // sending tab would draw that message a second time.
    const echo = firstEvent(alice, '/api/events', 'message');
    await new Promise((r) => setTimeout(r, 300));
    await call(alice, 'POST', `/api/conversations/${conversationId}/messages`, {
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
