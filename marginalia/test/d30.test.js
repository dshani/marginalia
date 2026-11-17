"use strict";
// test/d30.test.js — DECISIONS D30 (BUILD-NOTES "Tabs"): tabs inside the one page (js/tabs.js).
//  1. the pure helpers of M.tabs (places, the list operations, what is read from storage);
//  2. the real modules in the fake window of tools/smoke.js: the tab commands, the strip, the keys (M.keys.TABS_MAP
//     through M.app's one keydown listener), Cmd+click, links, storage and restart, and what blocks the commands.
// M.reader is a stand-in that follows js/reader.js (no PDF engine in Node): it records what it was asked, a load can
// be held back, and an open that another one replaced ends without a book. The page's history is a real stack.
// Everything else is real.
// Run: node --test test/d30.test.js
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const T = require(path.join(__dirname, "..", "js", "tabs.js"));
const P = T._pure;

// ---------------------------------------------------------------------------------------------------------- pure
describe("M.tabs pure helpers", () => {
  const tabs = (...ids) => ids.map((id) => ({ id }));
  const ids = (list) => list.map((t) => t.id);

  test("place: a route as {screen, collectionId}; the library and Statistics have no collection; a book without one is the library", () => {
    assert.deepEqual(P.place({ screen: "reader", collectionId: "b1", promptId: "p" }), { screen: "reader", collectionId: "b1" });
    assert.deepEqual(P.place({ screen: "deck", collectionId: 7 }), { screen: "deck", collectionId: "7" });
    assert.deepEqual(P.place({ screen: "library", collectionId: "b1" }), { screen: "library", collectionId: null });
    assert.deepEqual(P.place({ screen: "stats", collectionId: "b1" }), { screen: "stats", collectionId: null });
    for (const bad of [{ screen: "reader" }, { screen: "deck", collectionId: "" }, { screen: "nowhere", collectionId: "b1" }, {}, null, "x"]) {
      assert.deepEqual(P.place(bad), { screen: "library", collectionId: null });
    }
    assert.equal(P.samePlace({ screen: "reader", collectionId: "b1" }, { screen: "reader", collectionId: "b1" }), true);
    assert.equal(P.samePlace({ screen: "reader", collectionId: "b1" }, { screen: "reader", collectionId: "b2" }), false);
    assert.equal(P.samePlace({ screen: "library", collectionId: null }, { screen: "library" }), true);
    assert.equal(P.samePlace({ screen: "library" }, { screen: "stats" }), false);
    assert.equal(P.samePlace(null, { screen: "library" }), false);
  });

  test("title: Library, Statistics, the book's or deck's name, else Untitled", () => {
    assert.equal(P.title({ screen: "library" }, null), "Library");
    assert.equal(P.title({ screen: "stats" }, null), "Statistics");
    assert.equal(P.title({ screen: "reader", collectionId: "b" }, { name: "Griffiths", kind: "book" }), "Griffiths");
    assert.equal(P.title({ screen: "reader", collectionId: "b" }, { name: "", kind: "book" }), "Untitled");
    assert.equal(P.title({ screen: "deck", collectionId: "d" }, { name: "", kind: "deck" }), "Untitled deck");
    assert.equal(P.title({ screen: "deck", collectionId: "d" }, null), "Untitled deck");
    assert.equal(P.title(null, null), "Library");
  });

  test("after, without, step, nth: the list operations", () => {
    const l = tabs("a", "b", "c");
    assert.deepEqual(ids(P.after(l, "a", { id: "x" })), ["a", "x", "b", "c"]);
    assert.deepEqual(ids(P.after(l, "c", { id: "x" })), ["a", "b", "c", "x"]);
    assert.deepEqual(ids(P.after(l, "zz", { id: "x" })), ["a", "b", "c", "x"], "no active tab: at the end");
    assert.deepEqual(ids(l), ["a", "b", "c"], "the list given is not changed");
    // closing the active tab: its right neighbour becomes active, else its left one
    assert.deepEqual([ids(P.without(l, "b", "b").tabs), P.without(l, "b", "b").active], [["a", "c"], "c"]);
    assert.deepEqual([ids(P.without(l, "c", "c").tabs), P.without(l, "c", "c").active], [["a", "b"], "b"]);
    assert.deepEqual([ids(P.without(l, "a", "a").tabs), P.without(l, "a", "a").active], [["b", "c"], "b"]);
    assert.deepEqual(P.without(l, "a", "c").active, "a", "closing another tab keeps the active one");
    assert.deepEqual(ids(P.without(l, "a", "zz").tabs), ["a", "b", "c"]);
    assert.equal(P.without(tabs("a"), "a", "a").active, null);
    // round the strip in both directions
    assert.deepEqual([P.step(l, "a", 1), P.step(l, "c", 1), P.step(l, "a", -1), P.step(l, "b", -1)], ["b", "a", "c", "a"]);
    assert.equal(P.step([], "a", 1), null);
    // tab 1 to 8 by its place, 9 = the last
    const many = tabs("t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9", "t10");
    assert.deepEqual([P.nth(many, 1), P.nth(many, 8), P.nth(many, 9), P.nth(l, 9), P.nth(l, 3), P.nth(l, 4), P.nth(l, 0), P.nth([], 1)],
      ["t1", "t8", "t10", "c", "c", null, null, null]);
  });

  test("validPosition: {pageIndex, fraction, zoom} as the reader takes it, or null", () => {
    assert.deepEqual(P.validPosition({ pageIndex: 3.9, fraction: 0.25, zoom: 1.5 }), { pageIndex: 3, fraction: 0.25, zoom: 1.5 });
    assert.deepEqual(P.validPosition({ pageIndex: 0 }), { pageIndex: 0, fraction: 0, zoom: "fit" });
    assert.deepEqual(P.validPosition({ pageIndex: 2, fraction: 7, zoom: -1 }), { pageIndex: 2, fraction: 1, zoom: "fit" });
    assert.deepEqual(P.validPosition({ pageIndex: 2, fraction: -3, zoom: "fit" }), { pageIndex: 2, fraction: 0, zoom: "fit" });
    for (const bad of [null, undefined, "3", {}, { pageIndex: -1 }, { pageIndex: NaN }, { pageIndex: "2" }]) assert.equal(P.validPosition(bad), null);
  });

  test("clean: stored JSON becomes a valid list; a tab whose book is gone is dropped; the kind decides the screen", () => {
    const cols = { b1: { id: "b1", kind: "book" }, d1: { id: "d1", kind: "deck" }, gone: { id: "gone", kind: "book", deletedAt: 5 } };
    const find = (id) => cols[id] || null;
    const saved = { v: 1, active: 2, tabs: [
      { screen: "library", collectionId: null, position: null },
      { screen: "reader", collectionId: "gone" },                                       // its book was deleted
      { screen: "reader", collectionId: "b1", position: { pageIndex: 4, fraction: 0.5, zoom: 2 } },
      { screen: "reader", collectionId: "d1" },                                         // a deck stored as a book
      { screen: "deck", collectionId: "nowhere" },                                      // unknown
      { screen: "stats", collectionId: "b1", position: { pageIndex: 1 } },
      { screen: "bogus" }, null, "x", 7
    ] };
    const c = P.clean(saved, find);
    assert.deepEqual(c.tabs, [
      { screen: "library", collectionId: null, position: null, editing: null },
      { screen: "reader", collectionId: "b1", position: { pageIndex: 4, fraction: 0.5, zoom: 2 }, editing: null },
      { screen: "deck", collectionId: "d1", position: null, editing: null },
      { screen: "stats", collectionId: null, position: null, editing: null }
    ]);
    // a tab that came from another window (D31) brings its open editor; only a book tab has one, and only a real one
    const EDIT = { promptId: null, anchor: { pageIndex: 2, y: 300 }, initialText: "Q. " };
    const moved = P.clean({ tabs: [{ screen: "reader", collectionId: "b1", editing: EDIT }, { screen: "deck", collectionId: "d1", editing: EDIT },
      { screen: "library", editing: EDIT }, { screen: "reader", collectionId: "b1", editing: "x" }, { screen: "reader", collectionId: "b1", editing: { promptId: 7, anchor: null } },
      { screen: "reader", collectionId: "b1", editing: { promptId: "p_1", anchor: null } }] }, find);
    assert.deepEqual(moved.tabs.map((x) => x.editing), [EDIT, null, null, null, null, { promptId: "p_1", anchor: null }]);
    assert.equal(c.active, 1, "the active tab is still the book that was third");
    // the stored active tab itself was dropped: the nearest tab in range
    assert.equal(P.clean({ tabs: [{ screen: "library" }, { screen: "reader", collectionId: "gone" }], active: 1 }, find).active, 0);
    assert.equal(P.clean({ tabs: [{ screen: "library" }, { screen: "stats" }], active: 99 }, find).active, 1);
    assert.equal(P.clean({ tabs: [{ screen: "library" }, { screen: "stats" }], active: "1" }, find).active, 0);
    // nothing usable
    for (const bad of [null, undefined, "", 5, [], {}, { tabs: "x" }, { tabs: [] }, { tabs: [{ screen: "reader", collectionId: "gone" }] }]) {
      assert.deepEqual(P.clean(bad, find), { tabs: [], active: -1 });
    }
    // at most TABS_MAX tabs
    const many = { tabs: Array.from({ length: 50 }, () => ({ screen: "library" })), active: 40 };
    assert.equal(P.clean(many, find).tabs.length, T.TABS_MAX);
    assert.equal(P.clean(many, find).active, T.TABS_MAX - 1);
    // a find that throws drops the tab, nothing more
    assert.deepEqual(P.clean({ tabs: [{ screen: "reader", collectionId: "b1" }, { screen: "stats" }] }, () => { throw new Error("x"); }).tabs.map((t) => t.screen), ["stats"]);
  });

  test("serialize: the places in order and the active index; no ids, no prompt", () => {
    const list = [{ id: "tab4", screen: "library", collectionId: null, position: null, promptId: null },
      { id: "tab9", screen: "reader", collectionId: "b1", position: { pageIndex: 2, fraction: 0, zoom: "fit" }, promptId: "p_x", shown: {} }];
    assert.deepEqual(P.serialize(list, "tab9"), { v: 1, active: 1, tabs: [
      { screen: "library", collectionId: null, position: null },
      { screen: "reader", collectionId: "b1", position: { pageIndex: 2, fraction: 0, zoom: "fit" } }] });
    assert.equal(P.serialize(list, "zz").active, 0);
    assert.deepEqual(P.clean(JSON.parse(JSON.stringify(P.serialize(list, "tab9"))), () => ({ kind: "book" })).tabs.length, 2, "it reads back");
  });

  test("the tab keys take no key of the reader, the editor or a review preset (M.keys)", () => {
    const K = require(path.join(__dirname, "..", "js", "keys.js"));
    const flat = (b) => (Array.isArray(b) ? b : [b]).filter(Boolean).map((x) => K.canonical(x));
    const used = new Set();
    for (const map of [K.READER_MAP, K.EDITOR_MAP]) for (const id of Object.keys(map)) flat(map[id].binding).forEach((b) => used.add(b));
    for (const name of Object.keys(K.PRESETS)) for (const id of Object.keys(K.PRESETS[name])) flat(K.PRESETS[name][id]).forEach((b) => used.add(b));
    const mine = [];
    for (const id of Object.keys(K.TABS_MAP)) {
      assert.equal(K.TABS_MAP[id].inField, true, id + " works while a text field has the focus");
      flat(K.TABS_MAP[id].binding).forEach((b) => { assert.equal(used.has(b), false, id + " " + b + " is taken"); mine.push(b); });
    }
    assert.equal(new Set(mine).size, mine.length, "no key twice among the tab commands");
    assert.deepEqual(Object.keys(K.TABS_MAP), T.COMMANDS, "one key entry per command");
    assert.equal(K.conflicts(K.TABS_MAP).length, 0);
  });
});

// ------------------------------------------------------------------------------------- the real modules, one page
function loadSmokeHarness() {
  const file = path.join(__dirname, "..", "tools", "smoke.js");
  const src = fs.readFileSync(file, "utf8").replace(/^#!.*\n/, "");
  assert.match(src, /\nmain\(\);\s*$/, "tools/smoke.js no longer ends with main(); update loadSmokeHarness()");
  const body = src.replace(/\nmain\(\);\s*$/, "\nreturn { makeWindow: makeWindow, ORDER: ORDER };\n");
  const factory = vm.runInThisContext("(function (require, process, __dirname, __filename) {" + body + "\n})", { filename: file });
  return factory(require, process, path.dirname(file), file);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const unref = (t) => { if (t && typeof t.unref === "function") t.unref(); return t; };
const plain = (v) => JSON.parse(JSON.stringify(v));        // a value made inside the page (another realm) as plain data
const hasClass = (el, c) => (" " + (el.className || "") + " ").indexOf(" " + c + " ") >= 0;   // the fake DOM keeps className and classList apart
const BOOK = (id, name) => ({ id, kind: "book", name, sections: [], hasBytes: true, pageCount: 9, addedAt: 1, lastOpenedAt: 1, updatedAt: 1, deletedAt: null, v: 1 });
const DECK = (id, name) => ({ id, kind: "deck", name, sections: [], addedAt: 1, lastOpenedAt: 1, updatedAt: 1, deletedAt: null, v: 1 });

// The history of a page, as a browser keeps it: a stack of entries {state, hash}. pushState and replaceState change
// the address without an event; back() and forward() go to an entry, with its state, and fire hashchange; visit(hash)
// is a new address (a link from outside, an address the user typed): a new entry without a state, and hashchange.
function makeHistory(W) {
  const h = { entries: [{ state: null, hash: W.location.hash || "" }], at: 0 };
  const hashOf = (url) => { const s = String(url == null ? "" : url), i = s.indexOf("#"); return i < 0 ? "" : s.slice(i); };
  const arrive = () => { W.location.hash = h.entries[h.at].hash; W.dispatchEvent({ type: "hashchange" }); };
  const api = {
    get state() { return h.entries[h.at].state; },
    set state(v) { h.entries[h.at].state = v; },           // a test may set it (an entry of another program's making)
    get length() { return h.entries.length; },
    pushState(state, title, url) { h.entries.length = h.at + 1; h.entries.push({ state: state, hash: hashOf(url) }); h.at++; W.location.hash = hashOf(url); },
    replaceState(state, title, url) { h.entries[h.at] = { state: state, hash: hashOf(url) }; W.location.hash = hashOf(url); },
    back() { if (h.at > 0) { h.at--; arrive(); } },
    forward() { if (h.at < h.entries.length - 1) { h.at++; arrive(); } }
  };
  return { api, stack: h, visit(hash) { h.entries.length = h.at + 1; h.entries.push({ state: null, hash }); h.at++; arrive(); } };
}

// A page: the fake window, the real modules, a localStorage (the smoke window has none), a reader stand-in.
// opts: {hash, stored (the tabs JSON of "last time"), collections (in the library before boot), app (the Mac app),
// noHistory (a page without the history API), setup(W) (test/d31.test.js: the window gets what the pages of one origin
// share, before the modules load), beforeBoot(R, W) (the modules are loaded, the app has not started)}
async function page(opts) {
  opts = opts || {};
  const H = loadSmokeHarness(), W = H.makeWindow(), logs = [], mem = new Map();
  W.setTimeout = (fn, ms, ...a) => unref(setTimeout(fn, ms, ...a));
  W.setInterval = (fn, ms, ...a) => unref(setInterval(fn, ms, ...a));
  W.requestAnimationFrame = (fn) => W.setTimeout(() => fn(Date.now()), 0);
  W.requestIdleCallback = (fn) => W.setTimeout(() => fn({ timeRemaining: () => 50, didTimeout: false }), 0);
  W.console = { log() {}, info() {}, debug() {}, warn: (...a) => logs.push(a.join(" ")), error: (...a) => logs.push(a.join(" ")) };
  W.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, String(v)); }, removeItem: (k) => { mem.delete(k); } };
  if (opts.stored !== undefined) mem.set(T.STORE_KEY, typeof opts.stored === "string" ? opts.stored : JSON.stringify(opts.stored));
  if (typeof opts.setup === "function") opts.setup(W);
  W.location.hash = opts.hash || "";
  const hist = makeHistory(W);
  if (opts.noHistory) delete W.history; else W.history = hist.api;
  const ctx = vm.createContext(W);
  for (const name of H.ORDER) vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "js", name + ".js"), "utf8"), ctx, { filename: "js/" + name + ".js" });
  const R = W.Marginalia, doc = W.document, opens = [], toasts = [];
  R.keys.setPlatform("mac");
  // The reader stand-in, as js/reader.js behaves: `opens` records every call. A call for the book that is open only
  // goes to the place asked; for the book that still loads, the place waits (navOpts); another book replaces the one
  // there. A load ends at once, or with reader.hold = true when the test calls reader.release(); a load that another
  // open replaced ends without a book. doc:opened and doc:closed go out on the bus. reader.pos is the place on
  // screen, which a test can move.
  const reader = { pos: null, hold: false, id: null, loaded: false, seq: 0, nav: null, waiting: [] };
  const loaded = (seq, cid, first) => {
    if (seq !== reader.seq) return;                         // replaced meanwhile: this open ends without a book
    const o = reader.nav || first;
    reader.nav = null;
    reader.loaded = true;
    reader.pos = o && o.position ? o.position : { pageIndex: 0, fraction: 0, zoom: "fit" };
    R.bus.emit("doc:opened", { collectionId: cid });
  };
  R.reader.close = () => {
    if (reader.id === null) return Promise.resolve();
    const was = reader.id;
    reader.seq++; reader.id = null; reader.loaded = false; reader.pos = null; reader.nav = null;
    R.bus.emit("doc:closed", { collectionId: was });
    return Promise.resolve();
  };
  R.reader.open = (cid, o) => {
    const asked = JSON.parse(JSON.stringify(o || {}));
    opens.push([cid, asked]);
    if (reader.id === cid) {
      if (!reader.loaded) { reader.nav = asked; return Promise.resolve(); }
      if (asked.position) reader.pos = asked.position;
      return Promise.resolve();
    }
    R.reader.close();
    const seq = ++reader.seq;
    reader.id = cid;
    if (!reader.hold) return Promise.resolve().then(() => loaded(seq, cid, asked));
    return new Promise((resolve) => { reader.waiting.push(() => { loaded(seq, cid, asked); resolve(); }); });
  };
  reader.release = () => { const next = reader.waiting.shift(); if (next) next(); return !!next; };
  R.reader.position = () => (reader.loaded ? reader.pos : null);
  R.reader.isOpen = (id) => reader.loaded && (id == null || reader.id === id);
  if (opts.app) R.desktop.isApp = () => true;
  const before = new Map((opts.collections || []).map((c) => [c.id, c]));
  const realCollection = R.cache.collection;
  R.cache.collection = (id) => (before.has(id) ? before.get(id) : realCollection(id));   // "in this library already"
  const realToast = R.app.toast;
  R.app.toast = (o) => { toasts.push(o && o.text); return realToast(o); };
  if (typeof opts.beforeBoot === "function") opts.beforeBoot(R, W);
  assert.equal(await R.app.boot(), true, "boot\n" + logs.join("\n"));
  await wait(5);
  const host = () => doc.getElementById("tabs");
  const elements = (rootEl, pred) => { const out = []; (function walk(n) { (n.childNodes || []).forEach((c) => { if (c.nodeType === 1) { if (pred(c)) out.push(c); walk(c); } }); })(rootEl); return out; };
  return {
    W, R, doc, opens, toasts, logs, mem, reader, host, elements, hist,
    names: () => R.tabs.list().map((t) => t.title + (t.active ? "*" : "")).join(" | "),
    stored: () => (mem.has(T.STORE_KEY) ? JSON.parse(mem.get(T.STORE_KEY)) : null),
    hidden: () => host().classList.contains("is-hidden"),
    picks: () => host().querySelectorAll(".tabs__select"),
    // a keydown on the element that has the focus, bubbling to the document as in a browser
    key(key, mods) {
      const target = doc.activeElement || doc.body;
      const e = Object.assign({ type: "keydown", key, code: "", keyCode: 0, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false,
        repeat: false, isComposing: false, defaultPrevented: false, target, stopped: false }, mods || {});
      e.preventDefault = () => { e.defaultPrevented = true; };
      e.stopPropagation = () => { e.stopped = true; };
      e.stopImmediatePropagation = e.stopPropagation;
      for (let n = target; n && !e.stopped; n = n.parentNode) if (typeof n.dispatchEvent === "function") n.dispatchEvent(e);
      if (!e.stopped) doc.dispatchEvent(e);
      return e.defaultPrevented;
    },
    click(el, mods) {
      const e = Object.assign({ type: "click", target: el, button: 0, metaKey: false, ctrlKey: false, shiftKey: false, defaultPrevented: false }, mods || {});
      e.preventDefault = () => { e.defaultPrevented = true; };
      e.stopPropagation = () => {};
      el.dispatchEvent(e);
      return e;
    },
    async add(...cols) { for (const c of cols) await R.cache.saveCollection(Object.assign({}, c)); await wait(5); }
  };
}
const CMD = { metaKey: true }, CTRL = { ctrlKey: true };

describe("M.tabs in the page (real modules, fake DOM of tools/smoke.js)", () => {
  test("a first start: one tab, the library; the strip is hidden; a new tab shows it", async () => {
    const p = await page();
    assert.equal(p.R.tabs.started(), true);
    assert.equal(p.names(), "Library*");
    assert.equal(p.hidden(), true, "with one tab the app looks as before");
    assert.equal(p.host().childNodes.length, 0);
    assert.equal(p.R.tabs.run("newTab"), true);
    assert.equal(p.names(), "Library | Library*");
    assert.equal(p.hidden(), false);
    // the strip: a tablist of tabs, each a tab button with its title as text and a close button, then "+"
    const list = p.host().querySelector(".tabs__list");
    assert.equal(list.getAttribute("role"), "tablist");
    const picks = p.picks();
    assert.deepEqual(picks.map((b) => [b.getAttribute("role"), b.getAttribute("aria-selected"), b.textContent, b.getAttribute("tabindex")]),
      [["tab", "false", "Library", "-1"], ["tab", "true", "Library", "0"]]);
    assert.deepEqual(p.host().querySelectorAll(".tabs__close").map((b) => [b.getAttribute("aria-label"), b.textContent]), [["Close tab Library", "×"], ["Close tab Library", "×"]]);
    assert.deepEqual(p.host().querySelectorAll(".tabs__tab").map((el) => el.classList.contains("is-active")), [false, true]);
    assert.equal(p.host().querySelector(".tabs__new").getAttribute("aria-label"), "New tab");
    // closing a tab; the last tab cannot be closed by the page
    assert.equal(p.R.tabs.run("closeTab"), true);
    assert.equal(p.names(), "Library*");
    assert.equal(p.hidden(), true);
    assert.equal(p.R.tabs.run("closeTab"), false, "one tab left: not the page's to close");
    assert.equal(p.R.tabs.close(p.R.tabs.active()), false);
    assert.deepEqual(p.logs, []);
  });

  test("the active tab follows every navigation; names follow renames; a deleted book's tabs become library tabs", async () => {
    const p = await page();
    await p.add(BOOK("b1", "Griffiths"), DECK("d1", "Thermo"), BOOK("b2", "Arnold"));
    await p.R.app.route("reader", { collectionId: "b1" });
    assert.equal(p.names(), "Griffiths*", "the one tab went to the book");
    await p.R.app.route("library");
    assert.equal(p.names(), "Library*");
    p.R.tabs.open({ screen: "reader", collectionId: "b1" }, { background: true });
    p.R.tabs.open({ screen: "reader", collectionId: "d1" }, { background: true });     // a deck asked as a book is a deck tab
    assert.equal(p.names(), "Library* | Thermo | Griffiths", "each new tab opens right after the active one");
    assert.deepEqual(plain(p.R.tabs.list().map((t) => t.screen)), ["library", "deck", "reader"]);
    await p.R.app.route("stats");
    assert.equal(p.names(), "Statistics* | Thermo | Griffiths");
    // a rename
    const b1 = Object.assign({}, p.R.cache.collection("b1"), { name: "Griffiths QM" });
    await p.R.cache.saveCollection(b1);
    await wait(5);
    assert.equal(p.names(), "Statistics* | Thermo | Griffiths QM");
    assert.deepEqual(p.picks().map((b) => b.textContent), ["Statistics", "Thermo", "Griffiths QM"]);
    // deleting the deck: its background tab becomes a library tab; the stored list follows
    await p.R.cache.removeCollection("d1");
    await wait(5);
    assert.equal(p.names(), "Statistics* | Library | Griffiths QM");
    // deleting the book that is on screen: M.app goes home, and the tab with it
    p.R.tabs.select(p.R.tabs.list()[2].id);
    await wait(5);
    assert.equal(p.R.app.current().screen, "reader");
    await p.R.cache.removeCollection("b1");
    await wait(5);
    assert.equal(p.names(), "Statistics | Library | Library*");
    assert.equal(p.R.app.current().screen, "library");
    p.R.tabs.save();
    assert.deepEqual(p.stored().tabs.map((t) => t.screen), ["stats", "library", "library"]);
  });

  test("a book tab keeps its own place: two tabs on one book, and a tab that comes back after the library", async () => {
    const p = await page();
    await p.add(BOOK("b1", "Griffiths"));
    await p.R.app.route("reader", { collectionId: "b1" });
    const first = p.R.tabs.active();
    p.reader.pos = { pageIndex: 3, fraction: 0.2, zoom: 1.5 };                       // the reader was scrolled to page 4
    const second = p.R.tabs.open({ screen: "reader", collectionId: "b1" }, {});      // a second tab on the same book
    await wait(5);
    assert.equal(p.names(), "Griffiths | Griffiths*");
    assert.deepEqual(p.opens[p.opens.length - 1], ["b1", {}], "a new tab has no place of its own yet");
    p.reader.pos = { pageIndex: 6, fraction: 0.5, zoom: "fit" };
    p.R.tabs.select(first);
    await wait(5);
    assert.deepEqual(p.opens[p.opens.length - 1], ["b1", { position: { pageIndex: 3, fraction: 0.2, zoom: 1.5 } }], "the first tab is shown at its own place");
    p.R.tabs.select(second);
    await wait(5);
    assert.deepEqual(p.opens[p.opens.length - 1], ["b1", { position: { pageIndex: 6, fraction: 0.5, zoom: "fit" } }]);
    // the stored list holds the place of every tab: for the tab on screen, the place the reader shows now (D31)
    p.R.tabs.save();
    assert.deepEqual(p.stored(), { v: 1, active: 1, tabs: [
      { screen: "reader", collectionId: "b1", position: { pageIndex: 3, fraction: 0.2, zoom: 1.5 } },
      { screen: "reader", collectionId: "b1", position: { pageIndex: 6, fraction: 0.5, zoom: "fit" } }] });
    // a place is used once: going on inside the tab (‹ Library, then the book again) starts from the book's last position
    await p.R.app.route("library");
    await p.R.app.route("reader", { collectionId: "b1" });
    assert.deepEqual(p.opens[p.opens.length - 1], ["b1", {}]);
    // a tab left while its book was still loading (the reader has no place yet) keeps the place it was shown with
    p.R.tabs.select(first);
    await wait(5);
    p.reader.pos = null;
    p.R.tabs.select(second);
    await wait(5);
    p.R.tabs.select(first);
    await wait(5);
    assert.deepEqual(p.opens[p.opens.length - 1], ["b1", { position: { pageIndex: 3, fraction: 0.2, zoom: 1.5 } }]);
  });

  test("a book tab that is left with a prompt editor open gets the editor back when it is shown again", async () => {
    const p = await page();
    await p.add(BOOK("b1", "Griffiths"), BOOK("b2", "Arnold"));
    // the margin's editor as js/margin.js reports it and opens it; the reader closes it with its book
    const ed = { open: null, calls: [] };
    p.R.margin.editing = () => ed.open;
    p.R.margin.activeEditor = () => (ed.open ? {} : null);
    p.R.margin.openEditor = (o) => { ed.calls.push(plain(o)); ed.open = o; return {}; };
    const closeBook = p.R.reader.close;
    p.R.reader.close = () => { ed.open = null; return closeBook(); };
    const back = async (id) => { ed.calls.length = 0; p.R.tabs.select(id); await wait(5); return ed.calls.slice(); };
    await p.R.app.route("reader", { collectionId: "b1" });
    const book = p.R.tabs.active();
    const NEW = { promptId: null, anchor: { pageIndex: 2, y: 300, quote: "a passage" }, initialText: "Q. " };
    ed.open = NEW;                                        // N on a passage; the user types
    p.R.tabs.run("newTab");                               // Cmd+T: the library. The book closes, and the editor with it
    await wait(5);
    const lib = p.R.tabs.active();
    assert.equal(ed.open, null);
    assert.deepEqual(ed.calls, [], "nothing opens on the library");
    assert.deepEqual(await back(book), [NEW], "back on the book: the editor opens again with the same options");
    assert.equal(p.opens[p.opens.length - 1][0], "b1", "after the book opened");
    // it is used once: an editor the user closed meanwhile does not come back
    ed.open = null;
    await back(lib);
    assert.deepEqual(await back(book), []);
    // E on a card, then another book in another tab
    const EDIT = { promptId: "p_4", anchor: null };
    ed.open = EDIT;
    const other = p.R.tabs.open({ screen: "reader", collectionId: "b2" }, {});
    await wait(5);
    assert.equal(ed.open, null, "the other book took the reader");
    assert.deepEqual(ed.calls, []);
    assert.deepEqual(await back(book), [EDIT]);
    // a second tab on the SAME book: the reader keeps the book open and the editor stays on screen; nothing is opened
    // twice, and the tab that left has no editor to bring back
    ed.calls.length = 0;
    const twin = p.R.tabs.open({ screen: "reader", collectionId: "b1" }, {});
    await wait(5);
    assert.equal(ed.open, EDIT, "the editor is still open");
    assert.deepEqual(ed.calls, []);
    assert.deepEqual(await back(book), [], "back on the first tab: the editor is on screen already");
    assert.equal(ed.open, EDIT);
    await back(twin);
    ed.open = null;                                       // the user saves the prompt there
    assert.deepEqual(await back(lib), []);
    assert.deepEqual(await back(book), [], "no second editor for a prompt that was saved meanwhile");
    assert.deepEqual(await back(twin), []);
    // a closed tab keeps its editor for Cmd+Shift+T
    ed.open = NEW;
    assert.equal(p.R.tabs.run("closeTab"), true);         // the twin, with its editor open; the next tab is the other book
    await wait(5);
    assert.equal(p.R.app.current().collectionId, "b2");
    assert.equal(ed.open, null);
    ed.calls.length = 0;
    assert.equal(p.R.tabs.run("reopenTab"), true);
    await wait(5);
    assert.deepEqual(ed.calls, [NEW], "the reopened tab has its editor again");
    // a link to one prompt of the book shows that prompt, not the editor the tab had
    const linked = p.R.tabs.active();
    await back(lib);
    assert.equal(ed.open, null);
    assert.equal(p.R.tabs.close(book), true);             // one tab shows the book now: the one with the editor to bring back
    ed.calls.length = 0;
    assert.equal(p.R.tabs.link({ screen: "reader", collectionId: "b1", promptId: "p_9" }), true);
    await wait(5);
    assert.equal(p.R.tabs.active(), linked, "the tab that showed the book took the link");
    assert.equal(p.opens[p.opens.length - 1][1].promptId, "p_9");
    assert.deepEqual(ed.calls, [], "the prompt is shown, and no editor comes over it");
    await back(lib);
    assert.deepEqual(await back(linked), [], "… and not later either");
    // a review that starts while the book opens: nothing opens under it; the editor comes when the review ends
    ed.open = EDIT;
    const withEditor = p.R.tabs.active();
    await back(lib);
    const realActive = p.R.review.isActive;
    ed.calls.length = 0;
    p.reader.hold = true;
    assert.equal(p.R.tabs.select(withEditor), true);
    p.R.review.isActive = () => true;                     // R is pressed before the book is open
    p.reader.release();
    await wait(5);
    assert.deepEqual(ed.calls, [], "not under the review");
    p.R.review.isActive = realActive;
    p.R.bus.emit("review:ended", { summary: {} });
    assert.deepEqual(ed.calls, [EDIT], "when the review ends");
    p.reader.hold = false;
    assert.deepEqual(p.logs, []);
  });

  test("a tab's editor waits for its book: it opens when the book is open, not before, and a tab left too early keeps it", async () => {
    const p = await page();
    await p.add(BOOK("b1", "Griffiths"), BOOK("b2", "Arnold"));
    const ed = { open: null, calls: [] };
    p.R.margin.editing = () => ed.open;
    p.R.margin.activeEditor = () => (ed.open ? {} : null);
    p.R.margin.openEditor = (o) => { ed.calls.push(plain(o)); if (!p.reader.loaded) return null; ed.open = o; return {}; };   // the real margin opens nothing before its book
    const closeBook = p.R.reader.close;
    p.R.reader.close = () => { ed.open = null; return closeBook(); };
    await p.R.app.route("reader", { collectionId: "b1" });
    const book = p.R.tabs.active();
    const EDIT = { promptId: "p_1", anchor: null };
    ed.open = EDIT;
    p.R.tabs.run("newTab");
    await wait(5);
    const lib = p.R.tabs.active();
    // a large book: the load takes time
    p.reader.hold = true;
    p.R.tabs.select(book);                                // load 1 starts
    await wait(5);
    assert.deepEqual(ed.calls, [], "the book is not open yet");
    p.R.tabs.select(lib);                                 // the user goes away before it is open
    await wait(5);
    p.reader.release();                                   // load 1 ends without a book (the library replaced it)
    await wait(5);
    assert.deepEqual(ed.calls, [], "nothing opens on the library, and the tab keeps its editor");
    p.R.tabs.select(book);                                // load 2
    await wait(5);
    p.R.tabs.select(lib);
    await wait(5);
    p.R.tabs.select(book);                                // load 3, while load 2 is still on its way
    await wait(5);
    p.reader.release();                                   // load 2 ends without a book
    await wait(5);
    assert.deepEqual(ed.calls, [], "the route's promise came, the book did not: no editor yet");
    p.reader.release();                                   // load 3: the book is open
    await wait(5);
    assert.deepEqual(ed.calls, [EDIT], "now, and once");
    assert.equal(ed.open, EDIT);
    // The book is loading for ANOTHER tab of it when the tab with the editor is shown: this route is done at once
    // (the reader only takes the place), long before the book is open. The editor comes when the book is open.
    p.reader.hold = false;
    const twin = p.R.tabs.open({ screen: "reader", collectionId: "b1" }, { background: true });
    ed.open = EDIT;
    p.R.tabs.select(lib);                                 // the tab `book` has its editor to bring back
    await wait(5);
    ed.calls.length = 0;
    p.reader.hold = true;
    p.R.tabs.select(twin);                                // the book loads for the twin …
    await wait(5);
    p.R.tabs.select(book);                                // … and the user goes on to the tab with the editor
    await wait(5);
    assert.deepEqual(ed.calls, [], "the route is done, the book is not open");
    p.reader.release();
    await wait(5);
    assert.deepEqual(ed.calls, [EDIT], "when the book is open");
    assert.equal(p.R.tabs.close(twin), true);
    await wait(5);
    // The same, but the load was started by the page itself (a click on "Continue reading" in a library tab), not by
    // a tab change: no route of M.tabs ends when the book opens. The editor comes on doc:opened.
    p.reader.hold = false;
    p.reader.pos = { pageIndex: 7, fraction: 0, zoom: "fit" };   // the tab has a place of its own
    ed.open = EDIT;
    p.R.tabs.select(lib);
    await wait(5);
    ed.calls.length = 0;
    p.reader.hold = true;
    p.R.app.route("reader", { collectionId: "b1" });      // the library tab goes to the book: the load starts
    await wait(5);
    p.R.tabs.select(book);                                // Ctrl+Tab to the tab with the editor, before the book is open
    await wait(5);
    assert.deepEqual(ed.calls, []);
    p.reader.release();
    await wait(5);
    assert.deepEqual(ed.calls, [EDIT], "on doc:opened");
    assert.deepEqual(p.reader.pos, { pageIndex: 7, fraction: 0, zoom: "fit" }, "at the tab's own place");
    // (back to: the book tab on screen with its book open, and a library tab)
    p.reader.hold = false;
    ed.open = null;
    p.R.tabs.select(lib);
    await wait(5);
    await p.R.app.route("library");
    p.R.tabs.select(book);
    await wait(5);
    assert.equal(p.names(), "Griffiths* | Library");
    assert.equal(p.R.reader.isOpen("b1"), true);
    // a tab whose book cannot be opened (its file is gone) lands on the library; its editor is dropped with the place
    p.reader.hold = false;
    ed.open = EDIT;
    p.R.tabs.select(lib);
    await wait(5);
    ed.calls.length = 0;
    const realOpen = p.R.reader.open;
    p.R.reader.open = (cid) => { p.opens.push([cid, {}]); const e = new Error("No PDF bytes stored"); e.code = "no_bytes"; return Promise.reject(e); };
    p.R.tabs.select(book);
    await wait(10);
    assert.equal(p.R.app.current().screen, "library", "M.app goes home");
    assert.equal(p.names(), "Library* | Library");
    p.R.reader.open = realOpen;
    await p.R.app.route("reader", { collectionId: "b1" });
    await wait(5);
    assert.deepEqual(ed.calls, [], "the editor of the place the tab left does not follow it");
    assert.ok(p.logs.every((l) => /reader\.open/.test(l)), p.logs.join("\n"));
  });

  test("two tabs on one book while the book still loads: each tab keeps its own place, also its prompt", async () => {
    const p = await page();
    await p.add(BOOK("b1", "Griffiths"));
    await p.R.app.route("reader", { collectionId: "b1" });
    const a = p.R.tabs.active();
    p.reader.pos = { pageIndex: 5, fraction: 0, zoom: 1.5 };
    const b = p.R.tabs.open({ screen: "reader", collectionId: "b1" }, {});
    await wait(5);
    p.reader.pos = { pageIndex: 50, fraction: 0.5, zoom: "fit" };
    const lib = p.R.tabs.open({ screen: "library" }, {});  // both book tabs are in the background now
    await wait(5);
    assert.equal(p.names(), "Griffiths | Griffiths | Library*");
    p.reader.hold = true;
    p.R.tabs.select(a);                                   // the book starts to load for tab a (page 6) …
    await wait(5);
    p.R.tabs.select(b);                                   // … and the user goes on to tab b before it is open
    await wait(5);
    assert.deepEqual(p.opens.slice(-2), [["b1", { position: { pageIndex: 5, fraction: 0, zoom: 1.5 } }], ["b1", { position: { pageIndex: 50, fraction: 0.5, zoom: "fit" } }]],
      "the reader got tab b's place while it loads");
    p.reader.release();
    await wait(5);
    assert.deepEqual(p.reader.pos, { pageIndex: 50, fraction: 0.5, zoom: "fit" }, "the book opens at tab b's place");
    // each tab still has its own place afterwards
    p.reader.hold = false;
    p.R.tabs.select(lib);
    await wait(5);
    p.R.tabs.select(a);
    await wait(5);
    assert.deepEqual(p.opens[p.opens.length - 1], ["b1", { position: { pageIndex: 5, fraction: 0, zoom: 1.5 } }]);
    p.R.tabs.select(lib);
    await wait(5);
    p.R.tabs.select(b);
    await wait(5);
    assert.deepEqual(p.opens[p.opens.length - 1], ["b1", { position: { pageIndex: 50, fraction: 0.5, zoom: "fit" } }]);
    // a tab opened on one prompt, shown while the book loads for another tab: the prompt is not lost
    p.R.tabs.select(lib);
    await wait(5);
    const onPrompt = p.R.tabs.open({ screen: "reader", collectionId: "b1", promptId: "p_7" }, { background: true });
    p.reader.hold = true;
    p.R.tabs.select(a);
    await wait(5);
    p.R.tabs.select(onPrompt);
    await wait(5);
    assert.deepEqual(p.opens[p.opens.length - 1], ["b1", { promptId: "p_7" }]);
    p.reader.release();
    p.reader.hold = false;
    await wait(5);
    assert.deepEqual(p.logs, []);
  });

  test("closing a tab whose editor stays on screen (the next tab shows the same book): Cmd+Shift+T brings no second editor", async () => {
    const p = await page();
    await p.add(BOOK("b1", "Griffiths"), BOOK("b2", "Arnold"));
    const ed = { open: null, calls: [] };
    p.R.margin.editing = () => ed.open;
    p.R.margin.activeEditor = () => (ed.open ? {} : null);
    p.R.margin.openEditor = (o) => { ed.calls.push(plain(o)); ed.open = o; return {}; };
    const closeBook = p.R.reader.close;
    p.R.reader.close = () => { ed.open = null; return closeBook(); };
    await p.R.app.route("reader", { collectionId: "b1" });
    const first = p.R.tabs.active();
    p.R.tabs.open({ screen: "reader", collectionId: "b1" }, { background: true });
    const NEW = { promptId: null, anchor: { pageIndex: 2, y: 300 }, initialText: "Q. " };
    ed.open = NEW;                                        // a new prompt is being written in the first tab
    assert.equal(p.R.tabs.close(first), true);            // the second tab shows the same book: the editor stays
    await wait(5);
    assert.equal(ed.open, NEW);
    ed.open = null;                                       // the user saves the prompt there
    assert.equal(p.R.tabs.run("reopenTab"), true);
    await wait(5);
    assert.deepEqual(ed.calls, [], "no second editor on a passage whose prompt is saved");
    // … but a closed tab whose book left the screen does bring its editor back
    ed.open = NEW;
    const withEditor = p.R.tabs.active();
    p.R.tabs.open({ screen: "reader", collectionId: "b2" }, { background: true });
    const order = p.R.tabs.list().map((x) => x.id);
    assert.equal(order[order.indexOf(withEditor) + 1] !== undefined, true);
    // make the other book the right neighbour, then close the tab with the editor
    assert.equal(p.R.tabs.list()[order.indexOf(withEditor) + 1].collectionId, "b2");
    assert.equal(p.R.tabs.close(withEditor), true);
    await wait(5);
    assert.equal(p.R.app.current().collectionId, "b2");
    assert.equal(ed.open, null);
    assert.equal(p.R.tabs.run("reopenTab"), true);
    await wait(5);
    assert.deepEqual(ed.calls, [NEW]);
  });

  test("close and reopen: the neighbour becomes active; Cmd+Shift+T brings tabs back, last closed first, at their place", async () => {
    const p = await page();
    await p.add(BOOK("b1", "Griffiths"), BOOK("b2", "Arnold"));
    const lib = p.R.tabs.active();
    const g = p.R.tabs.open({ screen: "reader", collectionId: "b1" }, {});
    await wait(5);
    p.reader.pos = { pageIndex: 4, fraction: 0, zoom: "fit" };
    const a = p.R.tabs.open({ screen: "reader", collectionId: "b2" }, { background: true });
    assert.equal(p.names(), "Library | Griffiths* | Arnold");
    assert.equal(p.R.tabs.close(g), true);
    await wait(5);
    assert.equal(p.names(), "Library | Arnold*", "the right neighbour");
    assert.equal(p.R.app.current().collectionId, "b2");
    assert.equal(p.R.tabs.close(a), true);
    await wait(5);
    assert.equal(p.names(), "Library*", "no right neighbour: the left one");
    assert.equal(p.R.app.current().screen, "library");
    assert.equal(p.R.tabs.run("reopenTab"), true);
    await wait(5);
    assert.equal(p.names(), "Library | Arnold*");
    assert.equal(p.R.tabs.run("reopenTab"), true);
    await wait(5);
    assert.equal(p.names(), "Library | Arnold | Griffiths*");
    assert.deepEqual(p.opens[p.opens.length - 1], ["b1", { position: { pageIndex: 4, fraction: 0, zoom: "fit" } }], "where it was");
    assert.equal(p.R.tabs.run("reopenTab"), false, "nothing more to bring back");
    // a closed tab whose book was deleted meanwhile does not come back
    p.R.tabs.close(p.R.tabs.active());
    await p.R.cache.removeCollection("b1");
    await wait(5);
    assert.equal(p.R.tabs.run("reopenTab"), false);
    assert.equal(p.R.tabs.select(lib), true);
    assert.equal(p.R.tabs.select(lib), false, "it is on screen already");
    assert.equal(p.R.tabs.select("nope"), false);
  });

  test("the keys (M.keys.TABS_MAP through M.app's keydown listener)", async () => {
    const p = await page();
    await p.add(BOOK("b1", "Griffiths"), DECK("d1", "Thermo"));
    assert.equal(p.key("w", CMD), false, "Cmd+W with one tab is not the page's key");
    assert.equal(p.key("t", CMD), true);
    assert.equal(p.names(), "Library | Library*");
    assert.equal(p.key("t", Object.assign({ repeat: true }, CMD)), true, "a held key is swallowed …");
    assert.equal(p.names(), "Library | Library*", "… and acts once");
    await p.R.app.route("reader", { collectionId: "b1" });
    p.R.tabs.open({ screen: "deck", collectionId: "d1" }, { background: true });
    assert.equal(p.names(), "Library | Griffiths* | Thermo");
    const go = async (key, mods, want) => { assert.equal(p.key(key, mods), true, key); await wait(5); assert.equal(p.names(), want, key + " " + JSON.stringify(mods)); };
    await go("Tab", CTRL, "Library | Griffiths | Thermo*");
    await go("Tab", CTRL, "Library* | Griffiths | Thermo");                         // round the end
    await go("Tab", { ctrlKey: true, shiftKey: true }, "Library | Griffiths | Thermo*");
    await go("{", { metaKey: true, shiftKey: true }, "Library | Griffiths* | Thermo");   // Cmd+Shift+[
    await go("}", { metaKey: true, shiftKey: true }, "Library | Griffiths | Thermo*");   // Cmd+Shift+]
    await go("1", CMD, "Library* | Griffiths | Thermo");
    await go("2", CMD, "Library | Griffiths* | Thermo");
    await go("9", CMD, "Library | Griffiths | Thermo*");                            // the last tab
    await go("3", CMD, "Library | Griffiths | Thermo*");                            // on screen already: the key is still the page's
    assert.equal(p.key("4", CMD), false, "no tab 4");
    await go("w", CMD, "Library | Griffiths*");
    await go("t", { metaKey: true, shiftKey: true }, "Library | Griffiths | Thermo*");   // Cmd+Shift+T
    // nothing else became a tab key
    for (const [k, m] of [["t", {}], ["w", {}], ["1", {}], ["Tab", {}], ["t", CTRL], ["w", { metaKey: true, altKey: true }]]) {
      const before = p.names();
      p.key(k, m);
      await wait(2);
      assert.equal(p.names(), before, "not a tab key: " + k + " " + JSON.stringify(m));
    }
    assert.equal(p.R.app.current().screen, "deck", "the plain T did not start a review of today's prompts into a new screen");
  });

  test("in the Mac app the menu owns Cmd+T, Cmd+W and Shift+Cmd+T: the page leaves them alone, and run() serves the menu", async () => {
    const p = await page({ app: true });
    p.R.tabs.run("newTab");
    p.R.tabs.run("newTab");
    assert.equal(p.names(), "Library | Library | Library*");
    for (const [k, m] of [["t", CMD], ["w", CMD], ["t", { metaKey: true, shiftKey: true }]]) {
      assert.equal(p.key(k, m), false, "left to the menu: " + k);
      assert.equal(p.names(), "Library | Library | Library*");
      // a held key: the page takes the repeats, so they never reach the menu and the command runs once
      assert.equal(p.key(k, Object.assign({ repeat: true }, m)), true, "a held " + k + " is swallowed");
      assert.equal(p.names(), "Library | Library | Library*");
    }
    assert.deepEqual(plain(p.R.tabs.MENU_KEYS), ["Mod+t", "Mod+w", "Mod+Shift+t"]);
    // every other tab key is the page's in the app too (Ctrl+Tab has no Cmd: macOS may never give it to a menu)
    assert.equal(p.key("1", CMD), true);
    assert.equal(p.names(), "Library* | Library | Library");
    assert.equal(p.key("{", { metaKey: true, shiftKey: true }), true);
    assert.equal(p.names(), "Library | Library | Library*");
    assert.equal(p.key("Tab", CTRL), true);
    assert.equal(p.names(), "Library* | Library | Library");
    assert.equal(p.key("Tab", { ctrlKey: true, shiftKey: true }), true);
    assert.equal(p.names(), "Library | Library | Library*");
    assert.equal(p.key("Tab", Object.assign({ repeat: true }, CTRL)), true, "a held Ctrl+Tab is swallowed");
    assert.equal(p.names(), "Library | Library | Library*");
    assert.equal(p.key("}", { metaKey: true, shiftKey: true }), true);
    assert.equal(p.names(), "Library* | Library | Library");
    assert.equal(p.key("9", CMD), true);
    assert.equal(p.names(), "Library | Library | Library*");
    // what the menu calls
    assert.equal(p.R.tabs.run("prevTab"), true);
    assert.equal(p.names(), "Library | Library* | Library");
    assert.equal(p.R.tabs.run("closeTab"), true);
    assert.equal(p.R.tabs.run("closeTab"), true);
    assert.equal(p.R.tabs.run("closeTab"), false, "one tab: the menu then hides the window");
    assert.equal(p.R.tabs.run("nextTab"), false);
    assert.equal(p.R.tabs.run("bogus"), false);
  });

  test("Cmd+click opens a new tab in the background, with Shift an active one; a plain click goes there as before", async () => {
    const p = await page();
    await p.add(BOOK("b1", "Griffiths"), DECK("d1", "Thermo"));
    p.R.library.render();
    const button = (text) => p.elements(p.doc.getElementById("library"), (el) => el.tagName === "BUTTON" && el.textContent === text)[0];
    const openedAt = p.R.cache.collection("b1").lastOpenedAt;
    p.click(button("Continue reading"), CMD);
    await wait(5);
    assert.equal(p.names(), "Library* | Griffiths", "the page stays where it is");
    assert.equal(p.R.app.current().screen, "library");
    assert.equal(p.opens.length, 0, "nothing was opened");
    assert.equal(p.R.cache.collection("b1").lastOpenedAt, openedAt, "and the book does not count as opened yet");
    p.click(button("Open"), { metaKey: true, shiftKey: true });
    await wait(5);
    assert.equal(p.names(), "Library | Thermo* | Griffiths", "with Shift the new tab is shown");
    assert.equal(p.R.app.current().screen, "deck");
    p.R.tabs.select(p.R.tabs.list()[0].id);
    await wait(5);
    p.R.library.render();
    p.click(button("Statistics"), CMD);
    assert.equal(p.names(), "Library* | Statistics | Thermo | Griffiths");
    // off the Mac the key is Ctrl
    p.R.keys.setPlatform("other");
    p.click(button("Statistics"), CMD);
    await wait(5);
    assert.equal(p.names(), "Statistics* | Statistics | Thermo | Griffiths", "Cmd is no tab key there: a plain click, the page goes");
    await p.R.app.route("library");
    p.R.library.render();
    p.click(button("Statistics"), CTRL);
    assert.equal(p.names(), "Library* | Statistics | Statistics | Thermo | Griffiths");
    p.R.keys.setPlatform("mac");
    // a plain click on the book: the page goes there, and the book counts as opened
    p.click(button("Continue reading"), {});
    await wait(5);
    assert.equal(p.names(), "Griffiths* | Statistics | Statistics | Thermo | Griffiths");
    assert.ok(p.R.cache.collection("b1").lastOpenedAt > openedAt);
    assert.deepEqual(p.opens[p.opens.length - 1], ["b1", {}]);
    // go() and wantsTab() as the click handlers use them
    assert.equal(p.R.tabs.wantsTab({ metaKey: true }), true);
    assert.equal(p.R.tabs.wantsTab({ ctrlKey: true }), false);
    assert.equal(p.R.tabs.wantsTab({}), false);
    assert.equal(p.R.tabs.wantsTab(null), false);
    assert.equal(p.R.tabs.go({ metaKey: true }, "reader", { collectionId: "b1", promptId: "p_1" }), true);
    const last = p.R.tabs.list()[1];
    assert.deepEqual([last.screen, last.collectionId, last.active], ["reader", "b1", false]);
    p.R.tabs.select(last.id);
    await wait(5);
    assert.deepEqual(p.opens[p.opens.length - 1], ["b1", { promptId: "p_1" }], "a tab opened on a prompt goes to it when it is shown");
    p.R.tabs.select(p.R.tabs.list()[0].id);
    await wait(5);
    p.R.tabs.select(last.id);
    await wait(5);
    assert.equal(p.opens[p.opens.length - 1][1].promptId, undefined, "… once");
  });

  test("a prompt on the statistics page opens in a new tab with Cmd+click", async () => {
    const p = await page();
    await p.add(DECK("d1", "Thermo"));
    const parsed = p.R.prompts.parse("Q. What is entropy?\nA. A count of states");
    await p.R.cache.savePrompt({ id: "p_s", collectionId: "d1", kind: parsed.kind, text: "Q. What is entropy?\nA. A count of states", tags: [], flagged: false,
      anchor: null, context: null, cards: p.R.prompts.reconcileCards(null, parsed, 5).cards, createdAt: 5, deletedAt: null, v: 1 }, { content: true });
    await p.R.app.route("stats");
    await wait(5);
    const open = p.elements(p.doc.getElementById("stats"), (el) => el.tagName === "BUTTON" && hasClass(el, "stats__open"))[0];
    assert.ok(open, "the statistics page lists the prompt");
    p.click(open, CMD);
    await wait(5);
    assert.equal(p.names(), "Statistics* | Thermo");
    assert.equal(p.R.app.current().screen, "stats");
    p.click(open, {});
    await wait(5);
    assert.equal(p.names(), "Thermo* | Thermo", "a plain click goes there in this tab");
  });

  test("blocked: a review on screen, the ? sheet, a confirm question, Settings and the other dialogs stop every tab command and every click on the strip", async () => {
    const p = await page();
    await p.add(BOOK("b1", "Griffiths"));
    p.R.tabs.run("newTab");
    assert.equal(p.names(), "Library | Library*");
    p.R.tabs.run("newTab");
    p.R.tabs.run("closeTab");                               // one closed tab, for Cmd+Shift+T
    assert.equal(p.names(), "Library | Library*");
    const other = p.R.tabs.list()[0].id;
    const nothing = (why) => {
      for (const id of ["newTab", "closeTab", "nextTab", "prevTab", "tab1", "lastTab", "reopenTab"]) assert.equal(p.R.tabs.run(id), false, why + ": " + id);
      assert.equal(p.R.tabs.wantsTab({ metaKey: true }), false, why);
      assert.equal(p.R.tabs.link({ screen: "stats" }), false, why + ": a link is left to M.app");
      // the strip itself: a click on a tab, on its ×, a middle click, the keys on a tab that has the focus
      p.click(p.picks()[0]);
      p.click(p.host().querySelectorAll(".tabs__close")[0]);
      const wrap = p.host().querySelectorAll(".tabs__tab")[0];
      wrap.dispatchEvent({ type: "auxclick", button: 1, target: wrap, preventDefault() {} });
      for (const key of ["Enter", " ", "Delete", "Backspace"]) {
        p.host().querySelector(".tabs__list").dispatchEvent({ type: "keydown", key, target: p.picks()[0], preventDefault() {}, stopPropagation() {} });
      }
      // … and every function another module could call
      assert.equal(p.R.tabs.select(other), false, why + ": select");
      assert.equal(p.R.tabs.close(other), false, why + ": close");
      assert.equal(p.R.tabs.open({ screen: "stats" }, {}), null, why + ": open");
      assert.equal(p.R.tabs.open({ screen: "stats" }, { background: true }), null, why + ": open in the background");
      assert.equal(p.R.tabs.reopen(), false, why + ": reopen");
      assert.equal(p.R.tabs.go({ metaKey: true }, "library", {}), false, why + ": a Cmd+click is a plain click");
      assert.equal(p.names(), "Library | Library*", why);
    };
    const realActive = p.R.review.isActive;
    p.R.review.isActive = () => true;
    nothing("review");
    assert.equal(p.key("t", CMD), false);
    p.R.review.isActive = realActive;
    assert.equal(p.R.app.modal(), false);
    p.R.app.openShortcuts();
    assert.equal(p.R.app.modal(), true);
    nothing("the ? sheet");
    assert.equal(p.key("t", CMD), false);
    p.R.app.closeShortcuts();
    const asked = p.R.app.confirm({ title: "Sure?", body: "x", ok: "Yes" });
    assert.equal(p.R.app.modal(), true);
    nothing("a confirm question");
    p.key("Escape", {});
    assert.equal(await asked, false);
    p.doc.getElementById("settings").classList.remove("is-hidden");
    nothing("Settings");
    p.doc.getElementById("settings").classList.add("is-hidden");
    assert.equal(p.R.app.modal(), false);
    // the dialogs of other modules (in the Mac app the menu runs a tab command whatever has the keys)
    const dialog = p.R.exporter.openDialog({ scope: "all" });
    assert.equal(p.R.app.modal(), true, "Export / Import");
    nothing("Export / Import");
    dialog.close();
    assert.equal(p.R.app.modal(), false);
    await p.R.cache.createFolder("Physics");
    await wait(5);
    assert.equal(p.R.library.openPicker("book", "b1", null), true, "the picker opened");
    assert.equal(p.R.app.modal(), true, "the folder picker");
    nothing("Move to folder…");
    p.R.library.closePicker();
    assert.equal(p.R.app.modal(), false);
    assert.equal(p.R.tabs.run("tab1"), true, "and they work again");
  });

  test("the ? sheet lists the tab commands", async () => {
    const p = await page();
    p.R.app.openShortcuts();
    const sections = p.elements(p.doc.getElementById("shortcuts"), (el) => el.tagName === "SECTION");
    const tabsSection = sections.find((s) => p.elements(s, (el) => el.tagName === "H3")[0].textContent === "Tabs");
    assert.ok(tabsSection, "a Tabs section");
    const rows = p.elements(tabsSection, (el) => hasClass(el, "sc-row")).map((r) =>
      [p.elements(r, (el) => hasClass(el, "sc-label"))[0].textContent, p.elements(r, (el) => el.tagName === "KBD").map((k) => k.textContent).join(" / ")]);
    assert.deepEqual(rows, [
      ["New tab", "⌘T"], ["Close tab", "⌘W"], ["Reopen the last closed tab", "⇧⌘T"],
      ["Next tab", "⌃⇥ / ⇧⌘]"], ["Previous tab", "⌃⇧⇥ / ⇧⌘["], ["Tab 1 to 8", "⌘1 … ⌘8"], ["Last tab", "⌘9"],
      ["Open a book, a deck, Statistics or a prompt in a new tab", "⌘ click"]]);
    p.R.app.closeShortcuts();
  });

  test("at most 20 tabs: the next one is refused with a notice", async () => {
    const p = await page();
    for (let i = 1; i < T.TABS_MAX; i++) assert.notEqual(p.R.tabs.open({ screen: "library" }, { background: true }), null);
    assert.equal(p.R.tabs.list().length, T.TABS_MAX);
    assert.equal(p.R.tabs.open({ screen: "stats" }, {}), null);
    assert.equal(p.R.tabs.run("newTab"), false);
    assert.equal(p.R.tabs.list().length, T.TABS_MAX);
    assert.equal(p.toasts[p.toasts.length - 1], "Close a tab first: 20 tabs are open");
    // a link still gets through: it takes the active tab (a library tab here)
    assert.equal(p.R.tabs.link({ screen: "stats" }), true);
    assert.equal(p.R.tabs.list().length, T.TABS_MAX);
    assert.equal(p.R.tabs.list().filter((t) => t.active)[0].screen, "stats");
  });
});

describe("M.tabs: storage, restart and links (real modules, fake DOM of tools/smoke.js)", () => {
  const b1 = BOOK("b1", "Griffiths"), d1 = DECK("d1", "Thermo");
  const STORED = { v: 1, active: 1, tabs: [
    { screen: "library", collectionId: null, position: null },
    { screen: "reader", collectionId: "b1", position: { pageIndex: 5, fraction: 0.25, zoom: 2 } },
    { screen: "reader", collectionId: "lost", position: { pageIndex: 1, fraction: 0, zoom: "fit" } },
    { screen: "deck", collectionId: "d1", position: null }] };

  test("the tabs of last time come back, the active one on screen at its place; a tab whose book is gone does not", async () => {
    const p = await page({ stored: STORED, collections: [b1, d1] });
    assert.equal(p.names(), "Library | Griffiths* | Thermo");
    assert.equal(p.hidden(), false);
    assert.deepEqual(p.opens, [["b1", { position: { pageIndex: 5, fraction: 0.25, zoom: 2 } }]], "boot opened the active tab's book at the tab's place");
    assert.deepEqual(Object.assign({}, p.R.app.current()), { screen: "reader", collectionId: "b1", promptId: null });
    assert.equal(p.toasts.length, 0, "no notice about the tab that could not come back");
  });

  test("an address that names a place goes before the stored active tab: to the tab that shows it, else a library tab, else a new tab", async () => {
    // a link to the deck that has a tab: that tab is shown
    let p = await page({ stored: STORED, collections: [b1, d1], hash: "#deck/d1" });
    assert.equal(p.names(), "Library | Griffiths | Thermo*");
    assert.equal(p.opens.length, 0);
    // a link to one prompt of the book that has a tab: that tab, at the prompt (not at the tab's stored place alone)
    p = await page({ stored: STORED, collections: [b1, d1], hash: "#reader/b1/p_7" });
    assert.equal(p.names(), "Library | Griffiths* | Thermo");
    assert.equal(p.opens[0][0], "b1");
    assert.equal(p.opens[0][1].promptId, "p_7");
    // a link to Statistics, which no tab shows; the stored active tab is a book: a new tab after it
    p = await page({ stored: STORED, collections: [b1, d1], hash: "#stats" });
    assert.equal(p.names(), "Library | Griffiths | Statistics* | Thermo");
    // … and when the stored active tab is a library tab, that tab takes it
    p = await page({ stored: Object.assign({}, STORED, { active: 0 }), collections: [b1, d1], hash: "#stats" });
    assert.equal(p.names(), "Statistics* | Griffiths | Thermo");
    // the plain library address is no link: the stored active tab is shown
    p = await page({ stored: STORED, collections: [b1, d1], hash: "#library" });
    assert.equal(p.names(), "Library | Griffiths* | Thermo");
    // a first start on a link: one tab, that place
    p = await page({ collections: [b1], hash: "#reader/b1" });
    assert.equal(p.names(), "Griffiths*");
    assert.equal(p.hidden(), true);
  });

  test("storage that cannot be read gives one tab; what is stored is written 200 ms after a change and on pagehide", async () => {
    for (const bad of ["{not json", "null", "[]", "{\"tabs\":[{\"screen\":\"reader\",\"collectionId\":\"gone\"}]}"]) {
      const q = await page({ stored: bad });
      assert.equal(q.names(), "Library*", bad);
    }
    const p = await page();
    await wait(260);
    assert.deepEqual(p.stored(), { v: 1, active: 0, tabs: [{ screen: "library", collectionId: null, position: null }] });
    p.R.tabs.run("newTab");
    p.R.app.route("stats");
    assert.equal(p.stored().tabs.length, 1, "not yet");
    await wait(260);
    assert.deepEqual(p.stored().tabs.map((t) => t.screen), ["library", "stats"]);
    assert.equal(p.stored().active, 1);
    // closing the window right after a change loses nothing
    p.R.tabs.run("newTab");
    p.W.dispatchEvent({ type: "pagehide" });
    assert.equal(p.stored().tabs.length, 3);
    // nothing but the places is stored: no ids, no titles, no closed tabs
    assert.deepEqual(Object.keys(p.stored()).sort(), ["active", "tabs", "v"]);
    assert.deepEqual(Object.keys(p.stored().tabs[0]).sort(), ["collectionId", "position", "screen"]);
  });

  test("a page that stepped aside for a newer one, and the cover, store nothing", async () => {
    const p = await page();
    await wait(260);
    const before = JSON.stringify(p.stored());
    const realLocked = p.R.store.locked;
    p.R.store.locked = () => ({ reason: "othertab", by: "x", at: 1 });
    p.R.tabs.open({ screen: "stats" }, { background: true });
    assert.equal(p.R.tabs.save(), false);
    await wait(260);
    assert.equal(JSON.stringify(p.stored()), before, "the newer page's list is not overwritten");
    p.R.store.locked = realLocked;
    const realCovered = p.R.desktop.covered;
    p.R.desktop.covered = () => true;
    assert.equal(p.R.tabs.save(), false);
    p.R.desktop.covered = realCovered;
    assert.equal(p.R.tabs.save(), true);
    assert.equal(p.stored().tabs.length, 2);
    // a localStorage that throws never breaks a command
    p.W.localStorage.setItem = () => { throw new Error("quota"); };
    assert.equal(p.R.tabs.run("newTab"), true);
    assert.equal(p.R.tabs.save(), false);
  });

  test("a link from outside while the app runs (a new address): the tab that shows the place, else a library tab, else a new tab", async () => {
    const p = await page({ collections: [b1, d1] });
    await p.add(b1, d1);
    // a new address makes a new history entry, which does not carry the app's mark
    const visit = async (h) => { p.hist.visit(h); await wait(5); };
    await visit("#reader/b1/p_1");
    assert.equal(p.names(), "Griffiths*", "the one library tab took it");
    assert.deepEqual(p.opens[p.opens.length - 1], ["b1", { promptId: "p_1" }]);
    assert.deepEqual(plain(p.W.history.state), { marginalia: 1 }, "the entry is the app's own from now on");
    await visit("#deck/d1");
    assert.equal(p.names(), "Griffiths | Thermo*", "the active tab is a book: a new tab");
    p.reader.pos = null;
    await visit("#reader/b1/p_2");
    assert.equal(p.names(), "Griffiths* | Thermo", "the tab that shows the book already");
    assert.equal(p.opens[p.opens.length - 1][1].promptId, "p_2");
    await visit("#reader/b1");
    assert.equal(p.names(), "Griffiths* | Thermo", "the address of the place on screen: nothing to do");
    assert.deepEqual(plain(p.W.history.state), { marginalia: 1 }, "… but its entry is marked too");
    await visit("#stats");
    assert.equal(p.names(), "Griffiths | Statistics* | Thermo");
    await visit("#library");
    assert.equal(p.names(), "Griffiths | Statistics | Library* | Thermo");
    await visit("#deck/d1");
    assert.equal(p.names(), "Griffiths | Statistics | Library | Thermo*");
    assert.equal(p.R.tabs.list().length, 4, "no tab twice for the deck");
    // every entry of the history is the app's own now: none is left without the mark
    assert.equal(p.hist.stack.entries.every((e) => e.state && e.state.marginalia === 1), true);
  });

  test("Back and Forward (a browser's buttons) move the tab that is on screen: they open no tab and pick no other tab", async () => {
    const p = await page({ collections: [b1, d1] });
    await p.add(b1, d1);
    assert.deepEqual(plain(p.W.history.state), { marginalia: 1 }, "boot marks the entry the page started on");
    const go = async (way) => { p.W.history[way](); await wait(5); };
    // going on inside the tab adds entries, each with the app's mark
    await p.R.app.route("reader", { collectionId: "b1" });
    await p.R.app.route("stats");
    assert.equal(p.names(), "Statistics*");
    assert.deepEqual(p.hist.stack.entries.map((e) => e.hash), ["#library", "#reader/b1", "#stats"]);
    assert.equal(p.hist.stack.entries.every((e) => e.state && e.state.marginalia === 1), true, "also the entries that pushState made");
    await go("back");
    assert.equal(p.names(), "Griffiths*");
    assert.equal(p.R.app.current().screen, "reader");
    assert.equal(p.hist.stack.entries.length, 3, "going back adds no entry …");
    await go("forward");
    assert.equal(p.names(), "Statistics*", "… so Forward still works");
    await go("back");
    // with more tabs, one of them on the library: Back to the library still moves the tab on screen
    p.R.tabs.open({ screen: "library" }, { background: true });
    p.R.tabs.open({ screen: "deck", collectionId: "d1" }, { background: true });
    assert.equal(p.names(), "Griffiths* | Thermo | Library");
    await go("back");
    assert.equal(p.names(), "Library* | Thermo | Library", "not the tab that showed the library already");
    await go("forward");
    assert.equal(p.names(), "Griffiths* | Thermo | Library");
    await go("forward");
    assert.equal(p.names(), "Statistics* | Thermo | Library", "no new tab");
    assert.equal(p.R.tabs.list().length, 3);
    // a link from outside, then Back and Forward over its entry: the link picked a tab once; Forward to it later moves
    // the tab on screen and opens nothing
    p.hist.visit("#deck/d1");
    await wait(5);
    assert.equal(p.names(), "Statistics | Thermo* | Library", "the link went to the tab that shows the deck");
    await go("back");
    assert.equal(p.names(), "Statistics | Statistics* | Library", "Back: the tab on screen goes to the entry before");
    await go("forward");
    assert.equal(p.names(), "Statistics | Thermo* | Library", "Forward to the link's entry: the tab on screen, no new tab");
    assert.equal(p.R.tabs.list().length, 3);
    // changing tabs adds no history entry (it replaces the one the page is on)
    const entries = p.hist.stack.entries.length;
    p.R.tabs.run("nextTab");
    await wait(5);
    p.R.tabs.run("newTab");
    await wait(5);
    p.R.tabs.run("closeTab");
    await wait(5);
    p.R.tabs.run("reopenTab");
    await wait(5);
    p.R.tabs.run("tab1");
    await wait(5);
    assert.equal(p.hist.stack.entries.length, entries);
    assert.equal(p.W.location.hash, "#stats", "the address is the place of the tab on screen");
    // the mark is written only where it is missing: a route to the place that is on screen writes nothing
    let writes = 0;
    const realReplace = p.hist.api.replaceState, realPush = p.hist.api.pushState;
    p.hist.api.replaceState = function () { writes++; return realReplace.apply(this, arguments); };
    p.hist.api.pushState = function () { writes++; return realPush.apply(this, arguments); };
    await p.R.app.route("stats");
    await p.R.app.route("stats");
    assert.equal(writes, 0);
    p.hist.api.replaceState = realReplace; p.hist.api.pushState = realPush;
    // Back to an entry whose book is gone: the page goes home and that entry is replaced, so Forward still works
    const r = await page();                               // (no `collections` option: the book must be able to go)
    await r.add(b1, d1);
    await r.R.app.route("reader", { collectionId: "b1" });
    await r.R.app.route("stats");
    await r.R.cache.removeCollection("b1");
    await wait(5);
    r.W.history.back();
    await wait(10);
    assert.equal(r.R.app.current().screen, "library");
    assert.deepEqual(r.hist.stack.entries.map((e) => e.hash), ["#library", "#library", "#stats"], "the dead entry is replaced; nothing is pushed");
    r.W.history.forward();
    await wait(5);
    assert.equal(r.R.app.current().screen, "stats");
    // a page without the history API cannot tell the two apart: every address change moves the tab on screen
    const q = await page({ collections: [b1, d1], noHistory: true });
    await q.add(b1, d1);
    q.R.tabs.open({ screen: "deck", collectionId: "d1" }, { background: true });
    await q.R.app.route("reader", { collectionId: "b1" });
    assert.equal(q.names(), "Griffiths* | Thermo");
    q.W.location.hash = "#deck/d1"; q.W.dispatchEvent({ type: "hashchange" });
    await wait(5);
    assert.equal(q.names(), "Thermo* | Thermo");
  });

  test("a history call that fails once (a browser's limit) does not turn the tab links off for good", async () => {
    const p = await page({ collections: [b1, d1] });
    await p.add(b1, d1);
    await p.R.app.route("reader", { collectionId: "b1" });
    const realPush = p.hist.api.pushState;
    let fail = true;
    p.hist.api.pushState = function () { if (fail) { fail = false; throw new Error("SecurityError: too many calls"); } return realPush.apply(this, arguments); };
    await p.R.app.route("stats");                         // this write fails: the address goes through location.hash
    assert.equal(p.W.location.hash, "#stats");
    await p.R.app.route("library");                       // … and the next one works again
    assert.equal(p.names(), "Library*");
    await p.R.app.route("reader", { collectionId: "b1" });
    // a link from outside picks its tab again (the active tab is a book: a new tab)
    p.hist.visit("#deck/d1");
    await wait(5);
    assert.equal(p.names(), "Griffiths | Thermo*");
  });

  test("clicks on the strip: a tab is shown, × closes it, a middle click closes it, + adds a tab, ← and → move the focus", async () => {
    const p = await page({ collections: [b1, d1] });
    await p.add(b1, d1);
    p.R.tabs.open({ screen: "reader", collectionId: "b1" }, { background: true });
    p.R.tabs.open({ screen: "deck", collectionId: "d1" }, { background: true });
    assert.equal(p.names(), "Library* | Thermo | Griffiths");
    p.click(p.picks()[2]);
    await wait(5);
    assert.equal(p.names(), "Library | Thermo | Griffiths*");
    assert.equal(p.R.app.current().collectionId, "b1");
    p.click(p.host().querySelectorAll(".tabs__close")[1]);
    await wait(5);
    assert.equal(p.names(), "Library | Griffiths*", "closing a background tab keeps the screen");
    assert.equal(p.R.app.current().collectionId, "b1");
    const wrap = p.host().querySelectorAll(".tabs__tab")[0];
    wrap.dispatchEvent({ type: "auxclick", button: 2, target: wrap, preventDefault() {} });
    assert.equal(p.names(), "Library | Griffiths*", "only the middle button");
    wrap.dispatchEvent({ type: "auxclick", button: 1, target: wrap, preventDefault() {} });
    assert.equal(p.names(), "Griffiths*");
    assert.equal(p.hidden(), true);
    p.R.tabs.run("newTab");
    p.click(p.host().querySelector(".tabs__new"));
    await wait(5);
    assert.equal(p.names(), "Griffiths | Library | Library*");
    // ← and → on a tab move the focus along the strip, round the ends; they are no tab commands
    const picks = p.picks();
    picks[2].focus();
    const arrow = (key, from) => {
      const e = { type: "keydown", key, target: from, metaKey: false, ctrlKey: false, altKey: false, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} };
      p.host().querySelector(".tabs__list").dispatchEvent(e);
      return e.defaultPrevented;
    };
    assert.equal(arrow("ArrowRight", picks[2]), true);
    assert.equal(p.doc.activeElement, picks[0]);
    assert.equal(arrow("ArrowLeft", picks[0]), true);
    assert.equal(p.doc.activeElement, picks[2]);
    assert.equal(arrow("ArrowDown", picks[2]), false);
    assert.equal(p.names(), "Griffiths | Library | Library*");
    assert.deepEqual(p.logs, []);
  });

  test("keys on a tab that has the focus: Enter and Space show it, Delete and Backspace close it; the focus stays in the strip", async () => {
    const p = await page();
    await p.add(BOOK("b1", "Griffiths"));
    await p.R.app.route("reader", { collectionId: "b1" });
    p.R.tabs.open({ screen: "library" }, { background: true });
    p.R.tabs.open({ screen: "stats" }, { background: true });
    assert.equal(p.names(), "Griffiths* | Statistics | Library");
    // the reader's own keys must not get these: there Enter shows a card's answer and Backspace deletes a card
    const ran = [];
    const realRun = p.R.margin.run;
    p.R.margin.run = (id) => { ran.push(id); return realRun(id); };
    // (elements are compared with ===: a failed deepEqual of two fake elements prints the whole page)
    const attached = (el) => { for (let n = el; n; n = n.parentNode) if (n === p.doc.body) return true; return false; };
    const inStrip = (el) => { for (let n = el; n; n = n.parentNode) if (n === p.host()) return true; return false; };
    p.picks()[1].focus();
    assert.equal(p.key("Enter", {}), true, "the strip takes the key");
    await wait(5);
    assert.equal(p.names(), "Griffiths | Statistics* | Library");
    // the old buttons are gone with the redraw; the focus is never left on one of them (the screen that came may take it)
    assert.equal(attached(p.doc.activeElement), true, "the focus is on an element of the page still");
    p.picks()[2].focus();
    assert.equal(p.key(" ", {}), true);
    await wait(5);
    assert.equal(p.names(), "Griffiths | Statistics | Library*");
    assert.equal(attached(p.doc.activeElement), true);
    // Delete closes the tab under the focus, here a tab in the background: the screen stays, and the focus stays in
    // the strip, on the tab that is on screen
    p.picks()[1].focus();
    assert.equal(p.key("Delete", {}), true);
    await wait(5);
    assert.equal(p.names(), "Griffiths | Library*");
    assert.ok(p.doc.activeElement === p.picks()[1], "the focus is on the tab on screen");
    assert.equal(p.key("Backspace", { repeat: true }), true, "a held key is swallowed");
    assert.equal(p.names(), "Griffiths | Library*");
    assert.equal(p.key("Backspace", {}), true);
    await wait(5);
    assert.equal(p.names(), "Griffiths*", "the tab on screen closed; its neighbour came");
    assert.equal(p.hidden(), true);
    assert.equal(attached(p.doc.activeElement), true);
    assert.equal(inStrip(p.doc.activeElement), false, "the strip is gone, and the focus with it");
    assert.deepEqual(ran, [], "none of these keys reached the screen below");
    // with a modifier the keys are not the strip's
    p.R.tabs.run("newTab");
    p.picks()[0].focus();
    const before = p.names();
    p.host().querySelector(".tabs__list").dispatchEvent({ type: "keydown", key: "Enter", metaKey: true, target: p.picks()[0], preventDefault() { throw new Error("not the strip's key"); }, stopPropagation() {} });
    assert.equal(p.names(), before);
    // a redraw does not take the focus into the strip: a rename of a book redraws it while the focus is in the page
    p.doc.activeElement = p.doc.body;
    await p.R.cache.saveCollection(Object.assign({}, p.R.cache.collection("b1"), { name: "Griffiths QM" }));
    await wait(5);
    assert.equal(p.picks()[0].textContent, "Griffiths QM");
    assert.ok(p.doc.activeElement === p.doc.body, "the focus stayed where it was");
    p.R.margin.run = realRun;
  });

  test("Cmd+Shift+] and Cmd+Shift+[ also by the keys' place on the keyboard (an engine that reports ] with Shift)", async () => {
    const p = await page();
    p.R.tabs.run("newTab");
    p.R.tabs.run("newTab");
    assert.equal(p.names(), "Library | Library | Library*");
    assert.equal(p.key("]", { metaKey: true, shiftKey: true, code: "BracketRight" }), true);
    assert.equal(p.names(), "Library* | Library | Library");
    assert.equal(p.key("[", { metaKey: true, shiftKey: true, code: "BracketLeft" }), true);
    assert.equal(p.names(), "Library | Library | Library*");
    // not without Shift (Cmd+] and Cmd+[ are no tab keys), not with Alt, not with Ctrl on the Mac
    for (const mods of [{ metaKey: true, code: "BracketRight" }, { metaKey: true, shiftKey: true, altKey: true, code: "BracketRight" },
      { ctrlKey: true, shiftKey: true, code: "BracketRight" }, { shiftKey: true, code: "BracketRight" }, { metaKey: true, shiftKey: true, code: "KeyP" }]) {
      p.key("]", mods);
      assert.equal(p.names(), "Library | Library | Library*", JSON.stringify(mods));
    }
    // off the Mac the same keys go with Ctrl
    p.R.keys.setPlatform("other");
    assert.equal(p.key("]", { ctrlKey: true, shiftKey: true, code: "BracketRight" }), true);
    assert.equal(p.names(), "Library* | Library | Library");
    p.R.keys.setPlatform("mac");
  });

  test("the limits: 10 closed tabs come back, a 21st tab never opens, a link with 20 tabs takes the tab on screen and says so", async () => {
    const p = await page();
    await p.add(BOOK("b1", "Griffiths"));
    // 12 tabs closed: the last 10 come back
    for (let i = 0; i < 12; i++) p.R.tabs.run("newTab");
    for (let i = 0; i < 12; i++) assert.equal(p.R.tabs.run("closeTab"), true);
    assert.equal(p.R.tabs.list().length, 1);
    let back = 0;
    while (p.R.tabs.run("reopenTab")) back++;
    assert.equal(back, 10);
    assert.equal(p.R.tabs.CLOSED_MAX, 10);
    // 20 tabs open, one closed, another opened: Cmd+Shift+T has no room, says so, and keeps the closed tab for later
    while (p.R.tabs.list().length < 20) p.R.tabs.run("newTab");
    assert.equal(p.R.tabs.run("closeTab"), true);
    assert.equal(p.R.tabs.run("newTab"), true);
    assert.equal(p.R.tabs.list().length, 20);
    p.toasts.length = 0;
    assert.equal(p.R.tabs.run("reopenTab"), false);
    assert.equal(p.R.tabs.list().length, 20, "no 21st tab");
    assert.deepEqual(p.toasts, ["Close a tab first: 20 tabs are open"]);
    // a link from outside still opens: the tab on screen takes it, with a notice
    await p.R.app.route("stats");
    p.toasts.length = 0;
    assert.equal(p.R.tabs.link({ screen: "reader", collectionId: "b1", promptId: "p_3" }), true);
    await wait(5);
    assert.equal(p.R.tabs.list().length, 20);
    assert.equal(p.R.app.current().collectionId, "b1");
    assert.deepEqual(p.toasts, ["20 tabs are open: this tab took the link"]);
    // room again: the closed tab comes back
    assert.equal(p.R.tabs.run("closeTab"), true);
    assert.equal(p.R.tabs.run("reopenTab"), true);
    assert.equal(p.R.tabs.list().length, 20);
  });

  test("a tab opened in the background is stored too; a text field with the focus gets its blur before a tab leaves", async () => {
    const p = await page();
    await p.add(BOOK("b1", "Griffiths"));
    await wait(260);
    p.R.tabs.open({ screen: "reader", collectionId: "b1" }, { background: true });
    await wait(260);
    assert.deepEqual(p.stored().tabs.map((x) => x.screen), ["library", "reader"], "written without any other change");
    // A name that is being changed: its field takes the text on blur (js/library.js, js/reader.js). The tab change
    // gives it that blur BEFORE the screen goes (afterwards the reader has closed, and its field takes nothing).
    const field = p.doc.createElement("input");
    p.doc.getElementById("library").appendChild(field);
    const blurs = [];
    field.blur = () => { blurs.push(p.R.app.current().screen); p.doc.activeElement = p.doc.body; };
    field.focus();
    assert.equal(p.R.app.current().screen, "library");
    p.R.tabs.run("nextTab");
    await wait(5);
    assert.equal(p.R.app.current().screen, "reader");
    assert.deepEqual(blurs, ["library"], "once, while its screen was still there");
    // a button with the focus is not a text field: the tab change leaves it alone
    p.R.tabs.run("prevTab");
    await wait(5);
    const button = p.doc.createElement("button");
    p.doc.getElementById("library").appendChild(button);
    const early = [];
    button.blur = () => { early.push(p.R.app.current().screen); };
    button.focus();
    p.R.tabs.run("nextTab");
    await wait(5);
    assert.equal(early.indexOf("library"), -1, "no blur before the screen went");
  });

  test("the strip's level: under the review, the snip overlay, the banner and every dialog; over the page and its menus", () => {
    const css = (name) => fs.readFileSync(path.join(__dirname, "..", name), "utf8");
    const level = (text, selector) => {
      const i = text.indexOf(selector + " {");
      assert.ok(i >= 0, "no rule " + selector);
      const m = /z-index:\s*(\d+)/.exec(text.slice(i, text.indexOf("}", i)));
      assert.ok(m, "no z-index in " + selector);
      return Number(m[1]);
    };
    const strip = level(css("css/tabs.css"), "#tabs");
    assert.equal(strip, 35);
    assert.ok(strip < level(css("css/review.css"), "#review"), "a review covers the strip: nothing on it can be clicked then");
    assert.ok(strip < level(css("css/snip.css"), "#snipOverlay"));
    assert.ok(strip < level(css("css/app.css"), "#banner"));
    assert.ok(strip < level(css("css/library.css"), "#settings:not(.is-hidden)"));
    assert.ok(strip > level(css("css/library.css"), ".lib-menu"), "a menu of the page scrolls under the strip");
    const styles = css("styles.css");
    assert.match(styles, /#app:has\(> #banner:not\(\.is-hidden\)\) > #tabs \{ position: static; \}/, "with the banner shown, the banner keeps the top");
    assert.match(styles, /html:has\(#tabs:not\(\.is-hidden\)\) \{ scroll-padding-top: 34px; \}/);
    assert.match(styles, /#app \{ --tabs-h: 34px; \}/, "the same height");
  });
});
