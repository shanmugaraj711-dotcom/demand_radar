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

function seedDefaultProduct(db, initialData = null) {
  const existing = db.prepare('SELECT COUNT(*) n FROM products').get();
  if (existing && existing.n > 0) {
    return getActiveProduct(db);
  }

  let profile = initialData;
  if (!profile) {
    try {
      const raw = db.prepare("SELECT v FROM settings WHERE k='profile'").get();
      if (raw && raw.v) profile = JSON.parse(raw.v);
    } catch {
      profile = null;
    }
  }

  if (!profile || (!profile.product && !profile.name)) {
    throw new Error('Cannot seed default product: settings profile is missing product configuration.');
  }

  const name = String(profile.product || profile.name).trim();
  const topic = String(profile.topic || '').trim();
  if (!name || !topic) {
    throw new Error('Cannot seed default product: product name and topic are required in profile configuration.');
  }

  const org = String(profile.org || profile.target_org || 'business').trim() || 'business';
  const link = String(profile.link || '').trim();
  const offer = String(profile.offer || '').trim();
  const templates = profile.templates || {};
  const rawSlug = String(profile.slug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'product-1');
  const slug = rawSlug.length < 2 ? rawSlug + '-1' : rawSlug.slice(0, 60);
  const description = String(profile.description || `${name} (${topic})`).trim();
  const targetKeywords = Array.isArray(profile.target_keywords)
    ? profile.target_keywords
    : (topic ? [topic] : []);

  const valid = validateProduct({
    slug,
    name,
    description,
    topic,
    target_org: org,
    link,
    offer,
    target_keywords: targetKeywords,
    templates,
    active: 1
  }, false);

  const now = Date.now();
  const r = db.prepare(`
    INSERT INTO products(slug, name, description, topic, target_org, link, offer, target_keywords, templates, active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
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
  return null;
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
