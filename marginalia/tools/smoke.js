#!/usr/bin/env node
/* Headless boot smoke test for Marginalia.
 *
 * Builds a tiny fake window/document (no localStorage, no indexedDB → memory backend,
 * no pdfjsLib, no katex), loads the 30 scripts of SPEC §18 (+ obsidian, BUILD-NOTES "Obsidian", backup, BUILD-NOTES
 * "Automatic backup", desktop, BUILD-NOTES "Desktop app (binding)", and similar, BUILD-NOTES "Prompt craft") in order
 * as classic scripts
 * with vm.runInContext, then calls Marginalia.app.boot() and reports whether it resolves.
 *
 * Usage:  node tools/smoke.js            → human-readable report, exit 1 on failure
 *         node tools/smoke.js --keys     → JSON {namespace: [exported keys]} on stdout
 *         node tools/smoke.js --quiet    → only the verdict line
 */
"use strict";
var fs = require("fs");
var path = require("path");
var vm = require("vm");

var ROOT = path.resolve(__dirname, "..");
var ORDER = ["util", "bus", "settings", "store", "scheduler", "prompts", "similar", "context", "keys", "layout",
  "anchors", "markup", "exporter", "obsidian", "backup", "cache", "attachments", "pdfview", "reader", "editor", "margin",
  "list", "snip", "vision", "review", "stats", "library", "tabs", "desktop", "app"];
var HOST_IDS = ["app", "banner", "tabs", "library", "deck", "stats", "reader", "toolbar", "scroller", "pages", "margin", "adder",
  "find", "snipOverlay", "sheet", "list", "review", "settings", "shortcuts", "toasts", "confirm", "cover", "fileInput"];

var args = process.argv.slice(2);
var WANT_KEYS = args.indexOf("--keys") >= 0;
var QUIET = args.indexOf("--quiet") >= 0 || WANT_KEYS;

/* ---------- fake DOM ---------- */
function makeClassList(el) {
  var set = new Set();
  return {
    add: function () { for (var i = 0; i < arguments.length; i++) set.add(String(arguments[i])); el.className = Array.from(set).join(" "); },
    remove: function () { for (var i = 0; i < arguments.length; i++) set.delete(String(arguments[i])); el.className = Array.from(set).join(" "); },
    toggle: function (c, force) { var has = set.has(c); var want = force === undefined ? !has : !!force; if (want) set.add(c); else set.delete(c); el.className = Array.from(set).join(" "); return want; },
    contains: function (c) { return set.has(c); },
    _set: set
  };
}
function rect() { return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; }

function makeElement(tag, doc) {
  var el = {
    nodeType: 1, tagName: String(tag || "div").toUpperCase(), nodeName: String(tag || "div").toUpperCase(),
    id: "", className: "", style: {}, dataset: {}, attributes: {}, children: [], childNodes: [],
    parentNode: null, parentElement: null, ownerDocument: doc, hidden: false, value: "", disabled: false,
    checked: false, type: "", textContent: "", _innerHTML: "", tabIndex: -1, scrollTop: 0, scrollLeft: 0,
    scrollHeight: 0, scrollWidth: 0, clientWidth: 0, clientHeight: 0, offsetWidth: 0, offsetHeight: 0,
    offsetTop: 0, offsetLeft: 0, offsetParent: null, selectionStart: 0, selectionEnd: 0, width: 0, height: 0,
    isConnected: true, _listeners: {}
  };
  el.classList = makeClassList(el);
  // className and classList are one thing, as in a browser: writing the one shows in the other
  var className = "";
  Object.defineProperty(el, "className", {
    enumerable: true, configurable: true,
    get: function () { return className; },
    set: function (v) {
      className = v == null ? "" : String(v);
      el.classList._set.clear();
      className.split(/\s+/).filter(Boolean).forEach(function (c) { el.classList._set.add(c); });
    }
  });
  Object.defineProperty(el, "innerHTML", {
    get: function () { return el._innerHTML; },
    set: function (v) { el._innerHTML = String(v); el.children.length = 0; el.childNodes.length = 0; }
  });
  Object.defineProperty(el, "innerText", { get: function () { return el.textContent; }, set: function (v) { el.textContent = String(v); } });
  Object.defineProperty(el, "firstChild", { get: function () { return el.childNodes[0] || null; } });
  Object.defineProperty(el, "lastChild", { get: function () { return el.childNodes[el.childNodes.length - 1] || null; } });
  Object.defineProperty(el, "firstElementChild", { get: function () { return el.children[0] || null; } });
  Object.defineProperty(el, "lastElementChild", { get: function () { return el.children[el.children.length - 1] || null; } });
  Object.defineProperty(el, "nextSibling", { get: function () { var p = el.parentNode; if (!p) return null; var i = p.childNodes.indexOf(el); return p.childNodes[i + 1] || null; } });
  Object.defineProperty(el, "previousSibling", { get: function () { var p = el.parentNode; if (!p) return null; var i = p.childNodes.indexOf(el); return p.childNodes[i - 1] || null; } });
  Object.defineProperty(el, "nextElementSibling", { get: function () { var p = el.parentNode; if (!p) return null; var i = p.children.indexOf(el); return p.children[i + 1] || null; } });
  Object.defineProperty(el, "previousElementSibling", { get: function () { var p = el.parentNode; if (!p) return null; var i = p.children.indexOf(el); return p.children[i - 1] || null; } });
  function attach(child, before) {
    if (!child) return child;
    if (child.nodeType === 11) { var kids = child.childNodes.slice(); kids.forEach(function (k) { attach(k, before); }); return child; }
    if (child.parentNode) child.parentNode.removeChild(child);
    var idx = before ? el.childNodes.indexOf(before) : -1;
    if (idx < 0) el.childNodes.push(child); else el.childNodes.splice(idx, 0, child);
    if (child.nodeType === 1) { var eidx = before && before.nodeType === 1 ? el.children.indexOf(before) : -1; if (eidx < 0) el.children.push(child); else el.children.splice(eidx, 0, child); }
    child.parentNode = el; child.parentElement = el;
    return child;
  }
  el.appendChild = function (c) { return attach(c, null); };
  el.append = function () { for (var i = 0; i < arguments.length; i++) attach(typeof arguments[i] === "string" ? doc.createTextNode(arguments[i]) : arguments[i], null); };
  el.prepend = function () { for (var i = arguments.length - 1; i >= 0; i--) attach(typeof arguments[i] === "string" ? doc.createTextNode(arguments[i]) : arguments[i], el.childNodes[0] || null); };
  el.insertBefore = function (c, before) { return attach(c, before || null); };
  el.removeChild = function (c) { var i = el.childNodes.indexOf(c); if (i >= 0) el.childNodes.splice(i, 1); var j = el.children.indexOf(c); if (j >= 0) el.children.splice(j, 1); c.parentNode = null; c.parentElement = null; return c; };
  el.replaceChild = function (n, o) { attach(n, o); el.removeChild(o); return o; };
  el.replaceChildren = function () { el.childNodes.length = 0; el.children.length = 0; for (var i = 0; i < arguments.length; i++) attach(arguments[i], null); };
  el.remove = function () { if (el.parentNode) el.parentNode.removeChild(el); };
  el.insertAdjacentHTML = function () {};
  el.insertAdjacentElement = function (where, node) { if (where === "beforeend") attach(node, null); else if (where === "afterbegin") attach(node, el.childNodes[0] || null); else if (el.parentNode) el.parentNode.insertBefore(node, where === "beforebegin" ? el : el.nextSibling); return node; };
  el.cloneNode = function () { var c = makeElement(el.tagName, doc); c.id = el.id; c.className = el.className; c.textContent = el.textContent; return c; };
  el.setAttribute = function (k, v) { el.attributes[k] = String(v); if (k === "id") el.id = String(v); if (k === "class") { el.className = String(v); el.classList._set.clear(); String(v).split(/\s+/).filter(Boolean).forEach(function (c) { el.classList._set.add(c); }); } if (k.indexOf("data-") === 0) el.dataset[k.slice(5).replace(/-([a-z])/g, function (m, c) { return c.toUpperCase(); })] = String(v); };
  el.getAttribute = function (k) { return Object.prototype.hasOwnProperty.call(el.attributes, k) ? el.attributes[k] : (k === "id" && el.id ? el.id : null); };
  el.removeAttribute = function (k) { delete el.attributes[k]; };
  el.hasAttribute = function (k) { return Object.prototype.hasOwnProperty.call(el.attributes, k); };
  el.toggleAttribute = function (k, f) { var has = el.hasAttribute(k); var want = f === undefined ? !has : !!f; if (want) el.attributes[k] = ""; else delete el.attributes[k]; return want; };
  el.getBoundingClientRect = rect;
  el.getClientRects = function () { return []; };
  el.addEventListener = function (t, fn) { (el._listeners[t] = el._listeners[t] || []).push(fn); };
  el.removeEventListener = function (t, fn) { var l = el._listeners[t]; if (l) { var i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); } };
  el.dispatchEvent = function (ev) { var l = el._listeners[ev && ev.type] || []; l.slice().forEach(function (fn) { fn.call(el, ev); }); return true; };
  el.focus = function () { doc.activeElement = el; };
  el.blur = function () { if (doc.activeElement === el) doc.activeElement = doc.body; };
  el.click = function () { el.dispatchEvent({ type: "click", target: el, preventDefault: function () {}, stopPropagation: function () {} }); };
  el.select = function () {};
  el.setSelectionRange = function () {};
  el.scrollIntoView = function () {};
  el.scrollTo = function () {};
  el.scrollBy = function () {};
  el.closest = function () { return null; };
  el.contains = function (n) { if (n === el) return true; for (var i = 0; i < el.childNodes.length; i++) { if (el.childNodes[i].contains && el.childNodes[i].contains(n)) return true; } return false; };
  el.matches = function () { return false; };
  el.querySelector = function (sel) { return findIn(el, sel, false); };
  el.querySelectorAll = function (sel) { return findIn(el, sel, true); };
  el.getElementsByClassName = function (c) { return findIn(el, "." + c, true); };
  el.getElementsByTagName = function (t) { return findIn(el, t, true); };
  el.getContext = function () { return null; };
  el.toBlob = function (cb) { cb(null); };
  el.animate = function () { return { cancel: function () {}, finished: Promise.resolve() }; };
  el.getAnimations = function () { return []; };
  return el;
}
function matchSimple(el, sel) {
  if (!el || el.nodeType !== 1) return false;
  sel = sel.trim();
  if (sel === "*") return true;
  if (sel[0] === "#") return el.id === sel.slice(1);
  if (sel[0] === ".") return el.classList.contains(sel.slice(1));
  var m = /^([a-zA-Z0-9]*)((?:[.#][\w-]+)*)(?:\[[^\]]*\])*$/.exec(sel);
  if (!m) return false;
  if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
  var parts = m[2] ? m[2].match(/[.#][\w-]+/g) || [] : [];
  return parts.every(function (p) { return p[0] === "#" ? el.id === p.slice(1) : el.classList.contains(p.slice(1)); });
}
function findIn(rootEl, sel, all) {
  var out = [];
  var last = String(sel).split(",")[0].trim().split(/\s+|>/).filter(Boolean).pop() || "*";
  (function walk(n) {
    for (var i = 0; i < n.childNodes.length; i++) {
      var c = n.childNodes[i];
      if (c.nodeType === 1) { if (matchSimple(c, last)) { out.push(c); if (!all) return true; } if (walk(c) && !all) return true; }
    }
    return false;
  })(rootEl);
  return all ? out : (out[0] || null);
}

function makeDocument() {
  var doc = { nodeType: 9, readyState: "complete", hidden: false, visibilityState: "visible", _listeners: {}, title: "" };
  doc.createElement = function (tag) { return makeElement(tag, doc); };
  doc.createElementNS = function (ns, tag) { return makeElement(tag, doc); };
  doc.createTextNode = function (t) { return { nodeType: 3, nodeName: "#text", textContent: String(t), data: String(t), parentNode: null, contains: function () { return false; }, remove: function () { if (this.parentNode) this.parentNode.removeChild(this); } }; };
  doc.createDocumentFragment = function () { var f = makeElement("#fragment", doc); f.nodeType = 11; return f; };
  doc.createRange = function () { return { selectNodeContents: function () {}, getClientRects: function () { return []; }, getBoundingClientRect: rect, setStart: function () {}, setEnd: function () {}, cloneRange: function () { return this; }, collapsed: true }; };
  doc.addEventListener = function (t, fn) { (doc._listeners[t] = doc._listeners[t] || []).push(fn); };
  doc.removeEventListener = function (t, fn) { var l = doc._listeners[t]; if (l) { var i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); } };
  doc.dispatchEvent = function (ev) { (doc._listeners[ev && ev.type] || []).slice().forEach(function (fn) { fn.call(doc, ev); }); return true; };
  doc.documentElement = makeElement("html", doc);
  doc.head = makeElement("head", doc);
  doc.body = makeElement("body", doc);
  doc.documentElement.appendChild(doc.head);
  doc.documentElement.appendChild(doc.body);
  doc.activeElement = doc.body;
  doc.getElementById = function (id) { return findIn(doc.documentElement, "#" + id, false); };
  doc.querySelector = function (sel) { return findIn(doc.documentElement, sel, false); };
  doc.querySelectorAll = function (sel) { return findIn(doc.documentElement, sel, true); };
  doc.getElementsByClassName = function (c) { return findIn(doc.documentElement, "." + c, true); };
  doc.getElementsByTagName = function (t) { return t === "html" ? [doc.documentElement] : findIn(doc.documentElement, t, true); };
  doc.elementFromPoint = function () { return null; };
  doc.elementsFromPoint = function () { return []; };
  doc.getSelection = function () { return { rangeCount: 0, isCollapsed: true, toString: function () { return ""; }, removeAllRanges: function () {}, getRangeAt: function () { return null; }, addRange: function () {} }; };
  doc.hasFocus = function () { return true; };
  doc.contains = function (n) { return n === doc || doc.documentElement.contains(n); };
  doc.execCommand = function () { return false; };
  doc.fonts = { ready: Promise.resolve(), load: function () { return Promise.resolve([]); } };
  // skeleton of BUILD-NOTES
  var app = makeElement("div", doc); app.id = "app"; doc.body.appendChild(app);
  var meta = makeElement("meta", doc); meta.setAttribute("name", "marginalia-build"); meta.setAttribute("content", "local"); doc.head.appendChild(meta);
  function host(parent, tag, id, hidden, extra) { var e = makeElement(tag, doc); e.id = id; if (hidden) e.classList.add("is-hidden"); if (extra) extra(e); parent.appendChild(e); return e; }
  host(app, "div", "banner", true);
  host(app, "div", "tabs", true);
  host(app, "section", "library", false);
  host(app, "section", "deck", true);
  host(app, "section", "stats", true);
  var reader = host(app, "section", "reader", true, function (e) { e.setAttribute("tabindex", "-1"); });
  host(reader, "div", "toolbar", false);
  var scroller = host(reader, "div", "scroller", false);
  var gutter = makeElement("div", doc); gutter.classList.add("gutter"); scroller.appendChild(gutter);
  host(scroller, "div", "pages", false);
  host(scroller, "div", "margin", false);
  host(reader, "div", "adder", true);
  host(reader, "div", "find", true);
  host(reader, "div", "snipOverlay", true);
  host(reader, "div", "sheet", true);
  host(reader, "div", "list", true);
  host(app, "div", "review", true, function (e) { e.setAttribute("tabindex", "-1"); });
  host(app, "div", "settings", true);
  host(app, "div", "shortcuts", true);
  host(app, "div", "toasts", false);
  host(app, "div", "confirm", true);
  host(app, "div", "cover", true);
  host(app, "input", "fileInput", false, function (e) { e.type = "file"; e.hidden = true; });
  return doc;
}

function makeWindow() {
  var win = {};
  var doc = makeDocument();
  win.window = win; win.self = win; win.globalThis = win; win.document = doc;
  win.console = console;
  win.setTimeout = setTimeout; win.clearTimeout = clearTimeout; win.setInterval = setInterval; win.clearInterval = clearInterval;
  win.queueMicrotask = queueMicrotask;
  win.requestAnimationFrame = function (fn) { return setTimeout(function () { fn(Date.now()); }, 0); };
  win.cancelAnimationFrame = clearTimeout;
  win.requestIdleCallback = function (fn) { return setTimeout(function () { fn({ timeRemaining: function () { return 50; }, didTimeout: false }); }, 0); };
  win.cancelIdleCallback = clearTimeout;
  win.Promise = Promise; win.Map = Map; win.Set = Set; win.WeakMap = WeakMap; win.WeakSet = WeakSet; win.Symbol = Symbol;
  win.TextEncoder = TextEncoder; win.TextDecoder = TextDecoder; win.URL = URL; win.URLSearchParams = URLSearchParams;
  win.AbortController = AbortController; win.AbortSignal = AbortSignal; win.structuredClone = structuredClone;
  win.Uint8Array = Uint8Array; win.ArrayBuffer = ArrayBuffer; win.Float32Array = Float32Array; win.DataView = DataView;
  win.Blob = typeof Blob !== "undefined" ? Blob : undefined; win.performance = performance;
  win.Event = function (type, init) { this.type = type; Object.assign(this, init || {}); this.defaultPrevented = false; this.preventDefault = function () { this.defaultPrevented = true; }; this.stopPropagation = function () {}; this.stopImmediatePropagation = function () {}; };
  win.CustomEvent = win.Event; win.KeyboardEvent = win.Event; win.MouseEvent = win.Event; win.PointerEvent = win.Event; win.FocusEvent = win.Event; win.InputEvent = win.Event;
  win.Node = { ELEMENT_NODE: 1, TEXT_NODE: 3, DOCUMENT_NODE: 9, DOCUMENT_FRAGMENT_NODE: 11 };
  win.HTMLElement = function () {}; win.Element = win.HTMLElement; win.HTMLInputElement = function () {}; win.HTMLTextAreaElement = function () {};
  win.navigator = { userAgent: "Node.js smoke", platform: "", language: "en", onLine: true, storage: undefined, clipboard: undefined };
  win.location = { hash: "", search: "", hostname: "localhost", href: "http://localhost/", origin: "http://localhost", pathname: "/", protocol: "http:" };
  win.history = { state: null, pushState: function (s, t, u) { this.state = s; }, replaceState: function (s, t, u) { this.state = s; }, back: function () {}, forward: function () {} };
  win.matchMedia = function (q) { return { matches: false, media: q, addEventListener: function () {}, removeEventListener: function () {}, addListener: function () {}, removeListener: function () {} }; };
  win.ResizeObserver = function (cb) { this.observe = function () {}; this.unobserve = function () {}; this.disconnect = function () {}; };
  win.IntersectionObserver = function (cb) { this.observe = function () {}; this.unobserve = function () {}; this.disconnect = function () {}; this.takeRecords = function () { return []; }; };
  win.MutationObserver = function (cb) { this.observe = function () {}; this.disconnect = function () {}; this.takeRecords = function () { return []; }; };
  win.getComputedStyle = function () { return { getPropertyValue: function () { return ""; } }; };
  win.getSelection = doc.getSelection;
  win.innerWidth = 1280; win.innerHeight = 800; win.devicePixelRatio = 1; win.scrollX = 0; win.scrollY = 0;
  win.scrollTo = function () {}; win.scroll = function () {}; win.alert = undefined; win.confirm = undefined; win.prompt = undefined;
  win._listeners = {};
  win.addEventListener = function (t, fn) { (win._listeners[t] = win._listeners[t] || []).push(fn); };
  win.removeEventListener = function (t, fn) { var l = win._listeners[t]; if (l) { var i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); } };
  win.dispatchEvent = function (ev) { (win._listeners[ev && ev.type] || []).slice().forEach(function (fn) { fn.call(win, ev); }); return true; };
  win.isNaN = isNaN; win.parseInt = parseInt; win.parseFloat = parseFloat; win.isFinite = isFinite;
  win.encodeURIComponent = encodeURIComponent; win.decodeURIComponent = decodeURIComponent; win.encodeURI = encodeURI; win.decodeURI = decodeURI;
  win.btoa = btoa; win.atob = atob;
  // deliberately absent: localStorage, sessionStorage, indexedDB, pdfjsLib, katex, crypto, fetch, ClipboardItem, createImageBitmap, Image
  return win;
}

/* ---------- run ---------- */
function main() {
  var win = makeWindow();
  var ctx = vm.createContext(win);
  var loadErrors = [];
  var consoleErrors = [];
  var realError = console.error;
  console.error = function () { consoleErrors.push(Array.prototype.map.call(arguments, function (a) { return a && a.stack ? a.stack.split("\n")[0] : String(a); }).join(" ")); if (!QUIET) realError.apply(console, arguments); };

  ORDER.forEach(function (name) {
    var file = path.join(ROOT, "js", name + ".js");
    var code;
    try { code = fs.readFileSync(file, "utf8"); } catch (e) { loadErrors.push(name + ": cannot read (" + e.message + ")"); return; }
    try { vm.runInContext(code, ctx, { filename: "js/" + name + ".js" }); }
    catch (e) { loadErrors.push(name + ": " + (e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : String(e))); }
  });

  var M = win.Marginalia || {};
  var present = ORDER.filter(function (n) { return M[n] && typeof M[n] === "object"; });
  var missing = ORDER.filter(function (n) { return present.indexOf(n) < 0; });

  if (WANT_KEYS) {
    var keys = {};
    ORDER.forEach(function (n) {
      if (!M[n]) return;
      var out = {};
      Object.keys(M[n]).forEach(function (k) {
        var v = M[n][k];
        out[k] = typeof v === "function" ? "function" : (v && typeof v === "object" ? Object.keys(v) : typeof v);
      });
      keys[n] = out;
    });
    fs.writeSync(1, JSON.stringify({ namespaces: present, missing: missing, loadErrors: loadErrors, keys: keys }, null, 1) + "\n");
    process.exit(loadErrors.length ? 1 : 0);
    return;
  }

  var hostsOk = HOST_IDS.every(function (id) { return !!win.document.getElementById(id); });
  var ok = true;
  function finish(msg, bootErr) {
    console.error = realError;
    var lines = [];
    lines.push("Loaded " + present.length + "/" + ORDER.length + " namespaces" + (missing.length ? " — missing: " + missing.join(", ") : ""));
    if (loadErrors.length) { ok = false; lines.push("Load-time errors:"); loadErrors.forEach(function (e) { lines.push("  " + e); }); }
    lines.push("Fake DOM hosts present: " + (hostsOk ? "yes" : "NO"));
    lines.push("boot(): " + msg);
    if (bootErr) { ok = false; lines.push("  " + (bootErr && bootErr.stack ? bootErr.stack.split("\n").slice(0, 6).join("\n  ") : String(bootErr))); }
    if (consoleErrors.length) lines.push("console.error during load/boot (" + consoleErrors.length + "):\n  " + consoleErrors.slice(0, 10).join("\n  "));
    lines.push("Focus owner after boot: " + (M.app && typeof M.app.focusOwner === "function" ? M.app.focusOwner() : "n/a") + "; store mode: " + (M.store && typeof M.store.mode === "function" ? M.store.mode() : "n/a"));
    // M.app's boot starts M.backup once the store is open; in this memory-mode window it must stay off the network
    var bk = null;
    try { bk = M.backup && typeof M.backup.state === "function" ? M.backup.state() : null; } catch (e) { bk = null; }
    lines.push("Backup after boot: " + (bk ? bk.status + (bk.reason ? " (" + bk.reason + ")" : "") : "n/a"));
    lines.push(ok ? "SMOKE OK" : "SMOKE FAILED");
    if (!QUIET) console.log(lines.join("\n")); else console.log(lines[lines.length - 1]);
    process.exit(ok ? 0 : 1);
  }
  if (!M.app || typeof M.app.boot !== "function") { finish("M.app.boot is not a function", null); return; }
  var done = false;
  var timer = setTimeout(function () { if (!done) { done = true; finish("did not settle within 5 s", new Error("timeout")); } }, 5000);
  var p;
  try { p = M.app.boot(); } catch (e) { done = true; clearTimeout(timer); finish("threw synchronously", e); return; }
  Promise.resolve(p).then(function () {
    if (done) return; done = true; clearTimeout(timer);
    // let bus listeners and queued rAF callbacks run once
    setTimeout(function () { finish("resolved", null); }, 50);
  }, function (e) {
    if (done) return; done = true; clearTimeout(timer);
    finish("rejected", e || new Error("rejected"));
  });
}

main();
