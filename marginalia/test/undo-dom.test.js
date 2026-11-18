"use strict";
// test/undo-dom.test.js — DECISIONS D33 (BUILD-NOTES "Undo and redo") with the 31 real modules in the fake window of
// tools/smoke.js (memory store): the keys reach M.undo through M.app's one keydown listener, the deck page's "Add" is
// one step, the notice has the button that goes the other way, the ? sheet names the keys, and a picture that an
// edit took out of a card stays in the store while a step can bring its text back.
// tools/smoke.js calls main() when it loads, so its fake-window builder is compiled here without that last call, as
// test/app.test.js does. M.editor cannot run in that fake DOM: its create() is replaced, and the test calls the
// onSave that the page gave it. Run: node --test test/undo-dom.test.js
const { test, describe, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadSmokeHarness() {
  const file = path.join(__dirname, "..", "tools", "smoke.js");
  const src = fs.readFileSync(file, "utf8").replace(/^#!.*\n/, "");
  assert.match(src, /\nmain\(\);\s*$/, "tools/smoke.js no longer ends with main(); update loadSmokeHarness()");
  const body = src.replace(/\nmain\(\);\s*$/, "\nreturn { makeWindow: makeWindow, ORDER: ORDER };\n");
  const factory = vm.runInThisContext("(function (require, process, __dirname, __filename) {" + body + "\n})", { filename: file });
  return factory(require, process, path.dirname(file), file);
}

describe("undo and redo with the real modules (fake DOM of tools/smoke.js)", () => {
  let W, R, doc, deck, logs;
  const made = [];                                          // what the pages asked M.editor.create for
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const unref = (t) => { if (t && typeof t.unref === "function") t.unref(); return t; };
  function elements(rootEl, pred) {
    const out = [];
    (function walk(n) { (n.childNodes || []).forEach((c) => { if (c.nodeType === 1) { if (pred(c)) out.push(c); walk(c); } }); })(rootEl);
    return out;
  }
  const hasClass = (name) => (el) => (" " + (el.className || "") + " ").indexOf(" " + name + " ") >= 0;
  const deckRowIds = () => elements(doc.getElementById("deck"), (el) => el.getAttribute("role") === "option").map((el) => el.getAttribute("data-id"));
  const toastTexts = () => elements(doc.getElementById("toasts"), hasClass("toast__text")).map((n) => n.textContent);
  // a button's label is a text node in this fake DOM (an element's own textContent holds only what was set on it)
  const labelOf = (el) => (el.childNodes || []).map((c) => (c.nodeType === 3 ? c.textContent : "")).join("") || el.textContent;
  // the notice with these words (the newest one), and a button inside ONE notice: "Added n prompts" and M.undo's own
  // notice can both be on screen, each with a button
  const toastWith = (text) => elements(doc.getElementById("toasts"), hasClass("toast")).filter((el) => elements(el, hasClass("toast__text")).some((n) => n.textContent === text)).pop();
  const buttonIn = (toast, label) => (toast ? elements(toast, (el) => el.tagName === "BUTTON" && labelOf(el) === label)[0] : undefined);
  const liveOf = (collectionId) => R.cache.promptsOf(collectionId, { live: true });
  // A keydown that bubbles from its target through the ancestors to the document, as in the browser.
  function fire(key, target, mods) {
    const e = Object.assign({ type: "keydown", key, code: "", keyCode: 0, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false,
      repeat: false, isComposing: false, defaultPrevented: false, target, stopped: false }, mods || {});
    e.preventDefault = () => { e.defaultPrevented = true; };
    e.stopPropagation = () => { e.stopped = true; };
    e.stopImmediatePropagation = e.stopPropagation;
    for (let n = target; n && !e.stopped; n = n.parentNode) if (typeof n.dispatchEvent === "function") n.dispatchEvent(e);
    if (!e.stopped) doc.dispatchEvent(e);
    return e;
  }
  const cmdZ = (target, more) => fire("z", target, Object.assign({ metaKey: true }, more || {}));
  const shiftCmdZ = (target) => fire("Z", target, { metaKey: true, shiftKey: true });
  async function openDeckPage() {
    assert.equal(await R.app.route("deck", { collectionId: deck.id }), true);
    await wait(10);
    assert.equal(R.app.current().screen, "deck");
  }
  const batchBox = () => made.filter((o) => o.batch === true).pop();
  const size = () => JSON.parse(JSON.stringify(R.undo.size()));   // a plain copy: the page's objects are of another realm
  // the command that a key or a button began has ended (M.undo.idle()), and the views have followed
  const settle = async () => { await R.undo.idle(); await wait(10); };

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
    R.keys.setPlatform("mac");
    R.editor.create = (o) => { made.push(o); return { focus() {}, destroy() {}, run() { return false; }, getText() { return ""; }, setText() {} }; };
    assert.equal(await R.app.boot(), true, "boot\n" + logs.join("\n"));
    deck = await R.library.createDeck("Undo deck");
  });

  test("the page has M.undo, loaded right after M.cache", () => {
    assert.equal(typeof R.undo.undo, "function");
    assert.equal(typeof R.cache.revertPrompts, "function");
    assert.deepEqual(size(), { undo: 0, redo: 0 });
  });

  test("the deck page's Add is ONE step: Cmd+Z takes all its prompts back, Shift+Cmd+Z makes them again", async () => {
    R.undo.clear();
    await openDeckPage();
    const box = batchBox();
    assert.ok(box && typeof box.onSave === "function", "the deck page made its add box");
    assert.equal(await box.onSave("Q. one?\nA. 1\n\nQ. two?\nA. 2\n\nQ. three?\nA. 3"), 3);
    await wait(20);
    assert.equal(deckRowIds().length, 3);
    assert.deepEqual(size(), { undo: 1, redo: 0 });
    assert.equal(R.undo.peek("undo").label, "3 new prompts");

    doc.activeElement = doc.body;
    const z = cmdZ(doc.body);
    assert.equal(z.defaultPrevented, true, "the page took the key");
    await settle();
    assert.deepEqual(deckRowIds(), [], "all three are gone with one key");
    assert.equal(liveOf(deck.id).length, 0);
    assert.deepEqual(size(), { undo: 0, redo: 1 });
    assert.ok(toastTexts().includes("3 new prompts undone"), toastTexts().join(" | "));
    assert.ok(buttonIn(toastWith("3 new prompts undone"), "Redo"), "the notice offers Redo");
    assert.equal(buttonIn(toastWith("3 new prompts undone"), "Undo"), undefined);

    const y = shiftCmdZ(doc.body);
    assert.equal(y.defaultPrevented, true);
    await settle();
    assert.equal(deckRowIds().length, 3);
    assert.deepEqual(Array.from(liveOf(deck.id), (p) => p.text).sort(), ["Q. one?\nA. 1", "Q. three?\nA. 3", "Q. two?\nA. 2"]);
    assert.ok(toastTexts().includes("3 new prompts redone"), toastTexts().join(" | "));
    assert.equal(toastTexts().includes("3 new prompts undone"), false, "one notice at a time");

    buttonIn(toastWith("3 new prompts redone"), "Undo").click();   // the button of M.undo's own notice
    await settle();
    assert.deepEqual(deckRowIds(), []);
    assert.deepEqual(size(), { undo: 0, redo: 1 });
    buttonIn(toastWith("3 new prompts undone"), "Redo").click();
    await settle();
    assert.equal(deckRowIds().length, 3, "and that notice's Redo makes them again");
    assert.deepEqual(size(), { undo: 1, redo: 0 });
    assert.deepEqual(logs, []);
  });

  test("“Added n prompts” has its own Undo (after an Add the focus stays in the add box, where Cmd+Z is the text's)", async () => {
    R.undo.clear();
    await openDeckPage();
    const n0 = deckRowIds().length;                         // what the tests before left in the deck
    assert.equal(await batchBox().onSave("Q. added one?\nA. 1\n\nQ. added two?\nA. 2"), 2);
    await wait(20);
    assert.equal(deckRowIds().length, n0 + 2);
    const added = toastWith("Added 2 prompts");
    assert.ok(added && buttonIn(added, "Undo"), "the notice has Undo");
    buttonIn(added, "Undo").click();
    await settle();
    assert.equal(deckRowIds().length, n0, "both prompts of that Add are gone");
    assert.deepEqual(size(), { undo: 0, redo: 1 });
    assert.ok(toastTexts().includes("2 new prompts undone"), toastTexts().join(" | "));

    // the button takes back THAT Add only: after another step it says so and changes nothing
    assert.equal(await batchBox().onSave("Q. first add?\nA. 1"), 1);
    await wait(20);
    const first = toastWith("Added 1 prompt");
    assert.equal(await batchBox().onSave("Q. second add?\nA. 2"), 1);
    await wait(20);
    assert.equal(deckRowIds().length, n0 + 2);
    assert.ok(first && buttonIn(first, "Undo"), "the first Add's notice is still there, with its Undo");
    buttonIn(first, "Undo").click();
    await settle();
    assert.equal(deckRowIds().length, n0 + 2, "nothing changed");
    assert.ok(toastTexts().includes("Not undone: you made other changes after that one."), toastTexts().join(" | "));
    assert.deepEqual(size(), { undo: 2, redo: 0 });

    // Cmd+Z takes the second Add back while its notice is still on screen: that notice's Undo then says so
    const second = toastWith("Added 1 prompt");
    assert.notEqual(second, first);
    doc.activeElement = doc.body;
    cmdZ(doc.body);
    await settle();
    assert.equal(deckRowIds().length, n0 + 1);
    buttonIn(second, "Undo").click();
    await settle();
    assert.equal(deckRowIds().length, n0 + 1, "nothing more goes");
    assert.ok(toastTexts().includes("That is undone already."), toastTexts().join(" | "));
    assert.deepEqual(size(), { undo: 1, redo: 1 });

    // … and it says the same after a new Add emptied the redo list (there is a step to undo then, but not that one)
    assert.equal(await batchBox().onSave("Q. third add?\nA. 3"), 1);
    await wait(20);
    assert.deepEqual(size(), { undo: 2, redo: 0 });
    buttonIn(second, "Undo").click();
    await settle();
    assert.equal(deckRowIds().length, n0 + 2, "nothing goes");
    assert.equal(toastTexts().includes("Nothing to undo"), false, toastTexts().join(" | "));
    assert.ok(toastTexts().includes("That is undone already."), toastTexts().join(" | "));
    assert.deepEqual(size(), { undo: 2, redo: 0 });
    assert.deepEqual(logs, []);
  });

  test("a held key acts once, and in a text field the keys are the text's own", async () => {
    R.undo.clear();
    await openDeckPage();
    await batchBox().onSave("Q. held?\nA. yes");
    await batchBox().onSave("Q. held too?\nA. yes");
    await wait(20);
    assert.deepEqual(size(), { undo: 2, redo: 0 });

    doc.activeElement = doc.body;
    cmdZ(doc.body);
    for (let i = 0; i < 4; i++) assert.equal(cmdZ(doc.body, { repeat: true }).defaultPrevented, true);
    await settle();
    assert.deepEqual(size(), { undo: 1, redo: 1 }, "one step for one press, however long the key is held");

    const field = doc.createElement("textarea");
    doc.getElementById("deck").appendChild(field);
    field.focus();
    const inText = cmdZ(field);
    assert.equal(inText.defaultPrevented, false, "the key is left to the text field");
    assert.equal(shiftCmdZ(field).defaultPrevented, false);
    await settle();
    assert.deepEqual(size(), { undo: 1, redo: 1 });
    field.remove();
    doc.activeElement = doc.body;
  });

  test("nothing to undo: a short notice, and nothing is written", async () => {
    R.undo.clear();
    await openDeckPage();
    const before = JSON.stringify(R.cache.prompts());
    doc.activeElement = doc.body;
    assert.equal(cmdZ(doc.body).defaultPrevented, true);
    await settle();
    assert.ok(toastTexts().includes("Nothing to undo"), toastTexts().join(" | "));
    assert.equal(shiftCmdZ(doc.body).defaultPrevented, true);
    await settle();
    assert.ok(toastTexts().includes("Nothing to redo"), toastTexts().join(" | "));
    assert.equal(JSON.stringify(R.cache.prompts()), before);
  });

  test("while a question is up the keys change nothing, and neither does a notice's button", async () => {
    R.undo.clear();
    await openDeckPage();
    await batchBox().onSave("Q. behind a question?\nA. yes");
    await wait(20);
    assert.deepEqual(size(), { undo: 1, redo: 0 });
    const asked = R.app.confirm({ title: "A question", body: "that is up", ok: "OK", cancel: "Cancel" });
    await wait(5);
    assert.equal(R.app.modal(), true);
    doc.activeElement = doc.body;
    cmdZ(doc.body);
    await settle();
    assert.deepEqual(size(), { undo: 1, redo: 0 }, "the key is the question's");
    const r = await R.undo.undo();                           // what a notice's Undo button would call
    assert.equal(r.ok, false);
    assert.equal(r.reason, "modal");
    assert.deepEqual(size(), { undo: 1, redo: 0 });
    fire("Escape", doc.body);
    assert.equal(await asked, false);
    assert.equal((await R.undo.undo()).ok, true, "with the question gone the step is taken back");
  });

  test("the ? sheet names the two keys", async () => {
    await openDeckPage();
    assert.equal(R.app.openShortcuts(), true);
    const host = doc.getElementById("shortcuts");
    const sections = elements(host, hasClass("sheet__section"));
    const mine = sections.filter((s) => elements(s, hasClass("sheet__h")).some((h) => h.textContent === "Undo and redo"));
    assert.equal(mine.length, 1, "one section “Undo and redo”");
    // this fake DOM gives the text of a leaf element only: each row's label, then its key caps
    const rows = elements(mine[0], hasClass("sc-row")).map((r) => elements(r, hasClass("sc-label"))[0].textContent + " | " +
      elements(r, (el) => el.tagName === "KBD").map((k) => k.textContent).join(" "));
    assert.deepEqual(rows, ["Undo the last change to a card | ⌘Z", "Redo | ⇧⌘Z"]);
    // while the sheet is up the keys do nothing
    R.undo.clear();
    await batchBox().onSave("Q. behind the sheet?\nA. yes");
    await wait(20);
    cmdZ(doc.body);
    await settle();
    assert.deepEqual(size(), { undo: 1, redo: 0 });
    fire("Escape", doc.body);
    await wait(5);
  });

  test("a picture that an edit took out of a card stays in the store while a step can bring its text back", async () => {
    R.undo.clear();
    const id = "att_undo_1", withPic = "Q. What does the figure show?\nA. ![snip](att:" + id + ")", without = "Q. What does the figure show?\nA. a curve";
    await R.store.attachments.put({ id, mime: "image/png", bytes: new Uint8Array([1, 2, 3]), width: 1, height: 1, byteLength: 3, createdAt: Date.now() });
    const parsed = R.prompts.parse(withPic), t = Date.now();
    const p = await R.cache.savePrompt({
      collectionId: deck.id, kind: parsed.kind, text: withPic, tags: [], flagged: false, anchor: null,
      context: { docName: "Undo deck", sectionLabel: null, pageIndex: null, pageLabel: null },
      cards: R.prompts.reconcileCards(null, parsed, t).cards, createdAt: t, deletedAt: null, v: 1
    }, { content: true });
    // the edit, as js/list.js saveEdit makes it, with the clean-up that follows it
    const next = R.prompts.parse(without);
    await R.cache.savePrompt(Object.assign({}, R.cache.prompt(p.id), { text: without, kind: next.kind, tags: [], cards: R.prompts.reconcileCards(R.cache.prompt(p.id), next, Date.now()).cards }), { content: true, step: true });
    assert.deepEqual(Array.from(await R.attachments.gc(withPic, without, { draftIds: [] })), [], "nothing is deleted: the step still names the picture");
    assert.ok(await R.store.attachments.get(id));

    assert.equal((await R.undo.undo()).ok, true);
    assert.equal(R.cache.prompt(p.id).text, withPic);
    assert.ok(await R.store.attachments.get(id), "the card has its picture again");

    assert.equal((await R.undo.redo()).ok, true);
    assert.deepEqual(Array.from(await R.attachments.gc(withPic, without, { draftIds: [] })), [], "still named by the step (it can be undone again)");
    R.undo.clear();                                         // as after a reload: no step names it any more
    assert.deepEqual(Array.from(await R.attachments.gc(withPic, without, { draftIds: [] })), [id]);
    assert.equal(await R.store.attachments.get(id), null);
    assert.deepEqual(logs, []);
  });
});
