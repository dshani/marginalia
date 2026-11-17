"use strict";
// test/folders.test.js — FEATURES L1 "Folders in the library", the data side (BUILD-NOTES "Library folders"):
// the folder records in M.cache / M.store (one meta record, no IndexedDB version bump), create / rename / nest /
// move / delete / undo, cycles refused, a folder delete that moves its children up one level and changes nothing
// else, existing libraries unchanged, readers that never trust a stored reference, one folders:changed event per
// write, countsBy, review of a folder (M.review scope "folder"), the JSON backup and the import merge rules, Obsidian
// note paths unchanged, Anki / Markdown unchanged. Each test is a fresh vm page running the REAL modules on the memory
// backend of js/store.js; nothing here touches a network, a vault or a backup folder.
// Run: node --test test/folders.test.js
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const JS = path.join(__dirname, "..", "js");
const MODULES = ["util", "bus", "settings", "store", "scheduler", "prompts", "context", "markup", "exporter", "obsidian", "cache", "review"];
const plain = (v) => JSON.parse(JSON.stringify(v));      // records made in a vm context have that context's prototypes
const unref = (t) => { if (t && typeof t.unref === "function") t.unref(); return t; };
const DAY = 86400000;
const T0 = Date.UTC(2026, 10, 2, 12);

function page() {
  const toasts = [], events = [];
  const win = {
    console: { log() {}, info() {}, debug() {}, warn() {}, error() {} },
    setTimeout: (fn, ms, ...a) => unref(setTimeout(fn, ms, ...a)), clearTimeout,
    setInterval: (fn, ms) => unref(setInterval(fn, ms)), clearInterval,
    queueMicrotask, structuredClone, crypto: globalThis.crypto, TextEncoder, TextDecoder, Intl
  };
  win.window = win; win.self = win;
  const ctx = vm.createContext(win);
  for (const name of MODULES) vm.runInContext(fs.readFileSync(path.join(JS, name + ".js"), "utf8"), ctx, { filename: "js/" + name + ".js" });
  const M = win.Marginalia;
  M.app = { toast(o) { toasts.push(o && o.text); return { close() {} }; } };
  ["folders:changed", "collection:changed", "prompt:saved"].forEach((type) => M.bus.on(type, (p) => events.push({ type, payload: p })));
  return {
    M, win, toasts, events,
    of: (type) => events.filter((e) => e.type === type).map((e) => plain(e.payload)),
    async boot() { await M.store.open(); await M.cache.load(); return this; }
  };
}

function book(id, extra) {
  return Object.assign({ id, kind: "book", name: "Book " + id, sha256: "sha-" + id, hashAlgo: "sha-256", pageCount: 40, pageLabels: null,
    sections: [], lastPosition: { pageIndex: 3, fraction: 0.5, zoom: "fit" }, hasBytes: true, addedAt: T0, lastOpenedAt: T0,
    updatedAt: T0, deletedAt: null, v: 1 }, extra || {});
}
function deck(id, extra) {
  return Object.assign({ id, kind: "deck", name: "Deck " + id, description: "", sections: [], addedAt: T0, lastOpenedAt: T0,
    updatedAt: T0, deletedAt: null, v: 1 }, extra || {});
}
function card(i, dueAt, log) {
  return { i, createdAt: T0 - 30 * DAY, lastReviewedAt: null, intervalMs: 5 * DAY, dueAt, log: log || [] };
}
function prompt(id, collectionId, extra) {
  return Object.assign({ id, collectionId, kind: "qa", text: "Q. " + id + "?\nA. yes", tags: [], flagged: false, anchor: null, context: null,
    cards: [card(0, T0 - DAY)], createdAt: T0 - 30 * DAY, contentUpdatedAt: T0 - 30 * DAY, updatedAt: T0 - 30 * DAY, deletedAt: null, v: 1 }, extra || {});
}
async function seed(P, cols, prompts) {
  for (const c of cols) await P.M.cache.saveCollection(Object.assign({}, c));
  for (const p of prompts || []) await P.M.cache.savePrompt(Object.assign({}, p), { content: false });
}
const nameOf = (P, id) => (id === null ? null : P.M.cache.folder(id).name);
const names = (P, ids) => plain(ids).map((id) => nameOf(P, id));

/* ------------------------------------------------------------------ storage */

describe("storage: one meta record, no IndexedDB version bump (L1.1)", () => {
  test("an existing library opens unchanged: every book and deck at the top level, nothing written, schema still version 1", async () => {
    const P = page();
    await P.M.store.open();
    await P.M.store.collections.put(book("b1"));          // as a Marginalia from before folders stored them
    await P.M.store.collections.put(deck("d1"));
    await P.M.store.prompts.put(prompt("p1", "b1"));
    const before = plain(await P.M.store.collections.all());
    await P.M.cache.load();
    assert.equal(P.M.store.DB_VERSION, 1);
    assert.deepEqual(Object.keys(P.M.store.MIGRATIONS), ["1"], "no new object store, no version bump");
    assert.deepEqual(plain(P.M.cache.folders()), []);
    assert.equal(P.M.cache.folderOf("b1"), null);
    assert.equal(P.M.cache.folderOf("d1"), null);
    assert.equal(await P.M.store.meta.get("folders"), undefined, "loading writes no folder record");
    assert.deepEqual(plain(await P.M.store.collections.all()), before, "and no collection record");
    assert.ok(!("folderId" in P.M.cache.collection("b1")), "an old record gets no folderId by being read");
  });

  test("folders live in ONE meta record (tombstones included) and come back on the next load", async () => {
    const P = await page().boot();
    await seed(P, [book("b1")]);
    const a = await P.M.cache.createFolder("Physics", null, { now: T0 + 1 });
    const b = await P.M.cache.createFolder("QM", a.id, { now: T0 + 2 });
    await P.M.cache.moveCollection("b1", b.id, { now: T0 + 3 });
    const stored = plain(await P.M.store.meta.get("folders"));
    assert.deepEqual(stored.map((f) => [f.name, f.parentId === null ? null : stored.find((x) => x.id === f.parentId).name]), [["Physics", null], ["QM", "Physics"]]);
    for (const f of stored) assert.deepEqual(Object.keys(f).sort(), ["createdAt", "deletedAt", "id", "name", "parentId", "updatedAt"]);
    assert.match(a.id, /^folder_/);
    const rec = plain(await P.M.store.collections.get("b1"));
    assert.equal(rec.folderId, b.id);
    assert.equal(rec.folderUpdatedAt, T0 + 3);
    await P.M.cache.load();                                   // what a reload reads
    assert.deepEqual(names(P, P.M.cache.folderPath(P.M.cache.folderOf("b1"))), ["Physics", "QM"]);
    await P.M.cache.removeFolder(b.id, { now: T0 + 4 });
    await P.M.cache.load();
    assert.equal(P.M.cache.folder(b.id).deletedAt, T0 + 4, "a deleted folder stays as a tombstone");
    assert.equal(P.M.cache.folders({ live: true }).length, 1);
  });
});

/* ------------------------------------------------------------------ writes */

describe("create, rename, nest, move (L1.1, L1.3)", () => {
  test("create: the name is trimmed and collapsed, at most 80 characters; a blank name and an unknown parent are refused", async () => {
    const P = await page().boot();
    const f = await P.M.cache.createFolder("  Quantum \n  mechanics ", null);
    assert.equal(f.name, "Quantum mechanics");
    assert.equal(f.parentId, null);
    assert.equal(f.deletedAt, null);
    const long = await P.M.cache.createFolder("x".repeat(100) + "𝑥", null);
    assert.equal(Array.from(long.name).length, 80);
    await assert.rejects(P.M.cache.createFolder("   ", null), (e) => e.code === "bad_name");
    await assert.rejects(P.M.cache.createFolder("Child", "folder_nope"), (e) => e.code === "not_found");
    const sub = await P.M.cache.createFolder("Child", f.id);
    assert.equal(P.M.cache.folderParent(sub.id), f.id);
    assert.deepEqual(plain(P.M.cache.folderChildren(f.id)).map((x) => x.name), ["Child"]);
  });

  test("rename changes the name only (updatedAt moves); the same name writes nothing", async () => {
    const P = await page().boot();
    const f = await P.M.cache.createFolder("Physics", null, { now: T0 });
    const n = P.of("folders:changed").length;
    await P.M.cache.renameFolder(f.id, "Physics", { now: T0 + 5 });
    assert.equal(P.of("folders:changed").length, n, "nothing to write");
    const r = await P.M.cache.renameFolder(f.id, "  Physics II ", { now: T0 + 9 });
    assert.equal(r.name, "Physics II");
    assert.equal(r.updatedAt, T0 + 9);
    assert.equal(r.createdAt, T0);
    assert.equal(plain(await P.M.store.meta.get("folders"))[0].name, "Physics II");
    await assert.rejects(P.M.cache.renameFolder(f.id, " "), (e) => e.code === "bad_name");
  });

  test("nesting at any depth; a folder can never move into itself or any of its sub-folders", async () => {
    const P = await page().boot();
    const a = await P.M.cache.createFolder("A", null);
    const b = await P.M.cache.createFolder("B", a.id);
    const c = await P.M.cache.createFolder("C", b.id);
    const d = await P.M.cache.createFolder("D", c.id);
    assert.deepEqual(names(P, P.M.cache.folderPath(d.id)), ["A", "B", "C", "D"]);
    for (const target of [a.id, b.id, c.id, d.id]) {
      await assert.rejects(P.M.cache.moveFolder(a.id, target), (e) => e.code === "cycle", "A into " + nameOf(P, target));
    }
    await assert.rejects(P.M.cache.moveFolder(b.id, d.id), (e) => e.code === "cycle");
    assert.deepEqual(names(P, P.M.cache.folderPath(d.id)), ["A", "B", "C", "D"], "nothing moved");
    const r = await P.M.cache.moveFolder(c.id, null);
    assert.deepEqual([r.from, r.to, r.moved], [b.id, null, true]);
    assert.deepEqual(names(P, P.M.cache.folderPath(d.id)), ["C", "D"]);
    await P.M.cache.moveFolder(a.id, d.id);                   // A (with B) under D: fine, D is not inside A any more
    assert.deepEqual(names(P, P.M.cache.folderPath(b.id)), ["C", "D", "A", "B"]);
    const same = await P.M.cache.moveFolder(a.id, d.id);
    assert.equal(same.moved, false, "already there");
  });

  test("moveCollection: into a folder and back to the top level; only folderId, folderUpdatedAt and updatedAt change", async () => {
    const P = await page().boot();
    await seed(P, [book("b1", { contentUpdatedAt: T0 - 5 })], [prompt("p1", "b1")]);
    const before = plain(P.M.cache.collection("b1"));
    const promptBefore = plain(P.M.cache.prompt("p1"));
    const f = await P.M.cache.createFolder("Physics", null);
    const r = await P.M.cache.moveCollection("b1", f.id, { now: T0 + 7 });
    assert.deepEqual([r.from, r.to, r.moved], [null, f.id, true]);
    const after = plain(P.M.cache.collection("b1"));
    const changed = Object.keys(Object.assign({}, before, after)).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k])).sort();
    assert.deepEqual(changed, ["folderId", "folderUpdatedAt", "updatedAt"]);
    assert.equal(after.contentUpdatedAt, before.contentUpdatedAt, "a move is not a content edit");
    assert.deepEqual(plain(P.M.cache.prompt("p1")), promptBefore, "its prompts are untouched");
    const back = await P.M.cache.moveCollection("b1", null, { now: T0 + 8 });
    assert.deepEqual([back.from, back.to], [f.id, null]);
    assert.equal(P.M.cache.folderOf("b1"), null);
    await assert.rejects(P.M.cache.moveCollection("b1", "folder_gone"), (e) => e.code === "not_found");
    await assert.rejects(P.M.cache.moveCollection("nope", f.id), (e) => e.code === "not_found");
  });
});

/* ------------------------------------------------------------------ delete */

describe("delete (L1.4): children move up one level, nothing else is deleted or changed", () => {
  test("sub-folders, books and decks move to the parent; prompts and review history stay byte for byte; Undo puts them back", async () => {
    const P = await page().boot();
    const log = [{ at: T0 - 9 * DAY, outcome: "remembered", intervalMs: 5 * DAY, dueAt: T0 - 4 * DAY }];
    await seed(P, [book("b1"), book("b2"), deck("d1"), book("out")],
      [prompt("p1", "b1", { cards: [card(0, T0 - DAY, log)] }), prompt("p2", "d1"), prompt("p3", "b2", { kind: "note", text: "a note", cards: [] })]);
    const phys = await P.M.cache.createFolder("Physics", null, { now: T0 });
    const qm = await P.M.cache.createFolder("QM", phys.id, { now: T0 });
    const sub = await P.M.cache.createFolder("Problems", qm.id, { now: T0 });
    await P.M.cache.moveCollection("b1", qm.id, { now: T0 });
    await P.M.cache.moveCollection("d1", qm.id, { now: T0 });
    await P.M.cache.moveCollection("b2", sub.id, { now: T0 });
    const prompts = plain(await P.M.store.prompts.all());
    const n = P.of("folders:changed").length;
    const r = await P.M.cache.removeFolder(qm.id, { now: T0 + 50 });
    assert.equal(P.of("folders:changed").length, n + 1, "one event for the whole delete");
    assert.equal(r.to, phys.id);
    assert.deepEqual(plain(r.folders), [sub.id]);
    assert.deepEqual(plain(r.collections).sort(), ["b1", "d1"]);
    assert.equal(P.M.cache.folder(qm.id).deletedAt, T0 + 50);
    assert.equal(P.M.cache.folderParent(sub.id), phys.id, "the sub-folder moved up one level");
    assert.equal(P.M.cache.folderOf("b1"), phys.id);
    assert.equal(P.M.cache.folderOf("d1"), phys.id);
    assert.equal(P.M.cache.folderOf("b2"), sub.id, "deeper contents stay where they are");
    assert.equal(P.M.cache.folderOf("out"), null);
    assert.deepEqual(plain(await P.M.store.prompts.all()), prompts, "no prompt or review record changed");
    for (const id of ["b1", "b2", "d1", "out"]) assert.equal(P.M.cache.collection(id).deletedAt, null, id + " is live");
    assert.equal((await P.M.store.collections.get("b1")).folderId, phys.id, "stored");

    await P.M.cache.restoreFolder(qm.id, r, { now: T0 + 60 });
    assert.equal(P.M.cache.folder(qm.id).deletedAt, null);
    assert.equal(P.M.cache.folderOf("b1"), qm.id);
    assert.equal(P.M.cache.folderOf("d1"), qm.id);
    assert.equal(P.M.cache.folderParent(sub.id), qm.id);
    assert.deepEqual(plain(await P.M.store.prompts.all()), prompts);
  });

  test("a top-level folder's contents go to the top level; Undo leaves alone what was moved again meanwhile", async () => {
    const P = await page().boot();
    await seed(P, [book("b1"), book("b2")]);
    const f = await P.M.cache.createFolder("Inbox", null, { now: T0 });
    const other = await P.M.cache.createFolder("Other", null, { now: T0 });
    await P.M.cache.moveCollection("b1", f.id, { now: T0 });
    await P.M.cache.moveCollection("b2", f.id, { now: T0 });
    const r = await P.M.cache.removeFolder(f.id, { now: T0 + 10 });
    assert.equal(r.to, null);
    assert.equal(P.M.cache.folderOf("b1"), null);
    await P.M.cache.moveCollection("b2", other.id, { now: T0 + 11 });
    await P.M.cache.restoreFolder(f.id, r, { now: T0 + 12 });
    assert.equal(P.M.cache.folderOf("b1"), f.id);
    assert.equal(P.M.cache.folderOf("b2"), other.id, "moved since: stays");
  });

  test("deleting a book or deck is unchanged, also inside a folder", async () => {
    const P = await page().boot();
    await seed(P, [book("b1")], [prompt("p1", "b1")]);
    const f = await P.M.cache.createFolder("F", null);
    await P.M.cache.moveCollection("b1", f.id);
    await P.M.cache.removeCollection("b1", { now: T0 + 3 });
    assert.equal(P.M.cache.collection("b1").deletedAt, T0 + 3);
    assert.equal(P.M.cache.prompt("p1").deletedAt, T0 + 3);
    assert.deepEqual(plain(P.M.cache.folderMembers(f.id)), { folders: [], collections: [] });
    await P.M.cache.restoreCollection("b1");
    assert.equal(P.M.cache.folderOf("b1"), f.id, "an undone delete comes back into its folder");
  });
});

/* ------------------------------------------------------------------ readers */

describe("readers never trust a stored reference", () => {
  test("a folderId naming no folder → top level; a deleted folder → its nearest live folder; a stored loop is cut at its newest folder", async () => {
    const P = page();
    await P.M.store.open();
    await P.M.store.meta.set("folders", [
      { id: "fA", name: "A", parentId: null, createdAt: 1, updatedAt: 1, deletedAt: null },
      { id: "fB", name: "B", parentId: "fA", createdAt: 1, updatedAt: 1, deletedAt: 5 },          // deleted, inside A
      { id: "fC", name: "C", parentId: "fB", createdAt: 1, updatedAt: 2, deletedAt: null },       // its parent is deleted
      { id: "fX", name: "X", parentId: "fY", createdAt: 1, updatedAt: 9, deletedAt: null },       // X ⇄ Y: a loop
      { id: "fY", name: "Y", parentId: "fX", createdAt: 1, updatedAt: 3, deletedAt: null }
    ]);
    await P.M.store.collections.put(book("b1", { folderId: "f_missing" }));
    await P.M.store.collections.put(book("b2", { folderId: "fB" }));
    await P.M.store.collections.put(book("b3", { folderId: "fY" }));
    await P.M.cache.load();
    assert.equal(P.M.cache.folderOf("b1"), null);
    assert.equal(P.M.cache.folderOf("b2"), "fA");
    assert.equal(P.M.cache.folderParent("fC"), "fA");
    assert.equal(P.M.cache.folderParent("fX"), null, "the loop is cut at X, its newest folder");
    assert.equal(P.M.cache.folderParent("fY"), "fX");
    assert.deepEqual(plain(P.M.cache.folderMembers("fA")).collections, ["b2"]);
    assert.deepEqual(plain(P.M.cache.folderMembers("fX")), { folders: ["fY"], collections: ["b3"] });
    await assert.rejects(P.M.cache.moveFolder("fX", "fY"), (e) => e.code === "cycle");
  });
});

/* ------------------------------------------------------------------ events and counts */

describe("one event per write; one pass for the counts (the home screen stays fast)", () => {
  test("a folder delete that moves 100 books emits ONE folders:changed and no collection:changed", async () => {
    const P = await page().boot();
    const cols = [];
    for (let i = 0; i < 100; i++) cols.push(book("b" + i));
    await seed(P, cols);
    const f = await P.M.cache.createFolder("Big", null);
    for (const c of cols) await P.M.cache.moveCollection(c.id, f.id);
    const before = P.events.length;
    await P.M.cache.removeFolder(f.id);
    const after = P.events.slice(before);
    assert.deepEqual(after.map((e) => e.type), ["folders:changed"]);
    assert.equal(after[0].payload.collectionIds.length, 100);
  });

  test("countsBy(now) gives counts(id, now) for every collection in one pass", async () => {
    const P = await page().boot();
    await seed(P, [book("b1"), deck("d1"), book("b2")], [
      prompt("p1", "b1"), prompt("p2", "b1", { cards: [card(0, T0 + 30 * DAY)] }), prompt("p3", "d1", { kind: "cloze", text: "a {b} {c}", cards: [card(0, T0 - DAY), card(1, T0 - DAY)] }),
      prompt("p4", "b2", { kind: "note", text: "note", cards: [] }), prompt("p5", "b2", { deletedAt: T0 })
    ]);
    const by = P.M.cache.countsBy(T0);
    for (const id of ["b1", "d1", "b2"]) assert.deepEqual(plain(by.get(id)), plain(P.M.cache.counts(id, T0)), id);
  });
});

/* ------------------------------------------------------------------ review a folder */

describe("review a folder (L1.5)", () => {
  async function library() {
    const P = await page().boot();
    await seed(P, [book("b1"), deck("d1"), book("b2"), book("out")], [
      prompt("p1", "b1", { createdAt: T0 - 40 * DAY, cards: [card(0, T0 - 3 * DAY)] }),
      prompt("p2", "d1", { cards: [card(0, T0 - 2 * DAY)] }),
      prompt("p3", "b2", { cards: [card(0, T0 - 5 * DAY)] }),
      prompt("p4", "b2", { cards: [Object.assign(card(0, T0 + 20 * DAY), { lastReviewedAt: T0 - DAY })] }),   // answered before, not due (a card never asked is due at once: D27)
      prompt("p5", "out", { cards: [card(0, T0 - 9 * DAY)] })                   // outside the folder
    ]);
    const top = await P.M.cache.createFolder("Physics", null);
    const mid = await P.M.cache.createFolder("QM", top.id);
    const low = await P.M.cache.createFolder("Problems", mid.id);
    await P.M.cache.moveCollection("b1", top.id);
    await P.M.cache.moveCollection("d1", mid.id);
    await P.M.cache.moveCollection("b2", low.id);
    return { P, top, mid, low };
  }

  test("every due card of every book and deck inside, at any depth, interleaved exactly as Review all", async () => {
    const { P, top } = await library();
    const R = P.M.review;
    const members = new Set(plain(P.M.cache.folderMembers(top.id).collections));
    const expected = P.M.scheduler.buildQueue({ prompts: P.M.cache.prompts().filter((p) => members.has(p.collectionId)), scope: "all", now: T0, seed: T0 });
    await R.start({ scope: "folder", collectionId: top.id, now: T0 });
    const seen = [];
    for (let c = R.current(); c; c = R.current()) { seen.push(c.prompt.id); R.reveal(); R.grade("remembered"); }
    assert.deepEqual(seen, plain(expected).map((i) => i.promptId), "the Review all order over the folder's prompts");
    assert.deepEqual(seen.slice().sort(), ["p1", "p2", "p3"], "nested folders included; the book outside and the card not due are not");
    R.stop();
  });

  test("a sub-folder reviews only its own subtree; the summary names the folder; no folder id is refused", async () => {
    const { P, mid } = await library();
    const R = P.M.review;
    let summary = null;
    P.M.bus.on("review:ended", (e) => { summary = e.summary; });
    await R.start({ scope: "folder", collectionId: mid.id, now: T0 });
    const seen = [];
    for (let c = R.current(); c; c = R.current()) { seen.push(c.prompt.id); R.reveal(); R.grade("remembered"); }
    assert.deepEqual(seen.sort(), ["p2", "p3"]);
    assert.equal(summary.scope, "folder");
    assert.equal(summary.folderName, "QM");
    R.stop();
    await assert.rejects(R.start({ scope: "folder", collectionId: null, now: T0 }), (e) => e.code === "bad_scope");
  });
});

/* ------------------------------------------------------------------ backup and import */

describe("the JSON backup carries the folders (L1.7)", () => {
  test("Export all: every folder (tombstones too) and every collection's folderId; one book's export carries no folder", async () => {
    const P = await page().boot();
    await seed(P, [book("b1"), deck("d1")]);
    const f = await P.M.cache.createFolder("Physics", null, { now: T0 });
    const g = await P.M.cache.createFolder("Old", null, { now: T0 + 1 });          // folders go out in creation order
    await P.M.cache.moveCollection("b1", f.id, { now: T0 + 1 });
    await P.M.cache.removeFolder(g.id, { now: T0 + 2 });
    const all = JSON.parse((await P.M.exporter.prepare("json", { scope: "all", includeImages: false })).text);
    assert.deepEqual(all.folders.map((x) => [x.name, x.deletedAt]), [["Physics", null], ["Old", T0 + 2]]);
    assert.equal(all.collections.find((c) => c.id === "b1").folderId, f.id);
    assert.equal(all.collections.find((c) => c.id === "b1").folderUpdatedAt, T0 + 1);
    assert.equal(all.version, 1, "the backup format keeps its version: an older Marginalia imports it and ignores the folders");
    const one = JSON.parse((await P.M.exporter.prepare("json", { scope: "collection", collectionId: "b1", includeImages: false })).text);
    assert.deepEqual(one.folders, []);
    assert.equal(one.collections[0].folderId, f.id);
  });

  test("round trip: a backup imported into an empty library recreates the folders and puts every book and deck back", async () => {
    const A = await page().boot();
    await seed(A, [book("b1"), deck("d1"), book("b2")], [prompt("p1", "b1"), prompt("p2", "d1")]);
    const f = await A.M.cache.createFolder("Physics", null);
    const g = await A.M.cache.createFolder("QM", f.id);
    await A.M.cache.moveCollection("b1", g.id);
    await A.M.cache.moveCollection("d1", f.id);
    const text = (await A.M.exporter.prepare("json", { scope: "all", includeImages: false })).text;
    const B = await page().boot();
    const report = await B.M.exporter.importJSON(text, {});
    assert.equal(report.folders.added, 2);
    assert.match(B.toasts[B.toasts.length - 1], /· 2 new folders/);
    assert.deepEqual(names(B, B.M.cache.folderPath(B.M.cache.folderOf("b1"))), ["Physics", "QM"]);
    assert.equal(nameOf(B, B.M.cache.folderOf("d1")), "Physics");
    assert.equal(B.M.cache.folderOf("b2"), null);
    assert.equal((await B.M.store.meta.get("folders")).length, 2, "stored");
    const again = await B.M.exporter.importJSON(text, {});
    assert.deepEqual([again.folders.added, again.folders.updated, again.folders.unchanged], [0, 0, 2], "a second import changes nothing");
  });
});

describe("the import merge (L1.7)", () => {
  const F = (id, name, parentId, updatedAt, deletedAt) => ({ id, name, parentId, createdAt: 1, updatedAt, deletedAt: deletedAt || null });
  const C = (id, folderId, folderUpdatedAt, extra) => Object.assign(book(id), { folderId, folderUpdatedAt }, extra || {});
  const backupOf = (folders, collections) => ({ format: "marginalia", version: 1, folders, collections: collections || [], prompts: [] });
  const merge = (P, local, backup) => plain(P.M.exporter.merge(local, backup));
  const parents = (r) => Object.fromEntries(r.state.folders.map((f) => [f.id, f.parentId]));

  test("by id: the later updatedAt wins for the name and the parent; new folders are added", () => {
    const P = page();
    const r = merge(P, { folders: [F("A", "Physics", null, 10), F("B", "QM", null, 10)], collections: [] },
      backupOf([F("A", "Physik", null, 20), F("B", "Quantum", "A", 5), F("C", "New", "A", 3)]));
    const byId = Object.fromEntries(r.state.folders.map((f) => [f.id, f]));
    assert.deepEqual([byId.A.name, byId.A.parentId, byId.A.updatedAt], ["Physik", null, 20], "the backup's newer record wins");
    assert.deepEqual([byId.B.name, byId.B.parentId], ["QM", null], "the local newer record wins, name and parent");
    assert.deepEqual([byId.C.name, byId.C.parentId], ["New", "A"]);
    assert.deepEqual(r.report.folders, { added: 1, updated: 1, unchanged: 1, skipped: 0, removed: 0 });
  });

  test("a parent missing after the merge → the top level; a deleted parent → the nearest live folder above it", () => {
    const P = page();
    const r = merge(P, { folders: [F("P", "Physics", null, 1), F("Q", "QM", "P", 20, 20)], collections: [] },
      backupOf([F("R", "Problems", "Q", 25), F("S", "Stray", "nowhere", 4), F("T", "Under stray", "S", 4)]));
    assert.deepEqual(parents(r), { P: null, Q: "P", R: "P", S: null, T: "S" });
  });

  test("a cycle is broken by moving the newer folder to the top level", () => {
    const P = page();
    // here: B is inside A; the backup (another browser) moved A into B later
    const r = merge(P, { folders: [F("A", "A", null, 10), F("B", "B", "A", 10)], collections: [] },
      backupOf([F("A", "A", "B", 30), F("B", "B", null, 5)]));
    assert.deepEqual(parents(r), { A: null, B: "A" });
    // a longer loop arriving whole: X → Y → Z → X; Z is the newest
    const r2 = merge(P, { folders: [], collections: [] }, backupOf([F("X", "X", "Z", 3), F("Y", "Y", "X", 4), F("Z", "Z", "Y", 9)]));
    assert.deepEqual(parents(r2), { X: "Z", Y: "X", Z: null });
  });

  test("a tombstone newer than the other side's record wins; the deleted folder's books move up one level", () => {
    const P = page();
    const r = merge(P, { folders: [F("P", "Physics", null, 1), F("Q", "QM", "P", 10)], collections: [C("b1", "Q", 10)] },
      backupOf([F("Q", "QM", "P", 30, 30)], []));
    const q = r.state.folders.find((f) => f.id === "Q");
    assert.equal(q.deletedAt, 30);
    assert.equal(r.report.folders.removed, 1);
    assert.equal(r.state.collections[0].folderId, "P", "nothing is deleted: the book moves to the parent");
    assert.equal(r.state.collections[0].deletedAt, null);
    const r2 = merge(P, { folders: [F("Q", "QM", null, 40)], collections: [] }, backupOf([F("Q", "QM", null, 30, 30)]));
    assert.equal(r2.state.folders[0].deletedAt, null, "an older tombstone loses to a newer record");
  });

  test("a book's folder follows the newer folderUpdatedAt, not its updatedAt; a dangling folderId lands at the top level", () => {
    const P = page();
    const local = { folders: [F("A", "A", null, 1), F("B", "B", null, 1)], collections: [C("b1", "A", 50, { updatedAt: 50 }), C("b2", "A", 10, { updatedAt: 10 })] };
    const r = merge(P, local, backupOf([], [
      C("b1", "B", 20, { updatedAt: 90, lastPosition: { pageIndex: 30, fraction: 0, zoom: "fit" } }),   // read later elsewhere, moved earlier
      C("b2", "B", 60, { updatedAt: 60 }),
      C("b3", "gone", 60)
    ]));
    const byId = Object.fromEntries(r.state.collections.map((c) => [c.id, c]));
    assert.equal(byId.b1.folderId, "A", "the local move is newer than the backup's");
    assert.equal(byId.b1.lastPosition.pageIndex, 30, "the reading position still follows updatedAt");
    assert.equal(byId.b2.folderId, "B");
    assert.equal(byId.b2.folderUpdatedAt, 60);
    assert.equal(byId.b3.folderId, null, "a folder the merge does not know: the top level");
  });

  test("an older backup without folders changes no folder and no folderId", () => {
    const P = page();
    const local = { folders: [F("A", "A", null, 1)], collections: [C("b1", "A", 5)] };
    const r = merge(P, local, { format: "marginalia", version: 1, collections: [book("b1", { updatedAt: T0 + 99 })], prompts: [] });
    assert.equal(r.state.collections[0].folderId, "A");
    assert.deepEqual(r.report.changed.folders, []);
  });

  test("importJSON stores the merged folders before the books (one write), and an import never deletes a book", async () => {
    const P = await page().boot();
    await seed(P, [book("b1")], [prompt("p1", "b1")]);
    const f = await P.M.cache.createFolder("Mine", null, { now: T0 });
    await P.M.cache.moveCollection("b1", f.id, { now: T0 });
    const report = await P.M.exporter.importJSON(JSON.stringify(backupOf([Object.assign({}, plain(P.M.cache.folder(f.id)), { updatedAt: T0 + 5, deletedAt: T0 + 5 })])), {});
    assert.equal(report.folders.removed, 1);
    assert.equal(P.M.cache.folder(f.id).deletedAt, T0 + 5);
    assert.equal(P.M.cache.collection("b1").deletedAt, null);
    assert.equal(P.M.cache.prompt("p1").deletedAt, null);
    assert.equal(P.M.cache.folderOf("b1"), null, "read: the top level");
    assert.match(P.toasts[P.toasts.length - 1], /1 folder deleted, as in the backup/);
  });
});

/* ------------------------------------------------------------------ unchanged elsewhere */

describe("unchanged: Obsidian note paths, Anki and Markdown (L1.6, L1.7)", () => {
  test("a book in a folder still sends to <obsidianFolder>/<nickname>.md", async () => {
    const P = await page().boot();
    assert.equal(P.M.settings.set("obsidian", true), true);   // DECISIONS D32: the Obsidian connection is switched on
    await seed(P, [book("b1", { name: "Griffiths" })], [prompt("p1", "b1", { kind: "note", text: "a note", cards: [] })]);
    const f = await P.M.cache.createFolder("Physics", null);
    await P.M.cache.moveCollection("b1", f.id);
    const plan = await P.M.obsidian.planAll("b1");
    assert.equal(plan.ok, true);
    assert.equal(plan.file, "Notes/Marginalia/Griffiths.md");
    assert.ok(!/folderId|folderOf/.test(fs.readFileSync(path.join(JS, "obsidian.js"), "utf8")), "js/obsidian.js never reads the library folders");
  });

  test("Anki TSV and Markdown are the same with and without folders", async () => {
    const P = await page().boot();
    await seed(P, [book("b1", { name: "Griffiths" }), deck("d1", { name: "Verbs" })], [prompt("p1", "b1"), prompt("p2", "d1", { kind: "cloze", text: "Der Hund {bellt}." })]);
    const before = [(await P.M.exporter.prepare("anki", { scope: "all" })).text, (await P.M.exporter.prepare("markdown", { scope: "all" })).text];
    const f = await P.M.cache.createFolder("Physics", null);
    await P.M.cache.moveCollection("b1", f.id);
    await P.M.cache.moveCollection("d1", f.id);
    const after = [(await P.M.exporter.prepare("anki", { scope: "all" })).text, (await P.M.exporter.prepare("markdown", { scope: "all" })).text];
    assert.deepEqual(after, before);
  });
});

describe("no loop is ever stored (the API)", () => {
  test("saveFolders stores a loop it is given cut at its newest folder, and a parent naming no folder as the top level", async () => {
    const P = await page().boot();
    await P.M.cache.saveFolders([
      { id: "fX", name: "X", parentId: "fY", createdAt: 1, updatedAt: 9, deletedAt: null },
      { id: "fY", name: "Y", parentId: "fX", createdAt: 1, updatedAt: 3, deletedAt: null },
      { id: "fZ", name: "Z", parentId: "f_nowhere", createdAt: 1, updatedAt: 3, deletedAt: null }
    ]);
    const stored = Object.fromEntries(plain(await P.M.store.meta.get("folders")).map((f) => [f.id, f.parentId]));
    assert.deepEqual(stored, { fX: null, fY: "fX", fZ: null });
  });

  // Repair LIB-2 (2026-11-11): the folder the readers cut need not be one of the records saved.
  test("saveFolders: one record that closes a loop with a folder already here is stored cut where the readers cut it", async () => {
    const P = await page().boot();
    await P.M.cache.saveFolders([
      { id: "fX", name: "X", parentId: null, createdAt: 1, updatedAt: T0 + 1, deletedAt: null },
      { id: "fY", name: "Y", parentId: "fX", createdAt: 1, updatedAt: T0 + 2, deletedAt: null }
    ]);
    P.events.length = 0;
    await P.M.cache.saveFolders([{ id: "fX", name: "X", parentId: "fY", createdAt: 1, updatedAt: T0 + 1, deletedAt: null }]);
    assert.equal(P.M.cache.folderParent("fY"), null, "the readers cut at the newest folder, Y");
    assert.equal(P.M.cache.folderParent("fX"), "fY");
    const stored = Object.fromEntries(plain(await P.M.store.meta.get("folders")).map((f) => [f.id, f.parentId]));
    assert.deepEqual(stored, { fX: "fY", fY: null }, "no loop in the stored record: Y is stored at the top level");
    assert.equal(P.M.cache.folder("fY").updatedAt, T0 + 2, "its stamp stays (an import is not an edit)");
    assert.deepEqual(P.of("folders:changed").map((e) => e.folderIds.slice().sort()), [["fX", "fY"]], "one event naming both");
    await P.M.cache.load();                                   // a reload reads the same tree
    assert.deepEqual([P.M.cache.folderParent("fX"), P.M.cache.folderParent("fY")], ["fY", null]);
  });

  test("restoreFolder never puts back a child that sits above the folder by then", async () => {
    const P = await page().boot();
    const a = await P.M.cache.createFolder("A", null, { now: T0 });
    const b = await P.M.cache.createFolder("B", a.id, { now: T0 });
    const r = await P.M.cache.removeFolder(a.id, { now: T0 + 1 });          // B goes to the top level
    // a hand-made state: A's tombstone now names B as its parent while B still carries the delete's stamp
    P.M.cache.folder(a.id).parentId = b.id;
    await P.M.cache.restoreFolder(a.id, r, { now: T0 + 2 });
    assert.equal(P.M.cache.folderParent(a.id), b.id);
    assert.equal(P.M.cache.folderParent(b.id), null, "B stays where it is: back in A it would close a loop");
  });
});
