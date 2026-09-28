'use strict';
const { jget, jset } = require('./db');

// Message templates. Variables: {hello} {sender} {product} {topic} {org} {link} {offer} {area} {name} {details_link}
// {area_line} is "I found your <org> in <area>." and disappears when the area is unknown.
const TEMPLATES = {
  first_en: '{hello}\nI\'m {sender} from {product}. We made a phone app where kids practise {topic} at home with a friendly character.\n{area_line}\nWould you like to try it free? Here is the link: {link}\nIf you find it useful, we can talk about how it can help your {org}. No pressure.',
  first_ta: 'வணக்கம் 🙏\nநான் {sender}, {product} சார்பாக பேசுகிறேன். குழந்தைகள் வீட்டிலேயே {topic} பயிற்சி செய்ய ஒரு மொபைல் ஆப் உருவாக்கியுள்ளோம்.\nஇலவசமாக பார்த்துவிட்டு சொல்லுங்கள்: {link}\nபிடித்திருந்தால் அதைப் பற்றி பேசலாம். நன்றி 🙏',
  followup1_en: '{hello}\nDid you get a chance to look at the link? Happy to answer any questions or show a 5-minute demo whenever you\'re free.',
  followup1_ta: 'வணக்கம் 🙏\nநான் அனுப்பிய லிங்க்கைப் பார்க்க முடிந்ததா? ஏதேனும் சந்தேகம் இருந்தால் கேளுங்கள். உங்களுக்கு வசதியான நேரத்தில் 5 நிமிட டெமோவும் காட்டுகிறேன்.',
  call_en: 'Hello, I\'m {sender} from {product}. I sent you a WhatsApp about a free {topic} practice app for kids. Do you have one minute?\n\n(If yes) Kids practise {topic} at home with a friendly character. You can try it free and see if your students like it. Shall I send the details again?\n(If busy) No problem. When is a better time to call?',
  details_en: 'Thank you 🙏 Here are the details. {offer}\nYou can try the app here: {link}\nMay I know your name? I am happy to answer any questions or do a 10-minute video demo.',
  details_ta: 'நன்றி 🙏 விவரங்கள் இதோ. {offer}\nஆப்பை இங்கே பார்க்கலாம்: {link}\nஉங்கள் பெயர் தெரிந்துகொள்ளலாமா? சந்தேகங்கள் இருந்தால் கேளுங்கள், 10 நிமிட வீடியோ டெமோவும் காட்டலாம்.',
  nudge_en: '{hello}\nJust checking if you had a chance to read the details. Happy to do a 10-minute video demo whenever it suits you.',
  nudge_ta: 'வணக்கம் 🙏\nவிவரங்களைப் படிக்க முடிந்ததா? உங்களுக்கு வசதியான நேரத்தில் 10 நிமிட வீடியோ டெமோ காட்டுகிறேன்.',
  has_app_en: 'Thank you for telling me. Please keep your app. This is only for children\'s daily 10-minute {topic} practice at home. Could you try it with 2 students alongside your app? May I ask which app you use and what the children use it for?',
  checkin3_en: '{hello}\nHow are the students finding the app? Is anything confusing for them or the parents? Happy to fix it quickly.',
  checkin7_en: '{hello}\nIt has been a week. How many students practised? If you like, I can send a short message for your parents\' group.',
  review30_en: '{hello}\nThe 30-day trial is complete. Could we speak for 10 minutes about what worked and how to continue with your {org}?',
};

const DEFAULTS = {
  sender: 'Shanmugaraj',
  product: 'Abacus Buddy AI',
  topic: 'abacus',
  org: 'centre',
  link: 'https://abacus.promptstudioai.in',
  offer: '2 free student accounts are for you to test and show the app. Other students\' parents can unlock the full app, and your centre earns a share for each one.',
  country: 'IN',
  lang: 'en',
  cc: '91',
  dailyCap: 15,
  minQueueScore: 30,
  placesDailyCap: 200,
  chainWords: 'sip abacus, ideal play, indian abacus, magic brain, brainobrain, starkids, ucmas, kidzee, eurokids',
  aiModel: 'claude-haiku-4-5-20251001',
  templates: TEMPLATES,
};

const SECRET_KEYS = ['placesKey', 'anthropicKey'];

function load(db) {
  const saved = jget(db, 'profile', {});
  const s = { ...DEFAULTS, ...saved, templates: { ...TEMPLATES, ...(saved.templates || {}) } };
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
}

module.exports = { load, save, publicView, DEFAULTS, TEMPLATES };
