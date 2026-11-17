// node --test test/list.test.js — M.list loads without a DOM; row ordering, search, due text (SPEC §14, §17.2)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const list = require(path.join(__dirname, "..", "js", "list.js"));
const P = list._pure;
const DAY = 86400000;

test("loads in node with no DOM and registers M.list", () => {
  assert.equal(typeof window, "undefined");
  assert.ok(globalThis.Marginalia && globalThis.Marginalia.list === list);
});

test("every §17.2 / BUILD-NOTES contract function exists and is inert without a DOM", () => {
  for (const name of ["open", "close", "search", "refresh", "isOpen"]) assert.equal(typeof list[name], "function", name);
  assert.equal(list.open("c1", {}), false);
  assert.equal(list.isOpen(), false);
  list.close();
  list.search("x");
  list.refresh();
  assert.equal(list.activeEditor(), null);
  assert.equal(list.collectionId(), null);
});

test("sortPrompts: books in reading order (pageIndex, −y, createdAt), decks by createdAt, tombstones out", () => {
  const ps = [
    { id: "a", anchor: { pageIndex: 2, y: 500 }, createdAt: 1 },
    { id: "b", anchor: { pageIndex: 1, y: 100 }, createdAt: 2 },
    { id: "c", anchor: { pageIndex: 1, y: 700 }, createdAt: 3 },
    { id: "d", anchor: null, context: { pageIndex: 1 }, createdAt: 4 },        // lost: page top
    { id: "e", anchor: { pageIndex: 0, y: 10 }, createdAt: 5, deletedAt: 9 }
  ];
  assert.deepEqual(P.sortPrompts(ps, "book").map((p) => p.id), ["d", "c", "b", "a"]);
  assert.deepEqual(P.sortPrompts(ps, "deck").map((p) => p.id), ["a", "b", "c", "d"]);
});

test("matches: text search ignores the tags line, #query searches tags, case-insensitive", () => {
  const p = { text: "Q. What does V stand for?\nA. The potential\n#qm #griffiths", tags: ["qm", "griffiths"] };
  assert.equal(P.matches(p, ""), true);
  assert.equal(P.matches(p, "POTENTIAL"), true);
  assert.equal(P.matches(p, "#qm"), true);
  assert.equal(P.matches(p, "#nope"), false);
  assert.equal(P.matches(p, "griff"), true);          // tag text also matches a plain query
  assert.equal(P.matches(p, "#griffiths"), true);
  assert.equal(P.matches({ text: "plain", tags: [] }, "#"), false);
  assert.equal(P.matches(p, "zzz"), false);
});

test("dueText: note, not reviewed, new · due now (a card never asked is due at once: D27), due now, due in 13 d (the time from which a session can ask the card)", () => {
  const t = 1762150000000;
  assert.equal(P.dueText({ kind: "note", cards: [] }, t), "note");
  assert.equal(P.dueText({ kind: "highlight" }, t), "note");
  assert.equal(P.dueText({ kind: "qa", cards: [] }, t), "not reviewed");
  assert.equal(P.dueText({ kind: "qa", cards: [{ i: 0, createdAt: t - 60000, dueAt: t - 60000, lastReviewedAt: null }] }, t), "new · due now");
  assert.equal(P.dueText({ kind: "qa", cards: [{ i: 0, createdAt: t - DAY, dueAt: t + 4 * DAY, lastReviewedAt: null }] }, t), "new · due now", "a card stored before D27 (due in 5 days) reads the same");
  assert.equal(P.dueText({ kind: "qa", cards: [{ i: 0, dueAt: t + 5 * DAY, lastReviewedAt: null }] }, t), "new · due in 4 d", "without a createdAt the stored dueAt decides: a session asks from 16 hours before it (the lookahead)");
  assert.equal(P.dueText({ kind: "qa", cards: [{ i: 0, createdAt: t + 3 * DAY, dueAt: t + 3 * DAY, lastReviewedAt: null }] }, t), "new · due now", "never asked is due now, also with a createdAt that lies ahead (a clock set back)");
  assert.equal(P.dueText({ kind: "qa", cards: [{ i: 0, createdAt: t - 9 * DAY, dueAt: t + 5 * DAY, lastReviewedAt: t - 60000 }] }, t), "due in 4 d", "after its first answer: 5 days less the 16-hour lookahead, as the due counts say");
  assert.equal(P.dueText({ kind: "cloze", cards: [{ i: 0, dueAt: t - 1, lastReviewedAt: t - DAY }, { i: 1, dueAt: t + DAY, lastReviewedAt: null }] }, t), "due now");
  assert.equal(P.dueText({ kind: "qa", cards: [{ i: 0, dueAt: t + 14 * DAY, lastReviewedAt: t - DAY }] }, t), "due in 13 d");
  // the text says "due now" exactly when the count says due (M.scheduler.isReady): inside the 16-hour lookahead
  const soon = { kind: "qa", cards: [{ i: 0, createdAt: t - 9 * DAY, dueAt: t + 16 * 3600000, lastReviewedAt: t - 5 * DAY }] };
  assert.equal(P.dueText(soon, t), "due now");
  assert.equal(P.dueText(soon, t - 60000), "due in 1 min");
  // D29: no card comes again within 16 hours of an answer to it or to another card of its prompt
  const HOUR = 3600000;
  const answered = { i: 0, createdAt: t - 9 * DAY, dueAt: t + 5 * DAY, lastReviewedAt: t - HOUR }, blank = { i: 1, createdAt: t - 9 * DAY, dueAt: t - 9 * DAY, lastReviewedAt: null };
  assert.equal(P.dueText({ kind: "cloze", cards: [answered, blank] }, t), "due in 15 h", "the sentence's other blank waits for the end of the hold");
  assert.equal(P.dueText({ kind: "cloze", cards: [Object.assign({}, answered, { lastReviewedAt: t - 16 * HOUR }), blank] }, t), "due now");
  assert.equal(P.dueText({ kind: "cloze", cards: [answered, Object.assign({}, blank, { createdAt: t + 3 * DAY, dueAt: t + 3 * DAY })] }, t), "due in 15 h", "a clock set back changes nothing in that");
  // D28: a card answered wrong an hour ago is due the next day; one stored by the old rule (due 10 minutes later) too
  assert.equal(P.dueText({ kind: "qa", cards: [{ i: 0, createdAt: t - 9 * DAY, dueAt: t - HOUR + DAY, lastReviewedAt: t - HOUR }] }, t), "due in 15 h", "16 hours after the answer, not the 23 hours to its due time");
  assert.equal(P.dueText({ kind: "qa", cards: [{ i: 0, createdAt: t - 9 * DAY, dueAt: t - HOUR + 600000, lastReviewedAt: t - HOUR }] }, t), "due in 15 h");
});

test("sectionText: section label, page label, anchor page fallback, deck prompt without section", () => {
  assert.equal(P.sectionText({ context: { sectionLabel: "Ch. 1 · The Wave Function", pageLabel: "12" } }), "Ch. 1 · The Wave Function");
  assert.equal(P.sectionText({ context: { sectionLabel: null, pageLabel: "xii" } }), "p. xii");
  assert.equal(P.sectionText({ context: null, anchor: { pageIndex: 11 } }), "p. 12");
  assert.equal(P.sectionText({ context: { docName: "Deck", sectionLabel: null, pageIndex: null, pageLabel: null }, anchor: null }), "");
});

test("sides: question / answer per kind", () => {
  assert.deepEqual(P.sides({ text: "Q. What?\nA. That.\n#qm" }), { question: "What?", answer: "That." });
  assert.deepEqual(P.sides({ text: "The {wave function} solves it." }), { question: "The {wave function} solves it.", answer: "" });
  assert.deepEqual(P.sides({ text: "", anchor: { quote: "a potential energy function" } }), { question: "“a potential energy function”", answer: "" });
});
