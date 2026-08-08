'use strict';

// Verifies that a notification actually goes out — not just that a
// subscription is stored.
//
// Stands up a throwaway HTTPS server pretending to be a browser push service,
// subscribes to it, then has the owner answer a question while the visitor has
// no live stream open. A real POST, signed with VAPID and carrying an
// encrypted payload, should land on the fake service.
//
//   npm run test:push

const { spawn, execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_PORT = 4188;
const PUSH_PORT = 4189;
const BASE = `http://127.0.0.1:${APP_PORT}`;
const ADMIN_KEY = 'test-owner-key-1234';
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chatreece-push-'));

let passed = 0;
let failed = 0;
const check = (label, ok, detail) => {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

function selfSignedCert() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatreece-cert-'));
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', cert, '-days', '1',
    '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1',
  ], { stdio: 'ignore' });
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert), dir };
}

function jar() {
  const cookies = new Map();
  return {
    header: () => [...cookies].map(([k, v]) => `${k}=${v}`).join('; '),
    absorb(res) {
      for (const raw of res.headers.getSetCookie?.() || []) {
        const [pair] = raw.split(';');
        const eq = pair.indexOf('=');
        cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
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
  return { status: res.status, data: type.includes('json') ? await res.json() : await res.text() };
}

(async function run() {
  const { key, cert, dir: certDir } = selfSignedCert();

  const hits = [];
  let respondWith = 201;
  const pushService = https.createServer({ key, cert }, (req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      hits.push({
        url: req.url,
        headers: req.headers,
        bodyLength: Buffer.concat(chunks).length,
      });
      res.writeHead(respondWith);
      res.end();
    });
  });
  await new Promise((r) => pushService.listen(PUSH_PORT, '127.0.0.1', r));

  const child = spawn(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server', 'index.js')],
    {
      env: {
        ...process.env,
        PORT: String(APP_PORT),
        DATA_DIR,
        ADMIN_KEY,
        NOTIFY_WEBHOOK_URL: '',
        // The fake push service uses a self-signed certificate.
        NODE_TLS_REJECT_UNAUTHORIZED: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server did not start')), 15000);
      child.stdout.on('data', (c) => {
        if (c.toString().includes('is running on')) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on('exit', (code) => reject(new Error(`server exited early (${code})`)));
    });

    console.log('\nChatREECE push delivery test\n');

    const user = jar();
    await call(user, 'POST', '/api/auth/signup', {
      username: 'pushy',
      password: 'a good long password',
    });
    const convo = await call(user, 'POST', '/api/conversations');
    const conversationId = convo.data.conversation.id;
    await call(user, 'POST', `/api/conversations/${conversationId}/messages`, {
      body: 'Will I get told when you answer?',
    });

    const endpoint = `https://127.0.0.1:${PUSH_PORT}/push/visitor-1`;
    // p256dh has to be a real point on the P-256 curve — the payload is
    // encrypted to it, so invented bytes make the encryption step throw rather
    // than send anything.
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.generateKeys();
    await call(user, 'POST', '/api/push/subscribe', {
      endpoint,
      keys: {
        p256dh: ecdh.getPublicKey().toString('base64url'),
        auth: crypto.randomBytes(16).toString('base64url'),
      },
    });

    const reece = jar();
    await call(reece, 'POST', '/api/auth/owner', { key: ADMIN_KEY });
    await call(reece, 'POST', `/api/owner/conversations/${conversationId}/messages`, {
      body: 'Yes — this is that notification.',
    });

    await new Promise((r) => setTimeout(r, 1200));

    check('a push request reached the push service', hits.length === 1, `${hits.length} hits`);

    const hit = hits[0];
    if (hit) {
      check('it went to the subscribed endpoint', hit.url === '/push/visitor-1', hit.url);
      check(
        'it is signed with a VAPID token',
        String(hit.headers.authorization || '').startsWith('vapid t='),
        hit.headers.authorization,
      );
      check(
        'the payload is encrypted, not plain text',
        hit.headers['content-encoding'] === 'aes128gcm' && hit.bodyLength > 0,
        `${hit.headers['content-encoding']} / ${hit.bodyLength} bytes`,
      );
      check('it carries a TTL', hit.headers.ttl !== undefined, JSON.stringify(hit.headers.ttl));
    }

    // A visitor watching the page live should not also get a phone buzz.
    hits.length = 0;
    const watching = new AbortController();
    fetch(`${BASE}/api/events`, {
      headers: { Cookie: user.header(), Accept: 'text/event-stream' },
      signal: watching.signal,
    }).catch(() => {});
    await new Promise((r) => setTimeout(r, 600));
    await call(reece, 'POST', `/api/owner/conversations/${conversationId}/messages`, {
      body: 'And this one should be silent.',
    });
    await new Promise((r) => setTimeout(r, 1000));
    check('no push is sent while the visitor is watching live', hits.length === 0, `${hits.length} hits`);

    // That stream has to be closed and seen to be closed, or the rest of this
    // test would pass for the wrong reason: a live stream suppresses pushes,
    // so a still-open connection would look exactly like a dropped
    // subscription.
    watching.abort();
    await new Promise((r) => setTimeout(r, 800));
    hits.length = 0;
    await call(reece, 'POST', `/api/owner/conversations/${conversationId}/messages`, {
      body: 'Stream is closed now, so this one should be delivered.',
    });
    await new Promise((r) => setTimeout(r, 1200));
    check('pushes resume once the visitor stops watching', hits.length === 1, `${hits.length} hits`);

    // A subscription the browser has thrown away must not be retried forever.
    respondWith = 410;
    hits.length = 0;
    await call(reece, 'POST', `/api/owner/conversations/${conversationId}/messages`, {
      body: 'Gone subscription test.',
    });
    await new Promise((r) => setTimeout(r, 1200));
    check('the gone subscription was attempted once', hits.length === 1, `${hits.length} hits`);

    respondWith = 201;
    hits.length = 0;
    await call(reece, 'POST', `/api/owner/conversations/${conversationId}/messages`, {
      body: 'Should not be delivered — subscription was dropped.',
    });
    await new Promise((r) => setTimeout(r, 1200));
    check('a 410 Gone subscription is dropped, not retried', hits.length === 0, `${hits.length} hits`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL ${err.message}`);
  } finally {
    child.kill('SIGTERM');
    pushService.close();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.rmSync(certDir, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
})();
