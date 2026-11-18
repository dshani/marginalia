"use strict";
// Tests for js/app.js (SPEC §3 focus owner + key routing, §10 review triggers, §17.2 M.app; BUILD-NOTES "Key routing",
// "Routing and review triggers"). Run: node --test test/app.test.js
// app.js is a DOM module; here it is loaded without a document: the routing table, the Escape chain, the review
// triggers, the hash helpers and the no-DOM fallbacks are exercised with stubbed modules and fake keydown events
// (a bare `document` is installed only around the #list tests). The last blocks run the 29 real modules in the
// fake window of tools/smoke.js to cover the Escape chain against the deck page's inline prompt list, prompt links and
// the start of the daily backup (M.backup.start() at boot, BUILD-NOTES "Automatic backup").
const { test, describe, before, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const M = globalThis.Marginalia = globalThis.Marginalia || {};
const keys = require(path.join(__dirname, "..", "js", "keys.js"));
const bus = require(path.join(__dirname, "..", "js", "bus.js"));
const settings = require(path.join(__dirname, "..", "js", "settings.js"));
const app = require(path.join(__dirname, "..", "js", "app.js"));

// ---- fakes ---------------------------------------------------------------------

function ev(key, opts) {
  const o = opts || {};
  const e = {
    key, code: o.code || "",
    ctrlKey: !!o.ctrlKey, altKey: !!o.altKey, shiftKey: !!o.shiftKey, metaKey: !!o.metaKey,
    repeat: !!o.repeat, isComposing: !!o.isComposing, defaultPrevented: !!o.defaultPrevented,
    target: o.target || { tagName: "DIV", closest: () => null },
    prevented: 0
  };
  e.preventDefault = () => { e.prevented++; e.defaultPrevented = true; };
  return e;
}
const TEXTAREA = { tagName: "TEXTAREA", closest: () => null };
const IN_EDITOR_TEXTAREA = { tagName: "TEXTAREA", closest: (sel) => (sel === ".editor" ? { tagName: "DIV" } : null) };

// A stub whose run(id) returns `handles.includes(id)` and records every call.
function runner(handles) {
  const calls = [];
  return { calls, run(id) { calls.push(id); return handles.indexOf(id) >= 0; } };
}
function spy(ret) {
  const fn = function () { fn.calls.push(Array.from(arguments)); return typeof ret === "function" ? ret.apply(null, arguments) : ret; };
  fn.calls = [];
  return fn;
}

let snip, reader, margin, review, library, list, cache, editor, libEditor;
function installStubs() {
  snip = runner([]); reader = runner([]); margin = runner([]);
  editor = { calls: [], run(id) { editor.calls.push(id); return true; }, focus() {} };
  libEditor = { calls: [], run(id) { libEditor.calls.push(id); return true; }, focus() {} };
  margin.activeEditor = () => null;
  review = {
    start: spy(Promise.resolve()), stop: spy(), reveal: spy(), grade: spy(), undo: spy(), skip: spy(), goToSource: spy(),
    flag: spy(), remove: spy(), isActive: () => true, isSuspended: () => false
  };
  library = { render: spy(), openDeck: spy(), openSettings: spy(), closeSettings: spy(), activeEditor: () => null, addPdfFromUrl: spy(Promise.resolve()) };
  list = { isOpen: () => false, close: spy() };
  cache = { collection: () => null, prompt: () => null };
  M.snip = snip; M.reader = reader; M.margin = margin; M.review = review; M.library = library; M.list = list; M.cache = cache;
}

function press(key, opts) { const e = ev(key, opts); const handled = app.handleKeydown(e); return { e, handled }; }

// A bare document for the Escape-chain tests that look at #list (the reader's drawer host): `listClasses` is the
// class list of #list, or null for a document without a #list host. It is removed again afterwards.
function withDocument(listClasses, fn) {
  const cls = listClasses ? new Set(listClasses) : null;
  const listEl = cls ? { id: "list", classList: { contains: (c) => cls.has(c), add: (c) => cls.add(c), remove: (c) => cls.delete(c) } } : null;
  const body = { tagName: "BODY" };
  const had = Object.prototype.hasOwnProperty.call(globalThis, "document"), prev = globalThis.document;
  globalThis.document = { body, activeElement: body, getElementById: (id) => (id === "list" ? listEl : null) };
  try { return fn(); } finally { if (had) globalThis.document = prev; else delete globalThis.document; }
}

describe("app", () => {
  before(() => { keys.setPlatform("mac"); settings.reset(); });
  after(() => { keys.setPlatform(null); settings.reset(); });
  beforeEach(() => { installStubs(); app.setFocusOwner("library"); });

  describe("contract", () => {
    test("exposes every §17.2 / BUILD-NOTES signature", () => {
      for (const fn of ["boot", "route", "setFocusOwner", "focusOwner", "toast", "confirm", "setTheme", "isArtifact", "startReview", "openShortcuts"]) {
        assert.equal(typeof app[fn], "function", fn);
      }
      assert.equal(M.app, app);
    });
    test("is safe without a DOM", async () => {
      assert.equal(await app.boot(), false);
      assert.equal(await app.route("reader", { collectionId: "x" }), false);
      const t = app.toast({ text: "hi", actions: [{ label: "A", run() {} }] });
      assert.equal(typeof t.close, "function");
      t.close();
      assert.equal(await app.confirm({ title: "Delete?", danger: true }), false);
      assert.equal(app.isArtifact(), false);
      assert.equal(app.openShortcuts(), false);
    });
    test("focus owner round-trips (unknown owners are kept and routed like the library)", () => {
      assert.equal(app.setFocusOwner("reader"), "reader");
      assert.equal(app.focusOwner(), "reader");
      assert.equal(app.setFocusOwner(""), "reader");
      assert.equal(app.setFocusOwner("card"), "card");
      assert.deepEqual(app.OWNERS, ["reader", "card", "editor", "list", "review", "library", "settings"]);
    });
    test("setTheme normalises and persists through M.settings", () => {
      assert.equal(app.setTheme("dark"), "dark");
      assert.equal(settings.get("theme"), "dark");
      assert.equal(app.setTheme("bogus"), "system");
      assert.equal(settings.get("theme"), "system");
      assert.equal(app.setTheme("light"), "light");
      settings.set("theme", "system");
    });
    test("hash helpers round-trip and ignore junk", () => {
      assert.equal(app.hashFor("reader", { collectionId: "a b/c" }), "#reader/a%20b%2Fc");
      assert.deepEqual(app.parseHash("#reader/a%20b%2Fc"), { screen: "reader", params: { collectionId: "a b/c" } });
      assert.deepEqual(app.parseHash("#deck/deck_1"), { screen: "deck", params: { collectionId: "deck_1" } });
      assert.deepEqual(app.parseHash(""), { screen: "library", params: {} });
      assert.deepEqual(app.parseHash("#reader"), { screen: "library", params: {} });
      assert.deepEqual(app.parseHash("#nonsense/x"), { screen: "library", params: {} });
      // the "Open in Marginalia" links of BUILD-NOTES "Obsidian": #reader/<collectionId>/<promptId>
      assert.deepEqual(app.parseHash("#reader/92b1cb87/p_3f9a"), { screen: "reader", params: { collectionId: "92b1cb87", promptId: "p_3f9a" } });
      assert.deepEqual(app.parseHash("#reader/fp%3Aab12/p_1"), { screen: "reader", params: { collectionId: "fp:ab12", promptId: "p_1" } });
      assert.deepEqual(app.parseHash("#deck/deck_1/p_1"), { screen: "deck", params: { collectionId: "deck_1" } });
      assert.equal(app.hashFor("deck", {}), "#library");
      assert.equal(app.hashFor("library"), "#library");
      // D27: the statistics page has its own hash and no collection
      assert.equal(app.hashFor("stats"), "#stats");
      assert.equal(app.hashFor("stats", { collectionId: "b1" }), "#stats");
      assert.deepEqual(app.parseHash("#stats"), { screen: "stats", params: {} });
      assert.deepEqual(app.parseHash("#stats/b1"), { screen: "stats", params: {} });
    });
  });

  describe("reader / card owners", () => {
    test("routes snip → reader → margin → app and prevents the default of the first handler only", () => {
      app.setFocusOwner("reader");
      reader = runner(["prompt"]); M.reader = reader;
      const r = press("n");
      assert.equal(r.handled, true);
      assert.equal(r.e.prevented, 1);
      assert.deepEqual(snip.calls, ["prompt"]);
      assert.deepEqual(reader.calls, ["prompt"]);
      assert.deepEqual(margin.calls, []);
    });
    test("falls through to the margin for card actions", () => {
      app.setFocusOwner("card");
      margin = runner(["next"]); margin.activeEditor = () => null; M.margin = margin;
      const r = press("j");
      assert.equal(r.handled, true);
      assert.deepEqual(snip.calls, ["next"]);
      assert.deepEqual(reader.calls, ["next"]);
      assert.deepEqual(margin.calls, ["next"]);
    });
    test("O (obsidianNote, BUILD-NOTES \"Obsidian\") goes to M.reader.run like N / C / H, never from a text field", () => {
      app.setFocusOwner("reader");
      reader = runner(["obsidianNote"]); M.reader = reader;
      const r = press("o");
      assert.equal(r.handled, true);
      assert.equal(r.e.prevented, 1);
      assert.deepEqual(reader.calls, ["obsidianNote"]);
      assert.deepEqual(margin.calls, []);
      app.setFocusOwner("card");
      assert.equal(press("o").handled, true, "a focused card routes it too");
      assert.equal(press("o", { target: TEXTAREA }).handled, false);
      assert.deepEqual(reader.calls, ["obsidianNote", "obsidianNote"]);
    });
    test("the snip module wins first", () => {
      app.setFocusOwner("reader");
      snip = runner(["snip"]); M.snip = snip;
      const r = press("s");
      assert.equal(r.handled, true);
      assert.deepEqual(reader.calls, []);
      assert.deepEqual(margin.calls, []);
    });
    test("an unhandled action leaves the default alone", () => {
      app.setFocusOwner("reader");
      const r = press("j");
      assert.equal(r.handled, false);
      assert.equal(r.e.prevented, 0);
      assert.deepEqual(margin.calls, ["next"]);
    });
    test("a key with no binding does nothing", () => {
      app.setFocusOwner("reader");
      const r = press("x");
      assert.equal(r.handled, false);
      assert.deepEqual(snip.calls, []);
    });
    test("ignores repeats of single-shot actions but keeps their default prevented; J/K repeat", () => {
      app.setFocusOwner("reader");
      reader = runner(["prompt"]); margin = runner(["next"]); margin.activeEditor = () => null; M.reader = reader; M.margin = margin;
      const a = press("n", { repeat: true });
      assert.equal(a.handled, true);
      assert.equal(a.e.prevented, 1);
      assert.deepEqual(reader.calls, []);
      const b = press("j", { repeat: true });
      assert.equal(b.handled, true);
      assert.deepEqual(margin.calls, ["next"]);
    });
    test("ignores composing and already-handled events", () => {
      app.setFocusOwner("reader");
      reader = runner(["prompt"]); M.reader = reader;
      assert.equal(press("n", { isComposing: true }).handled, false);
      assert.equal(press("n", { defaultPrevented: true }).handled, false);
      assert.deepEqual(reader.calls, []);
    });
    test("nothing fires inside a text field (the find box, the page box, a rename field)", () => {
      app.setFocusOwner("reader");
      reader = runner(["prompt", "escape"]); M.reader = reader;
      assert.equal(press("n", { target: TEXTAREA }).handled, false);
      assert.equal(press("Escape", { target: TEXTAREA }).handled, false);
      assert.deepEqual(reader.calls, []);
    });
    test("Cmd+0 the reader declines (PDF already at fit width) keeps its default: the browser resets its zoom", () => {
      app.setFocusOwner("reader");
      reader = runner(["zoomIn", "zoomOut"]); M.reader = reader;           // zoomFit → false: already fitted
      const second = press("0", { metaKey: true });
      assert.equal(second.handled, false);
      assert.equal(second.e.prevented, 0, "not preventDefault()-ed: the browser's own Cmd+0 runs");
      assert.deepEqual(reader.calls, ["zoomFit"]);
      assert.deepEqual(margin.calls, ["zoomFit"], "nobody else claims it");
      reader = runner(["zoomFit"]); M.reader = reader;                     // a manual zoom: the reader fits it
      const first = press("0", { metaKey: true });
      assert.equal(first.handled, true);
      assert.equal(first.e.prevented, 1);
      reader = runner(["zoomIn", "zoomOut"]); M.reader = reader;           // Cmd+= / Cmd+- stay with the reader
      assert.equal(press("=", { metaKey: true }).e.prevented, 1);
      assert.equal(press("-", { metaKey: true }).e.prevented, 1);
    });
    test("Mod+ bindings use Meta on macOS and reach the reader", () => {
      app.setFocusOwner("reader");
      reader = runner(["find", "zoomIn"]); M.reader = reader;
      assert.equal(press("f", { metaKey: true }).handled, true);
      assert.equal(press("=", { metaKey: true }).handled, true);
      assert.equal(press("f", { ctrlKey: true }).handled, false);
      assert.deepEqual(reader.calls, ["find", "zoomIn"]);
    });
    test("R / Shift+R / T are the app's review triggers with the open collection", async () => {
      app.setFocusOwner("reader");
      bus.emit("doc:opened", { collectionId: "book1" });
      cache.collection = (id) => (id === "book1" ? { id, kind: "book" } : null);
      assert.equal(press("r").handled, true);
      assert.equal(press("R", { shiftKey: true }).handled, true);
      assert.equal(press("t").handled, true);
      await Promise.resolve();
      assert.equal(review.start.calls.length, 3);
      const [book, all, today] = review.start.calls.map((c) => c[0]);
      assert.equal(book.scope, "book"); assert.equal(book.collectionId, "book1"); assert.equal(typeof book.now, "number");
      assert.equal(all.scope, "all"); assert.equal(all.collectionId, null);
      assert.equal(today.scope, "today"); assert.equal(today.collectionId, "book1");
      assert.deepEqual(snip.calls, ["reviewBook", "reviewAll", "reviewToday"], "modules are offered the action first");
      bus.emit("doc:closed", { collectionId: "book1" });
    });
    test("R without an open book is not handled", () => {
      app.setFocusOwner("reader");
      assert.equal(press("r").handled, false);
      assert.equal(review.start.calls.length, 0);
    });
    test("Escape runs snip → reader → margin and stops at the first handler", () => {
      app.setFocusOwner("reader");
      margin = runner(["escape"]); margin.activeEditor = () => null; M.margin = margin;
      const r = press("Escape");
      assert.equal(r.handled, true);
      assert.deepEqual(snip.calls, ["escape"]);
      assert.deepEqual(reader.calls, ["escape"]);
      assert.deepEqual(margin.calls, ["escape"]);
      snip = runner(["escape"]); M.snip = snip; reader.calls.length = 0; margin.calls.length = 0;
      assert.equal(press("Escape").handled, true);
      assert.deepEqual(reader.calls, []);
      assert.deepEqual(margin.calls, []);
    });
    test("Escape closes an open prompt list before the modules see it", () => {
      app.setFocusOwner("reader");
      list.isOpen = () => true;
      assert.equal(press("Escape").handled, true);
      assert.equal(list.close.calls.length, 1);
      assert.deepEqual(snip.calls, []);
    });
    test("a throwing module counts as not handled and the chain continues", () => {
      app.setFocusOwner("reader");
      const origError = console.error; console.error = () => {};
      try {
        reader = { run() { throw new Error("boom"); } }; M.reader = reader;
        margin = runner(["edit"]); margin.activeEditor = () => null; M.margin = margin;
        assert.equal(press("e").handled, true);
        assert.deepEqual(margin.calls, ["edit"]);
      } finally { console.error = origError; }
    });
    test("missing modules are skipped", () => {
      app.setFocusOwner("reader");
      delete M.snip; delete M.margin;
      reader = runner(["cloze"]); M.reader = reader;
      assert.equal(press("c").handled, true);
      assert.equal(press("j").handled, false);
    });
  });

  describe("editor owner", () => {
    test("EDITOR_MAP actions go to the margin's active editor", () => {
      app.setFocusOwner("editor");
      margin.activeEditor = () => editor;
      assert.equal(press("Enter", { metaKey: true, target: TEXTAREA }).handled, true);
      assert.equal(press("Enter", { metaKey: true, shiftKey: true, target: TEXTAREA }).handled, true);
      assert.equal(press("Escape", { target: TEXTAREA }).handled, true);
      assert.equal(press("C", { code: "KeyC", altKey: true, shiftKey: true, target: TEXTAREA }).handled, true);
      assert.deepEqual(editor.calls, ["save", "saveAnother", "cancel", "wrapCloze"]);
      assert.deepEqual(reader.calls, [], "reader keys never fire in the editor");
    });
    test("falls back to the library's batch editor; nothing without an editor", () => {
      app.setFocusOwner("editor");
      library.activeEditor = () => libEditor;
      assert.equal(press("Enter", { metaKey: true, target: TEXTAREA }).handled, true);
      assert.deepEqual(libEditor.calls, ["save"]);
      library.activeEditor = () => null;
      assert.equal(press("Enter", { metaKey: true, target: TEXTAREA }).handled, false);
    });
    test("plain reader letters typed in the textarea are left to the browser", () => {
      app.setFocusOwner("editor");
      margin.activeEditor = () => editor;
      const r = press("n", { target: TEXTAREA });
      assert.equal(r.handled, false);
      assert.deepEqual(editor.calls, []);
    });
    test("a key typed inside an .editor element is routed as editor even when the owner says otherwise", () => {
      app.setFocusOwner("card");
      library.activeEditor = () => libEditor;
      assert.equal(press("Enter", { metaKey: true, target: IN_EDITOR_TEXTAREA }).handled, true);
      assert.deepEqual(libEditor.calls, ["save"]);
      assert.deepEqual(reader.calls, []);
    });
    test("editor:opened / editor:closed keep the owner in step", async () => {
      app.setFocusOwner("reader");
      bus.emit("editor:opened", { promptId: null });
      assert.equal(app.focusOwner(), "editor");
      bus.emit("editor:closed", { promptId: null, saved: true });
      await new Promise((r) => setTimeout(r, 5));
      assert.equal(app.focusOwner(), "library", "no reader screen in node: the screen default");
    });
  });

  describe("review owner", () => {
    test("the Default preset maps onto M.review", () => {
      app.setFocusOwner("review");
      assert.equal(press(" ").handled, true);
      assert.equal(press("1").handled, true);
      assert.equal(press("2").handled, true);
      assert.equal(press("u").handled, true);
      assert.equal(press("s").handled, true);
      assert.equal(press("g").handled, true);
      assert.equal(press("Escape").handled, true);
      assert.equal(review.reveal.calls.length, 1);
      assert.deepEqual(review.grade.calls, [["forgot"], ["remembered"]]);
      assert.equal(review.undo.calls.length, 1);
      assert.equal(review.skip.calls.length, 1);
      assert.equal(review.goToSource.calls.length, 1);
      assert.equal(review.stop.calls.length, 1);
      assert.deepEqual(reader.calls, [], "reader actions never fire in review");
    });
    test("rebound keys from settings.reviewKeys win; the old key is dead; unbound stays unbound", () => {
      app.setFocusOwner("review");
      settings.set("reviewKeys", { showAnswer: "Space", forgot: "ArrowLeft", remembered: "ArrowRight", undo: "u", skip: null, goToSource: "g", exit: "q" });
      assert.equal(press("ArrowLeft").handled, true);
      assert.equal(press("1").handled, false);
      assert.equal(press("s").handled, false);
      assert.equal(press("q").handled, true);
      assert.equal(press("Escape").handled, false);
      assert.deepEqual(review.grade.calls, [["forgot"]]);
      assert.equal(review.stop.calls.length, 1);
      settings.set("reviewKeys", keys.PRESETS.Default);
    });
    test("F flags and Backspace deletes (FEATURES P1.3); a rebound or unbound key follows settings.reviewKeys", () => {
      app.setFocusOwner("review");
      assert.equal(press("f").handled, true);
      assert.equal(press("Backspace").handled, true);
      assert.equal(review.flag.calls.length, 1);
      assert.deepEqual(review.remove.calls, [[]]);
      assert.equal(press("Delete").handled, false, "only Backspace");
      settings.set("reviewKeys", Object.assign({}, keys.PRESETS.Default, { flag: "x", delete: null }));
      assert.equal(press("f").handled, false);
      assert.equal(press("Backspace").handled, false);
      assert.equal(press("x").handled, true);
      assert.equal(review.flag.calls.length, 2);
      assert.equal(review.remove.calls.length, 1);
      assert.deepEqual(reader.calls, [], "the reader's own F and Backspace never fire in review");
      settings.set("reviewKeys", keys.PRESETS.Default);
    });
    test("nothing fires inside a text field; repeats are swallowed", () => {
      app.setFocusOwner("review");
      assert.equal(press(" ", { target: TEXTAREA }).handled, false);
      const r = press(" ", { repeat: true });
      assert.equal(r.handled, true);
      assert.equal(review.reveal.calls.length, 0);
    });
  });

  describe("library / settings / list owners", () => {
    test("Shift+R and T start reviews; T reviews everywhere from the library", async () => {
      app.setFocusOwner("library");
      assert.equal(press("R", { shiftKey: true }).handled, true);
      assert.equal(press("t").handled, true);
      await Promise.resolve();
      assert.deepEqual(review.start.calls.map((c) => [c[0].scope, c[0].collectionId]), [["all", null], ["today", null]]);
    });
    test("reader-only keys do nothing on the home screen", () => {
      app.setFocusOwner("library");
      assert.equal(press("n").handled, false);
      assert.equal(press("j").handled, false);
      assert.equal(press("r").handled, false);
      assert.deepEqual(reader.calls, []);
      assert.equal(review.start.calls.length, 0);
    });
    test("Escape closes the list drawer for the list owner", () => {
      app.setFocusOwner("list");
      list.isOpen = () => true;
      assert.equal(press("Escape").handled, true);
      assert.equal(list.close.calls.length, 1);
      assert.equal(app.focusOwner(), "library");
    });
    test("Escape leaves the deck page's inline prompt list alone: #list (the reader's drawer) is hidden", () => {
      list.isOpen = () => true;                           // library.openDeck mounts M.list inline: open, not the drawer
      withDocument(["is-hidden"], () => {
        for (const owner of ["library", "list"]) {
          app.setFocusOwner(owner);
          const r = press("Escape");
          assert.equal(r.handled, false, owner);
          assert.equal(r.e.prevented, 0, owner);
        }
      });
      assert.equal(list.close.calls.length, 0);
    });
    test("with a document but no #list host an open list can only be inline: Escape leaves it", () => {
      list.isOpen = () => true;
      withDocument(null, () => { assert.equal(press("Escape").handled, false); });
      assert.equal(list.close.calls.length, 0);
    });
    test("Escape closes the reader's list drawer while #list is shown, before the reader modules see it", () => {
      list.isOpen = () => true;
      withDocument([], () => {
        app.setFocusOwner("list");
        assert.equal(press("Escape").handled, true);
        assert.equal(app.focusOwner(), "library");
        app.setFocusOwner("reader");
        assert.equal(press("Escape").handled, true);
      });
      assert.equal(list.close.calls.length, 2);
      assert.deepEqual(snip.calls, []);
    });
    test("Escape closes the settings panel for the settings owner (no #settings host: owner decides)", () => {
      app.setFocusOwner("settings");
      assert.equal(press("Escape").handled, true);
      assert.equal(library.closeSettings.calls.length, 1);
      assert.equal(app.focusOwner(), "library");
    });
    test("Escape with nothing open is not handled", () => {
      app.setFocusOwner("library");
      assert.equal(press("Escape").handled, false);
    });
    test("comma toggles settings", () => {
      app.setFocusOwner("library");
      assert.equal(press(",").handled, true);
      assert.equal(library.openSettings.calls.length, 1);
      app.setFocusOwner("settings");
      assert.equal(press(",").handled, true);
      assert.equal(library.closeSettings.calls.length, 1);
    });
    test("an unknown owner is routed like the library", () => {
      app.setFocusOwner("sheet");
      assert.equal(press("n").handled, false);
      assert.equal(press("R", { shiftKey: true }).handled, true);
    });
  });

  describe("startReview", () => {
    test("calls M.review.start with {scope, collectionId, now} and takes the review owner", async () => {
      await app.startReview("all", null);
      const arg = review.start.calls[0][0];
      assert.deepEqual(Object.keys(arg).sort(), ["collectionId", "now", "scope"]);
      assert.equal(arg.scope, "all");
      assert.equal(arg.collectionId, null);
      assert.ok(Math.abs(arg.now - Date.now()) < 2000);
      assert.equal(app.focusOwner(), "review");
    });
    test("corrects the scope from the collection kind", async () => {
      cache.collection = (id) => ({ id, kind: id.startsWith("deck") ? "deck" : "book" });
      await app.startReview("book", "deck_1");
      await app.startReview("deck", "book_1");
      assert.deepEqual(review.start.calls.map((c) => [c[0].scope, c[0].collectionId]), [["deck", "deck_1"], ["book", "book_1"]]);
    });
    test("rejects a collection scope without a collection; a failing start toasts instead of throwing", async () => {
      await assert.rejects(app.startReview("book", null), (e) => e.code === "no_collection");
      const origError = console.error; console.error = () => {};
      const toasts = [];
      const origToast = app.toast; app.toast = (o) => { toasts.push(o); return { close() {} }; };
      try {
        review.start = () => Promise.reject(new Error("Nothing due"));
        assert.equal(await app.startReview("all", null), null);
        assert.equal(toasts.length, 1);
        assert.equal(toasts[0].text, "Nothing due");
      } finally { app.toast = origToast; console.error = origError; }
    });
    test("does not take the review owner when the session did not open", async () => {
      app.setFocusOwner("library");
      review.isActive = () => false;
      await app.startReview("all", null);
      assert.equal(app.focusOwner(), "library");
    });
    test("a folder (FEATURES L1.5): scope \"folder\" with the folder's id reaches M.review as it is; no id is refused", async () => {
      await app.startReview("folder", "folder_1");
      assert.deepEqual(review.start.calls.map((c) => [c[0].scope, c[0].collectionId]), [["folder", "folder_1"]]);
      await assert.rejects(app.startReview("folder", null), (e) => e.code === "no_collection");
      assert.equal(review.start.calls.length, 1);
    });
  });

  describe("events", () => {
    test("review:gotoSource routes to the reader with the prompt's book and promptId", () => {
      const routes = [];
      const origRoute = app.route; app.route = (s, p) => { routes.push([s, p]); return Promise.resolve(true); };
      try {
        cache.prompt = (id) => (id === "p1" ? { id, collectionId: "book1" } : null);
        cache.collection = (id) => (id === "book1" ? { id, kind: "book", hasBytes: true } : null);
        bus.emit("review:gotoSource", { promptId: "p1" });
        assert.deepEqual(routes, [["reader", { collectionId: "book1", promptId: "p1" }]]);
      } finally { app.route = origRoute; }
    });
    test("review:gotoSource toasts instead of routing for decks, missing books and books without bytes", () => {
      const routes = [], toasts = [];
      const origRoute = app.route, origToast = app.toast;
      app.route = (s, p) => { routes.push([s, p]); return Promise.resolve(true); };
      app.toast = (o) => { toasts.push(o.text); return { close() {} }; };
      try {
        cache.prompt = (id) => ({ p1: { id, collectionId: "deck1" }, p2: { id, collectionId: "gone" }, p3: { id, collectionId: "nobytes" } }[id] || null);
        cache.collection = (id) => ({ deck1: { id, kind: "deck" }, nobytes: { id, kind: "book", hasBytes: false } }[id] || null);
        bus.emit("review:gotoSource", { promptId: "p1" });
        bus.emit("review:gotoSource", { promptId: "p2" });
        bus.emit("review:gotoSource", { promptId: "p3" });
        bus.emit("review:gotoSource", { promptId: "nope" });
        assert.deepEqual(routes, []);
        assert.equal(toasts.length, 4);
        assert.match(toasts[2], /PDF not in library/);
      } finally { app.route = origRoute; app.toast = origToast; }
    });
    test("route to the reader with a promptId hands it to M.reader.open (#reader/<cid>/<pid>, BUILD-NOTES \"Obsidian\")", async () => {
      cache.collection = (id) => (id === "b1" ? { id, kind: "book" } : null);
      reader.open = spy(Promise.resolve()); reader.close = spy(Promise.resolve());
      const p = withDocument(["is-hidden"], () => app.route("reader", { collectionId: "b1", promptId: "p_1" }));
      assert.deepEqual(reader.open.calls, [["b1", { promptId: "p_1" }]]);
      assert.equal(await p, true);
      assert.deepEqual(app.current(), { screen: "reader", collectionId: "b1", promptId: "p_1" });
      await withDocument(["is-hidden"], () => app.route("library", {}));
      assert.equal(reader.close.calls.length, 1);
    });
    test("D27 the statistics page: route(\"stats\") opens M.stats without a collection, leaving closes it, Esc goes back to the library", async () => {
      const stats = { open: spy(true), close: spy(true), isOpen: () => true };
      M.stats = stats;
      try {
        cache.collection = () => null;                    // no collection is looked up for it
        assert.equal(await withDocument(["is-hidden"], () => app.route("stats", { collectionId: "b1", promptId: "p_1" })), true);
        assert.equal(stats.open.calls.length, 1);
        assert.deepEqual(app.current(), { screen: "stats", collectionId: null, promptId: null }, "the collection and the prompt are dropped");
        assert.equal(app.focusOwner(), "library", "the library's keys stay");
        assert.equal(library.render.calls.length, 0);
        assert.equal(stats.close.calls.length, 0);
        // Esc with the settings panel open closes the panel first; the page stays
        app.setFocusOwner("settings");
        const rs = withDocument(["is-hidden"], () => press("Escape"));
        assert.equal(rs.handled, true);
        assert.equal(library.closeSettings.calls.length, 1, "the settings panel took the Escape");
        assert.equal(app.current().screen, "stats");
        assert.equal(stats.close.calls.length, 0);
        app.setFocusOwner("library");
        // Esc: back to the library (the page is closed, the library is drawn)
        const r = withDocument(["is-hidden"], () => press("Escape"));
        assert.equal(r.handled, true);
        await Promise.resolve();
        assert.equal(app.current().screen, "library");
        assert.equal(stats.close.calls.length, 1);
        assert.equal(library.render.calls.length, 1);
        // to the page again, then on to a deck: closed again
        await withDocument(["is-hidden"], () => app.route("stats"));
        assert.equal(stats.open.calls.length, 2);
        cache.collection = (id) => (id === "d1" ? { id, kind: "deck" } : null);
        await withDocument(["is-hidden"], () => app.route("deck", { collectionId: "d1" }));
        assert.equal(stats.close.calls.length, 2);
        assert.equal(app.current().screen, "deck");
        // Esc elsewhere does not go to the library by this rule
        const r2 = withDocument(["is-hidden"], () => press("Escape"));
        assert.equal(app.current().screen, "deck", String(r2.handled));
        await withDocument(["is-hidden"], () => app.route("library", {}));
      } finally { delete M.stats; }
    });
    test("review:ended returns the owner to the screen; review:resumed takes it back", () => {
      app.setFocusOwner("review");
      bus.emit("review:ended", { summary: {} });
      assert.equal(app.focusOwner(), "library");
      bus.emit("review:resumed", { remaining: 3 });
      assert.equal(app.focusOwner(), "review");
      app.setFocusOwner("library");
      bus.emit("review:ended", { summary: {} });
      assert.equal(app.focusOwner(), "library");
    });
    test("settings:changed theme is applied without throwing when there is no document", () => {
      assert.doesNotThrow(() => bus.emit("settings:changed", { key: "theme", value: "dark" }));
      settings.set("theme", "system");
    });
  });

  describe("global errors", () => {
    test("one toast per burst, ResizeObserver noise ignored", async () => {
      const toasts = [];
      const origToast = app.toast; app.toast = (o) => { toasts.push(o); return { close() {} }; };
      try {
        await new Promise((r) => setTimeout(r, 5));
        assert.equal(app.handleError("ResizeObserver loop completed with undelivered notifications"), false);
        assert.equal(toasts.length, 0);
        assert.equal(app.handleError("boom"), true);
        assert.equal(app.handleError("boom again"), false);
        assert.equal(toasts.length, 1);
        assert.equal(toasts[0].id, "app-error");
        assert.equal(toasts[0].text, "Something went wrong — see the console");
      } finally { app.toast = origToast; }
    });
  });
});

// ---- the real modules in the fake window of tools/smoke.js ------------------------------------------------------
// Regression: library.openDeck mounts M.list INLINE on the deck page, a permanent section (SPEC §14). An Escape
// that reached the document there (focus on body or on a deck-page button) ran M.list.close() through the Escape
// chain and emptied it for good; it must leave it alone, while the reader's #list drawer still closes.
// tools/smoke.js calls main() when it loads, so its fake-window builder is compiled here without that last call
// (nothing is written to disk). M.editor cannot run in that fake DOM, so prompts are saved the way
// library.saveBatch saves one block (same shape, same M.cache.savePrompt → prompt:saved).

function loadSmokeHarness() {
  const file = path.join(__dirname, "..", "tools", "smoke.js");
  const src = fs.readFileSync(file, "utf8").replace(/^#!.*\n/, "");
  assert.match(src, /\nmain\(\);\s*$/, "tools/smoke.js no longer ends with main(); update loadSmokeHarness()");
  const body = src.replace(/\nmain\(\);\s*$/, "\nreturn { makeWindow: makeWindow, ORDER: ORDER };\n");
  const factory = vm.runInThisContext("(function (require, process, __dirname, __filename) {" + body + "\n})", { filename: file });
  return factory(require, process, path.dirname(file), file);
}

describe("app Escape chain with the real modules (fake DOM of tools/smoke.js)", () => {
  let W, R, doc, deck, logs;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const unref = (t) => { if (t && typeof t.unref === "function") t.unref(); return t; };
  const drawerHidden = () => doc.getElementById("list").classList.contains("is-hidden");
  function elements(rootEl, pred) {
    const out = [];
    (function walk(n) { (n.childNodes || []).forEach((c) => { if (c.nodeType === 1) { if (pred(c)) out.push(c); walk(c); } }); })(rootEl);
    return out;
  }
  const deckRowIds = () => elements(doc.getElementById("deck"), (el) => el.getAttribute("role") === "option").map((el) => el.getAttribute("data-id"));
  // A keydown that bubbles from its target through the ancestors to the document, as in the browser.
  function fire(key, target) {
    const e = { type: "keydown", key, code: "", keyCode: 0, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false,
      repeat: false, isComposing: false, defaultPrevented: false, target, stopped: false };
    e.preventDefault = () => { e.defaultPrevented = true; };
    e.stopPropagation = () => { e.stopped = true; };
    e.stopImmediatePropagation = e.stopPropagation;
    for (let n = target; n && !e.stopped; n = n.parentNode) if (typeof n.dispatchEvent === "function") n.dispatchEvent(e);
    if (!e.stopped) doc.dispatchEvent(e);
    return e;
  }
  async function addPrompt(text) {
    const b = R.prompts.parseBatch(text)[0], t = Date.now();
    const saved = await R.cache.savePrompt({
      collectionId: deck.id, kind: b.parsed.kind, text: b.text, tags: b.parsed.tags.slice(), flagged: false, anchor: null,
      context: { docName: deck.name || "", sectionLabel: b.section || null, pageIndex: null, pageLabel: null },
      cards: R.prompts.reconcileCards(null, b.parsed, t).cards, createdAt: t, deletedAt: null, v: 1
    }, { content: true });
    await wait(10);
    return saved.id;
  }
  async function openDeckPage() {
    assert.equal(await R.app.route("deck", { collectionId: deck.id }), true);
    await wait(10);
    assert.equal(R.app.current().screen, "deck");
    assert.equal(R.app.focusOwner(), "library");
    assert.equal(R.list.isOpen(), true, "the deck page mounts its prompt list");
    assert.equal(drawerHidden(), true, "the reader's drawer stays hidden on the deck page");
  }

  before(async () => {
    const H = loadSmokeHarness();
    W = H.makeWindow();
    logs = [];
    W.setTimeout = (fn, ms, ...a) => unref(setTimeout(fn, ms, ...a));   // library.js keeps a 60-s interval running
    W.setInterval = (fn, ms, ...a) => unref(setInterval(fn, ms, ...a));
    W.requestAnimationFrame = (fn) => W.setTimeout(() => fn(Date.now()), 0);
    W.requestIdleCallback = (fn) => W.setTimeout(() => fn({ timeRemaining: () => 50, didTimeout: false }), 0);
    W.console = { log() {}, info() {}, debug() {}, warn: (...a) => logs.push(a.join(" ")), error: (...a) => logs.push(a.join(" ")) };
    const ctx = vm.createContext(W);
    for (const name of H.ORDER) {
      vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "js", name + ".js"), "utf8"), ctx, { filename: "js/" + name + ".js" });
    }
    R = W.Marginalia; doc = W.document;
    assert.equal(await R.app.boot(), true, "boot\n" + logs.join("\n"));
    deck = await R.library.createDeck("Escape deck");
    await addPrompt("Q. What is 2+2?\nA. 4");
  });

  test("Escape with focus on the page body leaves the deck's prompt list in place", async () => {
    await openDeckPage();
    const rows = deckRowIds();
    assert.equal(rows.length, 1);
    doc.activeElement = doc.body;
    const e = fire("Escape", doc.body);
    assert.equal(e.defaultPrevented, false, "nothing on the deck page answers Escape");
    assert.equal(R.list.isOpen(), true);
    assert.deepEqual(deckRowIds(), rows);
  });
  test("Escape with focus on a deck header button leaves it too, and prompts saved afterwards are listed", async () => {
    await openDeckPage();
    const header = elements(doc.getElementById("deck"), (el) => el.tagName === "HEADER")[0];
    const button = header && elements(header, (el) => el.tagName === "BUTTON")[0];
    assert.ok(button, "the deck page has a header button ('‹ Library')");
    button.focus();
    const e = fire("Escape", button);
    assert.equal(e.defaultPrevented, false);
    assert.equal(R.list.isOpen(), true);
    const id = await addPrompt("Q. Capital of France?\nA. Paris");
    assert.equal(deckRowIds().length, 2);
    assert.ok(deckRowIds().includes(id), "the prompt saved after Escape appears in the deck's list");
  });
  test("Escape that reaches the document still closes the reader's prompt-list drawer", async () => {
    assert.equal(await R.app.route("library", {}), true);
    assert.equal(R.list.open(deck.id), true);              // no host: the #list drawer
    assert.equal(drawerHidden(), false);
    doc.activeElement = doc.body;
    const e = fire("Escape", doc.body);
    assert.equal(e.defaultPrevented, true);
    assert.equal(R.list.isOpen(), false);
    assert.equal(drawerHidden(), true);
  });
  test("FEATURES P1.3: the ? sheet names flag and delete; F, Backspace and U in review work on the real cache", async () => {
    assert.equal(await R.app.route("library", {}), true);
    assert.equal(R.app.openShortcuts(), true);
    const sheet = doc.getElementById("shortcuts");
    const sections = elements(sheet, (el) => el.tagName === "SECTION");
    const sectionOf = (title) => sections.find((sec) => elements(sec, (el) => el.tagName === "H3")[0].textContent === title);
    const labels = (sec) => elements(sec, (el) => (" " + el.className + " ").includes(" sc-label "));
    const capsOf = (sec, label) => {
      const l = labels(sec).find((x) => x.textContent === label);
      return l ? elements(l.parentNode, (el) => el.tagName === "KBD").map((k) => k.textContent).join(" ") : null;
    };
    assert.equal(capsOf(sectionOf("Review"), "Flag for revision"), "F");
    assert.equal(capsOf(sectionOf("Review"), "Delete prompt"), "⌫");
    assert.ok(labels(sectionOf("Reader")).some((l) => l.textContent === "Flag card"), "the reader's own label stays");
    R.app.closeShortcuts();

    logs.length = 0;
    await R.app.startReview("today", null);
    // this fake DOM keeps innerHTML as text, so the overlay cannot mount here (M.app reports that); the session, the
    // key routing and the real cache are what this test checks; the card itself is checked in review-dom.test.js
    const host = doc.getElementById("review");
    const first = R.review.current();
    assert.ok(first, "a card of today's prompts");
    const id = first.prompt.id, stamp = first.prompt.contentUpdatedAt;
    await wait(5);
    fire("f", host);
    assert.equal(R.cache.prompt(id).flagged, true);
    assert.ok(R.cache.prompt(id).contentUpdatedAt > stamp, "a content save, as the reader's F");
    const total = first.total;
    fire("Backspace", host);
    assert.ok(R.cache.prompt(id).deletedAt, "deleted at once, no confirm");
    assert.notEqual(R.review.current() && R.review.current().prompt.id, id);
    fire("u", host);
    assert.equal(R.cache.prompt(id).deletedAt, null, "U restores it");
    assert.equal(R.review.current().prompt.id, id);
    assert.equal(R.review.current().total, total);
    fire("Escape", host);
    assert.equal(R.review.isActive(), false);
    await wait(10);
    logs.length = 0;
  });
  test("DECISIONS D32: the Obsidian connection is off in a new library, on once it is chosen or once a card was sent; the ? sheet follows", async () => {
    assert.equal(await R.app.route("library", {}), true);
    const sheetHasO = () => {
      assert.equal(R.app.openShortcuts(), true);
      // this fake DOM keeps the panels of earlier opens (textContent = "" clears nothing here): read the newest one
      const panels = elements(doc.getElementById("shortcuts"), (el) => (" " + el.className + " ").includes(" sheet "));
      const labels = elements(panels[panels.length - 1], (el) => (" " + el.className + " ").includes(" sc-label ")).map((l) => l.textContent);
      const has = labels.some((l) => /^Note → Obsidian/.test(l));
      assert.ok(labels.includes("Highlight only"), "the reader's other rows are there");
      R.app.closeShortcuts();
      return has;
    };
    try {
      assert.equal(R.settings.get("obsidian"), null, "never chosen");
      assert.ok(!R.cache.prompts().some((p) => p.obsidianSentAt || p.obsidianPendingFile), "this library never sent a card");
      assert.equal(R.obsidian.enabled(), false, "a new library: off");
      assert.equal(sheetHasO(), false, "no row for O");
      const one = await R.obsidian.send(R.cache.prompts()[0].id, { fromGesture: true });
      assert.equal(one.error, R.obsidian.OFF);
      // chosen: on
      assert.equal(R.settings.set("obsidian", true), true);
      assert.equal(R.obsidian.enabled(), true);
      assert.equal(sheetHasO(), true);
      // chosen: off, also once a card holds a send record
      assert.equal(R.settings.set("obsidian", false), true);
      const id = await addPrompt("Q. Was this card sent before?\nA. Yes");
      assert.equal(await R.cache.patchPrompts([{ id, fields: { obsidianSentAt: Date.now(), obsidianFile: "Notes/Marginalia/Escape deck.md" } }]), 1);
      assert.equal(R.obsidian.enabled(), false, "the choice wins");
      assert.equal(sheetHasO(), false);
      // never chosen (a library from before the switch): its send record keeps the connection on
      assert.equal(R.settings.set("obsidian", null), true);
      assert.equal(R.obsidian.enabled(), true);
      assert.equal(sheetHasO(), true);
      // the record gone again: off again
      assert.equal(await R.cache.patchPrompts([{ id, fields: { obsidianSentAt: undefined, obsidianFile: undefined } }]), 1);
      assert.equal(R.obsidian.enabled(), false);
      assert.equal(sheetHasO(), false);
    } finally {
      R.settings.set("obsidian", null);
    }
    logs.length = 0;
  });
});

// ---- "Open in Marginalia" links (BUILD-NOTES "Obsidian"): #reader/<collectionId>/<promptId> with the real modules ----
// The link opens the book at the passage and focuses the card: M.app parses the hash at boot and on hashchange and
// routes to the reader with that promptId (M.reader.open is the recording stub here; its navigation is the same one
// review's "Go to source" uses).
describe("prompt links #reader/<collectionId>/<promptId> (real modules, fake DOM of tools/smoke.js)", () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const unref = (t) => { if (t && typeof t.unref === "function") t.unref(); return t; };
  function load(hash) {
    const H = loadSmokeHarness(), W = H.makeWindow(), logs = [];
    W.setTimeout = (fn, ms, ...a) => unref(setTimeout(fn, ms, ...a));
    W.setInterval = (fn, ms, ...a) => unref(setInterval(fn, ms, ...a));
    W.requestAnimationFrame = (fn) => W.setTimeout(() => fn(Date.now()), 0);
    W.requestIdleCallback = (fn) => W.setTimeout(() => fn({ timeRemaining: () => 50, didTimeout: false }), 0);
    W.console = { log() {}, info() {}, debug() {}, warn: (...a) => logs.push(a.join(" ")), error: (...a) => logs.push(a.join(" ")) };
    W.location.hash = hash || "";
    const ctx = vm.createContext(W);
    for (const name of H.ORDER) vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "js", name + ".js"), "utf8"), ctx, { filename: "js/" + name + ".js" });
    const R = W.Marginalia, opens = [];
    R.reader.open = (cid, opts) => { opens.push([cid, Object.assign({}, opts)]); return Promise.resolve(); };
    return { W, R, opens, logs };
  }
  const BOOK = { id: "92b1cb87", kind: "book", name: "Griffiths", sections: [], hasBytes: true, deletedAt: null };

  test("boot with the link's hash opens the reader at that prompt", async () => {
    const { R, opens, logs } = load("#reader/92b1cb87/p_link");
    const realCollection = R.cache.collection;
    R.cache.collection = (id) => (id === BOOK.id ? BOOK : realCollection(id));   // the book is in this browser's library
    assert.equal(await R.app.boot(), true, logs.join("\n"));
    assert.deepEqual(opens, [["92b1cb87", { promptId: "p_link" }]]);
    assert.deepEqual(Object.assign({}, R.app.current()), { screen: "reader", collectionId: "92b1cb87", promptId: "p_link" });
  });

  test("a hashchange to a prompt link navigates, even with its book open already", async () => {
    const { W, R, opens, logs } = load("");
    assert.equal(await R.app.boot(), true, logs.join("\n"));
    await R.cache.saveCollection(Object.assign({}, BOOK));
    W.location.hash = "#reader/92b1cb87/p_a";
    W.dispatchEvent({ type: "hashchange" });
    await wait(5);
    assert.deepEqual(opens, [["92b1cb87", { promptId: "p_a" }]]);
    W.location.hash = "#reader/92b1cb87/p_b";                 // same book: still a navigation to the new prompt
    W.dispatchEvent({ type: "hashchange" });
    await wait(5);
    assert.deepEqual(opens[1], ["92b1cb87", { promptId: "p_b" }]);
    W.location.hash = "#reader/92b1cb87";                      // the plain book hash of the open book: nothing to do
    W.dispatchEvent({ type: "hashchange" });
    await wait(5);
    assert.equal(opens.length, 2);
  });
});

// ---- the daily backup (BUILD-NOTES "Automatic backup"): boot starts M.backup once the store is open -----------------
// M.app's boot calls M.backup.start() after store.open and cache.load (and the first route), once, without waiting for
// it, and not in a tab that stepped aside. The real M.backup decides the rest: in the smoke window's memory mode it
// never asks anything. W.fetch is a stub in every test here: nothing reaches a server. The smoke window is a browser page
// on localhost, so boot's first request is the app check of FEATURES E2.2 (M.desktop: GET /api/app, which these stubs
// answer with something other than {ok: true, app: true}, so the page stays as before), and M.backup's come after it.
describe("boot starts M.backup (real modules, fake DOM of tools/smoke.js)", () => {
  const unref = (t) => { if (t && typeof t.unref === "function") t.unref(); return t; };
  const APP_CHECK = { url: "/api/app", method: "GET", headers: { "X-Marginalia": "1" } };
  function load(answer) {
    const H = loadSmokeHarness(), W = H.makeWindow(), logs = [], fetched = [];
    W.setTimeout = (fn, ms, ...a) => unref(setTimeout(fn, ms, ...a));
    W.setInterval = (fn, ms, ...a) => unref(setInterval(fn, ms, ...a));
    W.requestAnimationFrame = (fn) => W.setTimeout(() => fn(Date.now()), 0);
    W.requestIdleCallback = (fn) => W.setTimeout(() => fn({ timeRemaining: () => 50, didTimeout: false }), 0);
    W.console = { log() {}, info() {}, debug() {}, warn: (...a) => logs.push(a.join(" ")), error: (...a) => logs.push(a.join(" ")) };
    W.fetch = (url, init) => {
      fetched.push({ url: String(url), method: (init && init.method) || "GET", headers: Object.assign({}, init && init.headers) });
      return answer ? Promise.resolve(answer(url, init)) : Promise.reject(new TypeError("no server in this test"));
    };
    const ctx = vm.createContext(W);
    for (const name of H.ORDER) vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "js", name + ".js"), "utf8"), ctx, { filename: "js/" + name + ".js" });
    return { W, R: W.Marginalia, logs, fetched };
  }

  test("once, after store.open and cache.load, and boot does not wait for it", async () => {
    const { R, logs } = load();
    const calls = [];
    const open = R.store.open, loadCache = R.cache.load;
    R.store.open = function () { calls.push("store.open"); return open.apply(this, arguments).then((r) => { calls.push("store open"); return r; }); };
    R.cache.load = function () { calls.push("cache.load"); return loadCache.apply(this, arguments).then((r) => { calls.push("library loaded"); return r; }); };
    R.backup.start = function () { calls.push("backup.start"); return new Promise(() => {}); };   // never settles
    assert.equal(await R.app.boot(), true, logs.join("\n"));
    assert.ok(calls.indexOf("store open") >= 0 && calls.indexOf("library loaded") >= 0, calls.join(", "));
    assert.equal(calls[calls.length - 1], "backup.start", "last: after the store opened and the library loaded (" + calls.join(", ") + ")");
    assert.equal(await R.app.boot(), true, "boot() again is the same boot");
    assert.equal(calls.filter((c) => c === "backup.start").length, 1);
  });

  test("not in a tab that stepped aside for a newer tab", async () => {
    const { R, logs } = load();
    let started = 0;
    R.store.locked = () => ({ reason: "othertab", by: "tab_b", at: 1 });
    R.backup.start = () => { started++; return Promise.resolve(); };
    await R.app.boot();
    assert.equal(started, 0, logs.join("\n"));
  });

  test("in the store's memory mode the real M.backup asks nothing and says why", async () => {
    const { R, logs, fetched } = load();
    assert.equal(await R.app.boot(), true, logs.join("\n"));
    assert.equal(R.store.mode(), "memory");
    const s = R.backup.state();
    assert.deepEqual([s.status, s.reason], ["unavailable", "memory"]);
    assert.deepEqual(fetched, [APP_CHECK], "only the app check (FEATURES E2.2): M.backup asked nothing");
  });

  test("with the store in IndexedDB on Marginalia's server it asks GET /api/backup (an empty library is not backed up)", async () => {
    const answer = () => ({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, dir: "~/Documents/Marginalia Backups", today: "2026-11-09", files: [] }) });
    const { R, logs, fetched } = load(answer);
    R.store.mode = () => "idb";                                // the smoke window has no IndexedDB; M.backup asks the store's mode
    assert.equal(await R.app.boot(), true, logs.join("\n"));
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    assert.deepEqual(fetched, [APP_CHECK, { url: "/api/backup", method: "GET", headers: { "X-Marginalia": "1" } }]);
    const s = R.backup.state();
    assert.deepEqual([s.status, s.dir, s.today, s.last], ["on", "~/Documents/Marginalia Backups", "2026-11-09", null]);
  });
});

// ---- DECISIONS D33: Cmd+Z and Shift+Cmd+Z (M.keys.UNDO_MAP) → M.undo -----------------------------------------------
describe("undo and redo keys (DECISIONS D33)", () => {
  let undo;
  const BUTTON_IN_EDITOR = { tagName: "BUTTON", closest: (sel) => (sel === ".editor" ? { tagName: "DIV" } : null) };
  // a document in which a dialog of another module is up (or not): what dialogOpen() asks
  function withDialog(open, fn) {
    const had = Object.prototype.hasOwnProperty.call(globalThis, "document"), prev = globalThis.document;
    globalThis.document = { body: { tagName: "BODY" }, getElementById: () => null, querySelector: (sel) => (open && sel === ".dialog" ? { tagName: "DIV" } : null) };
    try { return fn(); } finally { if (had) globalThis.document = prev; else delete globalThis.document; }
  }
  before(() => { keys.setPlatform("mac"); });
  after(() => { keys.setPlatform(null); delete M.undo; });
  beforeEach(() => {
    installStubs();
    undo = { calls: [], run(id) { undo.calls.push(id); return true; } };
    M.undo = undo;
    app.setFocusOwner("reader");
  });

  test("outside a text field Cmd+Z runs undo and Shift+Cmd+Z runs redo: in the reader, on a card, in the list, in the library", () => {
    for (const owner of ["reader", "card", "list", "library"]) {
      app.setFocusOwner(owner);
      undo.calls.length = 0;
      const z = press("z", { metaKey: true });
      assert.equal(z.handled, true, owner);
      assert.equal(z.e.prevented, 1, owner);
      const y = press("Z", { metaKey: true, shiftKey: true });
      assert.equal(y.handled, true, owner);
      assert.equal(y.e.prevented, 1, owner);
      assert.deepEqual(undo.calls, ["undo", "redo"], owner);
    }
    assert.deepEqual(snip.calls.concat(reader.calls, margin.calls), [], "no command of the reader ran");
    assert.equal(review.undo.calls.length, 0);
  });

  test("in a text field the keys stay the text's own undo and redo", () => {
    for (const target of [TEXTAREA, IN_EDITOR_TEXTAREA]) {
      const z = press("z", { metaKey: true, target });
      assert.equal(z.handled, false);
      assert.equal(z.e.prevented, 0);
      const y = press("Z", { metaKey: true, shiftKey: true, target });
      assert.equal(y.handled, false);
      assert.equal(y.e.prevented, 0);
    }
    assert.deepEqual(undo.calls, []);
  });

  test("in the settings and with a dialog up the keys are left alone", () => {
    const left = (what, opts) => {
      for (const k of [["z", {}], ["Z", { shiftKey: true }]]) {
        const r = press(k[0], Object.assign({ metaKey: true }, k[1], opts));
        assert.equal(r.handled, false, what);
        assert.equal(r.e.prevented, 0, what);
      }
    };
    app.setFocusOwner("settings");
    left("the settings are open");
    app.setFocusOwner("library");
    withDialog(true, () => left("a dialog is up"));
    assert.deepEqual(undo.calls, []);
    withDialog(false, () => assert.equal(press("z", { metaKey: true }).handled, true));
    assert.deepEqual(undo.calls, ["undo"]);
    // the settings sheet is on screen while another owner has the focus (a click on the page behind it)
    const had = Object.prototype.hasOwnProperty.call(globalThis, "document"), prev = globalThis.document;
    const sheet = { classList: { contains: () => false } };
    globalThis.document = { body: { tagName: "BODY" }, getElementById: (id) => (id === "settings" ? sheet : null), querySelector: () => null };
    try { left("the settings sheet is shown"); } finally { if (had) globalThis.document = prev; else delete globalThis.document; }
    assert.deepEqual(undo.calls, ["undo"]);
  });

  test("an open editor keeps the keys only in its text field: on one of its buttons, or with the focus elsewhere, they run M.undo", () => {
    app.setFocusOwner("editor");                            // the editor owns the focus, the key comes from a plain element
    assert.equal(press("z", { metaKey: true }).handled, true);
    app.setFocusOwner("reader");                            // the deck page's add box: the focus is on its "Add prompts" button
    const onButton = press("Z", { metaKey: true, shiftKey: true, target: BUTTON_IN_EDITOR });
    assert.equal(onButton.handled, true);
    assert.equal(onButton.e.prevented, 1);
    assert.deepEqual(undo.calls, ["undo", "redo"], "M.undo itself leaves a card alone that an editor holds");
    assert.deepEqual(editor.calls, [], "no command of the editor ran");
    app.setFocusOwner("editor");
    assert.equal(press("z", { metaKey: true, target: IN_EDITOR_TEXTAREA }).handled, false, "in its text field: the text's own undo");
    assert.deepEqual(undo.calls, ["undo", "redo"]);
  });

  test("in a review Cmd+Z is the review's own undo (U), and Shift+Cmd+Z does nothing", () => {
    app.setFocusOwner("review");
    const z = press("z", { metaKey: true });
    assert.equal(z.handled, true);
    assert.equal(z.e.prevented, 1);
    assert.equal(review.undo.calls.length, 1);
    const y = press("Z", { metaKey: true, shiftKey: true });
    assert.equal(y.handled, true);
    assert.equal(y.e.prevented, 1, "the key is not passed on");
    assert.equal(review.undo.calls.length, 1);
    assert.deepEqual(undo.calls, []);
  });

  test("a held key acts once: the repeats are taken and do nothing", () => {
    assert.equal(press("z", { metaKey: true }).handled, true);
    for (let i = 0; i < 3; i++) {
      const r = press("z", { metaKey: true, repeat: true });
      assert.equal(r.handled, true);
      assert.equal(r.e.prevented, 1);
    }
    assert.deepEqual(undo.calls, ["undo"]);
    app.setFocusOwner("review");
    press("z", { metaKey: true, repeat: true });
    assert.equal(review.undo.calls.length, 0);
  });

  test("plain Z and U keep their work; a page without js/undo.js takes the keys and does nothing", () => {
    margin.run = function (id) { margin.calls.push(id); return id === "undoDelete"; };
    assert.equal(press("z").handled, true);
    assert.deepEqual(margin.calls, ["undoDelete"]);
    assert.deepEqual(undo.calls, []);
    delete M.undo;
    const z = press("z", { metaKey: true });
    assert.equal(z.handled, true);
    assert.equal(z.e.prevented, 1);
  });

  test("a failing M.undo.run does not break the key listener", () => {
    M.undo = { run() { throw new Error("boom"); } };
    const errors = [], real = console.error;
    console.error = (...a) => errors.push(a.join(" "));
    try { assert.equal(press("z", { metaKey: true }).handled, true); } finally { console.error = real; }
    assert.equal(errors.length, 1);
    assert.match(errors[0], /undo\.run\(undo\)/);
  });
});
