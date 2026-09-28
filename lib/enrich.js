'use strict';
// Reads a business's own public website (homepage + contact page) to find contact details and to spot
// whether they already have an app. One polite request or two per business.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MAX_BYTES = 600 * 1024;

async function get(url, signal) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 9000);
  const onAbort = () => ctl.abort();
  signal && signal.addEventListener('abort', onAbort, { once: true });
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,*/*' }, signal: ctl.signal, redirect: 'follow' });
    if (!r.ok) return '';
    const type = r.headers.get('content-type') || '';
    if (type && !/html|text/i.test(type)) return '';
    const reader = r.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      chunks.push(value);
      if (size > MAX_BYTES) { ctl.abort(); break; }
    }
    return Buffer.concat(chunks).toString('utf8');
  } catch { return ''; } finally { clearTimeout(t); signal && signal.removeEventListener('abort', onAbort); }
}

const JUNK_EMAIL = /(example|sentry|wixpress|domain|email)\.|\.(png|jpe?g|gif|webp|svg|css|js)$|^(you|your|name|user)@/i;

function extract(html) {
  const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ');
  const emails = [...new Set((text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || []).map((e) => e.toLowerCase()).filter((e) => !JUNK_EMAIL.test(e)))].slice(0, 5);
  const phones = new Set();
  for (const m of text.matchAll(/(?<!\d)(?:\+?91[\s-]*)?0?([6-9]\d{4})[\s-]?(\d{5})(?!\d)/g)) phones.add(m[1] + m[2]);
  for (const m of text.matchAll(/href=["']tel:([^"']+)["']/gi)) { const d = m[1].replace(/\D/g, '').slice(-10); if (d.length === 10) phones.add(d); }
  const wa = [];
  for (const m of text.matchAll(/(?:wa\.me\/|api\.whatsapp\.com\/send\?phone=|whatsapp\.com\/send\?phone=)\+?(\d{10,15})/gi)) wa.push(m[1]);
  const link = (re) => { const m = text.match(re); return m ? m[0].replace(/["'<>].*$/, '') : ''; };
  const instagram = link(/https?:\/\/(?:www\.)?instagram\.com\/[a-z0-9_.]+/i);
  const facebook = link(/https?:\/\/(?:www\.)?facebook\.com\/[a-z0-9_.\/-]+/i);
  const stores = [];
  if (/play\.google\.com\/store\/apps/i.test(text)) stores.push('Google Play link');
  if (/apps\.apple\.com/i.test(text)) stores.push('App Store link');
  const words = [];
  for (const re of [/\bstudent (?:portal|login|app)\b/i, /\bparent (?:portal|login|app)\b/i, /\bdownload (?:our|the) app\b/i, /\bmobile app\b/i, /\bandroid app\b/i, /\bonline (?:portal|practice|test)s?\b/i, /\blms\b/i]) {
    const m = text.match(re); if (m) words.push(m[0].toLowerCase());
  }
  const contactLink = (html.match(/href=["']([^"']*contact[^"']*)["']/i) || [])[1] || '';
  return { emails, phones: [...phones], wa: [...new Set(wa)], instagram, facebook, stores, words, contactLink };
}

async function enrich(website, signal) {
  let base;
  try { base = new URL(/^https?:/i.test(website) ? website : 'https://' + website); } catch { return { ok: false, reason: 'bad url' }; }
  const html = await get(base.href, signal);
  if (!html) return { ok: false, reason: 'site did not respond' };
  const a = extract(html);
  if (a.contactLink && !/^(mailto|tel|javascript|#)/i.test(a.contactLink)) {
    try {
      const u = new URL(a.contactLink, base);
      if (u.hostname === base.hostname && u.href !== base.href) {
        const b = extract(await get(u.href, signal));
        for (const k of ['emails', 'phones', 'wa', 'stores', 'words']) a[k] = [...new Set([...a[k], ...b[k]])];
        a.instagram = a.instagram || b.instagram; a.facebook = a.facebook || b.facebook;
      }
    } catch { /* ignore */ }
  }
  return { ok: true, ...a, hasApp: a.stores.length ? 'yes' : a.words.length ? 'maybe' : 'no' };
}

module.exports = { enrich, extract };
