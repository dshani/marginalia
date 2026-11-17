"use strict";
// test/stats.test.js — js/stats.js (DECISIONS D27, BUILD-NOTES "Scheduling and statistics"): the statistics page.
//  - the pure figures: rows, totals, forecast, sortRows, and the words (dayLabel, fullTime, the cell texts, the
//    totals line, the chart's summary and its labelled columns), on the REAL util, scheduler, prompts and similar;
//  - the page on a small fake DOM: what it draws, sorting, the book filter and the "Show" filter (flagged prompts of
//    every book), the chart's hover line and list, opening a prompt, the redraw on bus events, focus kept over a
//    redraw, close(), and that prompt text reaches the page escaped (M.markup.render) or as text.
// Run: node --test test/stats.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const M = (globalThis.Marginalia = globalThis.Marginalia || {});
const js = (name) => path.join(__dirname, "..", "js", name + ".js");
["util", "bus", "scheduler", "prompts", "similar", "markup"].forEach((n) => require(js(n)));
const X = require(js("stats"));
const S = M.scheduler;

const DAY = 86400000, HOUR = 3600000, MIN = 60000;
const NOW = new Date(2026, 10, 14, 12, 0, 0).getTime();   // Sat 14 Nov 2026, local noon
const at = (d, h, m) => new Date(2026, 10, d, h || 0, m || 0, 0).getTime();   // a local time in November 2026

// ---- fixtures ------------------------------------------------------------------------------------------------
const asked = (lastReviewedAt, dueAt, intervalDays, log) => ({ createdAt: at(1), lastReviewedAt, dueAt, intervalMs: intervalDays * DAY, log: log || [{ at: lastReviewedAt, outcome: "remembered" }] });
const never = (createdAt, old) => ({ createdAt, lastReviewedAt: null, dueAt: old ? createdAt + 5 * DAY : createdAt, intervalMs: 5 * DAY, log: [] });
function prompt(id, collectionId, text, cards, extra) {
  const kind = /\{/.test(text) && !/^Q\./.test(text) ? "cloze" : "qa";
  return Object.assign({ id, collectionId, kind, text, cards, flagged: false, createdAt: at(1), deletedAt: null }, extra || {});
}
const COLS = [
  { id: "b1", kind: "book", name: "Griffiths", deletedAt: null },
  { id: "b2", kind: "book", name: "arnold", deletedAt: null },
  { id: "d1", kind: "deck", name: "", deletedAt: null },
  { id: "gone", kind: "book", name: "Deleted book", deletedAt: at(2) }
];
// The due times are in the evening: a session can ask a card from 16 hours before its due time (the lookahead),
// which is then the same day (20:00 less 16 hours = 4:00).
function library() {
  return [
    // due now: never asked (new storage), written today
    prompt("p_new", "b1", "Q. What is new?\nA. this", [never(at(14, 9))], { createdAt: at(14, 9) }),
    // asked on 9 Nov, due on 20 Nov, wait 11 days, 2 answers of which 1 wrong
    prompt("p_wait", "b1", "Q. Why does it wait?\nA. it was right", [asked(at(9, 10), at(20, 20), 11, [{ at: at(4, 10), outcome: "forgot" }, { at: at(9, 10), outcome: "remembered" }])], { createdAt: at(4) }),
    // a sentence with three blanks: one answered (due 17 Nov), one never asked (stored before D27), one overdue
    prompt("p_cloze", "b2", "The {wave} is {complex} and {normalised}.", [
      asked(at(12, 8), at(17, 20), 5), never(at(12, 7), true), asked(at(8, 8), at(13, 8), 5)
    ], { createdAt: at(12, 7), flagged: true }),
    // a deck prompt, forgotten on three days: struggling; due tomorrow
    prompt("p_deck", "d1", "Q. Hard one?\nA. yes", [asked(at(13, 9), at(15, 20), 5, [
      { at: at(10, 9), outcome: "forgot" }, { at: at(11, 9), outcome: "forgot" }, { at: at(12, 9), outcome: "forgot" }, { at: at(13, 9), outcome: "remembered" }
    ])], { createdAt: at(10) }),
    // not counted: a note, a highlight, a deleted prompt, a prompt of a deleted book, a prompt of no book, a prompt without cards
    prompt("n1", "b1", "a note", [], { kind: "note" }),
    prompt("h1", "b1", "", undefined, { kind: "highlight" }),
    prompt("p_dead", "b1", "Q. Dead?\nA. yes", [never(at(3))], { deletedAt: at(5) }),
    prompt("p_gone", "gone", "Q. Gone?\nA. yes", [never(at(3))]),
    prompt("p_lost", "nowhere", "Q. Lost?\nA. yes", [never(at(3))]),
    prompt("p_empty", "b1", "Q. Empty?\nA. yes", [])
  ];
}
const byId = (rows) => Object.fromEntries(rows.map((r) => [r.id, r]));

// ---- pure ------------------------------------------------------------------------------------------------------
test("rows: one row per live Q./A. or cloze prompt of a live collection, with its figures", () => {
  const rows = X.rows(library(), COLS, NOW), r = byId(rows);
  assert.deepEqual(rows.map((x) => x.id), ["p_new", "p_wait", "p_cloze", "p_deck"], "notes, highlights, deleted, book-less and card-less prompts are left out");
  assert.deepEqual(r.p_new, { id: "p_new", collectionId: "b1", book: "Griffiths", kind: "qa", text: "What is new?", source: "What is new?", flagged: false, createdAt: at(14, 9),
    cards: 1, neverAsked: 1, due: 1, lastAskedAt: null, nextDueAt: at(14, 9), intervalMs: null, growth: null, answers: 0, wrong: 0, missDays: 0, struggling: false });
  assert.deepEqual([r.p_wait.cards, r.p_wait.neverAsked, r.p_wait.due, r.p_wait.lastAskedAt, r.p_wait.nextDueAt, r.p_wait.intervalMs, r.p_wait.answers, r.p_wait.wrong],
    [1, 0, 0, at(9, 10), at(20, 4), 11 * DAY, 2, 1]);   // next due: from when a session can ask it, 16 hours before its due time of 20:00
  // D28: the growth factor of the card that comes next, in thousandths. These cards were stored before D28, so their
  // answer logs give it: one wrong answer and a right one → 2300 · 3/4 = 1725, then a fifth back = 1840; wrong on
  // three days and a right answer → 1725, 1294, 1000 (never below), then 1260; never asked → none
  assert.deepEqual([r.p_wait.growth, r.p_deck.growth, r.p_cloze.growth, r.p_new.growth], [1840, 1260, null, null]);
  // the sentence: 3 cards; 1 never asked; 2 due now (the one never asked, although it is stored as due on 17 Nov, and
  // the overdue one); last asked = the latest answer of any card; next due = the earliest time one of its cards could
  // be asked from: the card never asked, 16 hours after the answer of 12 Nov 8:00 to another blank (D29)
  assert.deepEqual([r.p_cloze.kind, r.p_cloze.cards, r.p_cloze.neverAsked, r.p_cloze.due, r.p_cloze.lastAskedAt, r.p_cloze.nextDueAt, r.p_cloze.flagged],
    ["cloze", 3, 1, 2, at(12, 8), at(13, 0), true]);
  assert.equal(r.p_cloze.intervalMs, null, "the card that comes next was never asked: no wait yet");
  assert.equal(r.p_cloze.text, "The wave is complex and normalised.", "the sentence in one line");
  assert.equal(r.p_cloze.source, "The {wave} is {complex} and {normalised}.", "the asking side as typed, for M.markup to draw");
  assert.equal(r.p_cloze.book, "arnold");
  assert.deepEqual([r.p_deck.book, r.p_deck.answers, r.p_deck.wrong, r.p_deck.missDays, r.p_deck.struggling, r.p_deck.due], ["Untitled deck", 4, 3, 3, true, 0]);
  // a card due within the 16-hour lookahead counts as due now, as in the library's count
  const soon = X.rows([prompt("p", "b1", "Q. Soon?\nA. yes", [asked(at(9), NOW + 15 * HOUR, 5)])], COLS, NOW)[0];
  assert.equal(soon.due, 1);
  assert.equal(soon.growth, 2300, "a card never answered wrong grows 2.3 times");
  // D29: an answer to one blank holds the sentence's other blanks back for 16 hours: they are not due now, the row's
  // next due time is the end of the hold, and the forecast puts them on the day the hold ends
  const heldRow = (answeredAt) => prompt("p_held", "b1", "A {b} and a {c}.", [asked(answeredAt, answeredAt + 5 * DAY, 5), never(at(10))]);
  const h1 = X.rows([heldRow(NOW - HOUR)], COLS, NOW)[0];
  assert.deepEqual([h1.cards, h1.neverAsked, h1.due, h1.nextDueAt, h1.intervalMs, h1.growth], [2, 1, 0, NOW + 15 * HOUR, null, null]);
  assert.equal(X.nextDueText(h1, NOW), "tomorrow");
  assert.deepEqual(X.forecast([heldRow(NOW - HOUR)], COLS, NOW).days.slice(0, 2).map((d) => d.count), [0, 1], "the held blank comes tomorrow");
  const h2 = X.rows([heldRow(NOW - 16 * HOUR)], COLS, NOW)[0];
  assert.deepEqual([h2.due, h2.nextDueAt], [1, NOW], "16 hours after the answer the other blank is due");
  assert.deepEqual(X.forecast([heldRow(NOW - 16 * HOUR)], COLS, NOW).days.slice(0, 2).map((d) => d.count), [1, 0]);
  // D28: a card answered wrong an hour ago is due tomorrow, not now
  const lapsed = S.grade(S.grade(S.newSchedule(at(10)), at(10, 9), "remembered"), NOW - HOUR, "forgot");
  const l1 = X.rows([prompt("p_lapsed", "b1", "Q. Forgotten?\nA. yes", [lapsed])], COLS, NOW)[0];
  assert.deepEqual([l1.due, l1.intervalMs, l1.growth, X.nextDueText(l1, NOW), X.waitText(l1)], [0, DAY, 1725, "tomorrow", "1 d · ×1.7"]);
  assert.equal(X.rows([prompt("p_lapsed", "b1", "Q. Forgotten?\nA. yes", [lapsed])], COLS, NOW + 15 * HOUR)[0].due, 1, "16 hours after the wrong answer");
  // a card that 1.2.0 stored after a wrong answer keeps 5 days in its record; the row shows the wait its next answer is graded from
  const stored = asked(NOW - 2 * DAY, NOW - 2 * DAY + 10 * MIN, 5, [{ at: NOW - 2 * DAY, outcome: "forgot" }]);
  const o1 = X.rows([prompt("p_old", "b1", "Q. Stored by the old rule?\nA. yes", [stored])], COLS, NOW)[0];
  assert.deepEqual([o1.due, o1.intervalMs, o1.growth, X.waitText(o1)], [1, DAY, 1725, "1 d · ×1.7"]);
  // a card never asked whose createdAt lies ahead (a clock set back) is due now: its time is never later than now
  const f1 = X.rows([prompt("p_future", "b1", "Q. From the future?\nA. yes", [never(NOW + 3 * DAY)])], COLS, NOW)[0];
  assert.deepEqual([f1.due, f1.nextDueAt, X.nextDueText(f1, NOW)], [1, NOW, "now"]);
  assert.equal(X.forecast([prompt("p_future", "b1", "Q. From the future?\nA. yes", [never(NOW + 3 * DAY)])], COLS, NOW).days[0].count, 1);
  assert.equal(X.rows([prompt("p", "b1", "Q. Later?\nA. yes", [asked(at(9), NOW + 17 * HOUR, 5)])], COLS, NOW)[0].due, 0);
  // odd input
  assert.deepEqual(X.rows(null, COLS, NOW), []);
  assert.deepEqual(X.rows(library(), null, NOW), []);
  const long = X.rows([prompt("p", "b1", "Q. " + "word ".repeat(60) + "?\nA. x", [never(NOW)])], COLS, NOW)[0].text;
  assert.ok(Array.from(long).length <= 110 && long.endsWith("…"), long);
});

test("totals: the sums of the rows", () => {
  const rows = X.rows(library(), COLS, NOW);
  assert.deepEqual(X.totals(rows), { prompts: 4, cards: 6, due: 3, neverAsked: 2, answers: 8, wrong: 4 });
  assert.deepEqual(X.totals([]), { prompts: 0, cards: 0, due: 0, neverAsked: 0, answers: 0, wrong: 0 });
  assert.equal(X.totalsText(X.totals(rows)), "4 prompts · 6 cards · 3 due now · 2 never asked · 8 answers · 4 wrong (50%)");
  assert.equal(X.totalsText({ prompts: 1, cards: 1, due: 0, neverAsked: 1, answers: 0, wrong: 0 }), "1 prompt · 1 card · 0 due now · 1 never asked · 0 answers · 0 wrong");
  assert.equal(X.totalsText({ prompts: 2, cards: 2, due: 0, neverAsked: 0, answers: 1, wrong: 0 }), "2 prompts · 2 cards · 0 due now · 0 never asked · 1 answer · 0 wrong (0%)");
});

test("forecast: the cards per local day for 30 days; today holds everything that is due now; the rest is 'later'", () => {
  const fc = X.forecast(library(), COLS, NOW);
  assert.equal(fc.days.length, 30);
  assert.equal(X.FORECAST_DAYS, 30);
  assert.deepEqual([fc.days[0].at, fc.days[0].dayKey, fc.days[1].dayKey, fc.days[29].dayKey], [at(14), "2026-11-14", "2026-11-15", "2026-12-13"]);
  const counts = Object.fromEntries(fc.days.filter((d) => d.count).map((d) => [d.dayKey, d.count]));
  // today: p_new, the two due cards of the sentence; 15 Nov: the deck prompt; 17 Nov: the sentence's answered blank; 20 Nov: p_wait
  assert.deepEqual(counts, { "2026-11-14": 3, "2026-11-15": 1, "2026-11-17": 1, "2026-11-20": 1 });
  assert.deepEqual([fc.max, fc.total, fc.later], [3, 6, 0]);
  // the edges. A card is in the column of the day from which a session can ask it: 16 hours before its due time
  // (the lookahead), so the columns agree with the "due now" counts of each day
  const one = (dueAt) => X.forecast([prompt("p", "b1", "Q. x?\nA. y", [asked(at(9), dueAt, 5)])], COLS, NOW);
  assert.equal(one(at(14, 23, 59)).days[0].count, 1);
  assert.equal(one(NOW + 15 * HOUR).days[0].count, 1, "due tomorrow at 03:00, inside the lookahead: it is due now");
  assert.equal(one(at(15, 6)).days[0].count, 1, "due tomorrow at 06:00: not due now, but a session can ask it from 14:00 today");
  assert.equal(one(at(15, 15, 59)).days[0].count, 1, "due tomorrow at 15:59: from 23:59 today");
  assert.equal(one(at(15, 16, 1)).days[1].count, 1, "due tomorrow at 16:01: from 00:01 tomorrow");
  assert.equal(one(at(2)).days[0].count, 1, "overdue");
  assert.equal(one(new Date(2026, 11, 14, 15, 0).getTime()).days[29].count, 1, "the 30th day (13 Dec) → the last column");
  const far = one(new Date(2026, 11, 14, 16, 30).getTime());
  assert.deepEqual([far.later, far.total, far.max], [1, 1, 0], "the 31st → later");
  // fewer days on request; nothing to count
  assert.equal(X.forecast(library(), COLS, NOW, 7).days.length, 7);
  assert.equal(X.forecast(library(), COLS, NOW, 7).later, 0);
  assert.equal(X.forecast(library(), COLS, NOW, 3).later, 2, "17 and 20 Nov are after three days");
  assert.deepEqual([X.forecast([], COLS, NOW).total, X.forecast([], COLS, NOW).max], [0, 0]);
  // a day is a calendar day: every column starts at a local midnight
  for (const d of fc.days) assert.equal(new Date(d.at).getHours(), 0);
});

test("sortRows: every column both ways; a missing value first ascending and last descending; ties by next due, then written", () => {
  const rows = X.rows(library(), COLS, NOW);
  const ids = (key, dir) => X.sortRows(rows, key, dir).map((r) => r.id);
  assert.deepEqual(ids("nextDueAt", "asc"), ["p_cloze", "p_new", "p_deck", "p_wait"], "the one that waits longest first");
  assert.deepEqual(ids("nextDueAt", "desc"), ["p_wait", "p_deck", "p_new", "p_cloze"]);
  assert.deepEqual(ids("lastAskedAt", "asc"), ["p_new", "p_wait", "p_cloze", "p_deck"], "never asked first, then the oldest answer");
  assert.deepEqual(ids("lastAskedAt", "desc"), ["p_deck", "p_cloze", "p_wait", "p_new"]);
  assert.deepEqual(ids("intervalMs", "asc"), ["p_cloze", "p_new", "p_deck", "p_wait"], "no wait yet (twice, by next due), then 5 d, then 11 d");
  assert.deepEqual(ids("intervalMs", "desc"), ["p_wait", "p_deck", "p_cloze", "p_new"]);
  assert.deepEqual(ids("text", "asc"), ["p_deck", "p_cloze", "p_new", "p_wait"], "Hard…, The wave…, What…, Why…");
  assert.deepEqual(ids("book", "asc"), ["p_cloze", "p_new", "p_wait", "p_deck"], "arnold, Griffiths (twice, by next due), Untitled deck: letter case does not matter");
  assert.deepEqual(ids("cards", "desc"), ["p_cloze", "p_new", "p_deck", "p_wait"]);
  assert.deepEqual(ids("answers", "desc"), ["p_deck", "p_cloze", "p_wait", "p_new"], "4, then 2 and 2 (the one that is due first), then 0");
  assert.deepEqual(ids("wrong", "desc"), ["p_deck", "p_wait", "p_cloze", "p_new"]);
  assert.deepEqual(ids("wrong", "asc"), ["p_cloze", "p_new", "p_wait", "p_deck"]);
  assert.deepEqual(ids("nonsense", "asc"), ids("nextDueAt", "asc"), "an unknown column sorts by next due");
  assert.deepEqual(rows.map((r) => r.id), ["p_new", "p_wait", "p_cloze", "p_deck"], "the given list is not changed");
  assert.deepEqual(X.sortRows(null, "text", "asc"), []);
  // the "Show" choices
  const kept = (show) => X.filterRows(rows, show).map((r) => r.id);
  assert.deepEqual(X.SHOWS, [{ id: "", label: "All prompts" }, { id: "due", label: "Due now" }, { id: "never", label: "Never asked" }, { id: "flagged", label: "Flagged" }, { id: "struggling", label: "Struggling" }]);
  assert.deepEqual(kept(""), ["p_new", "p_wait", "p_cloze", "p_deck"]);
  assert.deepEqual(kept("due"), ["p_new", "p_cloze"]);
  assert.deepEqual(kept("never"), ["p_new", "p_cloze"], "a sentence with one blank never asked counts");
  assert.deepEqual(kept("flagged"), ["p_cloze"]);
  assert.deepEqual(kept("struggling"), ["p_deck"]);
  assert.deepEqual(kept("nonsense"), kept(""), "an unknown choice keeps all");
  assert.deepEqual(X.filterRows(null, "due"), []);
  assert.deepEqual(X.COLUMNS.map((c) => c.key), ["text", "book", "cards", "lastAskedAt", "nextDueAt", "intervalMs", "answers", "wrong"]);
});

test("the words: day labels, the cell texts, a column's day, the chart's summary and its labelled columns", () => {
  assert.equal(X.dayLabel(at(14, 1), NOW), "today");
  assert.equal(X.dayLabel(at(14, 23, 59), NOW), "today");
  assert.equal(X.dayLabel(at(13, 23, 59), NOW), "yesterday");
  assert.equal(X.dayLabel(at(15, 0, 1), NOW), "tomorrow");
  assert.equal(X.dayLabel(at(9, 10), NOW), "9 Nov");
  assert.equal(X.dayLabel(at(20, 10), NOW), "20 Nov");
  assert.equal(X.dayLabel(new Date(2025, 11, 31, 12).getTime(), NOW), "31 Dec 2025");
  assert.equal(X.dayLabel(new Date(2027, 0, 2, 12).getTime(), NOW), "2 Jan 2027");
  assert.equal(X.dayLabel(null, NOW), "");
  assert.equal(X.fullTime(at(14, 10, 6)), "Sat 14 Nov 2026, 10:06");
  assert.equal(X.fullTime(at(9, 9, 30)), "Mon 9 Nov 2026, 9:30");
  assert.equal(X.fullTime(null), "");
  const r = byId(X.rows(library(), COLS, NOW));
  assert.deepEqual([X.lastAskedText(r.p_new, NOW), X.nextDueText(r.p_new, NOW), X.waitText(r.p_new)], ["never", "now", "—"]);
  assert.deepEqual([X.lastAskedText(r.p_wait, NOW), X.nextDueText(r.p_wait, NOW), X.waitText(r.p_wait)], ["9 Nov", "20 Nov", "11 d · ×1.8"]);
  assert.deepEqual([X.lastAskedText(r.p_deck, NOW), X.nextDueText(r.p_deck, NOW), X.waitText(r.p_deck)], ["yesterday", "tomorrow", "5 d · ×1.3"]);
  // D28: the factor shows only while it reads lower than 2.3; the cell's title says what it means
  assert.deepEqual([X.growthText(r.p_wait), X.growthText(r.p_deck), X.growthText(r.p_new), X.growthText(null)], ["1.8", "1.3", "", ""]);
  assert.deepEqual([X.growthText({ growth: 2300 }), X.growthText({ growth: 2262 }), X.growthText({ growth: 2249 }), X.growthText({ growth: 1000 })], ["", "", "2.2", "1.0"]);
  assert.equal(X.waitText({ intervalMs: 5 * DAY, growth: 2300 }), "5 d");
  assert.equal(X.waitTitle(r.p_wait), "After a right answer this wait grows 1.8 times, not 2.3 times: the prompt was answered wrong");
  assert.equal(X.waitTitle(r.p_new), null);
  assert.deepEqual([X.lastAskedText(r.p_cloze, NOW), X.nextDueText(r.p_cloze, NOW)], ["12 Nov", "now"]);
  const fc = X.forecast(library(), COLS, NOW);
  assert.deepEqual([X.slotLabel(fc.days[0], NOW), X.slotLabel(fc.days[1], NOW), X.slotLabel(fc.days[3], NOW)], ["today", "tomorrow", "Tue 17 Nov"]);
  assert.equal(X.forecastSummary(fc, NOW), "Cards coming due in the next 30 days: today 3, tomorrow 1, Tue 17 Nov 1, Fri 20 Nov 1.");
  assert.equal(X.forecastSummary(X.forecast([], COLS, NOW), NOW), "Cards coming due in the next 30 days: none.");
  const far = X.forecast([prompt("p", "b1", "Q. x?\nA. y", [asked(at(9), new Date(2027, 2, 1).getTime(), 100)])], COLS, NOW);
  assert.equal(X.forecastSummary(far, NOW), "Cards coming due in the next 30 days: none. Later: 1 card.");
  // ten days with cards: the first eight are named
  const many = X.forecast(Array.from({ length: 10 }, (_, i) => prompt("p" + i, "b1", "Q. x?\nA. y", [asked(at(9), at(16 + i, 20), 5)])), COLS, NOW);
  assert.ok(X.forecastSummary(many, NOW).endsWith(", Mon 23 Nov 1, and 2 more days."), X.forecastSummary(many, NOW));
  // labelled columns: today's (when it has cards) and the highest
  assert.deepEqual(X.labelled(fc), { 0: true });
  const peak = X.forecast(library().concat([1, 2, 3, 4].map((i) => prompt("q" + i, "b1", "Q. x?\nA. y", [asked(at(9), at(20, 20), 5)]))), COLS, NOW);
  assert.deepEqual(X.labelled(peak), { 0: true, 6: true }, "today (3) and 20 Nov (5)");
  assert.deepEqual(X.labelled(X.forecast([], COLS, NOW)), {});
  assert.deepEqual(X.labelled(far), {});
});

// ---- the page on a small fake DOM ---------------------------------------------------------------------------------
function makeDoc() {
  const doc = { activeElement: null, created: [], layout: false };
  function el(tag) {
    const node = {
      nodeType: 1, tagName: String(tag).toUpperCase(), parentNode: null, childNodes: [], attributes: {}, style: {}, _text: "", _listeners: {}, _value: "",
      open: false, scrollLeft: 0,
      // a select takes only a value one of its options has (as a browser does); other elements take any
      get value() { return node._value; },
      set value(v) {
        if (node.tagName !== "SELECT") { node._value = String(v); return; }
        const ok = node.childNodes.some((o) => o.tagName === "OPTION" && o.getAttribute("value") === String(v));
        node._value = ok ? String(v) : (node.childNodes[0] ? node.childNodes[0].getAttribute("value") : "");
      },
      // the layout the hover line asks for: a plot 300 px wide, a line 110 px wide (doc.layout turns it on)
      get offsetWidth() { return doc.layout && node.classList.contains("stats__tip") ? 110 : 0; },
      get clientWidth() { return doc.layout && node.classList.contains("stats__plot") ? 300 : 0; },
      get firstChild() { return node.childNodes[0] || null; },
      get className() { return node.attributes.class || ""; },
      set className(v) { node.attributes.class = String(v); },
      get textContent() { return node.childNodes.length ? node.childNodes.map((c) => c.textContent).join("") : node._text; },
      set textContent(v) { node.childNodes.slice().forEach((c) => node.removeChild(c)); node._text = String(v); node._html = null; },
      // innerHTML is kept as written; the text of it is what a browser would show (tags off, entities decoded)
      get innerHTML() { return node._html === null || node._html === undefined ? "" : node._html; },
      set innerHTML(v) {
        node.childNodes.slice().forEach((c) => node.removeChild(c));
        node._html = String(v);
        node._text = node._html.replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&amp;/g, "&");
      },
      classList: {
        contains: (c) => node.className.split(/\s+/).includes(c),
        add: (c) => { if (!node.classList.contains(c)) node.className = (node.className + " " + c).trim(); },
        remove: (c) => { node.className = node.className.split(/\s+/).filter((x) => x && x !== c).join(" "); }
      },
      setAttribute(k, v) { node.attributes[k] = String(v); if (k === "value" && node.tagName !== "SELECT") node._value = String(v); },
      getAttribute(k) { return Object.prototype.hasOwnProperty.call(node.attributes, k) ? node.attributes[k] : null; },
      appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = node; node.childNodes.push(c); return c; },
      removeChild(c) { const i = node.childNodes.indexOf(c); if (i >= 0) node.childNodes.splice(i, 1); c.parentNode = null; if (doc.activeElement === c || (c.contains && c.contains(doc.activeElement))) doc.activeElement = null; return c; },
      contains(n) { for (; n; n = n.parentNode) if (n === node) return true; return false; },
      addEventListener(type, fn) { (node._listeners[type] = node._listeners[type] || []).push(fn); },
      focus() { doc.activeElement = node; },
      matches(sel) {
        if (sel[0] === ".") return node.classList.contains(sel.slice(1));
        if (sel[0] === "[") return node.getAttribute(sel.slice(1, -1)) !== null;
        return node.tagName === sel.toUpperCase();
      },
      closest(sel) { for (let n = node; n; n = n.parentNode) if (n.matches && n.matches(sel)) return n; return null; },
      querySelectorAll(sel) { const out = []; (function walk(n) { n.childNodes.forEach((c) => { if (c.matches(sel)) out.push(c); walk(c); }); })(node); return out; },
      querySelector(sel) { return node.querySelectorAll(sel)[0] || null; }
    };
    doc.created.push(node);
    return node;
  }
  doc.createElement = el;
  const hosts = {};
  doc.getElementById = (id) => hosts[id] || null;
  doc.addHost = (id) => { hosts[id] = el("section"); hosts[id].attributes.id = id; return hosts[id]; };
  return doc;
}
const fire = (node, type, ev) => (node._listeners[type] || []).slice().forEach((fn) => fn(Object.assign({ type, target: node }, ev || {})));
const texts = (nodes) => nodes.map((n) => n.textContent);
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

// One page: a document with #stats, a cache of `prompts`, a recording M.app, the real bus, the clock at NOW.
function page(prompts) {
  const doc = makeDoc(), host = doc.addHost("stats"), routes = [];
  const state = { prompts: prompts.slice() };
  const saved = { document: globalThis.document, now: Date.now, cache: M.cache, app: M.app };
  globalThis.document = doc;
  Date.now = () => NOW;
  M.cache = { prompts: () => state.prompts.slice(), collections: () => COLS.slice() };
  M.app = { route: (screen, params) => { routes.push([screen, params || null]); } };
  X.reset();                                              // all books, all prompts, the first sort order
  return {
    doc, host, routes, state,
    q: (sel) => host.querySelectorAll(sel),
    rowIds: () => host.querySelectorAll(".stats__row").map((r) => r.getAttribute("data-id")),
    done() {
      X.close();
      Date.now = saved.now; M.cache = saved.cache; M.app = saved.app;
      if (saved.document === undefined) delete globalThis.document; else globalThis.document = saved.document;
    }
  };
}

test("open() draws the page: totals, the chart, its list, the table in next-due order; without a host it does nothing", () => {
  assert.equal(X.open(), false, "no document");
  assert.equal(X.isOpen(), false);
  const P = page(library());
  try {
    assert.equal(X.open(), true);
    assert.equal(X.isOpen(), true);
    assert.deepEqual(texts(P.q("h1")), ["Statistics"]);
    assert.equal(P.doc.activeElement, P.q("h1")[0], "the heading takes the focus when the page opens");
    assert.equal(P.q("h1")[0].getAttribute("tabindex"), "-1");
    assert.deepEqual(texts(P.q(".stats__back")), ["‹ Library"]);
    assert.deepEqual(texts(P.q(".stats__totals")), ["4 prompts · 6 cards · 3 due now · 2 never asked · 8 answers · 4 wrong (50%)"]);
    const options = (i) => texts(P.q("select")[i].querySelectorAll("option"));
    assert.deepEqual(options(0), ["All books and decks (4)", "arnold (1)", "Griffiths (2)", "Untitled deck (1)"]);
    assert.deepEqual(options(1), ["All prompts (4)", "Due now (2)", "Never asked (2)", "Flagged (1)", "Struggling (1)"]);
    assert.deepEqual(P.q("select").map((x) => x.getAttribute("aria-label")), ["Book or deck", "Show"]);
    // the chart: 30 slots, a column where cards come due, heights against the highest, numbers on today's and the highest only
    const slots = P.q(".stats__slot");
    assert.equal(slots.length, 30);
    const cols = P.q(".stats__col");
    assert.deepEqual(cols.map((c) => [c.parentNode.getAttribute("data-i"), c.style.height]), [["0", "100%"], ["1", "33.3%"], ["3", "33.3%"], ["6", "33.3%"]]);
    assert.deepEqual(P.q(".stats__val").map((v) => [v.parentNode.getAttribute("data-i"), v.textContent, v.style.bottom]), [["0", "3", "100%"]]);
    assert.deepEqual(texts(P.q(".stats__tick-label")), ["today", "21 Nov", "28 Nov", "5 Dec", "12 Dec"]);
    const chart = P.q(".stats__chart")[0];
    assert.equal(chart.getAttribute("role"), "img");
    assert.equal(chart.getAttribute("aria-label"), "Cards coming due in the next 30 days: today 3, tomorrow 1, Tue 17 Nov 1, Fri 20 Nov 1.");
    assert.deepEqual(P.q(".stats__later"), [], "nothing later than the 30 days");
    assert.deepEqual(P.q("li").map((li) => texts(li.childNodes)), [["today", "3 cards"], ["tomorrow", "1 card"], ["Tue 17 Nov", "1 card"], ["Fri 20 Nov", "1 card"]]);
    assert.deepEqual(texts(P.q("summary")), ["Show as a list"]);
    // the hover line
    const tip = P.q(".stats__tip")[0], plot = P.q(".stats__plot")[0];
    assert.equal(tip.classList.contains("is-hidden"), true);
    fire(plot, "pointerover", { target: cols[2] });           // the column of 17 Nov
    assert.equal(tip.classList.contains("is-hidden"), false);
    assert.deepEqual(texts(tip.childNodes), ["1 card", "Tue 17 Nov"]);
    fire(plot, "pointerover", { target: slots[2] });          // an empty day: the whole slot answers
    assert.deepEqual(texts(tip.childNodes), ["0 cards", "Mon 16 Nov"]);
    fire(plot, "pointerleave");
    assert.equal(tip.classList.contains("is-hidden"), true);
    // the table
    assert.deepEqual(texts(P.q(".stats__sort")).map((t) => t.replace(/[▲▼]/, "").trim()), ["Prompt", "Book", "Cards", "Last asked", "Next due", "Wait", "Answers", "Wrong"]);
    assert.deepEqual(P.q("th").map((th) => th.getAttribute("aria-sort")), ["none", "none", "none", "none", "ascending", "none", "none", "none"]);
    assert.deepEqual(texts(P.q(".stats__arrow")), ["", "", "", "", "▲", "", "", ""]);
    assert.deepEqual(P.rowIds(), ["p_cloze", "p_new", "p_deck", "p_wait"]);
    const cells = (id) => texts(P.q(".stats__row").find((r) => r.getAttribute("data-id") === id).childNodes);
    assert.deepEqual(cells("p_wait"), ["Why does it wait?", "Griffiths", "1", "9 Nov", "20 Nov", "11 d · ×1.8", "2", "1"]);
    assert.deepEqual(cells("p_new"), ["What is new?", "Griffiths", "1", "never", "now", "—", "0", "0"]);
    assert.deepEqual(cells("p_cloze"), ["The wave is complex and normalised.⚑", "arnold", "3", "12 Nov", "now", "—", "2", "0"]);
    assert.deepEqual(cells("p_deck"), ["Hard one?struggling", "Untitled deck", "1", "yesterday", "tomorrow", "5 d · ×1.3", "4", "3"]);
    const row = (id) => P.q(".stats__row").find((r) => r.getAttribute("data-id") === id);
    assert.equal(row("p_new").classList.contains("stats__row--due"), true);
    assert.equal(row("p_wait").classList.contains("stats__row--due"), false);
    assert.equal(row("p_wait").childNodes[3].getAttribute("title"), "Mon 9 Nov 2026, 10:00");
    assert.equal(row("p_cloze").childNodes[4].getAttribute("title"), "2 cards due now");
    assert.equal(row("p_deck").querySelector(".stats__chip").getAttribute("title"), "Forgotten on 3 days");
    // the question is drawn by M.markup.render (the hidden parts of a sentence marked); the button names the prompt
    assert.equal(row("p_cloze").querySelector(".stats__q").innerHTML, 'The <mark class="cloze-mark">wave</mark> is <mark class="cloze-mark">complex</mark> and <mark class="cloze-mark">normalised</mark>.');
    assert.equal(row("p_cloze").querySelector(".stats__open").getAttribute("aria-label"), "The wave is complex and normalised. — open in its book");
  } finally { P.done(); }
});

test("a header sorts (a second click turns it round); a prompt opens in its book; ‹ Library goes back", () => {
  const P = page(library());
  try {
    X.open();
    const sortBtn = (key) => P.q(".stats__sort").find((b) => b.getAttribute("data-sort") === key);
    fire(sortBtn("lastAskedAt"), "click");
    assert.deepEqual(P.rowIds(), ["p_new", "p_wait", "p_cloze", "p_deck"]);
    assert.deepEqual(X.sort(), { key: "lastAskedAt", dir: "asc" });
    assert.equal(P.q("th")[3].getAttribute("aria-sort"), "ascending");
    fire(sortBtn("lastAskedAt"), "click");
    assert.deepEqual(P.rowIds(), ["p_deck", "p_cloze", "p_wait", "p_new"]);
    assert.equal(P.q("th")[3].getAttribute("aria-sort"), "descending");
    assert.deepEqual(texts(P.q(".stats__arrow"))[3], "▼");
    fire(sortBtn("wrong"), "click");                          // a number column starts with the most
    assert.deepEqual(X.sort(), { key: "wrong", dir: "desc" });
    assert.deepEqual(P.rowIds(), ["p_deck", "p_wait", "p_cloze", "p_new"]);
    fire(sortBtn("nextDueAt"), "click");
    assert.deepEqual(P.rowIds(), ["p_cloze", "p_new", "p_deck", "p_wait"]);
    // open a prompt
    fire(P.q(".stats__open").find((b) => b.textContent === "Why does it wait?"), "click");
    assert.deepEqual(P.routes, [["reader", { collectionId: "b1", promptId: "p_wait" }]]);
    fire(P.q(".stats__open").find((b) => b.textContent === "Hard one?"), "click");
    assert.deepEqual(P.routes[1], ["reader", { collectionId: "d1", promptId: "p_deck" }], "M.app.route sends a deck's prompt to its deck page");
    fire(P.q(".stats__back")[0], "click");
    assert.deepEqual(P.routes[2], ["library", null]);
  } finally { P.done(); }
});

test("the book filter narrows the rows, the totals and the chart; a book that goes away resets it", () => {
  const P = page(library());
  try {
    X.open();
    const select = P.q("select")[0];
    select.value = "b1";
    fire(select, "change");
    assert.deepEqual(P.rowIds(), ["p_new", "p_wait"]);
    assert.deepEqual(texts(P.q(".stats__totals")), ["2 prompts · 2 cards · 1 due now · 1 never asked · 2 answers · 1 wrong (50%)"]);
    assert.deepEqual(P.q(".stats__col").map((c) => c.parentNode.getAttribute("data-i")), ["0", "6"]);
    assert.equal(P.q("select")[0].value, "b1", "the choice is kept over the redraw");
    assert.deepEqual(texts(P.q("select")[0].querySelectorAll("option"))[0], "All books and decks (4)");
    assert.deepEqual(texts(P.q("select")[1].querySelectorAll("option")), ["All prompts (2)", "Due now (1)", "Never asked (1)", "Flagged (0)", "Struggling (0)"], "the Show counts are the book's");
    // the book's prompts are deleted: the filter falls back to all
    P.state.prompts = P.state.prompts.filter((p) => p.collectionId !== "b1");
    X.render();
    assert.equal(P.q("select")[0].value, "");
    assert.deepEqual(P.rowIds(), ["p_cloze", "p_deck"]);
  } finally { P.done(); }
});

test("Show: the flagged prompts of every book in one list; the choices narrow the rows, the totals and the chart, with the book filter", () => {
  const more = library().concat([prompt("p_f2", "b1", "Q. Flagged too?\nA. yes", [asked(at(10), at(25, 20), 14)], { flagged: true, createdAt: at(5) })]);
  const P = page(more);
  try {
    X.open();
    const show = () => P.q("select")[1], book = () => P.q("select")[0];
    const pick = (sel, v) => { sel.value = v; fire(sel, "change"); };
    pick(show(), "flagged");
    assert.deepEqual(P.rowIds(), ["p_cloze", "p_f2"], "from two books, by next due");
    assert.deepEqual(X.filters(), { book: "", show: "flagged" });
    assert.equal(show().value, "flagged", "the choice is kept over the redraw");
    assert.deepEqual(texts(P.q(".stats__totals")), ["2 prompts · 4 cards · 2 due now · 1 never asked · 3 answers · 0 wrong (0%)"]);
    assert.deepEqual(P.q(".stats__col").map((c) => c.parentNode.getAttribute("data-i")), ["0", "3", "11"], "the chart shows the flagged prompts' cards only");
    assert.equal(P.q(".stats__row").every((r) => r.querySelector(".stats__flag")), true);
    // with the book filter: Griffiths has one flagged prompt; the deck has none
    pick(book(), "b1");
    assert.deepEqual(P.rowIds(), ["p_f2"]);
    assert.deepEqual(texts(show().querySelectorAll("option")), ["All prompts (3)", "Due now (1)", "Never asked (1)", "Flagged (1)", "Struggling (0)"]);
    pick(book(), "d1");
    assert.deepEqual(P.rowIds(), []);
    assert.deepEqual(texts(P.q(".stats__none")), ["No prompt matches."]);
    assert.equal(P.q("table").length, 0);
    assert.deepEqual(texts(P.q(".stats__totals")), ["0 prompts · 0 cards · 0 due now · 0 never asked · 0 answers · 0 wrong"]);
    assert.equal(P.q(".stats__col").length, 0);
    // the other choices
    pick(book(), "");
    pick(show(), "struggling");
    assert.deepEqual(P.rowIds(), ["p_deck"]);
    pick(show(), "never");
    assert.deepEqual(P.rowIds(), ["p_cloze", "p_new"]);
    pick(show(), "due");
    assert.deepEqual(P.rowIds(), ["p_cloze", "p_new"]);
    assert.equal(X.show("flagged"), "flagged");
    assert.deepEqual(P.rowIds(), ["p_cloze", "p_f2"], "show(id) redraws the open page");
    assert.equal(X.show("bogus"), "", "an unknown choice is All prompts");
    assert.equal(P.rowIds().length, 5);
    // the flag goes: the prompt leaves the Flagged list on the next redraw
    X.show("flagged");
    P.state.prompts = P.state.prompts.map((p) => (p.id === "p_f2" ? Object.assign({}, p, { flagged: false }) : p));
    X.render();
    assert.deepEqual(P.rowIds(), ["p_cloze"]);
  } finally { P.done(); }
});

test("it redraws once for a burst of changes, keeps the keyboard focus, and close() stops it and empties the page", async () => {
  const P = page(library());
  try {
    X.open();
    const sortBtn = P.q(".stats__sort").find((b) => b.getAttribute("data-sort") === "answers");
    sortBtn.focus();
    fire(sortBtn, "click");
    const after = P.q(".stats__sort").find((b) => b.getAttribute("data-sort") === "answers");
    assert.notEqual(after, sortBtn, "the page was drawn again");
    assert.equal(P.doc.activeElement, after, "the focus is on the same header");
    // a review answers p_new: three events, one redraw
    const made = P.doc.created.length;
    P.state.prompts = P.state.prompts.map((p) => (p.id === "p_new" ? Object.assign({}, p, { cards: [S.grade(p.cards[0], NOW, "remembered")] }) : p));
    M.bus.emit("prompt:saved", {}); M.bus.emit("prompt:saved", {}); M.bus.emit("review:ended", {});
    assert.equal(P.doc.created.length, made, "not at once");
    await tick(220);
    assert.ok(P.doc.created.length > made, "drawn again");
    assert.deepEqual(texts(P.q(".stats__totals")), ["4 prompts · 6 cards · 2 due now · 1 never asked · 9 answers · 4 wrong (44%)"]);
    assert.equal(P.doc.activeElement, P.q(".stats__sort").find((b) => b.getAttribute("data-sort") === "answers"));
    const drawn = P.doc.created.length;
    await tick(220);
    assert.equal(P.doc.created.length, drawn, "one redraw for the burst");
    // close
    assert.equal(X.close(), true);
    assert.equal(X.isOpen(), false);
    assert.equal(P.host.childNodes.length, 0);
    M.bus.emit("prompt:saved", {});
    await tick(220);
    assert.equal(P.host.childNodes.length, 0, "no redraw after close");
    assert.equal(X.close(), false, "closing twice is harmless");
    X.render();
    assert.equal(P.host.childNodes.length, 0, "render() draws only an open page");
  } finally { P.done(); }
});

test("open() twice listens once and leaves the focus alone; Esc on a filter goes back to the library; a redraw keeps the open list and the table's scroll", () => {
  const P = page(library());
  const realOn = M.bus.on;
  let subscribed = 0;
  M.bus.on = (type, fn) => { subscribed++; return realOn.call(M.bus, type, fn); };
  try {
    X.open();
    const first = subscribed;
    assert.equal(first, 8, "one listener per event");
    const sortBtn = P.q(".stats__sort")[2];
    sortBtn.focus();
    assert.equal(X.open(), true);
    assert.equal(subscribed, first, "open() on an open page adds no listener");
    assert.equal(P.doc.activeElement.getAttribute("data-focus"), "sort:cards", "and does not move the focus to the heading");
    // Esc on a filter (M.app routes no key typed in a form field)
    const [book, show] = P.q("select");
    fire(book, "keydown", { key: "a", preventDefault() {} });
    assert.deepEqual(P.routes, []);
    let prevented = 0;
    fire(show, "keydown", { key: "Escape", preventDefault() { prevented++; } });
    assert.deepEqual(P.routes, [["library", null]]);
    assert.equal(prevented, 1);
    fire(book, "keydown", { key: "Escape", defaultPrevented: true, preventDefault() {} });
    assert.equal(P.routes.length, 1, "an Escape something else already took is left alone");
    // the list stays open and the table stays scrolled over a redraw
    P.q(".stats__list")[0].open = true;
    P.q(".stats__scroll")[0].scrollLeft = 120;
    fire(P.q(".stats__sort")[6], "click");
    assert.equal(P.q(".stats__list")[0].open, true);
    assert.equal(P.q(".stats__scroll")[0].scrollLeft, 120);
    P.q(".stats__list")[0].open = false;
    X.render();
    assert.equal(P.q(".stats__list")[0].open, false, "a closed list stays closed");
    // a select takes only its options' values (the fake DOM checks it, as a browser does)
    assert.ok(texts(P.q("select")[1].querySelectorAll("option")).length === 5 && P.q("select")[1].value === "");
    X.show("flagged");
    assert.equal(P.q("select")[1].value, "flagged");
  } finally { M.bus.on = realOn; P.done(); }
});

test("the hover line stays inside the plot: centred over its column, by its own width at both ends", () => {
  const P = page(library());
  try {
    P.doc.layout = true;                                    // a plot 300 px wide, a line 110 px wide
    X.open();
    const tip = P.q(".stats__tip")[0], plot = P.q(".stats__plot")[0], slots = P.q(".stats__slot");
    fire(plot, "pointerover", { target: slots[0] });
    assert.equal(tip.style.left, "55px", "the first day: half the line's width, not off the left edge");
    fire(plot, "pointerover", { target: slots[14] });
    assert.equal(tip.style.left, "145px", "(14.5 / 30) of 300 px");
    fire(plot, "pointerover", { target: slots[29] });
    assert.equal(tip.style.left, "245px", "the last day: the plot's width less half the line");
    fire(plot, "pointercancel");
    assert.equal(tip.classList.contains("is-hidden"), true);
  } finally { P.doc.layout = false; P.done(); }
});

test("a review over the page: no redraw for its answers, one redraw when it ends", async () => {
  const P = page(library());
  const savedReview = M.review;
  try {
    X.open();
    M.review = { isActive: () => true };
    const made = P.doc.created.length;
    M.bus.emit("prompt:saved", {}); M.bus.emit("prompt:saved", {}); M.bus.emit("attachment:ready", { id: "a1" });
    await tick(220);
    assert.equal(P.doc.created.length, made, "the page waits while the review runs");
    M.bus.emit("review:ended", { summary: {} });
    await tick(220);
    assert.ok(P.doc.created.length > made, "drawn again when the review ends");
    const drawn = P.doc.created.length;
    M.review = { isActive: () => false };
    M.bus.emit("prompt:saved", {});
    await tick(220);
    assert.ok(P.doc.created.length > drawn, "and for changes outside a review, as before");
  } finally { M.review = savedReview; P.done(); }
});

test("rendered questions are kept between redraws, but never an image placeholder; a full store drops its oldest entry only", async () => {
  const realRender = M.markup.render;
  const calls = [];
  let loaded = false;
  M.markup.render = (text, opts) => {
    calls.push(text);
    if (/snip/.test(text)) return loaded ? '<img class="att" src="blob:x" alt="snip">' : '<span class="att att--missing" data-id="a1">Image missing</span>';
    return realRender(text, opts);
  };
  let P = page([
    prompt("p_img", "b1", "Q. See the snip here " + Date.now() + "?\nA. yes", [never(NOW)]),
    prompt("p_txt", "b1", "Q. Plain " + Date.now() + "?\nA. yes", [never(NOW)])
  ]);
  try {
    X.open();
    assert.equal(calls.length, 2);
    const q = () => P.q(".stats__row").find((r) => r.getAttribute("data-id") === "p_img").querySelector(".stats__q");
    assert.match(q().innerHTML, /Image missing/);
    X.render();
    assert.equal(calls.length, 3, "the placeholder was not kept: its question is rendered again; the plain one is not");
    loaded = true;                                          // the image's bytes arrived
    M.bus.emit("attachment:ready", { id: "a1" });
    await tick(220);
    assert.match(q().innerHTML, /<img class="att"/, "the page drew the image by itself");
    assert.equal(calls.length, 4);
    X.render();
    assert.equal(calls.length, 4, "now it is kept");
  } finally { P.done(); }
  // 4,001 different questions, more than the 4,000 the store keeps: a draw never drops what it needs itself, so a
  // second draw renders nothing again (a store that dropped an entry per new one would render all 4,001 again)
  calls.length = 0;
  const stamp = "k" + Date.now();
  const big = Array.from({ length: 4001 }, (_, i) => prompt("p" + i, "b1", "Q. " + stamp + " number " + i + "?\nA. y", [never(NOW - i)]));
  P = page(big);
  try {
    X.open();
    assert.equal(calls.length, 4001);
    X.render();
    assert.equal(calls.length, 4001, "a second draw rendered " + (calls.length - 4001) + " questions again");
    assert.ok(X._cacheSize() >= 4001);
    // a later draw of other questions lets the store shrink back to 4,000: the oldest entries it did not use go
    P.state.prompts = [prompt("q1", "b1", "Q. " + stamp + " other one?\nA. y", [never(NOW)]), prompt("q2", "b1", "Q. " + stamp + " other two?\nA. y", [never(NOW)])];
    X.render();
    assert.equal(calls.length, 4003);
    assert.equal(X._cacheSize(), 4000, "trimmed to its limit");
    X.render();
    assert.equal(calls.length, 4003, "the two questions in use were kept");
  } finally { M.markup.render = realRender; P.done(); }
});

test("an empty library says so; prompt text and book names are text, never HTML", () => {
  let P = page([prompt("n1", "b1", "a note", [], { kind: "note" })]);
  try {
    X.open();
    assert.deepEqual(texts(P.q(".stats__empty")), ["No prompts to review yet"]);
    assert.equal(P.q("table").length, 0);
    assert.equal(P.q(".stats__chart").length, 0);
    assert.equal(P.q("select").length, 0);
  } finally { P.done(); }
  const evil = "Q. <img src=x onerror=alert(1)> & <b>bold</b>?\nA. no";
  P = page([prompt("p_x", "b1", evil, [never(NOW)])]);
  try {
    COLS[0].name = "<script>alert(2)</script>";
    X.open();
    // the question goes through M.markup.render, which escapes it; the book name and every other text is textContent
    const q = P.q(".stats__q")[0];
    assert.equal(q.innerHTML, "&lt;img src=x onerror=alert(1)&gt; &amp; &lt;b&gt;bold&lt;/b&gt;?");
    assert.equal(/<(img|b|script)\b/i.test(q.innerHTML), false, "no tag of the prompt's own");
    assert.equal(q.textContent, "<img src=x onerror=alert(1)> & <b>bold</b>?", "what the reader sees");
    assert.equal(P.q(".stats__open")[0].getAttribute("aria-label"), "<img src=x onerror=alert(1)> & <b>bold</b>? — open in its book");
    assert.equal(P.q(".stats__book")[0].textContent, "<script>alert(2)</script>");
    assert.equal(texts(P.q("option"))[1], "<script>alert(2)</script> (1)");
    const tags = new Set(P.doc.created.map((n) => n.tagName));
    for (const t of ["IMG", "SCRIPT", "B"]) assert.equal(tags.has(t), false, t + " was never made");
    const html = P.doc.created.filter((n) => n.innerHTML !== "");
    assert.deepEqual(html.map((n) => n.className), ["stats__q"], "the question is the page's only HTML");
  } finally { COLS[0].name = "Griffiths"; P.done(); }
});
