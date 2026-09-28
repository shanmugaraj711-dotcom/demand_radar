'use strict';
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = document.getElementById('err');
  err.hidden = true;
  try {
    const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: document.getElementById('pin').value }) });
    const j = await r.json().catch(() => ({}));
    if (r.ok) return location.replace('/');
    err.textContent = j.error || 'Could not sign in.';
  } catch { err.textContent = 'Cannot reach the server.'; }
  err.hidden = false;
});
