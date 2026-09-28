'use strict';
const sleep = (ms, signal) => new Promise((res) => {
  const t = setTimeout(res, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); res(); }, { once: true });
});
const jitter = (ms) => ms + Math.floor(Math.random() * ms * 0.5);
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const todayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const startOfDay = (d = new Date()) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); };
// "11:00 local time, n days from now"
const atEleven = (days, from = Date.now()) => { const d = new Date(from + days * 864e5); d.setHours(11, 0, 0, 0); return d.getTime(); };
module.exports = { sleep, jitter, norm, esc, todayKey, startOfDay, atEleven };
