'use strict';
// Draws the app icon (a radar sweep) as PNG files with no dependencies. Run once: node tools/make-icons.js
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const t = Buffer.from(type); const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([l, t, data, c]); };
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

function png(size, maskable) {
  const px = Buffer.alloc(size * size * 4);
  const bg = [24, 95, 165], fg = [255, 255, 255];
  const scale = maskable ? 0.72 : 1; // maskable icons keep the art inside the safe zone
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const nx = ((x + 0.5) / size - 0.5) * 2 / scale, ny = ((y + 0.5) / size - 0.5) * 2 / scale;
    const d = Math.hypot(nx, ny);
    let a = 0; // 0..1 white amount
    const ring = (r, w) => 1 - smooth(w, w + 0.02, Math.abs(d - r));
    a = Math.max(a, ring(0.72, 0.035), ring(0.42, 0.03));
    if (d < 0.07) a = 1;
    // sweep line from centre to upper right
    const ang = Math.atan2(-ny, nx), inside = d < 0.72;
    const off = Math.abs(Math.sin(ang - Math.PI / 4)) * d;
    if (inside && Math.cos(ang - Math.PI / 4) > 0) a = Math.max(a, 1 - smooth(0.025, 0.045, off));
    // blip
    const bx = nx - 0.36, by = ny + 0.36;
    a = Math.max(a, 1 - smooth(0.06, 0.09, Math.hypot(bx, by)));
    const round = maskable ? 1 : 1 - smooth(0.96, 1.0, Math.max(Math.abs(nx * scale), Math.abs(ny * scale)) * 1.0) ; // square edge softening
    const i = (y * size + x) * 4;
    for (let k = 0; k < 3; k++) px[i + k] = Math.round(bg[k] + (fg[k] - bg[k]) * a);
    px[i + 3] = 255;
  }
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const out = path.join(__dirname, '..', 'public');
fs.writeFileSync(path.join(out, 'icon-192.png'), png(192, true));
fs.writeFileSync(path.join(out, 'icon-512.png'), png(512, true));
fs.writeFileSync(path.join(out, 'apple-touch-icon.png'), png(180, false));
fs.writeFileSync(path.join(out, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#185fa5" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5"/><path d="M12 12l6-6"/></svg>');
console.log('icons written to public/');
