// node --test test/library-dom.test.js — M.library's DOM paths in a small fake browser (no jsdom, no npm):
// the real js/util.js, bus.js, keys.js, pdfview.js and library.js run as classic scripts in a vm context with a
// stub pdfjsLib, a stub M.app / M.cache / M.store. Pins: a password-protected PDF asks in-page on the Add path
// (§19 #40), the §11 duplicate choice never adds a book on a dismissal, "Replace file, keep prompts" leaves free
// notes in place, Review buttons stay enabled with nothing due, Delete → Z, the Settings panel's routed keys, a
// cancelled shortcut recording keeps focus in the panel, the book ⋯ menu removes manual chapter marks, and a
// dismissed "Replace file" picker never turns the next Add PDF into a replacement. "Send all to Obsidian" (the real
// js/obsidian.js with a stub fetch and opener): the item after Export… in the book row, deck row and deck page menus
// (disabled with nothing to send or while it runs), the confirm texts in server and link mode, the confirming click
// as the link's gesture, the refusals; FEATURES A8 (never a card twice): the confirm's new / edited / already-there
// counts, no confirm and no request when everything is there, an edited card sent alone with replaceOnly, a card the
// server no longer finds listed with "Copy notes", the link-mode toasts that name the edited cards (also when the
// notes are too long for one link and are copied instead);
// Settings › Data's "Automatic backup" block in each M.backup status, with its PDFs line (FEATURES B9.6);
// M.library.attachPdf (B9.5: a PDF from the backup folder joins a book without its bytes, the real js/backup.js restoring
// it end to end); a Send all while an import is saving (A10.1).
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

/* ------------------------------------------------------------------ stubs + boot */

// PDF.js 3.x stand-in: "%PDF-ENC" files ask for "secret" through onPassword (update(Error) cancels), others open.
function stubPdfjs() {
  return {
    PasswordResponses: { NEED_PASSWORD: 1, INCORRECT_PASSWORD: 2 },
    getDocument(params) {
      const text = Buffer.from(params.data).toString("latin1");
      const fp = (/FP:(\w+)/.exec(text) || [])[1] || "fpx";
      const pages = Number((/PAGES:(\d+)/.exec(text) || [])[1] || 40);
      let resolve, reject;
      const promise = new Promise((a, b) => { resolve = a; reject = b; });
      const task = { promise, onPassword: null, onProgress: null, destroy() { reject(Object.assign(new Error("Worker was destroyed"), { name: "AbortException" })); return Promise.resolve(); } };
      const pdf = {
        numPages: pages, fingerprints: [fp, null],
        getMetadata: () => Promise.resolve({ info: { Title: "Book " + fp } }),
        getPageLabels: () => Promise.resolve(null),
        getPage: () => Promise.resolve({ rotate: 0, getViewport: () => ({ width: 612, height: 792 }), cleanup() {} }),
        getOutline: () => Promise.resolve([])
      };
      if (/^%PDF-ENC/.test(text)) {
        const ask = (reason) => task.onPassword((pw) => {
          // as PDF.js 3.11.174: a PasswordException that keeps PDF.js's numeric code (1 = NEED_PASSWORD)
          if (pw instanceof Error) { reject(Object.assign(new Error("No password given"), { name: "PasswordException", code: 1 })); return; }
          if (pw === "secret") resolve(pdf); else setTimeout(() => ask(2), 0);
        }, reason);
        setTimeout(() => ask(1), 0);
      } else setTimeout(() => resolve(pdf), 0);
      return task;
    }
  };
}

function boot() {
  const { win, doc, dispatch } = makeBrowser();
  win.pdfjsLib = stubPdfjs();
  const ctx = vm.createContext(win);
  for (const name of ["util", "bus", "keys", "pdfview", "library"]) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, "js", name + ".js"), "utf8"), ctx, { filename: "js/" + name + ".js" });
  }
  const M = win.Marginalia;

  const cols = new Map(), ps = new Map(), due = {};
  const calls = { recontext: [], savePrompt: [], saveDocument: [] };
  M.cache = {
    collections: () => Array.from(cols.values()),
    collection: (id) => cols.get(id) || null,
    promptsOf: (id) => Array.from(ps.values()).filter((p) => p.collectionId === id),
    prompt: (id) => ps.get(id) || null,
    savePrompt(p, opts) { calls.savePrompt.push(p.id); ps.set(p.id, p); M.bus.emit("prompt:saved", { prompt: p }); return Promise.resolve(p); },
    saveCollection(c) { cols.set(c.id, c); M.bus.emit("collection:changed", { collectionId: c.id }); return Promise.resolve(c); },
    removeCollection(id) { const c = cols.get(id); c.deletedAt = Date.now(); M.bus.emit("collection:deleted", { collectionId: id }); return Promise.resolve(c); },
    restoreCollection(id) { const c = cols.get(id); c.deletedAt = null; M.bus.emit("collection:changed", { collectionId: id }); return Promise.resolve(c); },
    counts(id) {
      const n = Array.from(ps.values()).filter((p) => !p.deletedAt && (id == null || p.collectionId === id)).length;
      const d = id == null ? Object.values(due).reduce((a, b) => a + b, 0) : (due[id] || 0);
      return { prompts: n, cards: n, due: d, nextDueAt: null, writtenToday: 0 };
    },
    recontext(id) { calls.recontext.push(id); return Promise.resolve(0); }
  };
  M.store = {
    docs: { saveDocument(rec, bytes) { calls.saveDocument.push(rec.id); return Promise.resolve({ hasBytes: true, chunkCount: 1, chunkSize: bytes.byteLength }); } },
    estimate: () => Promise.resolve({ usage: 1, quota: 1e12, persisted: true }),
    persist: () => Promise.resolve(true),
    mode: () => "idb"
  };

  const toasts = [], confirms = [], routes = [], reviews = [];
  const appState = { owner: "library", screen: "library", cid: null, sheet: 0 };
  const show = (id) => ["library", "deck", "reader"].forEach((s) => doc.getElementById(s).classList.toggle("is-hidden", s !== id));
  M.app = {
    toast(opts) {
      if (opts.id) toasts.filter((t) => t.id === opts.id && !t.closed).forEach((t) => t.close(true));
      const el = doc.createElement("div");
      el.className = "toast";
      el.textContent = opts.text;
      doc.getElementById("toasts").appendChild(el);
      const rec = { id: opts.id, text: opts.text, detail: opts.detail == null ? null : opts.detail, actions: opts.actions || [], ttl: opts.ttl, el, closed: false,
        close() { if (rec.closed) return; rec.closed = true; el.remove(); if (typeof opts.onClose === "function") opts.onClose(); } };
      toasts.push(rec);
      return { id: opts.id, el, close: () => rec.close() };
    },
    confirm(opts) { return new Promise((res) => confirms.push({ opts, res })); },
    route(screen, params) {
      routes.push([screen, params && params.collectionId]);
      appState.screen = screen; appState.cid = (params && params.collectionId) || null;
      show(screen);
      if (screen === "library") M.library.render();
      else if (screen === "deck") M.library.openDeck(params.collectionId);
      return Promise.resolve(true);
    },
    startReview(scope, cid) { reviews.push([scope, cid]); return Promise.resolve(null); },
    setFocusOwner(o) { appState.owner = o; return o; },
    focusOwner: () => appState.owner,
    openShortcuts() { appState.sheet++; return true; },
    current: () => ({ screen: appState.screen, collectionId: appState.cid, promptId: null })
  };
  // the ONE document keydown listener of M.app: records what reaches it
  const appKeys = [];
  doc.addEventListener("keydown", (ev) => { appKeys.push(ev.key); });

  const env = { win, doc, M, cols, ps, due, calls, toasts, confirms, routes, reviews, appState, appKeys };
  env.press = (key, opts) => dispatch(doc.activeElement || doc.body, Object.assign({ type: "keydown", key, bubbles: true, cancelable: true, repeat: false, isComposing: false }, opts || {}));
  env.answer = async (v) => { await until(() => confirms.some((c) => !c.done)); const c = confirms.find((x) => !x.done); c.done = true; c.res(v); await ticks(3); return c.opts; };
  env.lastToast = () => toasts[toasts.length - 1] || null;
  env.toastAction = (t, label) => { const a = t.actions.find((x) => x.label === label); a.run({ close() {} }); if (!a.keep) t.close(); };
  env.byText = (root, sel, text) => root.querySelectorAll(sel).find((e) => e.textContent === text) || null;
  env.prepText = () => { const b = doc.body.querySelector(".lib-prep__text"); return b ? b.textContent : null; };
  return env;
}

function ticks(n) { let p = Promise.resolve(); for (let i = 0; i < n; i++) p = p.then(() => new Promise((r) => setTimeout(r, 0))); return p; }
async function until(pred, what) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (pred()) return; await new Promise((r) => setTimeout(r, 2)); }
  throw new Error("timed out waiting for " + (what || pred.toString()));
}
function pdfFile(name, body) {
  const u8 = new TextEncoder().encode(body);
  return { name, type: "application/pdf", size: u8.length, arrayBuffer: () => Promise.resolve(u8.buffer.slice(0)) };
}
function book(id, extra) {
  return Object.assign({ id, kind: "book", name: "Book " + id, sha256: "sha-old-" + id, hashAlgo: "sha-256", pageCount: 40, pageLabels: null,
    sections: [], lastPosition: { pageIndex: 0, fraction: 0, zoom: "fit" }, addedAt: 1, lastOpenedAt: 1, updatedAt: 1, deletedAt: null,
    hasBytes: true, v: 1 }, extra || {});
}

// M.pdfview's in-page password field, wherever it renders it: {input, form, cancel} or null
function passwordField(env) {
  const input = env.doc.querySelector("input[type=\"password\"]");
  if (!input) return null;
  const form = input.closest("form") || input.parentNode;
  return { input, form, cancel: form.querySelectorAll("button").find((b) => b.textContent === "Cancel") || null };
}
// attached to the document, and no ancestor hidden (.is-hidden, visibility:hidden, display:none, a 0×0 box)
function shown(env, el) {
  if (!el || !env.doc.contains(el)) return false;
  for (let n = el; n && n.nodeType === 1; n = n.parentNode) {
    const css = String(n.getAttribute("style") || "") + ";" + String(n.style.cssText || "");
    if (n.classList.contains("is-hidden") || /visibility:\s*hidden|display:\s*none|width:\s*0(px)?\s*;[^]*height:\s*0/.test(css)) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ tests */

test("a password-protected PDF asks in-page on the Add path; Cancel ends the add and frees the next one (§19 #40)", async () => {
  const env = boot();
  const opens = [];
  const realOpen = env.M.pdfview.open;
  env.M.pdfview.open = (u8, opts) => { opens.push(opts); return realOpen(u8, opts); };
  env.M.library.render();
  const adding = env.M.library.addPdf(pdfFile("locked.pdf", "%PDF-ENC\nFP:lock1\n"));
  let failure = null;
  adding.catch((e) => { failure = e; });
  await until(() => passwordField(env), "the password field");
  const field = passwordField(env);
  assert.equal(opens.length, 1);
  assert.ok(!opens[0] || !opens[0].container, "the metadata open passes no container");
  assert.ok(shown(env, field.form), "the field is in the page where the user sees it");
  assert.ok(!env.doc.getElementById("library").contains(field.form), "not inside a screen host");
  assert.equal(env.doc.activeElement, field.input, "the password input has focus");
  assert.equal(env.prepText(), "Enter the PDF’s password to add it");

  field.cancel.click();
  await until(() => failure, "the add to settle");
  assert.equal(failure.code, "password");
  assert.equal(passwordField(env), null);
  assert.equal(env.prepText(), null, "the Preparing bar is gone");
  assert.equal(env.lastToast().text, "This PDF is password-protected and could not be opened");
  assert.equal(env.cols.size, 0);

  const col = await env.M.library.addPdf(pdfFile("plain.pdf", "%PDF-1.7\nFP:plain1\n"));    // not "busy"
  assert.equal(col.id, "plain1");
  assert.deepEqual(env.routes[env.routes.length - 1], ["reader", "plain1"]);
});

test("a password-protected PDF is added once the right password is typed (a wrong one asks again)", async () => {
  const env = boot();
  env.M.library.render();
  const adding = env.M.library.addPdf(pdfFile("locked.pdf", "%PDF-ENC\nFP:lock2\nPAGES:12\n"));
  await until(() => passwordField(env));
  let field = passwordField(env);
  field.input.value = "nope";
  field.form.dispatchEvent({ type: "submit", bubbles: true, cancelable: true });
  await until(() => { const f = passwordField(env); return f && /Wrong password/.test(f.form.textContent); }, "the retry field");
  field = passwordField(env);
  assert.ok(shown(env, field.form));
  field.input.value = "secret";
  field.form.dispatchEvent({ type: "submit", bubbles: true, cancelable: true });
  const col = await adding;
  assert.equal(col.id, "lock2");
  assert.equal(col.pageCount, 12);
  assert.equal(env.prepText(), null);
  assert.deepEqual(env.calls.saveDocument, ["lock2"]);
});

test("§11 duplicate: a dismissal never adds a book; 'no' then 'yes' adds a separate one, then reopens it", async () => {
  const env = boot();
  env.cols.set("dup1", book("dup1", { name: "Griffiths" }));
  env.M.library.render();

  let failure = null;
  env.M.library.addPdf(pdfFile("annotated.pdf", "%PDF-1.7\nFP:dup1\nv2\n")).catch((e) => { failure = e; });
  const first = await env.answer(false);                 // Esc / backdrop / "Add as a separate book…"
  assert.equal(first.ok, "Replace file, keep prompts");
  const second = await env.answer(false);                // Esc / backdrop / Cancel
  assert.equal(second.title, "Add it as a separate book?");
  await until(() => failure);
  assert.equal(failure.code, "cancelled");
  assert.deepEqual(Array.from(env.cols.keys()), ["dup1"], "nothing was added");
  assert.deepEqual(env.calls.saveDocument, []);
  assert.equal(env.prepText(), null);
  assert.ok(!env.toasts.some((t) => /Could not add/.test(t.text)), "a cancel is silent");

  const sep = env.M.library.addPdf(pdfFile("annotated.pdf", "%PDF-1.7\nFP:dup1\nv2\n"));   // not "busy"
  await env.answer(false);
  await env.answer(true);
  const col = await sep;
  assert.match(col.id, /^dup1:[0-9a-f]{8}$/);
  assert.equal(env.cols.get("dup1").sha256, "sha-old-dup1", "the original keeps its file");

  const again = env.M.library.addPdf(pdfFile("annotated.pdf", "%PDF-1.7\nFP:dup1\nv2\n"));
  await env.answer(false);
  const reopen = await env.answer(true);
  assert.equal(reopen.title, "Open the separate copy?");
  assert.equal((await again).id, col.id);
  assert.equal(env.cols.size, 2);
});

test("'Replace file, keep prompts': quoted passages wait to be re-found, free notes keep their place (§5, §11)", async () => {
  const env = boot();
  env.cols.set("rep1", book("rep1"));
  const prompt = (id, anchor) => ({ id, collectionId: "rep1", kind: "note", text: "x", anchor, deletedAt: null });
  env.ps.set("note12", prompt("note12", { pageIndex: 11, pages: [], quote: "", y: 500, lost: false }));
  env.ps.set("note36", prompt("note36", { pageIndex: 35, pages: [], quote: "", y: 300, lost: false }));
  env.ps.set("passage", prompt("passage", { pageIndex: 4, pages: [{ pageIndex: 4, rects: [[1, 2, 3, 4]] }], quote: "a potential energy function", y: 4, lost: false }));
  env.ps.set("oldLost", prompt("oldLost", { pageIndex: 3, pages: [], quote: "", y: 10, lost: true }));
  env.M.library.render();
  const replacing = env.M.library.addPdf(pdfFile("v2.pdf", "%PDF-1.7\nFP:rep1\nPAGES:30\n"));
  await env.answer(true);
  const col = await replacing;
  assert.equal(col.id, "rep1");
  assert.equal(env.ps.get("note12").anchor.lost, false, "an in-range free note is not 'Passage not found'");
  assert.equal(env.ps.get("note36").anchor.lost, true, "its page is gone (30 pages now)");
  assert.equal(env.ps.get("passage").anchor.lost, true, "re-found lazily by quote");
  assert.equal(env.ps.get("oldLost").anchor.lost, false, "a free note lost by an earlier replace is back");
  assert.deepEqual(env.calls.savePrompt.sort(), ["note36", "oldLost", "passage"], "only changed prompts are written");
  assert.ok(env.calls.recontext.includes("rep1"));
});

test("Review buttons stay enabled with nothing due and open the review (its overlay explains)", async () => {
  const env = boot();
  env.cols.set("b0", book("b0"));
  env.cols.set("d0", { id: "d0", kind: "deck", name: "Verbs", sections: [], addedAt: 1, lastOpenedAt: 2, deletedAt: null });
  env.M.library.render();
  const lib = env.doc.getElementById("library");
  const all = lib.querySelector(".lib__review-all");
  assert.equal(all.disabled, false);
  assert.equal(all.title, "Nothing is due");
  all.click();
  const rowReview = (id) => env.byText(lib.querySelector(".lib-row[data-id=\"" + id + "\"]"), "button", "Review");
  assert.equal(rowReview("b0").disabled, false);
  assert.equal(rowReview("d0").disabled, false);
  rowReview("b0").click();
  rowReview("d0").click();
  env.M.app.route("deck", { collectionId: "d0" });
  const deckBtn = env.byText(env.doc.getElementById("deck"), "button", "Review this deck");
  assert.equal(deckBtn.disabled, false);
  deckBtn.click();
  assert.deepEqual(env.reviews, [["all", null], ["book", "b0"], ["deck", "d0"], ["deck", "d0"]]);
  env.due.d0 = 2;
  env.M.library.render();
  assert.ok(rowReview("d0").classList.contains("btn") && !rowReview("d0").classList.contains("btn--ghost"));
  assert.ok(lib.querySelector(".lib__review-all").classList.contains("btn--primary"));
});

test("Delete → focus stays in the library and Z undoes it while the toast shows (§14)", async () => {
  const env = boot();
  env.cols.set("dA", { id: "dA", kind: "deck", name: "Alpha", sections: [], addedAt: 1, lastOpenedAt: 3, deletedAt: null });
  env.cols.set("dB", { id: "dB", kind: "deck", name: "Beta", sections: [], addedAt: 1, lastOpenedAt: 2, deletedAt: null });
  env.M.library.render();
  const deleting = env.M.library.deleteCollection("dA");
  await env.answer(true);
  assert.equal(await deleting, true);
  assert.ok(env.cols.get("dA").deletedAt);
  const t = env.lastToast();
  assert.equal(t.text, "Deleted · Undo (Z)");
  const a = env.doc.activeElement;
  assert.equal(a.getAttribute("data-focus"), "row:dB:more", "focus lands on the next row, inside #library");
  await ticks(3);                                         // the deferred re-render keeps it there
  assert.equal(env.doc.activeElement.getAttribute("data-focus"), "row:dB:more");

  env.press("z", { code: "KeyZ" });
  await until(() => env.cols.get("dA").deletedAt === null, "the restore");
  assert.equal(t.closed, true, "the undo toast closes");
  assert.ok(!env.appKeys.includes("z"), "handled on #library, before the app's listener");
  assert.equal(env.M.library.undoDelete(), false, "nothing left to undo");
  assert.equal(env.lastToast().text, "Restored “Alpha”");

  const again = env.M.library.deleteCollection("dB");
  await env.answer(true);
  await again;
  env.toastAction(env.lastToast(), "Undo");               // the toast's button still works
  await until(() => env.cols.get("dB").deletedAt === null);
  env.press("z", { code: "KeyZ" });                       // no undo on offer: Z goes on to the app
  assert.ok(env.appKeys.includes("z"));
});

test("Settings panel runs the settings owner's keys: ',' closes, '?' sheet, Mod+O picker, Shift+R / T review", async () => {
  const env = boot();
  env.M.library.render();
  const settings = env.doc.getElementById("settings");
  const open = () => { env.M.library.openSettings("appearance"); assert.ok(!settings.classList.contains("is-hidden")); };

  open();
  assert.ok(env.doc.activeElement.classList.contains("settings__tab--active"));
  env.press(",");
  assert.ok(settings.classList.contains("is-hidden"), "',' toggles Settings shut");
  assert.equal(env.M.library.isSettingsOpen(), false);

  open();
  env.press("?", { shiftKey: true });
  assert.equal(env.appState.sheet, 1, "the shortcut sheet opens above Settings");
  assert.ok(!settings.classList.contains("is-hidden"));

  let picked = 0;
  env.doc.getElementById("fileInput").addEventListener("click", () => { picked++; });
  const cmdO = { type: "keydown", key: "o", code: "KeyO", metaKey: true, bubbles: true, cancelable: true };
  env.doc.activeElement.dispatchEvent(cmdO);
  assert.equal(cmdO.defaultPrevented, true, "never the browser's own Open File");
  assert.equal(picked, 1);
  assert.ok(settings.classList.contains("is-hidden"));

  open();
  env.press("R", { code: "KeyR", shiftKey: true });
  assert.ok(settings.classList.contains("is-hidden"), "the review overlay is not hidden under the panel");
  open();
  env.press("t", { code: "KeyT" });
  assert.deepEqual(env.reviews, [["all", null], ["today", null]]);

  open();
  const model = env.doc.createElement("input");             // a text field keeps its characters
  settings.querySelector(".settings__body").appendChild(model);
  model.focus();
  assert.equal(env.press(","), true, "not prevented");
  assert.ok(!settings.classList.contains("is-hidden"));
  assert.deepEqual(env.appKeys, [], "nothing from inside the panel reached the app's listener");
});

test("Review shortcuts: Esc while recording keeps focus on that key cap, inside the panel", async () => {
  const env = boot();
  env.M.library.render();
  env.M.library.openSettings("shortcuts");
  const settings = env.doc.getElementById("settings");
  const cap = (action) => settings.querySelectorAll("tr").find((tr) => tr.getAttribute("data-action") === action).querySelector(".shortcuts__cap");
  cap("forgot").click();
  assert.ok(env.doc.activeElement.classList.contains("shortcuts__use-esc"));
  env.press("Escape", { code: "Escape" });
  assert.equal(env.doc.activeElement, cap("forgot"), "focus is back on the (rebuilt) cap, not on <body>");
  assert.ok(settings.contains(env.doc.activeElement));
  env.press("t", { code: "KeyT" });                       // routed by the panel, not by the app's listener on <body>
  assert.ok(settings.classList.contains("is-hidden"));
  assert.deepEqual(env.appKeys, []);

  env.M.library.openSettings("shortcuts");
  cap("forgot").click();
  cap("skip").click();                                    // switch the recording to another row
  const row = settings.querySelectorAll("tr").find((tr) => tr.getAttribute("data-action") === "skip");
  assert.ok(row.classList.contains("is-recording"), "the fresh row shows the recording");
  assert.ok(env.doc.activeElement.classList.contains("shortcuts__use-esc"));
  assert.ok(row.contains(env.doc.activeElement));
  env.press("9", { code: "Digit9" });
  assert.equal(env.doc.activeElement, cap("skip"));
  assert.match(cap("skip").textContent, /9/);
});

test("the book ⋯ menu lists manual chapter marks with Remove (§14); Undo puts the mark back", async () => {
  const env = boot();
  env.cols.set("bm", book("bm", { sections: [
    { title: "1 A", label: "Ch. 1 · A", pageIndex: 5, level: 1, source: "outline" },
    { title: "Ch. 3 · Formalism", label: "Ch. 3 · Formalism", pageIndex: 39, level: 1, source: "manual" }
  ] }));
  env.M.library.render();
  const lib = env.doc.getElementById("library");
  lib.querySelector(".lib-row[data-id=\"bm\"] .lib-row__more").click();
  const labels = lib.querySelectorAll(".lib-menu__item").map((b) => b.textContent);
  assert.deepEqual(labels, ["Rename", "Export…", "Replace file", "Remove mark “Ch. 3 · Formalism” · p. 40", "Delete"]);
  env.byText(lib, ".lib-menu__item", "Remove mark “Ch. 3 · Formalism” · p. 40").click();
  await until(() => env.cols.get("bm").sections.length === 1);
  assert.equal(env.cols.get("bm").sections[0].source, "outline");
  await until(() => env.calls.recontext.includes("bm") && env.lastToast(), "the recontext and its toast");
  const t = env.lastToast();
  assert.equal(t.text, "Removed the chapter mark “Ch. 3 · Formalism”");
  env.toastAction(t, "Undo");
  await until(() => env.cols.get("bm").sections.length === 2);
  assert.deepEqual(env.cols.get("bm").sections.map((s) => [s.pageIndex, s.source]), [[5, "outline"], [39, "manual"]]);
});

test("a dismissed 'Replace file' picker never turns the next Add PDF into a replacement", async () => {
  const env = boot();
  env.cols.set("keep", book("keep"));
  env.M.library.render();
  const lib = env.doc.getElementById("library");
  const input = env.doc.getElementById("fileInput");
  lib.querySelector(".lib-row[data-id=\"keep\"] .lib-row__more").click();
  env.byText(lib, ".lib-menu__item", "Replace file").click();
  input.dispatchEvent({ type: "cancel", bubbles: false });            // the user closed the picker
  env.byText(lib, "button", "Add PDF").click();
  input.files = [pdfFile("other.pdf", "%PDF-1.7\nFP:other\n")];
  input.dispatchEvent({ type: "change", bubbles: true });
  await until(() => env.cols.has("other"), "the new book");
  assert.equal(env.cols.get("keep").sha256, "sha-old-keep", "the book was not replaced");

  lib.querySelector(".lib-row[data-id=\"keep\"] .lib-row__more").click();
  env.byText(lib, ".lib-menu__item", "Replace file").click();
  input.files = [pdfFile("keep-v2.pdf", "%PDF-1.7\nFP:keep\nv2\n")];
  input.dispatchEvent({ type: "change", bubbles: true });               // a picked file still replaces
  await until(() => env.cols.get("keep").sha256 !== "sha-old-keep", "the replacement");
  assert.equal(env.confirms.length, 0, "an explicit Replace file asks nothing");
});

test("Settings › Obsidian: a select of the server's vaults, the folder and the method line; a “Vault name” field without the server", async () => {
  const env = boot();
  for (const name of ["settings", "obsidian"]) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, "js", name + ".js"), "utf8"), env.win, { filename: "js/" + name + ".js" });
  }
  const M = env.M;
  assert.equal(M.settings.set("obsidian", true), true);   // DECISIONS D32: the Obsidian connection is switched on
  env.win.location = { protocol: "http:", hostname: "127.0.0.1", origin: "http://127.0.0.1:8791", search: "", hash: "", pathname: "/" };
  let reply = { status: 200, body: { vaults: [{ id: "v1", name: "Test Vault", open: true, attachmentFolder: "Attachments" }] } };
  const gets = [];
  M.obsidian._setFetch((url, init) => {
    gets.push([url, init && init.method]);
    return Promise.resolve({ ok: reply.status === 200, status: reply.status, json: () => Promise.resolve(reply.body) });
  });
  M.library.render();
  M.library.openSettings("obsidian");
  const settings = env.doc.getElementById("settings");
  const tabs = settings.querySelectorAll(".settings__tab").map((b) => b.textContent);
  assert.deepEqual(tabs, ["Appearance", "Review shortcuts", "LaTeX from snips", "Obsidian", "Data"]);
  const method = () => settings.querySelector(".settings__method").textContent;
  await until(() => method() === "Writes straight into the vault", "the server method line");
  assert.deepEqual(gets, [["/api/obsidian/vaults", "GET"]], "opening Settings checked once");
  const sel = settings.querySelector("select");
  assert.ok(sel, "a select of the vaults");
  assert.deepEqual(sel.querySelectorAll("option").map((o) => o.textContent), ["Test Vault (open)"]);
  assert.equal(sel.value, "Test Vault", "the only vault, chosen by default");
  const input = (label) => settings.querySelectorAll("input").find((i) => i.getAttribute("aria-label") === label) || null;
  const folder = input("Folder inside the vault");
  assert.equal(folder.value, "Notes/Marginalia");
  folder.value = "Study//Physics/";
  folder.dispatchEvent({ type: "change", bubbles: false });
  assert.equal(M.settings.get("obsidianFolder"), "Study/Physics");
  assert.equal(folder.value, "Study/Physics");
  assert.ok(env.byText(settings, ".settings__hint", "One note per book or deck, for example Study/Physics/Book nickname.md. Sending a note again updates its copy in the note that holds it, also after a rename or a folder change."));

  reply = { status: 404, body: {} };                      // an older serve.py: obsidian:// links, and "restart" is the advice
  M.library.closeSettings();
  M.library.openSettings("obsidian");
  await until(() => /^Opens obsidian:\/\//.test(method()), "the link method line");
  assert.equal(method(), "Opens obsidian:// links — restart Marginalia (marginalia restart in Terminal) to write silently",
    "plain marginalia only reopens the page while the old server runs");
  assert.equal(settings.querySelector("select"), null);
  const name = input("Vault name");
  assert.ok(name, "a Vault name field for the links");
  name.value = "Obsidian Vault";
  name.dispatchEvent({ type: "change", bubbles: false });
  assert.equal(M.settings.get("obsidianVault"), "Obsidian Vault");
  assert.equal(gets.length, 2, "re-checked when Settings opened again");

  reply = null;                                           // no server answers (stopped): the O1 line
  M.obsidian._setFetch((url, init) => { gets.push([url, init && init.method]); return Promise.reject(new TypeError("Failed to fetch")); });
  M.library.closeSettings();
  M.library.openSettings("obsidian");
  await until(() => gets.length === 3 && /^Opens obsidian:\/\//.test(method()), "the link method line again");
  assert.equal(method(), "Opens obsidian:// links — start Marginalia with the marginalia command to write silently");
  M.library.closeSettings();
});

test("Settings › Obsidian keeps a vault's name exactly as listed, so a name with doubled or edge spaces can be chosen", async () => {
  const env = boot();
  for (const name of ["settings", "obsidian"]) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, "js", name + ".js"), "utf8"), env.win, { filename: "js/" + name + ".js" });
  }
  const M = env.M;
  assert.equal(M.settings.set("obsidian", true), true);   // DECISIONS D32: the Obsidian connection is switched on
  env.win.location = { protocol: "http:", hostname: "127.0.0.1", origin: "http://127.0.0.1:8791", search: "", hash: "", pathname: "/" };
  const names = ["My  Vault", " Lead Vault", "Trail Vault ", "My Vault"];
  M.obsidian._setFetch(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ vaults: names.map((n, i) => ({ id: "v" + i, name: n, open: i === 0 })) }) }));
  M.library.render();
  const settings = env.doc.getElementById("settings");
  const method = () => settings.querySelector(".settings__method").textContent;
  for (const pick of names) {
    M.library.openSettings("obsidian");
    await until(() => method() === "Writes straight into the vault" && settings.querySelector("select"), "the vault select");
    let sel = settings.querySelector("select");
    sel.value = pick;
    sel.dispatchEvent({ type: "change", bubbles: false });
    assert.equal(M.settings.get("obsidianVault"), pick, "stored as listed: " + JSON.stringify(pick));
    M.library.closeSettings();
    M.library.openSettings("obsidian");                     // the next open shows that vault chosen, not "— not found"
    await until(() => method() === "Writes straight into the vault" && settings.querySelector("select"), "the vault select again");
    sel = settings.querySelector("select");
    assert.equal(sel.value, pick);
    assert.ok(sel.querySelectorAll("option").every((o) => !/not found/.test(o.textContent)), JSON.stringify(sel.querySelectorAll("option").map((o) => o.textContent)));
    M.library.closeSettings();
  }
});

/* ------------------------------------------------------------------ Send all to Obsidian (BUILD-NOTES "Obsidian") */

// The real js/prompts, markup and obsidian on the booted page, on a 127.0.0.1 test address; fetch and the opener are
// stubs (nothing opens an obsidian:// URI, nothing reaches a server). reply(url, init) → {status, body} | Error | Promise.
test("Settings › Obsidian (DECISIONS D32): off, the pane shows only the switch and asks nothing; the switch turns the connection on and off", async () => {
  const env = boot();
  for (const name of ["settings", "obsidian"]) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, "js", name + ".js"), "utf8"), env.win, { filename: "js/" + name + ".js" });
  }
  const M = env.M;
  env.win.location = { protocol: "http:", hostname: "127.0.0.1", origin: "http://127.0.0.1:8791", search: "", hash: "", pathname: "/" };
  M.cache.prompts = () => Array.from(env.ps.values());
  const gets = [];
  M.obsidian._setFetch((url, init) => {
    gets.push([url, init && init.method]);
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ vaults: [{ id: "v1", name: "Test Vault", open: true, attachmentFolder: "/" }] }) });
  });
  M.library.render();
  const settings = env.doc.getElementById("settings");
  const sw = () => settings.querySelector(".settings__obsidian-switch");
  const body = () => settings.querySelector(".settings__obsidian-body");
  const offLine = () => settings.querySelector(".settings__obsidian-off");
  const flip = (to) => { const s = sw(); s.checked = to; s.dispatchEvent({ type: "change", bubbles: false }); };

  assert.equal(M.settings.get("obsidian"), null, "never chosen");
  M.library.openSettings("obsidian");
  assert.ok(sw(), "the switch");
  assert.equal(sw().getAttribute("role"), "switch");
  assert.equal(sw().checked, false, "a new library: off");
  assert.ok(body().classList.contains("is-hidden"), "no vault, no folder, no method line");
  assert.ok(!offLine().classList.contains("is-hidden"));
  assert.match(offLine().textContent, /While this is off, Marginalia shows no Obsidian command and asks nothing about Obsidian\.$/);
  assert.ok(env.byText(settings, ".settings__check", " Connect Marginalia to Obsidian"), "its label (the switch, then the words)");
  await ticks(5);
  assert.deepEqual(gets, [], "nothing asked about Obsidian while it is off");

  flip(true);                                             // on
  assert.equal(M.settings.get("obsidian"), true);
  assert.equal(sw().checked, true);
  assert.ok(!body().classList.contains("is-hidden"));
  assert.ok(offLine().classList.contains("is-hidden"));
  await until(() => settings.querySelector(".settings__method").textContent === "Writes straight into the vault", "the check ran");
  assert.deepEqual(gets, [["/api/obsidian/vaults", "GET"]], "one check, when the switch went on");
  assert.ok(settings.querySelector("select"), "the vault select");
  M.library.closeSettings();
  M.library.openSettings("obsidian");
  await until(() => gets.length === 2, "on: opening Settings checks again");
  assert.equal(sw().checked, true);
  assert.ok(!body().classList.contains("is-hidden"));

  flip(false);                                            // off again
  assert.equal(M.settings.get("obsidian"), false);
  assert.ok(body().classList.contains("is-hidden"));
  assert.ok(!offLine().classList.contains("is-hidden"));
  M.library.closeSettings();
  M.library.openSettings("obsidian");
  await ticks(5);
  assert.equal(gets.length, 2, "off: opening Settings asks nothing");
  assert.equal(sw().checked, false);

  // never chosen, in a library that already sent a card (from before the switch existed): the switch shows on
  assert.equal(M.settings.set("obsidian", null), true);
  env.cols.set("bk", book("bk"));
  env.ps.set("s1", card("s1", "bk", 0, { obsidianSentAt: 5, obsidianFile: "Notes/Marginalia/Book bk.md" }));
  M.library.closeSettings();
  M.library.openSettings("obsidian");
  assert.equal(sw().checked, true);
  assert.ok(!body().classList.contains("is-hidden"));
  await until(() => gets.length === 3, "and Settings checks, as before the switch existed");
  flip(false);                                            // that reader turns it off: the choice wins over the record
  assert.equal(M.settings.get("obsidian"), false);
  assert.equal(M.obsidian.enabled(), false);
  M.library.closeSettings();
});

test("Settings › Obsidian follows the switch when it changes elsewhere (another window, DECISIONS D31), and Check again asks nothing while off", async () => {
  const env = boot();
  for (const name of ["settings", "obsidian"]) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, "js", name + ".js"), "utf8"), env.win, { filename: "js/" + name + ".js" });
  }
  const M = env.M;
  env.win.location = { protocol: "http:", hostname: "127.0.0.1", origin: "http://127.0.0.1:8791", search: "", hash: "", pathname: "/" };
  M.cache.prompts = () => Array.from(env.ps.values());
  const gets = [];
  M.obsidian._setFetch((url, init) => {
    gets.push([url, init && init.method]);
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ vaults: [{ id: "v1", name: "Test Vault", open: true, attachmentFolder: "/" }] }) });
  });
  M.library.render();
  const settings = env.doc.getElementById("settings");
  const sw = () => settings.querySelector(".settings__obsidian-switch");
  const body = () => settings.querySelector(".settings__obsidian-body");
  const method = () => settings.querySelector(".settings__method").textContent;
  assert.equal(M.settings.set("obsidian", true), true);
  M.library.openSettings("obsidian");
  await until(() => method() === "Writes straight into the vault", "on: the pane with its rows");
  const asked = gets.length;
  assert.equal(sw().checked, true);

  // the other window turned it off: this pane hears settings:changed (M.settings.reload() emits it) and shows it
  assert.equal(M.settings.set("obsidian", false), true);
  assert.equal(sw().checked, false, "the switch follows");
  assert.ok(body().classList.contains("is-hidden"), "the rows go");
  await ticks(5);
  assert.equal(gets.length, asked, "nothing asked for it");
  // Check again (a click that still reaches the hidden button): nothing is asked while the connection is off
  const again = body().querySelectorAll("button").find((b) => b.textContent === "Check again");
  assert.ok(again, "the Check again button");
  again.click();
  await ticks(5);
  assert.equal(gets.length, asked, "Check again asks nothing while off");

  // and turned on again elsewhere: the switch, the rows, and a fresh check
  assert.equal(M.settings.set("obsidian", true), true);
  assert.equal(sw().checked, true);
  assert.ok(!body().classList.contains("is-hidden"));
  await until(() => gets.length === asked + 1 && method() === "Writes straight into the vault", "one fresh check");
  again.click();
  await until(() => gets.length === asked + 2, "on: Check again asks");

  // another setting changes nothing here; on another tab of Settings the change is not painted, and nothing is asked
  M.settings.set("obsidianFolder", "Reading");
  M.library.openSettings("data");
  const before = gets.length;
  M.settings.set("obsidian", false);
  M.settings.set("obsidian", true);
  await ticks(5);
  assert.equal(gets.length, before, "the Obsidian tab is not on screen: no check");
  M.library.closeSettings();
  const closedAt = gets.length;
  M.settings.set("obsidian", false);                      // Settings is closed: the pane is gone, so a change asks nothing
  M.settings.set("obsidian", true);
  await ticks(5);
  assert.equal(gets.length, closedAt, "Settings is closed: nothing is asked");
});

test("with the Obsidian connection off (DECISIONS D32) no ⋯ menu has Send all to Obsidian, and a send-all started all the same says where to turn it on", async () => {
  const env = boot();
  const o = withObsidian(env, writesAll());
  let on = false;
  env.M.settings = { get: (k) => (k === "obsidian" ? on : undefined) };
  env.cols.set("bk", book("bk", { lastOpenedAt: 3 }));
  env.cols.set("dk", { id: "dk", kind: "deck", name: "Verbs", sections: [], addedAt: 1, lastOpenedAt: 3, deletedAt: null });
  env.ps.set("c1", card("c1", "bk", 0));
  env.ps.set("q1", card("q1", "dk", 0, { anchor: null }));
  env.M.library.render();
  const lib = env.doc.getElementById("library");
  assert.deepEqual(menuOf(env, lib, "bk").map((b) => b.textContent), ["Rename", "Export…", "Replace file", "Delete"]);
  assert.deepEqual(menuOf(env, lib, "dk").map((b) => b.textContent), ["Rename", "Export…", "Delete"]);
  assert.equal(await env.M.library.sendAllToObsidian("bk"), null);
  const t = env.lastToast();
  assert.deepEqual([t.id, t.text, t.actions.length], ["obsidian", "The Obsidian connection is off — turn it on in Settings › Obsidian.", 0]);
  assert.deepEqual([env.confirms.length, o.fetches.length, o.patches.length], [0, 0, 0], "no confirm, no request, nothing marked");
  on = true;                                              // switched on: the item is back, after Export…
  assert.deepEqual(menuOf(env, lib, "bk").map((b) => b.textContent), ["Rename", "Export…", "Send all to Obsidian", "Replace file", "Delete"]);
  assert.deepEqual(menuOf(env, lib, "dk").map((b) => b.textContent), ["Rename", "Export…", "Send all to Obsidian", "Delete"]);
  // the deck page's own ⋯ menu: with the item while on, without it while off
  env.M.app.route("deck", { collectionId: "dk" });
  const deckPage = env.doc.getElementById("deck");
  assert.deepEqual(menuOf(env, deckPage).map((b) => b.textContent), ["Rename", "Export…", "Send all to Obsidian", "Delete"]);
  on = false;
  assert.deepEqual(menuOf(env, deckPage).map((b) => b.textContent), ["Rename", "Export…", "Delete"]);
});

function withObsidian(env, reply) {
  for (const name of ["prompts", "markup", "obsidian"]) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, "js", name + ".js"), "utf8"), env.win, { filename: "js/" + name + ".js" });
  }
  env.win.location = { protocol: "http:", hostname: "127.0.0.1", origin: "http://127.0.0.1:8791", search: "", hash: "", pathname: "/" };
  // DECISIONS D32: the Obsidian connection is switched on (these pages have no settings module: every other key is unset)
  if (!env.M.settings) env.M.settings = { get: (k) => (k === "obsidian" ? true : undefined) };
  else env.M.settings.set("obsidian", true);
  env.M.cache.prompts = () => Array.from(env.ps.values());
  const saves = [], patches = [];
  const save = env.M.cache.savePrompt;
  env.M.cache.savePrompt = (p, opts) => { saves.push({ id: p.id, opts, sentAt: p.obsidianSentAt, file: p.obsidianFile }); return save(p, opts); };
  // as js/cache.js: the send record's fields in place (undefined removes one), no prompt:saved (FEATURES A9)
  env.M.cache.patchPrompts = (changes) => {
    changes.forEach((c) => {
      const p = env.ps.get(c.id);
      if (!p) return;
      patches.push({ id: c.id, fields: Object.assign({}, c.fields) });
      Object.keys(c.fields).forEach((k) => { if (c.fields[k] === undefined) delete p[k]; else p[k] = c.fields[k]; });
    });
    return Promise.resolve(changes.length);
  };
  const o = { opened: [], fetches: [], saves, patches };
  // the send records written ([id, file]) and the markers alone ([id, note]; undefined: removed)
  o.records = () => patches.filter((c) => "obsidianSentAt" in c.fields).map((c) => [c.id, c.fields.obsidianFile]);
  o.markers = () => patches.filter((c) => !("obsidianSentAt" in c.fields)).map((c) => [c.id, c.fields.obsidianPendingFile]);
  env.M.obsidian._setOpener((uri) => { o.opened.push(uri); });
  env.M.obsidian._setFetch((url, init) => {
    o.fetches.push({ url, init });
    return Promise.resolve(reply(url, init)).then((r) => (r instanceof Error ? Promise.reject(r)
      : { ok: r.status >= 200 && r.status < 300, status: r.status, json: () => Promise.resolve(r.body) }));
  });
  o.posts = () => o.fetches.filter((f) => f.url === "/api/obsidian/notes").map((f) => JSON.parse(f.init.body));
  return o;
}
// as tools/serve.py answers GET /api/obsidian/vaults now ("replaceOnly": its /notes honours a block's replaceOnly)
const VAULTS = { status: 200, body: { vaults: [{ id: "v1", name: "Test Vault", open: true, attachmentFolder: "/" }], replaceOnly: true } };
// a /notes endpoint that writes every block: replaced when `known` lists it or it is a replaceOnly block (which the
// server writes only over its earlier block)
function writesAll(known) {
  return (url, init) => {
    if (url === "/api/obsidian/vaults") return VAULTS;
    const b = JSON.parse(init.body);
    return { status: 200, body: { ok: true, file: b.file, created: false,
      results: b.blocks.map((x) => ({ blockId: x.blockId, ok: true, replaced: !!(known && known.includes(x.blockId)) || x.replaceOnly === true })) } };
  };
}
function card(id, cid, page, extra) {
  return Object.assign({ id, collectionId: cid, kind: "qa", text: "Q. " + id + "?\nA. a", tags: [], flagged: false,
    anchor: { pageIndex: page, pages: [{ pageIndex: page, rects: [[72, 600, 300, 612]] }], quote: "the quote of " + id, y: 612, lost: false },
    context: { docName: "Book", sectionLabel: null, pageIndex: page, pageLabel: String(page + 1) }, cards: [], createdAt: page, deletedAt: null, v: 1 }, extra || {});
}
const menuOf = (env, root, rowId) => {
  root.querySelector(rowId ? ".lib-row[data-id=\"" + rowId + "\"] .lib-row__more" : ".deck__more").click();
  return root.querySelectorAll(".lib-menu__item");
};

test("Send all to Obsidian sits after Export… in the book row, deck row and deck page menus; disabled with nothing in it", async () => {
  const env = boot();
  withObsidian(env, writesAll());
  env.cols.set("bk", book("bk", { lastOpenedAt: 3 }));
  env.cols.set("b0", book("b0", { lastOpenedAt: 2 }));
  env.cols.set("dk", { id: "dk", kind: "deck", name: "Verbs", sections: [], addedAt: 1, lastOpenedAt: 3, deletedAt: null });
  env.cols.set("d0", { id: "d0", kind: "deck", name: "Empty", sections: [], addedAt: 1, lastOpenedAt: 2, deletedAt: null });
  env.ps.set("h1", card("h1", "bk", 2, { kind: "highlight", text: "" }));      // a highlight alone is something to send
  env.ps.set("q1", card("q1", "dk", 0, { anchor: null }));
  env.ps.set("gone", card("gone", "d0", 0, { anchor: null, deletedAt: 9 }));
  env.M.library.render();
  const lib = env.doc.getElementById("library");
  let items = menuOf(env, lib, "bk");
  assert.deepEqual(items.map((b) => b.textContent), ["Rename", "Export…", "Send all to Obsidian", "Replace file", "Delete"]);
  assert.equal(items[2].disabled, false);
  items = menuOf(env, lib, "b0");
  assert.equal(items[2].textContent, "Send all to Obsidian");
  assert.equal(items[2].disabled, true, "a book with no prompt has nothing to send");
  assert.equal(items[2].title, "Nothing in it to send yet");
  items = menuOf(env, lib, "dk");
  assert.deepEqual(items.map((b) => b.textContent), ["Rename", "Export…", "Send all to Obsidian", "Delete"]);
  assert.equal(items[2].disabled, false);
  assert.equal(menuOf(env, lib, "d0")[2].disabled, true, "only a deleted prompt");
  env.M.app.route("deck", { collectionId: "dk" });
  items = menuOf(env, env.doc.getElementById("deck"));
  assert.deepEqual(items.map((b) => b.textContent), ["Rename", "Export…", "Send all to Obsidian", "Delete"]);
  assert.equal(items[2].disabled, false);
});

test("Send all (server): the confirm names the new cards, the edited ones updated in place and those already there; Cancel sends nothing, Send writes them", async () => {
  const env = boot();
  const o = withObsidian(env, writesAll(["c2"]));
  const note = "Notes/Marginalia/Book bk.md";
  env.cols.set("bk", book("bk"));
  env.ps.set("c1", card("c1", "bk", 0));
  env.ps.set("c2", card("c2", "bk", 1, { obsidianSentAt: 5, obsidianFile: note, contentUpdatedAt: 6 }));      // edited since its send
  env.ps.set("c3", card("c3", "bk", 2, { kind: "highlight", text: "" }));
  env.ps.set("c4", card("c4", "bk", 3, { obsidianSentAt: 5, obsidianFile: note, contentUpdatedAt: 4 }));      // not edited since
  env.M.library.render();
  const lib = env.doc.getElementById("library");
  menuOf(env, lib, "bk")[2].click();
  let asked = await env.answer(false);
  assert.deepEqual(Object.assign({}, asked), { title: "Send 3 cards to Obsidian?",
    body: "2 new ones are added and 1 edited one is updated in place, in Notes/Marginalia/Book bk.md. 1 already there is skipped.",
    ok: "Send", cancel: "Cancel", danger: false });
  await ticks(3);
  assert.equal(o.posts().length, 0, "Cancel sends nothing");
  assert.deepEqual([o.saves.length, o.patches.length], [0, 0]);

  menuOf(env, lib, "bk")[2].click();
  asked = await env.answer(true);
  assert.equal(asked.title, "Send 3 cards to Obsidian?");
  await until(() => env.toasts.some((t) => /^Sent /.test(t.text)), "the result toast");
  const posts = o.posts();
  assert.equal(posts.length, 1);
  assert.deepEqual([posts[0].vault, posts[0].file, posts[0].title], ["Test Vault", note, "Book bk"]);
  assert.deepEqual(posts[0].blocks.map((b) => [b.blockId, b.replaceOnly === true]), [["c1", false], ["c2", true], ["c3", false]], "c4 is in no request");
  assert.equal(env.lastToast().text, "Sent to Obsidian · Notes/Marginalia/Book bk.md: 2 added, 1 updated, 1 already there");
  assert.deepEqual(Array.from(env.lastToast().actions, (a) => a.label), ["Open in Obsidian"]);
  assert.deepEqual(o.records().sort(), [["c1", note], ["c2", note], ["c3", note]]);
  assert.deepEqual(o.markers().sort(), [["c1", note], ["c2", note], ["c3", note]], "written ahead, before the request");
  assert.equal(o.saves.length, 0, "no prompt:saved: the records go through patchPrompts");
  assert.equal(o.opened.length, 0);

  // right after: everything is there, so no confirm and no request at all
  await until(() => o.records().length === 3 && env.ps.get("c3").obsidianSentAt, "the records");
  const fetched = o.fetches.length;
  menuOf(env, lib, "bk")[2].click();
  await until(() => /^Everything in/.test(env.lastToast().text), "the everything-there toast");
  assert.deepEqual([env.lastToast().text, env.lastToast().detail, env.lastToast().id],
    ["Everything in “Book bk” is already in Obsidian", "Every card was sent before and none was edited since.", "obsidian"]);
  assert.equal(env.confirms.length, 2, "no third confirm");
  assert.equal(o.fetches.length, fetched, "no request, not even the server check");

  // editing one card: the next Send all sends exactly that card, replacing its block
  await new Promise((r) => setTimeout(r, 5));
  env.ps.set("c1", Object.assign({}, env.ps.get("c1"), { text: "Q. c1, edited?\nA. b", contentUpdatedAt: Date.now() }));
  menuOf(env, lib, "bk")[2].click();
  asked = await env.answer(true);
  assert.deepEqual([asked.title, asked.body], ["Send 1 card to Obsidian?", "1 edited one is updated in place, in Notes/Marginalia/Book bk.md. 3 already there are skipped."]);
  await until(() => o.posts().length === 2 && /0 added, 1 updated/.test(env.lastToast().text), "the second send");
  assert.deepEqual(o.posts()[1].blocks.map((b) => [b.blockId, b.replaceOnly === true]), [["c1", true]]);
  assert.match(o.posts()[1].blocks[0].markdown, /\nQ\. c1, edited\?\nA\. b\n/);
  assert.equal(env.lastToast().text, "Sent to Obsidian · Notes/Marginalia/Book bk.md: 0 added, 1 updated, 3 already there");
});

test("Send all (server): an edited card whose earlier copy is gone is listed with Copy notes, and keeps its record", async () => {
  const env = boot();
  const note = "Notes/Marginalia/Book bk.md";
  const o = withObsidian(env, (url, init) => {
    if (url === "/api/obsidian/vaults") return VAULTS;
    const b = JSON.parse(init.body);
    return { status: 200, body: { ok: true, file: b.file, created: false, results: b.blocks.map((x) => (x.replaceOnly
      ? { blockId: x.blockId, ok: false, notFound: true, error: "its earlier copy is no longer in the note" } : { blockId: x.blockId, ok: true, replaced: false })) } };
  });
  env.cols.set("bk", book("bk"));
  env.ps.set("c1", card("c1", "bk", 0));
  env.ps.set("c2", card("c2", "bk", 1, { obsidianSentAt: 5, obsidianFile: note, contentUpdatedAt: 6 }));
  env.ps.set("c3", card("c3", "bk", 2, { obsidianSentAt: 5, obsidianFile: note, contentUpdatedAt: 5 }));
  env.M.library.render();
  menuOf(env, env.doc.getElementById("library"), "bk")[2].click();
  const asked = await env.answer(true);
  assert.equal(asked.body, "1 new one is added and 1 edited one is updated in place, in Notes/Marginalia/Book bk.md. 1 already there is skipped.");
  await until(() => /^Sent to Obsidian/.test(env.lastToast().text), "the result toast");
  const t = env.lastToast();
  assert.equal(t.text, "Sent to Obsidian · Notes/Marginalia/Book bk.md: 1 added, 0 updated, 1 already there");
  assert.equal(t.detail, "1 edited card was not updated: its earlier copy is no longer in the note.");
  assert.deepEqual(Array.from(t.actions, (a) => a.label), ["Copy notes", "Open in Obsidian"]);
  await until(() => o.records().length === 1, "the record of c1");
  assert.deepEqual(o.records().map((r) => r[0]), ["c1"], "nothing recorded for c2");
  assert.equal("obsidianPendingFile" in env.ps.get("c2"), false, "notFound: not written, so no marker");
  assert.deepEqual([env.ps.get("c2").obsidianSentAt, env.ps.get("c2").obsidianFile], [5, note]);
});

test("Send all (obsidian:// link): the confirm says the cards sent before are skipped; the confirming click opens ONE link", async () => {
  const env = boot();
  const o = withObsidian(env, () => new TypeError("Failed to fetch"));       // no server answers: link mode
  env.cols.set("bk", book("bk"));
  env.ps.set("c1", card("c1", "bk", 0));
  env.ps.set("c2", card("c2", "bk", 1, { obsidianSentAt: 5 }));
  env.ps.set("c3", card("c3", "bk", 2));
  env.ps.set("c4", card("c4", "bk", 3, { obsidianSentAt: 5, contentUpdatedAt: 7 }));   // edited since: a link cannot update it
  env.M.library.render();
  const lib = env.doc.getElementById("library");
  menuOf(env, lib, "bk")[2].click();
  const asked = await env.answer(true);
  assert.equal(asked.title, "Send 2 cards to Obsidian?");
  assert.equal(asked.body, "They go to Notes/Marginalia/Book bk.md. 2 sent before are skipped: links can only add.");
  assert.equal(asked.ok, "Send");
  await until(() => o.opened.length === 1, "the link");
  assert.match(o.opened[0], /^obsidian:\/\/new\?file=Notes%2FMarginalia%2FBook%20bk&content=/);
  const content = decodeURIComponent(/&content=([^&]*)/.exec(o.opened[0])[1]);
  assert.match(content, /^<!-- marginalia:c1 -->[^]*<!-- \/marginalia -->\n\n<!-- marginalia:c3 -->[^]*<!-- \/marginalia -->$/, "c2 and c4 were sent before");
  assert.equal(o.fetches.filter((f) => f.url === "/api/obsidian/vaults").length, 1, "one check, before the confirm");
  await until(() => /^Sent to Obsidian/.test(env.lastToast().text), "the result toast");
  assert.equal(env.lastToast().text, "Sent to Obsidian · Notes/Marginalia/Book bk.md: 2 added, 0 updated, 1 already there");
  assert.equal(env.lastToast().detail, "Sent through an obsidian:// link. 1 edited card was not updated: links can only add. " +
    "Start Marginalia with the marginalia command to write silently and update in place.");
  await until(() => env.ps.get("c3").obsidianFile === "Notes/Marginalia/Book bk.md", "the records");
  assert.equal(env.ps.get("c2").obsidianFile, undefined, "the skipped card is left as it was");
  assert.equal(env.ps.get("c4").obsidianSentAt, 5, "so is the edited one");

  menuOf(env, lib, "bk")[2].click();                                       // nothing never sent is left: no confirm at all
  await until(() => /^Nothing new to send/.test(env.lastToast().text), "the nothing-new toast");
  assert.equal(env.lastToast().text, "Nothing new to send — every card of “Book bk” was sent before, and an obsidian:// link can only add");
  assert.equal(env.lastToast().detail, "1 edited card was not updated. Start Marginalia with the marginalia command to write silently and update in place.");
  assert.equal(env.confirms.length, 1);
  assert.equal(o.opened.length, 1);

  env.ps.delete("c4");                                                     // nothing edited either: everything is there
  menuOf(env, lib, "bk")[2].click();
  await until(() => /^Everything in/.test(env.lastToast().text), "the everything-there toast");
  assert.equal(env.lastToast().text, "Everything in “Book bk” is already in Obsidian");
  assert.equal(env.confirms.length, 1);
  assert.equal(o.opened.length, 1);
});

test("Send all (obsidian:// link), too long for one link: the notes are copied, and the toast names the edited card left as it was", async () => {
  const env = boot();
  const o = withObsidian(env, () => new TypeError("Failed to fetch"));       // no server answers: link mode
  const copied = [];
  env.win.navigator.clipboard = { writeText: (t) => { copied.push(t); return Promise.resolve(); } };
  env.cols.set("bk", book("bk"));
  env.ps.set("c1", card("c1", "bk", 0, { text: "Q. " + "w".repeat(40000) + "?\nA. a" }));
  env.ps.set("c2", card("c2", "bk", 1, { text: "Q. " + "v".repeat(40000) + "?\nA. b" }));
  env.ps.set("c3", card("c3", "bk", 2, { obsidianSentAt: 5, obsidianFile: "Notes/Marginalia/Book bk.md", contentUpdatedAt: 7 }));   // edited since
  env.M.library.render();
  menuOf(env, env.doc.getElementById("library"), "bk")[2].click();
  const asked = await env.answer(true);
  assert.equal(asked.body, "They go to Notes/Marginalia/Book bk.md. 1 sent before is skipped: links can only add. " +
    "Too long for an obsidian:// link: they are copied for you to paste into the note.");
  await until(() => /^Notes copied/.test(env.lastToast().text), "the copy toast");
  assert.equal(env.lastToast().text, "Notes copied — paste them into Notes/Marginalia/Book bk.md");
  assert.equal(env.lastToast().detail, "1 edited card was not updated: links can only add. " +
    "Start Marginalia with the marginalia command to write silently and update in place.");
  assert.equal(copied.length, 1);
  assert.match(copied[0], /^<!-- marginalia:c1 -->/);
  assert.ok(!copied[0].includes("marginalia:c3"), "the edited card is not in the copy: its earlier copy stays in the note");
  assert.deepEqual([o.opened.length, o.patches.length], [0, 0], "nothing opened, nothing recorded");
});

test("Send all: refused while that send-all runs (the item says so), in a tab that stepped aside, and without a chosen vault", async () => {
  const env = boot();
  let release;
  const held = new Promise((r) => { release = r; });
  const o = withObsidian(env, (url, init) => (url === "/api/obsidian/vaults" ? VAULTS : held.then(() => writesAll()(url, init))));
  env.cols.set("bk", book("bk"));
  env.ps.set("c1", card("c1", "bk", 0));
  env.M.library.render();
  const lib = env.doc.getElementById("library");
  const sending = env.M.library.sendAllToObsidian("bk");
  await env.answer(true);
  await until(() => o.posts().length === 1, "the request under way");
  const item = menuOf(env, lib, "bk")[2];
  assert.deepEqual([item.textContent, item.disabled], ["Sending to Obsidian…", true]);
  assert.equal(await env.M.library.sendAllToObsidian("bk"), null);
  assert.equal(env.lastToast().text, "Already sending “Book bk” to Obsidian");
  assert.equal(env.confirms.length, 1, "no second confirm");
  release();
  const res = await sending;
  assert.equal(res.sent, 1);
  assert.equal(o.posts().length, 1, "no double send");
  assert.equal(menuOf(env, lib, "bk")[2].textContent, "Send all to Obsidian");

  env.M.store.locked = () => ({ reason: "othertab", by: "tab_b", at: 1 });
  assert.equal(await env.M.library.sendAllToObsidian("bk"), null);
  assert.equal(env.lastToast().text, "Could not send to Obsidian — Marginalia is open in another tab");
  env.M.store.locked = () => null;

  env.ps.set("c2", card("c2", "bk", 1));                                    // a new card, so there is something to send
  const two = { status: 200, body: { vaults: [{ id: "a", name: "A" }, { id: "b", name: "B" }] } };
  env.M.obsidian._setFetch((url) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(url === "/api/obsidian/vaults" ? two.body : {}) }));
  assert.equal(await env.M.library.sendAllToObsidian("bk"), null);
  assert.equal(env.lastToast().text, "Could not send to Obsidian — choose a vault in Settings › Obsidian");
  assert.equal(env.confirms.length, 1);
  assert.equal(o.posts().length, 1);
});

test("the send-all confirm text: new and edited cards, those already there, one card, several notes, a link too long to open", () => {
  const pure = boot().M.library._pure, C = (plan) => Object.assign({}, pure.sendAllConfirm(plan));
  assert.deepEqual(C({ mode: "server", count: 1, fresh: 1, changed: 0, unchanged: 0, sentBefore: 0, file: "N/B.md", files: ["N/B.md"] }),
    { title: "Send 1 card to Obsidian?", body: "1 new one is added, in N/B.md.", ok: "Send", cancel: "Cancel", danger: false });
  assert.equal(C({ mode: "server", count: 5, fresh: 2, changed: 3, unchanged: 4, sentBefore: 7, file: "N/B.md", files: ["N/B.md", "N/Old.md"] }).body,
    "2 new ones are added and 3 edited ones are updated in place, in N/B.md and N/Old.md. 4 already there are skipped.");
  assert.equal(C({ mode: "server", count: 1, fresh: 0, changed: 1, unchanged: 1, sentBefore: 2, file: "N/B.md", files: ["N/B.md"] }).body,
    "1 edited one is updated in place, in N/B.md. 1 already there is skipped.");
  assert.equal(C({ mode: "server", count: 2, fresh: 1, changed: 1, unchanged: 0, sentBefore: 1, file: "N/B.md", files: ["N/B.md"] }).body,
    "1 new one is added and 1 edited one is updated in place, in N/B.md.");
  assert.equal(C({ mode: "server", count: 5, fresh: 5, changed: 0, unchanged: 0, sentBefore: 0, file: "N/B.md", files: ["N/B.md", "N/1.md", "N/2.md"] }).body,
    "5 new ones are added, in N/B.md and 2 other notes.");
  assert.equal(C({ mode: "link", count: 4, fresh: 4, changed: 1, unchanged: 1, sentBefore: 2, file: "N/B.md", files: ["N/B.md"], tooLong: true }).body,
    "They go to N/B.md. 2 sent before are skipped: links can only add. Too long for an obsidian:// link: they are copied for you to paste into the note.");
  assert.equal(C({ mode: "link", count: 1, fresh: 1, sentBefore: 0, file: "N/B.md", files: ["N/B.md"] }).body, "It goes to N/B.md.");
});

test("the send-all toast when there is nothing to send: nothing in it, everything already there, a link with edited cards", () => {
  const pure = boot().M.library._pure, N = (plan) => Object.assign({}, pure.sendAllNothing(plan, "Griffiths"));
  assert.deepEqual(N({ mode: null, count: 0, total: 0 }), { text: "Nothing in “Griffiths” to send to Obsidian", detail: null });
  for (const mode of ["server", "link", null]) {
    assert.deepEqual(N({ mode, count: 0, total: 3, fresh: 0, changed: 0, unchanged: 3 }),
      { text: "Everything in “Griffiths” is already in Obsidian", detail: "Every card was sent before and none was edited since." }, String(mode));
  }
  assert.deepEqual(N({ mode: "link", count: 0, total: 3, fresh: 0, changed: 2, unchanged: 1, outdated: false }),
    { text: "Nothing new to send — every card of “Griffiths” was sent before, and an obsidian:// link can only add",
      detail: "2 edited cards were not updated. Start Marginalia with the marginalia command to write silently and update in place." });
  assert.equal(N({ mode: "link", count: 0, total: 1, fresh: 0, changed: 1, unchanged: 0, outdated: true }).detail,
    "1 edited card was not updated. Restart Marginalia (marginalia restart in Terminal) to write silently and update in place.");
});

const HELD_LINE = (n, restart) => (n === 1 ? "1 card" : n + " cards") + " may already be in Obsidian: a send to Marginalia's server did not finish. " +
  (restart ? "Restart Marginalia (marginalia restart in Terminal)" : "Start Marginalia with the marginalia command") +
  " and send again: it checks the note and never adds a second copy.";

test("FEATURES A9: the confirm names the cards a link holds back and the ones whose last send did not finish; so does the nothing-to-send toast", () => {
  const pure = boot().M.library._pure, C = (plan) => Object.assign({}, pure.sendAllConfirm(plan)), N = (plan) => Object.assign({}, pure.sendAllNothing(plan, "Griffiths"));
  assert.equal(C({ mode: "link", count: 2, fresh: 2, changed: 0, unchanged: 1, sentBefore: 1, held: 3, file: "N/B.md", files: ["N/B.md"] }).body,
    "They go to N/B.md. 1 sent before is skipped: links can only add. " + HELD_LINE(3));
  assert.equal(C({ mode: "link", count: 1, fresh: 1, sentBefore: 0, held: 1, outdated: true, tooLong: true, file: "N/B.md", files: ["N/B.md"] }).body,
    "It goes to N/B.md. Too long for an obsidian:// link: it is copied for you to paste into the note. " + HELD_LINE(1, true));
  assert.deepEqual(C({ mode: "server", count: 1, fresh: 0, changed: 0, rechecked: 1, unchanged: 2, sentBefore: 3, file: "N/B.md", files: ["N/B.md"] }),
    { title: "Send 1 card to Obsidian?", body: "1 whose last send did not finish is updated in place, in N/B.md. 2 already there are skipped.",
      ok: "Send", cancel: "Cancel", danger: false });
  assert.equal(C({ mode: "server", count: 6, fresh: 1, changed: 2, rechecked: 3, unchanged: 0, sentBefore: 5, file: "N/B.md", files: ["N/B.md"] }).body,
    "1 new one is added, 2 edited ones are updated in place and 3 whose last send did not finish are updated in place, in N/B.md.");
  assert.deepEqual(N({ mode: "link", count: 0, total: 2, fresh: 0, changed: 0, unchanged: 0, held: 2, outdated: false }), { text: HELD_LINE(2), detail: null });
  assert.deepEqual(N({ mode: "link", count: 0, total: 3, fresh: 0, changed: 1, unchanged: 1, held: 1, outdated: true }),
    { text: HELD_LINE(1, true), detail: "1 edited card was not updated: links can only add." });
});

test("FEATURES A9 through the ⋯ menu: a link holds a marked card back (named in the confirm and the toast); with only marked cards left, no confirm, the A9.1 toast", async () => {
  const env = boot();
  const o = withObsidian(env, () => new TypeError("Failed to fetch"));       // the server stopped: link mode
  const note = "Notes/Marginalia/Book bk.md";
  env.cols.set("bk", book("bk"));
  env.ps.set("c1", card("c1", "bk", 0));
  env.ps.set("m1", card("m1", "bk", 1, { obsidianPendingFile: note }));     // its send to the server did not finish
  env.M.library.render();
  const lib = env.doc.getElementById("library");
  menuOf(env, lib, "bk")[2].click();
  const asked = await env.answer(true);
  assert.deepEqual([asked.title, asked.body], ["Send 1 card to Obsidian?", "It goes to " + note + ". " + HELD_LINE(1)]);
  await until(() => /^Sent to Obsidian/.test(env.lastToast().text), "the result toast");
  const content = decodeURIComponent(/&content=([^&]*)/.exec(o.opened[0])[1]);
  assert.ok(content.includes("marginalia:c1") && !content.includes("marginalia:m1"), "the marked card is not in the link");
  assert.equal(env.lastToast().detail, "Sent through an obsidian:// link. " + HELD_LINE(1));
  assert.deepEqual([env.ps.get("m1").obsidianPendingFile, env.ps.get("m1").obsidianSentAt], [note, undefined], "held back as it was");

  menuOf(env, lib, "bk")[2].click();                                       // c1 is there now; m1 still waits for the server
  await until(() => /may already be in Obsidian/.test(env.lastToast().text), "the held toast");
  assert.deepEqual([env.lastToast().text, env.lastToast().id, env.confirms.length, o.opened.length], [HELD_LINE(1), "obsidian", 1, 1]);
  assert.equal(env.lastToast().ttl, 12000, "as long as every other toast with the held line (repair A9-R7)");
});

test("FEATURES A9 through the ⋯ menu (server): a marked card that is otherwise unchanged is in the confirm and goes, with replaceOnly", async () => {
  const env = boot();
  const o = withObsidian(env, writesAll());
  const note = "Notes/Marginalia/Book bk.md";
  env.cols.set("bk", book("bk"));
  env.ps.set("u1", card("u1", "bk", 0, { obsidianSentAt: 5, obsidianFile: note, contentUpdatedAt: 5, obsidianPendingFile: note }));
  env.ps.set("u2", card("u2", "bk", 1, { obsidianSentAt: 5, obsidianFile: note, contentUpdatedAt: 5 }));
  env.M.library.render();
  menuOf(env, env.doc.getElementById("library"), "bk")[2].click();
  const asked = await env.answer(true);
  assert.deepEqual([asked.title, asked.body], ["Send 1 card to Obsidian?", "1 whose last send did not finish is updated in place, in " + note + ". 1 already there is skipped."]);
  await until(() => /^Sent to Obsidian/.test(env.lastToast().text), "the result toast");
  assert.deepEqual(o.posts().map((b) => b.blocks.map((x) => [x.blockId, x.replaceOnly === true])), [[["u1", true]]]);
  assert.equal(env.lastToast().text, "Sent to Obsidian · " + note + ": 0 added, 1 updated, 1 already there");
  assert.equal("obsidianPendingFile" in env.ps.get("u1"), false, "settled");
  assert.equal(o.saves.length, 0, "no prompt:saved");
});

/* ------------------------------------------------------------------ Settings › Data › Automatic backup (M.backup) */

test("Settings › Data: the Automatic backup block in each M.backup status; the switch, Back up now and its toast", async () => {
  const env = boot();
  const M = env.M;
  let state = { status: "checking", dir: null, today: null, last: null, error: null };
  const calls = { enabled: [], runs: 0, refresh: 0 };
  let runReply = { ok: true, file: "marginalia-backup-2026-11-09.json", bytes: 1572864 };
  M.backup = {
    start() {}, state: () => state, refresh: () => { calls.refresh++; return Promise.resolve(state); },
    runNow: () => { calls.runs++; return Promise.resolve(runReply); },
    setEnabled: (on) => { calls.enabled.push(on); state = Object.assign({}, state, { status: on ? "on" : "off" }); M.bus.emit("backup:state", state); }
  };
  const values = { autoBackup: true };
  M.settings = { get: (k) => values[k], set: (k, v) => { values[k] = v; return true; } };
  M.library.render();
  M.library.openSettings("data");
  const settings = env.doc.getElementById("settings");
  const block = () => settings.querySelector(".settings__backup");
  const line = () => block().querySelector(".settings__backup-status").textContent;
  const sw = () => block().querySelector(".settings__backup-switch");
  const now = () => block().querySelector(".settings__backup-now");
  const problem = () => block().querySelector(".settings__backup-error");
  const set = (s) => { state = Object.assign({ dir: "~/Documents/Marginalia Backups", today: "2026-11-09", last: null, error: null }, s); M.bus.emit("backup:state", state); };

  assert.ok(block(), "the block is there");
  assert.equal(calls.refresh, 1, "opening it asks the server again");
  assert.equal(block().querySelector(".settings__label").textContent, "Automatic backup");
  assert.equal(line(), "Checking for Marginalia’s server…");
  assert.deepEqual([sw().checked, sw().disabled, now().disabled], [true, false, true]);
  assert.equal(sw().getAttribute("role"), "switch");
  assert.equal(sw().parentNode.textContent, " Back up automatically every day");
  assert.ok(env.byText(block(), ".settings__hint", "Each backup also saves the PDFs that are not in the folder yet. To restore: Import a file from that folder; " +
    "Marginalia then takes each book’s PDF from its PDFs folder by itself (a book whose PDF is not there says Choose file again)."));

  set({ status: "on", last: { name: "marginalia-backup-2026-11-08.json", date: "2026-11-08", bytes: 1572864 } });
  assert.equal(line(), "Every day to ~/Documents/Marginalia Backups · last: 2026-11-08 (1.5 MB)");
  assert.deepEqual([sw().checked, sw().disabled, now().disabled], [true, false, false]);
  assert.ok(problem().classList.contains("is-hidden"));
  set({ status: "on" });
  assert.equal(line(), "Every day to ~/Documents/Marginalia Backups · no backup yet");
  set({ status: "on", error: "the folder is not writable", last: { name: "x", date: "2026-11-01", bytes: 2048 } });
  assert.equal(problem().textContent, "Today’s automatic backup failed — the folder is not writable");
  assert.ok(!problem().classList.contains("is-hidden"));
  set({ status: "on", running: true });
  assert.deepEqual([now().disabled, now().textContent], [true, "Backing up…"], "an automatic backup under way");
  set({ status: "on", enabled: true });
  assert.deepEqual([now().disabled, now().textContent], [false, "Back up now"]);
  set({ status: "off" });
  assert.equal(line(), "Off");
  assert.deepEqual([sw().checked, sw().disabled, now().disabled], [false, false, false]);
  set({ status: "outdated" });
  assert.equal(line(), "Restart Marginalia (marginalia restart in Terminal) to turn on automatic backups");
  assert.deepEqual([sw().checked, sw().disabled, now().disabled], [true, false, true]);
  values.autoBackup = false;
  set({ status: "outdated" });
  assert.equal(sw().checked, false, "the setting, while the server cannot say");
  values.autoBackup = true;
  set({ status: "outdated", enabled: false });
  assert.equal(sw().checked, false, "M.backup's own word on the setting wins");
  set({ status: "unavailable", reason: "artifact", error: "not available in the claude.ai copy" });
  assert.equal(line(), "Needs the marginalia command — not available in the claude.ai copy or a saved file");
  assert.deepEqual([sw().disabled, now().disabled], [true, true]);
  assert.ok(problem().classList.contains("is-hidden"), "the status line says it already");
  set({ status: "unavailable", reason: "no_server", error: "Marginalia's server did not answer" });
  assert.equal(problem().textContent, "Marginalia's server did not answer");
  assert.ok(!problem().classList.contains("is-hidden"));

  // the switch → setEnabled(bool); its "backup:state" repaints
  set({ status: "on" });
  sw().checked = false;
  sw().dispatchEvent({ type: "change", bubbles: true });
  assert.deepEqual(calls.enabled, [false]);
  assert.equal(line(), "Off");
  sw().checked = true;
  sw().dispatchEvent({ type: "change", bubbles: true });
  assert.deepEqual(calls.enabled, [false, true]);
  assert.match(line(), /^Every day to /);

  // Back up now → runNow() and a toast with the result
  now().click();
  assert.equal(now().disabled, true, "one at a time");
  await until(() => env.toasts.some((t) => t.id === "backup"), "the backup toast");
  assert.equal(calls.runs, 1);
  assert.equal(env.lastToast().text, "Backed up · ~/Documents/Marginalia Backups/marginalia-backup-2026-11-09.json (1.5 MB)");
  assert.equal(now().disabled, false);
  runReply = { ok: false, error: "the backup folder is not writable" };
  now().click();
  await until(() => /^Backup failed/.test(env.lastToast().text), "the failure toast");
  assert.equal(env.lastToast().text, "Backup failed — the backup folder is not writable");

  // other tabs and a closed panel are left alone by the event; without M.backup the pane has no block
  M.library.openSettings("appearance");
  set({ status: "off" });
  M.library.closeSettings();
  set({ status: "on" });
  delete M.backup;
  M.library.openSettings("data");
  assert.equal(settings.querySelector(".settings__backup"), null, "an older bundle or a test without M.backup");
  assert.ok(env.byText(settings, "button", "Export…"), "the rest of the Data pane is there");
  M.library.closeSettings();
});

test("Settings › Data: the PDFs line (FEATURES B9.6): N saved in <dir>/PDFs (size), the upload under way, why it failed, an older server", async () => {
  const env = boot();
  const M = env.M;
  let state = { status: "on", dir: "~/Documents/Marginalia Backups", today: "2026-11-09", last: null, error: null, pdfs: null };
  M.backup = { start() {}, state: () => state, refresh: () => Promise.resolve(state), runNow: () => Promise.resolve({ ok: true }), setEnabled() {} };
  M.library.render();
  M.library.openSettings("data");
  const block = () => env.doc.getElementById("settings").querySelector(".settings__backup");
  const pdfs = () => block().querySelector(".settings__backup-pdfs");
  const why = () => block().querySelector(".settings__backup-pdf-error");
  const set = (s) => { state = Object.assign({}, state, s); M.bus.emit("backup:state", state); };
  assert.ok(pdfs().classList.contains("is-hidden"), "not listed yet: no line");
  set({ pdfs: { saved: 3, bytes: 12 * 1048576 + 300 * 1024, dir: "~/Documents/Marginalia Backups", running: false, left: 0, error: null, outdated: false } });
  assert.equal(pdfs().textContent, "PDFs: 3 saved in ~/Documents/Marginalia Backups/PDFs (12 MB)");
  assert.ok(!pdfs().classList.contains("is-hidden"));
  assert.ok(why().classList.contains("is-hidden"));
  set({ pdfs: Object.assign({}, state.pdfs, { running: true, left: 2 }) });
  assert.equal(pdfs().textContent, "PDFs: 3 saved in ~/Documents/Marginalia Backups/PDFs (12 MB) · saving 2 more…");
  set({ pdfs: Object.assign({}, state.pdfs, { running: false, left: 0, error: "Could not save the PDF of “Griffiths” to the backup folder — the disk is full" }) });
  assert.equal(why().textContent, "Could not save the PDF of “Griffiths” to the backup folder — the disk is full");
  assert.ok(why().classList.contains("settings__status--bad") && !why().classList.contains("is-hidden"));
  set({ status: "off" });
  assert.match(pdfs().textContent, /^PDFs: 3 saved in /, "also while the switch is off");
  set({ status: "on", pdfs: { saved: null, bytes: null, dir: null, running: false, left: 0, error: null, outdated: true } });
  assert.equal(pdfs().textContent, "PDFs: restart Marginalia (marginalia restart in Terminal) to back them up too");
  set({ status: "unavailable", reason: "artifact" });
  assert.ok(pdfs().classList.contains("is-hidden") && why().classList.contains("is-hidden"), "no server: no PDFs line");
  const P = M.library._pure;
  assert.equal(P.pdfLine({ status: "on", dir: "~/B", pdfs: { saved: 0, bytes: 0, dir: null } }), "PDFs: 0 saved in ~/B/PDFs (0 B)");
  assert.equal(P.pdfLine({ status: "checking", pdfs: { saved: 1, bytes: 1 } }), "");
  assert.equal(P.pdfProblem({ status: "on", pdfs: { error: "could not save the PDFs — no" } }), "Could not save the PDFs — no");
  M.library.closeSettings();
});

// FEATURES B9.5: M.library.attachPdf with the real hashing (webcrypto) and the stub store / cache of boot().
function pdfBody(tag) { return new TextEncoder().encode("%PDF-1.7\n% FP:" + tag + " PAGES:12\n" + "x".repeat(200) + "\n%%EOF\n"); }
async function hexOf(u8) { return Buffer.from(await webcrypto.subtle.digest("SHA-256", u8)).toString("hex"); }

test("attachPdf (FEATURES B9.5): the PDF joins a book without its bytes as Choose file again would, after the SHA-256 check; the row reads Continue reading", async () => {
  const env = boot();
  const M = env.M, u8 = pdfBody("one"), sha = await hexOf(u8);
  env.cols.set("bk", book("bk", { hasBytes: false, chunkCount: 0, sha256: sha, lastOpenedAt: 7, sections: [{ id: "s1", title: "Ch. 1", pageIndex: 0, level: 1, source: "manual" }] }));
  M.library.render();
  const lib = env.doc.getElementById("library");
  assert.ok(env.byText(lib, "button", "Choose file again"));
  const before = Object.assign({}, env.cols.get("bk"));
  const rec = await M.library.attachPdf("bk", u8);
  assert.deepEqual(env.calls.saveDocument, ["bk"], "record and bytes in one store write");
  assert.equal(rec.hasBytes, true);
  assert.equal(env.cols.get("bk"), rec, "the cache holds the new record");
  for (const k of ["id", "name", "sha256", "hashAlgo", "pageCount", "sections", "lastPosition", "lastOpenedAt", "addedAt"]) {
    assert.deepEqual(rec[k], before[k], k + " kept: the same file");
  }
  assert.deepEqual([env.routes.length, env.calls.recontext.length], [0, 0], "nothing opens, nothing is re-derived");
  M.library.render();
  assert.equal(env.byText(lib, "button", "Choose file again"), null);
  assert.ok(env.byText(lib, "button", "Continue reading"), "the book opens normally");
  await assert.rejects(M.library.attachPdf("bk", u8), (e) => e.code === "has_bytes");
});

// DECISIONS D31 (BUILD-NOTES "Windows"): the windows of the Mac app hand the writer role to each other.
test("D31: a PDF that is added takes the writer role before it is compared with the library, and keeps it until it is stored", async () => {
  const env = boot();
  const M = env.M, order = [];
  // M.store.during as js/store.js gives it: the work's own promise, and the role is kept until it ends
  M.store.during = (work) => {
    order.push("during");
    const p = Promise.resolve(typeof work === "function" ? work() : work);
    p.then(() => order.push("ended"), (e) => order.push("ended:" + (e && e.code)));
    return p;
  };
  let role = true;
  M.app.takeRole = () => { order.push("takeRole"); return Promise.resolve(role); };
  const store = M.store.docs.saveDocument;
  M.store.docs.saveDocument = (rec, bytes) => { order.push("store"); return store(rec, bytes); };
  const col = await M.library.addPdf(pdfFile("plain.pdf", "%PDF-1.7\nFP:role1\n"));
  assert.equal(col.id, "role1");
  await Promise.resolve();
  assert.deepEqual(order, ["during", "takeRole", "store", "ended"], "the role first (the library as it is now), then the compare and the store, all under during()");
  // the role does not come (another window keeps it and this ask was ended): nothing is stored, and the user is told
  order.length = 0;
  role = false;
  M.store.locked = () => ({ reason: "window", by: null, at: 1 });
  const refused = await M.library.addPdf(pdfFile("other.pdf", "%PDF-1.7\nFP:role2\n")).then(() => "added", (e) => e.code);
  assert.equal(refused, "locked");
  await Promise.resolve();
  assert.deepEqual(order, ["during", "takeRole", "ended:locked"]);
  assert.equal(env.cols.has("role2"), false);
  assert.equal(env.lastToast().text, "Not added: another Marginalia window was in use. Add the PDF again.");
  assert.equal(env.prepText(), null, "the Preparing bar is gone");
  // in a browser tab that stepped aside (the legacy rule) the words are as before
  M.store.locked = () => ({ reason: "othertab", by: "tab_b", at: 1 });
  await M.library.addPdf(pdfFile("third.pdf", "%PDF-1.7\nFP:role3\n")).catch(() => null);
  assert.match(env.lastToast().text, /^Could not add the PDF/);
  M.store.locked = () => null;
  // a PDF that comes back from the backup folder (attachPdf) keeps the role while it is hashed and stored
  order.length = 0;
  role = true;
  const u8 = pdfBody("role"), sha = await hexOf(u8);
  env.cols.set("bk", book("bk", { hasBytes: false, chunkCount: 0, sha256: sha }));
  await M.library.attachPdf("bk", u8);
  await Promise.resolve();
  assert.deepEqual(order, ["during", "store", "ended"]);
  // without M.store.during and M.app.takeRole (an older store, a test stub) both work as before
  delete M.store.during;
  delete M.app.takeRole;
  const plain2 = await M.library.addPdf(pdfFile("plain2.pdf", "%PDF-1.7\nFP:role4\n"));
  assert.equal(plain2.id, "role4");
});

test("attachPdf refuses another file, a non-PDF, a book that has its bytes or is gone, a tab that stepped aside, and an Add PDF under way", async () => {
  const env = boot();
  const M = env.M, u8 = pdfBody("one"), other = pdfBody("two"), sha = await hexOf(u8);
  env.cols.set("bk", book("bk", { hasBytes: false, sha256: sha }));
  env.cols.set("has", book("has", { sha256: sha }));
  env.cols.set("old", book("old", { hasBytes: false, sha256: "a1b2c3d4e5f60718", hashAlgo: "fnv1a" }));
  env.cols.set("gone", book("gone", { hasBytes: false, sha256: sha, deletedAt: 5 }));
  const code = (p) => p.then(() => "attached", (e) => e.code);
  assert.equal(await code(M.library.attachPdf("bk", other)), "mismatch", "another PDF: its SHA-256 differs");
  assert.equal(await code(M.library.attachPdf("bk", new TextEncoder().encode("not a pdf at all"))), "not_pdf");
  assert.equal(await code(M.library.attachPdf("has", u8)), "has_bytes");
  assert.equal(await code(M.library.attachPdf("old", u8)), "mismatch", "no SHA-256 to check against");
  assert.equal(await code(M.library.attachPdf("gone", u8)), "not_found");
  assert.equal(await code(M.library.attachPdf("nope", u8)), "not_found");
  M.store.locked = () => ({ reason: "othertab", by: "tab_b", at: 1 });
  assert.equal(await code(M.library.attachPdf("bk", u8)), "locked");
  M.store.locked = () => null;
  // an Add PDF holds the library: the restore waits for another time, and Add PDF meanwhile is refused as for two adds
  let release;
  M.store.docs.saveDocument = (rec, bytes) => new Promise((r) => { release = () => r({ hasBytes: true, chunkCount: 1, chunkSize: bytes.byteLength }); });
  const first = M.library.attachPdf("bk", u8);
  await until(() => typeof release === "function", "the store write");
  await assert.rejects(M.library.addPdf(pdfFile("x.pdf", "%PDF-1.7 FP:x")), (e) => e.code === "busy");
  assert.equal(await code(M.library.attachPdf("bk", u8)), "busy");
  release();
  assert.equal((await first).hasBytes, true);
  assert.equal(env.calls.saveDocument.length, 0, "only the held write (the stub above) stored anything");
  // the record changed while the bytes were hashed: nothing is written
  env.cols.set("bk2", book("bk2", { hasBytes: false, sha256: sha }));
  const late = M.library.attachPdf("bk2", u8);
  env.cols.set("bk2", Object.assign({}, env.cols.get("bk2"), { hasBytes: true }));
  assert.equal(await code(late), "changed");
});

// Repair B9-R1 / LIB-1 (2026-11-11), the "Choose file again" / "Replace file" path (storeBook): the "Storing …" bar
// does not hold the library, so a rename, a move or a delete of that very book can land while its PDF is stored. The
// record saved at the end is the book as it is then, with the new file's fields; a deleted book is not brought back.
// (test/pdf-restore-race.test.js pins the same for attachPdf with the real M.cache and M.store.)
test("Choose file again: a rename and a move made while the PDF is stored stay; a book deleted meanwhile is not brought back", async () => {
  const env = boot();
  const M = env.M;
  const plainSave = M.store.docs.saveDocument;
  const hold = () => {                                     // the next store write waits for h.release()
    const h = {};
    M.store.docs.saveDocument = (rec, bytes) => new Promise((r) => {
      M.store.docs.saveDocument = plainSave;
      h.release = () => r({ hasBytes: true, chunkCount: 1, chunkSize: bytes.byteLength });
    });
    return h;
  };
  const body1 = "%PDF-1.7\nFP:rb1\nPAGES:12\n", sha1 = await hexOf(new TextEncoder().encode(body1));
  env.cols.set("rb1", book("rb1", { name: "Griffiths", hasBytes: false, chunkCount: 0, sha256: sha1, pageCount: 12 }));
  M.library.render();
  let h = hold();
  const adding = M.library.addPdf(pdfFile("griffiths.pdf", body1));
  await until(() => typeof h.release === "function", "the store write");
  await M.library.renameCollection("rb1", "Intro to QM");
  const moved = env.cols.get("rb1");
  moved.folderId = "fX";                                   // a move (this stub cache keeps no folders)
  await M.cache.saveCollection(moved);
  h.release();
  const col = await adding;
  assert.equal(col, env.cols.get("rb1"));
  assert.deepEqual([col.name, col.folderId, col.hasBytes, col.sha256], ["Intro to QM", "fX", true, sha1], "the rename and the move stay");
  assert.deepEqual(env.routes[env.routes.length - 1], ["reader", "rb1"]);

  const body2 = "%PDF-1.7\nFP:rb2\nPAGES:12\n", sha2 = await hexOf(new TextEncoder().encode(body2));
  env.cols.set("rb2", book("rb2", { name: "Jackson", hasBytes: false, chunkCount: 0, sha256: sha2, pageCount: 12 }));
  h = hold();
  let failure = null;
  const adding2 = M.library.addPdf(pdfFile("jackson.pdf", body2)).catch((e) => { failure = e; });
  await until(() => typeof h.release === "function", "the second store write");
  await M.cache.removeCollection("rb2");
  const tomb = env.cols.get("rb2");
  h.release();
  await adding2;
  assert.equal(failure && failure.code, "changed");
  assert.equal(env.cols.get("rb2"), tomb, "the deleted book is not replaced by a live copy");
  assert.ok(tomb.deletedAt);
  assert.equal(env.lastToast().text, "The book was deleted while its PDF was being stored, so the PDF was not added");
  assert.ok(!env.routes.some((r) => r[1] === "rb2"), "nothing opens");
  assert.equal(env.prepText(), null, "the Storing bar is gone");
  const again = M.library.addPdf(pdfFile("again.pdf", "%PDF-1.7\nFP:new1\n"));
  await until(() => env.routes.some((r) => r[1] === "new1"), "the next add");
  assert.equal((await again).id, "new1", "the library is not left busy");
});

test("the backup folder restores a book end to end: the real js/backup.js finds it, attachPdf joins it, one toast, the row reads Continue reading", async () => {
  const env = boot();
  const M = env.M, u8 = pdfBody("one"), sha = await hexOf(u8);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "js", "backup.js"), "utf8"), env.win, { filename: "js/backup.js" });
  env.win.location = { protocol: "http:", hostname: "127.0.0.1", origin: "http://127.0.0.1:8791", search: "", hash: "", pathname: "/" };
  env.cols.set("bk", book("bk", { hasBytes: false, sha256: sha }));
  env.cols.set("other", book("other", { hasBytes: false, sha256: "f".repeat(64) }));   // its PDF is not saved
  const asked = [];
  M.backup._setFetch((url, init) => {
    asked.push((init && init.method || "GET") + " " + url);
    if (url === "/api/backup/pdfs") return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, dir: "~/B", files: [{ sha12: sha.slice(0, 12), name: "Book bk [" + sha.slice(0, 12) + "].pdf", bytes: u8.length }] }) });
    if (url === "/api/backup/pdf/" + sha) return Promise.resolve({ ok: true, status: 200, headers: { get: () => String(u8.length) }, arrayBuffer: () => Promise.resolve(u8.slice().buffer) });
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ ok: false, error: "not found" }) });
  });
  const r = await M.backup.restorePdfs();
  assert.deepEqual([r.ok, r.restored, r.failed.length], [true, 1, 0]);
  assert.deepEqual(asked, ["GET /api/backup/pdfs", "GET /api/backup/pdf/" + sha]);
  assert.deepEqual(env.calls.saveDocument, ["bk"]);
  assert.equal(env.cols.get("bk").hasBytes, true);
  assert.equal(env.cols.get("other").hasBytes, false, "no saved PDF: Choose file again stays");
  assert.deepEqual([env.lastToast().id, env.lastToast().text], ["backup-restore", "Restored 1 PDF from your backup folder"]);
  M.library.render();
  const row = env.doc.getElementById("library").querySelector(".lib-row[data-id=\"bk\"]");
  assert.ok(env.byText(row, "button", "Continue reading"));
  M.backup._reset();
});

test("Send all to Obsidian while an import is saving (FEATURES A10.1): the wait toast, no confirm, no request", async () => {
  const env = boot();
  const o = withObsidian(env, writesAll());
  env.cols.set("bk", book("bk"));
  env.ps.set("c1", card("c1", "bk", 0));
  env.M.library.render();
  let importing = true;
  env.M.exporter = { isImporting: () => importing };
  assert.equal(await env.M.library.sendAllToObsidian("bk"), null);
  const t = env.lastToast();
  assert.deepEqual([t.id, t.text, t.actions.length], ["obsidian", "Wait until the import finishes, then send again.", 0]);
  assert.deepEqual([env.confirms.length, o.fetches.length, o.patches.length], [0, 0, 0], "no confirm, no request, nothing marked");
  const one = await env.M.obsidian.send("c1", { fromGesture: true });
  assert.equal(one.error, "an import is still saving");
  assert.equal(env.lastToast().text, "Wait until the import finishes, then send again.");
  assert.equal(o.fetches.length, 0);
  importing = false;
  const sending = env.M.library.sendAllToObsidian("bk");
  await env.answer(true);
  const res = await sending;
  assert.deepEqual([res.ok, res.sent], [true, 1], "once the import finished");
});

test("Review shortcuts list Flag for revision and Delete prompt, rebindable; a legacy map shows the rule's result (FEATURES P1.3 a)", async () => {
  const env = boot();
  const stored = { value: { showAnswer: "Space", forgot: "1", remembered: "2", undo: "u", skip: "f", goToSource: "g", exit: "Escape" } };
  const hadSettings = Object.prototype.hasOwnProperty.call(env.M, "settings"), oldSettings = env.M.settings;
  env.M.settings = { get: (k) => (k === "reviewKeys" ? JSON.parse(JSON.stringify(stored.value)) : undefined), set: (k, v) => { if (k === "reviewKeys") stored.value = v; return true; } };
  try {
    env.M.library.render();
    env.M.library.openSettings("shortcuts");
    const settings = env.doc.getElementById("settings");
    const rowOf = (action) => settings.querySelectorAll("tr").find((tr) => tr.getAttribute("data-action") === action);
    const cells = (action) => { const tr = rowOf(action); return [tr.querySelector(".shortcuts__action").textContent, tr.querySelector(".shortcuts__cap").textContent]; };
    assert.deepEqual(settings.querySelectorAll("tr").map((tr) => tr.getAttribute("data-action")).filter(Boolean),
      ["showAnswer", "forgot", "remembered", "undo", "skip", "goToSource", "flag", "delete", "exit"]);
    assert.deepEqual(cells("flag"), ["Flag for revision", "unbound"], "the stored skip uses f: flag stays unbound");
    assert.deepEqual(cells("delete"), ["Delete prompt", "⌫"]);
    assert.ok(!rowOf("flag").classList.contains("is-conflict") && !rowOf("skip").classList.contains("is-conflict"), "no two actions on one key");
    assert.equal(settings.querySelector("select").value, "__custom");
    rowOf("flag").querySelector(".shortcuts__cap").click();
    env.press("x", { code: "KeyX" });
    assert.equal(stored.value.flag, "x");
    assert.equal(stored.value.skip, "f", "the other actions are kept");
    assert.deepEqual(cells("flag"), ["Flag for revision", "X"]);
    const sel = settings.querySelector("select");
    sel.value = "Vim";
    sel.dispatchEvent({ type: "change", bubbles: false });
    assert.deepEqual([stored.value.flag, stored.value.delete, stored.value.exit], ["f", "Backspace", "q"], "a preset binds both");
    assert.deepEqual(cells("flag"), ["Flag for revision", "F"]);
  } finally {
    if (hadSettings) env.M.settings = oldSettings; else delete env.M.settings;
  }
});
