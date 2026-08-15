#!/usr/bin/env bash
#
# One-time setup for live-reload development.
#
# Checks the toolchain, installs what is missing, removes a previously packaged
# copy of the plugin (which would otherwise shadow this one), and links this
# folder into Stream Deck so `npm run watch` reloads in place.
#
# Safe to re-run.

set -euo pipefail

UUID="com.devbloom.ai-usage"
BUNDLE="${UUID}.sdPlugin"
PLUGIN_DIR="$HOME/Library/Application Support/com.elgato.StreamDeck/Plugins"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

bold()  { printf '\033[1m%s\033[0m\n' "$1"; }
info()  { printf '  %s\n' "$1"; }
ok()    { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn()  { printf '  \033[33m!\033[0m %s\n' "$1"; }
die()   { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

cd "$PROJECT_DIR"

bold "1. Checking Node"
command -v node >/dev/null 2>&1 || die "Node is not installed. Install Node 24+ from https://nodejs.org or via 'brew install node'."

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
info "found node v$(node -p 'process.versions.node')"
if [ "$NODE_MAJOR" -lt 24 ]; then
  warn "The Elgato CLI needs Node 24 or newer."
  if command -v nvm >/dev/null 2>&1 || [ -s "$HOME/.nvm/nvm.sh" ]; then
    info "nvm is available — run 'nvm install 24 && nvm use 24', then re-run this script."
  else
    info "Install a newer Node ('brew install node'), then re-run this script."
  fi
  die "Node 24+ required."
fi
ok "Node version is fine"

bold "2. Installing dependencies"
npm install
ok "dependencies installed"

bold "3. Checking the Elgato CLI"
if command -v streamdeck >/dev/null 2>&1; then
  ok "streamdeck CLI already installed"
else
  info "installing @elgato/cli globally"
  npm install -g @elgato/cli
  ok "streamdeck CLI installed"
fi

bold "4. Building once"
npm run build
ok "bundle written to ${BUNDLE}/bin/plugin.js"

bold "5. Clearing any previously installed copy"
INSTALLED="$PLUGIN_DIR/$BUNDLE"
if [ -L "$INSTALLED" ]; then
  # Already a symlink. If it points somewhere else, that is a stale link from
  # another checkout and re-linking below will fix it.
  TARGET="$(readlink "$INSTALLED")"
  if [ "$TARGET" = "$PROJECT_DIR/$BUNDLE" ]; then
    ok "already linked to this project"
  else
    warn "linked to a different checkout ($TARGET) — replacing"
    rm "$INSTALLED"
  fi
elif [ -d "$INSTALLED" ]; then
  # A real directory means the packaged .streamDeckPlugin was installed. It has
  # the same UUID as this project, so Stream Deck would load it instead of ours
  # and edits would appear to do nothing.
  warn "found an installed (packaged) copy — moving it aside"
  mv "$INSTALLED" "$INSTALLED.replaced-$(date +%s)"
  ok "moved aside; delete it once you are happy this build works"
else
  ok "nothing installed yet"
fi

bold "6. Linking this folder into Stream Deck"
streamdeck link "$BUNDLE"
ok "linked"

echo
bold "Ready."
cat <<EOF

  Start the loop:      npm run watch
  Watch plugin logs:   tail -f ${BUNDLE}/logs/*.log
  Preview key faces:   npm run preview
  Screenshot settings: node scripts/shoot-pi.mjs /tmp/pi.png

  Drag "Claude Usage" onto a key if it is not already there. Saving a file in
  src/ now rebuilds and reloads it in place — no re-installing.

  See DEVELOPMENT.md for the rest.
EOF
