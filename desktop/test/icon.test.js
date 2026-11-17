"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const icon = require("../lib/icon");

function decode(png) {
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let off = 8, w = 0, h = 0;
  const idat = [];
  const types = [];
  while (off < png.length) {
    const len = png.readUInt32BE(off), type = png.subarray(off + 4, off + 8).toString("latin1");
    const data = png.subarray(off + 8, off + 8 + len);
    assert.equal(png.readUInt32BE(off + 8 + len), zlib.crc32(png.subarray(off + 4, off + 8 + len)) >>> 0, type + " CRC");
    types.push(type);
    if (type === "IHDR") { w = data.readUInt32BE(0); h = data.readUInt32BE(4); assert.deepEqual([...data.subarray(8)], [8, 6, 0, 0, 0]); }
    if (type === "IDAT") idat.push(data);
    off += 12 + len;
  }
  assert.deepEqual(types, ["IHDR", "IDAT", "IEND"]);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  assert.equal(raw.length, h * (w * 4 + 1));
  const px = (x, y) => [...raw.subarray(y * (w * 4 + 1) + 1 + x * 4, y * (w * 4 + 1) + 1 + x * 4 + 4)];
  return { w, h, px };
}

test("the iconset has the ten sizes iconutil expects", () => {
  assert.deepEqual(icon.ICONSET.map(([, s]) => s), [16, 32, 32, 64, 128, 256, 256, 512, 512, 1024]);
  assert.ok(icon.ICONSET.every(([n, s]) => /^icon_(\d+)x\1(@2x)?\.png$/.test(n) && (n.includes("@2x") ? 2 : 1) * Number(/_(\d+)x/.exec(n)[1]) === s));
});

test("a 256-px icon: transparent corners, dark tile, paper page, red margin line, yellow card", () => {
  const png = icon.encodePng(256, icon.render(256));
  const { w, h, px } = decode(png);
  assert.equal(w, 256);
  assert.equal(h, 256);
  const at = (x, y) => px(Math.round(x / 4), Math.round(y / 4));   // design units (1024) → pixels
  assert.equal(at(8, 8)[3], 0, "corner transparent");
  const tile = at(512, 890);
  assert.ok(tile[3] === 255 && tile[0] < 0x50, "dark tile " + tile);
  const paper = at(300, 220);
  assert.ok(paper[0] > 240 && paper[1] > 240 && paper[2] > 230, "paper " + paper);
  const margin = at(621, 300);
  assert.ok(margin[0] > 200 && margin[1] < 110 && margin[2] < 90, "margin line " + margin);
  const card = at(757, 488);
  assert.ok(card[0] > 240 && card[1] > 200 && card[2] < 140, "card " + card);
});

test("rounded-rectangle distances are negative inside, zero on the edge, positive outside", () => {
  assert.ok(icon.sdRoundRect(50, 50, 0, 0, 100, 100, 10) < 0);
  assert.ok(Math.abs(icon.sdRoundRect(100, 50, 0, 0, 100, 100, 10)) < 1e-9);
  assert.ok(icon.sdRoundRect(150, 50, 0, 0, 100, 100, 10) > 0);
  assert.ok(icon.sdRoundRect(99, 99, 0, 0, 100, 100, 10) > 0, "the corner is cut");
});
