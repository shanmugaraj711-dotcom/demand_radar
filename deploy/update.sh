#!/usr/bin/env bash
# Updates the app from GitHub and rolls back by itself if the new version does not start.
# Usage: sudo bash /opt/radar/app/deploy/update.sh [branch]
# Your data in /var/lib/radar is never touched.
set -euo pipefail
REPO="${REPO:-shanmugaraj711-dotcom/demand_radar}"
BRANCH="${1:-${BRANCH:-main}}"
[ "$(id -u)" = 0 ] || { echo "run as root (sudo)." >&2; exit 1; }
PORT="$(grep -E '^PORT=' /etc/radar/radar.env | cut -d= -f2 || true)"
PORT="${PORT:-4173}"

T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
curl -fsSL "https://codeload.github.com/${REPO}/tar.gz/refs/heads/${BRANCH}" -o "$T/app.tgz"
rm -rf /opt/radar/app.new && mkdir /opt/radar/app.new
tar -xzf "$T/app.tgz" -C /opt/radar/app.new --strip-components=1
[ -f /opt/radar/app.new/server.js ] || { echo "the download did not contain server.js" >&2; exit 1; }
chown -R root:radar /opt/radar/app.new
chmod -R g+rX,o-rwx /opt/radar/app.new

systemctl start radar-backup.service || true   # fresh backup before changing anything
rm -rf /opt/radar/app.prev
mv /opt/radar/app /opt/radar/app.prev
mv /opt/radar/app.new /opt/radar/app
for u in radar.service radar-backup.service radar-backup.timer; do
  install -m 0644 "/opt/radar/app/deploy/$u" "/etc/systemd/system/$u"
done
systemctl daemon-reload
systemctl restart radar
sleep 3

if curl -fsS -o /dev/null "http://127.0.0.1:${PORT}/login.html" || curl -fsS -o /dev/null "http://127.0.0.1:${PORT}/"; then
  echo "Updated to ${REPO}@${BRANCH}. The previous version is kept in /opt/radar/app.prev."
else
  echo "The new version did not start. Rolling back." >&2
  rm -rf /opt/radar/app.failed
  mv /opt/radar/app /opt/radar/app.failed
  mv /opt/radar/app.prev /opt/radar/app
  systemctl restart radar
  exit 1
fi
