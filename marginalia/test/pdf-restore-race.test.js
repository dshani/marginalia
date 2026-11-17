"use strict";
// test/pdf-restore-race.test.js — repair B9-R1 / LIB-1 (2026-11-11) of FEATURES B9.5 (BUILD-NOTES "Automatic backup",
// "PDFs, restore"): M.library.attachPdf stores a PDF from the backup folder in ONE store transaction (the book's record
// and its chunks); a rename, a move to a folder, a delete or its Undo made meanwhile queues its own store write behind
// that transaction, and the record attachPdf writes afterwards must be the book as it is THEN, plus only what the PDF
// adds. A book deleted meanwhile stays deleted (its delete removed the chunks), and the delete's Undo brings its prompts
// back. Each test is a fresh vm page running the REAL js/util, bus, settings, store (memory backend), scheduler,
// prompts, context, markup, cache, library and backup modules, with a stub M.app (toast, confirm "yes"). The person's
// action runs once the real saveDocument has committed and before attachPdf goes on, the order IndexedDB gives a write
// queued behind the store write. No DOM, no network (M.backup's fetch is a stub), no vault, no backup folder.
// Run: node --test test/pdf-restore-race.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");

const JS = path.join(__dirname, "..", "js");
const MODULES = ["util", "bus", "settings", "store", "scheduler", "prompts", "context", "markup", "cache", "library", "backup"];
const T0 = Date.UTC(2026, 10, 2, 12);
const DAY = 86400000;
const plain = (v) => JSON.parse(JSON.stringify(v));
const unref = (t) => { if (t && typeof t.unref === "function") t.unref(); return t; };

function page() {
  const toasts = [];
  const win = {
    console: { log() {}, info() {}, debug() {}, warn() {}, error() {} },
    setTimeout: (fn, ms, ...a) => unref(setTimeout(fn, ms, ...a)), clearTimeout,
    setInterval: (fn, ms) => unref(setInterval(fn, ms)), clearInterval,
    queueMicrotask, structuredClone, crypto: webcrypto, TextEncoder, TextDecoder, Intl,
    location: { protocol: "http:", hostname: "127.0.0.1", origin: "http://127.0.0.1:8791", search: "", hash: "", pathname: "/" }
  };
  win.window = win; win.self = win;
  const ctx = vm.createContext(win);
  for (const name of MODULES) vm.runInContext(fs.readFileSync(path.join(JS, name + ".js"), "utf8"), ctx, { filename: "js/" + name + ".js" });
  const M = win.Marginalia;
  M.app = {
    toast(o) { toasts.push(o && o.text); return { close() {} }; },
    confirm() { return Promise.resolve(true); }
  };
  return { M, win, toasts };
}

function pdfBody(tag) { return new TextEncoder().encode("%PDF-1.7\n% " + tag + "\n" + "x".repeat(300) + "\n%%EOF\n"); }
async function hexOf(u8) { return Buffer.from(await webcrypto.subtle.digest("SHA-256", u8)).toString("hex"); }
function book(id, sha, extra) {
  return Object.assign({ id, kind: "book", name: "Griffiths", sha256: sha, hashAlgo: "sha-256", pageCount: 12, pageLabels: null,
    sections: [], lastPosition: { pageIndex: 3, fraction: 0.5, zoom: "fit" }, hasBytes: false, chunkCount: 0, addedAt: T0, lastOpenedAt: T0,
    updatedAt: T0, deletedAt: null, v: 1 }, extra || {});
}
function prompt(id, collectionId) {
  return { id, collectionId, kind: "qa", text: "Q. " + id + "?\nA. yes", tags: [], flagged: false, anchor: null, context: null,
    cards: [{ i: 0, createdAt: T0 - 30 * DAY, lastReviewedAt: null, intervalMs: 5 * DAY, dueAt: T0 - DAY, log: [] }],
    createdAt: T0 - 30 * DAY, contentUpdatedAt: T0 - 30 * DAY, updatedAt: T0 - 30 * DAY, deletedAt: null, v: 1 };
}

// A library with the book "bk" (no bytes in this browser, the SHA-256 of u8), its two prompts and a folder "Physics".
async function library() {
  const P = page(), M = P.M;
  const u8 = pdfBody("one"), sha = await hexOf(u8);
  await M.store.open();
  await M.store.collections.put(book("bk", sha));
  await M.store.prompts.put(prompt("p1", "bk"));
  await M.store.prompts.put(prompt("p2", "bk"));
  await M.cache.load();
  const physics = await M.cache.createFolder("Physics", null);
  return Object.assign(P, { u8, sha, physics });
}

// The person acts "while the PDF is stored": after the real saveDocument committed, before attachPdf goes on.
function during(P, act) {
  const docs = P.M.store.docs, real = docs.saveDocument;
  docs.saveDocument = function (rec, bytes) {
    return real.call(docs, rec, bytes).then(async (saved) => { docs.saveDocument = real; await act(); return saved; });
  };
}
// The store's own failure path (an aborted transaction): a stub of the record it was given, then code "store".
function failing(P, act) {
  const docs = P.M.store.docs, real = docs.saveDocument;
  docs.saveDocument = async function (rec) {
    docs.saveDocument = real;
    await act();
    await P.M.store.collections.put(Object.assign({}, rec, { hasBytes: false, chunkCount: 0 }));
    throw Object.assign(new Error("The PDF could not be stored"), { code: "store" });
  };
}
const code = (p) => p.then(() => "attached", (e) => e.code);
const settle = () => new Promise((r) => setTimeout(r, 5));          // the Undo's store write (the memory backend is quick)
async function stored(P, id) { return P.M.store.collections.get(id); }
async function livePrompts(P, id) {
  const inCache = P.M.cache.promptsOf(id).filter((p) => !p.deletedAt).length;
  const inStore = (await P.M.store.prompts.byCollection(id)).filter((p) => !p.deletedAt).length;
  return [inCache, inStore];
}
async function sameBytes(P, id, u8) {
  const got = await P.M.store.docs.loadBytes(id);
  return !!got && Buffer.from(got).equals(Buffer.from(u8));
}

test("a rename made while the PDF is stored is kept, in the cache and in the store; the book gets its bytes", async () => {
  const P = await library();
  during(P, () => P.M.library.renameCollection("bk", "Intro to QM"));
  const rec = await P.M.library.attachPdf("bk", P.u8);
  assert.equal(rec, P.M.cache.collection("bk"), "attachPdf answers the cached record");
  assert.deepEqual([P.M.cache.collection("bk").name, P.M.cache.collection("bk").hasBytes], ["Intro to QM", true]);
  const s = await stored(P, "bk");
  assert.deepEqual([s.name, s.hasBytes, s.chunkCount, s.byteLength], ["Intro to QM", true, 1, P.u8.length]);
  assert.ok(await sameBytes(P, "bk", P.u8), "the chunks hold the PDF");
});

test("a move into a folder made while the PDF is stored is kept, in the cache and in the store", async () => {
  const P = await library();
  during(P, () => P.M.library.moveTo("collection", "bk", P.physics.id));
  await P.M.library.attachPdf("bk", P.u8);
  assert.equal(P.M.cache.folderOf(P.M.cache.collection("bk")), P.physics.id, "the cache keeps the move");
  assert.equal(P.M.cache.collection("bk").hasBytes, true);
  const s = await stored(P, "bk");
  assert.deepEqual([s.folderId, s.hasBytes], [P.physics.id, true], "the store keeps the move");
  assert.ok(P.toasts.includes("Moved “Griffiths” to “Physics”"));
  assert.ok(await sameBytes(P, "bk", P.u8));
});

test("a book deleted while its PDF is stored stays deleted: no live row without bytes, and its Undo brings the prompts back", async () => {
  const P = await library();
  during(P, () => P.M.library.deleteCollection("bk"));
  assert.equal(await code(P.M.library.attachPdf("bk", P.u8)), "changed", "nothing to restore: the book changed meanwhile");
  const c = P.M.cache.collection("bk");
  assert.ok(c.deletedAt, "the cache keeps the delete");
  assert.deepEqual([c.hasBytes, c.chunkCount], [false, 0]);
  const s = await stored(P, "bk");
  assert.ok(s.deletedAt, "the store keeps the tombstone");
  assert.equal(s.hasBytes, false);
  assert.equal(await P.M.store.docs.loadBytes("bk"), null, "no chunks left behind");
  assert.deepEqual(await livePrompts(P, "bk"), [0, 0]);
  // the delete's Undo, after the restore gave up: the book and its prompts come back, without bytes (as documented)
  assert.equal(P.M.library.undoDelete(), true);
  await settle();
  assert.deepEqual(await livePrompts(P, "bk"), [2, 2], "Undo brings both prompts back, in the cache and in the store");
  assert.deepEqual([P.M.cache.collection("bk").deletedAt, P.M.cache.collection("bk").hasBytes], [null, false]);
  // ... and the next restore attaches its PDF
  await P.M.library.attachPdf("bk", P.u8);
  assert.deepEqual([(await stored(P, "bk")).hasBytes, await sameBytes(P, "bk", P.u8)], [true, true]);
});

test("a delete and its Undo, both while the PDF is stored: the prompts are back and the book offers its PDF again (no hasBytes without chunks)", async () => {
  const P = await library();
  during(P, async () => {
    await P.M.library.deleteCollection("bk");
    assert.equal(P.M.library.undoDelete(), true);
    await settle();
  });
  assert.equal(await code(P.M.library.attachPdf("bk", P.u8)), "changed");
  const c = P.M.cache.collection("bk"), s = await stored(P, "bk");
  assert.deepEqual([c.deletedAt, c.hasBytes], [null, false], "live, and honest about its bytes");
  assert.deepEqual([s.deletedAt, s.hasBytes], [null, false]);
  assert.equal(await P.M.store.docs.loadBytes("bk"), null, "the delete removed the chunks");
  assert.deepEqual(await livePrompts(P, "bk"), [2, 2], "Undo brought the prompts back");
  await P.M.library.attachPdf("bk", P.u8);
  assert.deepEqual([P.M.cache.collection("bk").hasBytes, await sameBytes(P, "bk", P.u8)], [true, true], "the next restore attaches it");
});

test("the store fails (its stub of the old record) while the book is moved: the move stays, the book still lacks its bytes", async () => {
  const P = await library();
  failing(P, () => P.M.library.moveTo("collection", "bk", P.physics.id));
  assert.equal(await code(P.M.library.attachPdf("bk", P.u8)), "store");
  const c = P.M.cache.collection("bk"), s = await stored(P, "bk");
  assert.deepEqual([c.folderId, c.hasBytes, c.deletedAt], [P.physics.id, false, null]);
  assert.deepEqual([s.folderId, s.hasBytes, s.deletedAt], [P.physics.id, false, null], "the store's stale stub is overwritten");
});

test("the store fails (its stub of the old record) while the book is deleted: the book stays deleted in the store too", async () => {
  const P = await library();
  failing(P, () => P.M.library.deleteCollection("bk"));
  assert.equal(await code(P.M.library.attachPdf("bk", P.u8)), "store");
  assert.ok(P.M.cache.collection("bk").deletedAt);
  assert.ok((await stored(P, "bk")).deletedAt, "the tombstone is back over the store's live stub");
  assert.deepEqual(await livePrompts(P, "bk"), [0, 0]);
});

test("end to end: M.backup.restorePdfs while the book is deleted restores nothing and says nothing; the book stays deleted", async () => {
  const P = await library();
  P.M.store.mode = () => "idb";                    // the memory backend would make M.backup stand aside
  P.M.backup._setFetch((url) => {
    if (url === "/api/backup/pdfs") return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, dir: "~/B", files: [{ sha12: P.sha.slice(0, 12), name: "Griffiths [" + P.sha.slice(0, 12) + "].pdf", bytes: P.u8.length }] }) });
    if (url === "/api/backup/pdf/" + P.sha) return Promise.resolve({ ok: true, status: 200, headers: { get: () => String(P.u8.length) }, arrayBuffer: () => Promise.resolve(P.u8.slice().buffer) });
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ ok: false }) });
  });
  during(P, () => P.M.library.deleteCollection("bk"));
  const r = await P.M.backup.restorePdfs();
  assert.deepEqual([r.ok, r.restored, r.failed.length], [true, 0, 0]);
  assert.ok(!P.toasts.some((t) => /^Restored \d+ PDF/.test(t)), "no “Restored 1 PDF” toast");
  assert.ok(P.M.cache.collection("bk").deletedAt);
  assert.ok((await stored(P, "bk")).deletedAt);
  P.M.backup._reset();
});

test("control: with nothing done meanwhile, the record keeps everything and gets its bytes", async () => {
  const P = await library();
  const before = plain(P.M.cache.collection("bk"));
  const rec = await P.M.library.attachPdf("bk", P.u8);
  for (const k of ["id", "name", "sha256", "hashAlgo", "pageCount", "sections", "lastPosition", "lastOpenedAt", "addedAt", "deletedAt"]) {
    assert.deepEqual(plain(rec)[k], before[k], k + " kept");
  }
  assert.deepEqual([rec.hasBytes, rec.chunkCount, rec.byteLength], [true, 1, P.u8.length]);
  assert.ok(await sameBytes(P, "bk", P.u8));
});
