'use strict';
/**
 * Rasterises build/icon.svg into build/icon.png (512x512), the one file the
 * installer, taskbar, tray and app header all use, so they can't disagree.
 * The SVG is the source: edit that, then run
 *
 *   node scripts/make-icon.js
 *
 * Dependency-free, so it only understands what the icon is made of: <rect>
 * elements with solid #rrggbb fills and an optional rx, painted in document
 * order. Anything else in the SVG is an error rather than a silently missing
 * shape. If the mark ever needs curves, swap this for a real rasteriser.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 512;
const SS = 3; // supersampling factor per axis, for smooth edges

const buildDir = path.join(__dirname, '..', 'build');
const svgFile = path.join(buildDir, 'icon.svg');

// --- PNG encoding ---------------------------------------------------------

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
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // Each scanline is prefixed with its filter type (0 = none).
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- reading the SVG ------------------------------------------------------

/** The SVG's rects, scaled from its viewBox to SIZE, in paint order. */
function readShapes(file) {
  const svg = fs.readFileSync(file, 'utf8');

  const viewBox = /viewBox="([^"]+)"/.exec(svg);
  if (!viewBox) throw new Error(`${file} has no viewBox.`);
  const [, , vbW, vbH] = viewBox[1]
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (vbW !== vbH) throw new Error(`${file} must be square, not ${vbW}x${vbH}.`);
  const scale = SIZE / vbW;

  // Comments go first, so a commented-out shape isn't drawn.
  const body = svg.replace(/<!--[\s\S]*?-->/g, '');
  const shapes = [];
  for (const [, tag, attrText] of body.matchAll(/<(\w+)\b([^>]*)>/g)) {
    if (tag === 'svg') continue;
    if (tag !== 'rect')
      throw new Error(`make-icon only draws <rect>, but ${file} has <${tag}>.`);

    const a = Object.fromEntries(
      [...attrText.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]])
    );
    if (a.transform) throw new Error(`make-icon can't apply transform="${a.transform}".`);
    const fill = /^#([0-9a-f]{6})$/i.exec(a.fill || '');
    if (!fill) throw new Error(`Every <rect> needs a #rrggbb fill, not "${a.fill}".`);

    const x = Number(a.x || 0) * scale;
    const y = Number(a.y || 0) * scale;
    const w = Number(a.width) * scale;
    const h = Number(a.height) * scale;
    shapes.push({
      cx: x + w / 2,
      cy: y + h / 2,
      halfW: w / 2,
      halfH: h / 2,
      r: Math.min(Number(a.rx || 0) * scale, w / 2, h / 2),
      rgb: [0, 2, 4].map((i) => parseInt(fill[1].slice(i, i + 2), 16)),
    });
  }
  if (!shapes.length) throw new Error(`${file} has no <rect> to draw.`);
  return shapes;
}

// --- shape maths ----------------------------------------------------------

/** Signed distance to a rounded rectangle centred at (cx, cy). */
function roundedRectSdf(px, py, cx, cy, halfW, halfH, r) {
  const qx = Math.abs(px - cx) - (halfW - r);
  const qy = Math.abs(py - cy) - (halfH - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(qx, qy), 0) - r;
}

// --- draw -----------------------------------------------------------------

const SHAPES = readShapes(svgFile);

function sample(x, y) {
  // Returns [r,g,b,a] at a point in 0..SIZE space. Later rects cover earlier
  // ones, as in the SVG; outside every rect is transparent.
  let rgb = null;
  for (const s of SHAPES) {
    if (roundedRectSdf(x, y, s.cx, s.cy, s.halfW, s.halfH, s.r) <= 0) rgb = s.rgb;
  }
  return rgb ? [rgb[0], rgb[1], rgb[2], 255] : [0, 0, 0, 0];
}

function render() {
  const rgba = Buffer.alloc(SIZE * SIZE * 4);
  const step = 1 / SS;
  const offset = step / 2;

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const [sr, sg, sb, sa] = sample(x + sx * step + offset, y + sy * step + offset);
          const w = sa / 255;
          r += sr * w;
          g += sg * w;
          b += sb * w;
          a += sa;
        }
      }
      const n = SS * SS;
      const alpha = a / n;
      // Un-premultiply so edge pixels keep their colour.
      const wsum = a / 255 || 1;
      const i = (y * SIZE + x) * 4;
      rgba[i] = Math.round(r / wsum);
      rgba[i + 1] = Math.round(g / wsum);
      rgba[i + 2] = Math.round(b / wsum);
      rgba[i + 3] = Math.round(alpha);
    }
  }
  return rgba;
}

const outFile = path.join(buildDir, 'icon.png');
fs.writeFileSync(outFile, encodePng(SIZE, SIZE, render()));
console.log(
  `Wrote ${outFile} from icon.svg (${SIZE}x${SIZE}, ${fs.statSync(outFile).size} bytes)`
);
