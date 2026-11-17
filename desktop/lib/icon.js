"use strict";
// The app icon, drawn in code (no image tools, no fonts): a dark rounded tile; on it a paper page with lines of
// text, one line highlighted, a red margin line, and a small yellow card in the margin beside the highlight.
// render(size) → RGBA pixels (anti-aliased with signed distances); encodePng(size, rgba) → PNG bytes.
// scripts/build.js (makeIcon, step 4) writes the macOS iconset from these and runs iconutil.
const zlib = require("node:zlib");

const COLORS = {
  tileTop: [0x3a, 0x35, 0x2f], tileBottom: [0x22, 0x1f, 0x1b],   // warm dark, like the app's dark theme
  paper: [0xfb, 0xf9, 0xf4], text: [0xd3, 0xcb, 0xbb], highlight: [0xff, 0xe6, 0x6d],
  margin: [0xe0, 0x4a, 0x2f],                                      // --accent
  card: [0xff, 0xe6, 0x6d], cardEdge: [0xd9, 0xb0, 0x1c], cardText: [0x8a, 0x6d, 0x1a]
};

// Signed distance from (px, py) to a rounded rectangle, in the 1024-unit design space (negative inside).
function sdRoundRect(px, py, x0, y0, x1, y1, r) {
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, hx = (x1 - x0) / 2 - r, hy = (y1 - y0) / 2 - r;
  const qx = Math.abs(px - cx) - hx, qy = Math.abs(py - cy) - hy;
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
  return Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(qx, qy), 0) - r;
}

function shapes(size) {
  const small = size <= 32;
  const list = [];
  const rect = (x0, y0, x1, y1, r, color, alpha) => list.push({ kind: "rect", x0, y0, x1, y1, r, color, alpha: alpha === undefined ? 1 : alpha });
  const shadow = (x0, y0, x1, y1, r, blur, alpha) => list.push({ kind: "shadow", x0, y0, x1, y1, r, blur, alpha });
  // tile (the macOS icon grid: 824 of 1024, corner radius about 185) and its shadow
  shadow(100, 112, 924, 936, 185, 22, 0.35);
  list.push({ kind: "tile", x0: 100, y0: 100, x1: 924, y1: 924, r: 185 });
  // the page
  shadow(232, 196, 792, 842, 22, 18, 0.45);
  rect(232, 188, 792, 834, 22, COLORS.paper);
  // lines of text (fewer and thicker when the icon is tiny), one of them highlighted
  const lines = small ? [[282, 560], [366, 520], [450, 560], [534, 470], [618, 545], [702, 500]]
                      : [[270, 572], [322, 548], [374, 566], [426, 520], [478, 570], [530, 556], [582, 498], [634, 566], [686, 540], [738, 452]];
  const h = small ? 34 : 20;
  const hlIndex = small ? 2 : 4;
  lines.forEach(([y, x1], i) => {
    if (i === hlIndex) rect(272, y - (small ? 14 : 12), x1 + 12, y + h + (small ? 14 : 12), 8, COLORS.highlight, 0.95);
    rect(284, y, x1, y + h, h / 2, COLORS.text);
  });
  // the margin line and the card beside the highlighted line
  rect(616, 188, 626, 834, 0, COLORS.margin);
  const hy = lines[hlIndex][0] + h / 2;
  rect(646, hy - 62, 772, hy + 62, 16, COLORS.cardEdge);
  rect(652, hy - 56, 766, hy + 56, 12, COLORS.card);
  if (!small) {
    rect(670, hy - 30, 748, hy - 18, 6, COLORS.cardText, 0.55);
    rect(670, hy - 6, 736, hy + 6, 6, COLORS.cardText, 0.55);
    rect(670, hy + 18, 722, hy + 30, 6, COLORS.cardText, 0.55);
  }
  return list;
}

function render(size) {
  const px = new Float32Array(size * size * 4);   // premultiplied RGBA, 0..1
  const k = 1024 / size;                          // design units per pixel
  const list = shapes(size);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const x = (i + 0.5) * k, y = (j + 0.5) * k;
      const o = (j * size + i) * 4;
      for (const s of list) {
        let a, c;
        if (s.kind === "shadow") {
          const d = sdRoundRect(x, y, s.x0, s.y0, s.x1, s.y1, s.r);
          const t = Math.min(Math.max((d + s.blur) / (2 * s.blur), 0), 1);
          a = s.alpha * (1 - t * t * (3 - 2 * t));
          c = [0, 0, 0];
        } else {
          const d = sdRoundRect(x, y, s.x0, s.y0, s.x1, s.y1, s.r) / k;    // in pixels
          a = Math.min(Math.max(0.5 - d, 0), 1);
          if (s.kind === "tile") {
            const t = Math.min(Math.max((y - s.y0) / (s.y1 - s.y0), 0), 1);
            c = COLORS.tileTop.map((v, n) => v + (COLORS.tileBottom[n] - v) * t);
          } else {
            c = s.color;
            a *= s.alpha;
          }
        }
        if (a <= 0) continue;
        // "over", premultiplied
        px[o] = (c[0] / 255) * a + px[o] * (1 - a);
        px[o + 1] = (c[1] / 255) * a + px[o + 1] * (1 - a);
        px[o + 2] = (c[2] / 255) * a + px[o + 2] * (1 - a);
        px[o + 3] = a + px[o + 3] * (1 - a);
      }
    }
  }
  const out = Buffer.alloc(size * size * 4);
  for (let p = 0; p < size * size; p++) {
    const a = px[p * 4 + 3];
    for (let n = 0; n < 3; n++) out[p * 4 + n] = a > 0 ? Math.round(Math.min(px[p * 4 + n] / a, 1) * 255) : 0;
    out[p * 4 + 3] = Math.round(Math.min(a, 1) * 255);
  }
  return out;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;   // 8-bit RGBA, no interlace
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;                                       // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

// The files of a macOS .iconset: [name, pixel size].
const ICONSET = Object.freeze([
  ["icon_16x16.png", 16], ["icon_16x16@2x.png", 32], ["icon_32x32.png", 32], ["icon_32x32@2x.png", 64],
  ["icon_128x128.png", 128], ["icon_128x128@2x.png", 256], ["icon_256x256.png", 256], ["icon_256x256@2x.png", 512],
  ["icon_512x512.png", 512], ["icon_512x512@2x.png", 1024]
]);

module.exports = { render, encodePng, sdRoundRect, ICONSET, COLORS };
