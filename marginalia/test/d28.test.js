"use strict";
// test/d28.test.js — DECISIONS D28 and D29 (BUILD-NOTES "Wrong answers and the next day"), the rules themselves:
//  D28  after a wrong answer the wait is 1 day and the card's growth factor drops to three quarters (one lapse per
//       day; a right answer to a due card wins a fifth back); a card never answered wrong is graded as before;
//  D29  no card is due again within 16 hours of an answer to it, or to another card of its prompt.
// Pure: the real util and scheduler modules, no DOM, no storage. The sessions end to end are in test/d27.test.js.
// Run: node --test test/d28.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

require(path.join(__dirname, "..", "js", "util.js"));
const S = require(path.join(__dirname, "..", "js", "scheduler.js"));
const { DAY, FIRST, LAPSE, NEXT_DAY, LOOKAHEAD, GROWTH_FULL, GROWTH_LEAST } = S;
const HOUR = 3600000, MIN = 60000;
const T0 = 1700000000000;                                   // T0 % 1000 === 0, so jitter(T0 + whole seconds) = 0

// A seeded generator, so that a failure can be repeated.
function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The grading rule before D28 (Orbit's rule, as js/scheduler.js had it up to version 1.2.0), kept here to compare with.
function oldGrade(s, now, outcome) {
  const last = (s.lastReviewedAt === null || s.lastReviewedAt === undefined) ? s.createdAt : s.lastReviewedAt;
  const elapsed = Math.max(0, now - last);
  let interval, due;
  if (outcome === "remembered") {
    const grown = Math.floor(elapsed * 23 / 10);
    interval = elapsed < s.intervalMs ? Math.max(s.intervalMs, FIRST, grown) : Math.max(FIRST, grown);
    due = now + S.jitter(now) + interval;
  } else {
    interval = s.intervalMs < FIRST ? s.intervalMs : Math.max(FIRST, Math.floor(s.intervalMs * 10 / 23));
    due = now + S.jitter(now) + 600000;
  }
  const entry = { at: now, outcome, intervalMs: interval, dueAt: due };
  return Object.assign({}, s, { lastReviewedAt: now, intervalMs: interval, dueAt: due, log: (s.log || []).concat([entry]) });
}
const oldNew = (now) => ({ createdAt: now, lastReviewedAt: null, intervalMs: FIRST, dueAt: now + FIRST, log: [] });   // as stored before D27

// A card that was answered right once (5 days) and is due at `t`.
function healthy(t) {
  const s = S.grade(S.newSchedule(t - 6 * DAY), t - 5 * DAY, "remembered");
  assert.equal(s.intervalMs, FIRST);
  return s;
}

test("a card never answered wrong is graded exactly as before D28: the same waits, due times and logs", () => {
  const rand = rng(20261114);
  let steps = 0;
  for (let run = 0; run < 1500; run++) {
    let t = T0 + Math.floor(rand() * 1e9);
    let neu = S.newSchedule(t), old = oldNew(t), ref = oldNew(t);
    const n = 1 + Math.floor(rand() * 12);
    for (let i = 0; i < n; i++) {
      // gaps from a minute to more than a year; some answers come early, some late, some at the very same time
      const kind = rand();
      const gap = kind < 0.1 ? 0 : kind < 0.3 ? Math.floor(rand() * 2 * HOUR) : kind < 0.8 ? Math.floor(rand() * 40 * DAY) : Math.floor(rand() * 500 * DAY);
      t += gap;
      neu = S.grade(neu, t, "remembered"); old = S.grade(old, t, "remembered"); ref = oldGrade(ref, t, "remembered");
      for (const got of [neu, old]) {
        assert.equal(got.intervalMs, ref.intervalMs, "run " + run + " step " + i);
        assert.equal(got.dueAt, ref.dueAt, "run " + run + " step " + i);
        assert.equal(got.lastReviewedAt, ref.lastReviewedAt);
        assert.deepEqual(got.log, ref.log);
        assert.equal(got.growth, GROWTH_FULL, "the full growth factor stays");
      }
      steps++;
    }
  }
  assert.ok(steps > 5000, String(steps));
  // the §7 integer arithmetic: 10 days times 2.3 is 23 days to the millisecond, and so is every other time
  const s = { createdAt: T0 - 30 * DAY, lastReviewedAt: T0, intervalMs: 10 * DAY, dueAt: T0 + 10 * DAY, log: [] };
  assert.equal(S.grade(s, T0 + 10 * DAY, "remembered").intervalMs, 23 * DAY);
});

test("the wait grows by the card's growth factor in exact integer arithmetic: floor(elapsed · g / 1000)", () => {
  const rand = rng(7);
  for (let i = 0; i < 4000; i++) {
    const g = [1725, 1294, 1000, 1840, 1932, 2006, 2299, 2300][i % 8];
    const elapsed = 16 * HOUR + Math.floor(rand() * (i % 3 === 0 ? 3e12 : 40 * DAY));     // up to about 95 years
    const s = { createdAt: T0 - 1, lastReviewedAt: T0, intervalMs: DAY, dueAt: T0 + DAY, growth: g, log: [{ at: T0, outcome: "remembered" }] };
    const exact = Number(BigInt(elapsed) * BigInt(g) / 1000n);
    const got = S.grade(s, T0 + elapsed, "remembered").intervalMs;
    // the least wait: 1 day for a card that comes back from a wrong answer (a factor below the full one), else 5 days
    assert.equal(got, Math.max(g < GROWTH_FULL ? DAY : FIRST, exact), "elapsed " + elapsed + " g " + g);
  }
});

test("after a wrong answer: 1 day, then waits that grow by 1.725, 1.84, 1.932 … (Matuschak's sketch on the real time since the last answer)", () => {
  let s = healthy(T0), t = T0;
  s = S.grade(s, t, "forgot");
  assert.deepEqual([s.intervalMs, s.growth, s.dueAt], [LAPSE, 1725, t + LAPSE], "1 day whatever the wait was; three quarters of 2.3");
  // every answer exactly when the wait is over
  const waits = [], growths = [];
  for (let i = 0; i < 8; i++) {
    const elapsed = s.intervalMs, g = s.growth;
    t += elapsed;
    s = S.grade(s, t, "remembered");
    assert.equal(s.intervalMs, Math.floor(elapsed * g / 1000), "step " + i + ": the time since the last answer times the factor before this answer");
    waits.push(Math.round(s.intervalMs / DAY * 100) / 100); growths.push(s.growth);
  }
  assert.deepEqual(waits, [1.73, 3.17, 6.13, 12.3, 25.4, 53.65, 115.34, 251.45]);
  assert.deepEqual(growths, [1840, 1932, 2006, 2065, 2112, 2150, 2180, 2204], "each right answer wins back a fifth of what is missing, rounded up");
  // the factor reaches the full value again, and never passes it
  for (let i = 0; i < 40; i++) { t += s.intervalMs; s = S.grade(s, t, "remembered"); }
  assert.equal(s.growth, GROWTH_FULL);
  // a wrong first answer counts too (the sketch): a new card starts its climb from 1 day
  const first = S.grade(S.newSchedule(T0), T0 + MIN, "forgot");
  assert.deepEqual([first.intervalMs, first.growth], [LAPSE, 1725]);
});

test("one lapse per 16 hours: wrong answers less than 16 hours after a wrong answer count once, whatever came in between; never below 1", () => {
  let s = S.grade(healthy(T0), T0, "forgot");
  assert.equal(s.growth, 1725);
  s = S.grade(s, T0 + 2 * MIN, "forgot"); s = S.grade(s, T0 + 4 * MIN, "forgot");
  assert.deepEqual([s.growth, s.intervalMs], [1725, LAPSE], "the retries of the session are the same lapse");
  assert.equal(S.grade(s, T0 + 4 * MIN + NEXT_DAY - 1, "forgot").growth, 1725, "one millisecond short of 16 hours after the last wrong answer: the same lapse");
  let next = S.grade(s, T0 + 4 * MIN + NEXT_DAY, "forgot");
  assert.equal(next.growth, 1294, "16 hours later: a new lapse (1725 · 3/4 = 1293.75, rounded)");
  next = S.grade(next, next.lastReviewedAt + DAY, "forgot");
  assert.equal(next.growth, GROWTH_LEAST, "970.5 would be below 1: the least is 1000");
  next = S.grade(next, next.lastReviewedAt + DAY, "forgot");
  assert.deepEqual([next.growth, next.intervalMs], [GROWTH_LEAST, LAPSE]);
  // a right retry in between changes nothing in that ("Review today's" can ask the card again on the same day)
  let r = S.grade(healthy(T0), T0, "forgot");
  r = S.grade(r, T0 + 3 * MIN, "remembered");
  assert.equal(S.grade(r, T0 + 5 * HOUR, "forgot").growth, 1725, "wrong, a right retry, wrong again 5 hours later: one lapse");
  assert.equal(S.grade(r, T0 + NEXT_DAY - 1, "forgot").growth, 1725);
  assert.equal(S.grade(r, T0 + NEXT_DAY, "forgot").growth, 1294, "16 hours after the wrong answer: a new lapse");
  // the time of the latest wrong answer counts, wherever it stands in the log
  const unsorted = Object.assign({}, r, { log: r.log.slice().reverse() });
  assert.equal(S.grade(unsorted, T0 + 5 * HOUR, "forgot").growth, 1725);
  // a wrong answer with no wrong answer in the 16 hours before it always counts, also when it comes early
  const early = S.grade(S.newSchedule(T0), T0 + MIN, "remembered");
  assert.deepEqual([S.grade(early, T0 + 3 * HOUR, "forgot").growth, S.grade(early, T0 + 3 * HOUR, "forgot").intervalMs], [1725, LAPSE]);
});

test("the growth factor comes back only with a right answer to a card that was due", () => {
  const lapsed = S.grade(healthy(T0), T0, "forgot");
  // the retry a few minutes later: 1 day from the retry, nothing won back
  const retry = S.grade(lapsed, T0 + 5 * MIN, "remembered");
  assert.deepEqual([retry.intervalMs, retry.growth, retry.dueAt], [LAPSE, 1725, T0 + 5 * MIN + LAPSE]);
  // "Review today's" asks due or not: an answer before the card is due wins nothing back either
  assert.equal(S.isDue(retry, T0 + 10 * HOUR), false);
  const tooEarly = S.grade(retry, T0 + 10 * HOUR, "remembered");
  assert.deepEqual([tooEarly.intervalMs, tooEarly.growth], [LAPSE, 1725], "the wait is kept, never shortened");
  // 16 hours after the retry the card is due: the wait grows from the real time, and a fifth comes back
  const due = T0 + 5 * MIN + NEXT_DAY;
  assert.equal(S.isDue(retry, due), true);
  const onTime = S.grade(retry, due, "remembered");
  assert.deepEqual([onTime.intervalMs, onTime.growth], [Math.floor(NEXT_DAY * 1725 / 1000), 1840], "16 h · 1.725 = 27.6 h, more than the day it had");
  // with the least factor the wait does not grow at the earliest time, but the factor does, so it grows soon
  let slow = Object.assign({}, retry, { growth: 1000 }), t = T0 + 5 * MIN, answers = 0;
  while (slow.intervalMs <= LAPSE) { t += NEXT_DAY; assert.equal(S.isDue(slow, t), true); slow = S.grade(slow, t, "remembered"); answers++; }
  assert.equal(answers, 4, "16 h times 1.0, 1.26 and 1.468 is less than a day; the fourth answer (16 h times 1.634) lengthens the wait");
  // a card never answered wrong has nothing to win back
  assert.equal(S.grade(S.newSchedule(T0), T0 + MIN, "remembered").growth, GROWTH_FULL);
});

test("the least wait: 1 day while the card comes back from a wrong answer (its wait is below 5 days), 5 days else", () => {
  const lapsed = S.grade(healthy(T0), T0, "forgot");
  assert.equal(S.grade(lapsed, T0 + 1, "remembered").intervalMs, LAPSE);
  let s = S.grade(lapsed, T0 + DAY, "remembered");                    // 1.725 d
  assert.ok(s.intervalMs > LAPSE && s.intervalMs < FIRST);
  assert.equal(S.grade(s, s.lastReviewedAt + MIN, "remembered").intervalMs, s.intervalMs, "an early answer keeps a wait below 5 days as it is (not 5 days)");
  // once the wait has passed 5 days the old least is back
  const big = { createdAt: T0 - 90 * DAY, lastReviewedAt: T0, intervalMs: 6 * DAY, dueAt: T0 + 6 * DAY, growth: 1000, log: [{ at: T0, outcome: "remembered" }] };
  assert.equal(S.grade(big, T0 + 6 * DAY, "remembered").intervalMs, 6 * DAY, "factor 1: the wait repeats");
  const five = Object.assign({}, big, { intervalMs: FIRST, dueAt: T0 + FIRST });
  assert.equal(S.grade(five, T0 + MIN, "remembered").intervalMs, FIRST);
});

test("a prompt forgotten is never stuck at a short wait, whatever the rhythm of the sessions", () => {
  for (const lapses of [1, 2, 3]) {
    for (const every of [8, 12, 16, 20, 24, 36, 48]) {
      let t = T0, s = healthy(T0);
      for (let i = 0; i < lapses; i++) { s = S.grade(s, t, "forgot"); if (i < lapses - 1) t += DAY; }
      assert.equal(s.growth, [1725, 1294, 1000][lapses - 1]);
      const from = t; let answers = 0, sessions = 0, last = t;
      while (s.intervalMs < FIRST && sessions < 200) {
        t += every * HOUR; sessions++;
        if (!S.isDue(s, t)) continue;
        assert.ok(t - last >= NEXT_DAY, "never asked again within 16 hours of its answer");
        s = S.grade(s, t, "remembered"); answers++; last = t;
      }
      assert.ok(s.intervalMs >= FIRST && answers <= 11 && t - from <= 14 * DAY,
        lapses + " lapse(s), a session every " + every + " h: " + answers + " answers, " + ((t - from) / DAY).toFixed(1) + " days");
      if (every === 24) assert.equal(answers, [3, 6, 7][lapses - 1], "one session a day");
    }
  }
});

test("D29 isDue: a card never asked is due; any other card when its due time is within 16 hours AND its answer is 16 hours old", () => {
  const now = T0;
  const c = (lastReviewedAt, dueAt) => ({ createdAt: now - 30 * DAY, lastReviewedAt, intervalMs: FIRST, dueAt, log: [] });
  assert.equal(S.isDue(c(now - NEXT_DAY, now - 1), now), true);
  assert.equal(S.isDue(c(now - NEXT_DAY + 1, now - 1), now), false, "answered less than 16 hours ago: not again today, although its due time has passed");
  assert.equal(S.isDue(c(now - 5 * DAY, now + LOOKAHEAD), now), true);
  assert.equal(S.isDue(c(now - 5 * DAY, now + LOOKAHEAD + 1), now), false);
  // a card that the rule before D28 stored after a wrong answer (due 10 minutes later) waits the 16 hours too
  const oldLapse = c(now - HOUR, now - HOUR + 10 * MIN);
  assert.equal(S.isDue(oldLapse, now), false);
  assert.equal(S.isDue(oldLapse, now + 15 * HOUR), true);
  // a card answered wrong now: due 1 day later, so with the 16-hour lookahead from 16 hours after the answer
  const lapsed = S.grade(healthy(now), now, "forgot");
  assert.equal(lapsed.dueAt - LOOKAHEAD, now + 8 * HOUR, "the lookahead alone would bring it back after 8 hours");
  assert.equal(S.isDue(lapsed, now + NEXT_DAY - 1), false);
  assert.equal(S.isDue(lapsed, now + NEXT_DAY), true);
  // never asked: due whatever the numbers say (D27); without a createdAt its dueAt decides, and no answer holds it
  assert.equal(S.isDue({ createdAt: now, lastReviewedAt: null, dueAt: now + FIRST }, now), true);
  assert.equal(S.isDue({ lastReviewedAt: null, dueAt: now - 1 }, now), true);
  assert.equal(S.isDue({ lastReviewedAt: undefined, dueAt: now - 1 }, now), true);
  assert.equal(S.isDue({ createdAt: now, lastReviewedAt: now, dueAt: "soon" }, now + DAY), false, "a due time that is no number");
});

test("D29 heldUntil, readyTime and isReady: an answer holds the prompt's other cards back for 16 hours", () => {
  const now = T0;
  const asked = (last, dueAt) => ({ createdAt: now - 30 * DAY, lastReviewedAt: last, intervalMs: FIRST, dueAt, log: [] });
  const never = (createdAt) => ({ createdAt, lastReviewedAt: null, intervalMs: FIRST, dueAt: createdAt, log: [] });
  const p = { id: "p", kind: "cloze", cards: [asked(now - HOUR, now + 5 * DAY), never(now - 9 * DAY), asked(now - 3 * DAY, now - DAY)] };
  assert.equal(S.heldUntil(p, 0), now - 3 * DAY + NEXT_DAY, "the latest answer to ANOTHER card (its own answer is not a hold)");
  assert.equal(S.heldUntil(p, 1), now + 15 * HOUR); assert.equal(S.heldUntil(p, 2), now + 15 * HOUR);
  assert.deepEqual([S.isReady(p, 0, now), S.isReady(p, 1, now), S.isReady(p, 2, now)], [false, false, false], "0 is not due; 1 and 2 are due but held");
  assert.deepEqual([S.isDue(p.cards[1], now), S.isDue(p.cards[2], now)], [true, true]);
  assert.deepEqual([S.isReady(p, 1, now + 15 * HOUR - 1), S.isReady(p, 1, now + 15 * HOUR), S.isReady(p, 2, now + 15 * HOUR)], [false, true, true]);
  assert.equal(S.readyTime(p, 0), now + 5 * DAY - LOOKAHEAD, "its own due time less the lookahead: a session can ask it from then");
  assert.equal(S.readyTime(p, 1), now + 15 * HOUR, "never asked: from the end of the hold, not from the time it was made");
  assert.equal(S.readyTime(p, 2), now + 15 * HOUR, "overdue: from the end of the hold");
  // a card's own answer: never before 16 hours after it (a card stored by the old rule after a wrong answer)
  const q = { id: "q", kind: "qa", cards: [asked(now - HOUR, now - 50 * MIN)] };
  assert.deepEqual([S.heldUntil(q, 0), S.readyTime(q, 0), S.isReady(q, 0, now), S.isReady(q, 0, now + 15 * HOUR)], [0, now + 15 * HOUR, false, true]);
  // one card, never asked: ready from the time it was made
  const n = { id: "n", kind: "qa", cards: [never(now - DAY)] };
  assert.deepEqual([S.heldUntil(n, 0), S.readyTime(n, 0), S.isReady(n, 0, now)], [0, now - DAY, true]);
  // readyTime is the time from which isReady holds, to the millisecond, for any card and any time
  const rand = rng(31);
  for (let run = 0; run < 3000; run++) {
    const n = 1 + Math.floor(rand() * 4), cards = [];
    for (let j = 0; j < n; j++) {
      const made = now - Math.floor(rand() * 20 * DAY) + (rand() < 0.1 ? 25 * DAY : 0);          // some made "in the future" (a clock set back)
      if (rand() < 0.35) { cards.push(never(made)); continue; }
      const last = now - Math.floor(rand() * 3 * DAY) + (rand() < 0.05 ? 4 * DAY : 0);
      cards.push(asked(last, last + [10 * MIN, DAY, FIRST, 12 * DAY][Math.floor(rand() * 4)] + Math.floor(rand() * 600000)));
    }
    const pr = { id: "r", kind: "cloze", cards };
    for (let j = 0; j < n; j++) {
      for (const at of [now, now + Math.floor(rand() * 3 * DAY), S.readyTime(pr, j, now), S.readyTime(pr, j, now) - 1]) {
        assert.equal(S.isReady(pr, j, at), S.readyTime(pr, j, at) <= at, "run " + run + " card " + j + " at " + (at - now));
      }
      if (S.isReady(pr, j, now)) assert.ok(S.readyTime(pr, j, now) <= now);
    }
  }
  // a card never asked whose createdAt lies ahead (a clock set back) is due now: with `now` its time is never later
  const ahead = { id: "a", kind: "qa", cards: [never(now + 3 * DAY)] };
  assert.deepEqual([S.isReady(ahead, 0, now), S.readyTime(ahead, 0, now), S.readyTime(ahead, 0)], [true, now, now + 3 * DAY]);
  const aheadHeld = { id: "a", kind: "cloze", cards: [never(now + 3 * DAY), asked(now - HOUR, now + 5 * DAY)] };
  assert.deepEqual([S.isReady(aheadHeld, 0, now), S.readyTime(aheadHeld, 0, now)], [false, now + 15 * HOUR], "another card's answer still holds it back");
  // odd input: no prompt, no cards, a missing card, a card without its numbers
  assert.equal(S.heldUntil(null, 0), 0); assert.equal(S.heldUntil({}, 0), 0); assert.equal(S.heldUntil({ cards: [null, { lastReviewedAt: "x" }] }, 0), 0);
  assert.equal(S.readyTime(null, 0), null); assert.equal(S.readyTime({ cards: [] }, 0), null); assert.equal(S.readyTime({ cards: [{ lastReviewedAt: 5 }] }, 0), null);
  assert.equal(S.isReady(null, 0, now), false); assert.equal(S.isReady({ cards: [null] }, 0, now), false); assert.equal(S.isReady(p, 7, now), false);
});

test("the queue: of a prompt's cards that can be asked, the one most overdue for its wait; then the shorter wait, the one due longest, the first", () => {
  const now = T0;
  const asked = (last, dueAt, intervalMs, log) => ({ createdAt: now - 30 * DAY, lastReviewedAt: last, intervalMs: intervalMs === undefined ? FIRST : intervalMs, dueAt, log: log || [] });
  const never = (createdAt) => ({ createdAt, lastReviewedAt: null, intervalMs: FIRST, dueAt: createdAt, log: [] });
  const one = (cards, scope, t) => S.buildQueue({ prompts: [{ id: "p", collectionId: "b", kind: "cloze", cards, createdAt: now - HOUR, deletedAt: null }], scope: scope || "all", collectionId: scope === "today" ? "b" : null, now: t || now, seed: 1 }).map((it) => it.cardIndex);
  // a sentence written yesterday: blank 1 was answered wrong yesterday (a day of its 1-day wait has passed), blanks 0
  // and 2 were never asked (a day of their 5 days): the forgotten blank comes first
  assert.deepEqual(one([never(now - DAY), asked(now - DAY, now, LAPSE), never(now - DAY)]), [1]);
  // a card passed over rises: a blank never asked for 6 days (1.2 of its wait) goes before a forgotten blank that
  // is just due (1.0 of its wait), so no blank is left out however often another one is forgotten
  assert.deepEqual(one([asked(now - DAY, now, LAPSE), never(now - 6 * DAY)]), [1]);
  assert.deepEqual(one([asked(now - DAY, now, LAPSE), never(now - 4 * DAY)]), [0]);
  assert.deepEqual(one([asked(now - 7 * DAY, now - 2 * DAY, FIRST), asked(now - DAY, now, LAPSE)]), [0], "two days late on a 5-day wait (1.4) before one just due (1.0)");
  // equally overdue: the shorter wait first (the card whose memory is weaker)
  assert.deepEqual(one([asked(now - 5 * DAY, now, FIRST), asked(now - DAY, now, LAPSE)]), [1]);
  // equally overdue with equal waits: the earliest due time, then the lower index
  const old = now - 5 * DAY;
  assert.deepEqual(one([asked(old, now - 1), asked(old, now - 9), asked(old, now - 9)]), [1]);
  assert.deepEqual(one([never(now - DAY), never(now - DAY), never(now - DAY)]), [0]);
  // the wait is the one the next answer is graded from: a wait that is no number counts as 5 days, and a card that
  // the rule before D28 stored after a wrong answer (5 days in its record) counts with 1 day
  assert.deepEqual(one([asked(now - 2 * DAY, now - 1, "x"), asked(now - 3 * DAY, now - 9, 6 * DAY)]), [1], "0.5 of 6 days before 0.4 of 5 days");
  const oldLapse = asked(now - DAY, now - DAY + 10 * MIN, FIRST, [{ at: now - DAY, outcome: "forgot" }]);
  assert.equal(S.waitOf(oldLapse), LAPSE);
  assert.deepEqual(one([never(now - 4 * DAY), oldLapse]), [1], "1.0 of its real wait of 1 day before 0.8 of 5 days");
  assert.deepEqual([S.waitOf(asked(now, now, 9 * DAY)), S.waitOf({}), S.waitOf(null), S.waitOf(asked(now, now, 3600000, [{ at: now, outcome: "forgot" }]))], [9 * DAY, FIRST, FIRST, 3600000]);
  // a card that is not due is no candidate, however overdue it would be
  assert.deepEqual(one([asked(now - DAY, now + 9 * DAY, LAPSE), never(now - HOUR)]), [1]);
  // an answer in the last 16 hours: nothing of the sentence for a normal session; "today" may ask the answered card again
  const cards = [asked(now - HOUR, now + 5 * DAY), never(now - DAY), never(now - DAY)];
  assert.deepEqual(one(cards), []);
  assert.deepEqual(one(cards, "book"), []); assert.deepEqual(one(cards, "deck"), []);
  assert.deepEqual(one(cards, "today"), [0], "due or not, but never another blank on the day of an answer");
  assert.deepEqual(one(cards, "all", now + 15 * HOUR), [1]);
  // two cards answered in the last 16 hours hold each other: "today" has no candidate at all
  assert.deepEqual(one([asked(now - HOUR, now + DAY), asked(now - 2 * HOUR, now + DAY)], "today"), []);
});

test("no blank of a sentence is left out, however often another blank is forgotten (one session a day for 60 days)", () => {
  // forget(blank, n) → is the n-th ask of that blank answered wrong (the retry a minute later is right)?
  function run(blanks, forget) {
    const p = { id: "p", collectionId: "b", kind: "cloze", createdAt: T0, deletedAt: null, cards: [] };
    for (let i = 0; i < blanks; i++) p.cards.push(Object.assign({ i }, S.newSchedule(T0)));
    const asks = new Array(blanks).fill(0), first = new Array(blanks).fill(null);
    let worstLate = 0;
    for (let day = 0; day < 60; day++) {
      const t = T0 + MIN + day * DAY;
      const q = S.buildQueue({ prompts: [p], scope: "book", collectionId: "b", now: t, seed: 1 });
      assert.ok(q.length <= 1, "one card of a sentence per session");
      if (!q.length) continue;
      const i = q[0].cardIndex, c = p.cards[i];
      if (c.lastReviewedAt !== null) worstLate = Math.max(worstLate, (t - c.dueAt) / DAY);
      asks[i]++; if (first[i] === null) first[i] = day;
      p.cards[i] = forget(i, asks[i]) ? S.grade(S.grade(c, t, "forgot"), t + MIN, "remembered") : S.grade(c, t, "remembered");
    }
    const end = T0 + 60 * DAY;
    const overdue = p.cards.map((c) => (c.lastReviewedAt === null ? Infinity : Math.max(0, (end - c.dueAt) / DAY)));
    return { asks, first, worstLate, overdue };
  }
  // never wrong: the blanks come on days 0, 1, 2, 3 and then each on its own schedule
  let r = run(4, () => false);
  assert.deepEqual([r.first, r.asks], [[0, 1, 2, 3], [4, 4, 4, 3]]);
  // blank 0 wrong on its first ask only: it comes back on day 1 and day 3, before the blanks never asked
  r = run(4, (i, n) => i === 0 && n === 1);
  assert.deepEqual(r.first, [0, 2, 4, 5]);
  // blank 0 wrong on every third ask, and on every ask: the other blanks still get their turns, at most a day and a half late
  for (const forget of [(i, n) => i === 0 && n % 3 === 0, (i) => i === 0]) {
    r = run(4, forget);
    assert.ok(r.asks.every((n) => n >= 2), "every blank is asked: " + r.asks.join("/"));
    assert.ok(r.first.every((d) => d !== null && d <= 9), "first asks on days " + r.first.join("/"));
    assert.ok(r.worstLate <= 1.5, "the latest answer came " + r.worstLate.toFixed(1) + " days after its due time");
    assert.ok(r.overdue.every((d) => d < 1), "nothing is left overdue at the end: " + r.overdue.join("/"));
  }
});

test("growthOf: the stored factor, else the one the answer log gives; replay carries it", () => {
  assert.equal(S.growthOf(S.newSchedule(T0)), GROWTH_FULL);
  assert.equal(S.growthOf({ growth: 1725, log: [] }), 1725);
  assert.equal(S.growthOf({ growth: 1000 }), 1000); assert.equal(S.growthOf({ growth: 2300 }), 2300);
  // no usable stored value: from the log (none → the full factor)
  const log = [{ at: T0, outcome: "forgot" }, { at: T0 + 3 * MIN, outcome: "remembered" }, { at: T0 + DAY, outcome: "remembered" }];
  for (const bad of [undefined, null, 999, 2301, 1725.5, "1725", NaN, Infinity, -1, {}]) {
    assert.equal(S.growthOf({ createdAt: T0 - DAY, growth: bad, log }), 1840, "growth " + String(bad) + ": one lapse (1725), the retry wins nothing, the next day a fifth comes back");
    assert.equal(S.growthOf({ createdAt: T0 - DAY, growth: bad, log: [] }), GROWTH_FULL);
  }
  assert.equal(S.growthOf({ createdAt: T0, growth: 1500, log }), 1500, "a stored factor wins over the log");
  assert.equal(S.growthOf(null), GROWTH_FULL); assert.equal(S.growthOf("x"), GROWTH_FULL); assert.equal(S.growthOf({}), GROWTH_FULL);
  assert.equal(S.growthOf({ createdAt: T0, log: [{ at: T0 + 1, outcome: "easy" }] }), GROWTH_FULL, "a log without an answer");
  // entries that are no answers (hand-made data) are left out: the real wrong answers still count
  const dirty = [{ at: T0, outcome: "forgot" }, { at: T0 + MIN, outcome: "skip" }, null, { outcome: "forgot" }, { at: "soon", outcome: "forgot" }, { at: T0 + DAY, outcome: "forgot" }];
  assert.equal(S.growthOf({ createdAt: T0 - DAY, log: dirty }), 1294, "two real lapses a day apart");
  assert.equal(S.growthOf({ log: [{ at: T0, outcome: "forgot" }] }), 1725, "no createdAt: the log still counts");
  // replay gives the factor, and equals step-by-step grading
  const r = S.replay(T0 - DAY, log);
  assert.deepEqual([r.growth, r.log.length, r.lastReviewedAt], [1840, 3, T0 + DAY]);
  assert.equal(S.replay(T0, []).growth, GROWTH_FULL);
});

test("replay equals step-by-step grading for any history, in any log order (growth included)", () => {
  const rand = rng(99);
  for (let run = 0; run < 400; run++) {
    const t0 = T0 + Math.floor(rand() * 1e9);
    let s = S.newSchedule(t0), t = t0;
    const n = Math.floor(rand() * 14);
    for (let i = 0; i < n; i++) {
      const kind = rand();
      t += 1 + (kind < 0.35 ? Math.floor(rand() * 20 * MIN) : kind < 0.7 ? Math.floor(rand() * 2 * DAY) : Math.floor(rand() * 60 * DAY));
      s = S.grade(s, t, rand() < 0.35 ? "forgot" : "remembered");
      assert.ok(Number.isInteger(s.growth) && s.growth >= GROWTH_LEAST && s.growth <= GROWTH_FULL, String(s.growth));
      assert.ok(Number.isInteger(s.intervalMs) && s.intervalMs >= LAPSE, String(s.intervalMs));
      assert.ok(s.dueAt >= t + s.intervalMs && s.dueAt <= t + s.intervalMs + 599400);
    }
    const shuffled = s.log.map((e) => ({ at: e.at, outcome: e.outcome })).sort(() => rand() - 0.5);
    assert.deepEqual(S.replay(t0, shuffled), s, "run " + run);
    // the stored factor and the one from the log agree for a card that lived under D28 only
    assert.equal(S.growthOf(Object.assign({}, s, { growth: undefined })), s.growth);
  }
});

test("cards stored before D28 keep their numbers; their next answer follows the new rule, and their old wrong answers count", () => {
  // as 1.2.0 stored it: wrong on day 0 (5 days kept, due 10 minutes later), no right retry, no `growth`
  const t = T0;
  const stored = { i: 0, createdAt: t - 9 * DAY, lastReviewedAt: t, intervalMs: FIRST, dueAt: t + 10 * MIN,
    log: [{ at: t - 8 * DAY, outcome: "remembered", intervalMs: FIRST, dueAt: t - 3 * DAY }, { at: t, outcome: "forgot", intervalMs: FIRST, dueAt: t + 10 * MIN }] };
  assert.equal(S.isDue(stored, t + HOUR), false, "D29: not again today");
  assert.equal(S.growthOf(stored), 1725, "the wrong answer from before D28 counts");
  const nextDay = S.grade(stored, t + DAY, "remembered");
  assert.deepEqual([nextDay.intervalMs, nextDay.growth, nextDay.i], [Math.floor(DAY * 1725 / 1000), 1840, 0], "1 day times 1.725, not the stored 5 days times 2.3");
  const retry = S.grade(stored, t + 5 * MIN, "remembered");
  assert.deepEqual([retry.intervalMs, retry.growth], [LAPSE, 1725], "a retry: 1 day, not the stored 5");
  assert.deepEqual([S.grade(stored, t + 5 * MIN, "forgot").growth, S.grade(stored, t + DAY, "forgot").growth], [1725, 1294]);
  // as 1.2.0 stored it after a wrong answer and a right retry: 5 days, due in 5 days. The wait and the due time stay
  // as they are; only the growth of the next right answer is lower
  const kept = { createdAt: t - 9 * DAY, lastReviewedAt: t + MIN, intervalMs: FIRST, dueAt: t + MIN + FIRST,
    log: [{ at: t, outcome: "forgot" }, { at: t + MIN, outcome: "remembered" }] };
  assert.equal(S.isDue(kept, t + DAY), false); assert.equal(S.isDue(kept, t + MIN + FIRST), true);
  assert.equal(S.growthOf(kept), 1725, "the retry won nothing back");
  const later = S.grade(kept, t + MIN + FIRST, "remembered");
  assert.deepEqual([later.intervalMs, later.growth], [Math.floor(FIRST * 1725 / 1000), 1840], "5 days times 1.725 = 8.6 days (before D28: 11.5)");
  // nothing is written until an answer: reading a card never changes it
  const copy = JSON.parse(JSON.stringify(kept));
  S.growthOf(kept); S.isDue(kept, t); S.preview(kept, t + DAY, "forgot");
  assert.deepEqual(kept, copy);
});
