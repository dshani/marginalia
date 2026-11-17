"use strict";
// test/cues.test.js — FEATURES P1.1, cues in cloze blanks: `{hidden::cue}`.
//  - M.prompts.parse: the last top-level "::" of a deletion splits it into the hidden part (`text`) and the cue;
//    math, image tokens, nested braces and `\::` never split; a blank part means no cue.
//  - M.prompts.reconcileCards: a card is its hidden part, so a cue can come, change and go without touching it.
//  - M.markup.render in every mode, with and without a mask; plain(), toMarkdown(), toObsidian(), the Anki row.
//  - The cloze commands (C in the reader: M.anchors.sentenceAround; Alt+Shift+C in the editor: wrapBraces) write a
//    "::" of the text they wrap as `\::`.
//  - The two scanners (js/prompts.js and js/markup.js) agree, on chosen texts and on 20 000 seeded random ones.
//  - A text without a cue gives the bytes it gave before cues existed: test/cues-golden.json holds what the code
//    of 2026-11-11, before this feature, produced for 100-odd texts (the vectors of the older tests among them).
// Run: node --test test/cues.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const JS = path.join(ROOT, "js");
delete globalThis.katex;                                   // math renders as <code class="tex">source</code>
require(path.join(JS, "util.js"));
const S = require(path.join(JS, "scheduler.js"));
const P = require(path.join(JS, "prompts.js"));
const mk = require(path.join(JS, "markup.js"));
require(path.join(JS, "context.js"));
const X = require(path.join(JS, "exporter.js"));
const A = require(path.join(JS, "anchors.js"));
const E = require(path.join(JS, "editor.js"));

const tex = (src) => '<code class="tex">' + src + "</code>";
function blank(hidden) {
  const len = hidden.replace(/\s+/g, " ").trim().length;
  return '<span class="cloze-blank" style="display:inline-block;width:' + Math.max(4, Math.round(len * 0.55 * 10) / 10) + 'em" data-len="' + len + '"></span>';
}
const cue = (html) => ' <span class="cloze-cue">(' + html + ")</span>";
const mark = (html) => '<mark class="cloze-mark">' + html + "</mark>";
const reveal = (html) => '<mark class="cloze-reveal">' + html + "</mark>";
const dels = (text) => P.parse(text).deletions;
const HIDE = (i) => ({ index: i, reveal: false }), SHOW = (i) => ({ index: i, reveal: true });

// ------------------------------------------------------------------ parse

test("parse: {hidden::cue} gives text = the hidden part and cue = the trimmed cue; start and end still span the braces", () => {
  const text = "The {wave function::two words} is {complex}.";
  const p = P.parse(text);
  assert.equal(p.kind, "cloze");
  assert.deepEqual(p.deletions, [{ start: 4, end: 30, text: "wave function", cue: "two words" }, { start: 34, end: 43, text: "complex" }]);
  assert.equal(text.slice(4, 30), "{wave function::two words}");
  assert.equal("cue" in p.deletions[1], false, "no cue: no cue key at all, the deletion is what it always was");
  assert.equal(p.body, text, "the body stays as typed");
  assert.equal(p.question, text);
  assert.equal(p.display, text);
  assert.deepEqual(p.lints, []);
  assert.equal(P.CUE_SEP, "::", "the separator is one named constant");
});

test("parse: blanks around the separator belong to it; the hidden part is kept as typed, so the separator sits right after it", () => {
  const text = "a { x  ::  the cue  } b";
  const d = dels(text)[0];
  assert.deepEqual(d, { start: 2, end: 21, text: " x  ", cue: "the cue" });
  assert.equal(text.substr(d.start + 1 + d.text.length, 2), "::", "start + 1 + text.length is the separator");
  assert.deepEqual(dels("{x::a\nb}"), [{ start: 0, end: 8, text: "x", cue: "a\nb" }], "a cue may span lines");
});

test("parse: the last top-level :: wins", () => {
  assert.deepEqual(dels("{a::b::c}"), [{ start: 0, end: 9, text: "a::b", cue: "c" }]);
  assert.deepEqual(dels("{a::b::c::d}"), [{ start: 0, end: 12, text: "a::b::c", cue: "d" }]);
  assert.deepEqual(dels("{a:::b}"), [{ start: 0, end: 7, text: "a:", cue: "b" }], "three colons: the last pair");
  assert.deepEqual(dels("{a::::b}"), [{ start: 0, end: 8, text: "a::", cue: "b" }]);
});

test("parse: a :: inside math, an image token or nested braces never splits", () => {
  assert.deepEqual(dels("{$a::b$}"), [{ start: 0, end: 8, text: "$a::b$" }]);
  assert.deepEqual(dels("{\\(a::b\\)}"), [{ start: 0, end: 10, text: "\\(a::b\\)" }]);
  assert.deepEqual(dels("{$$a::b$$}"), [{ start: 0, end: 10, text: "$$a::b$$" }]);
  assert.deepEqual(dels("{![a::b](att:i1)}"), [{ start: 0, end: 17, text: "![a::b](att:i1)" }]);
  assert.deepEqual(dels("{x {y::z} w}"), [{ start: 0, end: 12, text: "x {y::z} w" }]);
  // … and a top-level one after them still does
  assert.deepEqual(dels("{$|\\psi\\rangle$::state}"), [{ start: 0, end: 23, text: "$|\\psi\\rangle$", cue: "state" }]);
  assert.deepEqual(dels("{$a::b$::ratio}"), [{ start: 0, end: 15, text: "$a::b$", cue: "ratio" }]);
  assert.deepEqual(dels("{![img](att:1)::picture}"), [{ start: 0, end: 24, text: "![img](att:1)", cue: "picture" }]);
  assert.deepEqual(dels("{x {y::z} w::cue}"), [{ start: 0, end: 17, text: "x {y::z} w", cue: "cue" }]);
  assert.deepEqual(dels("{{a::b}}"), [{ start: 0, end: 8, text: "{a::b}" }], "doubled braces: the :: is nested");
});

test("parse: a cue may hold math and images (they are part of the cue, as typed)", () => {
  assert.deepEqual(dels("{x::$\\frac{a}{b}$}"), [{ start: 0, end: 18, text: "x", cue: "$\\frac{a}{b}$" }]);
  assert.deepEqual(dels("{momentum::$p$, a vector}"), [{ start: 0, end: 25, text: "momentum", cue: "$p$, a vector" }]);
  assert.deepEqual(dels("{x::![img](att:1)}"), [{ start: 0, end: 18, text: "x", cue: "![img](att:1)" }]);
  assert.deepEqual(dels("{x::see {y}}"), [{ start: 0, end: 12, text: "x", cue: "see {y}" }], "nested braces in a cue are text");
});

test("parse: \\:: is a literal :: and never a separator", () => {
  assert.deepEqual(dels("{a\\::b}"), [{ start: 0, end: 7, text: "a\\::b" }]);
  assert.deepEqual(dels("{a\\::b::c}"), [{ start: 0, end: 10, text: "a\\::b", cue: "c" }]);
  assert.deepEqual(dels("{a::b\\::c}"), [{ start: 0, end: 10, text: "a", cue: "b\\::c" }], "an escaped one inside the cue");
  assert.deepEqual(dels("{a\\:::b}"), [{ start: 0, end: 8, text: "a\\:::b" }], "\\:: takes both colons; one colon is left");
  assert.deepEqual(dels("{a\\::::b}"), [{ start: 0, end: 9, text: "a\\::", cue: "b" }]);
  // an escaped backslash escapes nothing: the :: after it separates
  assert.deepEqual(dels("{a\\\\::b}"), [{ start: 0, end: 8, text: "a\\\\", cue: "b" }]);
  assert.deepEqual(dels("{a\\\\\\::b}"), [{ start: 0, end: 9, text: "a\\\\\\::b" }]);
  // a backslash before one colon is as it always was
  assert.deepEqual(dels("{a\\:b::c}"), [{ start: 0, end: 9, text: "a\\:b", cue: "c" }]);
});

test("parse: a blank hidden part or a blank cue means no cue, and the deletion is exactly as before", () => {
  for (const t of ["{a::}", "{a:: }", "{a::\n}", "{::b}", "{ ::b}", "{::}", "{ :: }", "{a::b::}", "{a::b:: }"]) {
    const d = dels(t);
    assert.deepEqual(d, [{ start: 0, end: t.length, text: t.slice(1, -1) }], t);
  }
  // the last :: decides alone: an earlier one is not tried
  assert.equal("cue" in dels("{a::b::}")[0], false);
  // blank braces are still no deletion
  assert.equal(P.parse("{} and { }").kind, "note");
});

test("parse: :: outside a deletion, in Q./A. prompts and in notes is plain text", () => {
  assert.deepEqual(dels("std::vector is a {template}"), [{ start: 17, end: 27, text: "template" }]);
  const qa = P.parse("Q. What does {a::b} mean?\nA. c::d");
  assert.equal(qa.kind, "qa");
  assert.deepEqual(qa.deletions, []);
  assert.equal(qa.question, "What does {a::b} mean?");
  assert.equal(qa.answer, "c::d");
  assert.equal(P.parse("a::b").kind, "note");
});

test("parse: several deletions each have their own cue; tags and batch blocks work as before", () => {
  const p = P.parse("{Bern::capital} lies on the {Aare::river}.\n#geo");
  assert.deepEqual(p.deletions, [{ start: 0, end: 15, text: "Bern", cue: "capital" }, { start: 28, end: 41, text: "Aare", cue: "river" }]);
  assert.deepEqual(p.tags, ["geo"]);
  const blocks = P.parseBatch("# Verbs\nDer Hund {bellt::verb} laut.\n\nQ. a\nA. b");
  assert.deepEqual(blocks.map((b) => [b.section, b.parsed.kind]), [["Verbs", "cloze"], ["Verbs", "qa"]]);
  assert.deepEqual(blocks[0].parsed.deletions, [{ start: 9, end: 22, text: "bellt", cue: "verb" }]);
  assert.equal(E.cardCount(p), 2, "a cue adds no card");
  assert.equal(E.statusLine(p), "Cloze · 2 cards");
});

// ------------------------------------------------------------------ reconcileCards

const NOW = 1700000000000;
function mkCard(i, extra) {
  return Object.assign({ i, createdAt: NOW - 10 * S.DAY, lastReviewedAt: NOW - 3 * S.DAY, intervalMs: 7 * S.DAY, dueAt: NOW + 4 * S.DAY,
    log: [{ at: NOW - 3 * S.DAY, outcome: "remembered", intervalMs: 7 * S.DAY, dueAt: NOW + 4 * S.DAY }] }, extra);
}
function reconcile(oldText, cards, newText) { return P.reconcileCards({ text: oldText, cards }, P.parse(newText), NOW); }

test("reconcileCards: adding, changing and removing a cue keeps the card and its schedule", () => {
  const cards = [mkCard(0, { intervalMs: 11 }), mkCard(1, { intervalMs: 22 })];
  const steps = [
    ["The {wave function} is {complex}.", "The {wave function::two words} is {complex}."],                    // added
    ["The {wave function::two words} is {complex}.", "The {wave function::a state} is {complex::not real}."],  // changed, another added
    ["The {wave function::a state} is {complex::not real}.", "The {wave function} is {complex}."],             // removed
    ["The {wave function} is {complex}.", "The { wave  function :: spaced } is {complex}."]                    // blanks around it
  ];
  for (const [from, to] of steps) {
    const r = reconcile(from, cards, to);
    assert.deepEqual(r.cards, cards, from + " → " + to);
    assert.deepEqual(r.dropped, [], from + " → " + to);
  }
  assert.deepEqual(cards.map((c) => c.i), [0, 1], "input cards are not mutated");
});

test("reconcileCards: two deletions that share a hidden part keep their order whatever their cues do", () => {
  const cards = [mkCard(0, { intervalMs: 1 }), mkCard(1, { intervalMs: 2 })];
  for (const [from, to] of [
    ["{a} and {a}", "{a::x} and {a::y}"],
    ["{a::x} and {a::y}", "{a::y} and {a::x}"],          // the cues swap: the cards do not
    ["{a::x} and {a::y}", "{a} and {a::z}"],
    ["{a::x} and {a::y}", "{a} and {a}"]
  ]) {
    const r = reconcile(from, cards, to);
    assert.deepEqual(r.cards.map((c) => [c.i, c.intervalMs]), [[0, 1], [1, 2]], from + " → " + to);
    assert.deepEqual(r.dropped, []);
  }
});

test("reconcileCards: identity is the hidden part alone, so cards follow it through a reorder and a cue never matches", () => {
  const cards = [mkCard(0, { intervalMs: 1 }), mkCard(1, { intervalMs: 2 })];
  const moved = reconcile("{Bern::capital} and {Aare::river}", cards, "{Aare::a river} and {Bern}");
  assert.deepEqual(moved.cards.map((c) => [c.i, c.intervalMs]), [[0, 2], [1, 1]]);
  assert.deepEqual(moved.dropped, []);
  // a new hidden part with an old cue is a new card on the old index, as an edit of the hidden text always was
  const edited = reconcile("{Bern::capital} and {Aare::river}", cards, "{Aare} and {Basel::capital} and {Thun}");
  assert.deepEqual(edited.cards.map((c) => [c.i, c.intervalMs]), [[0, 2], [1, S.FIRST], [2, S.FIRST]]);
  assert.deepEqual(edited.dropped, [cards[0]], "the card of Bern has no deletion any more");
  // a stored prompt that already held a top-level :: gains a cue (FEATURES P1.1 f): its card stays
  const legacy = reconcile("{10::30} o'clock", [mkCard(0, { intervalMs: 5 })], "{10::30} o'clock");
  assert.deepEqual(legacy.cards.map((c) => [c.i, c.intervalMs]), [[0, 5]]);
  assert.deepEqual(P.parse("{10::30} o'clock").deletions, [{ start: 0, end: 8, text: "10", cue: "30" }]);
});

// ------------------------------------------------------------------ render

const T2 = "The {wave function::two words} is {complex::not real}.";
const T1 = "The {wave function::two words} is {complex}.";

test("render with a mask: the asked blank keeps its width and shows the cue; revealed it shows the hidden part alone", () => {
  for (const mode of ["review", "preview", "card", "list"]) {
    assert.equal(mk.render(T2, { mode, mask: HIDE(0) }), "The " + blank("wave function") + cue("two words") + " is complex.", mode);
    assert.equal(mk.render(T2, { mode, mask: SHOW(0) }), "The " + reveal("wave function") + " is complex.", mode);
    assert.equal(mk.render(T2, { mode, mask: HIDE(1) }), "The wave function is " + blank("complex") + cue("not real") + ".", mode);
    assert.equal(mk.render(T2, { mode, mask: SHOW(1) }), "The wave function is " + reveal("complex") + ".", mode);
    // a blank without a cue is the blank it always was
    assert.equal(mk.render(T1, { mode, mask: HIDE(1) }), "The wave function is " + blank("complex") + ".", mode);
  }
  assert.match(blank("wave function"), /width:7\.2em" data-len="13"/, "the width comes from the hidden part, not from the cue");
  // every blank at once: each with its own cue
  assert.equal(mk.render(T2, { mode: "card", mask: { index: "all", reveal: false } }),
    "The " + blank("wave function") + cue("two words") + " is " + blank("complex") + cue("not real") + ".");
  assert.equal(mk.render(T2, { mode: "card", mask: { index: "all", reveal: true } }),
    "The " + reveal("wave function") + " is " + reveal("complex") + ".");
  // an index beyond the deletions masks nothing: hidden parts only, no cue, no braces
  assert.equal(mk.render(T2, { mode: "review", mask: HIDE(5) }), "The wave function is complex.");
});

test("render without a mask: the reading surfaces mark the hidden part and show the cue; review keeps the text as typed", () => {
  const want = "The " + mark("wave function") + cue("two words") + " is " + mark("complex") + ".";
  assert.equal(mk.render(T1), want, "card is the default mode");
  for (const mode of ["card", "list", "preview"]) assert.equal(mk.render(T1, { mode, mask: null }), want, mode);
  assert.equal(mk.render(T1, { mode: "review", cloze: true }), want, "cloze: true asks for the marks in any mode");
  assert.equal(mk.render(T1, { mode: "review" }), T1, "review without a mask: as typed");
  assert.equal(mk.render(T1, { mode: "review", mask: null }), T1);
  for (const mode of ["card", "list", "preview"]) assert.equal(mk.render(T1, { mode, cloze: false }), T1, mode + " with cloze: false");
});

test("render: a cue renders like other prompt text (math, images, escaped HTML, line breaks)", () => {
  assert.equal(mk.render("{x::$\\frac{a}{b}$ of it}", { mask: HIDE(0), mode: "review" }), blank("x") + cue(tex("\\frac{a}{b}") + " of it"));
  assert.equal(mk.render("{x::$\\frac{a}{b}$}"), mark("x") + cue(tex("\\frac{a}{b}")));
  assert.equal(mk.render("{x::<b>bold</b> & \"q\" 'r'}"), mark("x") + cue("&lt;b&gt;bold&lt;/b&gt; &amp; &quot;q&quot; &#39;r&#39;"));
  assert.equal(mk.render("{x::<img src=x onerror=alert(1)>}", { mask: HIDE(0) }), blank("x") + cue("&lt;img src=x onerror=alert(1)&gt;"));
  assert.equal(mk.render("{x::![img](att:a_1)}", { imageUrl: { a_1: "blob:1" } }), mark("x") + cue('<img class="att" src="blob:1" alt="snip">'));
  assert.equal(mk.render("{x::a\nb}", { mode: "card" }), mark("x") + cue("a<br>b"));
  assert.equal(mk.render("{x::a\nb}", { mode: "list" }), mark("x") + cue("a b"), "a list row stays on one line");
  assert.equal(mk.render("{x::see {y}}"), mark("x") + cue("see {y}"));
});

test("render: math and images in the hidden part still render; a hidden one is never rendered", () => {
  const calls = [];
  globalThis.katex = { renderToString(src) { calls.push(src); return "<k>" + src + "</k>"; } };
  try {
    assert.equal(mk.render("{$|\\psi\\rangle$::state} of $H$", { mode: "review", mask: HIDE(0) }),
      blank("$|\\psi\\rangle$") + cue("state") + " of <k>H</k>");
    assert.deepEqual(calls, ["H"], "the hidden formula is not rendered");
    assert.equal(mk.render("{$|\\psi\\rangle$::state}", { mode: "review", mask: SHOW(0) }), reveal("<k>|\\psi\\rangle</k>"));
    assert.equal(mk.render("{$a::b$::a ratio}"), mark("<k>a::b</k>") + cue("a ratio"), "a :: inside the hidden formula stays in it");
  } finally { delete globalThis.katex; }
  assert.equal(mk.render("{![img](att:a_1)::picture}", { imageUrl: { a_1: "blob:1" } }),
    mark('<img class="att" src="blob:1" alt="snip">') + cue("picture"));
});

test("render: blanks around the separator are dropped; blanks at the start of the hidden part stay as they did", () => {
  assert.equal(mk.render("a { x  ::  the cue  } b"), "a " + mark(" x") + cue("the cue") + " b");
  assert.equal(mk.render("a { x  ::  the cue  } b", { mask: SHOW(0) }), "a " + reveal(" x") + " b");
  assert.equal(mk.render("a { x  ::  the cue  } b", { mask: HIDE(1) }), "a  x b", "another card's blank: the hidden part only");
  assert.equal(mk.render("a { x } b"), "a " + mark(" x ") + " b", "without a cue: as before");
});

test("render: \\:: shows as :: wherever \\{ shows as {, and stays as typed where \\{ does", () => {
  const t = "\\{a\\} b\\::c {d\\::e::f\\::g}";
  assert.equal(mk.render(t), "{a} b::c " + mark("d::e") + cue("f::g"));
  assert.equal(mk.render(t, { mode: "list" }), "{a} b::c " + mark("d::e") + cue("f::g"));
  assert.equal(mk.render(t, { mode: "review", mask: HIDE(0) }), "{a} b::c " + blank("d\\::e") + cue("f::g"));
  assert.equal(mk.render(t, { mode: "review", mask: SHOW(0) }), "{a} b::c " + reveal("d::e"));
  assert.equal(mk.render(t, { mode: "review" }), t, "review without a mask keeps \\{ and \\:: as typed");
  assert.equal(mk.render(t, { mode: "card", cloze: false }), t, "and so does cloze: false (Q./A. cards in the margin)");
  // more than two colons, and an escaped backslash
  assert.equal(mk.render("{a\\:::b}"), mark("a:::b"));
  assert.equal(mk.render("{a\\::\\::b}"), mark("a::::b"));
  assert.equal(mk.render("{a\\\\::b}"), mark("a\\\\") + cue("b"), "\\\\ is a backslash, the :: after it separates");
  assert.equal(mk.render("x\\\\\\::y {z}"), "x\\\\::y " + mark("z"));
  // a lone \: is not touched
  assert.equal(mk.render("a\\:b {c}"), "a\\:b " + mark("c"));
});

test("render: a deletion without a cue that holds a :: shows it as typed", () => {
  assert.equal(mk.render("{a::}"), mark("a::"));
  assert.equal(mk.render("{::b}", { mask: SHOW(0) }), reveal("::b"));
  assert.equal(mk.render("{a:: }", { mask: HIDE(0) }), blank("a:: "));
  assert.equal(mk.render("{x {y::z} w}"), mark("x {y::z} w"));
  assert.equal(mk.render("{$a::b$}"), mark(tex("a::b")));
});

test("render: cues in Q./A. text follow the surface's brace rule (marks in lists and previews, as typed in margin cards)", () => {
  assert.equal(mk.render("What does {a::b} mean?", { mode: "list" }), "What does " + mark("a") + cue("b") + " mean?");
  assert.equal(mk.render("What does {a::b} mean?", { mode: "card", cloze: false }), "What does {a::b} mean?");
  assert.equal(mk.render("What does {a::b} mean?", { mode: "review" }), "What does {a::b} mean?");
});

// ------------------------------------------------------------------ exports

const BOOK = { id: "book1", kind: "book", name: "Griffiths", addedAt: 1 };
function promptOf(text) {
  return { id: "p1", collectionId: "book1", kind: P.parse(text).kind, text, tags: [], flagged: false, anchor: { pageIndex: 11, y: 500, quote: "" },
    context: { docName: "Griffiths", sectionLabel: null, pageIndex: 11, pageLabel: "12" }, cards: [], createdAt: 5, contentUpdatedAt: 5, updatedAt: 5, deletedAt: null, v: 1 };
}
function ankiField(text) {
  const lines = X.toAnkiTSV({ collections: [BOOK], prompts: [promptOf(text)], attachments: [] }).split("\n");
  assert.equal(lines.length, 7, "five directives, one row, the final newline");
  const row = lines[5].split("\t");
  assert.equal(row[0], "Cloze");
  return row[2];
}
// What Anki makes of a cloze field: inside {{cN:: … }} the text up to the first "::" is hidden, the rest is the hint.
function ankiReads(field) {
  const out = [], re = /\{\{c(\d+)::([\s\S]*?)\}\}/g;
  const decode = (s) => s.replace(/&#58;/g, ":");
  let m;
  while ((m = re.exec(field))) {
    const at = m[2].indexOf("::");
    out.push(at < 0 ? { n: Number(m[1]), hidden: decode(m[2]) } : { n: Number(m[1]), hidden: decode(m[2].slice(0, at)), hint: decode(m[2].slice(at + 2)) });
  }
  return out;
}

test("plain(), toMarkdown() and toAnki() keep a cue as typed", () => {
  for (const t of [T2, "{a\\::b::c}", "{x::$y$} ![snip](att:gone)", "{ x :: cue }\n#tag"]) {
    assert.equal(mk.plain(t), t.replace("![snip](att:gone)", "[image]"));
    assert.equal(mk.toMarkdown(t, null), t);
  }
  assert.equal(mk.toAnki("{x::cue} and {a\\::b}", null), "{x::cue} and {a\\::b}");
});

test("toObsidian: {x::cue} becomes ==x== and the cue is dropped", () => {
  assert.equal(mk.toObsidian(T2), "The ==wave function== is ==complex==.");
  assert.equal(mk.toObsidian("a { x  ::  the cue  } b"), "a  ==x== b", "leading blanks move outside as before; the ones at the separator go with it");
  assert.equal(mk.toObsidian("{$|\\psi\\rangle$::state} and {\\(a\\)::b}"), "==$|\\psi\\rangle$== and ==$a$==");
  assert.equal(mk.toObsidian("{![snip](att:a_1)::picture}", { images: true }), "==![[marginalia-a_1.png]]==");
  assert.equal(mk.toObsidian("{a::b::c}"), "==a::b==");
  assert.equal(mk.toObsidian("{a\\::b::c} and {d\\::e}"), "==a\\::b== and ==d\\::e==", "\\:: stays as typed, as \\{ does");
  assert.equal(mk.toObsidian("{x::cue}\n#tag"), "==x==\n#tag");
  // no cue: as before
  assert.equal(mk.toObsidian("{a::} {::b} {$a::b$}"), "==a::== ==::b== ==$a::b$==");
  // Q./A. text and notes are not cloze text: nothing is dropped
  assert.equal(mk.toObsidian("Q. What does {a::b} mean?\nA. c"), "Q. What does {a::b} mean?\nA. c");
  assert.equal(mk.toObsidian("a::b"), "a::b");
  // a cue is dropped only where parse reports one for those braces. After a doubled backslash the two scans read
  // the braces differently (known before cues): parse finds no cue here, so the note text stays what it was
  assert.deepEqual(dels("{a\\\\}::b}"), [{ start: 0, end: 5, text: "a\\\\" }]);
  assert.equal(mk.toObsidian("{a\\\\}::b}"), "==a\\\\}::b==");
});

test("Anki row: {x::cue} becomes {{cN::x::cue}}, numbered by deletion", () => {
  assert.equal(ankiField(T2), "The {{c1::wave function::two words}} is {{c2::complex::not real}}.");
  assert.equal(ankiField(T1), "The {{c1::wave function::two words}} is {{c2::complex}}.");
  assert.equal(ankiField("a { x  ::  the cue  } b"), "a {{c1:: x::the cue}} b", "the blanks at the separator are dropped");
  assert.equal(ankiField("{$|\\psi\\rangle$::state}"), "{{c1::\\(|\\psi\\rangle\\)::state}}");
  assert.equal(ankiField("{x::$\\frac{a}{b}$ & <b>}"), "{{c1::x::\\(\\frac{a}{b}\\) &amp; &lt;b&gt;}}");
  assert.equal(ankiField("{x::cue}\n#tag"), "{{c1::x::cue}}", "the tags line is not part of the text");
  assert.deepEqual(ankiReads(ankiField(T2)), [{ n: 1, hidden: "wave function", hint: "two words" }, { n: 2, hidden: "complex", hint: "not real" }]);
});

test("Anki row: a :: that belongs to the hidden part never reaches Anki as its separator (second colon written &#58;)", () => {
  assert.equal(ankiField("{a\\::b}"), "{{c1::a\\:&#58;b}}", "a typed \\:: in a deletion without a cue");
  assert.equal(ankiField("{a\\::b::c}"), "{{c1::a\\:&#58;b::c}}");
  assert.equal(ankiField("{a::b::c}"), "{{c1::a:&#58;b::c}}", "an earlier :: is part of the hidden text");
  assert.equal(ankiField("{a:::b}"), "{{c1::a&#58;::b}}", "a hidden part that ends in a colon");
  assert.equal(ankiField("{a::::b}"), "{{c1::a:&#58;::b}}");
  assert.equal(ankiField("{$a::b$::ratio}"), "{{c1::\\(a:&#58;b\\)::ratio}}", "also inside the hidden formula");
  assert.equal(ankiField("{x {y::z} w::cue}"), "{{c1::x {y:&#58;z} w::cue}}");
  assert.equal(ankiField("{a::b\\::c}"), "{{c1::a::b\\::c}}", "the cue needs no guard: Anki splits at the first :: only");
  for (const [text, hidden, hint] of [["{a::b::c}", "a::b", "c"], ["{a:::b}", "a:", "b"], ["{a::::b}", "a::", "b"], ["{a\\::b::c}", "a\\::b", "c"],
    ["{a\\::b}", "a\\::b", undefined], ["{x {y::z} w::cue}", "x {y::z} w", "cue"], ["{a::b\\::c}", "a", "b\\::c"]]) {
    const want = hint === undefined ? [{ n: 1, hidden }] : [{ n: 1, hidden, hint }];
    assert.deepEqual(ankiReads(ankiField(text)), want, text);
  }
  // the marker never leaks, also when the text already holds private-use characters
  const odd = ankiField("\uE000\uE001 {a::b::c}");
  assert.equal(odd, "\uE000\uE001 {{c1::a:&#58;b::c}}");
  assert.ok(!/[\uE002-\uF8FF]/.test(ankiField("{a::b::c} \uE000")));
});

test("Anki row: what Anki reads is what Marginalia shows, on 3000 seeded random deletions with a cue", () => {
  const rnd = mulberry32(58);
  const BITS = ["a", "b", ":", ":", "::", "::", "\\::", " ", "c d", "\\\\", "e"];
  let withCue = 0;
  for (let i = 0; i < 3000; i++) {
    let inner = "";
    for (let k = 1 + Math.floor(rnd() * 7); k > 0; k--) inner += BITS[Math.floor(rnd() * BITS.length)];
    const text = "x {" + inner + "} y";
    const d = dels(text);
    if (d.length !== 1) continue;
    const read = ankiReads(ankiField(text));
    assert.equal(read.length, 1, text);
    if (typeof d[0].cue !== "string") continue;
    withCue++;
    assert.deepEqual(read[0], { n: 1, hidden: d[0].text.replace(/\s+$/, ""), hint: d[0].cue }, text);
  }
  assert.ok(withCue > 500, "enough of them had a cue (" + withCue + ")");
});

test("numberClozes: the deletions of M.prompts.parse carry the cue; without a marker nothing is guarded", () => {
  const t = "The {a::b::c} and {d}";
  assert.equal(X.numberClozes(t, dels(t)), "The {{c1::a::b::c}} and {{c2::d}}");
  assert.equal(X.numberClozes(t, dels(t), "#"), "The {{c1::a:#b::c}} and {{c2::d}}");
  assert.equal(X.numberClozes("{a\\::b}", dels("{a\\::b}"), "#"), "{{c1::a\\:#b}}");
  // the fallback scanner (used when M.prompts is missing) follows the same cue rule
  assert.deepEqual(X.scanDeletions("{a::b::c} {d\\::e} {$f::g$} {h {i::j} k} {l::}"),
    [{ start: 0, end: 9, text: "a::b", cue: "c" }, { start: 10, end: 17, text: "d\\::e" }, { start: 18, end: 26, text: "$f::g$" },
      { start: 27, end: 39, text: "h {i::j} k" }, { start: 40, end: 45, text: "l::" }]);
  for (const t2 of [T2, "{a::b::c}", "{a\\::b::c}", "{ x :: y }", "{$a::b$::c} {![s](att:i)::d}", "{a::} {::b}"]) {
    assert.deepEqual(X.scanDeletions(t2), dels(t2), t2);
  }
});

test("the Markdown export and the JSON backup keep a cue as typed", () => {
  const p = promptOf("The {wave function::two words} is {complex}.\n#qm");
  const md = X.toMarkdown({ collections: [BOOK], prompts: [p], attachments: [] });
  assert.equal(md, "# Griffiths\n\nThe {wave function::two words} is {complex}.\n#qm\n\n*(p. 12)*\n");
  const backup = JSON.parse(X.toJSON({ collections: [BOOK], prompts: [p], attachments: [], settings: {}, folders: [], now: 7 }));
  assert.equal(backup.version, 1, "no format change");
  assert.deepEqual(backup.prompts, [p], "the record is stored as it is: no new field");
});

// ------------------------------------------------------------------ the cloze commands

test("escapeCues writes every unescaped :: of the text runs in a range as \\::", () => {
  const esc = (t, a, b) => P.escapeCues(t, a, b);
  assert.equal(esc("a::b"), "a\\::b");
  assert.equal(esc("a::b::c"), "a\\::b\\::c");
  assert.equal(esc("a:::b"), "a\\:::b", "three colons: one pair, one colon");
  assert.equal(esc("a::::b"), "a\\::\\::b");
  assert.equal(esc("a\\::b"), "a\\::b", "already escaped: unchanged");
  assert.equal(esc("a\\\\::b"), "a\\\\\\::b", "after an escaped backslash it is not escaped yet");
  assert.equal(esc("a:b c"), "a:b c");
  assert.equal(esc("$a::b$ c::d \\(e::f\\) ![g::h](att:i1) $$j::k$$"), "$a::b$ c\\::d \\(e::f\\) ![g::h](att:i1) $$j::k$$", "math and images are left alone");
  assert.equal(esc("a::b {c::d} e::f", 5, 11), "a::b {c\\::d} e::f", "only inside the range");
  assert.equal(esc("{a::b}", 1, 5), "{a\\::b}");
  assert.equal(esc(""), "");
  assert.equal(esc(null), "");
  // whatever was wrapped, no deletion has a cue afterwards
  for (const sel of ["a::b", "a:::b", "a::::b", "::", ":::", "x::", "::y", "a\\::b::c", "a\\\\::b", "\\", "a::b $c::d$ e::f", "{n::m}", "a :: b"]) {
    const wrapped = "see {" + sel + "} here", out = P.escapeCues(wrapped, 5, 5 + sel.length);
    for (const d of dels(out)) assert.equal("cue" in d, false, JSON.stringify(sel) + " → " + JSON.stringify(out));
  }
});

function makeIndex(lines) {
  const items = [], starts = [];
  let text = "";
  lines.forEach((str, k) => {
    starts.push(text.length);
    items.push({ str, x: 72, y: 700 - 14 * k, width: 6 * str.length, height: 12, hasEOL: true, divIndex: k });
    text += str + "\n";
    if (k < lines.length - 1) text += " ";
  });
  return { text, starts, items };
}
const stored = (quote, prefix) => ({ pageIndex: 0, pages: [], quote, prefix: prefix || "", suffix: "", items: null, y: 0, lost: false });

test("C in the reader: sentenceAround escapes a :: of the selection it wraps, and only there", () => {
  const idx = makeIndex(["Use std::map here. The ratio a::b of the", "std::vector sizes is fixed. Next."]);
  assert.equal(A.sentenceAround(stored("ratio a::b of", "The "), idx), "The {ratio a\\::b of} the std::vector sizes is fixed.");
  assert.equal(A.sentenceAround(stored("std::map", "Use "), idx), "Use {std\\::map} here.");
  assert.deepEqual(dels(A.sentenceAround(stored("ratio a::b of", "The "), idx)), [{ start: 4, end: 20, text: "ratio a\\::b of" }], "one deletion, no cue");
  assert.equal(mk.render(A.sentenceAround(stored("std::map", "Use "), idx)), "Use " + mark("std::map") + " here.", "and it reads as it did in the book");
  // the fallback when the passage is not found: the braced quote, escaped the same way
  assert.equal(A.sentenceAround(stored("nowhere  a::b", ""), idx), "{nowhere a\\::b}");
  assert.equal(A.sentenceAround(stored("x:::y", ""), null), "{x\\:::y}");
  // a selection without :: is wrapped exactly as before
  assert.equal(A.sentenceAround(stored("vector sizes", "std::"), idx), "The ratio a::b of the std::{vector sizes} is fixed.");
});

test("Alt+Shift+C in the editor: wrapBraces escapes a :: of the selection it wraps and keeps the wrapped text selected", () => {
  assert.deepEqual(E.wrapBraces("see a::b here", 4, 8), { text: "see {a\\::b} here", start: 5, end: 10 });
  assert.deepEqual(E.wrapBraces("a::b c::d e::f", 5, 9), { text: "a::b {c\\::d} e::f", start: 6, end: 11 }, "only the wrapped part");
  assert.deepEqual(E.wrapBraces("x a::b::c:::d y", 2, 13), { text: "x {a\\::b\\::c\\:::d} y", start: 3, end: 17 });
  assert.deepEqual(E.wrapBraces("the $a::b$ ratio", 4, 10), { text: "the {$a::b$} ratio", start: 5, end: 11 }, "a formula is left alone");
  assert.deepEqual(E.wrapBraces("a\\::b", 0, 5), { text: "{a\\::b}", start: 1, end: 6 }, "already escaped");
  // the old vectors (test/marginui.test.js) are unchanged
  assert.deepEqual(E.wrapBraces("the wave function", 4, 8), { text: "the {wave} function", start: 5, end: 9 });
  assert.deepEqual(E.wrapBraces("ab", 1, 1), { text: "a{}b", start: 2, end: 2 });
  assert.deepEqual(E.wrapBraces("ab", 5, 9), { text: "ab{}", start: 3, end: 3 });
  // wrapping twice does not escape twice
  const once = E.wrapBraces("see a::b here", 4, 8), twice = E.wrapBraces(once.text, once.start, once.end);
  assert.deepEqual(twice, { text: "see {{a\\::b}} here", start: 6, end: 11 });
  for (const r of [once, twice]) for (const d of dels(r.text)) assert.equal("cue" in d, false);
});

// ------------------------------------------------------------------ the two scanners agree

function mulberry32(a) {
  return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
// What render() masks: one {len, cue} per blank, from the HTML of "every blank hidden".
function masked(text) {
  const html = mk.render(text, { mode: "review", mask: { index: "all", reveal: false } });
  const re = /<span class="cloze-blank" style="display:inline-block;width:[0-9.]+em" data-len="(\d+)"><\/span>( <span class="cloze-cue">\()?/g;
  const out = [];
  let m;
  while ((m = re.exec(html))) out.push({ len: Number(m[1]), cue: !!m[2] });
  return out;
}
const expected = (text) => {
  const p = P.parse(text);
  return (p.kind === "cloze" ? p.deletions : []).map((d) => ({ len: d.text.replace(/\s+/g, " ").trim().length, cue: typeof d.cue === "string" }));
};

test("parse and render scan the same deletions and the same cues", () => {
  for (const t of [T1, T2, "{a::b::c}", "{a:::b}", "{a\\::b}", "{a\\::b::c}", "{a\\\\::b}", "{a\\\\\\::b}", "{a:: }", "{::b}", "{::}", "{a::b::}",
    "{$a::b$}", "{$a::b$::c}", "{![a::b](att:i1)::c}", "{x {y::z} w::cue}", "{x {y::z} w}", "{{a::b}}", "{a::b}}", "\\{a::b\\} {c::d}",
    "{a::b} and {c} and {d::e}", "{ x :: y }", "{x::$\\frac{a}{b}$}", "{a\n::\nb}", "{a::b", "a::b}", "$${a::b}$$ {c::d}", "\\{{a::b}"]) {
    assert.deepEqual(masked(t), expected(t), t);
  }
});

test("parse and render agree on 20 000 seeded random texts", () => {
  const rnd = mulberry32(20261111);
  const BITS = ["{", "}", "{", "}", "::", "::", ":", "\\", " ", "a", "b", "$", "x", "$y::z$", "![s](att:i1)", "\\::", "\\{", "\\}", "\\\\", "\n", "c"];
  // Known before this feature and unchanged by it: a brace after an even number (2, 4, …) of backslashes is a
  // brace for parse and a literal for render. Such texts are left out.
  const EVEN_BACKSLASHES_BRACE = /(^|[^\\])(\\\\)+[{}]/;
  const INNER = ["a", "b", " ", "c", ":", "::", "\\::", "\\", "$y::z$", "![s](att:i1)", "{", "}", "\n"];
  const some = (from, max) => { let out = ""; for (let k = Math.floor(rnd() * (max + 1)); k > 0; k--) out += from[Math.floor(rnd() * from.length)]; return out; };
  let checked = 0, cues = 0;
  for (let i = 0; i < 20000; i++) {
    // random text, and in half of the cases a brace pair with a "::" in it somewhere inside
    let t = some(BITS, 8);
    if (rnd() < 0.5) t += "{" + some(INNER, 4) + "::" + some(INNER, 4) + "}" + some(BITS, 6);
    if (!t || EVEN_BACKSLASHES_BRACE.test(t) || /^\s*Q\./m.test(t)) continue;
    const want = expected(t);
    assert.deepEqual(masked(P.parse(t).display), want, JSON.stringify(t));
    checked++;
    if (want.some((d) => d.cue)) cues++;
  }
  assert.ok(checked > 15000 && cues > 1000, "enough texts (" + checked + ") and enough cues (" + cues + ")");
});

// ------------------------------------------------------------------ nothing else changed

// <golden> (tools used to write test/cues-golden.json read this block: keep it self-contained)
const GOLDEN_TEXTS = [
  // test/markup.test.js
  "a $x$ b", "$$E=mc^2$$", "p \\(y\\) q", "\\[z\\]", "before\n$$\na = b\n$$\nafter", "costs \\$5 and \\$6", "costs $5 and $6", "\\$x\\$",
  "$a\nb$", "$a$\n$b$", "$ x$", "$x $", "<b>&\"'\nx", "a\nb", "The wave.\n#qm #cs-2", "# Section\nbody", "#qm", "see #qm here",
  "see ![snip](att:a_1) here", "![snip](att:a_2)", "The {wave function} $\\Psi$ solves {the $E$ equation}.", "a \\{b\\} {c}",
  "Der Hund {bellt} laut.", "{a} und {b}", "{a {b} c} d", "{} {x}", "$\\frac{a}{b}$ is {x}", "see ![snip](att:a_1) {here}", "no braces at all",
  "<b>{x}</b>", "a\n{b}", "x {y}", "{x} and {y}", "x {ab} y", "{a {b} c} {d}", "{x} {y}",
  "E: $$E=mc^2$$ and $x<y$, \\(y\\), \\[z\\]\nnext\tline ![snip](att:a_1) \\$5 $7 and $8", "<b>\t&\n#tag", "![snip](att:nope)", "$$a\nb$$",
  "{x} and {{c1::y}}", "a\n$$b\nc$$\nd", "Q. $x$ and $$y$$ ![snip](att:a_1)\nA. \\(z\\)\n#t", "see ![snip](att:gone)", "plain", "a $x$ ![snip](att:a_1)",
  // test/obsidian.test.js
  "Q. What is $x$?\nA. \\( y \\)\n#qm #physics", "The {wave function} $\\Psi(x,t)$ solves {the $x^2$ term}.", "$\\frac{a}{b}$ is {half}", "a { b } c",
  "Q. Why {x}?\nA. y", "Q. only a question {x}", "\\[ E = mc^2 \\] and \\(a\\)", "$$\\int f$$ costs \\$5 and $x$", "not math: \\\\[x\\\\]",
  "Q. ![snip](att:a_1)\nA. see", "",
  // test/exporter.test.js
  "The {wave function} $\\Psi(x,t)$ solves the {Schrödinger equation}.\n#qm",
  "Set $\\frac{a}{b}$ then \\{literal\\} and {x = $\\sqrt{2}$ here} and {second}", "Q. What does V stand for?\nA. The potential energy ![snip](att:a_1)\n#qm #ch1",
  "$\\frac{a}{b}$ \\{x\\} {y $z$} {w}", "Q. Is a<b> & c\ttab?\nA. line one\nline two\n#t1", "Remember: <b>normalisation</b> fixes A & phase",
  // test/prompts.test.js
  "The {wave function} solves it.", "The {wave function} $\\Psi(x,t)$ solves the {Schrödinger equation} in {QM}.", "{a} and {b}", "Compute $\\frac{a}{b}$ now",
  "$$\\frac{a}{b}$$ and \\(\\sqrt{x}\\) and \\[\\{x\\}\\]", "{Euler} wrote $e^{i\\pi}$ first", "{the $x$ value} is here", "energy {$E = mc^2$} holds",
  "{open $\\frac{a}{b}$ never", "a \\{b\\} c", "x \\\\{y}", "{} and { }", "{x}} }", "The {wave function} solves it.\n#qm", "{ c } then {a}", "{wave\nfunction}",
  "Q. What does V stand for?\nA. The potential\nenergy function\n\nover two paragraphs", "Q. State the\nSchrödinger equation {in words}\nA. $i\\hbar\\partial_t\\Psi = H\\Psi$",
  "Q. What is this?", "just a thought\nover two lines", "Der Hund {bellt} laut.\n#de", "A {b}. C {d}. E {f}.",
  // a "::" that is no cue: outside a deletion, in math, in an image token, in nested braces, with a blank part, in Q./A. text
  "std::vector is a {template}", "the ratio a::b and {c}", "{$a::b$}", "{\\(a::b\\)} and {$$c::d$$}", "{![a::b](att:a_1)}", "{x {y::z} w}", "{{a::b}}",
  "{a::}", "{a:: }", "{::b}", "{ ::b}", "{::}", "{a::b::}", "{a::\n}", "Q. What does a::b mean?\nA. c::d", "Q. a::b?\nA. {c} :: d\n#t", "a::b", "10::30 and {x} at 11::45",
  "{a:b}", "{a : b} and {c:}", "a {b} :: c", "{a}::{b}"
];
function goldenOf(text, mods) {
  const parsed = mods.prompts.parse(text), R = (o) => mods.markup.render(text, o);
  const book = { id: "book1", kind: "book", name: "Griffiths", addedAt: 1 };
  const prompt = { id: "p1", collectionId: "book1", kind: parsed.kind, text, tags: parsed.tags, flagged: false, anchor: { pageIndex: 11, y: 500, quote: "the quote" },
    context: { docName: "Griffiths", sectionLabel: "Ch. 1", pageIndex: 11, pageLabel: "12" }, cards: [], createdAt: 5, contentUpdatedAt: 5, updatedAt: 5, deletedAt: null, v: 1 };
  const att = [{ id: "a_1", mime: "image/png", width: 1, height: 1, data: "iVBORw0KGgoAAAANSUhEUg==" }];
  const scope = { collections: [book], prompts: [prompt], attachments: att };
  return {
    kind: parsed.kind, deletions: parsed.deletions, question: parsed.question, answer: parsed.answer, body: parsed.body, display: parsed.display, tags: parsed.tags,
    card: R({}), list: R({ mode: "list" }), preview: R({ mode: "preview" }), review: R({ mode: "review" }),
    cardAsTyped: R({ mode: "card", cloze: false }), reviewMarks: R({ mode: "review", cloze: true }),
    hide0: R({ mode: "review", mask: { index: 0, reveal: false } }), show0: R({ mode: "review", mask: { index: 0, reveal: true } }),
    hide1: R({ mode: "preview", mask: { index: 1, reveal: false } }), show1: R({ mode: "card", mask: { index: 1, reveal: true } }),
    hideAll: R({ mode: "list", mask: { index: "all", reveal: false } }), showAll: R({ mode: "card", mask: { index: "all", reveal: true } }),
    withImage: R({ mode: "card", imageUrl: { a_1: "blob:1" } }),
    plain: mods.markup.plain(text), obsidian: mods.markup.toObsidian(text), obsidianImages: mods.markup.toObsidian(text, { images: true }),
    anki: mods.markup.toAnki(text, null), markdown: mods.markup.toMarkdown(text, null),
    ankiTSV: mods.exporter.toAnkiTSV(scope), ankiTSVNoImages: mods.exporter.toAnkiTSV(Object.assign({ includeImages: false }, scope)),
    markdownExport: mods.exporter.toMarkdown(scope),
    numbered: mods.exporter.numberClozes(text, parsed.deletions), fallbackScan: mods.exporter.scanDeletions(parsed.display)
  };
}
// </golden>

test("a text without a cue gives the bytes it gave before cues existed (parse, render, plain, Obsidian, Anki, Markdown)", () => {
  const golden = JSON.parse(fs.readFileSync(path.join(__dirname, "cues-golden.json"), "utf8"));
  assert.deepEqual(golden.vectors.map((v) => v.text), GOLDEN_TEXTS, "the golden file holds these texts, in this order");
  const mods = { prompts: P, markup: mk, exporter: X };
  let outputs = 0;
  for (const v of golden.vectors) {
    const now = JSON.parse(JSON.stringify(goldenOf(v.text, mods)));
    for (const key of Object.keys(v.out)) {
      assert.deepEqual(now[key], v.out[key], key + " of " + JSON.stringify(v.text));
      outputs++;
    }
    assert.deepEqual(Object.keys(now), Object.keys(v.out), "the same outputs, " + JSON.stringify(v.text));
    for (const d of now.deletions) assert.equal("cue" in d, false, "no cue in " + JSON.stringify(v.text));
  }
  assert.ok(golden.vectors.length >= 100 && outputs >= 2800, golden.vectors.length + " texts, " + outputs + " outputs compared");
});

test("a Q./A. prompt that holds {a::b}: parse and every export are as before; only the surfaces that mark braces show the cue", () => {
  const text = "Q. What does {a::b} mean?\nA. {c::d} here\n#qm";
  const p = P.parse(text);
  assert.equal(p.kind, "qa");
  assert.deepEqual(p.deletions, []);
  assert.deepEqual([p.question, p.answer], ["What does {a::b} mean?", "{c::d} here"]);
  assert.deepEqual(p.tags, ["qm"]);
  assert.equal(mk.plain(text), text);
  assert.equal(mk.toObsidian(text), text);
  assert.equal(mk.toMarkdown(text, null), text);
  const tsv = X.toAnkiTSV({ collections: [BOOK], prompts: [promptOf(text)], attachments: [] }).split("\n")[5].split("\t");
  assert.deepEqual(tsv, ["Basic", "Marginalia::Griffiths", "What does {a::b} mean?", "{c::d} here<br><br>Griffiths · p. 12", "marginalia griffiths qm"]);
  // the margin card (cloze: false) and the review card (mode review) show the text as typed, as before
  assert.equal(mk.render(p.question, { mode: "card", cloze: false }), "What does {a::b} mean?");
  assert.equal(mk.render(p.question, { mode: "review", mask: null }), "What does {a::b} mean?");
  // the prompt list and the editor preview marked {x} in Q./A. text before; a brace pair with a cue now shows it
  assert.equal(mk.render(p.question, { mode: "list", mask: null }), "What does " + mark("a") + cue("b") + " mean?");
  assert.equal(mk.render(p.answer, { mode: "preview", mask: null }), mark("c") + cue("d") + " here");
});

// ------------------------------------------------------------------ CSS

test(".cloze-cue is quiet and reads in both themes: one rule, the secondary text colour, in the stylesheet that owns .cloze-blank", () => {
  const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");
  const shared = strip(fs.readFileSync(path.join(ROOT, "styles.css"), "utf8"));
  assert.match(shared, /(^|\n)\.cloze-blank \{/, "styles.css owns the shared .cloze-blank");
  const rule = /(^|\n)\.cloze-cue \{([^}]*)\}/.exec(shared);
  assert.ok(rule, "styles.css has the .cloze-cue rule");
  assert.equal(rule[2].trim(), "color: var(--ink-2);", "the colour only: the font size is the surrounding text's");
  // no other stylesheet refines it, so the cue looks the same on every surface
  for (const file of fs.readdirSync(path.join(ROOT, "css"))) {
    assert.ok(!strip(fs.readFileSync(path.join(ROOT, "css", file), "utf8")).includes("cloze-cue"), "css/" + file + " has no .cloze-cue rule");
  }
  assert.equal((shared.match(/\.cloze-cue/g) || []).length, 1);
  // the three token blocks: light, the system's dark, the chosen dark. In each, --ink-2 against the surfaces a cue
  // sits on (the margin's --bg, the list's and the editor's --surface, the review overlay's --review-bg) has a
  // contrast of at least 4.5 to 1 (WCAG AA for body text)
  const blocks = shared.match(/--bg:[^}]*--ink-2:[^}]*--review-bg:[^}]*/g) || [];
  assert.equal(blocks.length, 3, "light, prefers-color-scheme dark, data-theme dark");
  const lum = (hex) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const contrast = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
  blocks.forEach((block, i) => {
    const token = (name) => { const m = new RegExp("--" + name + ":\\s*(#[0-9a-f]{6})\\b", "i").exec(block); assert.ok(m, "--" + name + " in block " + i); return m[1]; };
    for (const surface of ["bg", "surface", "review-bg"]) {
      const ratio = contrast(token("ink-2"), token(surface));
      assert.ok(ratio >= 4.5, "block " + i + ": --ink-2 on --" + surface + " is " + ratio.toFixed(2) + " to 1");
    }
  });
});
