'use strict';
const { STEPS } = require('./leads');

// "No 12, Gandhi St, Adyar, Chennai, Tamil Nadu 600020, India" + city "Chennai" -> "Adyar"
function guessArea(address, city) {
  if (!address) return '';
  const segs = address.split(',').map((s) => s.trim()).filter(Boolean);
  const idx = city ? segs.findIndex((s) => s.toLowerCase() === city.toLowerCase() || s.toLowerCase().startsWith(city.toLowerCase() + ' ')) : -1;
  const ok = (s) => s && !/\d/.test(s) && s.length <= 30 && !/\b(street|st\.?|road|rd\.?|nagar main|floor|flat|no\.?|plot|door|opp|near|behind)\b/i.test(s);
  if (idx > 0 && ok(segs[idx - 1])) return segs[idx - 1];
  if (idx > 1 && ok(segs[idx - 2])) return segs[idx - 2];
  return '';
}

function vars(lead, s) {
  const area = lead.area || '';
  return {
    hello: lead.contact_name ? `Hello ${lead.contact_name} 🙏` : 'Hello 🙏',
    sender: s.sender, product: s.product, topic: s.topic, org: s.org, link: s.link, offer: s.offer,
    area, name: lead.name || '', area_line: area ? `I found your ${s.org} in ${area}.` : '', details_link: '',
  };
}

function render(step, lead, settings, lang) {
  const meta = STEPS[step];
  if (!meta) return '';
  const T = settings.templates || {};
  const l = lang || lead.lang || 'en';
  const t = T[`${meta.tpl}_${l}`] || T[`${meta.tpl}_en`] || '';
  const v = vars(lead, settings);
  return t.replace(/\{(\w+)\}/g, (m, k) => (k in v ? v[k] : m)).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

const waLink = (wa, text) => (wa ? `https://wa.me/${wa}?text=${encodeURIComponent(text)}` : '');

// Which step is next for this lead, with everything the UI needs to act on it.
function action(lead, settings, stepOverride, opportunity = null) {\n  if (opportunity) {\n    if (opportunity.status !== 'human_confirmed') {\n      return { blocked: true, reason: 'awaiting human confirmation', opportunity_id: opportunity.id, status: opportunity.status };\n    }\n  }
  const step = stepOverride || lead.next_action || (lead.stage === 'new' ? (lead.wa && lead.phone_type !== 'landline' ? 'first' : 'call') : null);
  if (!step) return null;
  const meta = STEPS[step];
  const canWa = !!lead.wa && lead.phone_type !== 'landline';
  const channel = meta.channel === 'whatsapp' && !canWa ? 'call' : meta.channel;
  const lang = lead.lang || 'en';
  const key = channel === 'call' && meta.channel !== 'call' ? 'call' : step;
  const text = render(channel === 'call' && meta.channel !== 'call' ? 'call' : step, lead, settings, lang);
  return {
    step: key === 'call' ? 'call' : step, label: channel === 'call' && meta.channel !== 'call' ? 'Call (no WhatsApp number)' : meta.label,
    channel, hint: meta.hint, lang, text,
    wa: canWa ? waLink(lead.wa, text) : '', tel: lead.wa ? `tel:+${lead.wa}` : lead.phone ? `tel:${lead.phone.replace(/[^\d+]/g, '')}` : '',
  };
}

module.exports = { render, action, guessArea, waLink };
