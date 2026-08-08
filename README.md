# ChatREECE

A chat for your website that works like an AI chatbot, except the answers are
yours. People ask questions in a plain chat window; the questions land in an
inbox you open whenever you feel like it; your replies appear on their side
exactly where a bot's reply would.

People sign up with a username and password. Nothing else — no email, no
verification, no profile. Both sides can turn on notifications, so nobody has
to sit refreshing a page waiting for an answer.

## What's in the box

| Page | Who it's for | What it does |
|---|---|---|
| `/` | Visitors | Create an account or sign in |
| `/chat` | Visitors | The chat |
| `/admin` | You | Your answering desk — every conversation, unanswered first |
| `/embed.js` | Your site | One script tag that adds a chat bubble to any page |

## Run it

Needs Node 22.5 or newer (it uses Node's built-in SQLite, so there is nothing
to compile).

```bash
npm install
cp .env.example .env      # optional, but set ADMIN_KEY before going live
npm start
```

Then open http://localhost:3000. Your owner key is printed on first boot and
saved to `data/admin-key.txt` unless you set `ADMIN_KEY` yourself.

```bash
npm test            # both suites
npm run smoke       # accounts, chat, isolation, live delivery
npm run test:push   # real push delivery against a fake push service
```

## The look

Deliberately plain. System fonts, flat colours, square-ish corners, no
shadows, no gradients, no loading spinners, no animation beyond a drawer
sliding. It follows your phone's light or dark setting on its own.

It is also small: **the sign-in page is about 17 KB over 7 requests**, which
includes the icon and the web app manifest. There is no framework and no build
step — the files you edit are the files the browser gets. Nothing is
server-rendered per request, so pages paint immediately and the chat fills in.

Mobile is the default layout rather than an afterthought:

- Every tap target is at least 44px, and inputs are 16px so iOS does not zoom
  the page when you focus them.
- The composer sits above the home indicator using the safe-area insets, and
  the layout uses `100dvh` so the mobile browser's shrinking toolbar does not
  push it off screen.
- Enter inserts a newline on a touch keyboard (where people expect it) and
  sends on a physical keyboard.
- The chat list is a drawer with its own close button, because the strip of
  backdrop beside an open drawer is a poor tap target.

## Accounts

Usernames are 3–20 characters, letters and numbers plus `.`, `-` and `_`, and
are matched case-insensitively — signing up as `Reece` and signing in as
`reece` is the same account. Passwords are a minimum of 8 characters and are
stored as scrypt hashes.

Signing in with an unknown username takes the same time and returns the same
message as a wrong password, so the form cannot be used to discover who has an
account. Logins are rate limited to 10 tries per 15 minutes per IP.

Account creation is limited to 10 per hour per IP, and only counts accounts
actually created — a few fat-fingered passwords will not lock someone out.

There is no password reset, because there is no email address to send one to.
If you need to help someone back in, you can see them in the desk but the
honest answer today is that they make a new account.

## Notifications

Both sides can turn them on, from a bar at the top of the chat. It only asks
after a tap, never on page load.

- **Visitors** get told when you answer.
- **You** get told when a question comes in.

A notification is only sent when the recipient does not already have the page
open and live — if their tab is streaming, the message is already appearing on
their screen and a second buzz would be noise.

Two things worth knowing:

- **Notifications need HTTPS.** They will not work over plain `http://`, apart
  from `localhost` while developing.
- **On iPhone, the site has to be added to the Home Screen first** (Share →
  Add to Home Screen), then opened from there. That is an Apple restriction on
  web push, not something this app can work around. The app detects iOS and
  says this instead of showing a button that cannot work.

Signing keys are generated on first boot and stored in the database, so they
survive restarts. If you set `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` yourself,
changing them later invalidates every existing subscription.

You can also set `NOTIFY_WEBHOOK_URL` to a Slack or Discord incoming webhook
for a copy of every new question.

## Your answering desk

Go to `/admin` and enter your owner key. You get every conversation newest
first, unread badges, an All/Waiting filter, a private per-person note only you
can see, and block and delete. You can leave it closed for a week; questions
pile up and nothing expires.

## Putting it on your site

```html
<script src="https://your-chat-host.example.com/embed.js" defer></script>
```

Options: `data-label`, `data-position="left"`, `data-accent="#1a4fd0"`,
`data-open="1"`. The widget renders inside a shadow root so your site's CSS
cannot leak into it or vice versa, and the iframe is not loaded until someone
opens the bubble. You can drive it yourself with `ChatREECE.open()`,
`.close()`, `.toggle()`.

Add your site's origin to `EMBED_ORIGINS` or the browser will refuse to frame
the chat. `https://reece.io` and `https://www.reece.io` are different origins —
list both if you use both.

## Deploying

**See [DEPLOY.md](DEPLOY.md).** There's a `fly.toml`, a `render.yaml` and a
`docker-compose.yml`, plus `./scripts/deploy-fly.sh` for a one-command deploy.

Two things matter wherever it runs:

1. **Attach a persistent disk** and point `DATA_DIR` at it. Accounts,
   conversations and the notification signing keys all live there.
2. **Set `TRUST_PROXY=1`** when something terminates TLS in front of it.

This is a single-process, stateful app — SQLite plus in-memory tracking of who
is connected. Run one instance, not several behind a load balancer.

## Configuration

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `ADMIN_KEY` | generated | Your owner key for `/admin` |
| `DATA_DIR` | `./data` | Where the database and pepper live |
| `TRUST_PROXY` | `0` | Set to `1` behind a reverse proxy |
| `SITE_NAME` | `ChatREECE` | Shown on the sign-in screen |
| `OWNER_NAME` | `Reece` | The name on your replies |
| `EMBED_ORIGINS` | — | Origins allowed to embed the widget |
| `PUSH_CONTACT` | — | Contact address sent with push requests |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | generated | Pin your own signing keys |
| `NOTIFY_WEBHOOK_URL` | — | Pinged when a new question arrives |

## What gets stored

Usernames, scrypt password hashes, conversations, messages, notification
subscriptions, and any private note you write. No email, no IP logging, no
analytics, no third-party scripts. Nothing leaves your server except
notifications and the optional webhook.

## Layout

```
server/
  index.js    routes, auth middleware, rate limits
  db.js       SQLite schema and queries
  auth.js     usernames, password hashing, sessions, rate limiter
  push.js     web push delivery and subscription pruning
  events.js   server-sent-events hub for live delivery
  words.js    word lists, used only to generate an owner key
public/
  index.html  sign in / create account    js/login.js
  chat.html   the chat                    js/chat.js
  admin.html  answering desk              js/admin.js
  sw.js       service worker (notifications only)
  embed.js    the drop-in bubble          css/style.css
test/
  smoke.js    accounts, chat, isolation, live delivery
  push.js     real push delivery against a fake push service
```

One runtime dependency for the server (Express) and one for notifications
(web-push). Nothing on the client.
