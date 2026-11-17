"use strict";
// test/snip-dom.test.js — the armed snip overlay follows the page column (BUILD-NOTES "Post-review decisions"): it
// covers the visible part of #pages inside #scroller and stops at the left edge of a pinned #margin, and it is placed
// again on scale:changed (a pinch over the overlay itself, ⌘= / ⌘−, a refit) and reader:mode, which move the column
// without scrolling. Real bus.js and snip.js in a vm context; a few fake elements with settable rects.
// Run from the project root: node --test
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const JS = path.join(__dirname, "..", "js");

function makeEnv() {
  const els = {};
  function el(id) {
    const e = {
      id, nodeType: 1, children: [], style: {}, attrs: {}, listeners: {}, classes: new Set(id === "snipOverlay" ? ["is-hidden"] : []),
      rect: { left: 0, top: 0, width: 0, height: 0 }, offsetWidth: 0,
      classList: null,
      set innerHTML(v) { this.children = []; },
      get innerHTML() { return ""; },
      appendChild(k) { this.children.push(k); return k; },
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
      addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
      removeEventListener(t, fn) { const l = this.listeners[t] || []; const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); },
      getBoundingClientRect() { const r = this.rect; return { left: r.left, top: r.top, width: r.width, height: r.height, right: r.left + r.width, bottom: r.top + r.height }; }
    };
    e.classList = { add: (...c) => c.forEach((x) => e.classes.add(x)), remove: (...c) => c.forEach((x) => e.classes.delete(x)), contains: (x) => e.classes.has(x) };
    els[id] = e;
    return e;
  }
  ["snipOverlay", "scroller", "pages", "margin"].forEach(el);
  const doc = {
    getElementById: (id) => els[id] || null,
    createElement: () => el("rect" + Object.keys(els).length),
    addEventListener() {}, removeEventListener() {}
  };
  const win = { document: doc, console, setTimeout, clearTimeout, Promise, addEventListener() {}, removeEventListener() {}, navigator: { platform: "MacIntel", userAgent: "node" } };
  win.window = win;
  const ctx = vm.createContext(win);
  vm.runInContext(fs.readFileSync(path.join(JS, "bus.js"), "utf8"), ctx, { filename: "js/bus.js" });
  const M = win.Marginalia;
  M.settings = { get: (k) => (k === "snipMode" ? "image" : undefined), set() {} };
  M.app = { toast: () => ({ close() {} }) };
  M.vision = { detect: () => Promise.resolve(null) };
  vm.runInContext(fs.readFileSync(path.join(JS, "snip.js"), "utf8"), ctx, { filename: "js/snip.js" });
  return { M, els };
}
const box = (e) => [parseFloat(e.style.left), parseFloat(e.style.left) + parseFloat(e.style.width)];

test("the armed overlay follows the page column on scale:changed and reader:mode (no scroll involved)", () => {
  const { M, els } = makeEnv();
  // 760-px reader at fit width: page 48–536, the compact margin 536–760
  els.scroller.rect = { left: 0, top: 44, width: 760, height: 756 };
  els.pages.rect = { left: 48, top: 60, width: 488, height: 4000 };
  els.margin.rect = { left: 536, top: 44, width: 224, height: 4000 }; els.margin.offsetWidth = 224;
  assert.equal(M.snip.enter(), true);
  assert.deepEqual(box(els.snipOverlay), [48, 536]);
  // a pinch over the overlay at (60, 50): the page grows to 24–828 under the pinned margin, no scroll offset changes
  els.pages.rect = { left: 24, top: 60, width: 804, height: 6600 };
  M.bus.emit("scale:changed", { scale: 1.315 });
  assert.deepEqual(box(els.snipOverlay), [24, 536], "the new page strip 24–48 is covered; it still stops at the margin");
  // a breakpoint: the rail (44 px) leaves more of the page in view
  els.margin.rect = { left: 716, top: 44, width: 44, height: 4000 }; els.margin.offsetWidth = 44;
  M.bus.emit("reader:mode", { mode: "rail", compact: false });
  assert.deepEqual(box(els.snipOverlay), [24, 716]);
  // disarmed: the events leave the (hidden) overlay alone
  M.snip.exit();
  const before = JSON.stringify(els.snipOverlay.style);
  els.pages.rect = { left: 100, top: 60, width: 300, height: 1000 };
  M.bus.emit("scale:changed", { scale: 0.5 });
  assert.equal(JSON.stringify(els.snipOverlay.style), before);
});
