"use strict";
// SPEC §12 anchors.test.js: fake viewport transform [s, 0, 0, −s, 0, H·s] round-trips; line merging;
// multi-page split; all four refind strategies and the miss; hitTest; sentenceAround.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const A = require(path.join(__dirname, "..", "js", "anchors.js"));

// ---------------------------------------------------------------- fakes
// PDF.js-like PageViewport with transform [s, 0, 0, −s, 0, H·s]
function makeViewport(W, H, s) {
  const t = [s, 0, 0, -s, 0, H * s];
  const apply = (x, y) => [t[0] * x + t[2] * y + t[4], t[1] * x + t[3] * y + t[5]];
  return {
    width: W * s, height: H * s, scale: s, transform: t,
    convertToViewportPoint: (x, y) => apply(x, y),
    convertToPdfPoint(vx, vy) {
      const d = t[0] * t[3] - t[1] * t[2];
      return [(vx * t[3] - vy * t[2] + t[2] * t[5] - t[4] * t[3]) / d, (-vx * t[1] + vy * t[0] + t[4] * t[1] - t[5] * t[0]) / d];
    },
    convertToViewportRectangle(r) { const p1 = apply(r[0], r[1]), p2 = apply(r[2], r[3]); return [p1[0], p1[1], p2[0], p2[1]]; }
  };
}
function rect(left, top, width, height) {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top };
}
function closeRect(actual, expected, eps = 0.02) {
  assert.ok(Array.isArray(actual) && actual.length === 4, "rect shape: " + JSON.stringify(actual));
  for (let i = 0; i < 4; i++) {
    assert.ok(Math.abs(actual[i] - expected[i]) <= eps, `rect[${i}] = ${actual[i]}, expected ${expected[i]} (${JSON.stringify(actual)})`);
  }
}

// Minimal DOM: pages (.page elements with data-page-index), text-layer spans with one text node
// each, and a Range whose getClientRects() slices a span's rect proportionally.
function makeDom(pagesSpec) {
  const allSpans = [], views = new Map();
  for (const ps of pagesSpec) {
    const el = {
      nodeType: 1, dataset: { pageIndex: String(ps.index) },
      closest(sel) { return sel === ".page" ? el : null; },
      getBoundingClientRect() { return ps.box; }
    };
    const textDivs = ps.spans.map((sp) => {
      const tn = { nodeType: 3 };
      const span = {
        nodeType: 1, textContent: sp.str, childNodes: [tn], firstChild: tn, _rect: sp.rect,
        closest(sel) { return sel === ".page" ? el : null; }
      };
      tn.parentElement = span; tn.parentNode = span;
      allSpans.push(span);
      return span;
    });
    views.set(ps.index, { el, viewport: ps.viewport, textDivs });
  }
  return { views, allSpans };
}
const spanOf = (node) => (node.nodeType === 3 ? node.parentElement : node);
function makeRange(dom, sc, so, ec, eo) {
  return {
    startContainer: sc, startOffset: so, endContainer: ec, endOffset: eo, collapsed: false,
    intersectsNode(node) {
      const si = dom.allSpans.indexOf(spanOf(this.startContainer)), ei = dom.allSpans.indexOf(spanOf(this.endContainer));
      const ni = dom.allSpans.indexOf(node);
      return ni >= 0 && ni >= si && ni <= ei;
    },
    cloneRange() { return makeRange(dom, this.startContainer, this.startOffset, this.endContainer, this.endOffset); },
    setStart(node, off) { this.startContainer = node; this.startOffset = off; },
    setEnd(node, off) { this.endContainer = node; this.endOffset = off; },
    selectNodeContents(node) {
      this.startContainer = node.firstChild; this.startOffset = 0;
      this.endContainer = node.firstChild; this.endOffset = node.textContent.length;
    },
    getClientRects() {
      const span = spanOf(this.startContainer), len = span.textContent.length, R = span._rect;
      const a = this.startOffset / len, b = this.endOffset / len;
      return [rect(R.left + R.width * a, R.top, R.width * (b - a), R.height)];
    }
  };
}

// Text index in the BUILD-NOTES shape: one item per line, x = 72, y = 700 − 14·k, width = 6 chars,
// height 12; text = strs joined with " " plus "\n" after items with hasEOL.
function makeIndex(lines, extra = {}) {
  const items = [], starts = [];
  let text = "";
  lines.forEach((str, k) => {
    starts.push(text.length);
    items.push({ str, x: 72, y: 700 - 14 * k, width: 6 * str.length, height: 12, hasEOL: true, divIndex: k });
    text += str + "\n";
    if (k < lines.length - 1) text += " ";
  });
  return Object.assign({ text, starts, items }, extra);
}
const lineBox = (k, o1, o2) => [72 + 6 * o1, 700 - 14 * k - 2.4, 72 + 6 * o2, 700 - 14 * k + 9.6];

const LINES = [
  "The wave function Ψ solves it. In Section 1.12 we",
  "see that V(x,t) is a potential energy function. As in",
  "classical mechanics, the ﬁeld is conservative!",
  "Is it? Yes.",
  "Here the force is proportional to the distance from the origin, A.",
  "There the force is proportional to the distance from the origin, B."
];

// ---------------------------------------------------------------- viewport round trips
test("fake viewport: convertToPdfPoint inverts convertToViewportPoint", () => {
  const vp = makeViewport(612, 792, 1.25);
  const v = vp.convertToViewportPoint(72, 652);
  assert.deepEqual(v, [90, 175]);
  const p = vp.convertToPdfPoint(90, 175);
  assert.ok(Math.abs(p[0] - 72) < 1e-9 && Math.abs(p[1] - 652) < 1e-9);
});

test("rectsFromClientRects → viewportRects round-trips a client rect", () => {
  const s = 1.25, vp = makeViewport(612, 792, s);
  const pageBox = rect(100, 50, 612 * s, 792 * s);
  const rects = A.rectsFromClientRects([rect(190, 225, 225, 15)], pageBox, vp);
  assert.equal(rects.length, 1);
  closeRect(rects[0], [72, 640, 252, 652]);
  const anchor = { pageIndex: 3, pages: [{ pageIndex: 3, rects }], quote: "q", prefix: "", suffix: "", items: null, y: rects[0][3], lost: false };
  const back = A.viewportRects(anchor, 3, vp);
  assert.equal(back.length, 1);
  closeRect(back[0], [90, 175, 315, 190]);
  assert.deepEqual(A.viewportRects(anchor, 4, vp), []);
  assert.deepEqual(A.viewportRects(Object.assign({}, anchor, { lost: true }), 3, vp), []);
});

test("rectsFromClientRects rescales when the page box differs from the viewport size", () => {
  const vp = makeViewport(612, 792, 2);               // 1224 × 1584
  const pageBox = rect(0, 0, 612, 792);               // laid out at half size
  const rects = A.rectsFromClientRects([rect(36, 70, 90, 6)], pageBox, vp);
  closeRect(rects[0], [36, 792 - 76, 126, 792 - 70]);
});

test("rects under 1×1 are dropped and rects are clipped to the page", () => {
  const vp = makeViewport(612, 792, 1), pageBox = rect(100, 50, 612, 792);
  assert.deepEqual(A.rectsFromClientRects([rect(190, 225, 0.5, 15), rect(190, 225, 50, 0.9)], pageBox, vp), []);
  const clipped = A.rectsFromClientRects([rect(50, 225, 100, 15)], pageBox, vp);
  closeRect(clipped[0], [0, 792 - 190, 50, 792 - 175]);
  assert.deepEqual(A.rectsFromClientRects([rect(190, 225, 50, 15)], pageBox, null), []);
  assert.deepEqual(A.rectsFromClientRects(null, pageBox, vp), []);
});

// ---------------------------------------------------------------- line merging
test("fragments on one line merge (vertical overlap > 50 % of the shorter), other lines stay apart", () => {
  const vp = makeViewport(612, 792, 1), pageBox = rect(100, 50, 612, 792);
  const rects = A.rectsFromClientRects([
    rect(300, 225, 115, 15), rect(190, 225, 50, 15), rect(240, 225, 60, 15),   // one line, unsorted
    rect(190, 243, 100, 15)                                                     // next line
  ], pageBox, vp);
  assert.equal(rects.length, 2);
  closeRect(rects[0], [90, 792 - 190, 315, 792 - 175]);
  closeRect(rects[1], [90, 792 - 208, 190, 792 - 193]);
  // exactly 50 % overlap is not merged, 60 % is
  assert.equal(A.rectsFromClientRects([rect(190, 225, 50, 15), rect(240, 232.5, 50, 15)], pageBox, vp).length, 2);
  assert.equal(A.rectsFromClientRects([rect(190, 225, 50, 15), rect(240, 231, 50, 15)], pageBox, vp).length, 1);
});

// ---------------------------------------------------------------- fromSelection (multi-page split)
function selectionFixture() {
  const vp = makeViewport(612, 792, 1);
  const dom = makeDom([
    { index: 0, viewport: vp, box: rect(100, 50, 612, 792), spans: [
      { str: "where V(x,t) is", rect: rect(172, 150, 150, 12) },
      { str: "a potential energy", rect: rect(330, 150, 180, 12) }
    ] },
    { index: 1, viewport: vp, box: rect(100, 852, 612, 792), spans: [
      { str: "function. As in", rect: rect(172, 952, 150, 12) }
    ] },
    { index: 2, viewport: vp, box: rect(100, 1654, 612, 792), spans: [
      { str: "classical mechanics", rect: rect(172, 1754, 190, 12) }
    ] }
  ]);
  return { vp, dom };
}

test("fromSelection splits a two-page selection into one entry per page", () => {
  const { dom } = selectionFixture();
  const [s00, s01, s10] = dom.allSpans;
  const range = makeRange(dom, s01.firstChild, 0, s10.firstChild, 9);
  const anchor = A.fromSelection(range, dom.views);
  assert.ok(anchor);
  assert.deepEqual(Object.keys(anchor).sort(), ["items", "lost", "pageIndex", "pages", "prefix", "quote", "suffix", "y"]);
  assert.equal(anchor.pageIndex, 0);
  assert.equal(anchor.pages.length, 2);
  assert.equal(anchor.pages[0].pageIndex, 0);
  assert.equal(anchor.pages[1].pageIndex, 1);
  closeRect(anchor.pages[0].rects[0], [230, 680, 410, 692]);
  closeRect(anchor.pages[1].rects[0], [72, 680, 162, 692]);
  assert.equal(anchor.quote, "a potential energy\nfunction.");
  assert.equal(anchor.prefix, "where V(x,t) is ");
  assert.equal(anchor.suffix, " As in");
  assert.deepEqual(anchor.items, { start: { item: 1, offset: 0 }, end: { item: 0, offset: 9 } });
  assert.equal(anchor.y, 692);
  assert.equal(anchor.lost, false);
  void s00;
  // pageViews as a function gives the same anchor
  assert.deepEqual(A.fromSelection(range, (i) => dom.views.get(i) || null), anchor);
});

test("fromSelection: a partial span on one page, one line merged", () => {
  const { dom } = selectionFixture();
  const [s00, s01] = dom.allSpans;
  const range = makeRange(dom, s00.firstChild, 6, s01.firstChild, 11);   // "V(x,t) is" + "a potential"
  const anchor = A.fromSelection(range, dom.views);
  assert.equal(anchor.pages.length, 1);
  assert.equal(anchor.pages[0].rects.length, 1);
  closeRect(anchor.pages[0].rects[0], [72 + 60, 680, 230 + 110, 692]);
  assert.equal(anchor.quote, "V(x,t) is a potential");
  assert.equal(anchor.prefix, "where ");
  assert.equal(anchor.suffix, " energy");
  assert.deepEqual(anchor.items, { start: { item: 0, offset: 6 }, end: { item: 1, offset: 11 } });
});

test("fromSelection truncates selections over more than two pages and flags it", () => {
  const { dom } = selectionFixture();
  const [s00, , , s20] = dom.allSpans;
  const anchor = A.fromSelection(makeRange(dom, s00.firstChild, 6, s20.firstChild, 9), dom.views);
  assert.equal(anchor.pages.length, 2);
  assert.deepEqual(anchor.pages.map((p) => p.pageIndex), [0, 1]);
  assert.equal(anchor.quote, "V(x,t) is a potential energy\nfunction. As in");
  assert.equal(anchor.truncated, true);
});

test("fromSelection cuts a long quote at 500 characters, never inside a surrogate pair", () => {
  const vp = makeViewport(612, 792, 1);
  const long = "a".repeat(499) + "😀 and more words after the cut";       // NFKC keeps the emoji (it maps 𝑥 to x)
  const dom = makeDom([{ index: 0, viewport: vp, box: rect(100, 50, 612, 792), spans: [{ str: long, rect: rect(172, 150, 400, 12) }] }]);
  const span = dom.allSpans[0];
  const anchor = A.fromSelection(makeRange(dom, span.firstChild, 0, span.firstChild, long.length), dom.views);
  assert.equal(Array.from(anchor.quote).length, 500);
  assert.equal(anchor.quote, "a".repeat(499) + "😀", "the whole emoji, not half of it");
  assert.equal(/[\ud800-\udfff]/.test(anchor.quote.replace(/[\ud800-\udbff][\udc00-\udfff]/g, "")), false);
  assert.doesNotThrow(() => encodeURIComponent(anchor.quote));
});

test("fromSelection returns null for collapsed ranges, non-page nodes and missing views", () => {
  const { dom } = selectionFixture();
  const [s00, s01] = dom.allSpans;
  const r = makeRange(dom, s00.firstChild, 0, s01.firstChild, 3);
  assert.equal(A.fromSelection(Object.assign(r, { collapsed: true }), dom.views), null);
  assert.equal(A.fromSelection(null, dom.views), null);
  const orphan = { nodeType: 1, closest: () => null, textContent: "x", childNodes: [] };
  assert.equal(A.fromSelection(makeRange(dom, orphan, 0, orphan, 1), dom.views), null);
  assert.equal(A.fromSelection(makeRange(dom, s00.firstChild, 0, s01.firstChild, 3), new Map()), null);
});

// ---------------------------------------------------------------- fromMarginY / anchorY
test("fromMarginY stores a free note anchor with no rects", () => {
  assert.deepEqual(A.fromMarginY(4, 500.5), { pageIndex: 4, pages: [], quote: "", prefix: "", suffix: "", items: null, y: 500.5, lost: false });
});

test("anchorY = pageTop + viewport y; lost anchors sit at the page top", () => {
  const vps = [makeViewport(612, 792, 1), makeViewport(612, 792, 1)];
  const tops = [0, 1100];
  const y = A.anchorY({ pageIndex: 1, y: 652.1, pages: [], lost: false }, tops, (i) => vps[i]);
  assert.ok(Math.abs(y - 1239.9) < 1e-9, String(y));
  assert.equal(A.anchorY({ pageIndex: 1, y: 652.1, lost: true }, tops, vps), 1100);
  assert.equal(A.anchorY({ pageIndex: 7, y: 10, lost: false }, tops, new Map([[1, vps[1]]])), 1100 + 782);
  assert.equal(A.anchorY({ pageIndex: 0, y: 10 }, tops, () => null), 0);
  assert.equal(A.anchorY(null, tops, vps), 0);
});

// ---------------------------------------------------------------- hitTest
test("hitTest returns the prompt whose rect contains the point (smallest wins), else null", () => {
  const list = [{ id: "p1", rects: [[0, 0, 100, 100]] }, { id: "p2", rects: [[10, 10, 20, 20], [50, 50, 60, 60]] }];
  assert.equal(A.hitTest(list, 50, 50), "p2");
  assert.equal(A.hitTest(list, 15, 15), "p2");
  assert.equal(A.hitTest(list, 30, 30), "p1");
  assert.equal(A.hitTest(list, 100, 100), "p1");
  assert.equal(A.hitTest(list, 200, 200), null);
  assert.equal(A.hitTest([], 1, 1), null);
  assert.equal(A.hitTest(list, NaN, 1), null);
  assert.equal(A.hitTest(new Map([["m1", [[0, 0, 5, 5]]]]), 2, 2), "m1");
});

// ---------------------------------------------------------------- refind
const stored = (quote, prefix, extra = {}) => Object.assign({
  pageIndex: 3, pages: [], quote, prefix, suffix: "", items: null, y: null, lost: true
}, extra);

test("refind strategy 1: exact quote rebuilds items and rects from item boxes and clears lost", () => {
  const idx = makeIndex(LINES);
  const anchor = stored("a potential energy function", "see that V(x,t) is ");
  const copy = JSON.parse(JSON.stringify(anchor));
  const found = A.refind(anchor, idx);
  assert.ok(found);
  assert.deepEqual(anchor, copy, "input anchor is not mutated");
  assert.deepEqual(Object.keys(found).sort(), ["items", "lost", "pageIndex", "pages", "prefix", "quote", "suffix", "y"]);
  assert.equal(found.pageIndex, 3);
  assert.equal(found.lost, false);
  assert.equal(found.quote, anchor.quote);
  assert.equal(found.prefix, anchor.prefix);
  assert.equal(found.pages.length, 1);
  assert.equal(found.pages[0].pageIndex, 3);
  assert.equal(found.pages[0].rects.length, 1);
  closeRect(found.pages[0].rects[0], lineBox(1, 19, 46));
  assert.deepEqual(found.items, { start: { item: 1, offset: 19 }, end: { item: 1, offset: 46 } });
  assert.equal(found.y, found.pages[0].rects[0][3]);
});

test("refind takes the page from textIndex.pageIndex or the third argument", () => {
  const anchor = stored("a potential energy function", "");
  assert.equal(A.refind(anchor, makeIndex(LINES, { pageIndex: 5 })).pageIndex, 5);
  const f = A.refind(anchor, makeIndex(LINES), 2);
  assert.equal(f.pageIndex, 2);
  assert.equal(f.pages[0].pageIndex, 2);
});

test("refind strategy 2: whitespace / ligature-normalised quote, one merged rect per line", () => {
  const idx = makeIndex(LINES);
  const multi = A.refind(stored("In Section 1.12 we see that V(x,t)", "solves it. "), idx);
  assert.ok(multi);
  assert.equal(multi.pages[0].rects.length, 2);
  const l0 = LINES[0].indexOf("In Section");
  closeRect(multi.pages[0].rects[0], lineBox(0, l0, LINES[0].length));
  closeRect(multi.pages[0].rects[1], lineBox(1, 0, "see that V(x,t)".length));
  assert.deepEqual(multi.items, { start: { item: 0, offset: l0 }, end: { item: 1, offset: 15 } });
  assert.equal(multi.y, multi.pages[0].rects[0][3]);

  const lig = A.refind(stored("the field is conservative", "mechanics, "), idx);
  assert.ok(lig);
  const o = LINES[2].indexOf("the ﬁeld");
  closeRect(lig.pages[0].rects[0], lineBox(2, o, o + "the ﬁeld is conservative".length));
});

test("refind strategy 3: prefix + first 40 characters when the quote's tail changed", () => {
  const idx = makeIndex(LINES);
  const quote = "a potential energy function. As in classical MECHANICS";
  assert.equal(A.refind(stored(quote, "nothing like this "), idx) === null, false, "strategy 4 still finds the head");
  const found = A.refind(stored(quote, "see that V(x,t) is "), idx);
  assert.ok(found);
  assert.equal(found.items.start.item, 1);
  assert.equal(found.items.start.offset, 19);
  assert.equal(found.items.end.item, 2);
  assert.equal(found.pages[0].rects.length, 2);
  assert.equal(found.lost, false);
  // the prefix disambiguates a head that occurs twice
  const twice = "the force is proportional to the distance from the origin, ZZZ";
  assert.equal(A.refind(stored(twice, "There "), idx).items.start.item, 5);
  assert.equal(A.refind(stored(twice, "Here "), idx).items.start.item, 4);
});

test("refind strategy 4: the first 40 characters alone, nearest to the stored y when ambiguous", () => {
  const idx = makeIndex(LINES);
  const twice = "the force is proportional to the distance from the origin, ZZZ";
  assert.equal(A.refind(stored(twice, "no such prefix "), idx).items.start.item, 4);
  assert.equal(A.refind(stored(twice, "", { y: 700 - 14 * 5 + 9 }), idx).items.start.item, 5);
  assert.equal(A.refind(stored(twice, "", { y: 700 - 14 * 4 + 9 }), idx).items.start.item, 4);
});

test("refind miss returns null", () => {
  const idx = makeIndex(LINES);
  assert.equal(A.refind(stored("completely absent text that is nowhere on this page at all", "nope "), idx), null);
  assert.equal(A.refind(stored("", ""), idx), null);
  assert.equal(A.refind(stored("Yes", ""), null), null);
  assert.equal(A.refind(stored("Yes", ""), { text: "", items: [] }), null);
  assert.equal(A.refind(null, idx), null);
});

test("refind without `starts` derives item offsets itself", () => {
  const idx = makeIndex(LINES);
  const noStarts = { text: idx.text, items: idx.items };
  closeRect(A.refind(stored("Yes", ""), noStarts).pages[0].rects[0], lineBox(3, 7, 10));
});

// ---------------------------------------------------------------- sentenceAround
test("sentenceAround returns the sentence with the quote in braces; 1.12 stays intact", () => {
  const idx = makeIndex(LINES);
  assert.equal(A.sentenceAround(stored("a potential energy function", "see that V(x,t) is "), idx),
    "In Section 1.12 we see that V(x,t) is {a potential energy function}.");
  assert.equal(A.sentenceAround(stored("it", ""), idx), "The wave function Ψ solves {it}.");
  assert.equal(A.sentenceAround(stored("Yes", ""), idx), "{Yes}.");
  assert.equal(A.sentenceAround(stored("Is it", ""), idx), "{Is it}?");
  assert.equal(A.sentenceAround(stored("the field is conservative", "mechanics, "), idx), "As in classical mechanics, {the ﬁeld is conservative}!");
  assert.equal(A.sentenceAround(stored("wave function Ψ solves it. In Section", ""), idx), "The {wave function Ψ solves it. In Section} 1.12 we see that V(x,t) is a potential energy function.");
});

test("sentenceAround falls back to the braced quote when the text has no match", () => {
  const idx = makeIndex(LINES);
  assert.equal(A.sentenceAround(stored("nowhere   to be found", ""), idx), "{nowhere to be found}");
  assert.equal(A.sentenceAround(stored("Yes", ""), null), "{Yes}");
  assert.equal(A.sentenceAround(stored("", ""), idx), "");
});
