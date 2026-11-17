"use strict";
// test/prompts.test.js — SPEC §12 bullets for M.prompts (§4, §14, §16).
// Run from the project root: node --test test/prompts.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const P = require(path.join(__dirname, "..", "js", "prompts.js"));
const S = require(path.join(__dirname, "..", "js", "scheduler.js"));
const codes = (parsed) => parsed.lints.map((l) => l.code);

// ---- tokenize ------------------------------------------------------------------
function checkCoverage(text, runs) {
  let pos = 0;
  for (const r of runs) {
    assert.equal(r.start, pos, "runs are contiguous");
    assert.ok(r.end > r.start);
    if (r.type === "text") assert.equal(r.value, text.slice(r.start, r.end));
    pos = r.end;
  }
  assert.equal(pos, text.length, "runs cover the whole text");
}

test("tokenize: plain text is one run; empty text is none", () => {
  assert.deepEqual(P.tokenize("hello"), [{ type: "text", value: "hello", start: 0, end: 5 }]);
  assert.deepEqual(P.tokenize(""), []);
  assert.deepEqual(P.tokenize(null), []);
});

test("tokenize: the four delimiter pairs, offsets spanning the delimiters, values without them", () => {
  const text = "a $x^2$ b $$\nE=mc^2\n$$ c \\(y\\) d \\[\nz\n\\] e";
  const runs = P.tokenize(text);
  checkCoverage(text, runs);
  const math = runs.filter((r) => r.type === "math");
  assert.deepEqual(math.map((r) => [r.value, r.display, r.delim]), [
    ["x^2", false, "$"], ["\nE=mc^2\n", true, "$$"], ["y", false, "\\("], ["\nz\n", true, "\\["],
  ]);
  assert.equal(text.slice(math[0].start, math[0].end), "$x^2$");
  assert.equal(text.slice(math[1].start, math[1].end), "$$\nE=mc^2\n$$");
  assert.equal(text.slice(math[2].start, math[2].end), "\\(y\\)");
  assert.equal(text.slice(math[3].start, math[3].end), "\\[\nz\n\\]");
  assert.deepEqual(runs.map((r) => r.type), ["text", "math", "text", "math", "text", "math", "text", "math", "text"]);
});

test("tokenize: inline $ rules — no whitespace after the opener or before the closer, one line only", () => {
  assert.deepEqual(P.tokenize("$ x$").map((r) => r.type), ["text"]);
  assert.deepEqual(P.tokenize("$x $").map((r) => r.type), ["text"]);
  assert.deepEqual(P.tokenize("$x\ny$").map((r) => r.type), ["text"]);
  assert.deepEqual(P.tokenize("costs $5 and $6").map((r) => r.type), ["text"]);  // prose dollars survive
  assert.deepEqual(P.tokenize("costs $5 and 6").map((r) => r.type), ["text"]);
  assert.deepEqual(P.tokenize("costs $5 and 6$ now").map((r) => [r.type, r.value]), [["text", "costs "], ["math", "5 and 6"], ["text", " now"]]);
  assert.deepEqual(P.tokenize("\\(x\ny\\)").map((r) => r.type), ["text"]);
  assert.deepEqual(P.tokenize("$a$$b$").map((r) => [r.type, r.value]), [["math", "a"], ["math", "b"]]);
  assert.deepEqual(P.tokenize("$$unclosed").map((r) => r.type), ["text"]);
  assert.deepEqual(P.tokenize("lonely $").map((r) => r.type), ["text"]);
});

test("tokenize: \\$ is a literal dollar and never opens or closes math", () => {
  assert.deepEqual(P.tokenize("\\$5 and \\$6"), [{ type: "text", value: "\\$5 and \\$6", start: 0, end: 11 }]);
  const runs = P.tokenize("price \\$5, $x\\$y$ ok");
  assert.deepEqual(runs.map((r) => [r.type, r.value]), [["text", "price \\$5, "], ["math", "x\\$y"], ["text", " ok"]]);
  // an escaped backslash before $ does not escape the dollar
  assert.deepEqual(P.tokenize("\\\\$x$").map((r) => r.type), ["text", "math"]);
});

test("tokenize: image tokens anywhere, id extracted", () => {
  const text = "see ![snip](att:a_123-abc) and $x$";
  const runs = P.tokenize(text);
  checkCoverage(text, runs);
  assert.deepEqual(runs[1], { type: "image", value: "![snip](att:a_123-abc)", id: "a_123-abc", start: 4, end: 26 });
  assert.deepEqual(P.tokenize("![snip](http://x) ![snip](att:)").map((r) => r.type), ["text"]);
  assert.deepEqual(P.imageIds("![snip](att:one) text ![snip](att:two) ![snip](att:one)"), ["one", "two"]);
  assert.deepEqual(P.imageIds("no images $x$"), []);
});

// ---- parse: Q/A ----------------------------------------------------------------
test("parse: Q/A with a multi-line answer", () => {
  const p = P.parse("Q. What does V stand for?\nA. The potential\nenergy function\n\nover two paragraphs");
  assert.equal(p.kind, "qa");
  assert.equal(p.question, "What does V stand for?");
  assert.equal(p.answer, "The potential\nenergy function\n\nover two paragraphs");
  assert.deepEqual(p.deletions, []);
  assert.deepEqual(p.tags, []);
  // changed with FEATURES P1.2 c (was: no lint): three non-blank answer lines now read as a list of three items
  assert.deepEqual(p.lints, [{ code: "list_answer", msg: "The answer is a list of 3 items — a whole list is hard to recall; make one {blank} per item" }]);
  assert.deepEqual(P.parse("Q. What does V stand for?\nA. The potential\nenergy function").lints, []);
  assert.equal(p.display, "Q. What does V stand for?\nA. The potential\nenergy function\n\nover two paragraphs");
  assert.equal(p.body, p.display);
});

test("parse: multi-line question, A. line later; braces in Q/A are plain text", () => {
  const p = P.parse("Q. State the\nSchrödinger equation {in words}\nA. $i\\hbar\\partial_t\\Psi = H\\Psi$");
  assert.equal(p.kind, "qa");
  assert.equal(p.question, "State the\nSchrödinger equation {in words}");
  assert.equal(p.answer, "$i\\hbar\\partial_t\\Psi = H\\Psi$");
  assert.deepEqual(p.deletions, []);
});

test("parse: Q. without A. → note + lint no_answer (never blocked)", () => {
  const p = P.parse("Q. What is this?");
  assert.equal(p.kind, "note");
  assert.equal(p.question, "What is this?");
  assert.equal(p.answer, "");
  assert.deepEqual(p.lints, [{ code: "no_answer", msg: "Add an A. line to make this reviewable" }]);
  // an A. line before the Q. line does not count
  assert.equal(P.parse("A. answer first\nQ. then").kind, "note");
  assert.deepEqual(codes(P.parse("A. answer first\nQ. then")), ["no_answer"]);
});

test("parse: an A. line with nothing after it is a qa with lint empty_answer", () => {
  const p = P.parse("Q. ![snip](att:a_1)\nA. ");
  assert.equal(p.kind, "qa");
  assert.equal(p.question, "![snip](att:a_1)");
  assert.equal(p.answer, "");
  assert.deepEqual(codes(p), ["empty_answer"]);
});

// ---- parse: cloze -------------------------------------------------------------
test("parse: one deletion → cloze with offsets into the raw text", () => {
  const text = "The {wave function} solves it.";
  const p = P.parse(text);
  assert.equal(p.kind, "cloze");
  assert.deepEqual(p.deletions, [{ start: 4, end: 19, text: "wave function" }]);
  assert.equal(text.slice(4, 19), "{wave function}");
  assert.equal(p.body, text);
  assert.equal(p.question, text);
  assert.deepEqual(p.lints, []);
});

test("parse: three deletions → three cards + lint many_deletions", () => {
  const text = "The {wave function} $\\Psi(x,t)$ solves the {Schrödinger equation} in {QM}.";
  const p = P.parse(text);
  assert.equal(p.kind, "cloze");
  assert.deepEqual(p.deletions.map((d) => d.text), ["wave function", "Schrödinger equation", "QM"]);
  for (const d of p.deletions) assert.equal(text.slice(d.start, d.end), "{" + d.text + "}");
  assert.deepEqual(p.lints, [{ code: "many_deletions", msg: "Makes 3 cards" }]);
  assert.deepEqual(codes(P.parse("{a} and {b}")), []);
});

test("parse: braces inside $\\frac{a}{b}$ are ignored", () => {
  const p = P.parse("Compute $\\frac{a}{b}$ now");
  assert.equal(p.kind, "note");
  assert.deepEqual(p.deletions, []);
  assert.deepEqual(P.parse("$$\\frac{a}{b}$$ and \\(\\sqrt{x}\\) and \\[\\{x\\}\\]").deletions, []);
  const q = P.parse("{Euler} wrote $e^{i\\pi}$ first");
  assert.deepEqual(q.deletions.map((d) => d.text), ["Euler"]);
});

test("parse: a deletion that contains a math run is masked whole", () => {
  const text = "{the $x$ value} is here";
  const p = P.parse(text);
  assert.equal(p.kind, "cloze");
  assert.deepEqual(p.deletions, [{ start: 0, end: 15, text: "the $x$ value" }]);
  const d = P.parse("energy {$E = mc^2$} holds").deletions;
  assert.deepEqual(d.map((x) => x.text), ["$E = mc^2$"]);
  // a brace left open across math never closes
  assert.deepEqual(P.parse("{open $\\frac{a}{b}$ never").deletions, []);
});

test("parse: \\{ is a literal brace", () => {
  assert.equal(P.parse("a \\{b\\} c").kind, "note");
  const p = P.parse("a \\{b\\} {c}");
  assert.deepEqual(p.deletions, [{ start: 8, end: 11, text: "c" }]);
  // an escaped backslash followed by a real brace still opens a deletion
  assert.deepEqual(P.parse("x \\\\{y}").deletions.map((d) => d.text), ["y"]);
});

test("parse: nested braces → the outer span; blank braces are not deletions", () => {
  const p = P.parse("{a {b} c} d");
  assert.deepEqual(p.deletions, [{ start: 0, end: 9, text: "a {b} c" }]);
  assert.equal(P.parse("{} and { }").kind, "note");
  assert.equal(P.parse("{x}} }").deletions.length, 1);
});

// ---- tags ----------------------------------------------------------------------
test("parse: a final #tags line is stripped into tags; '# Section' is not a tag", () => {
  const p = P.parse("Q. x\nA. y\n#qm #physics #qm\n");
  assert.deepEqual(p.tags, ["qm", "physics"]);
  assert.equal(p.display, "Q. x\nA. y");
  assert.equal(p.answer, "y");
  assert.equal(P.stripTags("Q. x\nA. y\n#qm #physics\n"), "Q. x\nA. y");
  const s = P.parse("foo bar\n# Section");
  assert.deepEqual(s.tags, []);
  assert.equal(s.display, "foo bar\n# Section");
  assert.equal(P.stripTags("foo\n# Section"), "foo\n# Section");
  // short or malformed tokens keep the line as text
  assert.deepEqual(P.parse("foo\n#a").tags, []);
  assert.equal(P.parse("foo\n#a").display, "foo\n#a");
  assert.deepEqual(P.parse("foo\n#qm, #x").tags, []);
  // only the final line counts
  const mid = P.parse("#qm\nfoo");
  assert.deepEqual(mid.tags, []);
  assert.equal(mid.display, "#qm\nfoo");
  // a cloze keeps its offsets when a tags line follows
  const c = P.parse("The {wave function} solves it.\n#qm");
  assert.deepEqual(c.deletions, [{ start: 4, end: 19, text: "wave function" }]);
  assert.deepEqual(c.tags, ["qm"]);
  assert.deepEqual(P.parse("#qm-2024 #under_score").tags, ["qm-2024", "under_score"]);
});

// ---- kinds: highlight / note ----------------------------------------------------
test("parse: empty text is a highlight; plain text is a note; only tags is a highlight with tags", () => {
  assert.equal(P.parse("").kind, "highlight");
  assert.equal(P.parse("   \n").kind, "highlight");
  assert.equal(P.parse(undefined).kind, "highlight");
  assert.equal(P.parse("").body, "");
  const n = P.parse("just a thought\nover two lines");
  assert.equal(n.kind, "note");
  assert.equal(n.question, "just a thought\nover two lines");
  assert.deepEqual(n.lints, []);
  const t = P.parse("#qm");
  assert.equal(t.kind, "highlight");
  assert.deepEqual(t.tags, ["qm"]);
});

// ---- lints ---------------------------------------------------------------------
test("lint: long_question, long_answer, yes_no, multi_sentence_cloze; worst first", () => {
  const words = (n) => Array.from({ length: n }, (_, i) => "w" + i).join(" ");
  assert.deepEqual(codes(P.parse("Q. " + words(26) + "\nA. ok")), ["long_question"]);
  assert.deepEqual(codes(P.parse("Q. " + words(25) + "\nA. ok")), []);
  assert.deepEqual(codes(P.parse("Q. why\nA. " + words(16))), ["long_answer"]);
  assert.deepEqual(codes(P.parse("Q. why\nA. " + words(15))), []);
  // a formula counts as one word
  assert.deepEqual(codes(P.parse("Q. why\nA. $" + words(40) + "$ one")), []);
  for (const w of ["Is", "are", "Do", "does", "can", "Did", "was", "were"]) {
    assert.deepEqual(codes(P.parse("Q. " + w + " it true?\nA. yes")), ["yes_no"], w);
  }
  // changed with FEATURES P1.2 a (was: "A. yes" → []): "Island" is still no "is", but the answer "yes" alone now makes a yes/no prompt
  assert.deepEqual(codes(P.parse("Q. Island life?\nA. quiet")), []);
  assert.deepEqual(codes(P.parse("Q. Island life?\nA. yes")), ["yes_no"]);
  assert.deepEqual(codes(P.parse("The {wave function} is complex. It {evolves} in time.")), ["multi_sentence_cloze"]);
  assert.deepEqual(codes(P.parse("The {wave function} e.g. is complex.")), []);
  // ordering: worst first
  const both = P.parse("Q. Is " + words(30) + "\nA. ");
  assert.deepEqual(codes(both), ["empty_answer", "yes_no", "long_question"]);
  const cz = P.parse("A {b}. C {d}. E {f}.");
  assert.deepEqual(codes(cz), ["multi_sentence_cloze", "many_deletions"]);
  // lint() is callable on a parsed object directly
  assert.deepEqual(P.lint(P.parse("Q. hm")).map((l) => l.code), ["no_answer"]);
  assert.deepEqual(P.lint(null), []);
  assert.deepEqual(P.lint(P.parse("")), []);
  for (const l of [...both.lints, ...cz.lints]) { assert.equal(typeof l.msg, "string"); assert.ok(l.msg.length > 0); }
});

// ---- parseBatch ------------------------------------------------------------------
test("parseBatch: blank lines split blocks, '# Section' sets the section for what follows", () => {
  const text = "Q. to walk\nA. gehen\n\n# Verbs\nQ. to run\nA. laufen\n\nDer Hund {bellt} laut.\n#de\n\n\n# Nouns\nder {Hund}\n";
  const blocks = P.parseBatch(text);
  assert.equal(blocks.length, 4);
  assert.deepEqual(blocks.map((b) => b.section), [null, "Verbs", "Verbs", "Nouns"]);
  assert.deepEqual(blocks.map((b) => b.parsed.kind), ["qa", "qa", "cloze", "cloze"]);
  assert.equal(blocks[0].text, "Q. to walk\nA. gehen");
  assert.equal(blocks[1].parsed.answer, "laufen");
  assert.equal(blocks[2].text, "Der Hund {bellt} laut.\n#de");
  assert.deepEqual(blocks[2].parsed.tags, ["de"]);
  assert.deepEqual(blocks[2].parsed.deletions, [{ start: 9, end: 16, text: "bellt" }]);
  assert.deepEqual(P.parseBatch(""), []);
  assert.deepEqual(P.parseBatch("\n\n# Only a heading\n\n"), []);
  // CRLF input and a section line right after a block
  const crlf = P.parseBatch("Q. a\r\nA. b\r\n# S\r\nQ. c\r\nA. d");
  assert.deepEqual(crlf.map((b) => [b.section, b.parsed.question, b.parsed.answer]), [[null, "a", "b"], ["S", "c", "d"]]);
  // a tags line is not a section line; "#" without a space is text
  assert.equal(P.parseBatch("#qm\n").length, 1);
  assert.equal(P.parseBatch("#\nfoo")[0].text, "#\nfoo");
});

// ---- reconcileCards ---------------------------------------------------------------
const NOW = 1700000000000;
function mkCard(i, extra) {
  return Object.assign({ i, createdAt: NOW - 10 * S.DAY, lastReviewedAt: NOW - 3 * S.DAY, intervalMs: 7 * S.DAY, dueAt: NOW + 4 * S.DAY, log: [] }, extra);
}

test("reconcileCards: a new cloze gets one fresh schedule per deletion", () => {
  const r = P.reconcileCards({ text: "", cards: [] }, P.parse("{a} and {b}"), NOW);
  assert.equal(r.cards.length, 2);
  assert.deepEqual(r.cards.map((c) => c.i), [0, 1]);
  for (const c of r.cards) {
    assert.deepEqual(c, Object.assign({ i: c.i }, S.newSchedule(NOW)));
    assert.equal(c.dueAt, NOW, "a new card is due at once (D27)");
  }
  assert.deepEqual(r.dropped, []);
  assert.deepEqual(P.reconcileCards(null, P.parse("Q. x\nA. y"), NOW).cards, [Object.assign({ i: 0 }, S.newSchedule(NOW))]);
  assert.deepEqual(P.reconcileCards({ cards: [] }, P.parse("a note"), NOW), { cards: [], dropped: [] });
});

test("reconcileCards: cloze cards follow their hidden text (trimmed, whitespace-collapsed)", () => {
  const old = { text: "{a} then {b} then {c}", cards: [mkCard(0, { intervalMs: 1 }), mkCard(1, { intervalMs: 2 }), mkCard(2, { intervalMs: 3 })] };
  const r = P.reconcileCards(old, P.parse("{ c } then {a}"), NOW);
  assert.equal(r.cards.length, 2);
  assert.equal(r.cards[0].intervalMs, 3);                               // was card 2
  assert.equal(r.cards[0].i, 0);
  assert.equal(r.cards[1].intervalMs, 1);                               // was card 0
  assert.equal(r.cards[1].i, 1);
  assert.deepEqual(r.dropped, [old.cards[1]]);
  assert.equal(old.cards[2].i, 2, "input cards are not mutated");
  // whitespace inside the hidden text is collapsed for matching
  const r2 = P.reconcileCards({ text: "{wave  function}", cards: [mkCard(0, { intervalMs: 9 })] }, P.parse("{wave\nfunction}"), NOW);
  assert.equal(r2.cards[0].intervalMs, 9);
  assert.deepEqual(r2.dropped, []);
});

test("reconcileCards: unmatched deletions fall back to the same index, then to fresh schedules", () => {
  const old = { text: "{a} and {b}", cards: [mkCard(0, { intervalMs: 1 }), mkCard(1, { intervalMs: 2 })] };
  const r = P.reconcileCards(old, P.parse("{x} and {y}"), NOW);
  assert.deepEqual(r.cards.map((c) => [c.i, c.intervalMs]), [[0, 1], [1, 2]]);
  assert.deepEqual(r.dropped, []);
  // text match first, index fallback cannot reuse a card already matched
  const r2 = P.reconcileCards(old, P.parse("{b} and {z}"), NOW);
  assert.deepEqual(r2.cards.map((c) => [c.i, c.intervalMs]), [[0, 2], [1, S.FIRST]]);
  assert.equal(r2.cards[1].createdAt, NOW);
  assert.deepEqual(r2.dropped, [old.cards[0]]);
  // growing the cloze keeps the old ones and adds fresh cards
  const r3 = P.reconcileCards(old, P.parse("{a} and {b} and {c}"), NOW);
  assert.deepEqual(r3.cards.map((c) => [c.i, c.intervalMs]), [[0, 1], [1, 2], [2, S.FIRST]]);
  assert.deepEqual(r3.dropped, []);
  // cards without an `i` use their array position (position 0 hid "a", so "q" takes it by index; "b" is new)
  const r4 = P.reconcileCards({ text: "{a} {b}", cards: [{ createdAt: 1, lastReviewedAt: null, intervalMs: 5, dueAt: 6, log: [] }] }, P.parse("{q} {b}"), NOW);
  assert.deepEqual(r4.cards.map((c) => [c.i, c.intervalMs]), [[0, 5], [1, S.FIRST]]);
  const r5 = P.reconcileCards({ text: "{a} {b}", cards: [{ createdAt: 1, lastReviewedAt: null, intervalMs: 5, dueAt: 6, log: [] }] }, P.parse("{q} {a}"), NOW);
  assert.deepEqual(r5.cards.map((c) => [c.i, c.intervalMs]), [[0, S.FIRST], [1, 5]]);
});

test("reconcileCards: dropped cards keep their history so the editor can ask before saving", () => {
  const history = [{ at: NOW - 3 * S.DAY, outcome: "remembered", intervalMs: 7 * S.DAY, dueAt: NOW + 4 * S.DAY }];
  const old = { text: "{a} and {b} and {c}", cards: [mkCard(0), mkCard(1, { log: history }), mkCard(2, { log: history.concat(history) })] };
  const r = P.reconcileCards(old, P.parse("{a} only"), NOW);
  assert.deepEqual(r.cards.map((c) => c.i), [0]);
  assert.equal(r.dropped.length, 2);
  assert.deepEqual(r.dropped.map((c) => c.log.length), [1, 2]);
  assert.ok(r.dropped.some((c) => c.log.length > 0));
  assert.equal(r.dropped[0], old.cards[1]);
});

test("reconcileCards: qa keeps card 0; kind changes to note/highlight keep every card", () => {
  const cloze = { text: "{a} and {b} and {c}", cards: [mkCard(0, { intervalMs: 1 }), mkCard(1, { intervalMs: 2 }), mkCard(2, { intervalMs: 3 })] };
  const asQa = P.reconcileCards(cloze, P.parse("Q. what\nA. that"), NOW);
  assert.deepEqual(asQa.cards.map((c) => [c.i, c.intervalMs]), [[0, 1]]);
  assert.deepEqual(asQa.dropped, [cloze.cards[1], cloze.cards[2]]);
  // qa → qa keeps the schedule
  const qa = { text: "Q. a\nA. b", cards: [mkCard(0, { intervalMs: 42 })] };
  assert.deepEqual(P.reconcileCards(qa, P.parse("Q. a2\nA. b2"), NOW), { cards: [mkCard(0, { intervalMs: 42 })], dropped: [] });
  // qa whose only card is not index 0 (legacy) is still the one kept
  const odd = { text: "Q. a\nA. b", cards: [mkCard(1, { intervalMs: 8 })] };
  assert.deepEqual(P.reconcileCards(odd, P.parse("Q. a\nA. b"), NOW).cards, [mkCard(0, { intervalMs: 8 })]);
  // cloze → note keeps all three, untouched
  const asNote = P.reconcileCards(cloze, P.parse("just text now"), NOW);
  assert.deepEqual(asNote, { cards: cloze.cards, dropped: [] });
  assert.notEqual(asNote.cards, cloze.cards);
  const asHl = P.reconcileCards(cloze, P.parse(""), NOW);
  assert.deepEqual(asHl, { cards: cloze.cards, dropped: [] });
  // and back to a cloze with the same words: matched by text again
  const back = P.reconcileCards({ text: "just text now", cards: cloze.cards }, P.parse("{c} {a} {b}"), NOW);
  assert.deepEqual(back.cards.map((c) => c.intervalMs), [1, 2, 3]);   // old text had no deletions → index fallback
});
