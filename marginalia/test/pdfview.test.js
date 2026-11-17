// node --test test/pdfview.test.js — pure parts of M.pdfview (PDF.js is not available in node).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const pv = require("../js/pdfview.js");
const H = pv.helpers;

test("loads without a DOM and exposes the §17 contract", () => {
  for (const f of ["open", "outline", "resolvePageIndex", "pageTops", "pageHeights", "viewport", "pageView", "renderedPages",
    "setScale", "getScale", "scrollTo", "textIndex", "find", "capture", "close", "currentPage", "pageLabel", "setPassword"]) {
    assert.equal(typeof pv[f], "function", f);
  }
  assert.equal(globalThis.Marginalia.pdfview, pv);
});

test("open() without pdfjsLib rejects with code no_pdfjs; closed-state accessors are inert", async () => {
  await assert.rejects(pv.open(new Uint8Array([1, 2, 3])), (e) => e.code === "no_pdfjs");
  assert.deepEqual(pv.pageTops(), []);
  assert.deepEqual(pv.pageHeights(), []);
  assert.equal(pv.viewport(0), null);
  assert.equal(pv.pageView(0), null);
  assert.deepEqual(pv.renderedPages(), []);
  assert.equal(pv.getScale(), 1);
  assert.deepEqual(pv.currentPage(), { pageIndex: 0, fraction: 0 });
  assert.equal(pv.pageLabel(4), "5");
  assert.equal(pv.setPassword("x"), false);
  assert.deepEqual(await pv.find("anything"), []);
  assert.equal(await pv.outline(), null);
  assert.equal(await pv.resolvePageIndex("sec1"), null);
  await assert.rejects(pv.textIndex(0), (e) => e.code === "no_doc");
  await assert.rejects(pv.capture(0, { x: 0, y: 0, w: 10, h: 10 }, { k: 3 }), (e) => e.code === "no_doc");
  pv.setScale(2); pv.scrollTo({ pageIndex: 3, fraction: 0.5 });   // no document: no-ops, no throw
  await pv.close();
});

test("fitScale: pageColumnWidth / pageWidthPt capped at 1.6667", () => {
  assert.ok(Math.abs(H.fitScale(816, 612) - 1.33333) < 1e-4);
  assert.equal(H.fitScale(5000, 612), 1.6667);
  assert.equal(H.fitScale(0, 612), 1);
});

test("cappedDpr keeps width·height·dpr² ≤ 16 777 216", () => {
  assert.equal(H.cappedDpr(816, 1056, 2), 2);
  const d = H.cappedDpr(3264, 4224, 2);              // 13.8 Mpx at dpr 1
  assert.ok(d < 2 && 3264 * 4224 * d * d <= 16777216 + 1);
  assert.equal(H.cappedDpr(0, 0, 2), 2);
});

test("captureScale follows §15: s = z·dpr·k, pixel cap, 8000-px edge cap", () => {
  const a = H.captureScale({ x: 10, y: 10, w: 100, h: 50 }, 4 / 3, 2, 3);
  assert.ok(Math.abs(a.s - 8) < 1e-9 && Math.abs(a.f - 6) < 1e-9, JSON.stringify(a));
  assert.equal(a.width, 600); assert.equal(a.height, 300);
  const b = H.captureScale({ x: 0, y: 0, w: 1600, h: 1200 }, 1, 2, 3);  // 69 Mpx → scaled to the cap
  assert.ok(b.width * b.height <= 16777216 * 1.0001 && b.width * b.height > 16000000, JSON.stringify(b));   // round() may add a few px
  const c = H.captureScale({ x: 0, y: 0, w: 3000, h: 10 }, 1, 1, 3);    // long edge 9000 → 8000
  assert.equal(c.width, 8000);
});

test("layoutTops and pageAt are inverse (gap above the first page and between pages)", () => {
  const heights = [100, 200, 150];
  const tops = H.layoutTops(heights, 16);
  assert.deepEqual(tops, [16, 132, 348]);
  assert.deepEqual(H.pageAt(0, tops, heights), { pageIndex: 0, fraction: 0 });
  assert.deepEqual(H.pageAt(66, tops, heights), { pageIndex: 0, fraction: 0.5 });
  assert.deepEqual(H.pageAt(120, tops, heights), { pageIndex: 1, fraction: 0 });   // in the gap → next page
  assert.deepEqual(H.pageAt(232, tops, heights), { pageIndex: 1, fraction: 0.5 });
  assert.deepEqual(H.pageAt(9999, tops, heights), { pageIndex: 2, fraction: 1 });
  assert.deepEqual(H.pageAt(5, [], []), { pageIndex: 0, fraction: 0 });
});

test("indexFromContent builds the BUILD-NOTES shape", () => {
  const tc = { items: [
    { str: "Hello", transform: [10, 0, 0, 10, 72, 700], width: 30, height: 10, hasEOL: false },
    { type: "beginMarkedContent" },                                   // no str → no div
    { str: "world", transform: [10, 0, 0, 10, 110, 700], width: 28, height: 10, hasEOL: true },
    { str: "", transform: [10, 0, 0, 10, 72, 688], width: 0, height: 10, hasEOL: false },
    { str: "again", transform: [0, 12, -12, 0, 72, 688], width: 25, height: 12, hasEOL: false }
  ] };
  const ix = H.indexFromContent(tc);
  assert.equal(ix.text, "Hello world\n again");
  assert.deepEqual(ix.starts, [0, 6, 12, 13]);
  assert.equal(ix.map, ix.starts);
  assert.equal(ix.items.length, 4);
  assert.deepEqual(ix.items[0], { str: "Hello", x: 72, y: 700, width: 30, height: 10, hasEOL: false, divIndex: 0 });
  assert.equal(ix.items[3].divIndex, 3);
  assert.equal(ix.items[3].height, 12);                               // hypot(transform[2], transform[3])
  assert.equal(ix.hasText, true);
  for (let k = 0; k < ix.items.length; k++) assert.equal(ix.text.slice(ix.starts[k], ix.starts[k] + ix.items[k].str.length), ix.items[k].str);
  const blank = H.indexFromContent({ items: [{ str: "  ", transform: [1, 0, 0, 1, 0, 0], width: 1 }] });
  assert.equal(blank.hasText, false);
  assert.equal(H.indexFromContent(null).text, "");
});

test("findInIndex is case-insensitive, whitespace-flexible and non-overlapping", () => {
  const ix = { text: "A potential\nenergy function; Potential energy again. aaa" };
  assert.deepEqual(H.findInIndex(ix, "potential energy"), [{ start: 2, end: 18 }, { start: 29, end: 45 }]);
  assert.deepEqual(H.findInIndex(ix, "aa"), [{ start: 53, end: 55 }]);
  assert.deepEqual(H.findInIndex(ix, "   "), []);
  assert.deepEqual(H.findInIndex(ix, "(x)"), []);                       // regex metacharacters are escaped
  assert.deepEqual(H.findInIndex(null, "a"), []);
});

test("normRect accepts {x,y,w,h} and {left,top,width,height}", () => {
  assert.deepEqual(H.normRect({ left: 1, top: 2, width: 3, height: 4 }), { x: 1, y: 2, w: 3, h: 4 });
  assert.deepEqual(H.normRect({ x: 1, y: 2, w: 3, h: 4 }), { x: 1, y: 2, w: 3, h: 4 });
});

test("setScale extension: MIN_SCALE / MAX_SCALE / GESTURE_IDLE_MS are exported for the reader's pinch", () => {
  assert.equal(pv.MIN_SCALE, 0.2);
  assert.equal(pv.MAX_SCALE, 8);
  assert.equal(pv.GESTURE_IDLE_MS, 150);
  pv.setScale(2, { anchor: { clientX: 10, clientY: 10 }, gesture: true });   // no document: a no-op, no throw
});

test("anchorScroll keeps the document point under the pointer fixed when the scale changes (pinch)", () => {
  const A = H.anchorScroll;
  // where a document point that sits at (dx, dy) inside the page lands on screen after the change
  const screenAt = (s, page, dx, dy) => [page.left + dx - s.scrollLeft, page.top + dy - s.scrollTop];
  const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, msg + ": " + a + " vs " + b);

  // page at content (100, 16), pointer at (300, 200) with no scroll: the point is (200, 184) inside the page
  let o = { scrollLeft: 0, scrollTop: 0, px: 300, py: 200, before: { left: 100, top: 16 }, after: { left: 24, top: 16 }, ratio: 2 };
  let r = A(o);
  assert.deepEqual(r, { scrollLeft: 124, scrollTop: 184 });
  let at = screenAt(r, o.after, 200 * 2, 184 * 2);
  close(at[0], 300, "x stays under the pointer"); close(at[1], 200, "y stays under the pointer");

  // zooming back out by the inverse ratio returns to the start (the page moves back with the centring gutter)
  o = { scrollLeft: 124, scrollTop: 184, px: 300, py: 200, before: { left: 24, top: 16 }, after: { left: 100, top: 16 }, ratio: 0.5 };
  assert.deepEqual(A(o), { scrollLeft: 0, scrollTop: 0 });

  // scrolled, a later page, a fractional ratio (exp(0.4)), pointer in the lower right of the scroller
  const k = Math.exp(0.4);
  o = { scrollLeft: 350, scrollTop: 5000, px: 900, py: 600, before: { left: 24, top: 4816 }, after: { left: 24, top: 4816 * k - 16 * (k - 1) }, ratio: k };
  r = A(o);
  const dx = o.scrollLeft + o.px - o.before.left, dy = o.scrollTop + o.py - o.before.top;
  at = screenAt(r, o.after, dx * k, dy * k);
  close(at[0], 900, "x"); close(at[1], 600, "y");

  // the far side cannot be negative: the browser would clamp it anyway
  // (the pointer 90 px above-left of the page, which then moves to the content origin: −45 − 10 → 0)
  r = A({ scrollLeft: 0, scrollTop: 0, px: 10, py: 10, before: { left: 100, top: 100 }, after: { left: 0, top: 0 }, ratio: 0.5 });
  assert.deepEqual(r, { scrollLeft: 0, scrollTop: 0 });
  // a bad ratio counts as 1 (nothing moves)
  assert.deepEqual(A({ scrollLeft: 40, scrollTop: 50, px: 1, py: 2, before: { left: 0, top: 0 }, after: { left: 0, top: 0 }, ratio: 0 }), { scrollLeft: 40, scrollTop: 50 });
});

test("fitScale() (extension) is the fit for the column now, and null while no document is open", () => {
  assert.equal(typeof pv.fitScale, "function");
  assert.equal(pv.fitScale(), null);
});

test("anchorOffsets: the unclamped scroll offsets that put a document point under the pointer", () => {
  // the page's top-left at content (24, 16), the point 300 / 200 px into it, the pointer at (250, 300)
  assert.deepEqual(H.anchorOffsets({ px: 250, py: 300, box: { left: 24, top: 16 }, dx: 300, dy: 200 }), { left: 74, top: -84 });
  // anchorScroll is the same maths from before / after positions and a ratio, clamped at 0
  const o = { scrollLeft: 0, scrollTop: 0, px: 300, py: 200, before: { left: 100, top: 16 }, after: { left: 24, top: 16 }, ratio: 2 };
  const n = H.anchorOffsets({ px: 300, py: 200, box: o.after, dx: (300 - 100) * 2, dy: (200 - 16) * 2 });
  assert.deepEqual(H.anchorScroll(o), { scrollLeft: n.left, scrollTop: n.top });
});

test("zoomHold: margins for the page column where scrolling alone cannot hold the pinch point", () => {
  assert.deepEqual(H.zoomHold({ need: 120, maxScroll: 400, left: 24 }), { left: 0, right: 0 }, "inside the row: scroll only");
  assert.deepEqual(H.zoomHold({ need: 0, maxScroll: 0, left: 48 }), { left: 0, right: 0 });
  assert.deepEqual(H.zoomHold({ need: -0.4, maxScroll: 0, left: 48 }), { left: 0, right: 0 }, "sub-pixel: nothing");
  // the page still fits and grows leftwards: a left margin as wide as the page's target x on screen
  assert.deepEqual(H.zoomHold({ need: -14, maxScroll: 0.4, left: 24 }), { left: 38, right: 0 });
  // a zoom out that needs more row to scroll than there is: the missing room on the right
  assert.deepEqual(H.zoomHold({ need: 185, maxScroll: 0, left: 461 }), { left: 0, right: 185 });
  assert.deepEqual(H.zoomHold({ need: 500, maxScroll: 320, left: 24 }), { left: 0, right: 180 });
});

// The #scroller row of SPEC §2 as CSS lays it out: a gutter (flex 1, min 24), #pages (its width plus the hold margins),
// the margin column. → where the page's left edge lands (scroll-content x) and the row's horizontal overflow.
function row(o) {
  const free = o.cw - (o.pagesW + o.ml + o.mr + o.mw);
  const gutter = Math.max(o.gutterMin, free);
  return { pageLeft: gutter + o.ml, maxScroll: Math.max(0, gutter + o.ml + o.pagesW + o.mr + o.mw - o.cw) };
}
// One anchored gesture step as pdfview.anchorAfter takes it: the layout without a hold, the offsets the point needs,
// a hold where those fall outside [0, maxScroll], the layout again, scroll by what is left (clamped by the browser).
function step(geo, scale, ux, px) {
  const pagesW = geo.base * scale;
  let lay = row({ cw: geo.cw, mw: geo.mw, gutterMin: 24, pagesW, ml: 0, mr: 0 });
  const need = H.anchorOffsets({ px, py: 0, box: { left: lay.pageLeft, top: 0 }, dx: ux * scale, dy: 0 }).left;
  const hold = H.zoomHold({ need, maxScroll: lay.maxScroll, left: lay.pageLeft });
  let left = need;
  if (hold.left || hold.right) {
    const target = lay.pageLeft - need;
    lay = row({ cw: geo.cw, mw: geo.mw, gutterMin: 24, pagesW, ml: hold.left, mr: hold.right });
    left = lay.pageLeft - target;
  }
  const scrollLeft = Math.min(Math.max(0, left), lay.maxScroll);
  return { screenX: lay.pageLeft + ux * scale - scrollLeft, hold, scrollLeft };
}

test("a pinch from fit width keeps the point under the pointer while the page still fits (zoomHold), in and out", () => {
  for (const geo of [{ cw: 760, mw: 224, base: 612 }, { cw: 1400, mw: 288, base: 612 }]) {
    const fit = Math.min(1.6667, (geo.cw - geo.mw - 48) / geo.base);
    const start = row({ cw: geo.cw, mw: geo.mw, gutterMin: 24, pagesW: geo.base * fit, ml: 0, mr: 0 });
    for (const px of [start.pageLeft + 10, 250, geo.cw - geo.mw - 40]) {
      const ux = (px - start.pageLeft) / fit;                 // the document point under the pointer, unscaled
      let held = 0;
      for (const dir of [1, -1]) {                            // 30 small trackpad steps in, then 30 out from fit
        let scale = fit;
        for (let k = 0; k < 30; k++) {
          scale *= Math.exp(dir * 0.03);
          const r = step(geo, scale, ux, px);
          if (r.hold.left || r.hold.right) held++;
          assert.ok(Math.abs(r.screenX - px) < 1e-6, geo.cw + " px=" + px + " dir=" + dir + " k=" + k + ": " + r.screenX);
        }
      }
      assert.ok(held > 0, "the hold was needed at " + geo.cw + " px=" + px);
    }
  }
});
