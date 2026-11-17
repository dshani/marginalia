"use strict";
// test/pdfview-dom.test.js — M.pdfview on a small fake DOM whose #scroller row is laid out like the real one (a gutter
// with flex 1 and min-width 24, #pages with its inline width and margins, the 224-px compact margin), with a stub
// pdfjsLib whose pages render at once. Covers (BUILD-NOTES "Post-review decisions"):
//   - a pinch from fit width keeps the document point under the pointer, also while the page still fits: anchored
//     gesture steps hold #pages with margins (zoom in: left, zoom out below fit: right) and, once the gesture has been
//     idle, the page eases back into the layout's own place (no margins left, the page against the margin);
//   - a call that is not an anchored gesture step ends a hold at once; overflow-x: hidden (stack) never scrolls
//     sideways and takes no hold;
//   - a dimmed page keeps its .dimLayer through gesture steps (only the text layer goes until the re-render);
//   - fitScale() is the fit for the column as it is now.
// Run from the project root: node --test
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const JS = path.join(__dirname, "..", "js");
const BASE_W = 612, BASE_H = 792, GUTTER_MIN = 24;

function makeEnv(opts) {
  opts = opts || {};
  const geo = { cw: opts.cw || 760, ch: 800, mw: opts.mw == null ? 224 : opts.mw, overflowX: opts.overflowX || "auto" };
  const doc = { listeners: {} };
  class El {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase(); this.nodeType = 1; this.id = ""; this.children = []; this.parentNode = null;
      this.attrs = {}; this.listeners = {}; this.classes = new Set();
      this.style = { setProperty(k, v) { this[k] = String(v); }, removeProperty(k) { delete this[k]; } };
      this._sl = 0; this.scrollTop = 0; this.width = 0; this.height = 0;
    }
    get className() { return Array.from(this.classes).join(" "); }
    set className(v) { this.classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
    get classList() { const c = this.classes; return { add: (...a) => a.forEach((x) => c.add(x)), remove: (...a) => a.forEach((x) => c.delete(x)), contains: (x) => c.has(x), toggle: (x, f) => { const w = f === undefined ? !c.has(x) : !!f; if (w) c.add(x); else c.delete(x); return w; } }; }
    get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; }
    get firstChild() { return this.children[0] || null; }
    set innerHTML(v) { this.children.slice().forEach((k) => this.removeChild(k)); }
    get innerHTML() { return ""; }
    appendChild(k) { if (k.parentNode) k.parentNode.removeChild(k); this.children.push(k); k.parentNode = this; return k; }
    removeChild(k) { const i = this.children.indexOf(k); if (i >= 0) this.children.splice(i, 1); k.parentNode = null; return k; }
    setAttribute(k, v) { if (k === "id") this.id = String(v); else this.attrs[k] = String(v); }
    getAttribute(k) { return k === "id" ? this.id : (k in this.attrs ? this.attrs[k] : null); }
    hasAttribute(k) { return k in this.attrs; }
    removeAttribute(k) { delete this.attrs[k]; }
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
    removeEventListener(t, fn) { const l = this.listeners[t] || []; const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); }
    querySelectorAll(sel) {
      const out = [], want = sel.startsWith("#") ? { id: sel.slice(1) } : { cls: sel.slice(1) };
      (function walk(n) { n.children.forEach((k) => { if (want.id ? k.id === want.id : k.classes.has(want.cls)) out.push(k); walk(k); }); })(this);
      return out;
    }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    getContext() { return {}; }
    getBoundingClientRect() { return layoutRect(this); }
  }
  doc.createElement = (tag) => new El(tag);
  doc.addEventListener = (t, fn) => { (doc.listeners[t] = doc.listeners[t] || []).push(fn); };
  doc.removeEventListener = () => {};
  const reader = new El("section"); reader.id = "reader"; reader.classList.add("reader--wide", "reader--compact");
  const scroller = new El("div"); scroller.id = "scroller";
  const gutter = new El("div"); gutter.className = "gutter";
  const pages = new El("div"); pages.id = "pages";
  const margin = new El("div"); margin.id = "margin";
  reader.appendChild(scroller); scroller.appendChild(gutter); scroller.appendChild(pages); scroller.appendChild(margin);
  doc.getElementById = (id) => ({ reader, scroller, pages, margin })[id] || null;
  Object.defineProperty(margin, "offsetWidth", { get: () => geo.mw });
  Object.defineProperty(scroller, "clientWidth", { get: () => geo.cw });
  Object.defineProperty(scroller, "clientHeight", { get: () => geo.ch });

  // the row: gutter max(24, free) · #pages (width + margins) · margin; the page column's pages centred in #pages
  const px = (v) => parseFloat(v) || 0;
  function rowLayout() {
    const pw = px(pages.style.width), ml = px(pages.style.marginLeft), mr = px(pages.style.marginRight);
    const gutterW = Math.max(GUTTER_MIN, geo.cw - (pw + ml + mr + geo.mw));
    return { gutterW, pw, ml, rowW: gutterW + ml + pw + mr + geo.mw };
  }
  Object.defineProperty(scroller, "scrollWidth", { get: () => Math.max(geo.cw, rowLayout().rowW) });
  Object.defineProperty(scroller, "scrollHeight", { get: () => 100000 });
  Object.defineProperty(scroller, "scrollLeft", {
    get() { return Math.min(this._sl, Math.max(0, this.scrollWidth - geo.cw)); },   // the browser clamps at layout
    set(v) { this._sl = Math.min(Math.max(0, Number(v) || 0), Math.max(0, this.scrollWidth - geo.cw)); }
  });
  function layoutRect(el) {
    const lay = rowLayout(), sl = scroller.scrollLeft, st = scroller.scrollTop;
    if (el === scroller || el === reader) return { left: 0, top: 0, right: geo.cw, bottom: geo.ch, width: geo.cw, height: geo.ch };
    if (el === pages) return { left: lay.gutterW + lay.ml - sl, top: -st, width: lay.pw, height: 0, right: lay.gutterW + lay.ml + lay.pw - sl, bottom: -st };
    if (el.parentNode === pages) {
      let top = px(pages.style.paddingTop);
      for (const k of pages.children) { if (k === el) break; top += px(k.style.height) + 16; }
      const w = px(el.style.width), left = lay.gutterW + lay.ml + (lay.pw - w) / 2 - sl;
      return { left, top: top - st, width: w, height: px(el.style.height), right: left + w, bottom: top - st + px(el.style.height) };
    }
    return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
  }

  const settings = { dimPages: !!opts.dim };
  const win = {
    document: doc, console: { log() {}, warn() {}, error() {}, info() {} },
    setTimeout, clearTimeout, Promise, Map, Set, Uint8Array, ArrayBuffer, Math, Date,
    performance: { now: () => Date.now() },
    requestAnimationFrame: (fn) => setTimeout(() => fn(Date.now()), 4), cancelAnimationFrame: (id) => clearTimeout(id),
    getComputedStyle: (el) => ({ overflowX: el === scroller ? geo.overflowX : "visible" }),
    matchMedia: () => ({ matches: false }),
    devicePixelRatio: 1, innerWidth: geo.cw, innerHeight: geo.ch,
    addEventListener() {}, removeEventListener() {}
  };
  win.window = win;
  const pageObj = {
    rotate: 0,
    getViewport: (o) => { const s = (o && o.scale) || 1; return { width: BASE_W * s, height: BASE_H * s, scale: s, rotation: 0, convertToViewportPoint: (x, y) => [x * s, (BASE_H - y) * s] }; },
    render: () => ({ promise: Promise.resolve(), cancel() {} }),
    getTextContent: () => Promise.resolve({ items: [] }),
    cleanup() {}
  };
  win.pdfjsLib = {
    getDocument: () => ({ promise: Promise.resolve({ numPages: 3, fingerprints: ["fp"], getMetadata: () => Promise.resolve(null), getPageLabels: () => Promise.resolve(null), getPage: () => Promise.resolve(pageObj), getOutline: () => Promise.resolve(null) }), destroy: () => Promise.resolve() }),
    renderTextLayer: () => ({ promise: Promise.resolve() })
  };
  const ctx = vm.createContext(win);
  vm.runInContext(fs.readFileSync(path.join(JS, "bus.js"), "utf8"), ctx, { filename: "js/bus.js" });
  const M = win.Marginalia;
  M.settings = { get: (k) => settings[k], set: (k, v) => { settings[k] = v; M.bus.emit("settings:changed", { key: k, value: v }); } };
  vm.runInContext(fs.readFileSync(path.join(JS, "pdfview.js"), "utf8"), ctx, { filename: "js/pdfview.js" });
  const events = [];
  M.bus.on("scale:changed", (e) => events.push(e.scale));
  // the document point under a client point, and where it is on screen now
  function pageEl(i) { return pages.children[i]; }
  function docPoint(cx, cy) {
    const s = M.pdfview.getScale();
    for (let i = 0; i < pages.children.length; i++) { const r = pageEl(i).getBoundingClientRect(); if (cy >= r.top && cy <= r.bottom) return { i, x: (cx - r.left) / s, y: (cy - r.top) / s }; }
    return null;
  }
  function screenOf(d) { const s = M.pdfview.getScale(), r = pageEl(d.i).getBoundingClientRect(); return [r.left + d.x * s, r.top + d.y * s]; }
  return { M, geo, pages, scroller, settings, events, pageEl, docPoint, screenOf };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function openDoc(env) {
  await env.M.pdfview.open(new Uint8Array([1, 2, 3]), { container: env.pages });
  await wait(80);                                     // measuring and the first renders (no IntersectionObserver here)
}

test("a pinch from fit width keeps the point under the pointer while the page still fits, then eases into place", async () => {
  const env = makeEnv({ cw: 760 });
  await openDoc(env);
  const pv = env.M.pdfview, sc = env.scroller;
  const fit = (760 - 224 - 48) / BASE_W;
  assert.ok(Math.abs(pv.fitScale() - fit) < 1e-9, "fitScale() for the column now: " + pv.fitScale());
  assert.ok(Math.abs(pv.getScale() - fit) < 1e-9);
  assert.equal(env.pageEl(0).getBoundingClientRect().left, 48, "fit: the gutter takes the free room");
  sc.scrollTop = 200;
  const X = 250, Y = 300, d = env.docPoint(X, Y);
  let held = 0, maxDrift = 0;
  for (let k = 0; k < 20; k++) {                     // 20 trackpad-sized steps (deltaY −4 each)
    pv.setScale(pv.getScale() * Math.exp(0.04), { anchor: { clientX: X, clientY: Y }, gesture: true });
    if (env.pages.style.marginLeft) held++;
    const at = env.screenOf(d);
    maxDrift = Math.max(maxDrift, Math.abs(at[0] - X), Math.abs(at[1] - Y));
  }
  assert.ok(held > 0, "the first steps hold the page column with a left margin");
  assert.ok(maxDrift < 1e-6, "the point stays under the pointer: drift " + maxDrift);
  assert.equal(env.pages.style.marginLeft, "", "past the gutter the layout holds the point by scrolling alone");

  // a small pinch from fit that ends while the hold is on: once idle, the page eases back into the layout
  pv.setScale("fit");
  sc.scrollLeft = 0;
  const d2 = env.docPoint(X, Y);
  pv.setScale(fit * 1.04, { anchor: { clientX: X, clientY: Y }, gesture: true });
  assert.notEqual(env.pages.style.marginLeft, "", "held");
  assert.ok(Math.abs(env.screenOf(d2)[0] - X) < 1e-6);
  const before = env.events.length;
  await wait(150 + 150 + 120);                       // GESTURE_IDLE_MS, the easing, slack for the timers
  assert.equal(env.pages.style.marginLeft, "", "released");
  assert.equal(env.pages.style.marginRight, "");
  const w = env.pageEl(0).getBoundingClientRect().width, own = Math.max(GUTTER_MIN, 760 - 224 - w);
  const left = env.pageEl(0).getBoundingClientRect().left + sc.scrollLeft;
  assert.ok(Math.abs(left - own) < 1e-6, "the page's own place (it fits: against the margin): " + left + " vs " + own);
  assert.equal(sc.scrollLeft, 0);
  assert.ok(env.events.length > before, "scale:changed tells the margin and the snip overlay that the column moved");
  await pv.close();
});

test("a zoom out below fit holds the point with a right margin; a non-gesture call ends the hold at once", async () => {
  const env = makeEnv({ cw: 1400, mw: 288 });
  await openDoc(env);
  const pv = env.M.pdfview;
  env.scroller.scrollTop = 1200;                      // away from the document's top, where scrolling cannot go negative
  const X = 900, Y = 400, d = env.docPoint(X, Y);
  for (let k = 0; k < 10; k++) {
    pv.setScale(pv.getScale() * Math.exp(-0.03), { anchor: { clientX: X, clientY: Y }, gesture: true });
    const at = env.screenOf(d);
    assert.ok(Math.abs(at[0] - X) < 1e-6 && Math.abs(at[1] - Y) < 1e-6, "step " + k + ": " + at);
  }
  assert.notEqual(env.pages.style.marginRight, "", "the page shrinks towards the pointer, the room beside it held");
  pv.setScale(pv.getScale());                        // the same scale, not a gesture step: the hold ends now
  assert.equal(env.pages.style.marginRight, "");
  const lay = env.pageEl(0).getBoundingClientRect();
  assert.ok(Math.abs(lay.right - (1400 - 288)) < 1e-6, "the page is back against the margin: " + lay.right);
  await pv.close();
});

test("overflow-x: hidden (stack) is never scrolled sideways and takes no hold", async () => {
  const env = makeEnv({ cw: 400, mw: 0, overflowX: "hidden" });
  await openDoc(env);
  const pv = env.M.pdfview;
  for (let k = 0; k < 8; k++) pv.setScale(pv.getScale() * Math.exp(0.1), { anchor: { clientX: 380, clientY: 300 }, gesture: true });
  assert.equal(env.scroller.scrollLeft, 0);
  assert.equal(env.pages.style.marginLeft, "");
  assert.equal(env.pages.style.marginRight, "");
  await pv.close();
});

test("a dimmed page keeps its .dimLayer through gesture steps (only the text layer waits for the re-render)", async () => {
  const env = makeEnv({ cw: 1000, mw: 288, dim: true });
  await openDoc(env);
  const pv = env.M.pdfview;
  const layers = (cls) => env.pages.children.map((p) => p.querySelectorAll("." + cls).length);
  const rendered = Array.from(pv.renderedPages());
  assert.ok(rendered.length > 0, "pages rendered");
  assert.deepEqual(layers("dimLayer").filter((n, i) => rendered.includes(i)), rendered.map(() => 1));
  pv.setScale(pv.getScale() * 1.1, { anchor: { clientX: 300, clientY: 300 }, gesture: true });
  pv.setScale(pv.getScale() * 1.1, { anchor: { clientX: 300, clientY: 300 }, gesture: true });
  assert.deepEqual(layers("dimLayer").filter((n, i) => rendered.includes(i)), rendered.map(() => 1), "still dimmed mid-gesture");
  assert.deepEqual(layers("textLayer").filter((n, i) => rendered.includes(i)), rendered.map(() => 0), "the text layer is gone until the re-render");
  await wait(150 + 120);
  assert.deepEqual(layers("dimLayer").filter((n, i) => rendered.includes(i)), rendered.map(() => 1), "re-rendered: one dim layer each");
  assert.deepEqual(layers("textLayer").filter((n, i) => rendered.includes(i)), rendered.map(() => 1));
  await pv.close();
});
