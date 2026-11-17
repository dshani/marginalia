// node --test test/reader.test.js — M.reader loads without a DOM and its pure helpers behave (SPEC §17.2, BUILD-NOTES extras)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const reader = require(path.join(__dirname, "..", "js", "reader.js"));

test("loads in node with no DOM and registers M.reader", () => {
  assert.equal(typeof window, "undefined");
  assert.ok(globalThis.Marginalia && globalThis.Marginalia.reader === reader);
});

test("every §17.2 / BUILD-NOTES contract function exists", () => {
  for (const name of ["open", "close", "mode", "createFromSelection", "createFreeNote", "focusCard",
    "drawHighlights", "goToAnchor", "setFind", "pulse", "run", "escape"]) {
    assert.equal(typeof reader[name], "function", name);
  }
  assert.ok("selection" in reader);
  assert.equal(reader.selection, null);
});

test("while no book is open every action is a no-op that returns false", async () => {
  assert.equal(reader.mode(), "wide");
  for (const id of ["prompt", "cloze", "highlight", "find", "pageBox", "zoomIn", "zoomOut", "zoomFit",
    "markChapter", "dim", "hideAnswers", "markers", "list", "escape", "unknown"]) {
    assert.equal(reader.run(id), false, id);
  }
  assert.equal(reader.escape(), false);
  assert.equal(reader.drawHighlights(0), false);
  assert.equal(reader.setFind("wave"), false);
  assert.equal(reader.pulse("p_1"), false);
  assert.equal(reader.focusCard("p_1"), false);
  assert.equal(reader.createFromSelection("qa"), false);
  assert.equal(reader.createFreeNote(0, 100, "Q. "), false);
  assert.equal(reader.goToAnchor({ pageIndex: 0, pages: [], quote: "", y: 10 }, { flash: true }), false);
  await reader.close();   // resolves even when nothing is open
});

test("open() rejects with code no_dom outside a browser", async () => {
  await assert.rejects(reader.open("book1", {}), (err) => err instanceof Error && err.code === "no_dom");
});

test("zoom ladder stepping (SPEC §2)", () => {
  const step = reader._pure.nextLadderStep;
  assert.deepEqual(reader.ZOOM_LADDER, [0.5, 0.67, 0.8, 1, 1.25, 1.5, 1.6667, 2, 3, 4]);
  assert.equal(step(1, 1), 1.25);
  assert.equal(step(1, -1), 0.8);
  assert.equal(step(1.6667, 1), 2);
  assert.equal(step(4, 1), null);
  assert.equal(step(0.5, -1), null);
  assert.equal(step(1.1, 1), 1.25);     // from a fit-width scale between rungs
  assert.equal(step(1.1, -1), 1);
  assert.equal(step(1.25, 1), 1.5);
});

test("breakpoints are wide ≥ 680 (compact below 1000), rail 600–679, stack < 600 (BUILD-NOTES over SPEC §2)", () => {
  const m = reader._pure.modeFor, lay = reader._pure.layoutFor;
  assert.equal(reader.MODE_WIDE, 680);
  assert.equal(reader.MODE_RAIL, 600);
  assert.equal(reader.COMPACT_BELOW, 1000);
  const cases = [
    [1400, "wide", false], [1000, "wide", false], [999, "wide", true], [900, "wide", true], [760, "wide", true],
    [680, "wide", true], [679, "rail", false], [640, "rail", false], [600, "rail", false], [599, "stack", false], [400, "stack", false]
  ];
  for (const [w, mode, compact] of cases) {
    assert.equal(m(w), mode, "modeFor(" + w + ")");
    assert.deepEqual(lay(w), { mode, compact }, "layoutFor(" + w + ")");
  }
});

test("pinch: ctrl+wheel factor exp(−deltaY · 0.01), line / page deltas in px, |deltaY| capped at 50", () => {
  const f = reader._pure.wheelFactor;
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, a + " ≈ " + b);
  near(f(-40, 0), Math.exp(0.4));        // pinch out: zoom in
  near(f(40, 0), Math.exp(-0.4));        // pinch in: zoom out
  near(f(-40, 0) * f(40, 0), 1);         // a pinch out and back in returns to the start
  near(f(0, 0), 1);
  near(f(-3, 1), Math.exp(0.48));        // 3 lines = 48 px
  near(f(-100, 0), Math.exp(0.5));       // a mouse-wheel notch with ctrl: capped
  near(f(1, 2), Math.exp(-0.5));         // a page delta: capped
  near(f("x", 0), 1);
});

test("find rects come from item boxes with proportional x and the 0.8 / −0.2 defaults (SPEC §5)", () => {
  const ti = {
    text: "hello world foo",
    starts: [0, 6, 12],
    items: [
      { str: "hello", x: 100, y: 500, width: 50, height: 10, hasEOL: false, divIndex: 0 },
      { str: "world", x: 160, y: 500, width: 50, height: 10, hasEOL: true, divIndex: 1 },
      { str: "foo", x: 100, y: 480, width: 30, height: 10, hasEOL: false, divIndex: 2 }
    ]
  };
  const rects = reader._pure.rectsForOffsets(ti, 2, 8);     // "llo wo"
  assert.equal(rects.length, 2);
  assert.deepEqual(rects[0], [120, 498, 150, 508]);           // from char 2 of "hello" to its end
  assert.deepEqual(rects[1], [160, 498, 180, 508]);           // first 2 chars of "world"
  assert.deepEqual(reader._pure.rectsForOffsets(ti, 12, 15), [[100, 478, 130, 488]]);
  assert.deepEqual(reader._pure.rectsForOffsets(ti, 5, 6), []);   // the separator only
  assert.deepEqual(reader._pure.rectsForOffsets(null, 0, 3), []);
});

test("normRect accepts arrays and box objects and orders corners", () => {
  const n = reader._pure.normRect;
  assert.deepEqual(n([10, 20, 5, 2]), [5, 2, 10, 20]);
  assert.deepEqual(n({ left: 1, top: 2, width: 3, height: 4 }), [1, 2, 4, 6]);
  assert.deepEqual(n({ x: 1, y: 2, w: 3, h: 4 }), [1, 2, 4, 6]);
  assert.equal(n(null), null);
  assert.equal(n([1, 2]), null);
  assert.equal(n([NaN, 0, 1, 1]), null);
});

test("engine messages of SPEC §11 and the refind predicate of §5", () => {
  const msg = reader._pure.engineMessage;
  assert.match(msg({ code: "no_pdfjs" }), /PDF engine not loaded/);
  assert.match(msg({ code: "no_bytes" }), /not in library/);
  assert.match(msg({ code: "password" }), /password/);
  assert.match(msg(new Error("boom")), /boom/);
  const needs = reader._pure.needsRefind;
  assert.equal(needs({ quote: "a potential", pages: [], lost: false, pageIndex: 3 }), true);
  assert.equal(needs({ quote: "a potential", pages: [{ pageIndex: 3, rects: [[0, 0, 1, 1]] }], lost: true }), true);
  assert.equal(needs({ quote: "a potential", pages: [{ pageIndex: 3, rects: [[0, 0, 1, 1]] }], lost: false }), false);
  assert.equal(needs({ quote: "", pages: [], lost: true }), false);   // a free note has nothing to re-find
  assert.equal(needs(null), false);
});

test("revealLeft: navigation targets land in the page band beside the margin, never under it (BUILD-NOTES pinned margin)", () => {
  const R = reader._pure.revealLeft;
  assert.equal(reader.REVEAL_PAD, 24);
  // 760-px scroller, 224-px compact margin, row 1166 wide (scale 1.5): the band is [sl + 24, sl + 512]
  const base = { scrollLeft: 0, clientWidth: 760, scrollWidth: 1166, cover: 224, pad: 24 };
  assert.equal(R(Object.assign({}, base, { x1: 100, x2: 300 })), null, "inside the band: no scroll");
  assert.equal(R(Object.assign({}, base, { x1: 24, x2: 512 })), null, "the band's own edges count as inside");
  // the reviewer's case: a find match at 607–669 sat under the margin (536–760) with scrollLeft 0
  let t = R(Object.assign({}, base, { x1: 607, x2: 669 }));
  assert.equal(t, 406, "a third into the band would need 420: clamped to the end of the row (406)");
  assert.ok(607 - t >= 24 && 669 - t <= 760 - 224 - 24, "now inside the band");
  // a target half under the margin (497–572), a wider row: a third into the band
  t = R(Object.assign({}, base, { scrollWidth: 3000, x1: 497, x2: 572 }));
  assert.equal(t, Math.round(497 - 24 - 488 / 3));
  // scrolled past the target (it is left of the band): back to it, clamped at 0
  assert.equal(R(Object.assign({}, base, { scrollLeft: 406, x1: 132, x2: 416 })), 0);
  // a target too long for a third: its right end stays inside the band
  t = R(Object.assign({}, base, { scrollWidth: 3000, x1: 1000, x2: 1400 }));
  assert.equal(t, 1400 - 512);
  assert.ok(1000 - t >= 24 && 1400 - t <= 512);
  // wider than the band: its start shows
  assert.equal(R(Object.assign({}, base, { scrollWidth: 3000, x1: 1000, x2: 1700 })), 1000 - 24);
  // nothing scrolls sideways (the page fits), or a bad target: null
  assert.equal(R(Object.assign({}, base, { scrollWidth: 760, x1: 607, x2: 669 })), null);
  assert.equal(R(Object.assign({}, base, { x1: NaN, x2: 10 })), null);
  // rail: a 44-px rail covers less, the band is wider ([24, 692]); 607–669 is visible there
  assert.equal(R(Object.assign({}, base, { cover: 44, x1: 607, x2: 669 })), null);
  // a sliver of a band (huge cover): the whole room left of the margin is used, no negative band
  t = R({ scrollLeft: 0, clientWidth: 300, scrollWidth: 2000, cover: 260, pad: 24, x1: 500, x2: 520 });
  assert.ok(t !== null && 500 - t >= 0 && 520 - t <= 40, String(t));
  // order of the ends does not matter
  assert.equal(R(Object.assign({}, base, { x1: 669, x2: 607 })), 406);
  // no book open: scrollLeftFor has nothing to measure
  assert.equal(reader.scrollLeftFor({ pageIndex: 0, pages: [{ pageIndex: 0, rects: [[1, 2, 3, 4]] }] }), null);
});
