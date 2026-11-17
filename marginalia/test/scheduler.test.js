"use strict";
// test/scheduler.test.js — SPEC §12 bullets for M.scheduler (§7 vectors verbatim).
// Run from the project root: node --test test/scheduler.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// scheduler.js resolves M.util through dep(). util.js is written by another
// track; when it is absent (or lacks a function) a minimal stand-in with the
// §17 semantics is installed so this file runs on its own.
const M = (globalThis.Marginalia = globalThis.Marginalia || {});
try { require(path.join(__dirname, "..", "js", "util.js")); } catch (e) { /* util.js not present yet */ }
const utilStub = {
  hash32(str) {
    let h = 0x811c9dc5;
    const s = String(str);
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h >>> 0;
  },
  localMidnight(now) { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); },
  dayKey(ms) {
    const d = new Date(ms), p = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  },
};
M.util = M.util || {};
for (const k of Object.keys(utilStub)) if (typeof M.util[k] !== "function") M.util[k] = utilStub[k];

const S = require(path.join(__dirname, "..", "js", "scheduler.js"));
const { DAY, FIRST, LAPSE, NEXT_DAY, LOOKAHEAD, LEGEND, MAX_ASKS } = S;
const TEN_MIN = 600000;
const util = M.util;

function sched(fields) {
  return Object.assign({ createdAt: 0, lastReviewedAt: null, intervalMs: FIRST, dueAt: FIRST, log: [] }, fields);
}

// ---------------------------------------------------------------------------
test("constants match §7", () => {
  assert.equal(DAY, 86400000);
  assert.equal(S.GROWTH, 2.3);
  assert.equal(FIRST, 5 * DAY);
  assert.equal(LAPSE, DAY);                                            // D28: the wait after a wrong answer
  assert.equal(NEXT_DAY, 16 * 3600000);                                // D29
  assert.equal(S.GROWTH_FULL, 2300); assert.equal(S.GROWTH_LEAST, 1000);
  assert.equal(S.RETRY, undefined, "no 10-minute retry time any more (D28)");
  assert.equal(LOOKAHEAD, 16 * 3600000);
  assert.deepEqual(Array.from(LEGEND), [5, 11.5, 26.45, 60.835, 139.9205, 321.81715].map((d) => d * DAY));
  assert.equal(S.SCHEDULER_VERSION, 1);
  assert.equal(MAX_ASKS, 3);
  assert.equal(S.LEGEND_LABELS.length, 6);
});

// ---- §7 test vectors, verbatim ---------------------------------------------
test("vector: new at t=1000 → interval 432 000 000, due 1000 (D27: a new card is due at once)", () => {
  const s = S.newSchedule(1000);
  assert.equal(s.intervalMs, 432000000);
  assert.equal(s.dueAt, 1000);
  assert.equal(s.createdAt, 1000);
  assert.equal(s.lastReviewedAt, null);
  assert.equal(s.growth, 2300);                                        // D28: the full growth factor, in thousandths
  assert.deepEqual(s.log, []);
});

test("vector: remembered at t=2000 → interval unchanged, due 432 002 000", () => {
  const g = S.grade(S.newSchedule(1000), 2000, "remembered");
  assert.equal(g.intervalMs, 432000000);
  assert.equal(g.dueAt, 432002000);
  assert.equal(g.lastReviewedAt, 2000);
  assert.deepEqual(g.log, [{ at: 2000, outcome: "remembered", intervalMs: 432000000, dueAt: 432002000 }]);
  assert.equal(g.growth, 2300);
});

test("vector: forgot at t=10 000 → interval 86 400 000 (1 day), due 86 410 000, growth 1725 (D28)", () => {
  const g = S.grade(S.newSchedule(1000), 10000, "forgot");
  assert.equal(g.intervalMs, 86400000);
  assert.equal(g.dueAt, 86410000);
  assert.equal(g.growth, 1725);
  assert.deepEqual(g.log, [{ at: 10000, outcome: "forgot", intervalMs: 86400000, dueAt: 86410000 }]);
});

test("vector: interval 10 d reviewed exactly on time → 23 d", () => {
  const t0 = 1700000000000; // t0 % 1000 === 0 → jitter 0
  const s = sched({ createdAt: t0 - 30 * DAY, lastReviewedAt: t0, intervalMs: 10 * DAY, dueAt: t0 + 10 * DAY });
  const g = S.grade(s, t0 + 10 * DAY, "remembered");
  assert.equal(g.intervalMs, 23 * DAY);
  assert.equal(g.dueAt, t0 + 10 * DAY + 23 * DAY);
  assert.equal(S.preview(s, t0 + 10 * DAY, "remembered"), 23 * DAY);
});

test("vector: interval 10 d reviewed 10 d late → 46 d", () => {
  const t0 = 1700000000000;
  const s = sched({ createdAt: t0 - 30 * DAY, lastReviewedAt: t0, intervalMs: 10 * DAY, dueAt: t0 + 10 * DAY });
  const g = S.grade(s, t0 + 20 * DAY, "remembered");
  assert.equal(g.intervalMs, 46 * DAY);
});

test("vector: interval 10 d forgotten → 1 d, due the next day (+ jitter), growth 1725 (D28)", () => {
  const t0 = 1700000000000;
  const s = sched({ createdAt: t0 - 30 * DAY, lastReviewedAt: t0, intervalMs: 10 * DAY, dueAt: t0 + 10 * DAY });
  const now = t0 + 10 * DAY + 123; // jitter(now) = 123 · 600
  const g = S.grade(s, now, "forgot");
  assert.equal(g.intervalMs, DAY);
  assert.equal(g.dueAt, now + LAPSE + S.jitter(now));
  assert.equal(g.dueAt, now + 86400000 + 73800);
  assert.equal(g.growth, 1725);
  assert.equal(S.preview(s, now, "forgot"), DAY);
});

test("vector: interval 365 d forgotten → 1 d whatever the wait was; remembered 10 min later → unchanged (D28)", () => {
  const t0 = 1700000000000;
  const s = sched({ createdAt: t0 - 400 * DAY, lastReviewedAt: t0, intervalMs: 365 * DAY, dueAt: t0 + 365 * DAY });
  const forgot = S.grade(s, t0 + 365 * DAY, "forgot");
  assert.equal(forgot.intervalMs, DAY);
  assert.equal(forgot.dueAt, t0 + 365 * DAY + LAPSE);
  assert.equal(forgot.growth, 1725);
  const again = S.grade(forgot, t0 + 365 * DAY + 10 * 60000, "remembered");
  assert.equal(again.intervalMs, DAY);                               // the retry keeps the 1-day wait …
  assert.equal(again.dueAt, t0 + 365 * DAY + 10 * 60000 + LAPSE);     // … from the retry
  assert.equal(again.growth, 1725);                                  // … and wins nothing back
  assert.equal(again.log.length, 2);
});

test("vector: jitter(1 234 567) = 340 200", () => {
  assert.equal(S.jitter(1234567), 340200);
});

test("vector: rung(5 d) = 0, rung(5.6 d) = 0, rung(11.5 d) = 1, rung(0) = −1", () => {
  assert.equal(S.rung(5 * DAY), 0);
  assert.equal(S.rung(5.6 * DAY), 0);
  assert.equal(S.rung(11.5 * DAY), 1);
  assert.equal(S.rung(0), -1);
});

// ---- isDue, jitter range, rung edges, rayValue --------------------------------
test("isDue at exactly now + 16 h is due; one ms later is not", () => {
  const now = 1700000000000;
  assert.equal(S.isDue({ dueAt: now + LOOKAHEAD }, now), true);
  assert.equal(S.isDue({ dueAt: now + LOOKAHEAD + 1 }, now), false);
  assert.equal(S.isDue({ dueAt: now - DAY }, now), true);
  assert.equal(S.isDue({}, now), false);
  assert.equal(S.isDue(null, now), false);
});

test("jitter stays in 0 … 599 400 and is a multiple of 600", () => {
  for (let i = 0; i < 2000; i++) {
    const now = 1700000000000 + i * 7919 + i;
    const j = S.jitter(now);
    assert.ok(j >= 0 && j <= 599400, "range " + j);
    assert.equal(j % 600, 0);
  }
  assert.equal(S.jitter(1700000000000), 0);
  assert.equal(S.jitter(1700000000999), 599400);
});

test("rung edges: just under and just over each legend stop, below and above the ladder", () => {
  assert.equal(S.rung(1), -1);
  assert.equal(S.rung(TEN_MIN), -1);
  assert.equal(S.rung(4 * DAY), -1);                                 // 4.4 d < 5 d
  assert.equal(S.rung(10 * DAY), 0);                                 // 11 d < 11.5 d
  assert.equal(S.rung(10.5 * DAY), 1);                               // 11.55 d ≥ 11.5 d
  assert.equal(S.rung(LEGEND[2] / 1.1 + 1), 2);
  assert.equal(S.rung(LEGEND[2] / 1.1 - DAY), 1);
  assert.equal(S.rung(LEGEND[5]), 5);                                // above the ladder
  assert.equal(S.rung(100 * LEGEND[5]), 5);
  assert.equal(S.rung(LEGEND[4] / 1.1 - 1), 3);
});

test("rayValue maps the log scale onto 0.1 … 1 and clamps", () => {
  assert.equal(S.rayValue(0), 0);
  assert.equal(S.rayValue(-5), 0);
  assert.equal(S.rayValue(TEN_MIN), 0);                                // far below FIRST → clamped
  assert.ok(Math.abs(S.rayValue(FIRST) - 0.1) < 1e-9);
  assert.ok(Math.abs(S.rayValue(LEGEND[5]) - 1) < 1e-9);
  assert.equal(S.rayValue(LEGEND[5] * 10), 1);
  const mid = S.rayValue(LEGEND[2]);
  assert.ok(mid > 0.1 && mid < 1);
  assert.ok(S.rayValue(LEGEND[1]) < S.rayValue(LEGEND[2]));
  assert.ok(S.rayValue(LEGEND[2]) < S.rayValue(LEGEND[3]));
});

// ---- grade semantics ----------------------------------------------------------
test("grade throws code bad_outcome for anything but remembered/forgot", () => {
  const s = S.newSchedule(1000);
  for (const bad of ["good", "", null, undefined, 1, "Remembered"]) {
    assert.throws(() => S.grade(s, 2000, bad), (e) => e instanceof Error && e.code === "bad_outcome");
  }
  assert.throws(() => S.preview(s, 2000, "easy"), (e) => e.code === "bad_outcome");
});

test("grade never mutates its input: the previous object is an exact undo", () => {
  const s = S.newSchedule(1000);
  const snapshot = JSON.parse(JSON.stringify(s));
  const g1 = S.grade(s, 5000, "forgot");
  const g2 = S.grade(g1, 9000, "remembered");
  assert.notEqual(g1, s);
  assert.notEqual(g1.log, s.log);
  assert.deepEqual(s, snapshot);                                      // untouched
  assert.deepEqual(JSON.parse(JSON.stringify(g1)), { ...g2, log: g2.log.slice(0, 1), lastReviewedAt: 5000, intervalMs: g1.intervalMs, dueAt: g1.dueAt });
  // single-level undo = keep the previous card object
  const restored = g1;
  assert.equal(restored.log.length, 1);
  assert.equal(restored.lastReviewedAt, 5000);
});

test("grade grows on a late review from elapsed, keeps the interval on an early one; a wrong answer gives 1 day", () => {
  const t0 = 1700000000000;
  const s = sched({ createdAt: t0 - 100 * DAY, lastReviewedAt: t0, intervalMs: 20 * DAY, dueAt: t0 + 20 * DAY });
  // early (elapsed 2 d < 20 d): max(intervalMs, FIRST, grown)
  assert.equal(S.grade(s, t0 + 2 * DAY, "remembered").intervalMs, 20 * DAY);
  // on time: 46 d
  assert.equal(S.grade(s, t0 + 20 * DAY, "remembered").intervalMs, 46 * DAY);
  // forgot: 1 d (D28; before: one rung back, floor(20 d / 2.3))
  assert.equal(S.grade(s, t0 + 20 * DAY, "forgot").intervalMs, DAY);
  assert.equal(S.grade(s, t0 + 2 * DAY, "forgot").intervalMs, DAY, "also when the answer comes early");
  // an interval below a day (hand-made data) becomes 1 d too
  const tiny = sched({ createdAt: t0, lastReviewedAt: t0, intervalMs: 3600000, dueAt: t0 + 3600000 });
  assert.equal(S.grade(tiny, t0 + DAY, "forgot").intervalMs, DAY);
  // … and a right answer lifts it: to 5 days for a card never answered wrong (as before D28), to 1 day at least for
  // a card that comes back from a wrong answer (its growth factor is below the full one)
  assert.equal(S.grade(tiny, t0 + DAY, "remembered").intervalMs, FIRST);
  assert.equal(S.grade(tiny, t0 + 60000, "remembered").intervalMs, FIRST);
  const tinyLapsed = Object.assign({}, tiny, { growth: 1725 });
  assert.equal(S.grade(tinyLapsed, t0 + DAY, "remembered").intervalMs, Math.floor(DAY * 1725 / 1000));
  assert.equal(S.grade(tinyLapsed, t0 + 60000, "remembered").intervalMs, DAY);
  // first review uses createdAt when lastReviewedAt is null
  const fresh = S.newSchedule(t0);
  assert.equal(S.grade(fresh, t0 + 5 * DAY, "remembered").intervalMs, Math.floor(5 * DAY * 23 / 10));
  // a wait or a time that is no number never gives NaN
  const odd = S.grade({ createdAt: t0, lastReviewedAt: t0, dueAt: t0, log: [] }, t0 + DAY, "remembered");
  assert.equal(odd.intervalMs, FIRST); assert.equal(odd.dueAt, t0 + DAY + FIRST);
  const noTime = S.grade({ lastReviewedAt: null, intervalMs: FIRST, log: [] }, t0, "remembered");
  assert.equal(noTime.intervalMs, FIRST); assert.equal(noTime.dueAt, t0 + FIRST);
});

// ---- replay -------------------------------------------------------------------
test("replay equals sequential grading, whatever the log order", () => {
  const t0 = 1700000000000;
  const outcomes = ["remembered", "forgot", "remembered", "remembered", "forgot", "remembered"];
  let s = S.newSchedule(t0);
  const ats = [];
  let at = t0;
  for (const o of outcomes) {
    at += (o === "forgot" ? 3 * DAY : 6 * DAY) + 123;
    ats.push(at);
    s = S.grade(s, at, o);
  }
  const shuffled = s.log.slice().reverse();
  shuffled.push(shuffled.shift());
  const r = S.replay(t0, shuffled);
  assert.deepEqual(r, s);
  // a log with stale intervals/dueAt (from an older scheduler) is recomputed
  const stale = s.log.map((e) => ({ at: e.at, outcome: e.outcome, intervalMs: 1, dueAt: 2 }));
  assert.deepEqual(S.replay(t0, stale), s);
  assert.deepEqual(S.replay(t0, []), S.newSchedule(t0));
  assert.deepEqual(S.replay(t0, undefined), S.newSchedule(t0));
});

// ---- queue --------------------------------------------------------------------
let seq = 0;
// A card that was answered before (lastReviewedAt 1), so that its dueAt decides (a card never asked is due at once: D27).
function card(i, dueAt, extra) {
  return Object.assign({ i, createdAt: 1, lastReviewedAt: 1, intervalMs: FIRST, dueAt, log: [] }, extra);
}
// A card never asked, as stored before D27 (dueAt = createdAt + FIRST) or since (dueAt = createdAt).
function fresh(i, createdAt, old) {
  return { i, createdAt, lastReviewedAt: null, intervalMs: FIRST, dueAt: old ? createdAt + FIRST : createdAt, log: [] };
}
function prompt(o) {
  seq++;
  const p = {
    id: o.id || "p" + seq,
    collectionId: o.collectionId || "book1",
    kind: o.kind || "qa",
    text: o.text || "Q. q\nA. a",
    anchor: o.anchor === undefined ? { pageIndex: o.pageIndex || 0, y: o.y === undefined ? 500 : o.y, pages: [], quote: "" } : o.anchor,
    context: o.context || null,
    cards: o.cards || [card(0, o.dueAt === undefined ? 0 : o.dueAt)],
    createdAt: o.createdAt || seq,
    deletedAt: o.deletedAt === undefined ? null : o.deletedAt,
  };
  if (o.cards === undefined && o.kind === "cloze") p.cards = [card(0, o.dueAt || 0), card(1, o.dueAt || 0)];
  return p;
}
const ids = (q) => q.map((it) => it.promptId + "#" + it.cardIndex);

test("buildQueue excludes tombstones, notes, highlights, cardless and other-collection prompts", () => {
  const now = 1700000000000;
  const prompts = [
    prompt({ id: "live", pageIndex: 1 }),
    prompt({ id: "dead", pageIndex: 1, deletedAt: now - 1 }),
    prompt({ id: "note", pageIndex: 1, kind: "note", cards: [] }),
    prompt({ id: "noteWithCards", pageIndex: 1, kind: "note" }),       // cards persist through kind changes, never reviewed
    prompt({ id: "hl", pageIndex: 1, kind: "highlight", cards: [] }),
    prompt({ id: "elsewhere", pageIndex: 1, collectionId: "book2" }),
    prompt({ id: "noCards", pageIndex: 1, cards: [] }),
    prompt({ id: "notDue", pageIndex: 1, dueAt: now + 30 * DAY }),
  ];
  assert.deepEqual(ids(S.buildQueue({ prompts, scope: "book", collectionId: "book1", now, seed: 1 })), ["live#0"]);
  assert.deepEqual(ids(S.buildQueue({ prompts, scope: "all", collectionId: null, now, seed: 1 })).sort(), ["elsewhere#0", "live#0"]);
  assert.deepEqual(S.buildQueue({ prompts: [], scope: "all", now, seed: 1 }), []);
  assert.deepEqual(S.buildQueue({ prompts, scope: "book", collectionId: "nothing", now, seed: 1 }), []);
});

test("buildQueue returns plain {promptId, cardIndex} items (cardIndex = array position)", () => {
  const now = 1700000000000;
  const p = prompt({ id: "c", kind: "cloze", cards: [card(0, 0), card(1, now + 30 * DAY), card(2, 0)] });
  const q = S.buildQueue({ prompts: [p], scope: "deck", collectionId: "book1", now, seed: 1 });
  assert.deepEqual(q, [{ promptId: "c", cardIndex: 0 }], "one card per prompt (D27): of two due cards with the same time, the lower index");
  const p2 = prompt({ id: "c2", kind: "cloze", cards: [card(0, now + 30 * DAY), card(1, 5), card(2, 3)] });
  assert.deepEqual(S.buildQueue({ prompts: [p2], scope: "deck", collectionId: "book1", now, seed: 1 }), [{ promptId: "c2", cardIndex: 2 }], "cardIndex is the array position of the card that waits longest");
});

test("book scope: due cards in reading order (pageIndex, −y, createdAt, cardIndex)", () => {
  const now = 1700000000000;
  const prompts = [
    prompt({ id: "p3-low", pageIndex: 3, y: 100, createdAt: 10 }),
    prompt({ id: "p1-low", pageIndex: 1, y: 100, createdAt: 20 }),
    prompt({ id: "p1-high", pageIndex: 1, y: 700, createdAt: 30 }),
    prompt({ id: "p2-b", pageIndex: 2, y: 400, createdAt: 50 }),
    prompt({ id: "p2-a", pageIndex: 2, y: 400, createdAt: 40 }),
    prompt({ id: "lost", anchor: null, context: { pageIndex: 2 }, createdAt: 60 }),   // behaves as lost at the page top
    prompt({ id: "future", pageIndex: 0, dueAt: now + 10 * DAY }),
  ];
  const q = S.buildQueue({ prompts, scope: "book", collectionId: "book1", now, seed: 7 });
  assert.deepEqual(ids(q), ["p1-high#0", "p1-low#0", "lost#0", "p2-a#0", "p2-b#0", "p3-low#0"]);
});

test("deck scope: due cards by (createdAt, cardIndex)", () => {
  const now = 1700000000000;
  const prompts = [
    prompt({ id: "later", collectionId: "deck1", anchor: null, createdAt: 300, kind: "cloze", cards: [card(0, 0), card(1, 0)] }),
    prompt({ id: "earlier", collectionId: "deck1", anchor: null, createdAt: 100 }),
    prompt({ id: "other", collectionId: "deck2", anchor: null, createdAt: 50 }),
  ];
  const q = S.buildQueue({ prompts, scope: "deck", collectionId: "deck1", now, seed: 7 });
  assert.deepEqual(ids(q), ["earlier#0", "later#0"], "the cloze gives one of its two due cards (D27)");
});

test("today scope: prompts created since local midnight, ignoring dueness, reading order", () => {
  const now = 1700000000000 + 15 * 3600000;                            // some afternoon
  const midnight = util.localMidnight(now);
  const prompts = [
    prompt({ id: "today-p5", pageIndex: 5, createdAt: midnight + 3000, dueAt: now + 5 * DAY }),
    prompt({ id: "today-p2", pageIndex: 2, createdAt: midnight + 2000, dueAt: now + 5 * DAY }),
    prompt({ id: "at-midnight", pageIndex: 9, createdAt: midnight, dueAt: now + 5 * DAY }),
    prompt({ id: "yesterday-due", pageIndex: 1, createdAt: midnight - 1, dueAt: now - DAY }),
    prompt({ id: "other-coll", collectionId: "deck1", anchor: null, createdAt: midnight + 1000, dueAt: now + 5 * DAY }),
    prompt({ id: "today-note", kind: "note", createdAt: midnight + 4000 }),
  ];
  const q = S.buildQueue({ prompts, scope: "today", collectionId: "book1", now, seed: 1 });
  assert.deepEqual(ids(q), ["today-p2#0", "today-p5#0", "at-midnight#0"]);
  // from the library (collectionId null): every collection, in the order the writer started on them
  // today (book1's first prompt was written at midnight, before deck1's at midnight + 1 s)
  const all = S.buildQueue({ prompts, scope: "today", collectionId: null, now, seed: 1 });
  assert.deepEqual(ids(all), ["today-p2#0", "today-p5#0", "at-midnight#0", "other-coll#0"]);
  prompts.push(prompt({ id: "deck-first", collectionId: "deck1", anchor: null, createdAt: midnight - 1, dueAt: now + DAY })); // yesterday
  prompts.push(prompt({ id: "deck-early", collectionId: "deck2", anchor: null, createdAt: midnight + 500, dueAt: now + DAY }));
  const all2 = S.buildQueue({ prompts, scope: "today", collectionId: null, now, seed: 1 });
  assert.deepEqual(ids(all2), ["today-p2#0", "today-p5#0", "at-midnight#0", "deck-early#0", "other-coll#0"]);
});

test("all scope: one due card per prompt, ordered by (dayKey(dueTime), hash32(seed + promptId + cardIndex)), deterministic", () => {
  const now = Date.UTC(2026, 10, 3, 12, 0, 0);                         // noon UTC, safely inside a local day
  const seed = 424242;
  const prompts = [
    prompt({ id: "b1-old", collectionId: "book1", dueAt: now - 3 * DAY }),
    prompt({ id: "b2-old", collectionId: "book2", dueAt: now - 3 * DAY + 1000 }),
    prompt({ id: "d-old", collectionId: "deck1", anchor: null, dueAt: now - 3 * DAY + 2000 }),
    prompt({ id: "b1-y", collectionId: "book1", dueAt: now - DAY }),
    prompt({ id: "b2-y", collectionId: "book2", dueAt: now - DAY + 1000 }),
    prompt({ id: "d-y", collectionId: "deck1", anchor: null, kind: "cloze", cards: [card(0, now - DAY + 2000), card(1, now - DAY + 3000)] }),
    prompt({ id: "soon", collectionId: "book1", dueAt: now + LOOKAHEAD }),
    prompt({ id: "later", collectionId: "book1", dueAt: now + LOOKAHEAD + 1 }),
  ];
  const q = S.buildQueue({ prompts, scope: "all", collectionId: null, now, seed });
  assert.equal(q.length, 7);                                           // d-y has two due cards and gives one (D27)
  assert.ok(ids(q).includes("d-y#0") && !ids(q).includes("d-y#1"), "the one that is due first");
  assert.ok(!ids(q).includes("later#0"));
  assert.ok(ids(q).includes("soon#0"));
  // expected order computed independently with the same util
  const byId = new Map(prompts.map((p) => [p.id, p]));
  const expected = q.slice().sort((a, b) => {
    const ka = [util.dayKey(byId.get(a.promptId).cards[a.cardIndex].dueAt), util.hash32(String(seed) + a.promptId + a.cardIndex)];
    const kb = [util.dayKey(byId.get(b.promptId).cards[b.cardIndex].dueAt), util.hash32(String(seed) + b.promptId + b.cardIndex)];
    return ka[0] < kb[0] ? -1 : ka[0] > kb[0] ? 1 : ka[1] - kb[1];
  });
  assert.deepEqual(q, expected);                                       // sorted; no siblings to spread
  // day keys are non-decreasing along the sorted order; the first three are the oldest day
  const keys = expected.map((it) => util.dayKey(byId.get(it.promptId).cards[it.cardIndex].dueAt));
  for (let i = 1; i < keys.length; i++) assert.ok(keys[i - 1] <= keys[i]);
  assert.deepEqual(ids(q.slice(0, 3)).sort(), ["b1-old#0", "b2-old#0", "d-old#0"]);
  // a seed-only change reshuffles inside a day but never across days
  const q2 = S.buildQueue({ prompts, scope: "all", now, seed: seed + 1 });
  assert.deepEqual(ids(q2.slice(0, 3)).sort(), ["b1-old#0", "b2-old#0", "d-old#0"]);
  // same seed → same order; the seed defaults to now
  assert.deepEqual(S.buildQueue({ prompts, scope: "all", now, seed }), q);
  assert.deepEqual(S.buildQueue({ prompts, scope: "all", now }), S.buildQueue({ prompts, scope: "all", now, seed: now }));
});

test("buildQueue throws code bad_scope for an unknown scope", () => {
  assert.throws(() => S.buildQueue({ prompts: [], scope: "week", now: 1 }), (e) => e.code === "bad_scope");
});

// ---- spread -------------------------------------------------------------------
const it = (p, i) => ({ promptId: p, cardIndex: i });

test("spread defers siblings until 5 items have passed; leftovers go at the end in order", () => {
  const input = [it("A", 0), it("A", 1), it("A", 2), it("B", 0), it("C", 0), it("D", 0), it("E", 0), it("F", 0), it("G", 0)];
  const out = S.spread(input);
  assert.deepEqual(ids(out), ["A#0", "B#0", "C#0", "D#0", "E#0", "F#0", "A#1", "G#0", "A#2"]);
  assert.deepEqual(ids(out).slice().sort(), ids(input).slice().sort());
  assert.equal(out[0], input[0]);                                      // same objects, re-ordered
});

test("spread keeps a sibling at distance 6 and leaves a sibling-free list untouched", () => {
  const free = [it("A", 0), it("B", 0), it("C", 0)];
  assert.deepEqual(S.spread(free), free);
  const six = [it("A", 0), it("B", 0), it("C", 0), it("D", 0), it("E", 0), it("F", 0), it("A", 1)];
  assert.deepEqual(S.spread(six), six);
  const five = [it("A", 0), it("B", 0), it("C", 0), it("D", 0), it("E", 0), it("A", 1), it("F", 0)];
  assert.deepEqual(ids(S.spread(five)), ["A#0", "B#0", "C#0", "D#0", "E#0", "F#0", "A#1"]);
  assert.deepEqual(S.spread([]), []);
  assert.deepEqual(ids(S.spread([it("A", 0), it("A", 1), it("A", 2)])), ["A#0", "A#1", "A#2"]);
});

test("D27 one card per prompt: a 3-card cloze gives one blank to a queue; D29: the others come one day at a time", () => {
  const now = 1700000000000;
  const cz = prompt({ id: "cz", pageIndex: 0, y: 700, kind: "cloze", cards: [card(0, 0), card(1, 0), card(2, 0)] });
  const prompts = [cz, prompt({ id: "q1", pageIndex: 0, y: 600 }), prompt({ id: "q2", pageIndex: 0, y: 500 })];
  const build = (t, scope) => ids(S.buildQueue({ prompts, scope: scope || "book", collectionId: "book1", now: t, seed: 3 }));
  assert.deepEqual(build(now), ["cz#0", "q1#0", "q2#0"]);
  // nothing was written to the other cards: by their own schedule they are still due
  assert.equal(S.isDue(cz.cards[1], now), true); assert.equal(S.isDue(cz.cards[2], now), true);
  assert.equal(S.isReady(cz, 1, now), true); assert.equal(S.heldUntil(cz, 1), 1 + NEXT_DAY, "the fixture's old answers hold nothing now");
  // session 1 answers blank 0 right: the other blanks wait until the next day (16 hours), then come one at a time
  cz.cards[0] = S.grade(cz.cards[0], now, "remembered");
  prompts[1].cards[0] = S.grade(prompts[1].cards[0], now, "remembered");
  prompts[2].cards[0] = S.grade(prompts[2].cards[0], now, "remembered");
  assert.deepEqual(build(now + 60000), [], "a second session right away finds nothing");
  assert.equal(S.heldUntil(cz, 1), now + NEXT_DAY); assert.equal(S.heldUntil(cz, 0), 1 + NEXT_DAY, "its own answer is not a hold");
  assert.equal(S.isReady(cz, 1, now + NEXT_DAY - 1), false); assert.equal(S.isReady(cz, 1, now + NEXT_DAY), true);
  assert.equal(S.readyTime(cz, 1), now + NEXT_DAY);
  assert.equal(S.readyTime(cz, 0), cz.cards[0].dueAt - LOOKAHEAD, "the time from which a session can ask it: its due time less the lookahead");
  assert.deepEqual(build(now + NEXT_DAY - 1), []);
  assert.deepEqual(build(now + NEXT_DAY), ["cz#1"]);
  cz.cards[1] = S.grade(cz.cards[1], now + NEXT_DAY, "remembered");
  assert.deepEqual(build(now + NEXT_DAY + 60000), []);
  assert.deepEqual(build(now + 2 * NEXT_DAY), ["cz#2"]);
  cz.cards[2] = S.grade(cz.cards[2], now + 2 * NEXT_DAY, "remembered");
  assert.deepEqual(build(now + 3 * NEXT_DAY), []);
  // a blank answered wrong is due the next day (D28), and then it goes before the blank never asked: it is the one
  // most overdue for its wait (a day of its 1-day wait; the other blank, made yesterday, two days of its 5 days)
  const cz2 = prompt({ id: "cz2", collectionId: "book9", kind: "cloze", cards: [card(0, now - 1000, { createdAt: now - 6 * DAY, lastReviewedAt: now - 5 * DAY }), fresh(1, now - DAY)] });
  cz2.cards[0] = S.grade(cz2.cards[0], now, "forgot");
  const q = (t) => ids(S.buildQueue({ prompts: [cz2], scope: "all", now: t, seed: 1 }));
  assert.deepEqual(q(now + 60000), [], "blank 0 comes tomorrow, and its answer holds blank 1 back");
  assert.deepEqual(q(now + NEXT_DAY), ["cz2#0"], "both can be asked: the forgotten blank before the blank never asked");
  assert.deepEqual(q(now + DAY), ["cz2#0"]);
  cz2.cards[0] = S.grade(cz2.cards[0], now + DAY, "remembered");        // on time: 1 d · 1.725 = 41.4 h
  assert.equal(cz2.cards[0].intervalMs, Math.floor(DAY * 1725 / 1000));
  assert.deepEqual(q(now + DAY + 60000), []);
  assert.deepEqual(q(now + DAY + NEXT_DAY), ["cz2#1"], "blank 0 is not due yet, so blank 1 has its turn");
  // equally overdue with equal waits: the one that is due longest; then the lowest index
  const cz3 = prompt({ id: "cz3", collectionId: "book8", kind: "cloze", cards: [card(0, 500), card(1, 400), card(2, 400)] });
  assert.deepEqual(ids(S.buildQueue({ prompts: [cz3], scope: "all", now, seed: 1 })), ["cz3#1"]);
  // today's scope asks due or not, but the hold counts there too: the same blank comes again, never another one
  const midnight = util.localMidnight(now);
  const t3 = prompt({ id: "t3", collectionId: "bookT", kind: "cloze", createdAt: midnight + 1000, cards: [fresh(0, midnight + 1000), fresh(1, midnight + 1000), fresh(2, midnight + 1000)] });
  const today = (t) => ids(S.buildQueue({ prompts: [t3], scope: "today", collectionId: "bookT", now: t, seed: 1 }));
  assert.deepEqual(today(now), ["t3#0"]);
  t3.cards[0] = S.grade(t3.cards[0], now, "remembered");
  assert.deepEqual(today(now + 1000), ["t3#0"], "blanks 1 and 2 wait until the next day; blank 0 may come again (due or not)");
  assert.deepEqual(ids(S.buildQueue({ prompts: [t3], scope: "all", now: now + 1000, seed: 1 })), [], "and nothing of it is due");
  assert.deepEqual(ids(S.buildQueue({ prompts: [t3], scope: "all", now: now + NEXT_DAY, seed: 1 })), ["t3#1"]);
});

test("D27 a card never asked is due at once, whatever its stored dueAt; a skip is no answer; its first answer follows Orbit", () => {
  const t0 = 1700000000000;
  const neu = S.newSchedule(t0), old = fresh(0, t0, true);              // old: stored before D27, dueAt = createdAt + 5 d
  assert.equal(old.dueAt, t0 + FIRST);
  for (const c of [neu, old]) {
    assert.equal(S.neverAsked(c), true);
    assert.equal(S.dueTime(c), t0, "due from the moment it was made");
    assert.equal(S.isDue(c, t0), true); assert.equal(S.isDue(c, t0 + 3 * DAY), true); assert.equal(S.isDue(c, t0 - DAY), true);
  }
  // a queue takes them in every scope, the oldest day first
  const a = prompt({ id: "new-old", collectionId: "b", createdAt: 5, cards: [fresh(0, t0 - 2 * DAY, true)] });
  const b = prompt({ id: "new-now", collectionId: "b", createdAt: 6, cards: [S.newSchedule(t0)] });
  const c3 = prompt({ id: "asked-later", collectionId: "b", createdAt: 7, cards: [card(0, t0 + 3 * DAY)] });
  assert.deepEqual(ids(S.buildQueue({ prompts: [b, a, c3], scope: "all", now: t0, seed: 1 })), ["new-old#0", "new-now#0"]);
  assert.deepEqual(ids(S.buildQueue({ prompts: [b, a, c3], scope: "deck", collectionId: "b", now: t0, seed: 1 })), ["new-old#0", "new-now#0"]);
  // the first answer: right on day 0 → 5 d; right after 3 d → 6.9 d; right after 5 d → 11.5 d (Orbit: max(5 d, elapsed · 2.3))
  for (const start of [neu, old]) {
    const d0 = S.grade(start, t0 + 60000, "remembered");
    assert.equal(d0.intervalMs, FIRST); assert.equal(d0.dueAt, t0 + 60000 + S.jitter(t0 + 60000) + FIRST);
    assert.equal(S.neverAsked(d0), false); assert.equal(S.isDue(d0, t0 + 60000), false); assert.equal(S.dueTime(d0), d0.dueAt);
    assert.equal(S.grade(start, t0 + 3 * DAY, "remembered").intervalMs, Math.floor(3 * DAY * 23 / 10));
    assert.equal(S.grade(start, t0 + 5 * DAY, "remembered").intervalMs, Math.floor(5 * DAY * 23 / 10));
    // wrong first (D28): 1 day, due the next day, and it is no longer "never asked"
    const w = S.grade(start, t0 + 60000, "forgot");
    assert.equal(w.intervalMs, LAPSE); assert.equal(w.dueAt, t0 + 60000 + S.jitter(t0 + 60000) + LAPSE);
    assert.equal(w.growth, 1725);
    assert.equal(S.neverAsked(w), false); assert.equal(S.isDue(w, t0 + 60000), false, "not again on the day of its answer");
    assert.equal(S.isDue(w, t0 + 60000 + NEXT_DAY - 1), false); assert.equal(S.isDue(w, t0 + 60000 + NEXT_DAY), true);
    const retry = S.grade(w, t0 + 11 * 60000, "remembered");
    assert.equal(retry.intervalMs, LAPSE); assert.equal(retry.growth, 1725);
  }
  // the helpers on odd input
  assert.equal(S.neverAsked(null), false); assert.equal(S.neverAsked({ lastReviewedAt: 0 }), false, "0 is a time");
  assert.equal(S.dueTime(null), null); assert.equal(S.dueTime({ lastReviewedAt: 5 }), null);
  assert.equal(S.dueTime({ lastReviewedAt: null, dueAt: 9 }), 9, "never asked without a createdAt: its dueAt");
  assert.equal(S.isDue({ lastReviewedAt: null, dueAt: t0 + DAY * 9 }, t0), false, "… and that dueAt decides");
  assert.equal(S.isDue({}, t0), false); assert.equal(S.isDue(null, t0), false);
});

// ---- session mechanics built on the scheduler (§7 "Session") -------------------
test("retry append: a card answered wrong comes back in the session at most MAX_ASKS times, and is due the next day (D28)", () => {
  const t0 = 1700000000000;
  const prompts = [prompt({ id: "shaky", pageIndex: 0, cards: [card(0, t0 - DAY)] }), prompt({ id: "solid", pageIndex: 1, cards: [card(0, t0 - DAY)] })];
  const cards = { shaky: prompts[0].cards[0], solid: prompts[1].cards[0] };
  let queue = S.buildQueue({ prompts, scope: "book", collectionId: "book1", now: t0, seed: 1 });
  const asks = new Map(), last = new Map();
  const order = [];
  let now = t0;
  let passes = 0;
  while (queue.length && passes < 10) {
    passes++;
    const pass = queue;
    queue = [];
    for (const item of pass) {
      now += 15000;
      const key = item.promptId + "#" + item.cardIndex;
      order.push(key);
      const outcome = item.promptId === "shaky" ? "forgot" : "remembered";
      cards[item.promptId] = S.grade(cards[item.promptId], now, outcome);
      asks.set(key, (asks.get(key) || 0) + 1);
      last.set(key, outcome);
    }
    for (const item of pass) {                                         // the session appends the ones answered wrong, original order
      const key = item.promptId + "#" + item.cardIndex;
      if (last.get(key) === "forgot" && asks.get(key) < MAX_ASKS) queue.push(item);
    }
  }
  assert.deepEqual(order, ["shaky#0", "solid#0", "shaky#0", "shaky#0"]);
  assert.equal(asks.get("shaky#0"), MAX_ASKS);
  assert.equal(asks.get("solid#0"), 1);
  assert.equal(S.isDue(cards.shaky, now), false, "the scheduler no longer calls it due on the day of the answer");
  assert.equal(S.isDue(cards.shaky, now + NEXT_DAY), true);            // it comes the next day
  assert.equal(S.isDue(cards.solid, now + NEXT_DAY), false);
  assert.equal(cards.shaky.log.length, 3);
  assert.equal(cards.shaky.intervalMs, LAPSE);
  assert.equal(cards.shaky.growth, 1725, "three wrong answers in one session are one lapse");
});

test("undo restores the exact previous card object and drops the appended retry", () => {
  const t0 = 1700000000000;
  const before = card(0, t0 - DAY, { lastReviewedAt: t0 - 6 * DAY, log: [{ at: t0 - 6 * DAY, outcome: "remembered", intervalMs: FIRST, dueAt: t0 - DAY }] });
  const snapshot = JSON.parse(JSON.stringify(before));
  let current = before;
  let queue = [it("p", 0), it("q", 0)];
  // grade "forgot" → the session appends a retry
  current = S.grade(current, t0, "forgot");
  if (current.log[current.log.length - 1].outcome === "forgot") queue.push(it("p", 0));
  assert.equal(queue.length, 3);
  assert.equal(current.log.length, 2);
  // undo: restore the previous object, remove the retry tail
  current = before;
  queue = queue.slice(0, 2);
  assert.equal(current, before);
  assert.deepEqual(current, snapshot);
  assert.equal(current.log.length, 1);
  assert.equal(current.lastReviewedAt, t0 - 6 * DAY);
});
