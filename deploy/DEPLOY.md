# Deploy Demand Radar on AWS + Cloudflare

Target: an existing shared server (EC2 `t4g.small`, ARM64, Amazon Linux 2023, 2 GB RAM + swap) reached through SSM.
Goal: run the app next to your other services **without disturbing them**, with **no inbound ports**, behind a login.

```
phone / PC ──HTTPS──> Cloudflare (Access login) ──Tunnel──> cloudflared on EC2 ──> Radar on 127.0.0.1:4173
```

Cloudflare Workers and Pages are **not needed**. The app is a normal long-running Node server with a database file.

## What the installer does, and does not do

| Does | Does not |
|---|---|
| Creates its own user `radar` | Touch other users, services, apps or databases |
| Uses its own folders: `/opt/radar` (app + its own Node.js), `/var/lib/radar` (database), `/etc/radar` (settings) | Change the system Node.js or install packages |
| Runs one systemd service `radar` and one backup timer `radar-backup.timer` | Change the firewall or open any port |
| Listens on `127.0.0.1:4173` only | Restart any existing service |
| Caps the service at ~450 MB of RAM | Overwrite `/etc/radar/radar.env` if it already exists |

## 0. Before anything: audit (read-only)

Run the audit first (listening ports, services, memory, disk, existing `cloudflared`). Nothing below changes anything until step 2.
Check specifically:
- Is port 4173 free? (`ss -ltn`) The installer refuses to continue if it is not. Use `PORT=4180` to pick another.
- How much memory is free with the current services running? (`free -m`) Radar normally needs about 100 to 200 MB.
- Is `cloudflared` already running here? (`systemctl list-units | grep -i cloudflared`) If yes, you will reuse it in step 4 and install nothing new.

## 1. Look at the script, then do a dry run

The script is short and commented. Read it once: `deploy/install-al2023.sh`.

While the work is on the `deploy-pwa` branch, use `BRANCH=deploy-pwa`. After merging, use `main`.

```bash
curl -fsSL https://raw.githubusercontent.com/shanmugaraj711-dotcom/demand_radar/deploy-pwa/deploy/install-al2023.sh -o /tmp/radar-install.sh
```

```bash
sudo BRANCH=deploy-pwa bash /tmp/radar-install.sh --dry-run
```

The dry run prints the plan and the current memory, and changes nothing.

## 2. Install

```bash
sudo BRANCH=deploy-pwa bash /tmp/radar-install.sh
```

It ends with `OK: Demand Radar answers on 127.0.0.1:4173`. If not: `journalctl -u radar -n 50 --no-pager`.
At this point the app is local-only and has no login, which is safe because nothing can reach it from outside.

## 3. Set the address and the PIN

Pick the hostname you will use, for example `radar.yourdomain.com` (the domain's DNS must be on Cloudflare).

```bash
sudo sed -i 's/^ALLOWED_HOSTS=.*/ALLOWED_HOSTS=radar.yourdomain.com/' /etc/radar/radar.env
```

Set the PIN without leaving it in the command history (use letters and digits only, 8+ characters):

```bash
read -rsp "New PIN: " P; echo; sudo sed -i "s/^APP_PIN=.*/APP_PIN=${P}/" /etc/radar/radar.env; unset P
```

```bash
sudo systemctl restart radar
```

The app refuses to start with `ALLOWED_HOSTS` set and no `APP_PIN`. That is on purpose.

## 4. Publish through Cloudflare Tunnel (no inbound port)

**If `cloudflared` already runs on this server** (dashboard-managed tunnel): do not install anything.
Zero Trust dashboard → Networks → Tunnels → your tunnel → Public Hostname → Add:
- Hostname: `radar.yourdomain.com`
- Service: `HTTP` → `localhost:4173`

**If there is no tunnel yet:** Zero Trust dashboard → Networks → Tunnels → Create a tunnel (cloudflared).
Cloudflare then shows the exact install command for Linux ARM64 with your token. Run that command on the server, then add the Public Hostname as above.
(Cloudflare's screens and names change over time; the idea stays the same.)

## 5. Put a login in front (Cloudflare Access)

Zero Trust dashboard → Access → Applications → Add → Self-hosted:
- Application domain: `radar.yourdomain.com`
- Policy: Allow, include your own email address only
- Login method: one-time PIN by email works with no extra setup

You then have two locks: Cloudflare Access (email code) and the app's own PIN. Keep both. If you ever want only Access, set `ALLOW_NO_PIN=1` in `/etc/radar/radar.env` and remove `APP_PIN`. That is weaker: if the Access rule is ever misconfigured, the app is open.

## 6. Check it works

On the server:

```bash
systemctl is-active radar radar-backup.timer
```

```bash
ss -ltnp | grep 4173
```

The second command must show `127.0.0.1:4173`, never `0.0.0.0` or `*`.

From outside: open `https://radar.yourdomain.com`. You should get the Cloudflare login first, then the app's PIN page, then the app.
On the phone: open the same address, then browser menu → Add to Home Screen.

Can this server reach the keyword sources? (Outbound only, changes nothing.) Amazon addresses are sometimes rate-limited by search sites, so check before relying on it:

```bash
sudo -u radar /opt/radar/node/bin/node /opt/radar/app/tools/probe.js
```

Every line should say `HTTP 200`. If most say `HTTP 429` or `FAILED`, run keyword scans from your own PC instead and keep leads and follow-ups on the server.

## Updates, rollback, backups

Update to the latest code (takes a backup first; rolls back by itself if the new version does not start):

```bash
sudo bash /opt/radar/app/deploy/update.sh main
```

Manual rollback to the previous version:

```bash
sudo bash -c 'cd /opt/radar && mv app app.bad && mv app.prev app && systemctl restart radar'
```

Backups: daily at about 03:15 into `/var/lib/radar/backups` (newest 14 kept). Back up now:

```bash
sudo systemctl start radar-backup.service
```

Copy a backup off the server from time to time (for example to S3). A backup on the same disk does not protect you if the disk is lost.

Restore (the app must be stopped):

```bash
sudo systemctl stop radar
```

```bash
sudo -u radar cp /var/lib/radar/backups/radar-YYYY-MM-DD-HH-MM.db /var/lib/radar/radar.db
```

```bash
sudo systemctl start radar
```

## Uninstall (removes only Radar)

```bash
sudo systemctl disable --now radar radar-backup.timer
```

```bash
sudo rm -f /etc/systemd/system/radar.service /etc/systemd/system/radar-backup.service /etc/systemd/system/radar-backup.timer && sudo systemctl daemon-reload
```

Your data stays in `/var/lib/radar` until you delete that folder yourself. Remove the Public Hostname and Access application in Cloudflare too.

## Settings reference (`/etc/radar/radar.env`)

| Variable | Meaning |
|---|---|
| `HOST` | Address to listen on. Keep `127.0.0.1` when using the tunnel. |
| `PORT` | Default `4173`. |
| `DATA_DIR` | Where the database lives (`/var/lib/radar`). |
| `ALLOWED_HOSTS` | Public hostname(s), comma-separated. Anything else is refused. |
| `APP_PIN` | Login PIN (8+ characters). Required when `ALLOWED_HOSTS` is set. |
| `ALLOW_NO_PIN` | `1` only if Cloudflare Access alone protects the app. |
| `GOOGLE_PLACES_API_KEY`, `ANTHROPIC_API_KEY` | Optional. Can also be entered in the app's Settings page. |

## Honest status

Tested here (Windows, Node 22): the login and lockout, host rules, security headers, refuse-to-start safety, the backup tool, the service worker and manifest files, and the full app (`npm test`).
**Not tested:** the install/update scripts and systemd unit on a real Amazon Linux 2023 server (only shell syntax was checked); Cloudflare Tunnel and Access (no account access from here); the app on a real phone. Run the dry run first and read its output.
