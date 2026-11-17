// node --test test/folders-dom.test.js — FEATURES L1 "Folders in the library", the home screen (BUILD-NOTES "Library
// folders"): the real js/util, bus, settings, store (memory backend), scheduler, prompts, context, keys, markup, cache,
// review and library run as classic scripts in a vm context on the small fake browser of test/library-dom.test.js
// (copied, so this file stands alone), with a stub M.app. Pins: the FOLDERS section above BOOKS and DECKS, folder rows
// (chevron, name, counts of the whole subtree, "Review · N due", ⋯), open folders remembered in this browser, sorting
// by name (case-insensitive, natural numbers), the indented contents and the empty line, New folder / New folder
// inside / Rename / Delete (confirm text, children up one level, Undo and Z), "Move to folder…" in every menu and its
// picker (indented tree, current place marked, a folder's own subtree disabled, Esc), drag and drop (onto a folder,
// onto the top level, a refused cycle, Esc), the folder's Review and the review end screen naming the folder, a tab
// that stepped aside moving nothing, one re-render per move, no listener left behind, one counts pass for 300 books.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");

const ROOT = path.join(__dirname, "..");

/* ------------------------------------------------------------------ a small DOM */

const VOID = new Set(["input", "br", "img", "hr", "meta", "link"]);

function parseSelectorList(sel) {
  return String(sel).split(",").map((part) => {
    const out = [];
    const re = /\s*(>)?\s*([^\s>]+)/g;
    let m;
    while ((m = re.exec(part.trim()))) out.push({ comb: m[1] ? ">" : " ", c: parseCompound(m[2]) });
    return out;
  });
}
function parseCompound(s) {
  const c = { tag: null, id: null, classes: [], attrs: [], nots: [] };
  const re = /^(\*|[a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]|:not\(([^)]*)\)/g;
  let m;
  while ((m = re.exec(s))) {
    if (m[0] === "") { re.lastIndex++; continue; }
    if (m[1]) c.tag = m[1] === "*" ? null : m[1].toUpperCase();
    else if (m[2]) c.id = m[2];
    else if (m[3]) c.classes.push(m[3]);
    else if (m[4]) c.attrs.push({ name: m[4], value: m[5] !== undefined ? m[5] : m[6] !== undefined ? m[6] : m[7] });
    else if (m[8]) c.nots.push(parseCompound(m[8]));
  }
  return c;
}
function matchCompound(el, c) {
  if (!el || el.nodeType !== 1) return false;
  if (c.tag && el.tagName !== c.tag) return false;
  if (c.id && el.id !== c.id) return false;
  for (const k of c.classes) if (!el.classList.contains(k)) return false;
  for (const a of c.attrs) {
    if (!el.hasAttribute(a.name)) return false;
    if (a.value !== undefined && el.getAttribute(a.name) !== a.value) return false;
  }
  for (const n of c.nots) if (matchCompound(el, n)) return false;
  return true;
}
function matchComplex(el, parts) {
  let i = parts.length - 1;
  if (!matchCompound(el, parts[i].c)) return false;
  let node = el;
  while (i > 0) {
    const comb = parts[i].comb;
    i--;
    if (comb === ">") { node = node.parentNode; if (!matchCompound(node, parts[i].c)) return false; continue; }
    node = node.parentNode;
    while (node && !matchCompound(node, parts[i].c)) node = node.parentNode;
    if (!node) return false;
  }
  return true;
}

function makeBrowser() {
  const win = { _l: [] };
  const doc = { nodeType: 9, nodeName: "#document", parentNode: null, childNodes: [], _l: [] };

  function decode(s) {
    return String(s).replace(/&(amp|lt|gt|quot|#39);/g, (m, e) => ({ amp: "&", lt: "<", gt: ">", quot: "\"", "#39": "'" })[e]);
  }
  function fixFocus(removed) {
    if (doc.activeElement && removed.contains && removed.contains(doc.activeElement)) doc.activeElement = doc.body;
  }
  const NodeProto = {
    get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; },
    get firstChild() { return this.childNodes[0] || null; },
    get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; },
    get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n === doc; },
    appendChild(c) { return this.insertBefore(c, null); },
    insertBefore(c, ref) {
      if (c.nodeType === 11) { c.childNodes.slice().forEach((k) => this.insertBefore(k, ref)); return c; }
      if (c.parentNode) c.parentNode.removeChild(c);
      const i = ref ? this.childNodes.indexOf(ref) : -1;
      if (i < 0) this.childNodes.push(c); else this.childNodes.splice(i, 0, c);
      c.parentNode = this;
      return c;
    },
    removeChild(c) {
      const i = this.childNodes.indexOf(c);
      if (i < 0) throw new Error("NotFoundError");
      this.childNodes.splice(i, 1);
      c.parentNode = null;
      fixFocus(c);
      return c;
    },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); },
    contains(n) { for (; n; n = n.parentNode) if (n === this) return true; return false; },
    addEventListener(type, fn, opts) {
      const capture = opts === true || !!(opts && opts.capture);
      if (!this._l.some((l) => l.type === type && l.fn === fn && l.capture === capture)) this._l.push({ type, fn, capture });
    },
    removeEventListener(type, fn, opts) {
      const capture = opts === true || !!(opts && opts.capture);
      this._l = this._l.filter((l) => !(l.type === type && l.fn === fn && l.capture === capture));
    },
    dispatchEvent(ev) { return dispatch(this, ev); },
    querySelectorAll(sel) {
      const list = parseSelectorList(sel), out = [];
      (function walk(n) {
        for (const c of n.childNodes) {
          if (c.nodeType !== 1) continue;
          if (list.some((parts) => matchComplex(c, parts))) out.push(c);
          walk(c);
        }
      })(this);
      return out;
    },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  };
  Object.defineProperty(NodeProto, "textContent", {
    get() { return this.childNodes.map((c) => c.textContent).join(""); },
    set(v) {
      while (this.childNodes.length) this.removeChild(this.childNodes[0]);
      if (v !== "" && v != null) this.appendChild(doc.createTextNode(String(v)));
    }
  });
  Object.setPrototypeOf(doc, NodeProto);
  win.addEventListener = NodeProto.addEventListener;
  win.removeEventListener = NodeProto.removeEventListener;

  function reflect(proto, prop, attr) {
    Object.defineProperty(proto, prop, {
      get() { return this.getAttribute(attr) || ""; },
      set(v) { this.setAttribute(attr, String(v)); }
    });
  }
  const ElementProto = Object.create(NodeProto, {
    classList: {
      get() {
        const self = this;
        const get = () => (self.getAttribute("class") || "").split(/\s+/).filter(Boolean);
        const set = (a) => self.setAttribute("class", a.join(" "));
        return {
          add(...c) { const a = get(); c.forEach((x) => { if (!a.includes(x)) a.push(x); }); set(a); },
          remove(...c) { set(get().filter((x) => !c.includes(x))); },
          toggle(c, force) { const has = get().includes(c); const want = force === undefined ? !has : !!force; if (want !== has) (want ? this.add(c) : this.remove(c)); return want; },
          contains(c) { return get().includes(c); }
        };
      }
    },
    innerHTML: {
      get() { return ""; },
      set(html) {
        while (this.childNodes.length) this.removeChild(this.childNodes[0]);
        const stack = [this];
        const re = /<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)([^>]*)>|([^<]+)/g;
        let m;
        while ((m = re.exec(String(html)))) {
          const top = stack[stack.length - 1];
          if (m[1]) { if (stack.length > 1) stack.pop(); continue; }
          if (m[4]) { top.appendChild(doc.createTextNode(decode(m[4]))); continue; }
          const e = doc.createElement(m[2]);
          const ar = /([^\s=/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
          let a;
          while ((a = ar.exec(m[3]))) e.setAttribute(a[1], decode(a[2] !== undefined ? a[2] : a[3] !== undefined ? a[3] : a[4] !== undefined ? a[4] : ""));
          top.appendChild(e);
          if (!VOID.has(m[2].toLowerCase()) && !/\/\s*$/.test(m[3])) stack.push(e);
        }
      }
    }
  });
  Object.assign(ElementProto, {
    setAttribute(k, v) { this._attrs.set(String(k).toLowerCase(), String(v)); },
    getAttribute(k) { const v = this._attrs.get(String(k).toLowerCase()); return v === undefined ? null : v; },
    hasAttribute(k) { return this._attrs.has(String(k).toLowerCase()); },
    removeAttribute(k) { this._attrs.delete(String(k).toLowerCase()); },
    closest(sel) { const list = parseSelectorList(sel); for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (list.some((p) => matchComplex(n, p))) return n; return null; },
    matches(sel) { return parseSelectorList(sel).some((p) => matchComplex(this, p)); },
    focus() { if (this.isConnected) doc.activeElement = this; },
    blur() { if (doc.activeElement === this) doc.activeElement = doc.body; },
    click() { if (this.disabled) return; dispatch(this, { type: "click", bubbles: true, cancelable: true, button: 0 }); },
    getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
    getClientRects() { return []; },
    get offsetParent() { return this.parentNode; },
    select() {}, setSelectionRange() {}, scrollIntoView() {}
  });
  reflect(ElementProto, "id", "id");
  reflect(ElementProto, "className", "class");
  reflect(ElementProto, "title", "title");
  reflect(ElementProto, "type", "type");
  Object.defineProperty(ElementProto, "disabled", {
    get() { return this.hasAttribute("disabled"); },
    set(v) { if (v) this.setAttribute("disabled", ""); else this.removeAttribute("disabled"); }
  });

  doc.createElement = (tag) => {
    const e = Object.create(ElementProto);
    Object.assign(e, { nodeType: 1, tagName: String(tag).toUpperCase(), nodeName: String(tag).toUpperCase(), parentNode: null,
      childNodes: [], _attrs: new Map(), _l: [], style: {}, value: "", checked: false, scrollTop: 0, files: null });
    return e;
  };
  doc.createTextNode = (t) => {
    const n = Object.create(NodeProto);
    Object.assign(n, { nodeType: 3, nodeName: "#text", parentNode: null, childNodes: [], _l: [], data: String(t) });
    Object.defineProperty(n, "textContent", { get() { return this.data; }, set(v) { this.data = String(v); } });
    return n;
  };
  doc.createDocumentFragment = () => { const f = doc.createElement("#fragment"); f.nodeType = 11; return f; };
  doc.getElementById = (id) => doc.querySelectorAll("#" + id)[0] || null;
  doc.contains = (n) => !!n && (n === doc || (n.isConnected === true));
  doc.documentElement = doc.createElement("html");
  doc.head = doc.createElement("head");
  doc.body = doc.createElement("body");
  doc.appendChild(doc.documentElement);
  doc.documentElement.appendChild(doc.head);
  doc.documentElement.appendChild(doc.body);
  doc.activeElement = doc.body;

  function dispatch(target, ev) {
    ev.target = target;
    if (ev.defaultPrevented === undefined) ev.defaultPrevented = false;
    let stop = false, stopNow = false;
    ev.preventDefault = function () { if (ev.cancelable !== false) ev.defaultPrevented = true; };
    ev.stopPropagation = function () { stop = true; };
    ev.stopImmediatePropagation = function () { stop = true; stopNow = true; };
    const pathTo = [];
    for (let n = target; n; n = n.parentNode) pathTo.push(n);
    if (pathTo[pathTo.length - 1] === doc) pathTo.push(win);
    const run = (node, phase) => {
      ev.currentTarget = node;
      for (const l of node._l.slice()) {
        if (l.type !== ev.type || !node._l.includes(l)) continue;
        if (phase === "capture" && !l.capture) continue;
        if (phase === "bubble" && l.capture) continue;
        l.fn.call(node, ev);
        if (stopNow) break;
      }
    };
    for (let i = pathTo.length - 1; i > 0 && !stop; i--) run(pathTo[i], "capture");
    if (!stop) run(target, "target");
    if (ev.bubbles !== false) for (let i = 1; i < pathTo.length && !stop; i++) run(pathTo[i], "bubble");
    return !ev.defaultPrevented;
  }

  // BUILD-NOTES index.html skeleton
  const app = doc.createElement("div"); app.id = "app"; doc.body.appendChild(app);
  const add = (parent, tag, id, hidden) => { const e = doc.createElement(tag); e.id = id; if (hidden) e.classList.add("is-hidden"); parent.appendChild(e); return e; };
  add(app, "div", "banner", true);
  add(app, "section", "library", false);
  add(app, "section", "deck", true);
  const reader = add(app, "section", "reader", true);
  add(reader, "div", "toolbar"); const scroller = add(reader, "div", "scroller"); add(scroller, "div", "pages"); add(scroller, "div", "margin");
  add(app, "div", "review", true); add(app, "div", "settings", true); add(app, "div", "shortcuts", true);
  add(app, "div", "toasts", false); add(app, "div", "confirm", true);
  const fileInput = add(app, "input", "fileInput", false); fileInput.type = "file";

  const timer = (f) => (fn, ms, ...a) => { const t = f(fn, ms, ...a); if (t && typeof t.unref === "function") t.unref(); return t; };
  Object.assign(win, {
    window: win, self: win, document: doc, console,
    setTimeout: timer(setTimeout), setInterval: timer(setInterval), clearTimeout, clearInterval, queueMicrotask,
    Promise, Map, Set, WeakMap, Symbol, Uint8Array, ArrayBuffer, DataView, TextEncoder, TextDecoder, Error, TypeError,
    crypto: webcrypto,
    navigator: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 Chrome/120.0 Safari/537.36", platform: "MacIntel" },
    location: { hostname: "example.test", search: "", hash: "", pathname: "/" },
    getComputedStyle: () => ({ position: "static", getPropertyValue: () => "" })
  });
  return { win, doc, dispatch };
}

/* ------------------------------------------------------------------ boot: real modules, stub M.app */

const MODULES = ["util", "bus", "settings", "store", "scheduler", "prompts", "context", "keys", "markup", "cache", "review", "library"];
const T0 = Date.UTC(2026, 10, 2, 12);
const DAY = 86400000;
const plain = (v) => JSON.parse(JSON.stringify(v));

function boot(opts) {
  opts = opts || {};
  const { win, doc, dispatch } = makeBrowser();
  const ls = opts.storage || new Map();
  win.localStorage = {
    getItem: (k) => (ls.has(String(k)) ? ls.get(String(k)) : null),
    setItem: (k, v) => { ls.set(String(k), String(v)); },
    removeItem: (k) => { ls.delete(String(k)); }
  };
  win.structuredClone = structuredClone;
  const ctx = vm.createContext(win);
  for (const name of MODULES) vm.runInContext(fs.readFileSync(path.join(ROOT, "js", name + ".js"), "utf8"), ctx, { filename: "js/" + name + ".js" });
  const M = win.Marginalia;
  const toasts = [], confirms = [], routes = [], reviews = [];
  const appState = { owner: "library", screen: "library" };
  const show = (id) => ["library", "deck", "reader"].forEach((s) => doc.getElementById(s).classList.toggle("is-hidden", s !== id));
  M.app = {
    toast(o) {
      if (o.id) toasts.filter((t) => t.id === o.id && !t.closed).forEach((t) => t.close());
      const el = doc.createElement("div");
      el.className = "toast";
      el.textContent = o.text;
      doc.getElementById("toasts").appendChild(el);
      const rec = { id: o.id, text: o.text, actions: o.actions || [], el, closed: false,
        close() { if (rec.closed) return; rec.closed = true; el.remove(); if (typeof o.onClose === "function") o.onClose(); } };
      toasts.push(rec);
      return { id: o.id, el, close: () => rec.close() };
    },
    confirm(o) { return new Promise((res) => confirms.push({ opts: o, res })); },
    route(screen, params) {
      routes.push([screen, params && params.collectionId]);
      appState.screen = screen;
      show(screen);
      if (screen === "library") M.library.render();
      else if (screen === "deck") M.library.openDeck(params.collectionId);
      return Promise.resolve(true);
    },
    startReview(scope, cid) { reviews.push([scope, cid]); return Promise.resolve(null); },
    setFocusOwner(o) { appState.owner = o; return o; },
    focusOwner: () => appState.owner
  };
  const appKeys = [];
  doc.addEventListener("keydown", (ev) => { appKeys.push(ev.key); });     // M.app's ONE document listener stands here
  const env = { win, doc, M, ls, toasts, confirms, routes, reviews, appKeys, lib: doc.getElementById("library") };
  env.press = (key, o) => dispatch(doc.activeElement || doc.body, Object.assign({ type: "keydown", key, bubbles: true, cancelable: true, repeat: false, isComposing: false }, o || {}));
  env.fire = (el, type, extra) => dispatch(el, Object.assign({ type, bubbles: true, cancelable: true }, extra || {}));
  env.answer = async (v) => { await until(() => confirms.some((c) => !c.done)); const c = confirms.find((x) => !x.done); c.done = true; c.res(v); await ticks(3); return c.opts; };
  env.lastToast = () => toasts[toasts.length - 1] || null;
  // the toast of a write comes once the store has it: wait for the one whose text is `text`
  env.toasted = async (text) => { await until(() => toasts.some((t) => t.text === text), "the toast " + text); return toasts.filter((t) => t.text === text).pop(); };
  env.toastAction = (t, label) => t.actions.find((x) => x.label === label).run({ close() {} });
  env.row = (id) => env.lib.querySelectorAll(".lib-row").find((r) => r.getAttribute("data-id") === id) || null;
  env.group = (id) => env.lib.querySelectorAll(".lib-folder").find((g) => g.getAttribute("data-folder") === id) || null;
  env.menu = (rowEl) => { rowEl.querySelector(".lib-row__more").click(); return env.lib.querySelectorAll(".lib-menu__item"); };
  env.item = (items, label) => items.find((b) => b.textContent === label) || null;
  env.picker = () => doc.body.querySelector(".lib-picker");
  env.texts = (els) => els.map((e) => e.textContent);
  env.start = async () => { await M.store.open(); await M.cache.load(); M.library.render(); return env; };
  return env;
}

function ticks(n) { let p = Promise.resolve(); for (let i = 0; i < (n || 1); i++) p = p.then(() => new Promise((r) => setTimeout(r, 0))); return p; }
async function until(pred, what) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (pred()) return; await new Promise((r) => setTimeout(r, 2)); }
  throw new Error("timed out waiting for " + (what || pred.toString()));
}
function book(id, extra) {
  return Object.assign({ id, kind: "book", name: "Book " + id, sha256: "sha-" + id, pageCount: 40, pageLabels: null, sections: [],
    lastPosition: { pageIndex: 0, fraction: 0, zoom: "fit" }, hasBytes: true, addedAt: T0, lastOpenedAt: T0, updatedAt: T0, deletedAt: null, v: 1 }, extra || {});
}
function deck(id, extra) {
  return Object.assign({ id, kind: "deck", name: "Deck " + id, description: "", sections: [], addedAt: T0, lastOpenedAt: T0, updatedAt: T0, deletedAt: null, v: 1 }, extra || {});
}
function due(id, cid, dueAt) {
  return { id, collectionId: cid, kind: "qa", text: "Q. " + id + "?\nA. yes", tags: [], flagged: false, anchor: null,
    context: { docName: "x", sectionLabel: null, pageIndex: null, pageLabel: null },
    // with a dueAt given the card was answered before, so that dueAt decides (a card never asked is due at once: D27)
    cards: [{ i: 0, createdAt: T0 - 30 * DAY, lastReviewedAt: dueAt === undefined ? null : T0 - DAY, intervalMs: 5 * DAY, dueAt: dueAt === undefined ? Date.now() - DAY : dueAt, log: [] }],
    createdAt: T0 - 30 * DAY, contentUpdatedAt: T0 - 30 * DAY, updatedAt: T0 - 30 * DAY, deletedAt: null, v: 1 };
}
// Stored as a Marginalia with folders stores them: fixed folder ids, so a second page can read the same open state.
function folderRec(id, name, parentId, extra) { return Object.assign({ id, name, parentId: parentId || null, createdAt: T0, updatedAt: T0, deletedAt: null }, extra || {}); }
async function library(env, data) {
  await env.M.store.open();
  for (const c of data.collections || []) await env.M.store.collections.put(c);
  for (const p of data.prompts || []) await env.M.store.prompts.put(p);
  if (data.folders) await env.M.store.meta.set("folders", data.folders);
  return env.start();
}
const STD = () => ({
  folders: [folderRec("fP", "Physics"), folderRec("fQ", "QM", "fP"), folderRec("fE", "Empty")],
  collections: [book("b1", { folderId: "fP" }), book("b2", { folderId: "fQ", lastOpenedAt: T0 + 5 }), deck("d1", { folderId: "fP" }),
    book("top", { name: "Top book" }), deck("dtop", { name: "Top deck" })],
  prompts: [due("p1", "b1"), due("p2", "b2"), due("p3", "d1"), due("p4", "b2", Date.now() + 30 * DAY), due("p5", "top")]
});
function fakeTransfer() {
  const data = {};
  return { data, types: [], effectAllowed: "", dropEffect: "", files: null,
    setData(k, v) { data[k] = v; if (!this.types.includes(k)) this.types.push(k); }, getData(k) { return data[k] || ""; } };
}

/* ------------------------------------------------------------------ home screen (L1.2) */

test("FOLDERS sits above BOOKS and DECKS; folder rows carry chevron, name, subtree counts, Review · N due and ⋯", async () => {
  const env = await library(boot(), STD());
  const lib = env.lib;
  const sections = lib.querySelectorAll(".lib__section").map((s) => s.querySelector(".lib__label").textContent);
  assert.deepEqual(sections, ["Folders", "Books", "Decks"]);
  assert.deepEqual(env.texts(lib.querySelectorAll(".lib__section--folders > .lib-folder > .lib-row--folder .lib-row__nick")), ["Empty", "Physics"]);
  const phys = env.row("fP");
  assert.equal(phys.querySelector(".lib-folder__toggle").getAttribute("aria-expanded"), "false");
  assert.equal(phys.querySelector(".lib-folder__chevron").textContent, "▸");
  assert.equal(phys.querySelector(".lib-row__meta").textContent, "1 folder · 2 books · 1 deck · 3 due", "the whole subtree");
  const review = phys.querySelectorAll("button").find((b) => /^Review/.test(b.textContent));
  assert.equal(review.textContent, "Review · 3 due");
  assert.ok(phys.querySelector(".lib-row__more"));
  assert.equal(env.row("fE").querySelector(".lib-row__meta").textContent, "0 books · 0 decks · 0 due");
  const quiet = env.row("fE").querySelectorAll("button").find((b) => /^Review/.test(b.textContent));
  assert.equal(quiet.disabled, false, "clickable with nothing due");
  assert.ok(quiet.classList.contains("btn--ghost"), "the quiet look of a 0-due book row");
  assert.equal(quiet.title, "Nothing is due");
  assert.deepEqual(env.texts(lib.querySelectorAll(".lib__section--books .lib-row__nick")), ["Top book"], "only the top-level books stay in BOOKS");
  assert.deepEqual(env.texts(lib.querySelectorAll(".lib__section--decks .lib-row__nick")), ["Top deck"]);
  assert.equal(env.row("b1"), null, "a closed folder shows nothing inside");
  review.click();
  assert.deepEqual(env.reviews, [["folder", "fP"]]);
  quiet.click();
  assert.deepEqual(env.reviews[1], ["folder", "fE"]);
});

test("an open folder shows its sub-folders, then its books, then its decks, indented; an empty one says how to fill it", async () => {
  const env = await library(boot(), STD());
  env.row("fP").querySelector(".lib-folder__toggle").click();
  const body = env.group("fP").querySelectorAll(".lib-folder__body")[0];
  const kids = body.childNodes.filter((n) => n.nodeType === 1);
  assert.deepEqual(kids.map((k) => k.classList.contains("lib-folder") ? "folder:" + k.getAttribute("data-folder") : k.getAttribute("data-id")), ["folder:fQ", "b1", "d1"]);
  assert.equal(env.row("fP").querySelector(".lib-folder__toggle").getAttribute("aria-expanded"), "true");
  assert.equal(env.row("fP").querySelector(".lib-folder__chevron").textContent, "▾");
  assert.equal(env.doc.activeElement.getAttribute("data-focus"), "folder:fP:toggle", "focus stays on the chevron");
  assert.equal(env.row("b2"), null, "QM is still closed");
  env.row("fE").querySelector(".lib-folder__toggle").click();
  const empty = env.group("fE").querySelector(".lib-folder__empty");
  assert.equal(empty.textContent, "Empty — drag books here or use Move to folder…");
});

test("opening and closing is remembered in this browser (localStorage), for live folders only", async () => {
  const storage = new Map();
  const a = await library(boot({ storage }), STD());
  a.row("fP").querySelector(".lib-folder__toggle").click();
  a.row("fQ").querySelector(".lib-folder__toggle").click();
  assert.deepEqual(JSON.parse(storage.get("marginalia.openFolders")).sort(), ["fP", "fQ"]);
  const b = await library(boot({ storage }), STD());                      // the next page of this browser
  assert.ok(b.row("b2"), "QM's book shows: both folders open");
  b.row("fQ").querySelector(".lib-folder__toggle").click();
  assert.deepEqual(JSON.parse(storage.get("marginalia.openFolders")), ["fP"]);
  storage.set("marginalia.openFolders", "not json");
  const c = await library(boot({ storage }), STD());
  assert.equal(c.row("b1"), null, "a broken value opens nothing");
});

test("folders sort by name: case-insensitive, numbers in natural order", async () => {
  const env = await library(boot(), { folders: [folderRec("f1", "Ch 10"), folderRec("f2", "ch 2"), folderRec("f3", "Appendix"), folderRec("f4", "ch 1"), folderRec("f5", "b")], collections: [] });
  assert.deepEqual(env.texts(env.lib.querySelectorAll(".lib__section--folders .lib-row__nick")), ["Appendix", "b", "ch 1", "ch 2", "Ch 10"]);
});

test("an existing library without folders looks as it did: no FOLDERS section, every book and deck in BOOKS and DECKS", async () => {
  const env = await library(boot(), { collections: [book("b1"), deck("d1")] });
  assert.deepEqual(env.lib.querySelectorAll(".lib__section").map((s) => s.querySelector(".lib__label").textContent), ["Books", "Decks"]);
  assert.ok(env.row("b1") && env.row("d1"));
  assert.ok(env.lib.querySelector(".lib__newfolder-btn"), "New folder sits beside New deck");
  const actions = env.lib.querySelector(".lib__header-actions").childNodes.map((b) => b.textContent);
  assert.equal(actions.indexOf("New folder"), actions.indexOf("New deck") + 1);
});

/* ------------------------------------------------------------------ create, rename, delete (L1.2, L1.4) */

test("New folder: an inline field; Enter makes the folder, opens it and focuses it; a blank name asks for one", async () => {
  const env = await library(boot(), { collections: [book("b1")] });
  env.lib.querySelector(".lib__newfolder-btn").click();
  const input = env.lib.querySelector(".lib__newfolder-input");
  assert.ok(input && env.doc.activeElement === input);
  env.press("Enter");
  assert.equal(env.lastToast().text, "Give the folder a name first");
  env.lib.querySelector(".lib__newfolder-btn").click();
  const input2 = env.lib.querySelector(".lib__newfolder-input");
  input2.value = "  Quantum  mechanics ";
  env.press("Enter");
  await until(() => env.lib.querySelector(".lib__section--folders"), "the FOLDERS section");
  const f = env.M.cache.folders()[0];
  assert.equal(f.name, "Quantum mechanics");
  assert.equal(env.group(f.id).querySelector(".lib-folder__empty").textContent, "Empty — drag books here or use Move to folder…", "a new folder opens");
  assert.equal(env.doc.activeElement.getAttribute("data-focus"), "folder:" + f.id + ":toggle");
  assert.deepEqual(env.appKeys, [], "the field's keys never reach M.app");
});

test("⋯ of a folder: Rename, New folder inside, Move to folder…, Delete; New folder inside opens the folder with the field on top", async () => {
  const env = await library(boot(), STD());
  const items = env.menu(env.row("fE"));
  assert.deepEqual(env.texts(items), ["Rename", "New folder inside", "Move to folder…", "Delete"]);
  env.item(items, "New folder inside").click();
  const input = env.lib.querySelector(".lib__newfolder-input");
  assert.equal(input.parentNode.parentNode, env.group("fE").querySelector(".lib-folder__body"), "at the top of the folder's contents");
  input.value = "Inner";
  env.press("Enter");
  await until(() => env.M.cache.folders().length === 4);
  const inner = env.M.cache.folders().find((f) => f.name === "Inner");
  assert.equal(env.M.cache.folderParent(inner.id), "fE");
  await until(() => env.group(inner.id));
  env.item(env.menu(env.row(inner.id)), "Rename").click();
  const rn = env.row(inner.id).querySelector(".lib-rename");
  assert.equal(env.row(inner.id).getAttribute("draggable"), null, "no drag while the name is edited");
  rn.value = "Inner 2";
  env.press("Enter");
  await until(() => env.M.cache.folder(inner.id).name === "Inner 2");
  await until(() => env.row(inner.id) && env.row(inner.id).querySelector(".lib-row__nick").textContent === "Inner 2");
  assert.equal(env.row(inner.id).getAttribute("draggable"), "true");
});

// Repair UI-1 (2026-11-11): an inline New folder / New deck field no longer holds the home screen back. A re-render
// puts the same field (its text, its focus) back in its place, so what other controls do shows at once.
test("with the New folder field up, the chevron, a drag, the picker and a folder's rename show at once; the field keeps its text", async () => {
  const env = await library(boot(), STD());
  env.lib.querySelector(".lib__newfolder-btn").click();
  const field = () => env.lib.querySelector(".lib__newfolder-input");
  const input = field();
  input.value = "Draft";
  const toggle = () => env.row("fP").querySelector(".lib-folder__toggle");
  toggle().focus();                                        // a mouse press takes focus first, as in a browser
  toggle().click();
  assert.equal(toggle().getAttribute("aria-expanded"), "true", "the chevron opens Physics at once");
  assert.ok(env.row("b1"), "its book shows");
  assert.deepEqual([field(), input.value], [input, "Draft"], "the same field, still up, with its text");
  assert.equal(env.doc.activeElement.getAttribute("data-focus"), "folder:fP:toggle");
  // a drag onto Empty: the row leaves BOOKS on screen
  const dt = fakeTransfer(), row = env.row("top");
  env.fire(row, "dragstart", { dataTransfer: dt });
  env.fire(env.row("fE").querySelector(".lib-row__nick"), "drop", { dataTransfer: dt });
  env.fire(row, "dragend", { dataTransfer: dt });
  await until(() => env.M.cache.folderOf("top") === "fE");
  await env.toasted("Moved “Top book” to “Empty”");
  await ticks(3);
  assert.equal(env.lib.querySelector(".lib__section--books .lib-row[data-id=\"top\"]"), null, "it left BOOKS");
  assert.equal(env.row("fE").querySelector(".lib-row__meta").textContent, "1 book · 0 decks · 1 due");
  // the picker: Top deck into open Physics
  env.item(env.menu(env.row("dtop")), "Move to folder…").click();
  env.picker().querySelectorAll(".lib-picker__item").find((b) => b.querySelector(".lib-picker__name").textContent === "Physics").click();
  await until(() => env.M.cache.folderOf("dtop") === "fP");
  await ticks(3);
  assert.ok(env.group("fP").querySelector(".lib-row[data-id=\"dtop\"]"), "the deck shows inside Physics");
  assert.equal(env.doc.activeElement.getAttribute("data-focus"), "row:dtop:more", "focus lands on the moved row");
  // a folder's rename
  env.item(env.menu(env.row("fE")), "Rename").click();
  env.row("fE").querySelector(".lib-rename").value = "Inbox";
  env.press("Enter");
  await until(() => env.M.cache.folder("fE").name === "Inbox");
  await ticks(3);
  assert.equal(env.row("fE").querySelector(".lib-row__nick").textContent, "Inbox");
  assert.deepEqual([field(), input.value], [input, "Draft"], "what was typed is still there");
  input.focus();
  env.press("Enter");
  await until(() => env.M.cache.folders().some((f) => f.name === "Draft"), "the new folder");
  assert.equal(field(), null);
});

test("New folder inside with the field up: the field moves into that folder, opened, with its text; closing that folder drops it", async () => {
  const env = await library(boot(), STD());
  env.lib.querySelector(".lib__newfolder-btn").click();
  const input = env.lib.querySelector(".lib__newfolder-input");
  input.value = "Inner";
  env.item(env.menu(env.row("fE")), "New folder inside").click();
  const fields = env.lib.querySelectorAll(".lib__newfolder-input");
  assert.deepEqual([fields.length, fields[0] === input], [1, true], "one field, the same one");
  assert.equal(input.parentNode.parentNode, env.group("fE").querySelector(".lib-folder__body"), "at the top of Empty's contents");
  assert.deepEqual([env.doc.activeElement === input, input.value, input.getAttribute("aria-label")], [true, "Inner", "Name of the new folder inside"]);
  assert.equal(env.M.library.showNewFolderField("fP"), true, "asked again elsewhere: it moves there");
  assert.equal(input.parentNode.parentNode, env.group("fP").querySelector(".lib-folder__body"));
  // closing the folder that holds it: the field goes, as Cancel would; nothing is made
  const t = env.row("fP").querySelector(".lib-folder__toggle");
  t.focus();
  t.click();
  assert.equal(env.lib.querySelector(".lib__newfolder-input"), null);
  assert.equal(env.M.cache.folders().length, 3);
  env.lib.querySelector(".lib__newfolder-btn").click();
  assert.ok(env.lib.querySelector(".lib__newfolder-input"), "New folder works again");
});

test("a refresh while a field is typed in keeps its focus and text (New deck too); an IME composition holds it until it ends", async () => {
  const env = await library(boot(), STD());
  env.lib.querySelector(".lib__newdeck-btn").click();
  const deckIn = env.lib.querySelector(".lib__newdeck-input");
  deckIn.value = "Verbs";
  await env.M.cache.renameFolder("fP", "Physics II");      // a data change re-renders the home screen
  await ticks(3);
  assert.equal(env.row("fP").querySelector(".lib-row__nick").textContent, "Physics II", "the change shows");
  assert.equal(env.lib.querySelector(".lib__newdeck-input"), deckIn, "the same field");
  assert.ok(deckIn.closest(".lib__section--decks"), "still in DECKS");
  assert.deepEqual([env.doc.activeElement === deckIn, deckIn.value], [true, "Verbs"], "focus and text kept");
  const tg = env.row("fP").querySelector(".lib-folder__toggle");
  tg.focus();
  tg.click();
  assert.equal(env.row("fP").querySelector(".lib-folder__toggle").getAttribute("aria-expanded"), "true", "the chevron works with New deck up");
  deckIn.focus();
  env.fire(deckIn, "compositionstart");
  await env.M.cache.renameFolder("fP", "Physics III");
  await ticks(3);
  assert.equal(env.row("fP").querySelector(".lib-row__nick").textContent, "Physics II", "held while an IME composes");
  env.fire(deckIn, "compositionend");
  assert.equal(env.row("fP").querySelector(".lib-row__nick").textContent, "Physics III");
  assert.equal(env.doc.activeElement, deckIn);
  // a field with a name stays when the other one opens; a blank one gives way
  env.lib.querySelector(".lib__newfolder-btn").click();
  assert.deepEqual([!!env.lib.querySelector(".lib__newdeck-input"), !!env.lib.querySelector(".lib__newfolder-input")], [true, true]);
  deckIn.value = " ";
  env.lib.querySelector(".lib__newfolder-btn").click();
  assert.equal(env.lib.querySelector(".lib__newfolder-input"), env.doc.activeElement, "New folder again: back to its field");
  env.lib.querySelector(".lib__newfolder-input").value = "";
  env.lib.querySelector(".lib__newdeck-btn").click();
  assert.deepEqual([!!env.lib.querySelector(".lib__newfolder-input"), env.doc.activeElement === env.lib.querySelector(".lib__newdeck-input")], [false, true],
    "the blank New folder field gave way; New deck again goes back to its field");
});

test("Delete: the confirm names where the contents go; children move up one level; Undo (and Z) bring the folder back", async () => {
  const env = await library(boot(), STD());
  env.row("fP").querySelector(".lib-folder__toggle").click();
  const prompts = plain(env.M.cache.prompts());
  env.item(env.menu(env.row("fQ")), "Delete").click();
  const c = await env.answer(true);
  assert.equal(c.title, "Delete folder “QM”?");
  assert.equal(c.body, "Its books, decks and folders move to “Physics”. Nothing else is deleted.");
  assert.equal(c.danger, true);
  await until(() => env.M.cache.folder("fQ").deletedAt);
  assert.equal(env.M.cache.folderOf("b2"), "fP");
  assert.deepEqual(plain(env.M.cache.prompts()), prompts, "no prompt or review history changed");
  await until(() => env.row("b2"), "b2 shows in Physics");
  const t = env.lastToast();
  assert.equal(t.text, "Deleted the folder “QM” · Undo (Z)");
  assert.equal(env.doc.activeElement.getAttribute("data-focus"), "folder:fP:toggle");
  env.press("z");
  await until(() => env.M.cache.folder("fQ").deletedAt === null, "Z restores");
  assert.equal(env.M.cache.folderOf("b2"), "fQ");
  await until(() => env.lastToast().text === "Restored the folder “QM”");

  env.item(env.menu(env.row("fP")), "Delete").click();
  const c2 = await env.answer(true);
  assert.equal(c2.body, "Its books, decks and folders move to the top level. Nothing else is deleted.");
  await until(() => env.M.cache.folderOf("b1") === null);
  assert.equal(env.M.cache.folderParent("fQ"), null);
  env.toastAction(env.lastToast(), "Undo");
  await until(() => env.M.cache.folderOf("b1") === "fP");

  env.item(env.menu(env.row("fE")), "Delete").click();
  await env.answer(false);
  assert.equal(env.M.cache.folder("fE").deletedAt, null, "Cancel deletes nothing");
});

/* ------------------------------------------------------------------ Move to folder… (L1.3) */

test("every book, deck and deck page menu has Move to folder…; it is disabled while there is no folder", async () => {
  const empty = await library(boot(), { collections: [book("b1"), deck("d1")] });
  let items = empty.menu(empty.row("b1"));
  assert.deepEqual(empty.texts(items), ["Rename", "Export…", "Move to folder…", "Replace file", "Delete"]);
  assert.equal(empty.item(items, "Move to folder…").disabled, true);
  assert.equal(empty.item(items, "Move to folder…").title, "No folders yet — make one with New folder");
  const env = await library(boot(), STD());
  items = env.menu(env.row("top"));
  assert.equal(env.item(items, "Move to folder…").disabled, false);
  items = env.menu(env.row("dtop"));
  assert.deepEqual(env.texts(items), ["Rename", "Export…", "Move to folder…", "Delete"]);
  env.M.app.route("deck", { collectionId: "dtop" });
  const deckHost = env.doc.getElementById("deck");
  deckHost.querySelector(".deck__more").click();
  items = deckHost.querySelectorAll(".lib-menu__item");
  assert.deepEqual(env.texts(items), ["Rename", "Export…", "Move to folder…", "Delete"]);
  env.item(items, "Move to folder…").click();
  assert.ok(env.picker(), "the deck page opens the picker too");
  env.picker().querySelectorAll(".lib-picker__item").find((b) => b.getAttribute("data-target") === "fQ").click();
  await until(() => env.M.cache.folderOf("dtop") === "fQ");
  await env.toasted("Moved “Top deck” to “QM”");
});

// Repair UI-2 (2026-11-11): the deck page keeps its place; the home screen gets no landing from a move made there.
test("deck page › Move to folder…: focus goes back to the deck's ⋯, and back on the home screen nothing jumps to that folder", async () => {
  const env = await library(boot(), STD());
  env.M.app.route("deck", { collectionId: "dtop" });
  const deckHost = env.doc.getElementById("deck"), more = deckHost.querySelector(".deck__more");
  more.focus();
  more.click();
  env.item(deckHost.querySelectorAll(".lib-menu__item"), "Move to folder…").click();
  env.picker().querySelectorAll(".lib-picker__item").find((b) => b.getAttribute("data-target") === "fE").click();
  assert.equal(env.picker(), null);
  assert.equal(env.doc.activeElement, more, "focus is back on the deck's ⋯");
  await until(() => env.M.cache.folderOf("dtop") === "fE");
  await env.toasted("Moved “Top deck” to “Empty”");
  await ticks(3);
  assert.equal(env.doc.activeElement, more, "and stays there");
  env.M.app.route("library");
  await ticks(3);
  const a = env.doc.activeElement;
  assert.notEqual(a && a.getAttribute && a.getAttribute("data-focus"), "folder:fE:toggle", "no leftover landing on the folder it went into");
});

// Repair UI-3 (2026-11-11): a home re-render while the picker is up replaces the ⋯ that opened it.
test("the picker gives focus back to the same ⋯ after a re-render replaced it: Esc, ✕, a click outside, the current place", async () => {
  const env = await library(boot(), STD());
  const open = (id) => {
    const more = env.row(id).querySelector(".lib-row__more");
    more.focus();
    env.item(env.menu(env.row(id)), "Move to folder…").click();
    assert.ok(env.picker());
    env.M.library.render();                                // what the 60 s refresh or a data change does meanwhile
    assert.ok(env.picker(), "the picker stays up");
    assert.ok(!more.isConnected, "its ⋯ was replaced");
  };
  const focusKey = () => env.doc.activeElement && env.doc.activeElement.getAttribute && env.doc.activeElement.getAttribute("data-focus");
  open("top");
  env.press("Escape");
  assert.equal(focusKey(), "row:top:more", "Esc");
  open("top");
  env.picker().querySelector(".dialog__close").click();
  assert.equal(focusKey(), "row:top:more", "✕");
  open("top");
  env.fire(env.picker(), "click");
  assert.equal(env.picker(), null);
  assert.equal(focusKey(), "row:top:more", "a click outside");
  open("top");
  env.picker().querySelector(".lib-picker__item[aria-checked=\"true\"]").click();
  assert.equal(focusKey(), "row:top:more", "the current place");
  open("fE");
  env.press("Escape");
  assert.equal(focusKey(), "folder:fE:more", "a folder's ⋯ too");
});

// Repair UI-4 (2026-11-11): each folder is its own group, so "nothing of that kind left" is common there.
test("deleting the last book or deck of a folder keeps focus in that folder: its other rows, else its chevron", async () => {
  const env = await library(boot(), STD());
  env.row("fP").querySelector(".lib-folder__toggle").click();
  env.row("fQ").querySelector(".lib-folder__toggle").click();
  const del = async (id) => {
    const p = env.M.library.deleteCollection(id);
    await env.answer(true);
    assert.equal(await p, true);
    await ticks(3);
    return env.doc.activeElement.getAttribute("data-focus");
  };
  assert.equal(await del("b2"), "folder:fQ:toggle", "QM's only book: QM's chevron (it holds nothing else)");
  assert.equal(await del("d1"), "row:b1:more", "Physics's only deck: the book above it in Physics");
  assert.equal(await del("b1"), "folder:fP:toggle", "Physics's last book and nothing else of its own: Physics's chevron");
  assert.ok(env.row("fQ"), "Physics stays open");
});

// Repair UI-5 (2026-11-11): a toast never shows a record id.
test("the move's Undo after the folder it came from (or the item) was deleted says so in words", async () => {
  const env = await library(boot(), STD());
  await env.M.library.moveTo("collection", "b1", "fE");
  const moved = await env.toasted("Moved “Book b1” to “Empty”");
  const del = env.M.library.deleteFolder("fP");
  await env.answer(true);
  await del;
  env.toastAction(moved, "Undo");
  await env.toasted("Could not undo the move — the folder “Physics” was deleted");
  assert.equal(env.M.cache.folderOf("b1"), "fE", "the book stays where the move put it");
  await env.M.library.moveTo("collection", "top", "fE");
  const moved2 = await env.toasted("Moved “Top book” to “Empty”");
  const del2 = env.M.library.deleteCollection("top");
  await env.answer(true);
  await del2;
  env.toastAction(moved2, "Undo");
  await env.toasted("Could not undo the move — “Top book” was deleted");
  assert.ok(!env.toasts.some((t) => /folder_|book_|No (folder|collection) /.test(t.text)), "no record id in any toast");
});

test("the picker: every folder as an indented tree plus No folder (top level); the current place marked; choosing moves, Undo moves back", async () => {
  const env = await library(boot(), STD());
  const more = env.row("top").querySelector(".lib-row__more");
  env.item(env.menu(env.row("top")), "Move to folder…").click();
  const p = env.picker();
  assert.equal(p.querySelector(".dialog__title").textContent, "Move “Top book” to…");
  assert.equal(p.querySelector("[role=\"dialog\"]").getAttribute("aria-modal"), "true");
  const items = p.querySelectorAll(".lib-picker__item");
  assert.deepEqual(items.map((b) => b.querySelector(".lib-picker__name").textContent), ["No folder (top level)", "Empty", "Physics", "QM"]);
  assert.deepEqual(items.map((b) => b.style.paddingLeft), ["12px", "12px", "12px", "32px"], "QM is indented under Physics");
  assert.deepEqual(items.map((b) => b.getAttribute("aria-checked")), ["true", "false", "false", "false"]);
  assert.equal(items[0].querySelector(".lib-picker__here").textContent, "current");
  assert.equal(env.doc.activeElement, items[0], "focus starts on the current place");
  env.press("ArrowDown");
  assert.equal(env.doc.activeElement, items[1]);
  env.press("ArrowUp"); env.press("ArrowUp");
  assert.equal(env.doc.activeElement, items[3], "the arrows wrap");
  assert.deepEqual(env.appKeys, [], "no key reaches M.app while the picker is up");
  items[3].click();
  assert.equal(env.picker(), null);
  await until(() => env.M.cache.folderOf("top") === "fQ");
  const t = await env.toasted("Moved “Top book” to “QM”");
  await ticks(2);
  assert.equal(env.doc.activeElement.getAttribute("data-focus"), "folder:fP:toggle", "focus lands on the nearest folder on screen (QM is in closed Physics)");
  env.toastAction(t, "Undo");
  await until(() => env.M.cache.folderOf("top") === null);
  await env.toasted("Moved “Top book” back to the top level");
  assert.ok(more);
});

test("the picker for a folder disables the folder itself and its sub-folders; Esc closes it and focus returns to ⋯", async () => {
  const env = await library(boot(), STD());
  const more = env.row("fP").querySelector(".lib-row__more");
  more.click();
  env.item(env.lib.querySelectorAll(".lib-menu__item"), "Move to folder…").click();
  const items = env.picker().querySelectorAll(".lib-picker__item");
  const state = items.map((b) => [b.querySelector(".lib-picker__name").textContent, b.disabled, b.getAttribute("aria-checked")]);
  assert.deepEqual(state, [["No folder (top level)", false, "true"], ["Empty", false, "false"], ["Physics", true, "false"], ["QM", true, "false"]]);
  assert.equal(items[2].title, "A folder cannot go inside itself");
  env.press("Escape");
  assert.equal(env.picker(), null);
  assert.equal(env.doc.activeElement, more);
  assert.deepEqual(env.appKeys, []);
  assert.equal(env.M.cache.folderParent("fP"), null, "nothing moved");
  // the API refuses the same moves
  await assert.rejects(env.M.cache.moveFolder("fP", "fQ"), (e) => e.code === "cycle");
});

/* ------------------------------------------------------------------ drag and drop (L1.3) */

test("drag a book onto a folder row: the folder is highlighted, the drop moves it, the toast offers Undo", async () => {
  const env = await library(boot(), STD());
  const dt = fakeTransfer();
  const row = env.row("top");
  assert.equal(row.getAttribute("draggable"), "true");
  env.fire(row, "dragstart", { dataTransfer: dt });
  assert.equal(dt.effectAllowed, "move");
  assert.equal(dt.data["application/x-marginalia-item"], "collection:top");
  assert.ok(row.classList.contains("lib-row--dragging"));
  const target = env.row("fE").querySelector(".lib-row__nick");
  const over = env.fire(target, "dragover", { dataTransfer: dt });
  assert.equal(over, false, "dragover is prevented: a drop is allowed here");
  assert.equal(dt.dropEffect, "move");
  assert.ok(env.group("fE").classList.contains("lib-drop--over"));
  env.fire(target, "drop", { dataTransfer: dt });
  env.fire(row, "dragend", { dataTransfer: dt });
  assert.ok(!env.group("fE") || !env.group("fE").classList.contains("lib-drop--over"));
  await until(() => env.M.cache.folderOf("top") === "fE");
  env.toastAction(await env.toasted("Moved “Top book” to “Empty”"), "Undo");
  await until(() => env.M.cache.folderOf("top") === null);
  // a drag that starts, or passes, over text: the browser may name the text node; its element counts
  await ticks(2);
  const dt2 = fakeTransfer(), text = env.row("top").querySelector(".lib-row__nick").firstChild;
  assert.equal(text.nodeType, 3);
  env.fire(text, "dragstart", { dataTransfer: dt2 });
  assert.equal(dt2.data["application/x-marginalia-item"], "collection:top");
  env.fire(env.row("fE").querySelector(".lib-row__nick").firstChild, "drop", { dataTransfer: dt2 });
  await until(() => env.M.cache.folderOf("top") === "fE");
});

test("drag from inside a folder onto the top level (BOOKS); a folder onto another; a drop on its own place does nothing", async () => {
  const env = await library(boot(), STD());
  env.row("fP").querySelector(".lib-folder__toggle").click();
  let dt = fakeTransfer();
  env.fire(env.row("b1"), "dragstart", { dataTransfer: dt });
  const books = env.lib.querySelector(".lib__section--books .lib__label");
  env.fire(books, "dragover", { dataTransfer: dt });
  assert.ok(env.lib.querySelector(".lib__section--books").classList.contains("lib-drop--over"));
  env.fire(books, "drop", { dataTransfer: dt });
  await until(() => env.M.cache.folderOf("b1") === null);
  await env.toasted("Moved “Book b1” to the top level");
  dt = fakeTransfer();
  env.fire(env.row("fE"), "dragstart", { dataTransfer: dt });
  env.fire(env.row("fQ"), "dragover", { dataTransfer: dt });
  env.fire(env.row("fQ"), "drop", { dataTransfer: dt });
  await until(() => env.M.cache.folderParent("fE") === "fQ");
  dt = fakeTransfer();
  await ticks(2);
  env.fire(env.row("d1"), "dragstart", { dataTransfer: dt });
  const same = env.fire(env.row("fP"), "dragover", { dataTransfer: dt });
  assert.equal(same, true, "d1 is in Physics already: no drop target");
  assert.ok(!env.group("fP").classList.contains("lib-drop--over"));
  env.fire(env.row("d1"), "dragend", { dataTransfer: dt });
});

test("a folder dragged over itself or its own sub-folder finds no drop target, and a drop there moves nothing", async () => {
  const env = await library(boot(), STD());
  env.row("fP").querySelector(".lib-folder__toggle").click();
  const dt = fakeTransfer();
  env.fire(env.row("fP"), "dragstart", { dataTransfer: dt });
  for (const id of ["fP", "fQ"]) {
    const allowed = env.fire(env.row(id), "dragover", { dataTransfer: dt });
    assert.equal(allowed, true, "not prevented over " + id);
    assert.equal(dt.dropEffect, "none");
    assert.ok(!env.group(id).classList.contains("lib-drop--over"));
  }
  const before = env.toasts.length;
  env.fire(env.row("fQ"), "drop", { dataTransfer: dt });
  await ticks(3);
  assert.equal(env.M.cache.folderParent("fP"), null);
  assert.equal(env.M.cache.folderParent("fQ"), "fP");
  assert.equal(env.toasts.length, before, "nothing to say: nothing moved");
});

test("Esc cancels a drag: the highlight goes, nothing moves, and the screen re-renders what changed meanwhile", async () => {
  const env = await library(boot(), STD());
  const dt = fakeTransfer();
  env.fire(env.row("top"), "dragstart", { dataTransfer: dt });
  env.fire(env.row("fE"), "dragover", { dataTransfer: dt });
  assert.ok(env.group("fE").classList.contains("lib-drop--over"));
  await env.M.cache.renameFolder("fP", "Physics II");                   // a change while dragging: no re-render yet
  await ticks(2);
  assert.equal(env.row("fP").querySelector(".lib-row__nick").textContent, "Physics", "rows stay put during a drag");
  env.fire(env.row("top"), "keydown", { key: "Escape" });             // on its way up through #library
  assert.ok(!env.lib.querySelector(".lib-drop--over"));
  assert.equal(env.row("fP").querySelector(".lib-row__nick").textContent, "Physics II", "re-rendered once the drag ended");
  env.fire(env.lib, "dragend", { dataTransfer: dt });
  await ticks(2);
  assert.equal(env.M.cache.folderOf("top"), null, "nothing moved");
  assert.ok(!env.toasts.some((t) => /^Moved/.test(t.text)));
  assert.deepEqual(env.appKeys.filter((k) => k === "Escape"), [], "the Escape of a drag never reaches M.app");
});

/* ------------------------------------------------------------------ review a folder (L1.5) */

test("the review of a folder names it on the end screen and on the empty screen", async () => {
  const env = await library(boot(), STD());
  const host = env.doc.getElementById("review");
  await env.M.review.start({ scope: "folder", collectionId: "fP", now: Date.now() });
  const seen = [];
  for (let c = env.M.review.current(); c; c = env.M.review.current()) { seen.push(c.prompt.id); env.M.review.reveal(); env.M.review.grade("remembered"); }
  assert.deepEqual(seen.sort(), ["p1", "p2", "p3"]);
  assert.equal(host.querySelector(".review__scope").textContent, "Folder “Physics”");
  assert.ok(host.querySelector(".review__end"), "the end screen");
  env.M.review.stop();
  await env.M.review.start({ scope: "folder", collectionId: "fE", now: Date.now() });
  assert.equal(host.querySelector(".review__scope").textContent, "Folder “Empty”");
  assert.equal(host.querySelector(".review__empty h1").textContent, "No reviewable prompts yet");
  env.M.review.stop();
  await env.M.review.start({ scope: "all", collectionId: null, now: Date.now() });
  assert.equal(host.querySelector(".review__scope"), null, "other scopes name no folder");
  env.M.review.stop();
});

/* ------------------------------------------------------------------ a tab that stepped aside (L1.8) */

test("a tab that stepped aside moves, makes, renames and deletes no folder (and says nothing)", async () => {
  const env = await library(boot(), STD());
  env.M.store.lock({ reason: "othertab", by: "tab_newer" });
  const dt = fakeTransfer();
  env.fire(env.row("top"), "dragstart", { dataTransfer: dt });
  env.fire(env.row("fE"), "dragover", { dataTransfer: dt });
  env.fire(env.row("fE"), "drop", { dataTransfer: dt });
  await ticks(3);
  assert.equal(env.M.cache.folderOf("top"), null);
  await assert.rejects(env.M.library.createFolder("New", null), (e) => e.code === "locked");
  await assert.rejects(env.M.library.renameFolder("fP", "X"), (e) => e.code === "locked");
  env.item(env.menu(env.row("fE")), "Delete").click();
  await env.answer(true);
  await ticks(3);
  assert.equal(env.M.cache.folder("fE").deletedAt, null);
  assert.equal(env.M.cache.folders().length, 3);
  assert.ok(!env.toasts.some((t) => /^(Moved|Deleted|Could not)/.test(t.text)), env.toasts.map((t) => t.text).join(" | "));
  assert.equal(await env.M.store.meta.get("folders").then((l) => l.length), 3, "the store is untouched");
});

/* ------------------------------------------------------------------ fast, and nothing left behind */

test("one move re-renders the home screen once (a folder delete moving 50 books too)", async () => {
  const cols = [];
  for (let i = 0; i < 50; i++) cols.push(book("m" + i, { folderId: "fX" }));
  const env = await library(boot(), { folders: [folderRec("fX", "Many"), folderRec("fY", "Other")], collections: cols });
  let renders = 0;
  const orig = env.lib.appendChild;
  env.lib.appendChild = function (c) { if (c && c.classList && c.classList.contains("lib")) renders++; return orig.call(this, c); };
  await env.M.library.moveTo("collection", "m0", "fY");
  await ticks(3);
  assert.equal(renders, 1);
  renders = 0;
  env.item(env.menu(env.row("fX")), "Delete").click();
  await env.answer(true);
  await until(() => env.M.cache.folderOf("m49") === null);
  await ticks(3);
  assert.equal(renders, 1, "one render for the whole delete");
});

test("no listener is left behind: re-renders, toggles, menus and the picker leave the hosts' listeners as they were", async () => {
  const env = await library(boot(), STD());
  const count = () => [env.lib._l.length, env.doc._l.length, env.win._l.length, env.doc.body._l.length];
  const before = count();
  for (let i = 0; i < 5; i++) {
    env.M.library.render();
    env.row("fP").querySelector(".lib-folder__toggle").click();
    env.menu(env.row("fP"));
    env.M.library.render();
    env.item(env.menu(env.row("top")), "Move to folder…").click();
    env.press("Escape");
  }
  assert.deepEqual(count(), before);
  assert.equal(env.doc.body.querySelectorAll(".lib-picker").length, 0);
});

test("300 books and 50 folders: one counts pass per render (countsBy), nothing per row", async () => {
  const folders = [], cols = [];
  for (let i = 0; i < 50; i++) folders.push(folderRec("f" + i, "Folder " + i, i >= 10 ? "f" + (i % 10) : null));
  for (let i = 0; i < 300; i++) cols.push(i % 3 ? book("b" + i, { folderId: "f" + (i % 50) }) : deck("d" + i, { folderId: i % 2 ? null : "f" + (i % 50) }));
  const prompts = [];
  for (let i = 0; i < 600; i++) prompts.push(due("p" + i, cols[i % 300].id));
  const storage = new Map([["marginalia.openFolders", JSON.stringify(folders.map((f) => f.id))]]);    // everything open
  const env = await library(boot({ storage }), { folders, collections: cols, prompts });
  const calls = { counts: 0, countsBy: 0 };
  const C = env.M.cache, counts = C.counts, countsBy = C.countsBy;
  C.counts = function () { calls.counts++; return counts.apply(this, arguments); };
  C.countsBy = function () { calls.countsBy++; return countsBy.apply(this, arguments); };
  const t = Date.now();
  env.M.library.render();
  const ms = Date.now() - t;
  assert.deepEqual(calls, { counts: 1, countsBy: 1 }, "the total, and one pass for every row and folder");
  assert.equal(env.lib.querySelectorAll(".lib-row--book, .lib-row--deck").length, 300);
  assert.equal(env.lib.querySelectorAll(".lib-row--folder").length, 50);
  assert.ok(ms < 3000, "rendered in " + ms + " ms");
});
