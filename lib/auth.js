'use strict';
// Optional PIN login and host allow-list, for running the app behind a tunnel or proxy.
//   APP_PIN         turns login on (use 8+ characters)
//   ALLOWED_HOSTS   comma-separated hostnames the app may be reached at, besides localhost
// Sessions are a signed cookie (HttpOnly, SameSite=Strict). Wrong PINs are rate-limited per client.
const crypto = require('crypto');
const { jget, jset } = require('./db');

const LOCAL = ['localhost', '127.0.0.1', '[::1]'];
const DAY = 864e5;
const PUBLIC = new Set(['/login.html', '/login.js', '/app.css', '/manifest.webmanifest', '/sw.js', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png', '/icon.svg']);

function create(db, opts = {}) {
  const pin = opts.pin != null ? String(opts.pin) : process.env.APP_PIN || '';
  const extra = String(opts.allowedHosts != null ? opts.allowedHosts : process.env.ALLOWED_HOSTS || '')
    .split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  const hosts = new Set([...LOCAL, ...extra]);
  const sessionDays = opts.sessionDays || 30;

  let secret = process.env.APP_SECRET || jget(db, 'secret.session', '');
  if (!secret) { secret = crypto.randomBytes(32).toString('hex'); jset(db, 'secret.session', secret); }
  const sign = (s) => crypto.createHmac('sha256', secret).update(s).digest('hex');
  const same = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
  const digest = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

  const hostName = (h) => String(h || '').toLowerCase().replace(/:\d+$/, '');
  const hostOk = (h) => hosts.has(hostName(h));
  const originOk = (o) => { try { return hosts.has(hostName(new URL(o).host)); } catch { return false; } };

  const cookie = (req) => { const m = /(?:^|;\s*)radar_session=([^;]+)/.exec(req.headers.cookie || ''); return m ? m[1] : ''; };
  const isAuthed = (req) => {
    if (!pin) return true;
    const [exp, mac] = cookie(req).split('.');
    return !!(exp && mac && +exp > Date.now() && same(mac, sign('s' + exp)));
  };
  const secure = (req) => !!(req.socket.encrypted || /https/i.test(req.headers['x-forwarded-proto'] || '') || /https/i.test(req.headers['cf-visitor'] || ''));
  const setCookie = (req, res, value, maxAge) => res.setHeader('Set-Cookie', `radar_session=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure(req) ? '; Secure' : ''}`);

  const fails = new Map();
  const client = (req) => String(req.headers['cf-connecting-ip'] || (req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket.remoteAddress || '').trim();
  const locked = (ip) => { const f = fails.get(ip); return !!(f && f.n >= 5 && Date.now() - f.t < 15 * 60e3); };

  function login(req, res, given) {
    const ip = client(req);
    if (locked(ip)) return { status: 429, error: 'Too many wrong PINs. Try again in 15 minutes.' };
    if (!pin || !same(digest(given), digest(pin))) {
      const f = fails.get(ip);
      fails.set(ip, f && Date.now() - f.t < 15 * 60e3 ? { n: f.n + 1, t: f.t } : { n: 1, t: Date.now() });
      return { status: 401, error: 'Wrong PIN.' };
    }
    fails.delete(ip);
    const exp = Date.now() + sessionDays * DAY;
    setCookie(req, res, `${exp}.${sign('s' + exp)}`, sessionDays * 86400);
    return { status: 200 };
  }
  const actor = (req) => {
    if (!isAuthed(req)) return '';
    const c = cookie(req);
    return c ? 'session:' + digest(c).slice(0, 16) : 'local-authenticated';
  };
  const logout = (req, res) => setCookie(req, res, '', 0);
  const isPublic = (p) => PUBLIC.has(p) || p === '/api/login';

  return { enabled: !!pin, hostOk, originOk, isAuthed, actor, login, logout, isPublic, hosts: [...hosts], remote: extra.length > 0 };
}

module.exports = { create };
