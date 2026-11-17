"use strict";
// test/deck-sendall-render.test.js — "Send all to Obsidian" from the deck page (BUILD-NOTES "Obsidian") with the deck's
// prompt list open. M.obsidian records obsidianSentAt / obsidianFile on every card, one M.cache.savePrompt (one
// prompt:saved) each, and M.list used to render every row again for every one of them: 2·N² row renders in one
// synchronous run (5.7 s for 400 cards in this fake DOM, without KaTeX). Now a saved prompt that keeps its place
// replaces only its own row. Covers: server mode, an older serve.py (one POST /note per card) and obsidian:// link
// mode build about one row per card, every card stays listed in the deck's order, and the rows hold the saved records
// ("Update in Obsidian" in the row ⋯ menu). M.list's row update itself is covered in test/list-dom.test.js.
// FEATURES A8 with the real M.cache's content stamps: a second Send all right after the first sends nothing (no
// confirm, no request at all, "Everything in … is already in Obsidian"), in server and link mode, and a card edited
// through M.cache.savePrompt({content: true}) is then the only card sent, with "replaceOnly", updated in place. A Send
// all whose answer never came leaves each card the note it was writing to (obsidianPendingFile, through the real
// cache), so after a rename of the deck the next Send all updates those copies there instead of adding a second note.
// FEATURES A9: the send record (the markers written ahead of each request and the records after) goes through
// M.cache.patchPrompts, so a Send all of 200 cards emits no prompt:saved at all and the list builds no row for it,
// while every marker is in the store before the request leaves.
// The real 30 modules run in the fake window of tools/smoke.js (memory store; compiled without its main() call, as
// test/app.test.js does). A stand-in for tools/serve.py answers through M.obsidian._setFetch and the opener only
// records its URI: nothing reaches a network, a vault or a folder, and no obsidian:// URI is opened.
// Run from the project root: node --test
const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const N = 60;                    // cards in each deck
const ROW_BUILDS_MAX = 3 * N;    // each card's row once, plus two whole renders at most (one render per card: N·N)

function loadSmokeHarness() {
  const file = path.join(__dirname, "..", "tools", "smoke.js");
  const src = fs.readFileSync(file, "utf8").replace(/^#!.*\n/, "");
  assert.match(src, /\nmain\(\);\s*$/, "tools/smoke.js no longer ends with main(); update loadSmokeHarness()");
  const body = src.replace(/\nmain\(\);\s*$/, "\nreturn { makeWindow: makeWindow, ORDER: ORDER };\n");
  const factory = vm.runInThisContext("(function (require, process, __dirname, __filename) {" + body + "\n})", { filename: file });
  return factory(require, process, path.dirname(file), file);
}

let W, R, doc, logs, server, opened, renders, lastOk = null;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const unref = (t) => { if (t && typeof t.unref === "function") t.unref(); return t; };
function elements(rootEl, pred) {
  const out = [];
  (function walk(n) { (n.childNodes || []).forEach((c) => { if (c.nodeType === 1) { if (pred(c)) out.push(c); walk(c); } }); })(rootEl);
  return out;
}
// the fake DOM's querySelector reads classList, which className assignments leave empty: match className instead
const byClass = (rootEl, cls) => elements(rootEl, (el) => (" " + el.className + " ").indexOf(" " + cls + " ") >= 0);
const deckRows = () => byClass(doc.getElementById("deck"), "list__row");
const rowIds = () => deckRows().map((r) => r.getAttribute("data-id"));

function respond(status, body) {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });
}
// "server": serve.py with POST /api/obsidian/notes; "old": a serve.py from before /notes (404: one POST /note per card);
// "link": a serve.py from before the Obsidian API (GET /vaults 404 on localhost: obsidian:// links). server.calls counts
// every request, the GETs too.
function standIn(mode) {
  server = { posts: [], calls: 0 };
  return (url, init) => {
    server.calls++;
    if (/\/api\/obsidian\/vaults$/.test(url)) {
      // "replaceOnly": this server's /notes honours a block's replaceOnly (a serve.py from before /notes has no such flag)
      const vaults = [{ id: "v1", name: "Test Vault", open: true, attachmentFolder: "/" }];
      return mode === "link" ? respond(404, {}) : respond(200, mode === "server" ? { vaults, replaceOnly: true } : { vaults });
    }
    const body = init && init.body ? JSON.parse(init.body) : {};
    server.posts.push({ url, body });
    if (/\/api\/obsidian\/notes$/.test(url)) {
      if (mode !== "server") return respond(404, { ok: false, error: "not found" });
      return respond(200, { ok: true, file: body.file, created: true,
        results: body.blocks.map((b) => ({ blockId: b.blockId, ok: true, replaced: b.replaceOnly === true })) });
    }
    if (/\/api\/obsidian\/note$/.test(url) && mode === "old") return respond(200, { ok: true, file: body.file, created: false, replaced: false });
    return respond(404, { ok: false, error: "not found" });
  };
}

// A deck of N (or `count`) Q/A cards with math, created one after another (the deck page lists them in this order).
async function seedDeck(name, count) {
  const deck = await R.library.createDeck(name);
  const t0 = Date.now() - 1e6, ids = [];
  for (let i = 0; i < (count || N); i++) {
    const text = "Q. What is $\\int_0^{" + i + "} x^2\\,dx$ (card " + i + ")?\nA. It is $\\frac{" + i + "^3}{3}$.";
    const parsed = R.prompts.parse(text);
    const p = await R.cache.savePrompt({
      collectionId: deck.id, kind: parsed.kind, text, tags: parsed.tags.slice(), flagged: false, anchor: null,
      context: { docName: deck.name, sectionLabel: "Part " + (i % 3), pageIndex: null, pageLabel: null },
      cards: R.prompts.reconcileCards(null, parsed, t0 + i).cards, createdAt: t0 + i, deletedAt: null, v: 1
    }, { content: true });
    ids.push(p.id);
  }
  return { deck, ids };
}
async function openDeckPage(deck) {
  assert.equal(await R.app.route("deck", { collectionId: deck.id }), true);
  await wait(10);
  assert.equal(R.list.isOpen() && R.list.collectionId(), deck.id, "the deck page shows its prompt list");
}
// The ⋯ menu item's action through its confirm (the click on "Send" is the gesture a link needs). → the result and the
// rows the list built from that click on (each Q/A row renders its question and its answer: two markup.render calls).
async function sendAllThroughConfirm(deck) {
  const pending = R.library.sendAllToObsidian(deck.id);
  let ok = null;
  // this fake DOM keeps a closed dialog's nodes (textContent = "" removes nothing): the new dialog is the last one
  for (let k = 0; k < 200 && !ok; k++) {
    await wait(1);
    const all = byClass(doc.documentElement, "confirm__ok"), last = all[all.length - 1] || null;
    ok = last !== lastOk ? last : null;
  }
  assert.ok(ok, "a confirm asks first");
  lastOk = ok;
  renders = 0;
  ok.click();
  const res = await pending;
  await wait(10);                                          // the library's deferred refresh and anything queued after it
  return { res, builds: renders / 2 };
}
// The labels of a row's ⋯ menu (built from the record the row holds), then Escape closes it.
function menuLabels(row) {
  byClass(row, "list__more")[0].click();
  const menu = byClass(doc.getElementById("deck"), "list__menu")[0];
  assert.ok(menu, "the row's ⋯ opens its menu");
  const labels = byClass(menu, "list__menu-item").map((b) => b.textContent);
  menu.dispatchEvent({ type: "keydown", key: "Escape", target: menu, preventDefault() {}, stopPropagation() {} });
  return labels;
}
function checkAfter(name, ids, res, builds) {
  assert.equal(res && res.ok, true, name + ": " + JSON.stringify(res));
  assert.equal(res.sent, N);
  assert.ok(ids.every((id) => R.cache.prompt(id).obsidianSentAt > 0 && R.cache.prompt(id).obsidianFile), "every card is recorded");
  assert.ok(builds <= ROW_BUILDS_MAX, name + ": the deck page's list built " + builds + " rows for a send-all of " + N +
    " cards (at most " + ROW_BUILDS_MAX + "; a whole render for every card builds " + N * N + ")");
  assert.deepEqual(rowIds(), ids, "every card is still listed, in the deck's order");
  for (const row of [deckRows()[0], deckRows()[N - 1]]) {
    const labels = menuLabels(row);
    assert.ok(labels.includes("Update in Obsidian") && !labels.includes("Send to Obsidian"),
      "the row holds the saved record: " + labels.join(", "));
  }
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
  assert.equal(R.store.mode(), "memory");
  assert.equal(R.settings.set("obsidian", true), true);   // DECISIONS D32: the Obsidian connection is switched on here
  opened = [];
  R.obsidian._setOpener((uri) => { opened.push(uri); return true; });  // never the real opener: no obsidian:// URI opens
  const render = R.markup.render;
  renders = 0;
  R.markup.render = function () { renders++; return render.apply(this, arguments); };
});
after(() => { if (R) R.obsidian._reset(); });

describe("Send all to Obsidian with the deck page's prompt list open", () => {
  test("server: one POST /notes, and the list builds about one row per card", async () => {
    R.obsidian._setFetch(standIn("server"));
    const { deck, ids } = await seedDeck("Deck sent through the server");
    await openDeckPage(deck);
    assert.deepEqual(rowIds(), ids);
    const { res, builds } = await sendAllThroughConfirm(deck);
    assert.equal(res.mode, "server");
    assert.deepEqual(server.posts.map((x) => x.url.replace(/^.*\/api\/obsidian/, "")), ["/notes"]);
    assert.equal(server.posts[0].body.blocks.length, N);
    checkAfter("server", ids, res, builds);
    assert.equal(logs.length, 0, logs.join("\n"));
  });

  test("an older serve.py: one POST /note per card, and still about one row per card", async () => {
    R.obsidian._setFetch(standIn("old"));
    const { deck, ids } = await seedDeck("Deck sent through an older server");
    await openDeckPage(deck);
    const { res, builds } = await sendAllThroughConfirm(deck);
    assert.equal(server.posts.filter((x) => /\/note$/.test(x.url)).length, N);
    checkAfter("older server", ids, res, builds);
  });

  test("link: one obsidian:// link through the opener, and the list builds about one row per card", async () => {
    R.obsidian._setFetch(standIn("link"));
    const { deck, ids } = await seedDeck("Deck sent through a link");
    await openDeckPage(deck);
    opened.length = 0;
    const { res, builds } = await sendAllThroughConfirm(deck);
    assert.equal(res.mode, "link");
    assert.equal(opened.length, 1);
    assert.match(opened[0], /^obsidian:\/\/new\?/);
    assert.equal(server.posts.length, 0);
    checkAfter("link", ids, res, builds);
  });
});

// FEATURES A8 with the real M.cache: its content stamp (contentUpdatedAt, moved by a person's edit and never by a
// send's {content: false} record) against obsidianSentAt decides what a send-all sends again.
describe("Send all never sends a card twice (FEATURES A8), with the real cache's content stamps", () => {
  let toasts = [], confirms = [], toast0, confirm0;
  before(() => {
    toast0 = R.app.toast; confirm0 = R.app.confirm;
    R.app.toast = function (o) { toasts.push(o); return toast0.apply(this, arguments); };
    R.app.confirm = function (o) { confirms.push(o); return confirm0.apply(this, arguments); };
  });
  after(() => { R.app.toast = toast0; R.app.confirm = confirm0; });
  const lastToast = () => toasts[toasts.length - 1] || {};

  test("server: a second Send all right after the first sends nothing; editing one card sends exactly that card, replacing its block", async () => {
    R.obsidian._setFetch(standIn("server"));
    const { deck, ids } = await seedDeck("Deck sent twice");
    await openDeckPage(deck);
    toasts = []; confirms = [];
    const first = await sendAllThroughConfirm(deck);
    assert.deepEqual([first.res.sent, first.res.added], [N, N]);
    assert.equal(confirms[0].body, N + " new ones are added, in Notes/Marginalia/Deck sent twice.md.");
    assert.ok(ids.every((id) => R.obsidian.sendState(R.cache.prompt(id)) === "unchanged"), "the records are no content edit");

    // right after: no confirm, no request at all, and the toast says everything is there
    const calls = server.calls;
    toasts = []; confirms = [];
    assert.equal(await R.library.sendAllToObsidian(deck.id), null);
    assert.equal(server.calls, calls, "no request, not even the server check");
    assert.equal(confirms.length, 0);
    assert.deepEqual(toasts.map((t) => [t.text, t.detail]), [["Everything in “Deck sent twice” is already in Obsidian", "Every card was sent before and none was edited since."]]);

    // a person edits one card (as the editor saves it): only that card is sent, with replaceOnly, to the note holding it
    await wait(5);
    const cur = R.cache.prompt(ids[7]);
    await R.cache.savePrompt(Object.assign({}, cur, { text: cur.text.replace("(card 7)?", "(card 7, edited)?") }), { content: true });
    assert.equal(R.obsidian.sendState(R.cache.prompt(ids[7])), "changed");
    assert.equal(R.obsidian.sendState(R.cache.prompt(ids[8])), "unchanged");
    toasts = []; confirms = [];
    const posted = server.posts.length;
    const second = await sendAllThroughConfirm(deck);
    assert.deepEqual([confirms[0].title, confirms[0].body], ["Send 1 card to Obsidian?",
      "1 edited one is updated in place, in Notes/Marginalia/Deck sent twice.md. " + (N - 1) + " already there are skipped."]);
    const sent = server.posts.slice(posted);
    assert.deepEqual(sent.map((x) => x.url.replace(/^.*\/api\/obsidian/, "")), ["/notes"]);
    assert.deepEqual(sent[0].body.blocks.map((b) => [b.blockId, b.replaceOnly === true]), [[ids[7], true]]);
    assert.match(sent[0].body.blocks[0].markdown, /\(card 7, edited\)\?/);
    assert.deepEqual([second.res.ok, second.res.sent, second.res.added, second.res.updated, second.res.unchanged], [true, 1, 0, 1, N - 1]);
    assert.equal(lastToast().text, "Sent to Obsidian · Notes/Marginalia/Deck sent twice.md: 0 added, 1 updated, " + (N - 1) + " already there");
    assert.equal(R.obsidian.sendState(R.cache.prompt(ids[7])), "unchanged", "recorded again");
    assert.deepEqual(rowIds(), ids, "every card is still listed, in the deck's order");

    // and then nothing again
    const calls2 = server.calls;
    assert.equal(await R.library.sendAllToObsidian(deck.id), null);
    assert.equal(server.calls, calls2);
  });

  test("server: a Send all whose answer never came, then a rename: the next Send all updates those copies in that note", async () => {
    // a stand-in that keeps what it writes (note → block ids); while `lose` it writes, then the answer never comes (the
    // server stopped or restarted mid-answer)
    const notes = new Map();
    let lose = true;
    R.obsidian._setFetch((url, init) => {
      if (/\/api\/obsidian\/vaults$/.test(url)) return respond(200, { vaults: [{ id: "v1", name: "Test Vault", open: true, attachmentFolder: "/" }], replaceOnly: true });
      const body = JSON.parse(init.body), held = notes.get(body.file) || [];
      const results = body.blocks.map((b) => {
        const replaced = held.includes(b.blockId);
        if (!replaced && b.replaceOnly) return { blockId: b.blockId, ok: false, notFound: true, error: "its earlier copy is no longer in the note" };
        if (!replaced) held.push(b.blockId);
        return { blockId: b.blockId, ok: true, replaced };
      });
      notes.set(body.file, held);
      return lose ? Promise.reject(new TypeError("Failed to fetch")) : respond(200, { ok: true, file: body.file, created: false, results });
    });
    const { deck, ids } = await seedDeck("Deck whose answer was lost");
    const NOTE = "Notes/Marginalia/Deck whose answer was lost.md";
    await openDeckPage(deck);
    toasts = []; confirms = [];
    const first = await sendAllThroughConfirm(deck);
    assert.deepEqual([first.res.sent, first.res.failed.length], [0, N]);
    assert.equal(lastToast().text, "0 sent, " + N + " may already be in Obsidian — Marginalia's server did not answer");
    assert.ok(first.builds <= ROW_BUILDS_MAX, "the list built " + first.builds + " rows");
    assert.ok(ids.every((id) => { const p = R.cache.prompt(id); return p.obsidianPendingFile === NOTE && !p.obsidianSentAt && R.obsidian.sendState(p) === "fresh"; }),
      "each card remembers the note, and is still new");

    await R.library.renameCollection(deck.id, "Deck renamed since");
    lose = false;
    toasts = []; confirms = [];
    const second = await sendAllThroughConfirm(deck);
    assert.equal(confirms[0].body, N + " new ones are added, in " + NOTE + ".");
    assert.deepEqual([second.res.ok, second.res.added, second.res.updated], [true, 0, N]);
    assert.deepEqual(Array.from(notes.keys()), [NOTE], "no second note");
    assert.equal(notes.get(NOTE).length, N, "one copy of each card");
    assert.ok(ids.every((id) => { const p = R.cache.prompt(id); return p.obsidianFile === NOTE && p.obsidianSentAt > 0 && !("obsidianPendingFile" in p); }));
    assert.deepEqual(rowIds(), ids);
  });

  test("link: a second Send all right after the first opens no link and asks nothing", async () => {
    R.obsidian._setFetch(standIn("link"));
    const { deck, ids } = await seedDeck("Deck linked twice");
    await openDeckPage(deck);
    opened.length = 0;
    const first = await sendAllThroughConfirm(deck);
    assert.deepEqual([first.res.mode, first.res.sent, opened.length], ["link", N, 1]);
    assert.ok(ids.every((id) => R.obsidian.sendState(R.cache.prompt(id)) === "unchanged"));
    const calls = server.calls;
    toasts = []; confirms = [];
    assert.equal(await R.library.sendAllToObsidian(deck.id), null);
    assert.deepEqual([opened.length, server.calls, confirms.length], [1, calls, 0]);
    assert.equal(lastToast().text, "Everything in “Deck linked twice” is already in Obsidian");
  });
});

describe("FEATURES A9: a Send all of 200 cards costs no re-render per card", () => {
  test("server: every marker is in the store when /notes leaves; the markers and the 200 records emit no prompt:saved and build no row", async () => {
    let atRequest = null;
    R.obsidian._setFetch((url, init) => {
      if (/\/api\/obsidian\/vaults$/.test(url)) return respond(200, { vaults: [{ id: "v1", name: "Test Vault", open: true, attachmentFolder: "/" }], replaceOnly: true });
      const body = JSON.parse(init.body);
      // what the store holds while the request is on its way (a tab closed now leaves exactly this)
      return Promise.all(body.blocks.map((b) => R.store.prompts.get(b.blockId))).then((rows) => {
        atRequest = rows.map((r) => r && r.obsidianPendingFile);
        return respond(200, { ok: true, file: body.file, created: true, results: body.blocks.map((b) => ({ blockId: b.blockId, ok: true, replaced: false })) });
      });
    });
    const { deck, ids } = await seedDeck("Deck of two hundred", 200);
    const NOTE = "Notes/Marginalia/Deck of two hundred.md";
    await openDeckPage(deck);
    assert.equal(rowIds().length, 200);
    const stamps = ids.map((id) => R.cache.prompt(id).contentUpdatedAt);
    let saved = 0;
    const off = R.bus.on("prompt:saved", () => { saved++; });
    let res, builds;
    try { ({ res, builds } = await sendAllThroughConfirm(deck)); } finally { off(); }
    assert.deepEqual([res.ok, res.sent, res.added], [true, 200, 200]);
    assert.ok(atRequest && atRequest.length === 200 && atRequest.every((f) => f === NOTE), "every marker in the store before the request left");
    assert.equal(saved, 0, "no prompt:saved for the markers or the records");
    assert.equal(builds, 0, "the list built no row for them (one per save would be 400 here, a whole render per save 80 000)");
    for (let i = 0; i < ids.length; i++) {
      const p = R.cache.prompt(ids[i]);
      assert.deepEqual([typeof p.obsidianSentAt, p.obsidianFile, "obsidianPendingFile" in p, p.contentUpdatedAt], ["number", NOTE, false, stamps[i]], ids[i]);
    }
    const s = await R.store.prompts.get(ids[199]);
    assert.deepEqual([s.obsidianFile, "obsidianPendingFile" in s], [NOTE, false], "stored");
    assert.deepEqual(rowIds(), ids, "every card still listed, in order");
    const labels = menuLabels(deckRows()[199]);
    assert.ok(labels.includes("Update in Obsidian"), "the row's record is the cache's own, changed in place: " + labels.join(", "));
  });
});
