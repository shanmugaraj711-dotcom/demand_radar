#!/usr/bin/env bash
# Installs Demand Radar on Amazon Linux 2023 (ARM64 or x86_64) WITHOUT touching anything already there:
#   - own user "radar", own folders (/opt/radar, /var/lib/radar, /etc/radar), own copy of Node.js (system Node is not used or changed)
#   - no firewall change, no port opened, no other service restarted, no package installed
# It listens on 127.0.0.1 only. Publish it with a Cloudflare Tunnel (see DEPLOY.md).
# Usage:  sudo bash install-al2023.sh --dry-run     (shows the plan, changes nothing)
#         sudo bash install-al2023.sh
# Overrides (env): REPO=owner/name  BRANCH=main  NODE_VERSION=v22.20.0  PORT=4173
set -euo pipefail

REPO="${REPO:-shanmugaraj711-dotcom/demand_radar}"
BRANCH="${BRANCH:-main}"
NODE_VERSION="${NODE_VERSION:-v22.20.0}"
PORT="${PORT:-4173}"
DRY=0
if [ "${1:-}" = "--dry-run" ]; then DRY=1; fi

say() { printf '%s\n' "$*"; }
run() { if [ "$DRY" = 1 ]; then say "  [dry-run] $*"; else "$@"; fi; }
die() { say "STOP: $*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "run as root (sudo)."
case "$(uname -m)" in
  aarch64|arm64) NARCH=arm64 ;;
  x86_64) NARCH=x64 ;;
  *) die "unsupported CPU $(uname -m)" ;;
esac
command -v curl >/dev/null || die "curl is missing."
command -v xz >/dev/null || die "xz is missing (needed to unpack Node.js). Install it yourself first: dnf install -y xz"
command -v systemctl >/dev/null || die "systemd not found."
grep -qi 'amazon linux' /etc/os-release || say "Note: this is not Amazon Linux. Continuing, but the script was written for AL2023."

# Never collide with something that is already listening
if ss -ltn 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]${PORT}\$"; then
  if ! systemctl is-active --quiet radar 2>/dev/null; then
    die "port ${PORT} is already in use by something else. Pick another one: PORT=4180 sudo -E bash $0"
  fi
fi

say "Plan: user radar | app /opt/radar/app | data /var/lib/radar | settings /etc/radar/radar.env"
say "      Node ${NODE_VERSION} (${NARCH}) in /opt/radar/node | source ${REPO}@${BRANCH} | listens on 127.0.0.1:${PORT} only"
say "Memory now:"
free -m | sed 's/^/  /'
if [ "$DRY" = 1 ]; then say "(dry run: nothing will be changed)"; fi

# 1. user and folders
id radar >/dev/null 2>&1 || run useradd --system --no-create-home --shell /sbin/nologin radar
run install -d -o root -g radar -m 0750 /opt/radar /etc/radar
run install -d -o radar -g radar -m 0750 /var/lib/radar

# 2. our own Node.js, checked against the official checksum
if [ ! -x /opt/radar/node/bin/node ] || ! /opt/radar/node/bin/node -v | grep -q "^${NODE_VERSION}\$"; then
  F="node-${NODE_VERSION}-linux-${NARCH}.tar.xz"
  say "Downloading Node.js ${NODE_VERSION}..."
  if [ "$DRY" = 0 ]; then
    T="$(mktemp -d)"
    curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/${F}" -o "$T/$F"
    curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt" -o "$T/SUMS"
    (cd "$T" && grep " ${F}\$" SUMS | sha256sum -c -) || die "Node.js checksum did not match."
    rm -rf /opt/radar/node.new && mkdir /opt/radar/node.new
    tar -xJf "$T/$F" -C /opt/radar/node.new --strip-components=1
    rm -rf /opt/radar/node && mv /opt/radar/node.new /opt/radar/node
    rm -rf "$T"
  else
    say "  [dry-run] download, verify and unpack ${F}"
  fi
fi

# 3. the app, straight from GitHub (no git needed)
say "Downloading ${REPO}@${BRANCH}..."
if [ "$DRY" = 0 ]; then
  T2="$(mktemp -d)"
  curl -fsSL "https://codeload.github.com/${REPO}/tar.gz/refs/heads/${BRANCH}" -o "$T2/app.tgz" || die "could not download the repo (private, or wrong branch name?)."
  rm -rf /opt/radar/app.new && mkdir /opt/radar/app.new
  tar -xzf "$T2/app.tgz" -C /opt/radar/app.new --strip-components=1
  rm -rf "$T2"
  [ -f /opt/radar/app.new/server.js ] || die "the download did not contain server.js."
  if [ -d /opt/radar/app ]; then rm -rf /opt/radar/app.prev; mv /opt/radar/app /opt/radar/app.prev; fi
  mv /opt/radar/app.new /opt/radar/app
  chown -R root:radar /opt/radar/app
  chmod -R g+rX,o-rwx /opt/radar/app
else
  say "  [dry-run] download and unpack the repo into /opt/radar/app"
fi

# 4. settings file: created once, never overwritten
if [ ! -f /etc/radar/radar.env ]; then
  if [ "$DRY" = 0 ]; then
    umask 077
    cat > /etc/radar/radar.env <<ENV
HOST=127.0.0.1
PORT=${PORT}
DATA_DIR=/var/lib/radar
# Fill these in, then run: systemctl restart radar
# Your public address (the Cloudflare Tunnel hostname), for example radar.example.com
ALLOWED_HOSTS=
# A PIN of 8+ characters. Required whenever ALLOWED_HOSTS is set.
APP_PIN=
# Optional keys (or enter them in the app's Settings page)
# GOOGLE_PLACES_API_KEY=
# ANTHROPIC_API_KEY=
ENV
    chown root:radar /etc/radar/radar.env
    chmod 0640 /etc/radar/radar.env
  else
    say "  [dry-run] create /etc/radar/radar.env"
  fi
fi

# 5. services
for u in radar.service radar-backup.service radar-backup.timer; do
  run install -m 0644 "/opt/radar/app/deploy/$u" "/etc/systemd/system/$u"
done
run systemctl daemon-reload
run systemctl enable --now radar.service
run systemctl enable --now radar-backup.timer

if [ "$DRY" = 0 ]; then
  sleep 3
  if curl -fsS -o /dev/null "http://127.0.0.1:${PORT}/login.html" || curl -fsS -o /dev/null "http://127.0.0.1:${PORT}/"; then
    say "OK: Demand Radar answers on 127.0.0.1:${PORT}"
  else
    say "The service did not answer. Look at: journalctl -u radar -n 50 --no-pager"
  fi
  say "Next: edit /etc/radar/radar.env (ALLOWED_HOSTS and APP_PIN), run: systemctl restart radar, then follow DEPLOY.md to publish it."
fi
