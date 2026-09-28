'use strict';
// Login, host allow-list, security headers and the refuse-to-start safety. No network needed.
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const { createApp } = require('../server');

let pass = 0, fail = 0;
const ok = (c, m, x) => { if (c) { pass++; console.log('  ok   ' + m); } else { fail++; console.log('  FAIL ' + m + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); } };
const tmp = () => path.join(os.tmpdir(), 'radar-auth-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.db');
const clean = (f) => { for (const e of ['', '-wal', '-shm']) fs.rmSync(f + e, { force: true }); };

function start(opts) {
  const dbFile = tmp();
  const app = createApp({ dbFile, ...opts });
  return new Promise((res) => app.server.listen(0, '127.0.0.1', () => res({ app, dbFile, port: app.server.address().port })));
}
const call = (port, p, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers } }, (x) => {
    let t = ''; x.on('data', (c) => (t += c)); x.on('end', () => { let j; try { j = JSON.parse(t); } catch { j = t; } resolve({ status: x.statusCode, headers: x.headers, body: j }); });
  });
  r.on('error', reject); if (body) r.write(JSON.stringify(body)); r.end();
});
const cookieOf = (r) => ((r.headers['set-cookie'] || [])[0] || '').split(';')[0];

async function main() {
  console.log('\nLogin');
  {
    const { app, dbFile, port } = await start({ pin: 'correct-horse-9', allowedHosts: 'radar.example.com' });
    const H = { Host: 'radar.example.com' };
    let r = await call(port, '/api/state', { headers: H });
    ok(r.status === 401 && r.body.login === true, 'API without a session is refused (401)');
    r = await call(port, '/', { headers: H });
    ok(r.status === 302 && r.headers.location === '/login.html', 'page without a session redirects to the login page');
    r = await call(port, '/app.js', { headers: H });
    ok(r.status === 302, 'app code is not served before login');
    for (const p of ['/login.html', '/login.js', '/manifest.webmanifest', '/sw.js', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png']) {
      r = await call(port, p, { headers: H });
      ok(r.status === 200, `public file before login: ${p}`, r.status);
    }
    r = await call(port, '/icon-512.png', { headers: H });
    ok(r.headers['content-type'] === 'image/png', 'icon is served as image/png');
    r = await call(port, '/manifest.webmanifest', { headers: H });
    ok(/manifest\+json/.test(r.headers['content-type']) && r.body.display === 'standalone' && r.body.icons.length === 2, 'manifest is valid and installable');
    r = await call(port, '/login.html', { headers: H });
    ok(/default-src 'self'/.test(r.headers['content-security-policy']) && r.headers['x-frame-options'] === 'DENY' && r.headers['x-content-type-options'] === 'nosniff', 'security headers on pages');

    r = await call(port, '/api/login', { method: 'POST', headers: H, body: { pin: 'nope' } });
    ok(r.status === 401 && !r.headers['set-cookie'], 'wrong PIN is refused with no cookie');
    r = await call(port, '/api/login', { method: 'POST', headers: H, body: {} });
    ok(r.status === 401, 'missing PIN is refused');

    r = await call(port, '/api/login', { method: 'POST', headers: H, body: { pin: 'correct-horse-9' } });
    const sc = (r.headers['set-cookie'] || [])[0] || '';
    ok(r.status === 200 && /HttpOnly/.test(sc) && /SameSite=Strict/.test(sc) && !/Secure/.test(sc), 'right PIN sets an HttpOnly, SameSite=Strict cookie (no Secure on plain http)', sc);
    const ck = cookieOf(r);
    r = await call(port, '/api/login', { method: 'POST', headers: { ...H, 'X-Forwarded-Proto': 'https' }, body: { pin: 'correct-horse-9' } });
    ok(/Secure/.test((r.headers['set-cookie'] || [])[0] || ''), 'cookie is Secure when the request came in over https (tunnel)');

    r = await call(port, '/api/state', { headers: { ...H, Cookie: ck } });
    ok(r.status === 200 && r.body.auth === true, 'session cookie unlocks the API');
    r = await call(port, '/app.js', { headers: { ...H, Cookie: ck } });
    ok(r.status === 200 && /Topic Radar front end/.test(r.body), 'session cookie unlocks the app');
    r = await call(port, '/api/state', { headers: { ...H, Cookie: ck.slice(0, -3) + 'abc' } });
    ok(r.status === 401, 'tampered cookie is refused');
    r = await call(port, '/api/state', { headers: { ...H, Cookie: 'radar_session=' + (Date.now() - 1000) + '.' + ck.split('.')[1] } });
    ok(r.status === 401, 'expired or forged cookie is refused');
    r = await call(port, '/api/logout', { method: 'POST', headers: { ...H, Cookie: ck } });
    ok(r.status === 200 && /Max-Age=0/.test((r.headers['set-cookie'] || [])[0] || ''), 'logout clears the cookie');

    console.log('\nHost and origin rules');
    r = await call(port, '/api/state', { headers: { Host: 'evil.example', Cookie: ck } });
    ok(r.status === 403, 'unknown Host is refused even with a valid session');
    r = await call(port, '/api/settings', { method: 'PUT', headers: { ...H, Cookie: ck, Origin: 'https://evil.example' }, body: {} });
    ok(r.status === 403, 'cross-origin write is refused');
    r = await call(port, '/api/settings', { method: 'PUT', headers: { ...H, Cookie: ck, Origin: 'https://radar.example.com' }, body: {} });
    ok(r.status === 200, 'write from the allowed domain works');
    r = await call(port, '/api/state', { headers: { Host: 'localhost:4173', Cookie: ck } });
    ok(r.status === 200, 'localhost still works');

    console.log('\nLockout');
    const c2 = await start({ pin: 'another-pin-77' });
    let last;
    for (let i = 0; i < 5; i++) last = await call(c2.port, '/api/login', { method: 'POST', body: { pin: 'wrong' + i } });
    ok(last.status === 401, 'first five wrong PINs get 401');
    last = await call(c2.port, '/api/login', { method: 'POST', body: { pin: 'wrong-again' } });
    ok(last.status === 429, 'sixth attempt is locked out (429)');
    last = await call(c2.port, '/api/login', { method: 'POST', body: { pin: 'another-pin-77' } });
    ok(last.status === 429, 'even the right PIN is refused during the lockout');
    const c3 = await call(c2.port, '/api/login', { method: 'POST', headers: { 'CF-Connecting-IP': '203.0.113.9' }, body: { pin: 'another-pin-77' } });
    ok(c3.status === 200, 'lockout is per client address (another client can still sign in)');
    c2.app.close(); clean(c2.dbFile);

    console.log('\nNo PIN set (local use)');
    const c4 = await start({});
    r = await call(c4.port, '/api/state');
    ok(r.status === 200 && r.body.auth === false, 'works without login on localhost');
    r = await call(c4.port, '/app.js');
    ok(r.status === 200, 'app files are served');
    c4.app.close(); clean(c4.dbFile);
    app.close(); clean(dbFile);
  }

  console.log('\nSafe start-up');
  {
    const run = (env) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], { env: { ...process.env, DATA_DIR: os.tmpdir() + path.sep + 'radar-boot-' + Date.now(), PORT: '0', ...env }, encoding: 'utf8', timeout: 8000 });
    let r = run({ HOST: '0.0.0.0', APP_PIN: '', ALLOWED_HOSTS: '' });
    ok(r.status === 1 && /Refusing to start/.test(r.stderr), 'refuses to listen beyond this computer without a PIN');
    r = run({ ALLOWED_HOSTS: 'radar.example.com', APP_PIN: '' });
    ok(r.status === 1 && /Refusing to start/.test(r.stderr), 'refuses to serve a public hostname without a PIN');
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], { env: { ...process.env, DATA_DIR: os.tmpdir() + path.sep + 'radar-boot2-' + Date.now(), PORT: '0', ALLOWED_HOSTS: 'radar.example.com', ALLOW_NO_PIN: '1', APP_PIN: '' } });
    let out = '';
    child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (out += d));
    await new Promise((res) => setTimeout(res, 2500));
    ok(/is running/.test(out) && /off/.test(out), 'starts when ALLOW_NO_PIN=1 (for use behind Cloudflare Access)', out);
    child.kill();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
