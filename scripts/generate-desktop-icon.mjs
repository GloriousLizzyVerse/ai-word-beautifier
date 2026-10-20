// Generates desktop/build/icon.png + icon.ico without external dependencies.
// Renders an indigo rounded square with a white "W" (matches the web app logo).
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 256;
const SS = 4; // supersample factor for antialiasing
const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'desktop', 'build');

const BG = [79, 70, 229]; // #4f46e5
const FG = [255, 255, 255];

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy || 1;
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function roundedRectInside(x, y, w, h, r) {
  // true when the point is inside the rounded rect defined in [0,1] space
  const px = Math.max(x - r, 0) + Math.max(x - (w - r), 0);
  const py = Math.max(y - r, 0) + Math.max(y - (h - r), 0);
  const dx = Math.max(r - x, 0, x - (w - r));
  const dy = Math.max(r - y, 0, y - (h - r));
  const cornerDx = x < r ? r - x : x > w - r ? x - (w - r) : 0;
  const cornerDy = y < r ? r - y : y > h - r ? y - (h - r) : 0;
  void px; void py; void dx; void dy;
  if (Math.hypot(cornerDx, cornerDy) > r) return false;
  return true;
}

const W_POINTS = [
  [0.20, 0.28],
  [0.33, 0.72],
  [0.50, 0.44],
  [0.67, 0.72],
  [0.80, 0.28],
];
const STROKE = 0.075;

function renderPixel(fx, fy) {
  const inside = roundedRectInside(fx, fy, 1, 1, 0.22);
  if (!inside) return null;
  let minDist = Infinity;
  for (let i = 0; i < W_POINTS.length - 1; i += 1) {
    const [ax, ay] = W_POINTS[i];
    const [bx, by] = W_POINTS[i + 1];
    minDist = Math.min(minDist, distToSegment(fx, fy, ax, ay, bx, by));
  }
  const coverage = 1 - Math.min(1, Math.max(0, (minDist - STROKE / 2) / (1.5 / SIZE)));
  if (coverage <= 0) return [...BG, 255];
  const a = coverage;
  return [
    Math.round(FG[0] * a + BG[0] * (1 - a)),
    Math.round(FG[1] * a + BG[1] * (1 - a)),
    Math.round(FG[2] * a + BG[2] * (1 - a)),
    255,
  ];
}

const grid = SIZE * SS;
const pixels = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y += 1) {
  for (let x = 0; x < SIZE; x += 1) {
    let r = 0, g = 0, b = 0, a = 0, count = 0;
    for (let sy = 0; sy < SS; sy += 1) {
      for (let sx = 0; sx < SS; sx += 1) {
        const fx = (x * SS + sx + 0.5) / grid;
        const fy = (y * SS + sy + 0.5) / grid;
        const c = renderPixel(fx, fy);
        if (!c) { count += 1; continue; }
        r += c[0]; g += c[1]; b += c[2]; a += c[3]; count += 1;
      }
    }
    const idx = (y * SIZE + x) * 4;
    pixels[idx] = Math.round(r / count);
    pixels[idx + 1] = Math.round(g / count);
    pixels[idx + 2] = Math.round(b / count);
    pixels[idx + 3] = Math.round(a / count);
  }
}

const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([length, typeBuf, data, crcBuf]);
}

function encodePng(rgba, width, height) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function encodeIco(pngBuffer) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry[0] = 0; // width: 0 means 256
  entry[1] = 0; // height: 0 means 256
  entry[2] = 0; // palette
  entry[3] = 0;
  entry.writeUInt16LE(1, 4); // color planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32BE(0, 8);
  entry.writeUInt32LE(pngBuffer.length, 8);
  entry.writeUInt32LE(22, 12);
  return Buffer.concat([header, entry, pngBuffer]);
}

mkdirSync(OUT_DIR, { recursive: true });
const png = encodePng(pixels, SIZE, SIZE);
writeFileSync(resolve(OUT_DIR, 'icon.png'), png);
writeFileSync(resolve(OUT_DIR, 'icon.ico'), encodeIco(png));
console.log('icon written:', OUT_DIR, `${png.length} bytes png`);
