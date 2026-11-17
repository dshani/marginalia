"use strict";
// test/d27.test.js — DECISIONS D27 (BUILD-NOTES "Scheduling and statistics"), the two scheduling rules end to end:
//  1. a card never asked is due at once, whatever its stored dueAt (cards made before D27 store createdAt + 5 d);
//  2. a session takes ONE card of a prompt (a sentence with several blanks gives one blank; the others are "held").
// Since D28 and D29 (BUILD-NOTES "Wrong answers and the next day") a card answered wrong and a held blank come the
// next day (16 hours later at the earliest), not at once: the tests below move the clock for that.
// Each test is a fresh vm page running the REAL util, bus, settings, store (memory backend), scheduler, prompts,
// context, markup, exporter, obsidian, cache and review modules, with a clock the test moves. Nothing here touches a
// network, a vault or a backup folder.
// Run: node --test test/d27.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const JS = path.join(__dirname, "..", "js");
const MODULES = ["util", "bus", "settings", "store", "scheduler", "prompts", "context", "markup", "exporter", "obsidian", "cache", "review"];
const plain = (v) => JSON.parse(JSON.stringify(v));
const unref = (t) => { if (t && typeof t.unref === "function") t.unref(); return t; };
const DAY = 86400000, MIN = 60000, NEXT_DAY = 16 * 3600000;
const T0 = new Date(2026, 10, 14, 12, 0, 0).getTime();    // local noon, so "today" has room on both sides

function page() {
  const state = { clock: T0 }, ended = [];
  const win = {
    console: { log() {}, info() {}, debug() {}, warn() {}, error() {} },
    setTimeout: (fn, ms, ...a) => unref(setTimeout(fn, ms, ...a)), clearTimeout,
    setInterval: (fn, ms) => unref(setInterval(fn, ms)), clearInterval,
    queueMicrotask, structuredClone, crypto: globalThis.crypto, TextEncoder, TextDecoder, Intl,
    __clock: () => state.clock
  };
  win.window = win; win.self = win;
  const ctx = vm.createContext(win);
  vm.runInContext("Date.now = function () { return __clock(); };", ctx);
  for (const name of MODULES) vm.runInContext(fs.readFileSync(path.join(JS, name + ".js"), "utf8"), ctx, { filename: "js/" + name + ".js" });
  const M = win.Marginalia;
  M.app = { toast() { return { close() {} }; } };
  M.bus.on("review:ended", (p) => ended.push(plain(p.summary)));
  return {
    M, state, ended,
    tick(ms) { state.clock += ms; return state.clock; },
    async boot() { await M.store.open(); await M.cache.load(); await M.cache.saveCollection(book("b1")); await M.cache.saveCollection(book("b2")); return this; },
    // One whole session: every card answered by `answer(promptId, cardIndex, ask)`; → the keys in the order asked.
    async session(scope, collectionId, answer) {
      const R = M.review, asked = [], n = {};
      await R.start({ scope, collectionId: collectionId || null });
      for (let c = R.current(); c; c = R.current()) {
        const k = c.item.promptId + "#" + c.item.cardIndex;
        n[k] = (n[k] || 0) + 1;
        asked.push(k);
        R.reveal();
        state.clock += 1000;
        R.grade(answer ? answer(c.item.promptId, c.item.cardIndex, n[k]) : "remembered");
      }
      const sum = ended[ended.length - 1] || null;
      R.stop();
      return { asked, sum };
    }
  };
}
function book(id) {
  return { id, kind: "book", name: "Book " + id, sha256: "sha-" + id, hashAlgo: "sha-256", pageCount: 40, pageLabels: null, sections: [],
    lastPosition: { pageIndex: 0, fraction: 0, zoom: "fit" }, hasBytes: true, addedAt: T0 - 40 * DAY, lastOpenedAt: T0, updatedAt: T0, deletedAt: null, v: 1 };
}
// A prompt written `at`, its cards made by the real M.prompts.reconcileCards (so by M.scheduler.newSchedule).
function written(P, id, collectionId, text, at) {
  const parsed = P.M.prompts.parse(text);
  const cards = plain(P.M.prompts.reconcileCards(null, parsed, at).cards);
  return { id, collectionId, kind: parsed.kind, text, tags: [], flagged: false, anchor: null, context: null, cards,
    createdAt: at, contentUpdatedAt: at, updatedAt: at, deletedAt: null, v: 1 };
}
// A card as stored before D27: never asked, dueAt = createdAt + 5 d.
const oldCard = (i, createdAt) => ({ i, createdAt, lastReviewedAt: null, intervalMs: 5 * DAY, dueAt: createdAt + 5 * DAY, log: [] });
const save = (P, p) => P.M.cache.savePrompt(Object.assign({}, p), { content: false });

test("a new prompt is due at once: the counts, Review all and the book's review hold it; a right first answer gives 5 days", async () => {
  const P = await page().boot(), C = P.M.cache;
  await save(P, written(P, "p_new", "b1", "Q. What is new?\nA. this", T0));
  const stored = plain(C.prompt("p_new"));
  assert.equal(stored.cards[0].dueAt, T0, "the card is stored as due from the moment it was made");
  assert.equal(stored.dueAt, T0, "and so is the prompt (the earliest of its cards)");
  assert.deepEqual(plain(C.counts(null, T0)), { prompts: 1, cards: 1, due: 1, nextDueAt: T0, writtenToday: 1 });
  assert.equal(C.counts("b1", T0 + 3 * DAY).due, 1, "it stays due while it was never asked");
  assert.equal(C.counts("b2", T0).due, 0);

  const s1 = await P.session("book", "b1");
  assert.deepEqual(s1.asked, ["p_new#0"]);
  const card = plain(C.prompt("p_new")).cards[0];
  assert.equal(card.intervalMs, 5 * DAY, "the first interval, as in Orbit");
  assert.ok(card.dueAt >= P.state.clock + 5 * DAY && card.dueAt < P.state.clock + 5 * DAY + 10 * MIN, "due in 5 days (plus the jitter)");
  assert.equal(C.counts(null, P.state.clock).due, 0);
  assert.deepEqual((await P.session("all", null)).asked, [], "nothing more to ask");
  // 5 days later it is due again, and a right answer gives 11.5 days
  P.tick(5 * DAY);
  assert.deepEqual((await P.session("all", null)).asked, ["p_new#0"]);
  const c2 = plain(C.prompt("p_new")).cards[0];
  assert.ok(c2.intervalMs > 11.4 * DAY && c2.intervalMs < 11.6 * DAY, String(c2.intervalMs / DAY));
});

test("a card made before D27 and never asked (stored due in 5 days) is due at once too, without a change of stored data", async () => {
  const P = await page().boot(), C = P.M.cache;
  const p = written(P, "p_old", "b1", "Q. What is old?\nA. this", T0 - DAY);
  p.cards = [oldCard(0, T0 - DAY)];
  await save(P, p);
  assert.equal(plain(C.prompt("p_old")).cards[0].dueAt, T0 + 4 * DAY, "the stored dueAt is as it was");
  assert.equal(C.counts(null, T0).due, 1);
  assert.equal(C.countsBy(T0).get("b1").due, 1);
  const s = await P.session("all", null, () => "forgot");
  assert.deepEqual(s.asked, ["p_old#0", "p_old#0", "p_old#0"], "asked, and again at the end, up to 3 times");
  assert.equal(s.sum.stillShaky.length, 1);
  assert.equal(C.counts(null, P.state.clock).due, 0, "wrong three times: it comes the next day (D28), not at once");
  assert.equal(C.counts(null, P.state.clock + NEXT_DAY - 1).due, 0);
  assert.equal(C.counts(null, P.state.clock + NEXT_DAY).due, 1, "16 hours after its last answer");
  // a skip is no answer: a card never asked (stored before D27 here) stays due after a session in which it was only
  // skipped, and the end of that session knows it: the next due time is the card's dueTime, not its stored dueAt
  const q = written(P, "p_skip", "b2", "Q. Skipped?\nA. yes", T0);
  q.cards = [oldCard(0, T0)];
  await save(P, q);
  const R = P.M.review;
  await R.start({ scope: "book", collectionId: "b2" });
  R.skip(); R.skip();                                      // once to the end, twice out of the session
  assert.equal(R.current(), null);
  const sum = P.ended[P.ended.length - 1];
  assert.deepEqual([sum.total, sum.reviewed, sum.skipped, sum.held, sum.dueNow], [1, 0, 1, 0, 1]);
  assert.equal(sum.nextDueAt, T0, "due since it was made (so the end line reads “more due now”), not in 5 days");
  R.stop();
  assert.equal(P.M.scheduler.neverAsked(C.prompt("p_skip").cards[0]), true);
  assert.equal(C.counts("b2", P.state.clock).due, 1);
});

test("a card never asked whose createdAt lies ahead (a clock set back) is due, and nothing says otherwise", async () => {
  const P = await page().boot(), C = P.M.cache, sc = P.M.scheduler;
  const p = written(P, "p_ahead", "b1", "Q. From the future?\nA. yes", T0 + 3 * DAY);
  await save(P, p);
  assert.equal(sc.isDue(C.prompt("p_ahead").cards[0], T0), true);
  assert.equal(C.counts("b1", T0).due, 1);
  const R = P.M.review;
  await R.start({ scope: "book", collectionId: "b1" });
  assert.equal(R.current().item.promptId, "p_ahead", "it is asked");
  R.skip(); R.skip();
  const sum = P.ended[P.ended.length - 1];
  assert.ok(sum.nextDueAt <= P.state.clock, "the end line says “more due now”, not “nothing due until …”: " + sum.nextDueAt);
  assert.equal(sum.dueNow, 1);
  R.stop();
});

test("held counts the session's scope only: a sentence moved to another book in the middle of a session holds nothing here", async () => {
  const P = await page().boot(), C = P.M.cache, R = P.M.review;
  await save(P, written(P, "p_z", "b1", "A {b} and a {c}.", T0 - DAY));
  await save(P, written(P, "p_q", "b1", "Q. One card?\nA. yes", T0 - DAY + 1000));
  await R.start({ scope: "book", collectionId: "b1" });
  assert.equal(R.current().item.promptId, "p_z");
  R.reveal(); P.tick(1000); R.grade("remembered");
  await C.savePrompt(Object.assign({}, plain(C.prompt("p_z")), { collectionId: "b2" }), { content: false });   // moved to the other book
  assert.equal(R.current().item.promptId, "p_q");
  R.reveal(); P.tick(1000); R.grade("remembered");
  const sum = P.ended[P.ended.length - 1];
  assert.equal(sum.held, 0, "its other blank waits in the other book now");
  R.stop();
  // … and there it is asked, the next day (D29)
  assert.deepEqual((await P.session("book", "b2")).asked, [], "not on the day its sentence was answered");
  P.tick(NEXT_DAY);
  assert.deepEqual((await P.session("book", "b2")).asked, ["p_z#1"]);
  // without the move the same session holds one blank
  const Q = await page().boot();
  await save(Q, written(Q, "p_z", "b1", "A {b} and a {c}.", T0 - DAY));
  assert.equal((await Q.session("book", "b1")).sum.held, 1);
});

test("a sentence with three blanks gives one blank to a session; the others are held and come one day at a time (D29)", async () => {
  const P = await page().boot(), C = P.M.cache;
  await save(P, written(P, "p_z", "b1", "The {wave} function is {complex} and {normalised}.", T0 - DAY));
  await save(P, written(P, "p_q", "b1", "Q. One card?\nA. yes", T0 - DAY));
  assert.equal(C.counts(null, T0).due, 4, "the count is a count of cards");

  const s1 = await P.session("all", null);
  assert.deepEqual(s1.asked.slice().sort(), ["p_q#0", "p_z#0"], "one blank of the sentence");
  assert.deepEqual([s1.sum.total, s1.sum.reviewed, s1.sum.held, s1.sum.dueNow], [2, 2, 2, 0]);
  const answered = plain(C.prompt("p_z")).cards[0].lastReviewedAt;
  assert.equal(s1.sum.heldUntil, answered + NEXT_DAY, "the held blanks can be asked 16 hours after the answer to the first");
  assert.ok(s1.sum.nextDueAt > P.state.clock + 4 * DAY, "the next due time leaves the held blanks out: " + s1.sum.nextDueAt);
  assert.equal(C.counts(null, P.state.clock).due, 0, "nothing is due right after the session: the other blanks wait");
  assert.equal(C.counts(null, P.state.clock).nextDueAt, answered + NEXT_DAY);
  assert.deepEqual((await P.session("all", null)).asked, [], "a second session at once asks nothing");

  P.tick(NEXT_DAY);
  assert.equal(C.counts(null, P.state.clock).due, 2, "the next day both other blanks are due …");
  const s2 = await P.session("all", null);
  assert.deepEqual(s2.asked, ["p_z#1"], "… and the session takes one");
  assert.equal(s2.sum.held, 1);
  assert.equal(C.counts(null, P.state.clock).due, 0);
  P.tick(NEXT_DAY);
  const s3 = await P.session("book", "b1");
  assert.deepEqual(s3.asked, ["p_z#2"]);
  assert.equal(s3.sum.held, 0);
  assert.deepEqual((await P.session("all", null)).asked, []);
  assert.equal(C.counts(null, P.state.clock).due, 0);
});

test("a blank answered wrong comes back in the same session (never its sibling); the next day it goes before the blank never asked", async () => {
  const P = await page().boot(), C = P.M.cache;
  await save(P, written(P, "p_z", "b1", "A {b} and a {c}.", T0 - DAY));
  const s1 = await P.session("book", "b1", (id, i, ask) => (ask < 3 ? "forgot" : "remembered"));
  assert.deepEqual(s1.asked, ["p_z#0", "p_z#0", "p_z#0"], "the retry is the same card");
  assert.deepEqual([s1.sum.reviewed, s1.sum.forgot, s1.sum.remembered, s1.sum.held, s1.sum.stillShaky.length], [1, 2, 1, 1, 0]);
  // wrong every time: it is still shaky, and due the next day (D28); nothing of the sentence is due at once
  await save(P, written(P, "p_y", "b2", "X {y} and {w}.", T0 - DAY));
  const t1 = await P.session("book", "b2", () => "forgot");
  assert.deepEqual(t1.asked, ["p_y#0", "p_y#0", "p_y#0"]);
  assert.deepEqual([t1.sum.stillShaky.length, t1.sum.held, t1.sum.dueNow], [1, 1, 0]);
  assert.equal(C.counts("b2", P.state.clock).due, 0);
  assert.deepEqual((await P.session("book", "b2")).asked, []);
  // the next day both blanks can be asked: the one answered wrong (wait 1 day) goes before the one never asked (D28)
  P.tick(DAY);
  assert.equal(C.counts("b2", P.state.clock).due, 2);
  const t2 = await P.session("book", "b2");
  assert.deepEqual(t2.asked, ["p_y#0"]);
  assert.equal(t2.sum.held, 1, "the blank never asked waits one more day");
  const wrong = plain(C.prompt("p_y")).cards[0];
  assert.ok(Math.abs(wrong.intervalMs / DAY - 1.725) < 0.01, "a right answer after a day: 1 day times 1.725, got " + wrong.intervalMs / DAY);
  assert.equal(wrong.growth, 1840, "three wrong answers in one session are one lapse (1725); the right answer won a fifth back");
  P.tick(DAY);
  const t3 = await P.session("book", "b2");
  assert.deepEqual(t3.asked, ["p_y#1"]);
  assert.equal(C.counts("b2", P.state.clock).due, 0);
});

test("Review today's takes one blank of each sentence written today, due or not; its other blanks wait until the next day there too (D29)", async () => {
  const P = await page().boot();
  await save(P, written(P, "p_t", "b1", "Today {a}, {b} and {c}.", T0 - 60 * MIN));
  await save(P, written(P, "p_y", "b1", "Yesterday {a} and {b}.", T0 - DAY));
  const asked = [];
  for (let i = 0; i < 3; i++) { const s = await P.session("today", "b1"); asked.push(s.asked.join(",")); if (i === 0) assert.equal(s.sum.held, 2); }
  assert.deepEqual(asked, ["p_t#0", "p_t#0", "p_t#0"], "the same blank again (due or not); never another blank on the same day");
  assert.deepEqual((await P.session("all", null)).asked, ["p_y#0"], "yesterday's sentence was not part of today's review");
  P.tick(NEXT_DAY);
  assert.deepEqual((await P.session("all", null)).asked.slice().sort(), ["p_t#1", "p_y#1"], "the next day: the next blank of each sentence");
});

test("the import merge keeps the rule: a card without answers replays to 'due from the moment it was made'", async () => {
  const P = await page().boot(), sc = P.M.scheduler;
  assert.deepEqual(plain(sc.replay(T0 - 9 * DAY, [])), plain(sc.newSchedule(T0 - 9 * DAY)));
  assert.equal(sc.replay(T0 - 9 * DAY, []).dueAt, T0 - 9 * DAY);
  const answered = sc.replay(T0 - 9 * DAY, [{ at: T0 - 9 * DAY + MIN, outcome: "remembered" }]);
  assert.equal(answered.intervalMs, 5 * DAY);
  assert.equal(sc.isDue(answered, T0 - 6 * DAY), false);
  assert.equal(sc.isDue(answered, T0), true);
});
