'use strict';
function parse(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  const s = String(text).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.some((x) => x !== '')) rows.push(row); row = []; }
    else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x !== '')) rows.push(row);
  return rows;
}

const cell = (v) => {
  let s = v == null ? '' : String(v);
  if (/^(=|@|[+-][^\d\s(])/.test(s)) s = "'" + s; // stop spreadsheet formula injection, keep +91 phone numbers intact
  return '"' + s.replace(/"/g, '""') + '"';
};
const stringify = (rows) => rows.map((r) => r.map(cell).join(',')).join('\r\n');

module.exports = { parse, stringify };
