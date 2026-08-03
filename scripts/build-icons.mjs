#!/usr/bin/env node
/**
 * Generates the Stead app icon from vector source.
 *
 * The mark: a ring broken by a gap, with a solid bead standing in the gap.
 * The ring is the meeting; the gap is you, absent; the bead is your agent
 * holding your place. The circle only closes because something stands in for
 * you — which is the product in one shape.
 *
 * The geometry below is the source of truth, not a binary. Everything
 * downstream is generated from it:
 *
 *   brand/icon.svg                    full-bleed tile (Windows, Linux, web)
 *   brand/icon-mac.svg                inset on the macOS icon grid, with shadow
 *   brand/mark.svg                    the bare mark on transparency, for chrome
 *   packages/desktop/build/icon.png   1024 master, and Linux
 *   packages/desktop/build/icon.icns  macOS, 10 representations
 *   packages/desktop/build/icon.ico   Windows, 7 representations
 *
 * The raster outputs live in the desktop package's `build/` because that is
 * electron-builder's default buildResources directory for that project.
 *
 *   npm run icons
 *
 * PNGs are rasterised here rather than shelled out to a browser or ImageMagick,
 * so the only requirement is Node. Each size is rendered from the geometry at
 * its native resolution — nothing is downsampled — which keeps the 16px ring
 * from turning to mush. `.icns` packing uses iconutil and so needs macOS; the
 * other outputs build anywhere.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import zlib from 'node:zlib';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const brandDir = path.join(root, 'brand');
const buildDir = path.join(root, 'packages', 'desktop', 'build');

// --- palette -----------------------------------------------------------------
// Taken from the app's own tokens in packages/desktop/src/styles.css, so the
// icon and the window it launches read as the same object.

const INK_TOP = [0x1c, 0x25, 0x36];
const INK_BOTTOM = [0x0b, 0x0e, 0x14];
const RING = [0xee, 0xf1, 0xf8];
const BEAD_TOP = [0x8f, 0xc2, 0xff];
const BEAD_BOTTOM = [0x4f, 0x8e, 0xf0];

const hex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');

// --- geometry ----------------------------------------------------------------

/**
 * The mark, sized to a tile of side `s` and centred on (cx, cy).
 *
 * The gap is not a fixed angle. It is solved from the bead radius so the ring's
 * round caps clear the bead by the same optical margin at every scale.
 */
function geometry(s, cx, cy) {
  const r = s * 0.245; // ring radius
  const w = s * 0.084; // ring stroke
  const bead = s * 0.072; // bead radius
  const clearance = s * 0.04; // breathing room either side of the bead

  // Chord from the bead's centre to each cap centre, and the angle it subtends:
  // 2r·sin(θ/2) = chord.
  const half = Math.asin(Math.min(1, (bead + w / 2 + clearance) / (2 * r)));

  // The bead reaches further right than the ring does, so true centring leaves
  // the mark looking pushed right. Shift by half the overhang to balance it.
  const overhang = bead - w / 2;
  const x = cx - overhang / 2;

  return { cx: x, cy, r, w, bead, half, bx: x + r, by: cy };
}

/** Tight bounding box of the drawn mark, caps and bead included. */
function markBounds(g) {
  const right = Math.max(g.bx + g.bead, g.cx + g.r * Math.cos(g.half) + g.w / 2);
  return {
    minX: g.cx - g.r - g.w / 2,
    maxX: right,
    minY: g.cy - g.r - g.w / 2,
    maxY: g.cy + g.r + g.w / 2,
  };
}

// --- signed distance fields --------------------------------------------------
// Negative inside the shape. Coverage comes from supersampling, so these only
// need a sign; the soft shadow and the glow use their distance continuously.

function sdRoundedRect(px, py, cx, cy, halfW, halfH, radius) {
  const qx = Math.abs(px - cx) - (halfW - radius);
  const qy = Math.abs(py - cy) - (halfH - radius);
  return (
    Math.min(Math.max(qx, qy), 0) +
    Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) -
    radius
  );
}

/**
 * A circular arc of radius r centred on (cx, cy), missing the wedge within
 * ±half of angle 0, stroked to width w with round caps.
 */
function sdArc(px, py, g) {
  const dx = px - g.cx;
  const dy = py - g.cy;
  const angle = Math.atan2(dy, dx);

  if (Math.abs(angle) >= g.half) {
    // Inside the drawn sweep: distance to the ring's centreline.
    return Math.abs(Math.hypot(dx, dy) - g.r) - g.w / 2;
  }
  // In the gap: distance to whichever round cap is nearer.
  const capAngle = angle >= 0 ? g.half : -g.half;
  const capX = g.cx + g.r * Math.cos(capAngle);
  const capY = g.cy + g.r * Math.sin(capAngle);
  return Math.hypot(px - capX, py - capY) - g.w / 2;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function lerp(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Straight-alpha "source over" compositing, in place on `dst`. */
function over(dst, rgb, alpha) {
  if (alpha <= 0) return;
  const a = clamp01(alpha);
  const outA = a + dst[3] * (1 - a);
  if (outA <= 0) {
    dst[0] = dst[1] = dst[2] = dst[3] = 0;
    return;
  }
  for (let i = 0; i < 3; i++) {
    dst[i] = (rgb[i] * a + dst[i] * dst[3] * (1 - a)) / outA;
  }
  dst[3] = outA;
}

// --- rasteriser --------------------------------------------------------------

/**
 * Renders the icon at `size` square as straight-alpha RGBA bytes.
 *
 * `inset` follows the macOS icon grid: the tile occupies the centre 80.5% of
 * the canvas and casts a soft shadow. Otherwise the tile is full-bleed.
 */
function render(size, { inset, samples }) {
  const side = inset ? size * 0.8047 : size;
  const half = side / 2;
  const cx = size / 2;
  const cy = size / 2;
  const radius = side * 0.225;

  const g = geometry(side, cx, cy);
  const tileTop = cy - half;

  // Shadow: offset down, and softened over a band rather than blurred, which
  // for a convex shape is visually the same thing and far cheaper.
  const shadowDy = size * 0.012;
  const shadowBlur = size * 0.028;

  const glowRadius = g.bead * 2.9;
  const px = new Uint8Array(size * size * 4);
  const step = 1 / samples;
  const offset = step / 2;
  const weight = 1 / (samples * samples);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let ar = 0;
      let ag = 0;
      let ab = 0;
      let aa = 0;

      for (let sy = 0; sy < samples; sy++) {
        const py = y + offset + sy * step;
        for (let sx = 0; sx < samples; sx++) {
          const pxx = x + offset + sx * step;
          const c = [0, 0, 0, 0];

          if (inset) {
            const d = sdRoundedRect(pxx, py - shadowDy, cx, cy, half, half, radius);
            over(c, [0, 0, 0], 0.34 * clamp01(-d / shadowBlur));
          }

          const dTile = sdRoundedRect(pxx, py, cx, cy, half, half, radius);
          if (dTile < 0) {
            const t = clamp01((py - tileTop) / side);
            over(c, lerp(INK_TOP, INK_BOTTOM, t), 1);
            // Sheen: a light fall across the top face.
            over(c, [255, 255, 255], 0.1 * (1 - clamp01(t / 0.5)) + 0.02);
            // Hairline: catches the edge the way a physical bevel would.
            if (dTile > -1.5 * (size / 1024) - 0.5) over(c, [255, 255, 255], 0.07);
          }

          // Glow behind the bead, so it sits in the gap rather than on it.
          const dGlow = Math.hypot(pxx - g.bx, py - g.by);
          if (dGlow < glowRadius && dTile < 0) {
            const t = dGlow / glowRadius;
            over(c, BEAD_TOP, t < 0.55 ? 0.34 - (t / 0.55) * 0.25 : 0.09 * (1 - (t - 0.55) / 0.45));
          }

          if (sdArc(pxx, py, g) < 0) over(c, RING, 1);

          const dBead = Math.hypot(pxx - g.bx, py - g.by);
          if (dBead < g.bead) {
            over(c, lerp(BEAD_TOP, BEAD_BOTTOM, clamp01((py - (g.by - g.bead)) / (g.bead * 2))), 1);
          }

          ar += c[0] * c[3] * weight;
          ag += c[1] * c[3] * weight;
          ab += c[2] * c[3] * weight;
          aa += c[3] * weight;
        }
      }

      const i = (y * size + x) * 4;
      if (aa > 0) {
        px[i] = Math.round(clamp01(ar / aa / 255) * 255);
        px[i + 1] = Math.round(clamp01(ag / aa / 255) * 255);
        px[i + 2] = Math.round(clamp01(ab / aa / 255) * 255);
      }
      px[i + 3] = Math.round(clamp01(aa) * 255);
    }
  }

  return px;
}

// --- PNG ---------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function encodePng(rgba, size) {
  const stride = size * 4;
  // One filter byte per scanline. Filter 0 (none) compresses fine here and
  // keeps this honest and simple.
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(
      raw,
      y * (stride + 1) + 1,
    );
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- SVG ---------------------------------------------------------------------
// The same geometry, emitted as vector for design tools, the README and the web.

function markPath(g) {
  const n = (v) => Number(v.toFixed(2));
  const p = (a) => [g.cx + g.r * Math.cos(a), g.cy + g.r * Math.sin(a)];
  const [x1, y1] = p(-g.half);
  const [x2, y2] = p(g.half);
  // large-arc=1, sweep=0: the long way round, anticlockwise through the left,
  // leaving the gap on the right.
  return `M ${n(x1)} ${n(y1)} A ${n(g.r)} ${n(g.r)} 0 1 0 ${n(x2)} ${n(y2)}`;
}

function tileSvg({ canvas = 1024, inset = false } = {}) {
  const side = inset ? canvas * 0.8047 : canvas;
  const off = (canvas - side) / 2;
  const radius = side * 0.225;
  const g = geometry(side, canvas / 2, canvas / 2);
  const n = (v) => Number(v.toFixed(2));
  const id = inset ? 'm' : 's';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas}" height="${canvas}" viewBox="0 0 ${canvas} ${canvas}">
  <defs>
    <linearGradient id="ink-${id}" x1="0" y1="${n(off)}" x2="0" y2="${n(off + side)}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${hex(INK_TOP)}"/><stop offset="1" stop-color="${hex(INK_BOTTOM)}"/>
    </linearGradient>
    <linearGradient id="sheen-${id}" x1="0" y1="${n(off)}" x2="0" y2="${n(off + side)}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#fff" stop-opacity="0.12"/><stop offset="0.5" stop-color="#fff" stop-opacity="0.02"/><stop offset="1" stop-color="#fff" stop-opacity="0.02"/>
    </linearGradient>
    <linearGradient id="bead-${id}" x1="0" y1="${n(g.by - g.bead)}" x2="0" y2="${n(g.by + g.bead)}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${hex(BEAD_TOP)}"/><stop offset="1" stop-color="${hex(BEAD_BOTTOM)}"/>
    </linearGradient>
    <radialGradient id="glow-${id}">
      <stop offset="0" stop-color="${hex(BEAD_TOP)}" stop-opacity="0.34"/>
      <stop offset="0.55" stop-color="${hex(BEAD_TOP)}" stop-opacity="0.09"/>
      <stop offset="1" stop-color="${hex(BEAD_TOP)}" stop-opacity="0"/>
    </radialGradient>
    <clipPath id="tile-${id}"><rect x="${n(off)}" y="${n(off)}" width="${n(side)}" height="${n(side)}" rx="${n(radius)}"/></clipPath>
${
  inset
    ? `    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="${n(canvas * 0.012)}" stdDeviation="${n(canvas * 0.014)}" flood-color="#000" flood-opacity="0.34"/>
    </filter>\n`
    : ''
}  </defs>
  <g${inset ? ' filter="url(#shadow)"' : ''}>
    <rect x="${n(off)}" y="${n(off)}" width="${n(side)}" height="${n(side)}" rx="${n(radius)}" fill="url(#ink-${id})"/>
    <rect x="${n(off)}" y="${n(off)}" width="${n(side)}" height="${n(side)}" rx="${n(radius)}" fill="url(#sheen-${id})"/>
  </g>
  <g clip-path="url(#tile-${id})">
    <circle cx="${n(g.bx)}" cy="${n(g.by)}" r="${n(g.bead * 2.9)}" fill="url(#glow-${id})"/>
  </g>
  <rect x="${n(off + 0.75)}" y="${n(off + 0.75)}" width="${n(side - 1.5)}" height="${n(side - 1.5)}" rx="${n(radius - 0.75)}" fill="none" stroke="#fff" stroke-opacity="0.07" stroke-width="1.5"/>
  <path d="${markPath(g)}" fill="none" stroke="${hex(RING)}" stroke-width="${n(g.w)}" stroke-linecap="round"/>
  <circle cx="${n(g.bx)}" cy="${n(g.by)}" r="${n(g.bead)}" fill="url(#bead-${id})"/>
</svg>
`;
}

/** The bare mark on transparency, bounding-box centred, for app chrome. */
function markSvg({ box = 128, pad = 0.07 } = {}) {
  const g = geometry(100, 0, 0);
  const b = markBounds(g);
  const padding = Math.max(b.maxX - b.minX, b.maxY - b.minY) * pad;
  const minX = b.minX - padding;
  const minY = b.minY - padding;
  const w = b.maxX - b.minX + padding * 2;
  const h = b.maxY - b.minY + padding * 2;
  const extent = Math.max(w, h);
  const n = (v) => Number(v.toFixed(2));

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${box}" height="${box}" viewBox="${n(minX - (extent - w) / 2)} ${n(minY - (extent - h) / 2)} ${n(extent)} ${n(extent)}">
  <defs>
    <linearGradient id="bead-k" x1="0" y1="${n(g.by - g.bead)}" x2="0" y2="${n(g.by + g.bead)}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${hex(BEAD_TOP)}"/><stop offset="1" stop-color="${hex(BEAD_BOTTOM)}"/>
    </linearGradient>
  </defs>
  <path d="${markPath(g)}" fill="none" stroke="currentColor" stroke-width="${n(g.w)}" stroke-linecap="round"/>
  <circle cx="${n(g.bx)}" cy="${n(g.by)}" r="${n(g.bead)}" fill="url(#bead-k)"/>
</svg>
`;
}

// --- ICO ---------------------------------------------------------------------

/**
 * Packs PNGs into an ICO. Windows has accepted PNG-compressed entries since
 * Vista, which keeps this to a header and a directory rather than a stack of
 * hand-rolled BMPs with their upside-down rows and AND masks.
 */
function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(images.length, 4);

  const dir = Buffer.alloc(16 * images.length);
  let offset = header.length + dir.length;

  images.forEach((image, i) => {
    const at = i * 16;
    dir.writeUInt8(image.size >= 256 ? 0 : image.size, at); // 0 encodes 256
    dir.writeUInt8(image.size >= 256 ? 0 : image.size, at + 1);
    dir.writeUInt8(0, at + 2); // palette entries
    dir.writeUInt8(0, at + 3); // reserved
    dir.writeUInt16LE(1, at + 4); // colour planes
    dir.writeUInt16LE(32, at + 6); // bits per pixel
    dir.writeUInt32LE(image.data.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += image.data.length;
  });

  return Buffer.concat([header, dir, ...images.map((i) => i.data)]);
}

/** Read the container back, so a malformed icon fails here and not in NSIS. */
function verifyIco(buf, expected) {
  if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) throw new Error('bad ICO header');
  const count = buf.readUInt16LE(4);
  if (count !== expected) throw new Error(`ICO declares ${count} images, expected ${expected}`);
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 16;
    const bytes = buf.readUInt32LE(at + 8);
    const offset = buf.readUInt32LE(at + 12);
    if (offset + bytes > buf.length) throw new Error(`ICO entry ${i} runs past end of file`);
    if (buf.subarray(offset, offset + 8).toString('hex') !== '89504e470d0a1a0a') {
      throw new Error(`ICO entry ${i} is not a PNG`);
    }
  }
}

// --- build -------------------------------------------------------------------

const ICNS_SIZES = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
];

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

/** Small icons get more samples per pixel; they need it and can afford it. */
const samplesFor = (size) => (size <= 64 ? 8 : size <= 256 ? 6 : 4);

const cache = new Map();
function png(size, inset) {
  const key = `${size}:${inset}`;
  let hit = cache.get(key);
  if (!hit) {
    hit = encodePng(render(size, { inset, samples: samplesFor(size) }), size);
    cache.set(key, hit);
  }
  return hit;
}

async function main() {
  await fs.mkdir(brandDir, { recursive: true });
  await fs.mkdir(buildDir, { recursive: true });

  await fs.writeFile(path.join(brandDir, 'icon.svg'), tileSvg({ inset: false }), 'utf8');
  await fs.writeFile(path.join(brandDir, 'icon-mac.svg'), tileSvg({ inset: true }), 'utf8');
  await fs.writeFile(path.join(brandDir, 'mark.svg'), markSvg(), 'utf8');
  console.log('brand/  icon.svg, icon-mac.svg, mark.svg');

  await fs.writeFile(path.join(buildDir, 'icon.png'), png(1024, false));
  console.log('build/  icon.png       1024, full-bleed');

  if (process.platform === 'darwin') {
    const iconset = path.join(buildDir, 'icon.iconset');
    await fs.rm(iconset, { recursive: true, force: true });
    await fs.mkdir(iconset, { recursive: true });
    for (const [name, size] of ICNS_SIZES) {
      await fs.writeFile(path.join(iconset, name), png(size, true));
    }
    await run('/usr/bin/iconutil', [
      '-c',
      'icns',
      iconset,
      '-o',
      path.join(buildDir, 'icon.icns'),
    ]);
    await fs.rm(iconset, { recursive: true, force: true });
    console.log(`build/  icon.icns      ${ICNS_SIZES.length} representations`);
  } else {
    console.log('build/  icon.icns      skipped — packing needs macOS (iconutil)');
  }

  const ico = encodeIco(ICO_SIZES.map((size) => ({ size, data: png(size, false) })));
  verifyIco(ico, ICO_SIZES.length);
  await fs.writeFile(path.join(buildDir, 'icon.ico'), ico);
  console.log(`build/  icon.ico       ${ICO_SIZES.join(', ')}`);

  // A contact sheet to eyeball the mark at the sizes that actually ship.
  if (process.env.STEAD_ICON_PREVIEW) {
    const dir = path.join(os.tmpdir(), 'stead-icon-preview');
    await fs.mkdir(dir, { recursive: true });
    for (const size of [16, 32, 64, 128, 256, 512]) {
      await fs.writeFile(path.join(dir, `mac-${size}.png`), png(size, true));
      await fs.writeFile(path.join(dir, `square-${size}.png`), png(size, false));
    }
    console.log(`preview ${dir}`);
  }
}

main().catch((err) => {
  console.error(`\nIcon build failed: ${err.message}`);
  process.exit(1);
});
