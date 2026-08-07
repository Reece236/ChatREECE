# ChatREECE

A chat widget for your website that looks and feels like an AI chatbot — except
the answers are yours. Visitors ask questions in a familiar ChatGPT-style
window; the questions land in an inbox you open whenever you feel like it; your
replies show up on their side exactly where a bot's reply would.

No accounts, no email, no passwords to invent. A visitor taps one button and
gets a key like **`meadow-drifting-472`**. That key is the whole login — no
username, nothing to remember beyond two everyday words and a number. They can
close the tab, come back next week, type the key, and their conversation is
right where they left it.

## What's in the box

| Page | Who it's for | What it does |
|---|---|---|
| `/` | Visitors | Get a key, or come back with one |
| `/chat` | Visitors | The chat window |
| `/admin` | You | Your answering desk — every conversation, unread first |
| `/embed.js` | Your site | One script tag that adds a chat bubble to any page |

Answers stream to the visitor live if they still have the tab open, and are
waiting for them if they don't. Both sides get typing dots, and visitors can see
whether you're at the desk right now or away.

## Run it

Needs Node 22.5 or newer (it uses Node's built-in SQLite — nothing to compile).

```bash
npm install
cp .env.example .env      # optional, but set ADMIN_KEY before going live
npm start
```

Then open http://localhost:3000. Your owner key is printed on first boot and
saved to `data/admin-key.txt` unless you set `ADMIN_KEY` yourself.

```bash
npm run smoke   # end-to-end check: keys, chat, isolation, live delivery
```

## How the keys work

Keys are `noun-verb-number`, drawn from ~500 nouns and ~300 actions, so they
read like something you'd say out loud: `crayon-rehearsing-739`,
`harbor-drifting-812`.

Typing them is deliberately forgiving. Spacing, hyphens and capitals are all
stripped before the key is checked, so every one of these opens the same chat:

```
dog-jumping-472      Dog Jumping 472      dogjumping472      DOG JUMPING 472
```

**On the number of digits.** You described keys like "dog jumping 47" — two
digits. The default here is three, because there's no username attached: every
guess an attacker makes is a guess against *every* visitor's chat at once, and
the third digit multiplies the work by ten for no extra effort from the person
typing it. Set `KEY_DIGITS=2` in `.env` if you'd rather have the shorter form;
existing keys keep working either way.

The rest of the protection:

- Keys are stored hashed (scrypt), never in plain text. If someone steals the
  database file they still can't read the keys.
- Login is rate limited to 12 tries per 15 minutes per IP, and key creation to
  8 per hour per IP.
- A key is looked up through an HMAC index keyed by a server-side secret
  (`data/pepper.key`), so login stays fast no matter how many visitors you have.

Because a key is the whole credential, **there is no recovery**. If a visitor
loses their key, their old conversation is gone to them and they start fresh.
The UI says so plainly on the screen where the key is handed out.

## Your answering desk

Go to `/admin` and enter your owner key. You'll see:

- Every conversation, newest first, with a badge on anything unanswered
- An **All / Waiting** toggle to hide what you've already handled
- The full thread, with your replies appearing on the visitor's side as the
  chatbot's answers
- A private note field per visitor that only you can see
- Block (kills that key) and delete (removes the conversation for both of you)

You can leave it closed for a week. Questions pile up; nothing expires.

### Getting told about new questions

Set `NOTIFY_WEBHOOK_URL` to a Slack or Discord incoming webhook — or any URL
that takes a JSON POST — and you'll get a ping whenever someone asks something.
The payload includes `text` and `content` fields so it works with both Slack and
Discord as-is.

## Putting it on your site

**One script tag** adds a chat bubble in the corner of any page:

```html
<script src="https://your-chat-host.example.com/embed.js" defer></script>
```

Options, all optional:

```html
<script src="https://your-chat-host.example.com/embed.js"
        data-label="Ask Reece"
        data-position="left"
        data-accent="#6f8cff"
        defer></script>
```

The widget renders inside a shadow root, so your site's CSS can't leak into it
and its CSS can't leak out. The iframe isn't loaded until someone actually opens
the bubble, so the widget costs your page nothing until it's wanted. You can
also drive it yourself: `ChatREECE.open()`, `.close()`, `.toggle()`.

**Important:** add your site's origin to `EMBED_ORIGINS` or the browser will
refuse to frame the chat:

```
EMBED_ORIGINS=https://reece.io,https://www.reece.io
```

If you'd rather not use the bubble, link straight to the chat
(`https://your-chat-host.example.com/`) or drop it in an iframe yourself.

## Deploying

**See [DEPLOY.md](DEPLOY.md) for step-by-step instructions.** There's a
`render.yaml`, a `fly.toml` and a `docker-compose.yml` in here, so the host does
most of the configuring itself.

Any host that runs a Node process works — Render, Railway, Fly.io, a VPS.

Two things matter:

1. **Attach a persistent disk** and point `DATA_DIR` at it. The SQLite file, the
   pepper and the generated admin key all live there; on a host with an
   ephemeral filesystem, every deploy would wipe every conversation and
   invalidate every visitor's key.
2. **Set `TRUST_PROXY=1`** when there's a reverse proxy or CDN in front. Without
   it, login cookies won't get the `Secure` flag and rate limiting will see the
   proxy's IP instead of the visitor's.

There's a `Dockerfile` if your host prefers containers.

Note that this is a stateful, single-process app — SQLite plus in-memory event
streams. Run one instance of it, not several behind a load balancer.

## Configuration

Everything is optional except `ADMIN_KEY`, which you should set yourself.

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `ADMIN_KEY` | generated | Your owner key. Generated and saved to `data/admin-key.txt` if unset |
| `DATA_DIR` | `./data` | Where the database, pepper and admin key live |
| `TRUST_PROXY` | `0` | Set to `1` behind a reverse proxy |
| `KEY_DIGITS` | `3` | Digits on the end of a visitor key (2–4) |
| `SITE_NAME` | `ChatREECE` | Shown in the browser tab and on the login screen |
| `OWNER_NAME` | `Reece` | The name on your replies |
| `EMBED_ORIGINS` | — | Comma-separated origins allowed to embed the widget |
| `NOTIFY_WEBHOOK_URL` | — | Pinged when a new question arrives |
| `KEY_PEPPER` | generated | Overrides the generated `data/pepper.key` |

Changing `ADMIN_KEY` signs out every owner session on the next boot. Changing
`KEY_PEPPER` after visitors exist will lock all of them out — don't.

## What gets stored

Conversations, messages, a hash of each key, and whatever display name a visitor
chooses to give. No email, no IP logging, no third-party scripts, no analytics.
Nothing leaves your server except the optional webhook ping.

## Layout

```
server/
  index.js    routes, auth middleware, rate limits
  db.js       SQLite schema and queries
  auth.js     key generation, hashing, sessions, rate limiter
  words.js    the two word lists keys are built from
  events.js   server-sent-events hub for live delivery
public/
  index.html  landing + login          js/login.js
  chat.html   visitor chat             js/chat.js
  admin.html  answering desk           js/admin.js
  embed.js    the drop-in bubble       css/style.css
test/
  smoke.js    end-to-end check against a real server
```

No build step, no framework, one dependency (Express).
