# Getting ChatREECE live

## Read this first

ChatREECE keeps everything in a SQLite file on disk: conversations, messages,
the hash of every visitor's key, and the secret (`pepper.key`) those hashes are
built on. **That directory must survive restarts and redeploys.**

If it doesn't, every visitor's key silently stops working and their
conversations are gone — and because keys have no email attached, there is no
way to give anyone their chat back. This is the one mistake worth being careful
about, and it's why the free tier of most hosts is not suitable: free tiers
generally give you an ephemeral filesystem that is wiped on every deploy.

Two settings to get right on any host:

| Setting | Value | Why |
|---|---|---|
| `DATA_DIR` | the mounted disk path | So the database lives on the persistent disk, not the container |
| `TRUST_PROXY` | `1` | Anything with TLS in front of it. Otherwise login cookies lose the `Secure` flag and rate limiting sees the proxy's IP, not the visitor's |

And set `ADMIN_KEY` yourself, so your owner key is something you chose rather
than something generated into a file.

---

## Option A — Render (least fiddly)

There's a `render.yaml` in this repo, so Render configures itself.

1. Push this branch to GitHub (already done).
2. Render dashboard → **New** → **Blueprint** → pick this repo.
3. Render reads `render.yaml` and proposes a web service with a 1 GB disk
   mounted at `/var/data`. It will prompt for the values marked `sync: false`:
   - **`ADMIN_KEY`** — your owner key. Make it longer than a visitor's, e.g.
     `harbor-drifting-quietly-8412`.
   - **`EMBED_ORIGINS`** — the site you'll embed from, e.g. `https://reece.io`.
     Leave blank for now if you're not embedding yet.
   - **`NOTIFY_WEBHOOK_URL`** — optional Slack/Discord webhook.
4. Apply. First deploy takes a couple of minutes.

The blueprint asks for the **Starter** instance type, not Free, because Render
only attaches persistent disks to paid instances. On Free, every deploy would
wipe the database.

Your site is then at `https://chatreece.onrender.com` (or your own domain via
Settings → Custom Domain), and your desk is at `/admin`.

## Option B — Fly.io (cheapest always-on)

```bash
fly launch --copy-config --no-deploy      # edit the app name in fly.toml first
fly volumes create chatreece_data --size 1
fly secrets set ADMIN_KEY="your-owner-key-here"
fly secrets set EMBED_ORIGINS="https://reece.io"
fly deploy
```

`fly.toml` deliberately sets `auto_stop_machines = false`. Live message delivery
holds a long-lived connection open per visitor, and suspending the machine
underneath that drops it.

## Option C — Your own VPS or machine

```bash
cp .env.example .env         # set ADMIN_KEY, and TRUST_PROXY=1 if proxied
docker compose up -d
```

Then put Caddy, nginx or a Cloudflare Tunnel in front for HTTPS. Without
Docker, plain `npm ci && npm start` behind a process manager works the same.

---

## After it's live

1. **Open `/admin`** and sign in with your `ADMIN_KEY`. If you left it unset,
   the key was generated into `DATA_DIR/admin-key.txt` and printed in the deploy
   logs — grab it and then set `ADMIN_KEY` properly.

2. **Test it as a visitor.** Open the site in a private window, get a key, ask
   something. It should appear in your desk within a second. Reply, and watch it
   land in the visitor window without a refresh.

3. **Add it to your site** once you know the URL:

   ```html
   <script src="https://YOUR-CHAT-URL/embed.js" data-label="Ask Reece" defer></script>
   ```

   Then add your site's origin to `EMBED_ORIGINS` and redeploy, or the browser
   will refuse to frame the chat. `https://reece.io` and `https://www.reece.io`
   count as different origins — list both if you use both.

4. **Get notified.** Without a webhook you have to remember to check `/admin`.
   With `NOTIFY_WEBHOOK_URL` set to a Slack or Discord incoming webhook, new
   questions come to you.

## Scaling note

This is a single-process, stateful app — SQLite plus in-memory connection
tracking for live delivery. Run **one** instance. Don't scale it to 2+ behind a
load balancer: you'd get two processes writing one database file, and visitors
connected to instance A would not receive replies you sent from instance B.

One small instance handles a personal Q&A site comfortably. If you ever
genuinely outgrow it, the swap is Postgres plus Redis for the event fan-out, not
more copies of this.

## Backups

The whole system is one directory. To back it up:

```bash
# Render / Fly: run inside the instance shell
sqlite3 $DATA_DIR/chatreece.db ".backup '/tmp/backup.db'"
```

Copy `chatreece.db` **and** `pepper.key` together. The database is useless
without the pepper — visitor keys can't be verified without it.
