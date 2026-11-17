"use strict";
// test/cache.test.js — M.store (memory backend) and M.cache, run with `node --test test/cache.test.js`.
// util, scheduler, context and bus are stubbed with their §17 signatures so this file is self-contained.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const DAY = 86400000;
const FIRST = 5 * DAY;
const LOOKAHEAD = 16 * 3600000;

const events = [];
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
  isDue: REAL.isDue, isReady: REAL.isReady, readyTime: REAL.readyTime
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

const store = require(path.join(__dirname, "..", "js", "store.js"));
const cache = require(path.join(__dirname, "..", "js", "cache.js"));

// asked: the card was answered before, so its dueAt decides (a card never asked is due at once: D27)
function card(i, createdAt, dueAt, asked) {
  return { i, createdAt, lastReviewedAt: asked ? createdAt : null, intervalMs: FIRST, dueAt, log: [] };
}

/* ---------------------------------------------------------------- store */

test("store opens the memory backend in node and open() is idempotent", async () => {
  const a = store.open();
  const b = store.open();
  assert.equal(a, b, "open() returns the same promise");
  assert.deepEqual(await a, { mode: "memory" });
  assert.equal(store.mode(), "memory");
  assert.equal(await store.meta.get("dataVersion"), store.DATA_VERSION);
  assert.equal(await store.meta.get("schedulerVersion"), 1);
  assert.ok(events.some((e) => e.type === "store:mode" && e.payload.mode === "memory"));
  assert.deepEqual(Object.keys(store.MIGRATIONS), ["1"]);
  for (const fn of ["open", "get", "put", "del", "getAll", "tx", "estimate"]) assert.equal(typeof store.backend[fn], "function");
});

test("docs.saveDocument writes metadata plus 8 MiB chunks in one transaction; loadBytes reassembles them", async () => {
  const n = store.CHUNK_SIZE + 5;
  const bytes = new Uint8Array(n);
  for (let i = 0; i < n; i += 4099) bytes[i] = i & 255;
  bytes[n - 1] = 7;
  const rec = await store.docs.saveDocument({ id: "doc1", kind: "book", name: "Doc", deletedAt: null, v: 1 }, bytes);
  assert.equal(rec.chunkCount, 2);
  assert.equal(rec.byteLength, n);
  assert.equal(rec.chunkSize, store.CHUNK_SIZE);
  assert.equal(rec.hasBytes, true);
  assert.equal((await store.collections.get("doc1")).chunkCount, 2);
  const chunks = await store.backend.getAll("chunks", { range: store.range.bound(["doc1", 0], ["doc1", Infinity]) });
  assert.deepEqual(chunks.map((c) => c.i), [0, 1]);
  assert.ok(chunks[0].bytes instanceof ArrayBuffer, "chunk bytes are ArrayBuffers");
  assert.equal(chunks[0].bytes.byteLength, store.CHUNK_SIZE);
  assert.equal(chunks[1].bytes.byteLength, 5);
  const back = await store.docs.loadBytes("doc1");
  assert.ok(back instanceof Uint8Array);
  assert.equal(back.byteLength, n);
  assert.equal(back[n - 1], 7);
  assert.equal(Buffer.compare(Buffer.from(back.buffer, back.byteOffset, back.byteLength), Buffer.from(bytes.buffer)), 0);
  await store.docs.deleteBytes("doc1");
  assert.equal(await store.docs.loadBytes("doc1"), null);
  await assert.rejects(store.docs.saveDocument({ id: "big" }, { byteLength: store.MAX_DOC_BYTES + 1 }), (e) => e.code === "too_large");
  assert.equal(await store.collections.get("big"), null);
  await store.backend.del("collections", "doc1");
});

test("backend.tx is atomic: a throwing callback rolls back its writes", async () => {
  await assert.rejects(store.backend.tx(["meta"], "readwrite", async (meta) => {
    await meta.put({ key: "tx-test", value: 1 });
    throw new Error("boom");
  }), /boom/);
  assert.equal(await store.meta.get("tx-test"), undefined);
  await store.meta.set("tx-test", 2);
  assert.equal(await store.meta.get("tx-test"), 2);
});

test("prompts.due(now) uses the byDue index up to now + LOOKAHEAD and skips records without dueAt", async () => {
  const now = 1000000000000;
  await store.prompts.putMany([
    { id: "d1", collectionId: "cx", kind: "qa", dueAt: now + 3600000, createdAt: now },
    { id: "d2", collectionId: "cx", kind: "qa", dueAt: now + 20 * 3600000, createdAt: now },
    { id: "d3", collectionId: "cx", kind: "note", createdAt: now }
  ]);
  assert.deepEqual((await store.prompts.due(now)).map((p) => p.id), ["d1"]);
  assert.deepEqual((await store.prompts.due(now, 24 * 3600000)).map((p) => p.id), ["d1", "d2"]);
  assert.deepEqual((await store.prompts.byCollection("cx")).map((p) => p.id).sort(), ["d1", "d2", "d3"]);
  assert.deepEqual(await store.backend.getAll("prompts", { index: "byCreated", keys: true }), ["d1", "d2", "d3"]);
  for (const id of ["d1", "d2", "d3"]) await store.backend.del("prompts", id);
  assert.deepEqual(await store.prompts.all(), []);
});

/* ---------------------------------------------------------------- cache */

test("savePrompt derives dueAt from cards and deletes it for notes, highlights and tombstones", async () => {
  await cache.load();
  const now = Date.now();
  const book = await cache.saveCollection({ id: "bookA", kind: "book", name: "Griffiths", pageCount: 322 }, { now });
  assert.equal(book.updatedAt, now);
  assert.equal(book.deletedAt, null);
  assert.equal(cache.collection("bookA"), book);

  events.length = 0;
  const p = await cache.savePrompt({
    id: "p1", collectionId: "bookA", kind: "qa", text: "Q. a\nA. b",
    cards: [card(0, now, now + 500), card(1, now, now + 300)]
  }, { content: true, now });
  assert.equal(p.dueAt, now + 300, "dueAt = min over cards");
  assert.equal(p.updatedAt, now);
  assert.equal(p.contentUpdatedAt, now);
  assert.equal(p.createdAt, now);
  assert.equal(p.deletedAt, null);
  const saved = events.find((e) => e.type === "prompt:saved");
  assert.ok(saved);
  assert.equal(saved.payload.isNew, true);
  assert.equal(saved.payload.prompt, p);
  assert.equal((await store.prompts.get("p1")).dueAt, now + 300);

  const later = now + 1000;
  p.cards[1].dueAt = now + 900;
  await cache.savePrompt(p, { content: false, now: later });
  assert.equal(p.dueAt, now + 500);
  assert.equal(p.updatedAt, later);
  assert.equal(p.contentUpdatedAt, now, "a grade does not touch contentUpdatedAt");
  assert.equal(events.filter((e) => e.type === "prompt:saved")[1].payload.isNew, false);

  p.kind = "note";
  await cache.savePrompt(p, { content: true, now: later });
  assert.equal(Object.prototype.hasOwnProperty.call(p, "dueAt"), false, "notes carry no dueAt property");
  assert.equal("dueAt" in (await store.prompts.get("p1")), false);
  assert.deepEqual(await store.prompts.due(now + 10 * DAY), []);

  const h = await cache.savePrompt({ id: "h1", collectionId: "bookA", kind: "highlight", text: "", cards: [] }, { content: true, now });
  assert.equal("dueAt" in h, false);

  p.kind = "qa";
  await cache.savePrompt(p, { content: true, now: later });
  assert.equal(p.dueAt, now + 500);

  events.length = 0;
  await cache.removePrompt("p1", { now: later + 1 });
  assert.equal(p.deletedAt, later + 1);
  assert.equal("dueAt" in p, false, "tombstones carry no dueAt");
  assert.deepEqual(events[0], { type: "prompt:deleted", payload: { promptId: "p1", collectionId: "bookA" } });
  assert.equal(cache.prompt("p1"), p, "the tombstone stays in the cache");
  assert.equal(cache.prompts({ live: true }).some((x) => x.id === "p1"), false);
  assert.equal(cache.promptsOf("bookA").length, 2);
  await cache.restorePrompt("p1", { now: later + 2 });
  assert.equal(p.deletedAt, null);
  assert.equal(p.dueAt, now + 500);
  assert.equal(events[1].type, "prompt:restored");
  await assert.rejects(cache.removePrompt("nope"), (e) => e.code === "not_found");
  await assert.rejects(cache.savePrompt({ id: "x", kind: "qa", text: "" }), (e) => e.code === "bad_prompt");
});

test("counts() per scope: prompts, cards, due, nextDueAt, writtenToday", async () => {
  const now = Date.now();
  const yesterday = now - 36 * 3600000;
  await cache.saveCollection({ id: "bookB", kind: "book", name: "B" }, { now });
  await cache.saveCollection({ id: "deckC", kind: "deck", name: "C" }, { now });
  await cache.savePrompt({ id: "b1", collectionId: "bookB", kind: "qa", text: "Q. x\nA. y", createdAt: now,
    cards: [card(0, now, now + 3600000)] }, { content: true, now });
  await cache.savePrompt({ id: "b2", collectionId: "bookB", kind: "cloze", text: "{a} {b} {c}", createdAt: yesterday,
    cards: [card(0, yesterday, now - 1000, true), card(1, yesterday, now + 15 * 3600000, true), card(2, yesterday, now + 30 * 3600000, true)] }, { content: true, now: yesterday });
  await cache.savePrompt({ id: "b3", collectionId: "bookB", kind: "note", text: "note", createdAt: now, cards: [] }, { content: true, now });
  await cache.savePrompt({ id: "b4", collectionId: "bookB", kind: "highlight", text: "", createdAt: now }, { content: true, now });
  await cache.savePrompt({ id: "b5", collectionId: "bookB", kind: "qa", text: "Q. z\nA. w", createdAt: now, cards: [card(0, now, now)] }, { content: true, now });
  await cache.removePrompt("b5", { now });
  await cache.savePrompt({ id: "c1", collectionId: "deckC", kind: "qa", text: "Q. d\nA. e", createdAt: yesterday,
    cards: [card(0, yesterday, now + 2 * DAY, true)] }, { content: true, now: yesterday });

  // bookB: b1 was never asked (due), b2's first card is overdue, its second is inside the 16-hour lookahead, its third is not due.
  // nextDueAt is the earliest time from which a session can ask a card (M.scheduler.readyTime): a due time less the 16-hour lookahead
  assert.deepEqual(cache.counts("bookB", now), { prompts: 3, cards: 4, due: 3, nextDueAt: now - 1000 - LOOKAHEAD, writtenToday: 2 });
  assert.deepEqual(cache.counts("deckC", now), { prompts: 1, cards: 1, due: 0, nextDueAt: now + 2 * DAY - LOOKAHEAD, writtenToday: 0 });
  assert.equal(cache.counts("deckC", now + 2 * DAY - LOOKAHEAD - 1).due, 0, "one millisecond before that time it is not due …");
  assert.equal(cache.counts("deckC", now + 2 * DAY - LOOKAHEAD).due, 1, "… and at that time it is");
  // D27: a card never asked counts as due, also one stored before D27 with its dueAt 4 days ahead
  await cache.savePrompt({ id: "c2", collectionId: "deckC", kind: "qa", text: "Q. never\nA. asked", createdAt: yesterday,
    cards: [card(0, yesterday, yesterday + 5 * DAY)] }, { content: true, now: yesterday });
  assert.deepEqual(cache.counts("deckC", now), { prompts: 2, cards: 2, due: 1, nextDueAt: yesterday, writtenToday: 0 },
    "nextDueAt is the earliest time a card can be asked from (M.scheduler.readyTime): a card never asked, from the time it was made");
  assert.deepEqual(cache.countsBy(now).get("deckC"), cache.counts("deckC", now));
  // D29: an answer to one blank holds the sentence's other blanks back for 16 hours; then they count as due again
  await cache.savePrompt({ id: "c3", collectionId: "deckC", kind: "cloze", text: "{x} and {y} and {z}", createdAt: yesterday,
    cards: [Object.assign(card(0, yesterday, now + 5 * DAY), { lastReviewedAt: now - 3600000 }), card(1, yesterday, yesterday), card(2, yesterday, yesterday)] }, { content: true, now: yesterday });
  assert.equal(cache.counts("deckC", now).due, 1, "the two blanks never asked wait: the first blank was answered an hour ago");
  assert.equal(cache.countsBy(now).get("deckC").due, 1);
  assert.equal(cache.counts("deckC", now + 15 * 3600000).due, 3, "16 hours after that answer both are due");
  assert.equal(cache.countsBy(now + 15 * 3600000).get("deckC").due, 3);
  await cache.removePrompt("c3", { now });
  // a card never asked whose createdAt lies ahead (a clock set back) is due now: nextDueAt is never later than now for it
  await cache.saveCollection({ id: "deckF", kind: "deck", name: "F" }, { now });
  await cache.savePrompt({ id: "f1", collectionId: "deckF", kind: "qa", text: "Q. ahead\nA. yes", createdAt: now,
    cards: [card(0, now + 3 * DAY, now + 3 * DAY)] }, { content: true, now });
  assert.deepEqual(cache.counts("deckF", now), { prompts: 1, cards: 1, due: 1, nextDueAt: now, writtenToday: 1 });
  assert.deepEqual(cache.countsBy(now).get("deckF"), cache.counts("deckF", now));
  await cache.removeCollection("deckF", { now });
  await cache.removePrompt("c2", { now });
  assert.deepEqual(cache.counts("missing", now), { prompts: 0, cards: 0, due: 0, nextDueAt: null, writtenToday: 0 });

  const all = cache.counts(null, now);
  const sum = { prompts: 0, cards: 0, due: 0, nextDueAt: null, writtenToday: 0 };
  for (const c of cache.collections({ live: true })) {
    const k = cache.counts(c.id, now);
    sum.prompts += k.prompts; sum.cards += k.cards; sum.due += k.due; sum.writtenToday += k.writtenToday;
    if (k.nextDueAt !== null && (sum.nextDueAt === null || k.nextDueAt < sum.nextDueAt)) sum.nextDueAt = k.nextDueAt;
  }
  assert.deepEqual(all, sum, "null scope = every live collection");
  assert.equal(all.prompts, 5);
  assert.equal(all.cards, 7);
  assert.equal(all.due, 5);
});

test("removeCollection tombstones the collection and its prompts and deletes the book's chunks", async () => {
  const now = Date.now();
  await store.docs.saveDocument({ id: "bookD", kind: "book", name: "D", addedAt: now, lastOpenedAt: now, updatedAt: now, deletedAt: null, v: 1 },
    new Uint8Array([1, 2, 3, 4, 5]));
  await cache.load();
  assert.equal(cache.collection("bookD").hasBytes, true);
  assert.equal(cache.prompt("b1").kind, "qa", "load() keeps earlier records");
  await cache.savePrompt({ id: "e1", collectionId: "bookD", kind: "qa", text: "Q. 1\nA. 2", cards: [card(0, now, now + 100)] }, { content: true, now });
  await cache.savePrompt({ id: "e2", collectionId: "bookD", kind: "note", text: "n", cards: [] }, { content: true, now });

  events.length = 0;
  const c = await cache.removeCollection("bookD", { now: now + 5 });
  assert.equal(c.deletedAt, now + 5);
  assert.equal(c.hasBytes, false);
  assert.equal(cache.prompt("e1").deletedAt, now + 5);
  assert.equal("dueAt" in cache.prompt("e1"), false);
  assert.equal(cache.prompt("e2").deletedAt, now + 5);
  assert.equal(await store.docs.loadBytes("bookD"), null, "chunks are gone");
  assert.equal((await store.collections.get("bookD")).deletedAt, now + 5);
  assert.equal((await store.prompts.get("e1")).deletedAt, now + 5);
  assert.equal((await store.prompts.get("e2")).deletedAt, now + 5);
  assert.deepEqual(events.map((e) => e.type), ["prompt:deleted", "prompt:deleted", "collection:deleted"]);
  assert.deepEqual(events[2].payload, { collectionId: "bookD" });
  assert.deepEqual(cache.counts("bookD", now), { prompts: 0, cards: 0, due: 0, nextDueAt: null, writtenToday: 0 });
  assert.equal(cache.collections({ live: true }).some((x) => x.id === "bookD"), false);
  assert.ok(cache.collections().some((x) => x.id === "bookD"), "the tombstone stays in the cache");

  events.length = 0;
  await cache.restoreCollection("bookD", { now: now + 9 });
  assert.equal(cache.collection("bookD").deletedAt, null);
  assert.equal(cache.prompt("e1").deletedAt, null);
  assert.equal(cache.prompt("e1").dueAt, now + 100);
  assert.equal(cache.counts("bookD", now).prompts, 2);
  assert.deepEqual(events.map((e) => e.type), ["collection:changed", "prompt:restored", "prompt:restored"]);
  assert.equal((await store.collections.get("bookD")).deletedAt, null);
});

test("recontext() recomputes every live prompt's context; a nickname change updates context.docName", async () => {
  const now = Date.now();
  const sections = [
    { title: "1 The Wave Function", label: "Ch. 1 · The Wave Function", pageIndex: 10, level: 1, source: "outline" },
    { title: "2 Time-Independent", label: "Ch. 2 · Time-Independent", pageIndex: 40, level: 1, source: "outline" }
  ];
  await cache.saveCollection({ id: "bookE", kind: "book", name: "Griffiths", sections, pageLabels: null }, { now });
  const anchorAt = (pageIndex) => ({ pageIndex, pages: [], quote: "", prefix: "", suffix: "", items: null, y: 0, lost: false });
  const p = await cache.savePrompt({ id: "r1", collectionId: "bookE", kind: "qa", text: "Q. q\nA. a", anchor: anchorAt(11),
    cards: [card(0, now, now + 1)] }, { content: true, now });
  const q = await cache.savePrompt({ id: "r2", collectionId: "bookE", kind: "note", text: "n", anchor: anchorAt(41), cards: [] }, { content: true, now });
  await cache.savePrompt({ id: "r3", collectionId: "bookE", kind: "note", text: "gone", anchor: anchorAt(41) }, { content: true, now });
  await cache.removePrompt("r3", { now });

  events.length = 0;
  assert.equal(await cache.recontext("bookE", { now: now + 10 }), 2);
  assert.deepEqual(p.context, { docName: "Griffiths", sectionLabel: "Ch. 1 · The Wave Function", pageIndex: 11, pageLabel: "12" });
  assert.deepEqual(q.context, { docName: "Griffiths", sectionLabel: "Ch. 2 · Time-Independent", pageIndex: 41, pageLabel: "42" });
  assert.equal(cache.prompt("r3").context, null, "tombstones are left alone");
  assert.equal(p.updatedAt, now + 10);
  assert.equal(p.contentUpdatedAt, now, "a context refresh is derived, not an edit: it must not outrank real edits in a merge");
  assert.deepEqual(events.map((e) => e.type), ["prompts:recontexted"]);
  assert.equal(events[0].payload.collectionId, "bookE");

  const col = cache.collection("bookE");
  col.name = "QM";
  await cache.saveCollection(col, { now: now + 20 });
  await cache.recontext("bookE", { now: now + 20 });
  assert.equal(p.context.docName, "QM");
  assert.equal(q.context.docName, "QM");
  assert.equal((await store.prompts.get("r1")).context.docName, "QM");
  assert.equal(await cache.recontext("bookE", { now: now + 30 }), 0, "nothing changed → nothing written");
  assert.equal(p.updatedAt, now + 20);
  await assert.rejects(cache.recontext("nope"), (e) => e.code === "not_found");
});

test("recontext() falls back to labelFor when M.context has no contextFor", async () => {
  const real = M.context;
  M.context = { labelFor: real.labelFor };
  try {
    const col = cache.collection("bookE");
    col.name = "QM2";
    await cache.saveCollection(col);
    assert.equal(await cache.recontext("bookE"), 2);
    assert.deepEqual(cache.prompt("r1").context, { docName: "QM2", sectionLabel: "Ch. 1 · The Wave Function", pageIndex: 11, pageLabel: "12" });
    assert.equal(cache.prompt("r2").context.docName, "QM2");
  } finally {
    M.context = real;
  }
});

/* SELF-CHECK: covers M.store (open idempotence + memory mode, backend tx atomicity, docs.saveDocument/loadBytes/deleteBytes,
 * too_large, prompts.due/byCollection/putMany, getAll keys) and M.cache (load, savePrompt dueAt derivation and deletion,
 * removePrompt/restorePrompt, saveCollection, removeCollection cascade + restoreCollection, counts per scope, recontext). */

/* ---------------------------------------------------------------- collection content stamp */

test("saveCollection moves contentUpdatedAt only for name, description or sections", async () => {
  await cache.load();
  const id = "deck_stamp-" + globalThis.crypto.randomUUID();
  const rec = { id, kind: "deck", name: "Stamp deck", description: "", sections: [], addedAt: 1000, lastOpenedAt: 1000, updatedAt: 1000, deletedAt: null, v: 1 };
  await cache.saveCollection(rec, { now: 2000 });
  assert.equal(cache.collection(id).contentUpdatedAt, 2000, "a new record is stamped when saved");

  const c = cache.collection(id);
  c.lastOpenedAt = 3000;
  await cache.saveCollection(c, { now: 3000 });
  assert.equal(cache.collection(id).contentUpdatedAt, 2000, "lastOpenedAt is not content");
  assert.equal(cache.collection(id).updatedAt, 3000, "updatedAt still moves on every write");

  c.name = "Renamed deck";
  await cache.saveCollection(c, { now: 4000 });
  assert.equal(cache.collection(id).contentUpdatedAt, 4000, "a rename is content");

  c.sections = [{ title: "Verbs", label: "Verbs", pageIndex: 0, level: 1, source: "manual" }];
  await cache.saveCollection(c, { now: 5000 });
  assert.equal(cache.collection(id).contentUpdatedAt, 5000, "a section change is content");

  c.description = "imported";
  c.contentUpdatedAt = 4500;
  await cache.saveCollection(c, { now: 6000, content: false });
  assert.equal(cache.collection(id).contentUpdatedAt, 4500, "{content: false} keeps the record's own stamp (imports)");
});
