
## Update: login, PWA, phone layout and server deploy (branch `deploy-pwa`)
This adds to the main HANDOFF.md: it supersedes its section 7 (security) and steps 1 to 5 of its section 10. Everything below is implemented and tested locally unless marked otherwise.

**Login and hosts** (`lib/auth.js`, wired in `server.js`)
- `APP_PIN` turns login on. Session = signed cookie (`radar_session`, HttpOnly, SameSite=Strict, `Secure` when the request came in over https, 30 days). The signing secret is generated once and stored in the settings table (or `APP_SECRET`).
- 5 wrong PINs from one client (`CF-Connecting-IP`, then `X-Forwarded-For`, then socket address) lock that client out for 15 minutes.
- `ALLOWED_HOSTS` (comma-separated hostnames) extends the Host and Origin allow-list beyond localhost. `HOST` and `PORT` set the listen address. `DATA_DIR` sets where `radar.db` lives.
- The server **refuses to start** if `HOST` is not loopback, or `ALLOWED_HOSTS` is set, and there is no `APP_PIN`, unless `ALLOW_NO_PIN=1` (for when Cloudflare Access alone protects it).
- Without a session only these are public: `/login.html`, `/login.js`, `/app.css`, `/manifest.webmanifest`, `/sw.js`, the icons. Everything else redirects to the login page (API calls get 401 JSON).
- Static files carry a strict CSP (no inline scripts), `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`.

**PWA and phone**
- `public/manifest.webmanifest`, icons made by `tools/make-icons.js` (no dependencies), `public/sw.js` (caches the app shell only, never `/api`, network first).
- Phone layout (max-width 700 px): bottom tab bar, bigger tap targets, 16 px inputs (stops iOS zoom), Follow-ups is the start screen when leads exist.
- "Did you send it?": opening WhatsApp remembers the card; when the page becomes visible again a banner asks and one tap logs `sent`.
- "Save contact" downloads a vCard so the number shows a name.
- Log out button appears when a PIN is set.

**Deploy** (`deploy/`, read `deploy/DEPLOY.md`)
- Target: AWS EC2 (owner has a `t4g.small`, ARM64, Amazon Linux 2023, 2 GB RAM, SSM access, other services already running) plus Cloudflare Tunnel and Cloudflare Access. Workers and Pages are not needed. Vercel does not fit (see section 10).
- `install-al2023.sh` (has `--dry-run`): own user `radar`, own dirs, own Node.js copy checked against the official SHA-256, systemd service with memory cap, daily backup timer. Touches nothing else; opens no port; refuses if the port is taken.
- `update.sh`: downloads the branch, backs up, swaps, health-checks, rolls back by itself on failure.
- `tools/backup.js`: consistent `VACUUM INTO` copy, keeps 14. `tools/probe.js` (`npm run probe`): outbound-only check of the keyword sources, to run on the server.

**Tests**: `npm test` = `test/auth.test.js` (35 checks, no network) then `test/selftest.js` (85 checks). The selftest probes the network first and skips the live keyword part with a clear message if the internet is blocked (`--skip-live` forces it; `npm run test:local`). Last full run: 35 + 85 passed.

**Not tested (do these first)**
- The install and update scripts and the systemd unit on a real Amazon Linux 2023 machine (only `bash -n` syntax check and the backup tool were run).
- Cloudflare Tunnel and Access (no access from the build environment).
- The service worker: the browser pane used for testing blocks service workers even for a trivial script, so `sw.js` is syntax-checked and reasoned about but has never run in a real browser. Check "Add to Home Screen" and offline behaviour on a real phone.
- Search sources from the AWS address (`npm run probe` on the server). Amazon addresses may be rate-limited by search sites.
- Real Google Places calls, the AI brief and the Tamil wording (unchanged from section 8).
