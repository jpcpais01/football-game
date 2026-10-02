// GameNight app icon: a pixel-art football under one floodlight at dusk.
// Draws a 32×32 grid, then writes the favicon SVG and the PWA PNGs from it.
// Run: node scripts/make-icon.mjs
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const N = 32;
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const bayer = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const dith = (x, y) => (bayer[(y % 4) * 4 + (x % 4)] + 0.5) / 16;

const SKY = ['#1a1240', '#26175a', '#3b1d68', '#5c2470', '#8a3170', '#bb4868', '#e2685a', '#f59a52', '#ffc46a'].map(hex);
const INK = hex('#170f2c');
const STAND = hex('#24183f');
const STAND_LIT = hex('#3a2752');
const GRASS = [hex('#2f7a3c'), hex('#3d9447')];
const LAMP = hex('#fffbe6');
const WARM = hex('#fff0bf');
const BALL = hex('#f7f3e8');
const BALL_SHADE = hex('#ddd6e8');
const BALL_DEEP = hex('#a99fc6');
const PATCH = hex('#2a2142');

const g = [];
for (let y = 0; y < N; y++) {
  g.push([]);
  for (let x = 0; x < N; x++) {
    // Sunset in dithered bands, darkest at the top.
    const t = (y / 24) * (SKY.length - 1);
    const i = Math.min(SKY.length - 2, Math.floor(t));
    g[y].push(t - i > dith(x, y) ? SKY[i + 1] : SKY[i]);
  }
}
const put = (x, y, c) => x >= 0 && y >= 0 && x < N && y < N && (g[y][x] = c);
const tint = (x, y, c, a) => x >= 0 && y >= 0 && x < N && y < N && (g[y][x] = mix(g[y][x], c, a));

// Stars in the dark sky.
for (const [x, y] of [[24, 2], [29, 4], [20, 5], [27, 8], [13, 2], [30, 1]]) put(x, y, hex('#e9e3ff'));

// The floodlight beam: a soft cone from the lamp down across the ball, dithered at the edge.
const lx = 6.5, ly = 4.5;
const ax = 16 - lx, ay = 18 - ly;
const al = Math.hypot(ax, ay);
for (let y = 5; y < 27; y++) {
  for (let x = 0; x < N; x++) {
    const dx = x + 0.5 - lx, dy = y + 0.5 - ly;
    const along = (dx * ax + dy * ay) / al;
    if (along <= 0) continue;
    const perp = Math.abs(dx * ay - dy * ax) / al;
    const w = 1.2 + along * 0.42;
    const k = 1 - perp / w;
    if (k > 0) tint(x, y, WARM, k > dith(x, y) * 0.7 ? 0.22 + 0.18 * k : 0.1);
  }
}

// Stadium: roofline silhouette, a lit band where the beam lands, then the pitch.
for (let x = 0; x < N; x++) {
  const roof = 24 + (x % 9 < 2 ? -1 : 0);
  for (let y = roof; y < 28; y++) put(x, y, y === 26 && x > 9 && x < 24 ? STAND_LIT : STAND);
  for (let y = 28; y < N; y++) put(x, y, GRASS[(Math.floor((x + (y - 28) * 2) / 4)) % 2]);
}
for (let x = 11; x < 22; x++) tint(x, 28, WARM, 0.35); // light pool on the grass

// Pylon: mast and the lamp head with a halo.
for (let y = 6; y < 26; y++) put(4, y, INK), put(5, y, y % 3 === 0 ? INK : STAND);
for (let y = 3; y < 6; y++) for (let x = 3; x < 9; x++) put(x, y, (x + y) % 2 ? LAMP : WARM);
for (let x = 2; x < 10; x++) put(x, 2, INK), put(x, 6, INK);
put(2, 3, INK), put(2, 4, INK), put(2, 5, INK), put(9, 3, INK), put(9, 4, INK), put(9, 5, INK);
for (const [x, y, a] of [[1, 4, 0.5], [10, 4, 0.5], [5, 1, 0.45], [6, 1, 0.45], [11, 4, 0.25], [10, 7, 0.3], [11, 8, 0.2]]) tint(x, y, WARM, a);

// The ball, lit from the top-left, with a glow ring and its shadow on the grass.
const cx = 16, cy = 17.5, R = 6.6;
for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
    if (d > R && d < R + 2.2 && y < 27) tint(x, y, WARM, (1 - (d - R) / 2.2) * 0.45 > dith(x, y) * 0.5 ? 0.4 : 0.15);
  }
}
for (let x = 12; x < 21; x++) put(x, 29, mix(GRASS[0], INK, 0.55));
for (let x = 13; x < 20; x++) put(x, 30, mix(GRASS[1], INK, 0.3));
const patches = [[16, 17.5, 2.1], [11.4, 15.2, 1.5], [20.6, 15.2, 1.5], [12.6, 21.9, 1.5], [19.4, 21.9, 1.5]];
for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    const px = x + 0.5, py = y + 0.5;
    const d = Math.hypot(px - cx, py - cy);
    if (d > R) continue;
    if (d > R - 1) { put(x, y, INK); continue; }
    // Lambert-ish shade from the floodlight direction.
    const nz = Math.sqrt(Math.max(0, 1 - (d / R) ** 2));
    const lit = (-(px - cx) / R) * 0.55 + (-(py - cy) / R) * 0.65 + nz * 0.55;
    let c = lit > 0.45 ? BALL : lit > 0.08 + dith(x, y) * 0.12 ? BALL_SHADE : BALL_DEEP;
    for (const [qx, qy, r] of patches) if (Math.hypot(px - qx, py - qy) < r) c = lit > 0.45 ? mix(PATCH, BALL_SHADE, 0.25) : PATCH;
    put(x, y, c);
  }
}
put(13, 13, [255, 255, 255]), put(14, 13, [255, 255, 255]), put(13, 14, [255, 255, 255]); // specular

// ---- output
const toHex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}" shape-rendering="crispEdges">`;
for (let y = 0; y < N; y++) {
  // Merge horizontal runs of the same colour to keep the file small.
  for (let x = 0; x < N; ) {
    const c = toHex(g[y][x]);
    let w = 1;
    while (x + w < N && toHex(g[y][x + w]) === c) w++;
    svg += `<rect x="${x}" y="${y}" width="${w}" height="1.02" fill="${c}"/>`;
    x += w;
  }
}
writeFileSync('public/icons/icon.svg', svg + '</svg>');

const crcT = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (b) => {
  let c = 0xffffffff;
  for (const v of b) c = crcT[(c ^ v) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
/** size px; `inset` scales the art into the centre (maskable safe zone), edges extend. */
function png(file, size, inset = 0) {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  const art = size * (1 - inset * 2);
  const off = size * inset;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    const gy = Math.min(N - 1, Math.max(0, Math.floor(((y - off) / art) * N)));
    for (let x = 0; x < size; x++) {
      const gx = Math.min(N - 1, Math.max(0, Math.floor(((x - off) / art) * N)));
      raw.set(g[gy][gx], y * (size * 3 + 1) + 1 + x * 3);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}
png('public/icons/icon-192.png', 192);
png('public/icons/icon-512.png', 512);
png('public/icons/apple-touch-icon.png', 180);
png('public/icons/icon-maskable-512.png', 512, 0.1);
