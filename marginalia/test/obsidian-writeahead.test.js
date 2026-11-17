"use strict";
// test/obsidian-writeahead.test.js — FEATURES A9.2 with the real M.cache and M.store (memory backend): before a request
// that may write blocks (POST /api/obsidian/note, /notes) leaves, every card in it has its marker (obsidianPendingFile =
// the request's note) IN THE STORE, so a tab that never sees the answer (closed, reloaded, stepped aside) leaves the
// marker behind; the answer then settles it there (written: the send record; a 4xx JSON refusal or a per-block
// ok: false: put back; a 5xx, no answer, a cut body: kept). The writes go through M.cache.patchPrompts: no prompt:saved,
// never a content edit, one store write before a request and one after, so a send-all of 200 cards costs no
// re-render per card. Repairs of the A9 review (2026-11-10): a claude.ai copy that already holds a card takes the marker
// from a backup made since (D1), an import saving while a send is on its way keeps that send's marker or record (D4),
// and a write-ahead the store refuses sends nothing (A9-R3). Nothing here opens a URI or touches a vault: the opener
// and fetch are stubs.
// Run from the app folder: node --test
const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const M = globalThis.Marginalia = globalThis.Marginalia || {};
const JS = path.join(__dirname, "..", "js");
for (const name of ["util", "bus", "scheduler", "prompts", "markup", "exporter", "store", "cache"]) require(path.join(JS, name + ".js"));
const O = require(path.join(JS, "obsidian.js"));
const store = M.store, cache = M.cache, bus = M.bus;

const T0 = Date.UTC(2026, 10, 1);
const NOTE = "Notes/Marginalia/Griffiths.md";
const ONE_VAULT = { vaults: [{ id: "v1", name: "Test Vault", open: true, attachmentFolder: "/" }], replaceOnly: true };
const wait = (ms) => new Promise((r) => setTimeout(r, ms || 0));
const answer = (status, body) => ({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });

let toasts = [], saved = [], writes = { put: 0, putMany: 0 }, opened = [], fetches = [], n = 0, refuseMany = 0;
const realPut = store.prompts.put, realPutMany = store.prompts.putMany;
store.prompts.put = function () { writes.put++; return realPut.apply(this, arguments); };
// refuseMany: the next that many putMany calls fail as a full disk does (IndexedDB aborts the transaction: nothing stored)
store.prompts.putMany = function () {
  writes.putMany++;
  if (refuseMany > 0) { refuseMany--; return Promise.reject(Object.assign(new Error("The quota has been exceeded."), { name: "QuotaExceededError" })); }
  return realPutMany.apply(this, arguments);
};
bus.on("prompt:saved", (e) => saved.push(e && e.prompt && e.prompt.id));

// A book of `count` Q/A cards, stored through the real cache (each its own content stamp), and a fresh obsidian state.
async function setup(count, reply) {
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
  toasts = []; saved = []; opened = []; fetches = []; writes = { put: 0, putMany: 0 }; refuseMany = 0;
  M.app = { toast: (o) => { toasts.push(o); return { close() {} }; }, isArtifact: () => false };
  M.settings = { get: (k) => ({ obsidian: true, obsidianVault: "", obsidianFolder: "Notes/Marginalia" })[k] };   // D32: switched on
  globalThis.location = { protocol: "http:", origin: "http://127.0.0.1:8765", hostname: "127.0.0.1" };
  Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true, value: { clipboard: { writeText: () => Promise.resolve() } } });
  O._reset();
  O._setOpener((uri) => { opened.push(uri); });
  O._setFetch((url, init) => {
    fetches.push({ url, init });
    if (/\/vaults$/.test(url)) return Promise.resolve(answer(200, ONE_VAULT));
    const r = reply(url, init);
    return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
  });
  return { bid, ids };
}
const storedMarker = async (id) => (await store.prompts.get(id)).obsidianPendingFile;
const posted = (url) => fetches.filter((f) => f.url === url);
afterEach(() => { O._reset(); delete globalThis.location; delete globalThis.navigator; });

describe("write-ahead with the real cache and store (FEATURES A9.2)", () => {
  test("a single send stores the marker before the request leaves: a tab that never sees the answer leaves it in the store", async () => {
    let atRequest = null;
    const { ids } = await setup(1, (url) => {
      if (url === "/api/obsidian/note") atRequest = store.prompts.get(ids[0]).then((r) => r.obsidianPendingFile);
      return new Promise(() => {});                          // the answer never comes: the tab is closed meanwhile
    });
    const rec = cache.prompt(ids[0]), stamp = rec.contentUpdatedAt;
    O.send(ids[0], { fromGesture: true });
    for (let i = 0; i < 50 && !atRequest; i++) await wait(1);
    assert.ok(atRequest, "the request left");
    assert.equal(await atRequest, NOTE, "the marker was in the store when the request left");
    assert.equal(await storedMarker(ids[0]), NOTE);
    assert.equal(cache.prompt(ids[0]), rec, "changed in place: the record keeps its identity");
    assert.deepEqual([rec.obsidianPendingFile, rec.obsidianSentAt, rec.contentUpdatedAt], [NOTE, undefined, stamp], "no send, no content edit");
    assert.deepEqual([saved, writes.put, writes.putMany], [[], 0, 1], "no prompt:saved; one store write");
    // what the tab that reads the store next sees (a reload, the newer tab): the marker, so a link holds the card back
    await cache.load();
    assert.equal(cache.prompt(ids[0]).obsidianPendingFile, NOTE);
    O._reset();
    O._setOpener((uri) => { opened.push(uri); });
    O._setFetch(() => Promise.reject(new TypeError("Failed to fetch")));      // the server is down now: obsidian:// links
    const res = await O.send(ids[0], { fromGesture: true });
    assert.deepEqual([res.ok, res.mode, opened.length], [false, "link", 0], "no link: it may be in the note already");
    assert.equal(toasts[toasts.length - 1].text, "1 card may already be in Obsidian: a send to Marginalia's server did not finish. " +
      "Start Marginalia with the marginalia command and send again: it checks the note and never adds a second copy.");
  });

  test("the answer settles the marker in the store: written → the record; a 4xx JSON refusal → put back; a 5xx, no answer or a cut body → kept", async () => {
    const cases = [
      ["written", () => answer(200, { ok: true, file: NOTE, created: true, replaced: false }), undefined, true],
      ["400", () => answer(400, { ok: false, error: "unknown vault" }), undefined, false],
      ["404", () => answer(404, { ok: false, error: "not found" }), undefined, false],
      ["409", () => answer(409, { ok: false, error: "the note is read-only (locked in Finder or chmod)" }), undefined, false],
      ["413", () => answer(413, { ok: false, error: "too large" }), undefined, false],
      ["500", () => answer(500, { ok: false, error: "unexpected error" }), NOTE, false],
      ["502 not JSON", () => ({ ok: false, status: 502, json: () => Promise.reject(new SyntaxError("not JSON")) }), NOTE, false],
      ["403 not JSON", () => ({ ok: false, status: 403, json: () => Promise.reject(new SyntaxError("not JSON")) }), NOTE, false],
      ["no answer", () => new TypeError("Failed to fetch"), NOTE, false],
      ["cut body", () => ({ ok: true, status: 200, json: () => Promise.reject(new TypeError("network error")) }), NOTE, false]
    ];
    for (const [name, reply, marker, recorded] of cases) {
      const { ids } = await setup(1, (url) => reply(url));
      const stamp = cache.prompt(ids[0]).contentUpdatedAt;
      const res = await O.send(ids[0], { fromGesture: true });
      await wait(1);
      assert.equal(res.ok, recorded, name);
      const s = await store.prompts.get(ids[0]);
      assert.deepEqual([s.obsidianPendingFile, typeof s.obsidianSentAt === "number", s.obsidianFile], [marker, recorded, recorded ? NOTE : undefined], name);
      assert.deepEqual([cache.prompt(ids[0]).obsidianPendingFile, cache.prompt(ids[0]).contentUpdatedAt], [marker, stamp], name);
      assert.equal("obsidianPendingFile" in s, marker !== undefined, name + ": put back means removed, not set to undefined");
      assert.deepEqual(saved, [], name + ": no prompt:saved");
      assert.equal(writes.putMany, marker === NOTE && !recorded ? 1 : 2, name + ": one write ahead, one after unless the marker stays");
    }
  });

  test("a 200-card Send all: every marker in the store in ONE write before /notes leaves, the records in ONE more; no prompt:saved, no content edit", async () => {
    let release, atRequest = null;
    const gate = new Promise((r) => { release = r; });
    const { bid, ids } = await setup(200, (url, init) => {
      const b = JSON.parse(init.body);
      atRequest = Promise.all(ids.map(storedMarker)).then((list) => ({ list, putMany: writes.putMany, put: writes.put }));
      return gate.then(() => answer(200, { ok: true, file: b.file, created: true, results: b.blocks.map((x) => ({ blockId: x.blockId, ok: true, replaced: false })) }));
    });
    const stamps = ids.map((id) => cache.prompt(id).contentUpdatedAt);
    const running = O.sendAll(bid, { fromGesture: true });
    for (let i = 0; i < 100 && !atRequest; i++) await wait(1);
    assert.ok(atRequest, "the request left");
    const seen = await atRequest;
    assert.ok(seen.list.every((f) => f === NOTE), "every card's marker was in the store when /notes left");
    assert.deepEqual([seen.putMany, seen.put], [1, 0], "in one store write");
    assert.deepEqual(saved, []);
    release();
    const res = await running;
    assert.deepEqual([res.ok, res.sent, res.added], [true, 200, 200]);
    assert.equal(posted("/api/obsidian/notes").length, 1);
    assert.deepEqual([writes.putMany, writes.put], [2, 0], "the records in one more write");
    assert.deepEqual(saved, [], "no prompt:saved at all: no list or margin re-renders a card for it");
    for (let i = 0; i < ids.length; i++) {
      const s = await store.prompts.get(ids[i]);
      assert.deepEqual([typeof s.obsidianSentAt, s.obsidianFile, "obsidianPendingFile" in s, s.contentUpdatedAt], ["number", NOTE, false, stamps[i]], ids[i]);
    }
    assert.ok(ids.every((id) => O.sendState(cache.prompt(id)) === "unchanged"));
  });

  test("a Send all whose answer never comes leaves every marker in the store; the next Send all, the server back, settles them", async () => {
    let lose = true;
    const notes = new Map();
    const { bid, ids } = await setup(3, (url, init) => {
      const b = JSON.parse(init.body), held = notes.get(b.file) || [];
      const results = b.blocks.map((x) => {
        const replaced = held.includes(x.blockId);
        if (!replaced) held.push(x.blockId);
        return { blockId: x.blockId, ok: true, replaced };
      });
      notes.set(b.file, held);
      return lose ? new TypeError("Failed to fetch") : answer(200, { ok: true, file: b.file, created: false, results });
    });
    const first = await O.sendAll(bid, { fromGesture: true });
    assert.deepEqual([first.sent, first.failed.length], [0, 3]);
    for (const id of ids) assert.equal(await storedMarker(id), NOTE, id);
    await cache.saveCollection(Object.assign({}, cache.collection(bid), { name: "Griffiths, renamed" }), { now: T0 + 500 });
    lose = false;
    const second = await O.sendAll(bid, { fromGesture: true });
    assert.deepEqual([second.ok, second.added, second.updated], [true, 0, 3], "the copies the lost request wrote are updated");
    assert.deepEqual(Array.from(notes.keys()), [NOTE], "in the note it was writing to, never a second note");
    assert.equal(notes.get(NOTE).length, 3, "one copy of each card");
    for (const id of ids) assert.equal(await storedMarker(id), undefined, id);
    assert.deepEqual(saved.filter((id) => ids.includes(id)), [], "no prompt:saved");
  });
});

// ------------------------------------------------------------------ repairs after the A9 review (2026-11-10)

// A backup as M.exporter.toJSON writes it, with the prompts in the given order (importJSON saves them in that order).
const backupText = (col, prompts) => JSON.stringify({ format: "marginalia", version: 1, schedulerVersion: 1, exportedAt: T0 + 1000,
  scope: "all", settings: {}, collections: [col], prompts, attachments: [] });
const clone = (o) => JSON.parse(JSON.stringify(o));

describe("repairs: an import, a refused store write (the A9 review of 2026-11-10)", () => {
  test("D1: a claude.ai copy that already holds the card takes the marker from a backup made since, and its obsidian:// links leave the card alone", async () => {
    const { bid, ids } = await setup(2, () => new Promise(() => {}));
    M.app.isArtifact = () => true;                         // this library is the claude.ai copy: links only
    // the marginalia library's backup after its Send all was cut off: the same cards, with the marker
    const theirs = ids.map((id) => Object.assign(clone(cache.prompt(id)), { obsidianPendingFile: NOTE }));
    const report = await M.exporter.importJSON(backupText(clone(cache.collection(bid)), theirs));
    assert.deepEqual([report.added, report.updated, report.failed], [0, 2, 0]);
    for (const id of ids) {
      assert.equal(cache.prompt(id).obsidianPendingFile, NOTE, id);
      assert.equal(await storedMarker(id), NOTE, id + " (store)");
    }
    const res = await O.send(ids[0], { fromGesture: true });
    assert.deepEqual([res.ok, res.mode, res.error, opened.length], [false, "link", "a send to Marginalia's server did not finish", 0]);
    const plan = await O.planAll(bid);
    assert.deepEqual([plan.mode, plan.count, plan.held], ["link", 0, 2]);
    const all = await O.sendAll(bid, { fromGesture: true });
    assert.deepEqual([all.sent, all.held.length, opened.length], [0, 2, 0], "no link: the note may hold them already");
    // the marginalia library settles them (a later send recorded into that very note); its next backup clears the doubt here
    const settled = ids.map((id) => Object.assign(clone(cache.prompt(id)), { obsidianSentAt: T0 + 2000, obsidianFile: NOTE }));
    settled.forEach((p) => { delete p.obsidianPendingFile; });
    await M.exporter.importJSON(backupText(clone(cache.collection(bid)), settled));
    for (const id of ids) {
      const s = await store.prompts.get(id);
      assert.deepEqual(["obsidianPendingFile" in s, s.obsidianSentAt, s.obsidianFile], [false, T0 + 2000, NOTE], id);
    }
    const after = await O.planAll(bid);
    assert.deepEqual([after.count, after.held, after.unchanged], [0, 0, 2], "already there: nothing held back, nothing sent");
  });

  test("D4: an import that begins while a send is on its way keeps that send's marker, and its record when the answer comes while the import saves", async () => {
    // Since FEATURES A10.1 no send leaves while an import is saving (test/obsidian-import.test.js), so the send here
    // leaves first: its marker is written ahead and its request is out when the import begins.
    for (const how of ["lost", "answered"]) {
      let release, atRequest = false;
      const gate = new Promise((r) => { release = r; });
      const { bid, ids } = await setup(1, () => {
        atRequest = true;
        return gate.then(() => {
          if (how === "lost") throw new TypeError("Failed to fetch");       // the server wrote it; the page hears nothing
          return answer(200, { ok: true, file: NOTE, created: true, replaced: false });
        });
      });
      const X = ids[0];
      // the backup: two prompts new here, then X edited on the other library (so the import saves a merged copy of X)
      const fresh = [0, 1].map((i) => ({ id: bid + "_n" + i, collectionId: bid, kind: "note", text: "new " + i, tags: [], flagged: false,
        anchor: null, context: null, cards: [], createdAt: T0 + 50, contentUpdatedAt: T0 + 50, updatedAt: T0 + 50, deletedAt: null, v: 1 }));
      const edited = Object.assign(clone(cache.prompt(X)), { text: "Q. card 0, edited there?\nA. yes", contentUpdatedAt: T0 + 100, updatedAt: T0 + 100 });
      // the user sends X; the import begins while its request is out
      const sending = O.send(X, { fromGesture: true });
      for (let i = 0; i < 100 && !atRequest; i++) await wait(1);
      assert.ok(atRequest, how + ": the request left");
      assert.equal(cache.prompt(X).obsidianPendingFile, NOTE, how + ": written ahead");
      // "answered": the answer comes while the import saves the first new prompt (the merge was already made, from a
      // record that held only the marker), so only the re-merge right before X is saved keeps the record
      const realSave = cache.savePrompt;
      let answered = false;
      cache.savePrompt = async function (p, o) {
        if (how === "answered" && p.id === fresh[0].id && !answered) {
          answered = true;
          release();
          await sending;
          assert.equal(typeof cache.prompt(X).obsidianSentAt, "number", "answered while the import saves");
        }
        return realSave.call(this, p, o);
      };
      let report;
      try { report = await M.exporter.importJSON(backupText(clone(cache.collection(bid)), fresh.concat([edited]))); }
      finally { cache.savePrompt = realSave; }
      if (how === "lost") { release(); await sending; }
      assert.deepEqual([report.added, report.updated, report.failed], [2, 1, 0], how);
      const now = cache.prompt(X), s = await store.prompts.get(X);
      assert.equal(s.text, edited.text, how + ": the import's merge landed");
      if (how === "lost") {
        assert.deepEqual([now.obsidianPendingFile, s.obsidianPendingFile, s.obsidianSentAt], [NOTE, NOTE, undefined], how + ": the marker stays");
        M.app.isArtifact = () => true;
        O._reset();
        O._setOpener((uri) => { opened.push(uri); });
        const res = await O.send(X, { fromGesture: true });
        assert.deepEqual([res.ok, res.mode, opened.length], [false, "link", 0], "a link leaves it alone");
      } else {
        assert.deepEqual([typeof s.obsidianSentAt, s.obsidianFile, "obsidianPendingFile" in s], ["number", NOTE, false], how + ": the record stays");
        assert.equal(now.obsidianSentAt, s.obsidianSentAt);
      }
    }
  });

  test("A9-R3: a write-ahead the store refuses stops the send: no request, no marker left behind, nothing offered as sent", async () => {
    const { bid, ids } = await setup(3, (url, init) => {
      const b = JSON.parse(init.body);
      if (url === "/api/obsidian/note") return answer(200, { ok: true, file: b.file, created: true, replaced: false });
      return answer(200, { ok: true, file: b.file, created: true, results: b.blocks.map((x) => ({ blockId: x.blockId, ok: true, replaced: false })) });
    });
    refuseMany = 1;                                        // the disk is full when the marker is written
    const res = await O.send(ids[0], { fromGesture: true });
    assert.equal(posted("/api/obsidian/note").length, 0, "the request never left");
    assert.deepEqual([res.ok, res.mode, res.error], [false, "server", "Marginalia could not save, so nothing was sent"]);
    assert.deepEqual([cache.prompt(ids[0]).obsidianPendingFile, await storedMarker(ids[0]), cache.prompt(ids[0]).obsidianSentAt], [undefined, undefined, undefined]);
    const t = toasts[toasts.length - 1];
    assert.deepEqual([t.text, t.actions.map((a) => a.label)], ["Could not add to Obsidian — Marginalia could not save, so nothing was sent", ["Copy note"]]);
    assert.ok(toasts.some((x) => x.text === "Could not save"), "the cache says so too");
    // Send all: the first request's write-ahead is refused, so nothing goes at all
    refuseMany = 1;
    const all = await O.sendAll(bid, { fromGesture: true });
    assert.equal(posted("/api/obsidian/notes").length, 0, "no /notes request");
    assert.deepEqual([all.sent, all.failed.map((f) => f.error)], [0, ids.map(() => "Marginalia could not save, so nothing was sent")]);
    for (const id of ids) assert.deepEqual([cache.prompt(id).obsidianPendingFile, await storedMarker(id)], [undefined, undefined], id);
    // the store takes writes again: the next send goes, written ahead and settled as before
    const ok = await O.send(ids[0], { fromGesture: true });
    assert.deepEqual([ok.ok, posted("/api/obsidian/note").length], [true, 1]);
  });
});
