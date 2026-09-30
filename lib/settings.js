'use strict';
const { jget, jset } = require('./db');

// Message templates. Variables: {hello} {sender} {product} {topic} {org} {link} {offer} {area} {name} {details_link}
// {area_line} is "I found your <org> in <area>." and disappears when the area is unknown.
const TEMPLATES = {
  first_en: '{hello}\nI\'m {sender} from {product}. We provide a solution for your {org} around {topic}.\n{area_line}\nWould you like to try it free? Here is the link: {link}\nIf you find it useful, we can talk about how it can help your {org}. No pressure.',
  first_ta: 'வணக்கம் 🙏\nநான் {sender}, {product} சார்பாக பேசுகிறேன். {topic} தொடர்பாக உங்கள் {org}க்கு உதவ ஒரு தீர்வு உருவாக்கியுள்ளோம்.\nஇலவசமாக பார்த்துவிட்டு சொல்லுங்கள்: {link}\nபிடித்திருந்தால் அதைப் பற்றி பேசலாம். நன்றி 🙏',
  followup1_en: '{hello}\nDid you get a chance to look at the link? Happy to answer any questions or show a 5-minute demo whenever you\'re free.',
  followup1_ta: 'வணக்கம் 🙏\nநான் அனுப்பிய லிங்க்கைப் பார்க்க முடிந்ததா? ஏதேனும் சந்தேகம் இருந்தால் கேளுங்கள். உங்களுக்கு வசதியான நேரத்தில் 5 நிமிட டெமோவும் காட்டுகிறேன்.',
  call_en: 'Hello, I\'m {sender} from {product}. I sent you a message about our solution for {topic}. Do you have one minute?\n\n(If yes) You can try it free and see if it helps your {org}. Shall I send the details again?\n(If busy) No problem. When is a better time to call?',
  details_en: 'Thank you 🙏 Here are the details. {offer}\nYou can see it here: {link}\nMay I know your name? I am happy to answer any questions or do a 10-minute video demo.',
  details_ta: 'நன்றி 🙏 விவரங்கள் இதோ. {offer}\nஇங்கே பார்க்கலாம்: {link}\nஉங்கள் பெயர் தெரிந்துகொள்ளலாமா? சந்தேகங்கள் இருந்தால் கேளுங்கள், 10 நிமிட வீடியோ டெமோவும் காட்டலாம்.',
  nudge_en: '{hello}\nJust checking if you had a chance to read the details. Happy to do a 10-minute video demo whenever it suits you.',
  nudge_ta: 'வணக்கம் 🙏\nவிவரங்களைப் படிக்க முடிந்ததா? உங்களுக்கு வசதியான நேரத்தில் 10 நிமிட வீடியோ டெமோ காட்டுகிறேன்.',
  has_app_en: 'Thank you for telling me. Please keep what you use. We provide a focused solution for {topic}. Could you try it alongside your current setup? May I ask what you currently use?',
  checkin3_en: '{hello}\nHow are you finding the solution? Is anything confusing? Happy to fix it quickly.',
  checkin7_en: '{hello}\nIt has been a week. How is it working for your {org}? Happy to answer any questions.',
  review30_en: '{hello}\nThe 30-day trial is complete. Could we speak for 10 minutes about what worked and how to continue with your {org}?',
};

const DEFAULTS = {
  sender: 'Shanmugaraj',
  product: 'Demand Radar',
  topic: 'lead generation',
  org: 'business',
  link: '',
  offer: '',
  country: 'IN',
  lang: 'en',
  cc: '91',
  dailyCap: 15,
  minQueueScore: 30,
  placesDailyCap: 200,
  chainWords: '',
  aiModel: 'claude-haiku-4-5-20251001',
  templates: TEMPLATES,
};

const SECRET_KEYS = ['placesKey', 'anthropicKey'];

function load(db) {
  const saved = jget(db, 'profile', {});
  const s = { ...DEFAULTS, ...saved, templates: { ...TEMPLATES, ...(saved.templates || {}) } };

  // Overlay active product configuration if products table exists
  try {
    const productsLib = require('./products');
    const activeProduct = productsLib.getActiveProduct(db);
    if (activeProduct) {
      s.activeProduct = activeProduct;
      s.product = activeProduct.name;
      s.topic = activeProduct.topic;
      s.org = activeProduct.target_org;
      s.link = activeProduct.link;
      s.offer = activeProduct.offer;
      if (activeProduct.templates && Object.keys(activeProduct.templates).length > 0) {
        s.templates = { ...TEMPLATES, ...activeProduct.templates, ...(saved.templates || {}) };
      }
    }
  } catch (_) {
    // Graceful fallback if database does not have products table yet
  }

  s.placesKey = process.env.GOOGLE_PLACES_API_KEY || jget(db, 'secret.placesKey', '');
  s.anthropicKey = process.env.ANTHROPIC_API_KEY || jget(db, 'secret.anthropicKey', '');
  return s;
}

function publicView(s) {
  const mask = (k) => (k ? '••••' + k.slice(-4) : '');
  const out = { ...s };
  for (const k of SECRET_KEYS) { out[k + 'Set'] = !!s[k]; out[k] = mask(s[k]); }
  return out;
}

function save(db, patch) {
  const cur = jget(db, 'profile', {});
  const next = { ...cur };
  for (const [k, v] of Object.entries(patch || {})) {
    if (SECRET_KEYS.includes(k)) {
      if (typeof v === 'string' && !v.startsWith('••••')) jset(db, 'secret.' + k, v.trim());
      continue;
    }
    if (!(k in DEFAULTS)) continue;
    if (k === 'templates') next.templates = { ...(cur.templates || {}), ...v };
    else next[k] = v;
  }
  jset(db, 'profile', next);

  // Sync to active product if products table exists
  try {
    const productsLib = require('./products');
    const active = productsLib.getActiveProduct(db);
    if (active) {
      const updates = {};
      if (patch.product) updates.name = patch.product;
      if (patch.topic) updates.topic = patch.topic;
      if (patch.org) updates.target_org = patch.org;
      if (patch.link !== undefined) updates.link = patch.link;
      if (patch.offer !== undefined) updates.offer = patch.offer;
      if (patch.templates) updates.templates = patch.templates;
      if (Object.keys(updates).length > 0) {
        productsLib.updateProduct(db, active.id, updates);
      }
    }
  } catch (_) {}
}

module.exports = { load, save, publicView, DEFAULTS, TEMPLATES };
