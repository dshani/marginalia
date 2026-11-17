"use strict";
// test/struggle.test.js — struggling prompts (FEATURES P1.4 a, b; BUILD-NOTES "Prompt craft"):
// M.scheduler.missDays / struggling / STRUGGLE_DAYS / promptMissDays. Pure; the days are local days (M.util.dayKey).
// Run from the project root: node --test
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const js = (name) => path.join(__dirname, "..", "js", name + ".js");
const U = require(js("util"));
const S = require(js("scheduler"));

const local = (d, h, m) => new Date(2026, 10, d, h, m || 0).getTime();   // November 2026, local time
const miss = (t) => ({ at: t, outcome: "forgot", intervalMs: 600000, dueAt: t + 600000 });
const hit = (t) => ({ at: t, outcome: "remembered", intervalMs: S.FIRST, dueAt: t + S.FIRST });
const cardOf = (log) => ({ createdAt: local(1, 8), lastReviewedAt: null, intervalMs: S.FIRST, dueAt: local(30, 8), log });

test("STRUGGLE_DAYS is 3", () => {
  assert.equal(S.STRUGGLE_DAYS, 3);
});

test("missDays counts different local days with a 'forgot' entry; several misses on one day count once", () => {
  assert.equal(S.missDays(cardOf([miss(local(2, 9)), miss(local(2, 9, 10)), miss(local(2, 23, 59))])), 1, "three misses on one day");
  assert.equal(S.struggling(cardOf([miss(local(2, 9)), miss(local(2, 9, 10)), miss(local(2, 23, 59))])), false, "one miss day is not struggling");
  assert.equal(S.missDays(cardOf([miss(local(2, 23, 59)), miss(local(3, 0, 1))])), 2, "either side of local midnight");
  const three = cardOf([miss(local(2, 9)), hit(local(7, 9)), miss(local(12, 9)), miss(local(12, 9, 10)), miss(local(20, 9))]);
  assert.equal(S.missDays(three), 3);
  assert.equal(S.struggling(three), true);
  assert.equal(U.dayKey(local(2, 23, 59)) !== U.dayKey(local(3, 0, 1)), true);
});

test("only outcome 'forgot' counts; an empty or missing log is 0", () => {
  assert.equal(S.missDays(cardOf([hit(local(2, 9)), hit(local(3, 9)), hit(local(4, 9))])), 0);
  assert.equal(S.missDays(cardOf([{ at: local(2, 9), outcome: "skip" }, { at: local(3, 9), outcome: "FORGOT" }, null, { outcome: "forgot" }, { at: "x", outcome: "forgot" }])), 0);
  assert.equal(S.missDays(cardOf([])), 0);
  assert.equal(S.missDays({}), 0);
  assert.equal(S.missDays(null), 0);
  assert.equal(S.struggling(cardOf([])), false);
});

test("since cuts the log: only entries at >= since count; since defaults to 0", () => {
  const c = cardOf([miss(local(2, 9)), miss(local(5, 9)), miss(local(8, 9)), miss(local(11, 9))]);
  assert.equal(S.missDays(c), 4);
  assert.equal(S.missDays(c, 0), 4);
  assert.equal(S.missDays(c, local(5, 9)), 3, "an entry at exactly since counts");
  assert.equal(S.missDays(c, local(5, 9) + 1), 2);
  assert.equal(S.struggling(c, local(5, 9)), true);
  assert.equal(S.struggling(c, local(5, 9) + 1), false);
  assert.equal(S.missDays(c, local(12, 0)), 0);
  assert.equal(S.missDays(c, "soon"), 4, "a since that is not a number reads as 0");
});

// FIXES-1 FIX-5: the count runs from revisedAt (the last change of the text), no longer from contentUpdatedAt
test("promptMissDays: the most of any card since the prompt's revisedAt; live Q./A. and cloze prompts only", () => {
  const busy = [miss(local(2, 9)), miss(local(5, 9)), miss(local(8, 9))];
  const p = { id: "p", kind: "cloze", deletedAt: null, revisedAt: local(1, 8), cards: [cardOf([miss(local(2, 9))]), cardOf(busy)] };
  assert.equal(S.promptMissDays(p), 3);
  assert.equal(S.promptMissDays(Object.assign({}, p, { revisedAt: local(4, 0) })), 2, "a text edit restarts the count");
  assert.equal(S.promptMissDays(Object.assign({}, p, { revisedAt: undefined })), 3, "no revisedAt (an old record): since 0");
  assert.equal(S.promptMissDays(Object.assign({}, p, { revisedAt: undefined, contentUpdatedAt: local(4, 0) })), 3, "contentUpdatedAt is not read");
  assert.equal(S.promptMissDays(Object.assign({}, p, { kind: "qa" })), 3);
  assert.equal(S.promptMissDays(Object.assign({}, p, { kind: "note" })), 0);
  assert.equal(S.promptMissDays(Object.assign({}, p, { kind: "highlight" })), 0);
  assert.equal(S.promptMissDays(Object.assign({}, p, { deletedAt: local(9, 9) })), 0);
  assert.equal(S.promptMissDays(Object.assign({}, p, { cards: undefined })), 0);
  assert.equal(S.promptMissDays(null), 0);
});

test("nothing is stored: missDays reads the log and changes nothing; replay ignores it", () => {
  const log = [miss(local(2, 9)), miss(local(5, 9)), miss(local(8, 9))];
  const c = cardOf(log.slice());
  const before = JSON.stringify(c);
  S.missDays(c); S.struggling(c); S.promptMissDays({ kind: "qa", cards: [c] });
  assert.equal(JSON.stringify(c), before);
  assert.deepEqual(Object.keys(S.replay(local(1, 8), log)).sort(), Object.keys(S.newSchedule(local(1, 8))).sort(), "no new field on a schedule");
});
