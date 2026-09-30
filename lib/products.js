'use strict';

function parseJsonField(val, defaultVal = null) {
  if (val === null || val === undefined) return defaultVal;
  if (typeof val === 'object') return val;
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (!trimmed) return defaultVal;
    try {
      return JSON.parse(trimmed);
    } catch {
      throw new Error('Invalid JSON format');
    }
  }
  return defaultVal;
}

function validateProduct(input, isUpdate = false) {
  const p = {};
  if (!isUpdate || input.slug !== undefined) {
    const slug = String(input.slug || '').trim().toLowerCase();
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length < 2 || slug.length > 60) {
      throw new Error('Slug must be 2-60 lowercase alphanumeric characters and hyphens.');
    }
    p.slug = slug;
  }

  if (!isUpdate || input.name !== undefined) {
    const name = String(input.name || '').trim();
    if (!name || name.length > 100) {
      throw new Error('Name is required and must be under 100 characters.');
    }
    p.name = name;
  }

  if (!isUpdate || input.description !== undefined) {
    const description = String(input.description || '').trim();
    if (!description || description.length > 2000) {
      throw new Error('Description is required and must be under 2000 characters.');
    }
    p.description = description;
  }

  if (!isUpdate || input.topic !== undefined) {
    const topic = String(input.topic || '').trim();
    if (!topic || topic.length > 100) {
      throw new Error('Topic is required and must be under 100 characters.');
    }
    p.topic = topic;
  }

  if (input.target_org !== undefined) {
    p.target_org = String(input.target_org || 'business').trim().slice(0, 80) || 'business';
  } else if (!isUpdate) {
    p.target_org = 'business';
  }

  if (input.link !== undefined) {
    p.link = String(input.link || '').trim().slice(0, 500);
  } else if (!isUpdate) {
    p.link = '';
  }

  if (input.offer !== undefined) {
    p.offer = String(input.offer || '').trim().slice(0, 2000);
  } else if (!isUpdate) {
    p.offer = '';
  }

  if (input.target_keywords !== undefined) {
    let kw = input.target_keywords;
    if (typeof kw === 'string') {
      try {
        kw = JSON.parse(kw);
      } catch {
        kw = kw.split(',').map(s => s.trim()).filter(Boolean);
      }
    }
    if (kw !== null && !Array.isArray(kw)) {
      throw new Error('target_keywords must be a JSON array of keyword strings.');
    }
    if (Array.isArray(kw)) {
      kw = kw.map(k => String(k).trim()).filter(Boolean);
    }
    p.target_keywords = Array.isArray(kw) ? JSON.stringify(kw) : '[]';
  } else if (!isUpdate) {
    p.target_keywords = '[]';
  }

  if (input.templates !== undefined) {
    let tpl = input.templates;
    if (typeof tpl === 'string') {
      try {
        tpl = JSON.parse(tpl);
      } catch {
        throw new Error('templates must be a valid JSON object.');
      }
    }
    if (tpl !== null && (typeof tpl !== 'object' || Array.isArray(tpl))) {
      throw new Error('templates must be a valid JSON object of template strings.');
    }
    p.templates = tpl ? JSON.stringify(tpl) : '{}';
  } else if (!isUpdate) {
    p.templates = '{}';
  }

  if (input.active !== undefined) {
    p.active = input.active ? 1 : 0;
  } else if (!isUpdate) {
    p.active = 1;
  }

  return p;
}

function hydrateProduct(row) {
  if (!row) return null;
  let target_keywords = [];
  try {
    target_keywords = JSON.parse(row.target_keywords || '[]');
  } catch {
    target_keywords = [];
  }
  let templates = {};
  try {
    templates = JSON.parse(row.templates || '{}');
  } catch {
    templates = {};
  }
  return {
    ...row,
    active: Number(row.active),
    target_keywords,
    templates,
  };
}

const DEFAULT_ABACUS_TEMPLATES = {
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
  review30_en: '{hello}\nThe 30-day trial is complete. Could we speak for 10 minutes about what worked and how to continue with your {org}?'
};

function seedDefaultProduct(db) {
  const existing = db.prepare('SELECT COUNT(*) n FROM products').get();
  if (existing && existing.n > 0) {
    return getActiveProduct(db);
  }

  // Read existing configured settings from settings table if present
  let profile = {};
  try {
    const raw = db.prepare("SELECT v FROM settings WHERE k='profile'").get();
    if (raw && raw.v) profile = JSON.parse(raw.v);
  } catch {
    profile = {};
  }

  const name = String(profile.product || 'Abacus Buddy AI').trim();
  const topic = String(profile.topic || 'abacus').trim();
  const org = String(profile.org || 'centre').trim();
  const link = String(profile.link || 'https://abacus.promptstudioai.in').trim();
  const offer = String(profile.offer || '2 free student accounts are for you to test and show the app. Other students\' parents can unlock the full app, and your centre earns a share for each one.').trim();
  const templates = profile.templates || DEFAULT_ABACUS_TEMPLATES;

  const now = Date.now();
  const r = db.prepare(`
    INSERT INTO products(slug, name, description, topic, target_org, link, offer, target_keywords, templates, active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(
    'abacus-buddy',
    name,
    'Kids abacus practice app with friendly character',
    topic,
    org,
    link,
    offer,
    JSON.stringify(['abacus', 'abacus classes', 'vedic maths', 'mental arithmetic']),
    JSON.stringify(templates),
    now,
    now
  );

  return getProductById(db, Number(r.lastInsertRowid));
}

function getActiveProduct(db) {
  const row = db.prepare('SELECT * FROM products WHERE active=1 ORDER BY updated_at DESC LIMIT 1').get();
  if (row) return hydrateProduct(row);
  const anyRow = db.prepare('SELECT * FROM products ORDER BY id ASC LIMIT 1').get();
  if (anyRow) return hydrateProduct(anyRow);
  return seedDefaultProduct(db);
}

function getProductById(db, id) {
  const row = db.prepare('SELECT * FROM products WHERE id=?').get(Number(id));
  return hydrateProduct(row);
}

function getProductBySlug(db, slug) {
  const row = db.prepare('SELECT * FROM products WHERE slug=?').get(String(slug).trim().toLowerCase());
  return hydrateProduct(row);
}

function listProducts(db, { activeOnly = false } = {}) {
  const sql = activeOnly
    ? 'SELECT * FROM products WHERE active=1 ORDER BY updated_at DESC'
    : 'SELECT * FROM products ORDER BY active DESC, updated_at DESC';
  const rows = db.prepare(sql).all();
  return rows.map(hydrateProduct);
}

function createProduct(db, input) {
  const valid = validateProduct(input, false);
  const now = Date.now();

  if (valid.active === 1) {
    db.prepare('UPDATE products SET active=0, updated_at=?').run(now);
  }

  const r = db.prepare(`
    INSERT INTO products(slug, name, description, topic, target_org, link, offer, target_keywords, templates, active, created_at, updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    valid.slug,
    valid.name,
    valid.description,
    valid.topic,
    valid.target_org,
    valid.link,
    valid.offer,
    valid.target_keywords,
    valid.templates,
    valid.active,
    now,
    now
  );
  return getProductById(db, Number(r.lastInsertRowid));
}

function updateProduct(db, id, patch) {
  const pid = Number(id);
  const existing = db.prepare('SELECT * FROM products WHERE id=?').get(pid);
  if (!existing) throw new Error('Product not found.');
  const valid = validateProduct(patch, true);

  const updates = [];
  const args = [];
  for (const [k, v] of Object.entries(valid)) {
    updates.push(`${k}=?`);
    args.push(v);
  }
  if (!updates.length) return hydrateProduct(existing);

  const now = Date.now();
  if (valid.active === 1) {
    db.prepare('UPDATE products SET active=0, updated_at=? WHERE id!=?').run(now, pid);
  }

  updates.push('updated_at=?');
  args.push(now);
  args.push(pid);

  db.prepare(`UPDATE products SET ${updates.join(', ')} WHERE id=?`).run(...args);
  return getProductById(db, pid);
}

function activateProduct(db, id) {
  const pid = Number(id);
  const existing = db.prepare('SELECT * FROM products WHERE id=?').get(pid);
  if (!existing) throw new Error('Product not found.');
  const now = Date.now();
  db.exec('BEGIN TRANSACTION;');
  try {
    db.prepare('UPDATE products SET active=0, updated_at=? WHERE id!=?').run(now, pid);
    db.prepare('UPDATE products SET active=1, updated_at=? WHERE id=?').run(now, pid);
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }
  return getProductById(db, pid);
}

function deleteProduct(db, id) {
  const pid = Number(id);
  const existing = db.prepare('SELECT * FROM products WHERE id=?').get(pid);
  if (!existing) throw new Error('Product not found.');
  const oppCount = db.prepare('SELECT COUNT(*) n FROM lead_opportunities WHERE product_id=?').get(pid);
  if (oppCount && oppCount.n > 0) {
    throw new Error('Cannot delete product referenced by existing opportunities. Deactivate it instead.');
  }
  const total = db.prepare('SELECT COUNT(*) n FROM products').get().n;
  if (total <= 1) {
    throw new Error('Cannot delete the only existing product.');
  }
  db.prepare('DELETE FROM products WHERE id=?').run(pid);
  if (existing.active) {
    const nextProd = db.prepare('SELECT id FROM products ORDER BY updated_at DESC LIMIT 1').get();
    if (nextProd) activateProduct(db, nextProd.id);
  }
  return { ok: true, id: pid };
}

module.exports = {
  DEFAULT_ABACUS_TEMPLATES,
  validateProduct,
  seedDefaultProduct,
  getActiveProduct,
  getProductById,
  getProductBySlug,
  listProducts,
  createProduct,
  updateProduct,
  activateProduct,
  deleteProduct,
  hydrateProduct,
};
