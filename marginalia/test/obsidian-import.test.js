"use strict";
// test/obsidian-import.test.js — FEATURES A10 with the real M.exporter, M.cache and M.store (memory backend):
// A10.1, while an import is saving (M.exporter.isImporting(): set when importJSON is called, before its first write,
// cleared in a finally) no Obsidian send leaves, single send or Send all, server mode or link mode: the toast says
// "Wait until the import finishes, then send again." (no actions), no request, no link, the card unchanged; the same
// send works once the import finished, also after an import that failed. A10.2, a Send all link that waits for its
// toast's "Add to Obsidian" looks at the tab, the import and every planned card again at the click: a card marked
// meanwhile is held back and named, one sent meanwhile is already there, and a tab that stepped aside opens nothing.
// Nothing here opens a URI or touches a vault: the opener and fetch are stubs.
// Run from the app folder: node --test
const { test, describe, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const M = globalThis.Marginalia = globalThis.Marginalia || {};
const JS = path.join(__dirname, "..", "js");
for (const name of ["util", "bus", "scheduler", "prompts", "markup", "exporter", "store", "cache"]) require(path.join(JS, name + ".js"));
const O = require(path.join(JS, "obsidian.js"));
const store = M.store, cache = M.cache, bus = M.bus, X = M.exporter;

const T0 = Date.UTC(2026, 10, 1);
const NOTE = "Notes/Marginalia/Griffiths.md";
const WAIT = "Wait until the import finishes, then send again.";
const IMPORTING = "an import is still saving";
const ONE_VAULT = { vaults: [{ id: "v1", name: "Test Vault", open: true, attachmentFolder: "/" }], replaceOnly: true };
const HELD_LINE = (n) => (n === 1 ? "1 card" : n + " cards") + " may already be in Obsidian: a send to Marginalia's server did not finish. " +
  "Start Marginalia with the marginalia command and send again: it checks the note and never adds a second copy.";
const wait = (ms) => new Promise((r) => setTimeout(r, ms || 0));
const answer = (status, body) => ({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });
const clone = (o) => JSON.parse(JSON.stringify(o));
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }
async function until(pred, what) {
  for (let i = 0; i < 500; i++) { if (pred()) return; await wait(2); }
  throw new Error("timed out waiting for " + (what || pred.toString()));
}

let toasts = [], opened = [], fetches = [], finished = [], n = 0;
bus.on("import:finished", (e) => finished.push(e));

// A book of `count` Q/A cards through the real cache; mode "server" (127.0.0.1 page, a stub server that writes every
// block) or "link" (the claude.ai copy: links only, no request at all).
async function setup(count, mode) {
  await store.open();
  await cache.load();
  const bid = "bk" + (++n);
  await cache.saveCollection({ id: bid, kind: "book", name: "Griffiths", sections: [] }, { now: T0 });
  const ids = [];
  for (let i = 0; i < count; i++) {
    const p = await cache.savePrompt({ id: bid + "_p" + i, collectionId: bid, kind: "qa", text: "Q. card " + i + "?\nA. yes", cards: [],
      anchor: { pageIndex: i, pages: [{ pageIndex: i, rects: [[72, 600, 300, 612]] }], quote: "quote " + i, y: 612, lost: false } },
    { content: true, now: T0 + i });
    ids.push(p.id);
  }
  toasts = []; opened = []; fetches = []; finished = [];
  M.app = { toast: (o) => { toasts.push(o); return { close() {} }; }, isArtifact: () => mode === "link" };
  M.settings = { get: (k) => ({ obsidian: true, obsidianVault: "", obsidianFolder: "Notes/Marginalia" })[k] };   // D32: switched on
  globalThis.location = { protocol: "http:", origin: "http://127.0.0.1:8765", hostname: "127.0.0.1" };
  Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true, value: { clipboard: { writeText: () => Promise.resolve() } } });
  O._reset();
  O._setOpener((uri) => { opened.push(uri); });
  O._setFetch((url, init) => {
    fetches.push({ url, init });
    if (/\/vaults$/.test(url)) return Promise.resolve(answer(200, ONE_VAULT));
    const b = JSON.parse(init.body);
    if (url === "/api/obsidian/note") return Promise.resolve(answer(200, { ok: true, file: b.file, created: true, replaced: false }));
    return Promise.resolve(answer(200, { ok: true, file: b.file, created: false, results: b.blocks.map((x) => ({ blockId: x.blockId, ok: true, replaced: false })) }));
  });
  return { bid, ids };
}
const requests = () => fetches.filter((f) => !/\/vaults$/.test(f.url));
const last = () => toasts[toasts.length - 1] || null;
// A backup holding the book and one note new to this library: importJSON saves that note, which `slowImport` holds.
const backupText = (bid, newId) => JSON.stringify({ format: "marginalia", version: 1, schedulerVersion: 1, exportedAt: T0 + 1000, scope: "all",
  settings: {}, collections: [clone(cache.collection(bid))], attachments: [],
  prompts: [{ id: newId, collectionId: bid, kind: "note", text: "from the backup", tags: [], flagged: false, anchor: null, context: null,
    cards: [], createdAt: T0 + 50, contentUpdatedAt: T0 + 50, updatedAt: T0 + 50, deletedAt: null, v: 1 }] });
// An import that stays in its saves until release(): resolves {done (the import's promise), release}.
async function slowImport(bid) {
  const newId = bid + "_new" + (++n), gate = deferred(), entered = deferred(), realSave = cache.savePrompt;
  cache.savePrompt = async function (p, o) {
    if (p.id === newId) { entered.resolve(); await gate.promise; }
    return realSave.call(this, p, o);
  };
  const done = X.importJSON(backupText(bid, newId));
  assert.equal(X.isImporting(), true, "set at once, before the import's first write");
  await entered.promise;
  return { done: done.finally(() => { cache.savePrompt = realSave; }), release: () => gate.resolve(), newId };
}
afterEach(() => { O._reset(); delete globalThis.location; delete globalThis.navigator; });

describe("FEATURES A10.1: no Obsidian send while an import is saving", () => {
  for (const mode of ["server", "link"]) {
    test(mode + " mode: a single send, O's save and Send all are refused with the toast, send nothing and change no card; afterwards they go", async () => {
      const { bid, ids } = await setup(3, mode);
      const imp = await slowImport(bid);
      assert.equal(X.isImporting(), true);
      const before = clone(cache.prompt(ids[0]));
      const one = await O.send(ids[0], { fromGesture: true });              // "Send to Obsidian", and O's save (the same call)
      assert.deepEqual([one.ok, one.error], [false, IMPORTING]);
      assert.deepEqual([last().text, last().actions || [], last().detail || null], [WAIT, [], null], "the toast, with no actions");
      const plan = await O.planAll(bid);
      assert.deepEqual([plan.ok, plan.importing, plan.error, plan.count], [false, true, IMPORTING, 0]);
      toasts = [];
      const all = await O.sendAll(bid, { fromGesture: true });
      assert.deepEqual([all.ok, all.sent, all.error], [false, 0, IMPORTING]);
      assert.deepEqual(toasts.map((t) => [t.text, (t.actions || []).length]), [[WAIT, 0]], "only the wait toast");
      const later = await O.sendAll(bid, { fromGesture: false });           // the no-gesture path is refused too
      assert.equal(later.error, IMPORTING);
      assert.deepEqual([requests().length, opened.length], [0, 0], "no request, no link");
      assert.deepEqual(clone(cache.prompt(ids[0])), before, "the card stays as it is: no marker, no record");
      for (const id of ids) assert.deepEqual([cache.prompt(id).obsidianPendingFile, cache.prompt(id).obsidianSentAt], [undefined, undefined], id);

      imp.release();
      const report = await imp.done;
      assert.equal(report.added, 1);
      assert.equal(X.isImporting(), false, "cleared once the import finished");
      assert.deepEqual(finished.map((e) => [e.report && e.report.added, e.error]), [[1, null]], "import:finished once");
      const again = await O.send(ids[0], { fromGesture: true });
      assert.deepEqual([again.ok, again.mode], [true, mode]);
      if (mode === "server") assert.equal(requests().length, 1, "the request leaves now");
      else assert.equal(opened.length, 1, "the link opens now");
      const rest = await O.sendAll(bid, { fromGesture: true });
      assert.deepEqual([rest.ok, rest.added], [true, mode === "server" ? 3 : 3], "Send all goes too (the backup's note among them)");
    });
  }

  test("a send waiting for the server's answer to GET /api/obsidian/vaults when an import begins sends nothing", async () => {
    const { bid, ids } = await setup(1, "server");
    const vaults = deferred();
    O._setFetch((url, init) => {
      fetches.push({ url, init });
      if (/\/vaults$/.test(url)) return vaults.promise.then(() => answer(200, ONE_VAULT));
      return Promise.resolve(answer(200, { ok: true, file: NOTE, created: true, replaced: false }));
    });
    const sending = O.send(ids[0], { fromGesture: true });
    await until(() => fetches.length === 1, "the GET");
    const imp = await slowImport(bid);
    vaults.resolve();
    const r = await sending;
    assert.deepEqual([r.ok, r.mode, r.error, requests().length], [false, "server", IMPORTING, 0]);
    assert.equal(last().text, WAIT);
    assert.equal(cache.prompt(ids[0]).obsidianPendingFile, undefined, "no marker written");
    imp.release();
    await imp.done;
  });

  test("a Send all under way stops before its next request when an import begins: the rest is not sent, not marked and not offered to copy", async () => {
    const { bid, ids } = await setup(3, "server");
    O._setSplit(1, 1);                                                     // one card per request
    const first = deferred();
    O._setFetch((url, init) => {
      fetches.push({ url, init });
      if (/\/vaults$/.test(url)) return Promise.resolve(answer(200, ONE_VAULT));
      const b = JSON.parse(init.body);
      const reply = answer(200, { ok: true, file: b.file, created: true, results: b.blocks.map((x) => ({ blockId: x.blockId, ok: true, replaced: false })) });
      return requests().length === 1 ? first.promise.then(() => reply) : Promise.resolve(reply);
    });
    const sending = O.sendAll(bid, { fromGesture: true });
    await until(() => requests().length === 1, "the first request");
    const imp = await slowImport(bid);
    first.resolve();
    const res = await sending;
    assert.equal(requests().length, 1, "no request after the import began");
    assert.deepEqual([res.sent, res.failed.map((f) => f.error)], [1, [IMPORTING, IMPORTING]]);
    const t = last();
    assert.equal(t.text, "1 sent, 2 could not be sent — " + IMPORTING);
    assert.match(t.detail, /Wait until the import finishes, then send again\.$/);
    assert.deepEqual(t.actions.map((a) => a.label), ["Open in Obsidian"], "nothing offered to copy");
    for (const id of ids.slice(1)) assert.deepEqual([cache.prompt(id).obsidianPendingFile, cache.prompt(id).obsidianSentAt], [undefined, undefined], id);
    imp.release();
    await imp.done;
    const rest = await O.sendAll(bid, { fromGesture: true });
    assert.deepEqual([rest.sent, rest.unchanged], [3, 1], "the two left and the backup's note go afterwards");
  });

  test("an import that fails clears the state, early (not a backup) or in the middle of its saves; two at once keep it until both end", async () => {
    const { bid, ids } = await setup(1, "server");
    // early: the text is not a backup (nothing written)
    const bad = X.importJSON("{ not json");
    assert.equal(X.isImporting(), true);
    await assert.rejects(bad, (e) => e.code === "invalid_json");
    assert.equal(X.isImporting(), false);
    assert.deepEqual(finished.map((e) => [e.report, e.error]), [[null, "invalid_json"]]);
    // in the middle of its saves: an error after the first write
    const newId = bid + "_late", realPrompt = cache.prompt;
    cache.prompt = function (id) { if (id === newId) throw new Error("the cache broke"); return realPrompt.apply(this, arguments); };
    try { await assert.rejects(X.importJSON(backupText(bid, newId)), /the cache broke/); }
    finally { cache.prompt = realPrompt; }
    assert.equal(X.isImporting(), false, "never left set by an error");
    assert.equal(finished[1].error, "error");
    const r = await O.send(ids[0], { fromGesture: true });
    assert.deepEqual([r.ok, requests().length], [true, 1], "the same send works");
    // two imports at once: the state stays until the second one ends
    const a = await slowImport(bid);
    const b = X.importJSON("[]");                                          // refused at once: not a backup
    await assert.rejects(b);
    assert.equal(X.isImporting(), true, "the first import still saves");
    assert.equal((await O.send(ids[0], { fromGesture: true })).error, IMPORTING);
    a.release();
    await a.done;
    assert.equal(X.isImporting(), false);
  });
});

describe("FEATURES A10.2: a Send all link opened from its toast looks again at the click", () => {
  async function ready(count) {
    const s = await setup(count, "link");
    const r = await O.sendAll(s.bid, { fromGesture: false });
    assert.deepEqual([r.error, r.sent, opened.length], ["needs_click", 0, 0]);
    const t = last();
    assert.deepEqual([t.text, t.actions.map((a) => a.label)], ["Ready for Obsidian · " + count + " cards · " + NOTE, ["Add to Obsidian"]]);
    s.click = async () => { toasts = []; t.actions[0].run(); await until(() => toasts.length > 0, "the click's toast"); await wait(5); return last(); };
    return s;
  }
  const inLink = (id) => opened.length === 1 && decodeURIComponent(opened[0]).includes("<!-- marginalia:" + id + " -->");

  test("a card marked between the toast and the click is held back and named; the others go in one link", async () => {
    const { ids, click } = await ready(3);
    await cache.patchPrompts([{ id: ids[1], fields: { obsidianPendingFile: NOTE } }]);   // a server send of it began meanwhile
    const t = await click();
    assert.equal(opened.length, 1);
    assert.deepEqual(ids.map(inLink), [true, false, true], "the marked card is not in the link");
    assert.equal(t.text, "Sent to Obsidian · " + NOTE + ": 2 added, 0 updated, 0 already there");
    assert.equal(t.detail, "Sent through an obsidian:// link. " + HELD_LINE(1), "named by the A9.1 line");
    assert.equal(t.ttl, 12000);
    assert.deepEqual(ids.map((id) => typeof cache.prompt(id).obsidianSentAt), ["number", "undefined", "number"]);
    assert.equal(cache.prompt(ids[1]).obsidianPendingFile, NOTE, "its marker stays");
  });

  test("every card marked meanwhile: nothing opens, the held line says why", async () => {
    const { ids, click } = await ready(2);
    await cache.patchPrompts(ids.map((id) => ({ id, fields: { obsidianPendingFile: NOTE } })));
    const t = await click();
    assert.deepEqual([opened.length, t.text, t.actions || []], [0, HELD_LINE(2), []]);
    for (const id of ids) assert.equal(cache.prompt(id).obsidianSentAt, undefined);
  });

  test("a card sent meanwhile is already there, not added again", async () => {
    const { ids, click } = await ready(3);
    await cache.patchPrompts([{ id: ids[2], fields: { obsidianSentAt: T0 + 500, obsidianFile: NOTE } }]);   // its own link went first
    const t = await click();
    assert.deepEqual(ids.map(inLink), [true, true, false]);
    assert.equal(t.text, "Sent to Obsidian · " + NOTE + ": 2 added, 0 updated, 1 already there");
    const title = decodeURIComponent(opened[0]).includes("content=# Griffiths");
    assert.equal(title, false, "the note is known now: no second title line");
  });

  test("a tab that stepped aside between the toast and the click opens nothing and records nothing", async () => {
    const { ids, click } = await ready(2);
    const realLocked = store.locked;
    store.locked = () => ({ reason: "othertab", by: "tab_b", at: T0 });
    try { await click(); } finally { store.locked = realLocked; }
    assert.equal(opened.length, 0);
    for (const id of ids) assert.equal(cache.prompt(id).obsidianSentAt, undefined, id);
  });

  test("an import saving at the click: nothing opens, the wait toast; afterwards Send all goes", async () => {
    const { bid, ids, click } = await ready(2);
    const imp = await slowImport(bid);
    const t = await click();
    assert.deepEqual([opened.length, t.text, t.actions || []], [0, WAIT, []]);
    for (const id of ids) assert.equal(cache.prompt(id).obsidianSentAt, undefined, id);
    imp.release();
    await imp.done;
    const r = await O.sendAll(bid, { fromGesture: true });
    assert.deepEqual([r.ok, r.sent, opened.length], [true, 3, 1]);
  });
});
