// Generates the PWA icons as PNGs with no dependencies: node scripts/make-icons.js
// Design: vermilion square, cream compass ring, ink view cone pointing north-east.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BG = [255, 74, 28];
const RING = [255, 250, 243];
const CONE = [20, 17, 15];

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

// Colour of one sample point in unit coordinates (0..1), padded for maskable safe zone.
function sample(x, y) {
  const dx = x - 0.5, dy = y - 0.5;
  const r = Math.hypot(dx, dy);
  const ang = (Math.atan2(dx, -dy) * 180) / Math.PI; // 0 = up, clockwise
  const d = ((ang - 40 + 540) % 360) - 180;
  if (r < 0.27 && Math.abs(d) <= 30) return CONE;
  if (r < 0.045) return CONE;
  if (r > 0.29 && r < 0.335) return RING;
  return BG;
}

function png(size) {
  const ss = 4;
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < ss; sy++)
        for (let sx = 0; sx < ss; sx++) {
          const c = sample((x + (sx + 0.5) / ss) / size, (y + (sy + 0.5) / ss) / size);
          r += c[0]; g += c[1]; b += c[2];
        }
      const o = y * (size * 3 + 1) + 1 + x * 3;
      raw[o] = r / (ss * ss); raw[o + 1] = g / (ss * ss); raw[o + 2] = b / (ss * ss);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const out = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(out, { recursive: true });
for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) {
  fs.writeFileSync(path.join(out, name), png(size));
  console.log('wrote', name);
}
