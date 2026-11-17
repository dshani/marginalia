"use strict";
// test/cache-writes.test.js — M.cache write outcomes against the real store (memory backend), run with
// `node --test test/cache-writes.test.js`:
//  - savePrompt rejects with code "store" when the store write fails, so attachment GC chained on its success
//    never deletes an image that the persisted text still references; a never-stored new prompt is dropped again;
//  - contentUpdatedAt follows edits a person made (lost-marking, refound positions and recontext keep it),
//    so an import merge keeps the other machine's real text edits;
//  - removeCollection / restoreCollection write their cascade in one transaction;
//  - patchPrompts (FEATURES A9: the Obsidian send record) changes records in place, emits nothing, never moves
//    contentUpdatedAt, writes once for many records, refuses content fields and a tab that stepped aside.
// util, scheduler, context, bus and app are stubbed with their §17 signatures; store, cache, attachments and
// exporter are the real modules.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const DAY = 86400000;
const FIRST = 5 * DAY;
const LOOKAHEAD = 16 * 3600000;
const T0 = 1762150000000;

const events = [];
const toasts = [];
const M = globalThis.Marginalia = globalThis.Marginalia || {};
M.bus = {
  on() { return function () {}; },
  off() {},
  emit(type, payload) { events.push({ type, payload }); }
};
M.util = {
  uuid(prefix) { return (prefix || "") + globalThis.crypto.randomUUID(); },
  localMidnight(now) { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); },
  escapeHtml(s) { return String(s); }
};
// The real scheduler's rules for "can this card be asked now, and from when" (D27: a card never asked is due at once;
// D29: not within 16 hours of an answer to it or to another card of its prompt). It is loaded first: the stand-in below
// then takes its place as M.scheduler.
const REAL = require(path.join(__dirname, "..", "js", "scheduler.js"));
M.scheduler = {
  DAY, FIRST, LOOKAHEAD, SCHEDULER_VERSION: 1,
  newSchedule(now) { return { createdAt: now, lastReviewedAt: null, intervalMs: FIRST, dueAt: now, growth: 2300, log: [] }; },
  isDue: REAL.isDue, isReady: REAL.isReady, readyTime: REAL.readyTime,
  replay(createdAt, log) { return { createdAt, lastReviewedAt: null, intervalMs: FIRST, dueAt: createdAt, log: (log || []).slice() }; }
};
M.context = {
  labelFor(sections, pageIndex) {
    let best = null;
    for (const s of sections || []) if (s.pageIndex <= pageIndex && (!best || s.pageIndex >= best.pageIndex)) best = s;
    return best ? best.label : null;
  },
  contextFor(c, p) {
    const pageIndex = p.anchor && typeof p.anchor.pageIndex === "number" ? p.anchor.pageIndex : null;
    const sectionLabel = c.kind === "book"
      ? (pageIndex === null ? null : M.context.labelFor(c.sections, pageIndex))
      : ((p.context && p.context.sectionLabel) || null);
    return { docName: c.name, sectionLabel, pageIndex, pageLabel: pageIndex === null ? null : String(pageIndex + 1) };
  }
};
M.app = { toast(o) { toasts.push(o); return { close() {} }; } };

const store = require(path.join(__dirname, "..", "js", "store.js"));
const cache = require(path.join(__dirname, "..", "js", "cache.js"));
const attachments = require(path.join(__dirname, "..", "js", "attachments.js"));
const exporter = require(path.join(__dirname, "..", "js", "exporter.js"));

function card(i, createdAt, dueAt) {
  return { i, createdAt, lastReviewedAt: null, intervalMs: FIRST, dueAt, log: [] };
}

function quotaError() {
  const e = new Error("The quota has been exceeded.");
  e.name = "QuotaExceededError";
  return e;
}

// The next call of obj[method] rejects with `error`; the real method is back afterwards.
function failNextCall(obj, method, error) {
  const real = obj[method];
  obj[method] = function () { obj[method] = real; return Promise.reject(error); };
  return () => { obj[method] = real; };
}

// In the next transaction over `storeName`, `method` on that store rejects the way a failing IndexedDB request
// does mid-transaction (QuotaExceededError); the backend then rolls the whole transaction back.
function failInNextTx(storeName, method) {
  const real = store.backend.tx;
  store.backend.tx = function (names, mode, fn) {
    const list = Array.isArray(names) ? names : [names];
    if (list.indexOf(storeName) < 0) return real.call(this, names, mode, fn);
    store.backend.tx = real;
    return real.call(this, names, mode, function (...wrappers) {
      const i = list.indexOf(storeName);
      wrappers[i] = Object.assign({}, wrappers[i], { [method]: () => Promise.reject(quotaError()) });
      return fn(...wrappers);
    });
  };
  return () => { store.backend.tx = real; };
}

function savedToast() { return toasts.some((t) => t && t.text === "Could not save"); }

/* ---------------------------------------------------------------- savePrompt outcome */

test("a failed prompt write rejects with code 'store', so GC chained on success never deletes a still-stored image", async () => {
  await cache.load();
  await cache.saveCollection({ id: "bookG", kind: "book", name: "G" }, { now: T0 });
  await store.attachments.put({ id: "a_1", mime: "image/png", bytes: new Uint8Array([1, 2, 3]).buffer, width: 1, height: 1, byteLength: 3, createdAt: T0 });
  const oldText = "Q. what is shown?\n![snip](att:a_1)\nA. a wave";
  const p = await cache.savePrompt({ id: "pg1", collectionId: "bookG", kind: "qa", text: oldText, cards: [] }, { content: true, now: T0 });

  // The margin editor saves a fresh record with the new text and runs attachments.gc only once the save succeeded.
  const newText = "Q. what is shown?\nA. a wave";
  const rec = Object.assign({}, p, { text: newText });
  toasts.length = 0;
  events.length = 0;
  failNextCall(store.prompts, "put", quotaError());
  let gcResult = null;
  const flow = cache.savePrompt(rec, { content: true, now: T0 + 10 })
    .then(() => attachments.gc(oldText, newText, { draftIds: [] }))
    .then((ids) => { gcResult = ids; });
  await assert.rejects(flow, (e) => e.code === "store" && e.prompt === rec && !!e.cause && e.cause.name === "QuotaExceededError");
  assert.equal(gcResult, null, "GC never ran after the failed write");
  assert.ok(await store.attachments.get("a_1"), "the image the stored text references is still there");
  assert.match((await store.prompts.get("pg1")).text, /att:a_1/, "the store still holds the old text");
  assert.equal(cache.prompt("pg1"), rec, "an edited prompt keeps its in-memory state");
  assert.equal(cache.prompt("pg1").text, newText);
  assert.ok(savedToast(), "the failure is toasted");
  assert.deepEqual(events.map((e) => e.type), ["prompt:saved"], "an edit is not rolled back");

  // Once a retry lands, the same GC is correct: the store no longer references a_1.
  assert.equal(await cache.savePrompt(rec, { content: true, now: T0 + 20 }), rec);
  assert.equal((await store.prompts.get("pg1")).text, newText);
  assert.deepEqual(await attachments.gc(oldText, newText, { draftIds: [] }), ["a_1"]);
  assert.equal(await store.attachments.get("a_1"), null);
});

test("a brand-new prompt whose first write fails is dropped again (prompt:deleted), so a retry cannot duplicate it", async () => {
  events.length = 0;
  toasts.length = 0;
  const rec = { collectionId: "bookG", kind: "qa", text: "Q. new\nA. one", cards: [] };
  failNextCall(store.prompts, "put", quotaError());
  await assert.rejects(cache.savePrompt(rec, { content: true, now: T0 + 30 }), (e) => e.code === "store" && e.prompt === rec);
  assert.ok(rec.id, "the id was assigned before the write");
  assert.equal(cache.prompt(rec.id), null, "a never-stored prompt is not kept in memory");
  assert.equal(await store.prompts.get(rec.id), null);
  assert.deepEqual(events.map((e) => e.type), ["prompt:saved", "prompt:deleted"]);
  assert.deepEqual(events[1].payload, { promptId: rec.id, collectionId: "bookG" });
  assert.ok(savedToast());

  events.length = 0;
  assert.equal(await cache.savePrompt(rec, { content: true, now: T0 + 31 }), rec);
  assert.equal(events[0].type, "prompt:saved");
  assert.equal(events[0].payload.isNew, true, "the retry is the first stored version");
  assert.equal(cache.promptsOf("bookG").filter((x) => x.text === rec.text).length, 1);
  assert.equal((await store.prompts.get(rec.id)).text, rec.text);
});

test("a newer write of a new prompt overrides the rollback of its failed first write", async () => {
  const rec = { collectionId: "bookG", kind: "qa", text: "Q. raced\nA. yes", cards: [] };
  failNextCall(store.prompts, "put", quotaError());
  const first = cache.savePrompt(rec, { content: true, now: T0 + 40 });
  rec.flagged = true;                                   // e.g. F pressed on the new card before the write settled
  const second = cache.savePrompt(rec, { content: true, now: T0 + 41 });
  await assert.rejects(first, (e) => e.code === "store");
  assert.equal(await second, rec);
  assert.equal(cache.prompt(rec.id), rec);
  assert.equal((await store.prompts.get(rec.id)).flagged, true);
});

/* ---------------------------------------------------------------- contentUpdatedAt */

const SECTIONS = [{ title: "1 Waves", label: "Ch. 1 · Waves", pageIndex: 0, level: 1, source: "outline" }];
function anchorAt(pageIndex, y, quote) {
  return {
    pageIndex, pages: [{ pageIndex, rects: [[10, y - 10, 200, y]] }],
    quote: quote || "the wave function", prefix: quote ? "" : "Here ", suffix: quote ? "" : " solves",
    items: null, y, lost: false
  };
}

test("contentUpdatedAt follows edits a person made; lost-marking, refound positions and recontext leave it alone", async () => {
  await cache.saveCollection({ id: "bookH", kind: "book", name: "Griffiths", sections: SECTIONS, pageLabels: null }, { now: T0 });
  await cache.saveCollection({ id: "deckH", kind: "deck", name: "Deck H" }, { now: T0 });
  const p = await cache.savePrompt({ id: "ph1", collectionId: "bookH", kind: "qa", text: "Q. what?\nA. psi", anchor: anchorAt(3, 500),
    cards: [card(0, T0, T0 + FIRST)] }, { content: true, now: T0 });
  assert.equal(p.contentUpdatedAt, T0);

  // "Replace file, keep prompts" marks anchors lost and saves with {content: true}
  p.anchor.lost = true;
  await cache.savePrompt(p, { content: true, now: T0 + 1 });
  assert.equal(p.contentUpdatedAt, T0, "lost-marking is not an edit");
  assert.equal(p.updatedAt, T0 + 1);

  // the reader's automatic refind replaces the anchor with the same passage found on another page
  p.anchor = anchorAt(4, 420);
  p.context = Object.assign({}, p.context, { pageIndex: 4, pageLabel: "5" });
  await cache.savePrompt(p, { content: true, now: T0 + 2 });
  assert.equal(p.contentUpdatedAt, T0, "a refound position is not an edit");

  // a nickname change runs recontext: a fresh snapshot, updatedAt only
  const col = cache.collection("bookH");
  col.name = "QM";
  await cache.saveCollection(col, { now: T0 + 3 });
  assert.equal(await cache.recontext("bookH", { now: T0 + 3 }), 1);
  assert.equal(p.context.docName, "QM");
  assert.equal(p.updatedAt, T0 + 3);
  assert.equal(p.contentUpdatedAt, T0, "a context refresh is not an edit");
  assert.equal((await store.prompts.get("ph1")).contentUpdatedAt, T0);

  // the margin editor saves a fresh record object; saving it unchanged is not an edit either
  const same = Object.assign({}, p);
  await cache.savePrompt(same, { content: true, now: T0 + 4 });
  assert.equal(same.contentUpdatedAt, T0);

  // after a reload the comparison starts from the stored record
  await cache.load();
  const q = cache.prompt("ph1");
  q.anchor.lost = true;
  await cache.savePrompt(q, { content: true, now: T0 + 5 });
  assert.equal(q.contentUpdatedAt, T0);

  const edits = [
    ["a text edit", (r) => { r.text = "Q. what is psi?\nA. the wave function"; }],
    ["a tag edit", (r) => { r.tags = ["qm"]; }],
    ["a flag toggle", (r) => { r.flagged = !r.flagged; }],
    ["anchoring to another passage", (r) => { r.anchor = anchorAt(7, 300, "the Hamiltonian"); }],
    ["a move to a deck", (r) => { r.collectionId = "deckH"; r.anchor = null; }]
  ];
  let t = T0 + 10;
  for (const [what, edit] of edits) {
    const r = cache.prompt("ph1");
    edit(r);
    t += 1;
    await cache.savePrompt(r, { content: true, now: t });
    assert.equal(r.contentUpdatedAt, t, what + " bumps contentUpdatedAt");
  }
  // {content: false} (grades, imports) never bumps it
  const r = cache.prompt("ph1");
  r.text = "Q. imported\nA. text";
  await cache.savePrompt(r, { content: false, now: t + 1 });
  assert.equal(r.contentUpdatedAt, t);
});

test("an import of the other machine's earlier text edit survives a later rename, lost-marking and refind here", async () => {
  // Both machines start from the same prompt at T0.
  await cache.saveCollection({ id: "bookM", kind: "book", name: "Griffiths", sections: SECTIONS, pageLabels: null }, { now: T0 });
  const p = await cache.savePrompt({ id: "pm1", collectionId: "bookM", kind: "qa", text: "Q. old\nA. old", anchor: anchorAt(2, 300),
    cards: [card(0, T0, T0 + FIRST)] }, { content: true, now: T0 });
  const backup = {
    collections: [JSON.parse(JSON.stringify(cache.collection("bookM")))],
    prompts: [Object.assign(JSON.parse(JSON.stringify(p)), { text: "Q. B's question\nA. B's answer\n#mine", tags: ["mine"],
      contentUpdatedAt: T0 + 100, updatedAt: T0 + 100 })],
    attachments: []
  };
  // Machine A, later: nickname change (recontext), "Replace file" (lost-marking), automatic refind.
  const col = cache.collection("bookM");
  col.name = "QM";
  await cache.saveCollection(col, { now: T0 + 200 });
  await cache.recontext("bookM", { now: T0 + 200 });
  p.anchor.lost = true;
  await cache.savePrompt(p, { content: true, now: T0 + 300 });
  p.anchor = anchorAt(3, 280);
  await cache.savePrompt(p, { content: true, now: T0 + 400 });
  assert.equal(p.contentUpdatedAt, T0);

  const local = { collections: cache.collections(), prompts: cache.prompts(), attachments: [] };
  const { state, report } = exporter.merge(local, backup);
  const merged = state.prompts.find((x) => x.id === "pm1");
  assert.equal(merged.text, "Q. B's question\nA. B's answer\n#mine", "B's newer text edit wins");
  assert.deepEqual(merged.tags, ["mine"]);
  assert.ok(report.updated >= 1);
});

/* ---------------------------------------------------------------- collection cascades */

test("removeCollection writes its cascade in one transaction: a failure leaves the store untouched", async () => {
  const now = T0 + 1000;
  await store.docs.saveDocument({ id: "bookR", kind: "book", name: "R", addedAt: now, lastOpenedAt: now, updatedAt: now, deletedAt: null, v: 1 },
    new Uint8Array([1, 2, 3, 4]));
  await cache.load();
  const ids = [];
  for (let i = 0; i < 40; i++) {
    const rec = await cache.savePrompt({ id: "pr" + i, collectionId: "bookR", kind: "qa", text: "Q. " + i + "\nA. x",
      cards: [card(0, now, now + DAY)] }, { content: true, now });
    ids.push(rec.id);
  }
  async function storeUntouched() {
    const stored = await store.collections.get("bookR");
    assert.equal(stored.deletedAt, null, "the collection tombstone rolled back");
    assert.equal(stored.hasBytes, true);
    assert.ok(await store.docs.loadBytes("bookR"), "the chunks are still there");
    for (const id of ids) assert.equal((await store.prompts.get(id)).deletedAt, null, id + " is still live in the store");
  }

  // a prompt tombstone write fails (quota) after the chunk delete and the collection tombstone were issued
  toasts.length = 0;
  let undo = failInNextTx("prompts", "put");
  let c;
  try { c = await cache.removeCollection("bookR", { now: now + 5 }); } finally { undo(); }
  assert.equal(c.deletedAt, now + 5, "the session goes on with the deletion");
  assert.equal(cache.prompt("pr0").deletedAt, now + 5);
  assert.ok(savedToast(), "the failure is toasted");
  await storeUntouched();

  // the chunk deletion fails: the tombstones roll back with it
  await cache.load();
  assert.equal(cache.collection("bookR").deletedAt, null, "after a reload the book is whole again");
  undo = failInNextTx("chunks", "del");
  try { await cache.removeCollection("bookR", { now: now + 7 }); } finally { undo(); }
  await storeUntouched();

  // a clean run commits everything together
  await cache.load();
  await cache.removeCollection("bookR", { now: now + 9 });
  assert.equal((await store.collections.get("bookR")).deletedAt, now + 9);
  assert.equal((await store.collections.get("bookR")).hasBytes, false);
  assert.equal(await store.docs.loadBytes("bookR"), null);
  for (const id of ids) assert.equal((await store.prompts.get(id)).deletedAt, now + 9);

  // a deck's cascade (no chunks) is atomic as well
  await cache.saveCollection({ id: "deckR", kind: "deck", name: "R deck" }, { now });
  await cache.savePrompt({ id: "dr1", collectionId: "deckR", kind: "qa", text: "Q. d\nA. e", cards: [card(0, now, now + DAY)] }, { content: true, now });
  undo = failInNextTx("prompts", "put");
  try { await cache.removeCollection("deckR", { now: now + 11 }); } finally { undo(); }
  assert.equal((await store.collections.get("deckR")).deletedAt, null);
  assert.equal((await store.prompts.get("dr1")).deletedAt, null);
});

test("restoreCollection brings the collection and its prompts back in one transaction", async () => {
  const now = T0 + 1000;
  await cache.load();
  assert.equal(cache.collection("bookR").deletedAt, now + 9);
  const undo = failInNextTx("prompts", "put");
  try { await cache.restoreCollection("bookR", { now: now + 20 }); } finally { undo(); }
  assert.equal(cache.collection("bookR").deletedAt, null, "the session shows it restored");
  assert.equal((await store.collections.get("bookR")).deletedAt, now + 9, "the store keeps the whole deletion");
  assert.equal((await store.prompts.get("pr0")).deletedAt, now + 9);

  await cache.load();
  await cache.restoreCollection("bookR", { now: now + 30 });
  assert.equal((await store.collections.get("bookR")).deletedAt, null);
  for (let i = 0; i < 40; i++) assert.equal((await store.prompts.get("pr" + i)).deletedAt, null);
  assert.equal(cache.counts("bookR", now).prompts, 40);
});

/* ---------------------------------------------------------------- patchPrompts (FEATURES A9) */

test("patchPrompts: in place, no event, updatedAt only, one store write for every record; undefined removes a field", async () => {
  await cache.load();
  await cache.saveCollection({ id: "bookP", kind: "book", name: "P" }, { now: T0 });
  const recs = [];
  for (let i = 0; i < 3; i++) {
    recs.push(await cache.savePrompt({ id: "pp" + i, collectionId: "bookP", kind: "qa", text: "Q. " + i + "\nA. a", cards: [card(0, T0, T0 + DAY)] },
      { content: true, now: T0 + i }));
  }
  const stamps = recs.map((p) => p.contentUpdatedAt), dues = recs.map((p) => p.dueAt);
  events.length = 0;
  toasts.length = 0;
  let putMany = 0, put = 0;
  const realMany = store.prompts.putMany, realPut = store.prompts.put;
  store.prompts.putMany = function (list) { putMany++; return realMany.apply(this, arguments); };
  store.prompts.put = function (x) { put++; return realPut.apply(this, arguments); };
  try {
    const n = await cache.patchPrompts([
      { id: "pp0", fields: { obsidianPendingFile: "Notes/Marginalia/P.md" } },
      { id: "pp1", fields: { obsidianPendingFile: "Notes/Marginalia/P.md" } },
      { id: "pp2", fields: { obsidianPendingFile: "Notes/Marginalia/P.md" } },
      { id: "nope", fields: { obsidianPendingFile: "Notes/Marginalia/P.md" } }
    ], { now: T0 + 50 });
    assert.equal(n, 3, "the unknown id is skipped");
    assert.deepEqual([putMany, put], [1, 0], "one store write for all of them");
  } finally { store.prompts.putMany = realMany; store.prompts.put = realPut; }
  recs.forEach((p, i) => {
    assert.equal(cache.prompt(p.id), p, "the cached record keeps its identity: whatever holds it sees the change");
    assert.equal(p.obsidianPendingFile, "Notes/Marginalia/P.md");
    assert.equal(p.updatedAt, T0 + 50);
    assert.equal(p.contentUpdatedAt, stamps[i], "never a content edit");
    assert.equal(p.dueAt, dues[i]);
  });
  assert.deepEqual(events, [], "no event: no view re-renders a card for it");
  assert.equal((await store.prompts.get("pp1")).obsidianPendingFile, "Notes/Marginalia/P.md", "stored");

  // the send record: fields set and the marker removed; a record the patch leaves as it is is not written again
  const n2 = await cache.patchPrompts([
    { id: "pp0", fields: { obsidianSentAt: T0 + 60, obsidianFile: "Notes/Marginalia/P.md", obsidianPendingFile: undefined } },
    { id: "pp1", fields: { obsidianPendingFile: "Notes/Marginalia/P.md" } }
  ], { now: T0 + 60 });
  assert.equal(n2, 1);
  assert.equal("obsidianPendingFile" in cache.prompt("pp0"), false);
  assert.equal(cache.prompt("pp1").updatedAt, T0 + 50, "unchanged: no new stamp");
  const stored = await store.prompts.get("pp0");
  assert.deepEqual([stored.obsidianSentAt, stored.obsidianFile, "obsidianPendingFile" in stored], [T0 + 60, "Notes/Marginalia/P.md", false]);
  assert.equal(await cache.patchPrompts([]), 0);
  // a later edit still counts as an edit: the content key is untouched
  await cache.savePrompt(Object.assign({}, cache.prompt("pp2"), { text: "Q. 2, edited\nA. a" }), { content: true, now: T0 + 70 });
  assert.equal(cache.prompt("pp2").contentUpdatedAt, T0 + 70);
  assert.equal(cache.prompt("pp2").obsidianPendingFile, "Notes/Marginalia/P.md", "an edit made from the record keeps the marker");
  assert.deepEqual(toasts, []);
});

test("patchPrompts refuses content, derived and odd field names, and a tab that stepped aside; a failed store write is toasted and rejects", async () => {
  await cache.load();
  const before = JSON.stringify(cache.prompt("pp1"));
  for (const name of ["text", "kind", "tags", "flagged", "collectionId", "anchor", "context", "cards", "dueAt", "deletedAt",
    "createdAt", "updatedAt", "contentUpdatedAt", "id", "v", "__proto__", "a-b", ""]) {
    await assert.rejects(cache.patchPrompts([{ id: "pp1", fields: { [name]: 1 } }]), (e) => e.code === "bad_patch", name);
  }
  await assert.rejects(cache.patchPrompts([{ id: "pp1" }]), (e) => e.code === "bad_patch");
  await assert.rejects(cache.patchPrompts([null]), (e) => e.code === "bad_patch");
  // a bad entry anywhere refuses the whole call: nothing changed
  await assert.rejects(cache.patchPrompts([{ id: "pp1", fields: { obsidianFile: "x.md" } }, { id: "pp2", fields: { text: "no" } }]), (e) => e.code === "bad_patch");
  assert.equal(JSON.stringify(cache.prompt("pp1")), before);

  const realLocked = store.locked;
  store.locked = () => ({ reason: "othertab", by: "tab_b", at: T0 });
  events.length = 0;
  toasts.length = 0;
  try {
    await assert.rejects(cache.patchPrompts([{ id: "pp1", fields: { obsidianFile: "x.md" } }]), (e) => e.code === "locked");
  } finally { store.locked = realLocked; }
  assert.equal(JSON.stringify(cache.prompt("pp1")), before, "nothing changed in the tab that stepped aside");
  assert.deepEqual([events, toasts], [[], []]);

  failNextCall(store.prompts, "putMany", quotaError());
  // rejects, as savePrompt does, so a caller never sends anything on a write that did not land (repair A9-R3)
  await assert.rejects(cache.patchPrompts([{ id: "pp1", fields: { obsidianFile: "Notes/Marginalia/P.md" } }], { now: T0 + 80 }),
    (e) => e.code === "store" && e.cause && e.cause.name === "QuotaExceededError");
  assert.ok(savedToast(), "the failure is toasted");
  // the in-memory state is the session's truth (as an edit's): the change stays there
  assert.equal(cache.prompt("pp1").obsidianFile, "Notes/Marginalia/P.md");
  assert.equal((await store.prompts.get("pp1")).obsidianFile, undefined, "the store kept its copy");
});

/* SELF-CHECK: covers M.cache write outcomes — savePrompt rejects code "store" on a failed write (GC chained on success
 * stays safe; edits keep their in-memory state; never-stored new prompts are dropped with prompt:deleted unless a newer
 * write superseded them), contentUpdatedAt bumps only on person-made edits (not lost-marking, refind or recontext; an
 * import merge keeps the other side's edit), removeCollection / restoreCollection cascades are one transaction, and
 * patchPrompts (A9) writes the Obsidian send record in place, quietly, once, never as a content edit. */
