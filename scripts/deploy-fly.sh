#!/usr/bin/env bash
#
# Deploys ChatREECE to Fly.io.
#
#   ./scripts/deploy-fly.sh <app-name> [embed-origin]
#
# Example:
#   ./scripts/deploy-fly.sh reece-chat https://reece.io
#
# Safe to re-run: each step checks whether it has already been done, so if
# something fails halfway you can fix it and run this again without starting
# over or losing the volume.

set -euo pipefail

APP="${1:-}"
EMBED_ORIGIN="${2:-}"
REGION="${FLY_REGION:-iad}"
VOLUME_NAME="chatreece_data"

die() { printf '\nError: %s\n' "$1" >&2; exit 1; }
step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

[ -n "$APP" ] || die "Give your app a name: ./scripts/deploy-fly.sh <app-name>
App names are globally unique across Fly, so pick something specific
like 'reece-chat' rather than 'chat'."

command -v flyctl >/dev/null 2>&1 || die "flyctl is not installed.
  macOS:  brew install flyctl
  Linux:  curl -L https://fly.io/install.sh | sh
  Then:   fly auth login"

fly auth whoami >/dev/null 2>&1 || die "Not signed in to Fly. Run: fly auth login"

cd "$(dirname "$0")/.."

# ---------------------------------------------------------------------------
step "Pointing fly.toml at '$APP'"
# ---------------------------------------------------------------------------
# Rewrite only the app name line, leaving every other setting alone.
if [ -f fly.toml ]; then
  tmp=$(mktemp)
  sed "s|^app = .*|app = \"$APP\"|" fly.toml > "$tmp" && mv "$tmp" fly.toml
  echo "fly.toml now targets $APP"
else
  die "fly.toml is missing — are you running this from inside the repo?"
fi

# ---------------------------------------------------------------------------
step "Creating the app (skipped if it already exists)"
# ---------------------------------------------------------------------------
if fly status --app "$APP" >/dev/null 2>&1; then
  echo "App '$APP' already exists — leaving it alone."
else
  fly apps create "$APP" || die "Could not create '$APP'. The name is probably
taken by someone else on Fly — try a more specific one."
fi

# ---------------------------------------------------------------------------
step "Creating the 1GB data volume (skipped if it already exists)"
# ---------------------------------------------------------------------------
# This volume is the whole database. Never delete it casually: every visitor's
# key becomes unverifiable without the pepper file stored inside it.
if fly volumes list --app "$APP" 2>/dev/null | grep -q "$VOLUME_NAME"; then
  echo "Volume '$VOLUME_NAME' already exists — leaving it alone."
else
  fly volumes create "$VOLUME_NAME" --app "$APP" --region "$REGION" --size 1 --yes
fi

# ---------------------------------------------------------------------------
step "Setting your owner key"
# ---------------------------------------------------------------------------
if fly secrets list --app "$APP" 2>/dev/null | grep -q '^ADMIN_KEY'; then
  echo "ADMIN_KEY is already set — keeping it."
  echo "To change it: fly secrets set ADMIN_KEY=\"...\" --app $APP"
  OWNER_KEY=""
else
  OWNER_KEY=$(node scripts/make-key.js)
  fly secrets set ADMIN_KEY="$OWNER_KEY" --app "$APP" --stage
  echo "Generated an owner key. It is shown at the end — write it down."
fi

if [ -n "$EMBED_ORIGIN" ]; then
  fly secrets set EMBED_ORIGINS="$EMBED_ORIGIN" --app "$APP" --stage
  echo "Widget embedding allowed from: $EMBED_ORIGIN"
fi

# ---------------------------------------------------------------------------
step "Deploying"
# ---------------------------------------------------------------------------
# --ha=false keeps this to a single machine. Two machines would mean two
# processes writing one SQLite file, and a visitor connected to one machine
# would never receive a reply sent from the other.
fly deploy --app "$APP" --ha=false

# ---------------------------------------------------------------------------
step "Done"
# ---------------------------------------------------------------------------
URL="https://$APP.fly.dev"
cat <<EOF

  Your chat:  $URL
  Your desk:  $URL/admin
EOF

if [ -n "$OWNER_KEY" ]; then
  cat <<EOF

  Your owner key — save this now, it is not shown again:

      $OWNER_KEY

EOF
fi

cat <<EOF
  Add the bubble to your site with:

      <script src="$URL/embed.js" data-label="Ask Reece" defer></script>

EOF

if [ -z "$EMBED_ORIGIN" ]; then
  cat <<EOF
  Then allow your site to frame it:

      fly secrets set EMBED_ORIGINS="https://your-site.com" --app $APP

EOF
fi

echo "  Checking it responded..."
if curl -fsS --max-time 20 "$URL/api/config" >/dev/null 2>&1; then
  echo "  It's up."
else
  echo "  Not answering yet — it can take a minute. Check: fly logs --app $APP"
fi
