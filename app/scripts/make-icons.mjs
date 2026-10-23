// Generates Monday's icon set with zero dependencies: a minimal PNG encoder
// over zlib, supersampled for clean curves.
//
// THE MARK: the orb. A ring with a solid core, which is exactly the object
// MondayOrb.jsx draws in the header — so the icon and the running app share one
// identity rather than merely sharing a colour. Gold on ink, because a dark tile
// reads correctly in a light Dock, a dark Dock, a browser tab and a favicon,
// whereas the old flat #ffde00 square only worked against light chrome.
//
// Run: node scripts/make-icons.mjs   (or `npm run icons`)
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HUE, NEUTRAL } from '../design/tokens.js';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'public');
fs.mkdirSync(OUT, { recursive: true });

// ---- tiny PNG encoder (8-bit RGBA, colour type 6) ----
// Type 6 rather than the old type 2: the rounded-square mask needs real alpha
// or the corners come out as opaque black against every background.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
function png(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit, RGBA
  const stride = w * 4;
  const raw = Buffer.alloc(h * (1 + stride));
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (1 + stride) + 1, y * stride, (y + 1) * stride);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const GOLD = hex(HUE.brand.dark.fill);      // #f0c33c — the identity colour
const INK  = hex(NEUTRAL.light.ink);        // #1a1815 — the tile ground
const SS = 4;                               // supersample factor

/**
 * Draw at SS× and box-downsample. The previous generator wrote hard-edged
 * circles with no antialiasing, which is defensible for squares and looks
 * broken on a ring at any size below ~128px.
 */
function drawIcon(S) {
  const N = S * SS;
  const hi = Buffer.alloc(N * N * 4);
  const u = N / 64;                         // design grid is 64 units
  const put = (x, y, c, a = 255) => {
    const i = (y * N + x) * 4;
    hi[i] = c[0]; hi[i + 1] = c[1]; hi[i + 2] = c[2]; hi[i + 3] = a;
  };
  // rounded square ground — macOS masks its own shape, but the favicon and the
  // PWA icons do not, so the tile carries the radius itself
  const R = 14 * u;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const dx = Math.max(R - x, x - (N - R), 0);
      const dy = Math.max(R - y, y - (N - R), 0);
      if (dx * dx + dy * dy <= R * R) put(x, y, INK);
    }
  }
  // the orb: a gold ring with a solid gold core, concentric — the same object
  // MondayOrb draws, so the icon IS Monday's face rather than a separate logo
  const cx = 32 * u, cy = 32 * u;
  const rOuter = 20 * u, rInner = 15.2 * u, rCore = 8.4 * u;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const dx = x - cx + 0.5, dy = y - cy + 0.5;
      const d2 = dx * dx + dy * dy;
      const ring = d2 <= rOuter * rOuter && d2 >= rInner * rInner;
      const core = d2 <= rCore * rCore;
      if (ring || core) put(x, y, GOLD);
    }
  }
  // box downsample → antialiasing, including on the alpha channel
  const out = Buffer.alloc(S * S * 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * N + (x * SS + sx)) * 4;
          const al = hi[i + 3];
          r += hi[i] * al; g += hi[i + 1] * al; b += hi[i + 2] * al; a += al;
        }
      }
      const o = (y * S + x) * 4;
      if (a > 0) { out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a); }
      out[o + 3] = Math.round(a / (SS * SS));
    }
  }
  return out;
}

// ---- the macOS bundle icon ----
// Every size is DRAWN at its native resolution rather than downscaled from one
// master, so the 16pt ring is composed for 16pt instead of being a blurred 512.
const ICNS_SIZES = [16, 32, 64, 128, 256, 512, 1024];
const ICONSET = path.join(OUT, '..', '..', '..', '.monday.iconset');
fs.rmSync(ICONSET, { recursive: true, force: true });
fs.mkdirSync(ICONSET, { recursive: true });
for (const sz of ICNS_SIZES) {
  const buf = png(sz, sz, drawIcon(sz));
  // Apple's naming: icon_<pt>x<pt>.png and the @2x variant at double the pixels
  if (sz <= 512) fs.writeFileSync(path.join(ICONSET, `icon_${sz}x${sz}.png`), buf);
  if (sz >= 32) fs.writeFileSync(path.join(ICONSET, `icon_${sz / 2}x${sz / 2}@2x.png`), buf);
}
console.log('wrote iconset ->', ICONSET);

for (const [name, size] of [['icon-512.png', 512], ['icon-192.png', 192], ['apple-touch-icon.png', 180]]) {
  fs.writeFileSync(path.join(OUT, name), png(size, size, drawIcon(size)));
  console.log('wrote', name);
}

// The SVG is drawn from the same numbers, so the favicon and the PNGs cannot
// drift apart. currentColor is deliberately NOT used — the mark must stay gold
// on ink in a browser tab regardless of the surrounding theme.
const goldHex = HUE.brand.dark.fill;
const inkHex = NEUTRAL.light.ink;
fs.writeFileSync(
  path.join(OUT, 'favicon.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="Monday">` +
    `<rect width="64" height="64" rx="14" fill="${inkHex}"/>` +
    `<circle cx="32" cy="32" r="17.6" fill="none" stroke="${goldHex}" stroke-width="4.8"/>` +
    `<circle cx="32" cy="32" r="8.4" fill="${goldHex}"/>` +
    `</svg>\n`
);
console.log('wrote favicon.svg');

fs.writeFileSync(
  path.join(OUT, 'manifest.webmanifest'),
  JSON.stringify({
    name: 'Monday',
    short_name: 'Monday',
    description: 'Monday — the AI that runs the TMUA tutor',
    start_url: '/',
    display: 'standalone',
    background_color: NEUTRAL.light.bg,
    theme_color: NEUTRAL.light.bg,
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ],
  }, null, 2) + '\n'
);
console.log('wrote manifest.webmanifest');
