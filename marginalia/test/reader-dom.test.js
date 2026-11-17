"use strict";
// test/reader-dom.test.js — M.reader driven through a small fake DOM (SPEC §2, §3, §5, §17.2, §17.3). Covers:
//   - open(B) while book A is open closes A and really opens B (doc:opened for B, toolbar, pages), and a run of
//     opens issued back to back still ends with the last one open;
//   - a prompt moved out of the open book (margin "Move to…" saves a copy with the deck's collectionId; the
//     prompt list mutates the record in place) leaves the page layers and the hit index: no ghost highlight,
//     note triangle or badge, and clicking / hovering its old place no longer reaches the margin;
//   - "Dim pages" (D): the reader never adds a .dimLayer of its own, so with pdfview's layer every page is
//     dimmed exactly once, whichever pages were drawn before or after the toggle;
//   - breakpoints (BUILD-NOTES "Post-review decisions"): wide ≥ 680 with .reader--compact below 1000, rail
//     600–679, stack < 600, reader:mode {mode, compact} on every change and the fit applied inside the same
//     ResizeObserver callback; the toolbar sheds Image|LaTeX first, then labels, then Review ▾ / ?;
//   - zoomFit → false at fit already (Cmd+0 reaches the browser); pinch zoom: ctrl+wheel and Safari gesture
//     events are prevented and merged into one M.pdfview.setScale(scale, {anchor, gesture}) per frame; a step that
//     changes nothing leaves fit as fit; stack mode clamps to M.pdfview.fitScale() (the fit now, not one remembered
//     from another width or a reopen); every width change refits inside the ResizeObserver callback;
//   - find and goToAnchor (G, Go to passage, review's Go to source) bring the target into the page band beside a
//     pinned margin, and scrollLeftFor(anchor) gives margin.js the same for J / K.
// Real util / bus / anchors / reader modules loaded as classic scripts in a vm context; M.pdfview, M.cache,
// M.store, M.settings, M.margin, M.app and M.review are recording stubs (the pdfview stub keeps a .dimLayer the
// way js/pdfview.js does: added on render while dimPages is on and on every dimPages change, its own only).
// Run from the project root: node --test
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const JS = path.join(__dirname, "..", "js");
const PAGE_W = 600, PAGE_H = 800, PAGE_GAP = 10, PAGES = 2;

// ------------------------------------------------------------------ fake DOM

// compound selectors only: tag? (.class | #id | [attr] | [attr="value"])*, comma lists
const SEL_PART = /([a-zA-Z][\w-]*)|\.([\w-]+)|#([\w-]+)|\[([\w-]+)(?:="((?:[^"\\]|\\.)*)")?\]/y;
function parseCompound(sel) {
  const out = { tag: null, id: null, classes: [], attrs: [] };
  sel = sel.trim();
  let pos = 0;
  while (pos < sel.length) {
    SEL_PART.lastIndex = pos;
    const m = SEL_PART.exec(sel);
    if (!m || (m[1] && pos !== 0)) throw new Error("fake DOM: unsupported selector " + JSON.stringify(sel));
    if (m[1]) out.tag = m[1].toUpperCase();
    else if (m[2]) out.classes.push(m[2]);
    else if (m[3]) out.id = m[3];
    else out.attrs.push({ name: m[4], value: m[5] === undefined ? null : m[5].replace(/\\(.)/g, "$1") });
    pos = SEL_PART.lastIndex;
  }
  return out;
}
function matchesSel(el, sel) {
  if (!el || el.nodeType !== 1) return false;
  return String(sel).split(",").some((s) => {
    const c = parseCompound(s);
    if (c.tag && el.tagName !== c.tag) return false;
    if (c.id && el.id !== c.id) return false;
    if (!c.classes.every((k) => el.classList.contains(k))) return false;
    return c.attrs.every((a) => { const v = el.getAttribute(a.name); return v !== null && (a.value === null || v === a.value); });
  });
}
function dataKey(attr) { return attr.slice(5).replace(/-([a-z])/g, (m, ch) => ch.toUpperCase()); }

function makeDocument() {
  const doc = { nodeType: 9, visibilityState: "visible", listeners: {} };
  class FakeElement {
    constructor(tag, nodeType) {
      this.nodeType = nodeType || 1;
      this.tagName = String(tag).toUpperCase();
      this.ownerDocument = doc;
      this.id = "";
      this.children = [];
      this.parentNode = null;
      this.dataset = {};
      this.style = { setProperty(k, v) { this[k] = String(v); }, removeProperty(k) { delete this[k]; } };
      this.attrs = new Map();
      this.classes = [];
      this.text = "";
      this.listeners = {};
      this.rect = null;
      this.value = "";
      this.disabled = false;
      this.scrollTop = 0; this.scrollLeft = 0; this.scrollWidth = 0; this.scrollHeight = 0;
      this.clientWidth = 0; this.clientHeight = 0; this.offsetWidth = 0; this.offsetHeight = 0;
    }
    get className() { return this.classes.join(" "); }
    set className(v) { this.classes = String(v).split(/\s+/).filter(Boolean); }
    get classList() {
      const el = this;
      return {
        add(...cs) { cs.forEach((c) => { if (!el.classes.includes(c)) el.classes.push(c); }); },
        remove(...cs) { el.classes = el.classes.filter((c) => !cs.includes(c)); },
        toggle(c, force) {
          const want = force === undefined ? !el.classes.includes(c) : !!force;
          if (want) this.add(c); else this.remove(c);
          return want;
        },
        contains(c) { return el.classes.includes(c); }
      };
    }
    get childNodes() { return this.children; }
    get firstChild() { return this.children[0] || null; }
    get lastChild() { return this.children[this.children.length - 1] || null; }
    get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; }
    get textContent() { return this.text + this.children.map((c) => c.textContent).join(""); }
    set textContent(v) { this.children.slice().forEach((c) => this.removeChild(c)); this.text = v == null ? "" : String(v); }
    get innerHTML() { return ""; }
    set innerHTML(v) { this.textContent = ""; }
    appendChild(c) { return this.insertBefore(c, null); }
    insertBefore(c, ref) {
      if (c.nodeType === 11) { c.children.slice().forEach((k) => this.insertBefore(k, ref)); return c; }
      if (c.parentNode) c.parentNode.removeChild(c);
      const i = ref ? this.children.indexOf(ref) : -1;
      if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
      c.parentNode = this;
      return c;
    }
    removeChild(c) {
      const i = this.children.indexOf(c);
      if (i < 0) throw new Error("fake DOM: removeChild of a non-child");
      this.children.splice(i, 1);
      c.parentNode = null;
      return c;
    }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    setAttribute(k, v) {
      v = String(v);
      if (k === "id") this.id = v;
      else if (k === "class") this.className = v;
      else if (k.startsWith("data-")) this.dataset[dataKey(k)] = v;
      else this.attrs.set(k, v);
    }
    getAttribute(k) {
      if (k === "id") return this.id || null;
      if (k === "class") return this.className;
      if (k.startsWith("data-")) { const v = this.dataset[dataKey(k)]; return v === undefined ? null : String(v); }
      return this.attrs.has(k) ? this.attrs.get(k) : null;
    }
    hasAttribute(k) { return this.getAttribute(k) !== null; }
    removeAttribute(k) { if (k.startsWith("data-")) delete this.dataset[dataKey(k)]; else this.attrs.delete(k); }
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
    removeEventListener(type, fn) { const l = this.listeners[type] || []; const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); }
    dispatchEvent(ev) { (this.listeners[ev.type] || []).slice().forEach((fn) => fn.call(this, ev)); return true; }
    getBoundingClientRect() {
      const r = this.rect || { left: 0, top: 0, width: 0, height: 0 };
      return { left: r.left, top: r.top, width: r.width, height: r.height, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top };
    }
    getClientRects() { return []; }
    contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
    matches(sel) { return matchesSel(this, sel); }
    closest(sel) { for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (matchesSel(n, sel)) return n; return null; }
    querySelectorAll(sel) {
      const out = [];
      (function walk(n) { n.children.forEach((c) => { if (matchesSel(c, sel)) out.push(c); walk(c); }); })(this);
      return out;
    }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    focus() { doc.activeElement = this; }
    blur() { if (doc.activeElement === this) doc.activeElement = doc.body; }
    select() {}
    setSelectionRange() {}
  }
  doc.createElement = (tag) => new FakeElement(tag, 1);
  doc.createDocumentFragment = () => new FakeElement("#fragment", 11);
  doc.documentElement = doc.createElement("html");
  doc.body = doc.createElement("body");
  doc.documentElement.appendChild(doc.body);
  doc.activeElement = doc.body;
  doc.getElementById = (id) => doc.documentElement.querySelector("#" + id);
  doc.querySelector = (sel) => doc.documentElement.querySelector(sel);
  doc.querySelectorAll = (sel) => doc.documentElement.querySelectorAll(sel);
  doc.addEventListener = (type, fn) => { (doc.listeners[type] = doc.listeners[type] || []).push(fn); };
  doc.removeEventListener = (type, fn) => { const l = doc.listeners[type] || []; const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); };
  doc.getSelection = () => ({ rangeCount: 0, isCollapsed: true, removeAllRanges() {}, getRangeAt() { return null; } });

  // the BUILD-NOTES skeleton hosts the reader touches
  function host(parent, tag, id, hidden) {
    const e = doc.createElement(tag);
    e.id = id;
    if (hidden) e.classList.add("is-hidden");
    parent.appendChild(e);
    return e;
  }
  const app = host(doc.body, "div", "app");
  const reader = host(app, "section", "reader");
  reader.setAttribute("tabindex", "-1");
  host(reader, "div", "toolbar");
  const scroller = host(reader, "div", "scroller");
  const gutter = doc.createElement("div"); gutter.className = "gutter"; scroller.appendChild(gutter);
  host(scroller, "div", "pages");
  host(scroller, "div", "margin");
  ["adder", "find", "snipOverlay", "sheet", "list"].forEach((id) => host(reader, "div", id, true));
  return doc;
}

// ------------------------------------------------------------------ harness

// PDF space has y up; the fake viewport is scale 1 with y flipped (page box PAGE_W × PAGE_H).
function viewport() {
  return {
    width: PAGE_W, height: PAGE_H, scale: 1, rotation: 0,
    convertToViewportPoint: (x, y) => [x, PAGE_H - y],
    convertToPdfPoint: (x, y) => [x, PAGE_H - y],
    convertToViewportRectangle: (r) => [r[0], PAGE_H - r[1], r[2], PAGE_H - r[3]]
  };
}

function harness(opts) {
  opts = opts || {};
  const doc = makeDocument();
  const errors = [];
  const ros = [];      // every ResizeObserver made, with its callback (a test can deliver entries by hand)
  const win = {
    document: doc,
    console: { log() {}, info() {}, warn() {}, error: (...a) => errors.push(a.map((x) => (x && x.stack) || String(x)).join(" ")) },
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    requestAnimationFrame: (fn) => setTimeout(() => fn(Date.now()), 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    ResizeObserver: function (cb) {
      this.cb = cb; this.targets = []; ros.push(this);
      this.observe = function (el) { this.targets.push(el); }; this.unobserve = function () {}; this.disconnect = function () { this.targets = []; };
    },
    Promise, Map, Set, WeakMap, Uint8Array, ArrayBuffer,
    innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1,
    navigator: { platform: "MacIntel", userAgent: "node" },
    listeners: {},
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    removeEventListener(type, fn) { const l = this.listeners[type] || []; const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); }
  };
  win.window = win;
  win.self = win;
  const ctx = vm.createContext(win);
  for (const name of ["util", "bus", "anchors", "reader"]) {
    vm.runInContext(fs.readFileSync(path.join(JS, name + ".js"), "utf8"), ctx, { filename: "js/" + name + ".js" });
  }
  const M = win.Marginalia;

  // settings: in memory, settings:changed like js/settings.js
  const values = Object.assign({ dimPages: false, marginAnswers: true, marginMode: "cards", snipMode: "image" }, opts.settings || {});
  M.settings = {
    get: (k) => values[k],
    set: (k, v) => { values[k] = v; M.bus.emit("settings:changed", { key: k, value: v }); return v; }
  };

  // DECISIONS D32: the Obsidian connection, switched on unless a test passes settings: {obsidian: false}
  M.obsidian = { enabled: () => values.obsidian !== false };

  // cache: collections + prompts in maps, savePrompt emits prompt:saved like js/cache.js
  const cols = new Map(), ps = new Map();
  (opts.collections || []).forEach((c) => cols.set(c.id, c));
  (opts.prompts || []).forEach((p) => ps.set(p.id, p));
  const cache = {
    collection: (id) => cols.get(id) || null,
    promptsOf: (id) => Array.from(ps.values()).filter((p) => p.collectionId === id),
    prompt: (id) => ps.get(id) || null,
    saveCollection: (c) => { cols.set(c.id, c); return Promise.resolve(c); },
    recontext: () => Promise.resolve(),
    savePrompt: (p) => { ps.set(p.id, p); M.bus.emit("prompt:saved", { prompt: p, isNew: false }); return Promise.resolve(p); }
  };
  M.cache = cache;
  // the stored bytes name their book, so the pdfview stub can tell which document it was asked to open
  M.store = { docs: { loadBytes: (id) => Promise.resolve(new Uint8Array(Buffer.from("%PDF " + id))) } };

  // pdfview: renders PAGES pages at once into opts.container; .dimLayer kept like js/pdfview.js; setScale is
  // recorded (scale + opts) and "fit" is scale pv.fit (1 unless a test narrows the column), which fitScale() reports
  const pv = { opens: [], S: null, scale: 1, mode: "fit", scaleCalls: [], fit: 1 };
  function addDim(p) {
    if (p.dimLayer) return;
    const d = doc.createElement("div");
    d.className = "dimLayer";
    p.el.appendChild(d);
    p.dimLayer = d;
  }
  function dropDim(p) { if (p.dimLayer) { p.dimLayer.remove(); p.dimLayer = null; } }
  function closeDoc() { if (pv.S) { pv.S.container.textContent = ""; pv.S = null; } }
  M.bus.on("settings:changed", (e) => {
    if (!pv.S || !e || e.key !== "dimPages") return;
    pv.S.pages.forEach((p) => (e.value ? addDim(p) : dropDim(p)));
  });
  M.pdfview = {
    open(bytes, o) {
      const name = Buffer.from(bytes).toString().replace(/^%PDF /, "");
      pv.opens.push(name);
      closeDoc();
      return Promise.resolve().then(() => {
        const container = o.container;
        container.textContent = "";
        const pages = [];
        for (let i = 0; i < PAGES; i++) {
          const el = doc.createElement("div");
          el.className = "page";
          el.setAttribute("data-page-index", String(i));
          el.rect = { left: 0, top: i * (PAGE_H + PAGE_GAP), width: PAGE_W, height: PAGE_H };
          container.appendChild(el);
          el.appendChild(doc.createElement("canvas"));
          for (const cls of ["hlLayer", "textLayer"]) { const l = doc.createElement("div"); l.className = cls; el.appendChild(l); }
          const p = { index: i, el, dimLayer: null };
          if (values.dimPages) addDim(p);
          pages.push(p);
        }
        pv.S = { name, pages, container };
        return { numPages: PAGES, pageLabels: null, fingerprint: "fp-" + name, info: {} };
      });
    },
    close() { closeDoc(); return Promise.resolve(); },
    pageView: (i) => { const p = pv.S && pv.S.pages[i]; return p ? { el: p.el, viewport: viewport(), textDivs: [], textContent: null } : null; },
    renderedPages: () => (pv.S ? pv.S.pages.map((p) => p.index) : []),
    viewport: () => (pv.S ? viewport() : null),
    pageTops: () => (pv.S ? pv.S.pages.map((p) => p.index * (PAGE_H + PAGE_GAP)) : []),
    pageHeights: () => (pv.S ? pv.S.pages.map(() => PAGE_H) : []),
    getScale: () => pv.scale,
    scaleMode: () => pv.mode,
    fitScale: () => (pv.S ? pv.fit : null),
    setScale(s, o) {
      pv.scaleCalls.push([s, o]);
      pv.mode = s === "fit" ? "fit" : "manual";
      pv.scale = s === "fit" ? pv.fit : Math.min(8, Math.max(0.2, s));
    },
    MIN_SCALE: 0.2, MAX_SCALE: 8,
    scrollTo() {},
    textIndex: () => Promise.resolve({ text: "", starts: [], items: [] }),
    find: () => Promise.resolve([])
  };

  const marginCalls = { focus: [], setHot: [] };
  M.margin = {
    mount() {}, setItems() {}, setMode() {}, setAnswersHidden() {}, activeEditor: () => null,
    focus: (id) => { marginCalls.focus.push(id); return true; },
    setHot: (id) => { marginCalls.setHot.push(id); }
  };
  const toasts = [];
  M.app = {
    toast: (o) => { toasts.push(o && o.text); return { close() {} }; },
    setFocusOwner() {}, focusOwner: () => "reader", route() {}, openShortcuts() {}, startReview() {}
  };
  M.review = { isSuspended: () => false };

  function record(type) {
    const out = [];
    M.bus.on(type, (e) => out.push(e && e.collectionId));
    return out;
  }
  const pagesEl = doc.getElementById("pages");
  function pageEl(i) { return pv.S.pages[i].el; }
  // a pointer event on page i at PDF point (x, y), targeted at the page's text layer like a real click
  function pointer(type, i, x, y) {
    const target = pageEl(i).querySelector(".textLayer");
    const ev = { type, target, button: 0, clientX: x, clientY: i * (PAGE_H + PAGE_GAP) + (PAGE_H - y), defaultPrevented: false };
    ev.preventDefault = () => { ev.defaultPrevented = true; };
    ev.stopPropagation = () => {};
    pagesEl.dispatchEvent(ev);
    return ev;
  }
  return { M, doc, win, pv, cache, errors, toasts, marginCalls, record, pagesEl, pageEl, pointer, ros };
}

function book(id) { return { id, kind: "book", name: "Book " + id, sections: [], lastPosition: null, deletedAt: null }; }
function deck(id) { return { id, kind: "deck", name: "Deck " + id, sections: [], deletedAt: null }; }
function mkPrompt(id, collectionId, kind, anchor) {
  return {
    id, collectionId, kind, text: kind === "highlight" ? "" : "Q. q\nA. a", tags: [], flagged: false, anchor,
    context: { docName: "Book", sectionLabel: null, pageIndex: anchor ? anchor.pageIndex : null, pageLabel: null },
    cards: [], createdAt: 1, contentUpdatedAt: 1, updatedAt: 1, deletedAt: null, v: 1
  };
}
function rectAnchor(pageIndex, rect) {
  return { pageIndex, pages: [{ pageIndex, rects: [rect] }], quote: "a passage", prefix: "", suffix: "", items: null, y: rect[3], lost: false };
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 0));

// ------------------------------------------------------------------ open / close (SPEC §17.2)

test("open(B) while book A is open closes A and opens B", async () => {
  const h = harness({ collections: [book("A"), book("B")] });
  const opened = h.record("doc:opened"), closed = h.record("doc:closed");
  await h.M.reader.open("A", {});
  assert.deepEqual(opened, ["A"]);
  assert.equal(h.doc.querySelector(".tb-name__text").textContent, "Book A");

  const r = await h.M.reader.open("B", {});
  assert.equal(r, undefined);
  assert.deepEqual(closed, ["A"]);
  assert.deepEqual(opened, ["A", "B"], "doc:opened fires for B");
  assert.deepEqual(h.pv.opens, ["A", "B"], "pdfview was asked for B's bytes");
  assert.equal(h.doc.querySelector(".tb-name__text").textContent, "Book B");
  assert.equal(h.pagesEl.querySelectorAll(".page").length, PAGES);
  assert.equal(h.M.reader.run("zoomIn"), true, "a book is open");
  assert.equal(h.M.reader.run("zoomFit"), true, "back to fit from a manual zoom");
  assert.ok(h.doc.querySelector(".reader__prep").classList.contains("is-hidden"), "no stuck “Preparing document…” bar");

  await h.M.reader.open("B", { pageIndex: 1 });          // the open book again: navigate only
  assert.deepEqual(opened, ["A", "B"]);
  await h.M.reader.close();
  assert.deepEqual(closed, ["A", "B"]);
  assert.equal(h.M.reader.run("zoomFit"), false);
  assert.deepEqual(h.toasts, []);
  assert.deepEqual(h.errors, []);
});

test("opens issued back to back: the last one wins and nothing is left half open", async () => {
  const h = harness({ collections: [book("A"), book("B"), book("C")] });
  const opened = h.record("doc:opened"), closed = h.record("doc:closed");
  const pA = h.M.reader.open("A", {}), pB = h.M.reader.open("B", {});   // nothing open yet: A is superseded
  assert.equal(await pA, undefined);
  await pB;
  assert.deepEqual(opened, ["B"]);
  assert.deepEqual(h.pv.opens, ["B"]);

  const pA2 = h.M.reader.open("A", {}), pC = h.M.reader.open("C", {}); // B open: closed once, then C wins
  await Promise.all([pA2, pC]);
  assert.deepEqual(closed, ["B"]);
  assert.deepEqual(opened, ["B", "C"]);
  assert.deepEqual(h.pv.opens, ["B", "C"]);
  assert.equal(h.doc.querySelector(".tb-name__text").textContent, "Book C");
  await h.M.reader.close();
  assert.deepEqual(h.errors, []);
});

// ------------------------------------------------------------------ moved prompts leave the page (SPEC §5)

test("a prompt moved to a deck leaves the page layers and the hit index", async () => {
  const p1 = mkPrompt("p1", "A", "qa", rectAnchor(0, [100, 600, 300, 620]));
  const p3 = mkPrompt("p3", "A", "highlight", rectAnchor(0, [100, 300, 300, 320]));
  const note = mkPrompt("n1", "A", "note", { pageIndex: 1, pages: [], quote: "", prefix: "", suffix: "", items: null, y: 400, lost: false });
  const h = harness({ collections: [book("A"), deck("D")], prompts: [p1, p3, note] });
  await h.M.reader.open("A", {});
  const drawn = (id) => h.pagesEl.querySelectorAll("[data-id=\"" + id + "\"]").length;
  assert.ok(h.pagesEl.querySelectorAll(".hl[data-id=\"p1\"]").length > 0, "p1 drawn");
  assert.ok(h.pagesEl.querySelector(".hl-badge[data-id=\"p1\"]"), "p1 badge");
  assert.ok(h.pagesEl.querySelector(".hl-note[data-id=\"n1\"]"), "note triangle drawn");

  // before the move: a click on the highlight focuses its card, hovering lights it
  let ev = h.pointer("click", 0, 200, 610);
  assert.equal(ev.defaultPrevented, true);
  assert.deepEqual(h.marginCalls.focus, ["p1"]);
  h.pointer("mousemove", 0, 200, 610);
  await tick(5);
  assert.deepEqual(h.marginCalls.setHot, ["p1"]);
  assert.ok(h.pagesEl.querySelectorAll(".hl.hl--active[data-id=\"p1\"]").length > 0);

  // margin "Move to…": a copy with the deck's collectionId and no anchor is saved
  await h.cache.savePrompt(Object.assign({}, p1, { collectionId: "D", anchor: null }));
  assert.equal(drawn("p1"), 0, "no ghost .hl / badge for the moved prompt");
  assert.equal(h.pagesEl.querySelectorAll(".hl--active").length, 0);
  assert.ok(h.pagesEl.querySelectorAll(".hl[data-id=\"p3\"]").length > 0, "the book's other highlight stays");
  ev = h.pointer("click", 0, 200, 610);
  assert.equal(ev.defaultPrevented, false, "the old place is plain page again");
  h.pointer("mousemove", 0, 200, 610);
  await tick(5);
  assert.deepEqual(h.marginCalls.focus, ["p1"], "no focus for a card that left the book");
  assert.ok(!h.marginCalls.setHot.slice(1).includes("p1"), "no hover for it either");
  h.pointer("click", 0, 200, 310);
  assert.deepEqual(h.marginCalls.focus, ["p1", "p3"], "hit-testing still works for the prompts that stayed");

  // prompt list "Move to…": the record itself is changed and saved
  const live = h.cache.prompt("n1");
  live.anchor = null;
  live.collectionId = "D";
  await h.cache.savePrompt(live);
  assert.equal(drawn("n1"), 0, "no ghost note triangle");

  await h.M.reader.close();
  assert.deepEqual(h.errors, []);
});

// ------------------------------------------------------------------ Dim pages (SPEC §13 "Dark mode", §5 layers)

test("Dim pages: the reader adds no .dimLayer, so each page is dimmed exactly once", async () => {
  const h = harness({ collections: [book("A")], prompts: [mkPrompt("p1", "A", "qa", rectAnchor(0, [100, 600, 300, 620]))] });
  const dimLayers = (i) => h.pageEl(i).children.filter((c) => c.classList.contains("dimLayer")).length;
  const perPage = () => Array.from({ length: PAGES }, (x, i) => dimLayers(i));
  const readerDim = () => h.doc.getElementById("reader").classList.contains("reader--dim");

  await h.M.reader.open("A", {});
  h.M.bus.emit("page:rendered", { pageIndex: 0 });
  assert.ok(h.pagesEl.querySelectorAll(".hl[data-id=\"p1\"]").length > 0, "highlights are drawn");
  assert.deepEqual(perPage(), [0, 0], "Dim off: no .dimLayer at all");
  assert.equal(readerDim(), false);

  assert.equal(h.M.reader.run("dim"), true);             // D: on
  assert.equal(readerDim(), true);
  assert.deepEqual(perPage(), [1, 1], "pages drawn before the toggle get one layer, not two");
  h.M.bus.emit("page:rendered", { pageIndex: 1 });
  h.M.bus.emit("scale:changed", { scale: 1 });
  assert.deepEqual(perPage(), [1, 1], "redraws add none");

  h.M.reader.run("dim");                                 // D: off
  assert.equal(readerDim(), false);
  assert.deepEqual(perPage(), [0, 0], "no orphan layer is left behind");
  h.M.reader.run("dim");                                 // D: on again
  assert.deepEqual(perPage(), [1, 1]);

  await h.M.reader.close();                              // reopen with Dim on: pdfview adds it at render
  await h.M.reader.open("A", {});
  h.M.bus.emit("page:rendered", { pageIndex: 0 });
  assert.equal(readerDim(), true);
  assert.deepEqual(perPage(), [1, 1]);
  await h.M.reader.close();
  assert.equal(readerDim(), false);
  assert.deepEqual(h.errors, []);
});

// ------------------------------------------------------------------ breakpoints, compact margin (BUILD-NOTES)

// Objects made inside the vm context have that realm's prototypes: compare them as plain data.
const plain = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
// The reader's own ResizeObserver (the one watching #reader); entries are delivered by hand.
function readerRO(h) { return h.ros.find((ro) => ro.targets.includes(h.doc.getElementById("reader"))); }
function resizeReader(h, width) { readerRO(h).cb([{ target: h.doc.getElementById("reader"), contentRect: { width, height: 800 } }]); }

test("breakpoints: wide ≥ 680 (.reader--compact below 1000), rail 600–679, stack < 600; reader:mode {mode, compact}", async () => {
  const h = harness({ collections: [book("A")] });
  const modes = [];
  h.M.bus.on("reader:mode", (e) => modes.push(e));
  await h.M.reader.open("A", {});                     // the fake #reader is 1280 wide (innerWidth)
  const reader = h.doc.getElementById("reader");
  const state = () => ["reader--wide", "reader--compact", "reader--rail", "reader--stack"].filter((c) => reader.classList.contains(c)).join(" ");
  assert.equal(state(), "reader--wide");
  assert.deepEqual(plain(modes), [{ mode: "wide", compact: false }]);
  assert.ok(readerRO(h), "the reader observes #reader");

  const expect = [
    [1000, "reader--wide", { mode: "wide", compact: false }, false],
    [999, "reader--wide reader--compact", { mode: "wide", compact: true }, true],
    [900, "reader--wide reader--compact", { mode: "wide", compact: true }, false],
    [760, "reader--wide reader--compact", { mode: "wide", compact: true }, false],
    [680, "reader--wide reader--compact", { mode: "wide", compact: true }, false],
    [679, "reader--rail", { mode: "rail", compact: false }, true],
    [640, "reader--rail", { mode: "rail", compact: false }, false],
    [600, "reader--rail", { mode: "rail", compact: false }, false],
    [599, "reader--stack", { mode: "stack", compact: false }, true],
    [400, "reader--stack", { mode: "stack", compact: false }, false],
    [1400, "reader--wide", { mode: "wide", compact: false }, true]
  ];
  for (const [w, classes, payload, changes] of expect) {
    const before = modes.length, fits = h.pv.scaleCalls.length;
    resizeReader(h, w);
    assert.equal(state(), classes, "classes at " + w);
    assert.equal(h.M.reader.mode(), payload.mode, "mode() at " + w);
    assert.equal(modes.length - before, changes ? 1 : 0, "one reader:mode per change at " + w);
    if (changes) {
      assert.deepEqual(plain(modes[modes.length - 1]), payload);
      // the fit for the new margin width is applied inside the same callback (no timer, no stale-width frame)
      assert.deepEqual(h.pv.scaleCalls.slice(fits).map((c) => c[0]), ["fit"], "synchronous refit at " + w);
    }
  }
  await h.M.reader.close();
  assert.deepEqual(h.errors, []);
});

test("the toolbar sheds Image|LaTeX first, then the labels, then Review ▾ and ?; the zoom group stays", async () => {
  const h = harness({ collections: [book("A")] });
  await h.M.reader.open("A", {});
  const tb = h.doc.getElementById("toolbar");
  // a toolbar whose content is 940 px wide; each level saves what hiding its items saves in the real bar
  Object.defineProperty(tb, "scrollWidth", { configurable: true, get() {
    let w = 940;
    if (tb.classList.contains("tb--fit-1")) w += 36 - 123;     // ⋯ shows, Image|LaTeX goes
    if (tb.classList.contains("tb--fit-2")) w -= 76;           // Library, Snip, ✎
    if (tb.classList.contains("tb--fit-3")) w -= 119;          // Review ▾, ?
    return w;
  } });
  const levels = () => [1, 2, 3].filter((k) => tb.classList.contains("tb--fit-" + k));
  tb.clientWidth = 1000; resizeReader(h, 1000);
  assert.deepEqual(levels(), [], "room for everything");
  tb.clientWidth = 900; resizeReader(h, 900);
  assert.deepEqual(levels(), [1], "Image|LaTeX goes first");
  tb.clientWidth = 800; resizeReader(h, 800);
  assert.deepEqual(levels(), [1, 2]);
  tb.clientWidth = 700; resizeReader(h, 700);
  assert.deepEqual(levels(), [1, 2, 3]);
  tb.clientWidth = 640; resizeReader(h, 640);
  assert.deepEqual(levels(), [1, 2, 3], "rail keeps the zoom group: the bar sheds the rest");
  assert.equal(tb.classList.contains("tb--measure"), false, "the measuring class never stays");
  tb.clientWidth = 400; resizeReader(h, 400);
  assert.deepEqual(levels(), [], "stack has its own fixed collapse");
  tb.clientWidth = 1400; resizeReader(h, 1400);
  assert.deepEqual(levels(), []);
  assert.ok(h.doc.querySelector(".tb-zoom-fit").parentNode.classList.contains("tb-zoom-group"), "the fit control is in the zoom group");
  await h.M.reader.close();
  assert.deepEqual(h.errors, []);
});

// ------------------------------------------------------------------ Cmd+0 and pinch zoom (BUILD-NOTES)

test("zoomFit is declined at fit width already (Cmd+0 then resets the browser zoom); the fit control lights on a manual zoom", async () => {
  const h = harness({ collections: [book("A")] });
  await h.M.reader.open("A", {});
  const fitBtn = h.doc.querySelector(".tb-zoom-fit");
  assert.equal(h.M.reader.run("zoomFit"), false, "already at fit: not handled, the keydown keeps its default");
  assert.equal(fitBtn.classList.contains("is-manual"), false);
  assert.equal(h.M.reader.run("zoomIn"), true);
  assert.equal(h.pv.mode, "manual");
  assert.equal(fitBtn.classList.contains("is-manual"), true, "manual zoom: the fit control reads as “back to fit”");
  assert.match(fitBtn.getAttribute("aria-label"), /Back to fit width/);
  assert.equal(h.M.reader.run("zoomFit"), true, "first Cmd+0: fits the page");
  assert.deepEqual(plain(h.pv.scaleCalls[h.pv.scaleCalls.length - 1]), ["fit", null]);
  assert.equal(fitBtn.classList.contains("is-manual"), false);
  const calls = h.pv.scaleCalls.length;
  assert.equal(h.M.reader.run("zoomFit"), false, "second Cmd+0: left to the browser");
  assert.equal(h.pv.scaleCalls.length, calls, "and the PDF scale is left alone");
  assert.equal(h.M.reader.run("zoomOut"), true, "zoom in / out stay consumed");
  await h.M.reader.close();
  assert.deepEqual(h.errors, []);
});

function wheel(target, o) {
  const ev = Object.assign({ type: "wheel", target, deltaMode: 0, clientX: 300, clientY: 200, ctrlKey: false, defaultPrevented: false }, o);
  ev.preventDefault = () => { ev.defaultPrevented = true; };
  target.dispatchEvent(ev);
  return ev;
}

test("pinch (ctrl+wheel): prevented, merged into one anchored gesture setScale per frame, zoom becomes manual", async () => {
  const h = harness({ collections: [book("A")] });
  await h.M.reader.open("A", {});
  const sc = h.doc.getElementById("scroller"), readout = h.doc.querySelector(".tb-zoom");
  const calls = h.pv.scaleCalls.length;
  const scrollWheel = wheel(sc, { deltaY: 40 });
  assert.equal(scrollWheel.defaultPrevented, false, "a plain wheel scrolls as usual");
  const a = wheel(sc, { ctrlKey: true, deltaY: -40 }), b = wheel(sc, { ctrlKey: true, deltaY: -40, clientX: 310, clientY: 220 });
  assert.equal(a.defaultPrevented && b.defaultPrevented, true, "the browser does not zoom the page");
  assert.equal(h.pv.scaleCalls.length, calls, "nothing is applied inside the event");
  await tick(5);
  const applied = h.pv.scaleCalls.slice(calls);
  assert.equal(applied.length, 1, "two events in one frame → one setScale");
  assert.ok(Math.abs(applied[0][0] - Math.exp(0.8)) < 1e-9, "factor exp(−ΣdeltaY · 0.01): " + applied[0][0]);
  assert.deepEqual(plain(applied[0][1]), { anchor: { clientX: 310, clientY: 220 }, gesture: true }, "anchored at the latest pointer");
  assert.equal(readout.textContent, Math.round(Math.exp(0.8) / 1.3333 * 100) + "%", "the readout follows");
  assert.equal(h.doc.querySelector(".tb-zoom-fit").classList.contains("is-manual"), true);
  assert.equal(h.M.reader.run("zoomFit"), true, "a pinched zoom is manual: Cmd+0 fits it");

  // pinch in far: clamped to MIN_SCALE
  for (let k = 0; k < 40; k++) wheel(sc, { ctrlKey: true, deltaY: 50 });
  await tick(5);
  assert.equal(h.pv.scaleCalls[h.pv.scaleCalls.length - 1][0], 0.2);

  // Safari: gesturestart / gesturechange / gestureend (scale = start · ev.scale); ctrl+wheel during it is ignored
  h.M.reader.run("zoomFit");
  const gs = wheel(sc, { type: "gesturestart", scale: 1 });
  assert.equal(gs.defaultPrevented, true);
  const n0 = h.pv.scaleCalls.length;
  wheel(sc, { type: "gesturechange", scale: 1.5 });
  const mid = wheel(sc, { ctrlKey: true, deltaY: -40 });
  assert.equal(mid.defaultPrevented, true);
  wheel(sc, { type: "gesturechange", scale: 2, clientX: 120, clientY: 90 });
  await tick(5);
  assert.deepEqual(plain(h.pv.scaleCalls.slice(n0)), [[2, { anchor: { clientX: 120, clientY: 90 }, gesture: true }]], "start 1 · scale 2, once");
  assert.equal(wheel(sc, { type: "gestureend", scale: 2 }).defaultPrevented, true);
  await h.M.reader.close();
  assert.equal(wheel(sc, { ctrlKey: true, deltaY: -40 }).defaultPrevented, false, "no book open: the listeners are gone");
  assert.deepEqual(h.errors, []);
});

// ------------------------------------------------------------------ stack clamp, no-op pinch steps, width changes

test("stack mode clamps to the fit computed now (M.pdfview.fitScale): after a resize from a manual zoom, a reopen with a saved zoom, a pinch", async () => {
  const h = harness({ collections: [book("A")] });
  h.pv.fit = 1.6667;                                   // 1400 px: fit width is capped at 1.6667
  await h.M.reader.open("A", {});
  assert.equal(h.pv.scale, 1.6667);
  assert.equal(h.M.reader.run("zoomOut"), true);
  assert.equal(h.pv.scale, 1.5, "Cmd+− from fit: manual 1.5");
  h.pv.fit = 0.6;                                      // the 400-px column
  resizeReader(h, 400);
  assert.equal(h.M.reader.mode(), "stack");
  assert.deepEqual(plain(h.pv.scaleCalls[h.pv.scaleCalls.length - 1]), ["fit", null], "1.5 does not fit the column: shown at fit width");
  assert.equal(h.pv.scale, 0.6);
  const sc = h.doc.getElementById("scroller");
  sc.scrollLeft = 120;                                 // a leftover sideways scroll cannot stay in stack (overflow-x hidden)
  let n = h.pv.scaleCalls.length;
  assert.equal(wheel(sc, { ctrlKey: true, deltaY: -50 }).defaultPrevented, true);
  await tick(5);
  assert.equal(h.pv.scale, 0.6, "a pinch out cannot pass fit width");
  assert.ok(h.pv.scaleCalls.slice(n).every((c) => c[0] === "fit"), "only fit");
  assert.equal(sc.scrollLeft, 0);
  n = h.pv.scaleCalls.length;
  wheel(sc, { ctrlKey: true, deltaY: -50 });
  await tick(5);
  assert.equal(h.pv.scaleCalls.length, n, "at fit already: nothing to apply");
  h.M.reader.run("zoomIn");
  assert.equal(h.pv.scaleCalls.length, n, "Cmd+= at fit width: nothing");
  wheel(sc, { ctrlKey: true, deltaY: 50 });
  await tick(5);
  assert.ok(Math.abs(h.pv.scale - 0.6 * Math.exp(-0.5)) < 1e-9, "below fit is allowed: " + h.pv.scale);
  h.M.reader.run("zoomIn");
  assert.equal(h.pv.scale, 0.5, "the ladder below fit");
  h.M.reader.run("zoomIn");
  assert.equal(h.pv.scale, 0.6, "the next rung (0.67) is past fit: clamped to fit width");
  assert.equal(h.pv.mode, "fit");
  await h.M.reader.close();

  // reopened with a zoom saved at another width: the clamp applies at once (there is no earlier fit to remember)
  h.cache.collection("A").lastPosition = { pageIndex: 0, fraction: 0, zoom: 1.5 };
  h.win.innerWidth = 400;
  h.pv.fit = 0.6;
  n = h.pv.scaleCalls.length;
  await h.M.reader.open("A", {});
  assert.equal(h.M.reader.mode(), "stack");
  assert.deepEqual(plain(h.pv.scaleCalls.slice(n)), [["fit", null]]);
  assert.equal(h.pv.scale, 0.6);
  wheel(h.doc.getElementById("scroller"), { ctrlKey: true, deltaY: -50 });
  await tick(5);
  assert.equal(h.pv.scale, 0.6, "and a pinch cannot pass it");
  // a width change within stack refits as well (the clamp follows the column)
  h.pv.fit = 0.62;
  resizeReader(h, 420);
  assert.equal(h.pv.scale, 0.62);
  await h.M.reader.close();
  assert.deepEqual(h.errors, []);
});

test("a pinch step that changes nothing leaves fit as fit (Safari scale 1 or a rotation, a sideways ctrl+wheel)", async () => {
  const h = harness({ collections: [book("A")] });
  await h.M.reader.open("A", {});
  const sc = h.doc.getElementById("scroller"), fitBtn = h.doc.querySelector(".tb-zoom-fit");
  const n = h.pv.scaleCalls.length;
  assert.equal(wheel(sc, { type: "gesturestart", scale: 1 }).defaultPrevented, true);
  assert.equal(wheel(sc, { type: "gesturechange", scale: 1 }).defaultPrevented, true);
  await tick(5);
  assert.equal(wheel(sc, { type: "gestureend", scale: 1 }).defaultPrevented, true);
  const side = wheel(sc, { ctrlKey: true, deltaY: 0, deltaX: 30 });
  assert.equal(side.defaultPrevented, true, "no browser zoom either");
  await tick(5);
  assert.equal(h.pv.scaleCalls.length, n, "no setScale");
  assert.equal(h.pv.mode, "fit");
  assert.equal(fitBtn.classList.contains("is-manual"), false);
  assert.equal(h.M.reader.run("zoomFit"), false, "still at fit width: Cmd+0 is left to the browser");
  await h.M.reader.close();
  assert.deepEqual(h.errors, []);
});

test("every width change refits inside the ResizeObserver callback: a breakpoint at once, any other as a gesture step", async () => {
  const h = harness({ collections: [book("A")] });
  await h.M.reader.open("A", {});
  resizeReader(h, 999);                                // a breakpoint (compact): re-rendered at once
  let n = h.pv.scaleCalls.length;
  resizeReader(h, 960);                                // same mode, new width
  assert.deepEqual(plain(h.pv.scaleCalls.slice(n)), [["fit", { gesture: true }]], "synchronous, no 120-ms timer");
  n = h.pv.scaleCalls.length;
  resizeReader(h, 960);                                // a height-only change: nothing
  assert.equal(h.pv.scaleCalls.length, n);
  h.M.reader.run("zoomIn");
  n = h.pv.scaleCalls.length;
  resizeReader(h, 930);                                // a manual zoom stays as it is in wide mode
  assert.equal(h.pv.scaleCalls.length, n);
  await tick(200);
  assert.equal(h.pv.scaleCalls.length, n, "and no timer refits it later");
  await h.M.reader.close();
  assert.deepEqual(h.errors, []);
});

// ------------------------------------------------------------------ the page band beside a pinned margin

test("find and goToAnchor bring the target into the page band beside a pinned margin; scrollLeftFor gives J / K the same", async () => {
  const h = harness({ collections: [book("A")] });
  await h.M.reader.open("A", {});
  resizeReader(h, 760);                                // compact: the 224-px margin
  const sc = h.doc.getElementById("scroller"), mg = h.doc.getElementById("margin");
  // a page zoomed past the room beside the margin: the row is 1166 wide in a 760-px scroller, the margin pinned
  Object.assign(sc, { clientWidth: 760, scrollWidth: 1166, clientHeight: 800, scrollLeft: 0, scrollTop: 0 });
  sc.rect = { left: 0, top: 0, width: 760, height: 800 };
  mg.offsetWidth = 224;
  h.pageEl(0).rect = { left: 24, top: 0, width: PAGE_W, height: PAGE_H };
  // a passage at x 500–560 of the page: content x 524–584, under the margin (536–760) at scrollLeft 0
  const anchor = rectAnchor(0, [500, 400, 560, 410]);
  const want = Math.round(524 - 24 - (760 - 224 - 48) / 3);   // a third into the band [24, 512]
  assert.equal(h.M.reader.scrollLeftFor(anchor), want);
  assert.equal(h.M.reader.goToAnchor(anchor, { flash: false }), true);
  assert.equal(sc.scrollLeft, want, "G / Go to passage / Go to source");
  // in view now (the page has moved left with the scroll): nothing to do
  h.pageEl(0).rect = { left: 24 - want, top: 0, width: PAGE_W, height: PAGE_H };
  assert.equal(h.M.reader.scrollLeftFor(anchor), null);
  // the find match takes the same path
  sc.scrollLeft = 0;
  h.pageEl(0).rect = { left: 24, top: 0, width: PAGE_W, height: PAGE_H };
  h.M.pdfview.find = () => Promise.resolve([{ pageIndex: 0, start: 0, end: 6 }]);
  h.M.pdfview.textIndex = () => Promise.resolve({ text: "target", starts: [0], items: [{ str: "target", x: 500, y: 400, width: 60, height: 10, hasEOL: false, divIndex: 0 }] });
  assert.equal(h.M.reader.setFind("target"), true);
  await tick(5);
  assert.equal(sc.scrollLeft, want, "the current match lands beside the margin, not under it");
  // a passage already inside the band does not move the page; a page that fits never scrolls sideways
  sc.scrollLeft = 0;
  assert.equal(h.M.reader.scrollLeftFor(rectAnchor(0, [100, 400, 200, 410])), null);
  sc.scrollWidth = 760;
  assert.equal(h.M.reader.scrollLeftFor(anchor), null);
  // stack mode never scrolls sideways
  sc.scrollWidth = 1166;
  resizeReader(h, 400);
  assert.equal(h.M.reader.scrollLeftFor(anchor), null);
  await h.M.reader.close();
  assert.deepEqual(h.errors, []);
});

// ------------------------------------------------------------------ O: a note for Obsidian (BUILD-NOTES "Obsidian")

test("O and the adder's fourth action open the margin editor on the selection with empty text and the Obsidian save", async () => {
  const h = harness({ collections: [book("A")] });
  await h.M.reader.open("A", {});
  const calls = [];
  h.M.margin.openEditor = (o) => { calls.push(o); return {}; };
  const anchor = rectAnchor(0, [100, 600, 300, 620]);

  // objects made inside the vm context have its prototypes: compare field by field (the anchor is the snapshot itself)
  const call = (o) => ({ promptId: o.promptId, anchor: o.anchor, initialText: o.initialText, obsidian: o.obsidian, keys: Object.keys(o).sort().join() });
  h.M.reader.selection = anchor;
  assert.equal(h.M.reader.run("obsidianNote"), true);
  assert.deepEqual(call(calls[0]), { promptId: null, anchor, initialText: "", obsidian: true, keys: "anchor,initialText,obsidian,promptId" });

  const btns = h.doc.getElementById("adder").querySelectorAll(".adder__btn");
  assert.deepEqual(btns.map((b) => b.dataset.kind), ["qa", "cloze", "highlight", "obsidian"]);
  const ob = btns[3];
  assert.equal(ob.querySelector(".adder__key").textContent, "O");
  assert.equal(ob.querySelector(".adder__label").textContent, "Note → Obsidian");
  assert.ok(ob.querySelector(".adder__label-pre"), "the “Note → ” part (hidden in stack mode)");
  assert.equal(ob.getAttribute("aria-label"), "Note → Obsidian (O)");
  h.M.reader.selection = anchor;
  let prevented = false;
  ob.dispatchEvent({ type: "click", preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(call(calls[1]), { promptId: null, anchor, initialText: "", obsidian: true, keys: "anchor,initialText,obsidian,promptId" });

  // N keeps its own editor: "Q. " and no Obsidian save
  h.M.reader.selection = anchor;
  assert.equal(h.M.reader.run("prompt"), true);
  assert.equal(calls[2].initialText, "Q. ");
  assert.equal(calls[2].obsidian, undefined);
  await h.M.reader.close();
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.toasts, []);
});

test("O without a selection makes a free note at the middle of the visible page with the Obsidian save (like N)", async () => {
  const h = harness({ collections: [book("A")] });
  await h.M.reader.open("A", {});
  const calls = [];
  h.M.margin.openEditor = (o) => { calls.push(o); return {}; };
  h.M.reader.selection = null;
  assert.equal(h.M.reader.run("obsidianNote"), true);
  assert.equal(calls.length, 1);
  const o = calls[0];
  assert.equal(o.promptId, null);
  assert.equal(o.initialText, "");
  assert.equal(o.obsidian, true);
  assert.equal(o.anchor.pageIndex, 0);
  assert.equal(o.anchor.quote, "");
  assert.equal(o.anchor.pages.length, 0, "a free note: no rects");
  assert.equal(typeof o.anchor.y, "number");

  assert.equal(h.M.reader.run("prompt"), true, "N without a selection: the same free note, as a prompt");
  assert.equal(calls[1].initialText, "Q. ");
  assert.equal(calls[1].obsidian, undefined);
  assert.equal(calls[1].anchor.y, o.anchor.y, "both at the middle of the visible page");
  await h.M.reader.close();
  assert.equal(h.M.reader.run("obsidianNote"), false, "nothing open: nothing to note");
  assert.deepEqual(h.errors, []);
});

test("with the Obsidian connection off (DECISIONS D32) the adder has no fourth action and O does nothing; switched on, both are back", async () => {
  const h = harness({ collections: [book("A")], settings: { obsidian: false } });
  await h.M.reader.open("A", {});
  const calls = [];
  h.M.margin.openEditor = (o) => { calls.push(o); return {}; };
  const anchor = rectAnchor(0, [100, 600, 300, 620]);
  const btns = () => h.doc.getElementById("adder").querySelectorAll(".adder__btn");
  const shown = () => btns().filter((b) => !b.classList.contains("is-hidden")).map((b) => b.dataset.kind);
  assert.deepEqual(shown(), ["qa", "cloze", "highlight"], "no Note → Obsidian in the adder");
  h.M.reader.selection = anchor;
  assert.equal(h.M.reader.run("obsidianNote"), false, "O does nothing on a selection");
  h.M.reader.selection = null;
  assert.equal(h.M.reader.run("obsidianNote"), false, "and makes no free note");
  assert.equal(calls.length, 0);
  // a click on the hidden button (a page script, or a stale layout) opens nothing either
  h.M.reader.selection = anchor;
  btns().find((b) => b.dataset.kind === "obsidian").dispatchEvent({ type: "click", preventDefault() {} });
  assert.equal(calls.length, 0);
  // N is as before
  h.M.reader.selection = anchor;
  assert.equal(h.M.reader.run("prompt"), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].obsidian, undefined);

  // switched on in Settings › Obsidian: the action and the key are back, without opening the book again
  h.M.settings.set("obsidian", true);
  assert.deepEqual(shown(), ["qa", "cloze", "highlight", "obsidian"]);
  h.M.reader.selection = anchor;
  assert.equal(h.M.reader.run("obsidianNote"), true);
  assert.equal(calls[1].obsidian, true);
  // and switched off again
  h.M.settings.set("obsidian", false);
  assert.deepEqual(shown(), ["qa", "cloze", "highlight"]);
  h.M.reader.selection = anchor;
  assert.equal(h.M.reader.run("obsidianNote"), false);
  assert.equal(calls.length, 2);
  await h.M.reader.close();
  assert.deepEqual(h.errors, []);
});

test("the adder looks at the Obsidian connection each time it shows: the never-chosen state turns on with the first sent card (DECISIONS D32)", async () => {
  const h = harness({ collections: [book("A")] });
  await h.M.reader.open("A", {});
  let on = false;
  h.M.obsidian = { enabled: () => on };                    // changes without a settings:changed, as a first send does
  const pages = h.doc.getElementById("pages"), adder = h.doc.getElementById("adder");
  const inPage = pages.children[0] || pages;
  const box = { left: 100, right: 300, top: 200, bottom: 220, width: 200, height: 20 };
  let placed = 0;                                          // how often the adder took its place from the selection
  const range = { commonAncestorContainer: inPage, getClientRects: () => { placed++; return [box]; }, getBoundingClientRect: () => box };
  const anchor = rectAnchor(0, [100, 600, 300, 620]);
  h.M.anchors.fromSelection = () => anchor;
  h.doc.getSelection = () => ({ rangeCount: 1, isCollapsed: false, removeAllRanges() {}, getRangeAt: () => range });
  const shown = () => adder.querySelectorAll(".adder__btn").filter((b) => !b.classList.contains("is-hidden")).map((b) => b.dataset.kind);
  // the document's selectionchange listeners (this fake document keeps them in doc.listeners), then the reader's 50-ms wait
  const select = async () => {
    const fns = (h.doc.listeners.selectionchange || []).slice();
    assert.ok(fns.length > 0, "the reader listens for selectionchange");
    fns.forEach((fn) => fn({ type: "selectionchange" }));
    await new Promise((r) => setTimeout(r, 90));
  };
  await select();
  assert.equal(adder.classList.contains("is-hidden"), false, "the selection shows the adder");
  assert.equal(h.M.reader.selection, anchor);
  assert.deepEqual(shown(), ["qa", "cloze", "highlight"]);
  on = true;                                               // the first card went to Obsidian (or a backup brought one)
  await select();
  assert.deepEqual(shown(), ["qa", "cloze", "highlight", "obsidian"], "the next selection offers Note → Obsidian");
  on = false;
  await select();
  assert.deepEqual(shown(), ["qa", "cloze", "highlight"]);
  // the switch changes while the adder shows: one button more, and the adder takes its place again
  const before = placed;
  on = true;
  h.M.bus.emit("settings:changed", { key: "obsidian", value: true });
  assert.deepEqual(shown(), ["qa", "cloze", "highlight", "obsidian"]);
  assert.equal(placed, before + 1, "placed again for its new width");
  h.M.bus.emit("settings:changed", { key: "dimPages", value: false });
  assert.equal(placed, before + 1, "another setting does not move it");
  await h.M.reader.close();
  assert.deepEqual(h.errors, []);
});

test("a page without M.obsidian has no Obsidian action either (DECISIONS D32)", async () => {
  const h = harness({ collections: [book("A")] });
  delete h.M.obsidian;
  await h.M.reader.open("A", {});
  const calls = [];
  h.M.margin.openEditor = (o) => { calls.push(o); return {}; };
  assert.deepEqual(h.doc.getElementById("adder").querySelectorAll(".adder__btn").filter((b) => !b.classList.contains("is-hidden")).map((b) => b.dataset.kind),
    ["qa", "cloze", "highlight"]);
  h.M.reader.selection = rectAnchor(0, [100, 600, 300, 620]);
  assert.equal(h.M.reader.run("obsidianNote"), false);
  assert.equal(calls.length, 0);
  await h.M.reader.close();
  assert.deepEqual(h.errors, []);
});

// ------------------------------------------------------------------ prompt links (#reader/<cid>/<pid>, BUILD-NOTES "Obsidian")

test("a prompt link to a deleted, unknown or moved note says so and keeps the position; a fresh open falls back to the last position", async () => {
  const live = mkPrompt("p_live", "A", "qa", rectAnchor(1, [100, 400, 300, 420]));
  const gone = Object.assign(mkPrompt("p_gone", "A", "qa", rectAnchor(0, [100, 700, 300, 720])), { deletedAt: 5 });
  const moved = mkPrompt("p_moved", "B", "qa", rectAnchor(0, [100, 700, 300, 720]));
  const A = Object.assign(book("A"), { lastPosition: { pageIndex: 1, fraction: 0.5, zoom: "fit" } });
  const h = harness({ collections: [A, book("B")], prompts: [live, gone, moved] });
  const scrolls = [];
  h.M.pdfview.scrollTo = (o) => { scrolls.push(JSON.parse(JSON.stringify(o))); };   // a plain copy (the vm realm)
  const sc = h.doc.getElementById("scroller");
  Object.assign(sc, { clientHeight: 800, clientWidth: 1000, scrollWidth: 1000 });

  await h.M.reader.open("A", { promptId: "p_live" });        // a live note: its passage and its card
  assert.ok(sc.scrollTop > 0, "scrolled to the passage on page 2");
  assert.deepEqual(h.marginCalls.focus, ["p_live"]);
  assert.deepEqual(h.toasts, []);

  for (const pid of ["p_gone", "p_nope", "p_moved"]) {        // the book is open: a dead link moves nothing
    sc.scrollTop = 1234;
    scrolls.length = 0;
    await h.M.reader.open("A", { promptId: pid });
    assert.equal(sc.scrollTop, 1234, pid + ": the reader stays where it was");
    assert.deepEqual(scrolls, [], pid + ": no jump to the last position");
    assert.deepEqual(h.marginCalls.focus, ["p_live"], pid + ": no other card is focused");
    assert.equal(h.toasts[h.toasts.length - 1], "That note is no longer in this book");
  }
  assert.equal(h.toasts.length, 3);

  await h.M.reader.close();                                   // a fresh open with a dead link: the last position
  scrolls.length = 0;
  await h.M.reader.open("A", { promptId: "p_gone" });
  assert.equal(h.toasts.length, 4);
  assert.deepEqual(scrolls, [{ pageIndex: 1, fraction: 0.5 }]);
  await h.M.reader.close();
  assert.deepEqual(h.errors, []);
});

test("an open that is replaced while the engine loads ends quietly; the book that came after it stays (D30: quick tab changes)", async () => {
  const h = harness({ collections: [book("A"), book("B")] });
  const realOpen = h.M.pdfview.open;
  // the engine: the first load hangs until the test ends it with the error PDF.js gives when its worker is destroyed
  let giveUp = null;
  h.M.pdfview.open = (bytes, o) => {
    if (giveUp === null) return new Promise((resolve, reject) => { giveUp = () => reject(Object.assign(new Error("Worker was destroyed"), { code: "engine" })); });
    return realOpen(bytes, o);
  };
  const waitFor = async (pred) => { for (let i = 0; i < 200 && !pred(); i++) await new Promise((r) => setTimeout(r, 1)); assert.ok(pred()); };
  // the book starts to load; the user leaves (‹ Library, another tab) before it is open; the engine gives up
  const first = h.M.reader.open("A", {});
  await waitFor(() => typeof giveUp === "function");
  await h.M.reader.close();
  giveUp();
  assert.equal(await first, undefined, "the replaced open ends without an error");
  assert.deepEqual(h.toasts, [], "no notice about a book that is fine");
  assert.equal(h.M.reader.isOpen(), false);
  // away and back at once: the first load's error comes while the same book loads again. The second open stays.
  giveUp = null;
  const one = h.M.reader.open("A", {});
  await waitFor(() => typeof giveUp === "function");
  const end = giveUp;
  await h.M.reader.close();
  const two = h.M.reader.open("A", {});                       // (the engine stand-in loads this one at once)
  end();
  assert.equal(await one, undefined);
  await two;
  assert.equal(h.M.reader.isOpen("A"), true, "the book is open");
  assert.deepEqual(h.toasts, []);
  await h.M.reader.close();
  // an open that nothing replaced still fails loudly, as before
  giveUp = null;
  const bad = h.M.reader.open("B", {});
  await waitFor(() => typeof giveUp === "function");
  giveUp();
  await assert.rejects(bad, /Worker was destroyed/);
  assert.equal(h.toasts.length, 1);
  assert.equal(h.M.reader.isOpen(), false);
});

// ------------------------------------------------------------------ the place of a window that is not the writer (D31)

test("a window that is not the writer holds its book's place back, and stores it when the role comes (D31)", async () => {
  const A = Object.assign(book("A"), { lastPosition: { pageIndex: 0, fraction: 0, zoom: "fit" } });
  const h = harness({ collections: [A], prompts: [] });
  let reason = null;                                          // what M.store.locked() says; null: this window writes
  h.M.store.locked = () => (reason ? { reason } : null);
  const saves = [];
  const save = h.cache.saveCollection;
  h.cache.saveCollection = (c) => { saves.push(JSON.parse(JSON.stringify(c.lastPosition))); return save(c); };
  assert.equal(h.M.reader.unsaved(), false, "no book is open");
  await h.M.reader.open("A", {});
  saves.length = 0;
  // the writer: a scroll that settled is stored at once
  h.M.bus.emit("scroll:settled", { pageIndex: 1, fraction: 0.5 });
  assert.deepEqual(saves, [{ pageIndex: 1, fraction: 0.5, zoom: "fit" }]);
  assert.equal(h.M.reader.unsaved(), false);
  // another window has the role: nothing is written, and this window's copy of the record is not touched
  reason = "window";
  h.M.bus.emit("scroll:settled", { pageIndex: 1, fraction: 0.9 });
  assert.equal(saves.length, 1);
  assert.deepEqual(plain(h.cache.collection("A").lastPosition), { pageIndex: 1, fraction: 0.5, zoom: "fit" });
  assert.equal(h.M.reader.unsaved(), true);
  // the role went to yet another window: still held back
  h.M.bus.emit("store:writer", { writer: false });
  assert.equal(saves.length, 1);
  assert.equal(h.M.reader.unsaved(), true);
  // the role comes: the place goes into the store, once
  reason = null;
  h.M.bus.emit("store:writer", { writer: true });
  assert.deepEqual(saves[1], { pageIndex: 1, fraction: 0.9, zoom: "fit" });
  assert.equal(h.M.reader.unsaved(), false);
  h.M.bus.emit("store:writer", { writer: true });
  assert.equal(saves.length, 2, "nothing held back: nothing is written");
  // a tab that stepped aside in a browser (the legacy rule) is not this case: M.cache refuses that write itself
  reason = "othertab";
  h.M.bus.emit("scroll:settled", { pageIndex: 0, fraction: 0.2 });
  assert.equal(saves.length, 3, "as before D31: the call goes to M.cache");
  assert.equal(h.M.reader.unsaved(), false);
  // the book closes: nothing is held back any more
  reason = "window";
  h.M.bus.emit("scroll:settled", { pageIndex: 0, fraction: 0.4 });
  assert.equal(h.M.reader.unsaved(), true);
  await h.M.reader.close();
  assert.equal(h.M.reader.unsaved(), false);
  assert.deepEqual(h.errors, []);
});

// ------------------------------------------------------------------ the small picture of a tab that is dragged (D31)

test("snapshot(w, h): a small canvas of the pages in view, cut to the view and to the pages' column; null without a page drawn", async () => {
  const h = harness({ collections: [book("A")], prompts: [] });
  assert.equal(h.M.reader.snapshot(220, 126), null, "no book is open");
  await h.M.reader.open("A", {});
  const scroller = h.doc.getElementById("scroller"), pages = h.doc.getElementById("pages");
  // the view: 1000 wide from x = 0, 600 high from y = 80; the pages' column: 600 wide from x = 200
  scroller.getBoundingClientRect = () => ({ left: 0, top: 80, right: 1000, bottom: 680, width: 1000, height: 600 });
  pages.getBoundingClientRect = () => ({ left: 200, top: -120, right: 800, bottom: 5000, width: 600, height: 5120 });
  // three page canvases (1200 × 1600 pixels for 600 × 800 CSS pixels): the first ends in the view, the second begins
  // in it, the third is below it; one more was never drawn
  const canvas = (top, w, hgt) => ({ width: w, height: hgt, getBoundingClientRect: () => ({ left: 200, top, right: 800, bottom: top + 800, width: 600, height: 800 }) });
  const list = [canvas(-520, 1200, 1600), canvas(300, 1200, 1600), canvas(1120, 1200, 1600), canvas(400, 0, 0)];
  pages.querySelectorAll = (sel) => (sel === "canvas" ? list : []);
  const drawn = [];
  let out = null;
  const create = h.doc.createElement.bind(h.doc);
  h.doc.createElement = (tag) => {
    if (tag !== "canvas") return create(tag);
    out = { width: 0, height: 0, getContext: () => ({ scale() {}, drawImage: (...a) => drawn.push(a.map((x) => (typeof x === "number" ? Math.round(x * 100) / 100 : x))) }) };
    return out;
  };
  const shot = h.M.reader.snapshot(220, 126);
  assert.ok(shot === out);
  // 220 wide for the 600 of the column: scale 0.3667; 126 high shows 343.6 CSS pixels of the view (y 80 … 423.6)
  assert.deepEqual([shot.width, shot.height], [220, 126]);
  assert.equal(drawn.length, 2, "the two canvases that are in view");
  // the first canvas: its last 200 CSS pixels (y 80 … 280) → source y 1200 … 1600, drawn at the top
  assert.ok(drawn[0][0] === list[0]);
  assert.deepEqual(drawn[0].slice(1), [0, 1200, 1200, 400, 0, 0, 220, 73.33]);
  // the second canvas: from y 300 to the picture's end (423.64) → its first 123.64 CSS pixels, drawn below the first
  assert.ok(drawn[1][0] === list[1]);
  assert.deepEqual(drawn[1].slice(1), [0, 0, 1200, 247.27, 0, 80.67, 220, 45.33]);
  // a view that is lower than the picture's place: the picture is as high as what the view shows (150 CSS pixels → 55)
  scroller.getBoundingClientRect = () => ({ left: 0, top: 80, right: 1000, bottom: 230, width: 1000, height: 150 });
  drawn.length = 0;
  const low = h.M.reader.snapshot(220, 126);
  assert.deepEqual([low.width, low.height], [220, 55]);
  assert.equal(drawn.length, 1, "the first canvas alone reaches into this view");
  scroller.getBoundingClientRect = () => ({ left: 0, top: 80, right: 1000, bottom: 680, width: 1000, height: 600 });
  // sizes that make no sense: no picture (with drawn pages in view)
  for (const [w, hgt] of [[0, 126], [220, 0], [-220, 126], [220, -1], [NaN, 126], [220, NaN]]) assert.equal(h.M.reader.snapshot(w, hgt), null, w + " × " + hgt);
  assert.ok(h.M.reader.snapshot(220, 126), "(a size that makes sense still gives one)");
  // nothing drawn yet (the pages are still empty): no picture
  list.length = 0;
  list.push(canvas(100, 0, 0));
  assert.equal(h.M.reader.snapshot(220, 126), null);
  // a page without canvas support: no picture, no error
  h.doc.createElement = create;
  list.length = 0;
  list.push(canvas(100, 1200, 1600));
  assert.equal(h.M.reader.snapshot(220, 126), null, "this page cannot make a canvas");
  await h.M.reader.close();
  assert.equal(h.M.reader.snapshot(220, 126), null);
  assert.deepEqual(h.errors, []);
});

// ------------------------------------------------------------------ a tab's own place in a book (D30, BUILD-NOTES "Tabs")

test("a tab's own place: open(id, {position}) opens there, not at the last position; position() is the view's place now", async () => {
  const A = Object.assign(book("A"), { lastPosition: { pageIndex: 1, fraction: 0.5, zoom: "fit" } });
  const h = harness({ collections: [A, book("B")], prompts: [] });
  const scrolls = [];
  let cur = { pageIndex: 0, fraction: 0 };                    // where the view is (M.pdfview.currentPage)
  h.M.pdfview.scrollTo = (o) => { scrolls.push(JSON.parse(JSON.stringify(o))); cur = { pageIndex: o.pageIndex, fraction: o.fraction || 0 }; };
  h.M.pdfview.currentPage = () => cur;
  const place = () => plain(h.M.reader.position());
  assert.equal(h.M.reader.position(), null, "no book is open");

  // a fresh open at a tab's place: that place and its zoom, not the book's last position
  let n = h.pv.scaleCalls.length;
  await h.M.reader.open("A", { position: { pageIndex: 0, fraction: 0.25, zoom: 1.5 } });
  assert.deepEqual(scrolls, [{ pageIndex: 0, fraction: 0.25 }]);
  assert.deepEqual(plain(h.pv.scaleCalls.slice(n).map((c) => c[0])), [1.5]);
  assert.deepEqual(place(), { pageIndex: 0, fraction: 0.25, zoom: 1.5 });
  // the view was scrolled: position() says so at once (scroll:settled comes a second later)
  cur = { pageIndex: 1, fraction: 0.75 };
  assert.deepEqual(place(), { pageIndex: 1, fraction: 0.75, zoom: 1.5 });

  // the book is open already and another tab of it is shown: the view takes that tab's zoom and moves to its place
  scrolls.length = 0;
  n = h.pv.scaleCalls.length;
  await h.M.reader.open("A", { position: { pageIndex: 0, fraction: 0.1, zoom: "fit" } });
  assert.deepEqual(scrolls, [{ pageIndex: 0, fraction: 0.1 }]);
  assert.deepEqual(plain(h.pv.scaleCalls.slice(n).map((c) => c[0])), ["fit"]);
  assert.deepEqual(place(), { pageIndex: 0, fraction: 0.1, zoom: "fit" });
  n = h.pv.scaleCalls.length;
  await h.M.reader.open("A", { position: { pageIndex: 0, fraction: 0.1, zoom: "fit" } });
  assert.equal(h.pv.scaleCalls.length, n, "the same zoom is not set again");
  // … and without a place an open book stays where it is, as before
  scrolls.length = 0;
  await h.M.reader.open("A", {});
  assert.deepEqual(scrolls, []);
  // closing saves the book's last position as before: it is the place of the tab that was on screen
  await h.M.reader.close();
  assert.equal(h.M.reader.position(), null);
  assert.deepEqual(plain(h.cache.collection("A").lastPosition), { pageIndex: 0, fraction: 0.1, zoom: "fit" });

  // a fresh open without a place, or with something that is no place: the book's last position, as before
  for (const position of [undefined, null, { pageIndex: -4 }, { pageIndex: "1" }, "x"]) {
    h.cache.collection("A").lastPosition = { pageIndex: 1, fraction: 0.5, zoom: "fit" };
    scrolls.length = 0;
    await h.M.reader.open("A", { position });
    assert.deepEqual(scrolls, [{ pageIndex: 1, fraction: 0.5 }], JSON.stringify(position));
    await h.M.reader.close();
  }
  // a place past the last page (the PDF was replaced by a shorter one) is the last page
  scrolls.length = 0;
  await h.M.reader.open("A", { position: { pageIndex: 9, fraction: 2, zoom: "fit" } });
  assert.deepEqual(scrolls, [{ pageIndex: 1, fraction: 1 }]);
  await h.M.reader.close();

  // A second tab of the book is shown while the book still loads for the first one: the book opens at the place and
  // with the zoom that was asked last. isOpen() says when the book is really there.
  assert.equal(h.M.reader.isOpen(), false);
  assert.equal(h.M.reader.isOpen("A"), false);
  scrolls.length = 0;
  n = h.pv.scaleCalls.length;
  const first = h.M.reader.open("A", { position: { pageIndex: 0, fraction: 0.25, zoom: 1.5 } });
  await Promise.resolve();                                    // the load is under way, the document is not there yet
  assert.equal(h.M.reader.isOpen("A"), false, "still loading");
  assert.equal(h.M.reader.position(), null);
  await h.M.reader.open("A", { position: { pageIndex: 1, fraction: 0.5, zoom: 2 } });   // answers at once: the place waits
  assert.equal(h.M.reader.isOpen("A"), false, "the answer came before the book");
  await first;
  assert.equal(h.M.reader.isOpen("A"), true);
  assert.equal(h.M.reader.isOpen(), true);
  assert.equal(h.M.reader.isOpen("B"), false);
  assert.deepEqual(scrolls, [{ pageIndex: 1, fraction: 0.5 }], "the place asked last, once");
  assert.equal(plain(h.pv.scaleCalls.slice(n).map((c) => c[0])).pop(), 2, "and its zoom");
  assert.deepEqual(place(), { pageIndex: 1, fraction: 0.5, zoom: 2 });
  await h.M.reader.close();
  assert.equal(h.M.reader.isOpen("A"), false);
  assert.deepEqual(h.errors, []);
});

// ------------------------------------------------------------------ C and a "::" in the selection (FEATURES P1.1 e)

test("C wraps the selection in braces and writes a :: inside it as \\::, so selected text never makes a cue", async () => {
  const h = harness({ collections: [book("A")] });
  vm.runInContext(fs.readFileSync(path.join(JS, "prompts.js"), "utf8"), h.win, { filename: "js/prompts.js" });
  await h.M.reader.open("A", {});
  const calls = [];
  h.M.margin.openEditor = (o) => { calls.push(o); return {}; };
  const selected = (pageIndex, quote, prefix) => Object.assign(rectAnchor(pageIndex, [100, 600, 300, 620]), { quote, prefix: prefix || "" });
  const cuesOf = (text) => h.M.prompts.parse(text).deletions.filter((d) => "cue" in d).length;

  // the sentence around the selection: only the wrapped part is escaped
  const text = "Use std::map here. The ratio a::b of the std::vector sizes is fixed. Next.";
  h.M.pdfview.textIndex = () => Promise.resolve({ text, starts: [0], items: [{ str: text, x: 72, y: 700, width: 440, height: 12, hasEOL: true, divIndex: 0 }] });
  h.M.reader.selection = selected(0, "ratio a::b of", "The ");
  assert.equal(h.M.reader.run("cloze"), true);
  await tick(5);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].initialText, "The {ratio a\\::b of} the std::vector sizes is fixed.");
  assert.equal(calls[0].promptId, null);
  assert.equal(cuesOf(calls[0].initialText), 0);
  assert.equal(h.M.prompts.parse(calls[0].initialText).deletions.length, 1);

  // no text index for the page (the read fails): the braced selection, escaped the same way
  h.M.pdfview.textIndex = () => Promise.reject(new Error("no text"));
  h.M.reader.selection = selected(1, "x::y and a:::b");
  assert.equal(h.M.reader.run("cloze"), true);
  await tick(5);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].initialText, "{x\\::y and a\\:::b}");
  assert.equal(cuesOf(calls[1].initialText), 0);

  // a text index that does not hold the selection: M.anchors.sentenceAround's own braced quote
  h.M.pdfview.textIndex = () => Promise.resolve({ text: "", starts: [], items: [] });
  h.M.reader.selection = selected(1, "p::q   r");
  assert.equal(h.M.reader.run("cloze"), true);
  await tick(5);
  assert.equal(calls[2].initialText, "{p\\::q r}");

  // a selection without :: is wrapped exactly as before
  h.M.reader.selection = selected(1, "plain words");
  assert.equal(h.M.reader.run("cloze"), true);
  await tick(5);
  assert.equal(calls[3].initialText, "{plain words}");
  await h.M.reader.close();
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.toasts, []);
});
