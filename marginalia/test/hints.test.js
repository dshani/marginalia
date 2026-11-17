"use strict";
// test/hints.test.js — FEATURES P1.2, more writing hints in M.prompts.lint:
//  - yes_no (wider): more question-start words, and an answer that is just yes / no / true / false;
//  - either_or: the question offers the answer as one of its choices;
//  - list_answer: the answer is a list of three or more items;
//  - long_cloze: a cloze body of more than 30 words (cues not counted, never together with multi_sentence_cloze);
//  - the order, worst first, and the older hints unchanged.
// Run: node --test test/hints.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const JS = path.join(__dirname, "..", "js");
const P = require(path.join(JS, "prompts.js"));
const E = require(path.join(JS, "editor.js"));

const codes = (text) => P.parse(text).lints.map((l) => l.code);
const qa = (q, a) => "Q. " + q + "\nA. " + a;
const words = (n, w) => Array.from({ length: n }, (_, i) => (w || "w") + i).join(" ");

const YES_NO = { code: "yes_no", msg: "Yes/no questions are easy to guess — ask for the fact itself" };
const EITHER_OR = { code: "either_or", msg: "The question offers the answer as a choice — ask for the fact itself" };
const listMsg = (n) => ({ code: "list_answer", msg: "The answer is a list of " + n + " items — a whole list is hard to recall; make one {blank} per item" });
const longClozeMsg = (n) => ({ code: "long_cloze", msg: "Long cloze (" + n + " words) — keep only the words around the blank" });

// ------------------------------------------------------------------ yes_no

test("yes_no: the question-start words gain has, have, had, will, would, should, could, must", () => {
  for (const w of ["Has", "have", "Had", "will", "Would", "should", "Could", "must"]) {
    assert.deepEqual(P.parse(qa(w + " the field any sources there?", "Only at the origin")).lints, [YES_NO], w);
  }
  for (const w of ["Is", "are", "Do", "does", "can", "Did", "was", "were"]) {
    assert.deepEqual(codes(qa(w + " it conserved?", "Only without friction")), ["yes_no"], w + " (as before)");
  }
  assert.deepEqual(codes(qa("Would a heavier ball fall faster in a vacuum?", "It falls at the same rate")), ["yes_no"]);
  // whole words only, and only at the start of the question
  for (const q of ["Hash tables use which function?", "Hadrons are made of what?", "Haven for which particles?", "Willpower aside, what limits it?",
    "Shoulders carry which load?", "Mustard gas has which formula?", "Couldron shapes aside, what matters?", "What would a heavier ball do?", "Why must energy be conserved?"]) {
    assert.deepEqual(codes(qa(q, "something else")), [], q);
  }
});

test("yes_no: it also fires when the answer is just yes, no, true or false", () => {
  for (const a of ["Yes.", "yes", "No", "no.", "NO!", "True", "true.", "False", "FALSE!", "  yes  ", "Yes…", "No?!", "yes,", "true;"]) {
    assert.deepEqual(P.parse(qa("The ground state energy of the oscillator vanishes", a)).lints, [YES_NO], JSON.stringify(a));
  }
  assert.deepEqual(codes("Q. Light needs a medium\nA.\nNo.\n"), ["yes_no"], "the answer on its own line");
  // anything more than the bare word is an answer with content
  // ("Yes, because …" is a yes/no answer since FIXES-1 FIX-6 e: "yes" or "no" then a comma, a period or the end)
  assert.deepEqual(codes(qa("What about the ground state energy", "Yes, because the potential is symmetric")), ["yes_no"]);
  for (const a of ["No: it is half a quantum", "Not at all", "Yes and no", "Truly", "Nothing", "Falsehood", "yes no", "$yes$", "Noether"]) {
    assert.deepEqual(codes(qa("What about the ground state energy", a)), [], JSON.stringify(a));
  }
  // both halves at once: still one hint
  assert.deepEqual(P.parse(qa("Is it conserved?", "Yes.")).lints, [YES_NO]);
});

// ------------------------------------------------------------------ either_or

test("either_or: the answer stands in the question as one of its choices", () => {
  assert.deepEqual(P.parse(qa("Which is heavier, a proton or an electron?", "A proton")).lints, [EITHER_OR]);
  assert.deepEqual(codes(qa("Which is heavier, a proton or an electron?", "an electron.")), ["either_or"]);
  assert.deepEqual(codes(qa("Fermions or bosons: which obey the exclusion principle?", "Fermions!")), ["either_or"], "case and punctuation do not matter");
  assert.deepEqual(codes(qa("Which travels faster in glass:\nred light\nor blue light?", "Red   light")), ["either_or"], "nor do line breaks and blanks");
  assert.deepEqual(codes(qa("What is larger for $x > 1$: $x^2$ or $x$?", "$x^2$")), ["either_or"], "a formula is one word");
  assert.deepEqual(codes(qa("What is larger for $x > 1$: $x^2$ or $x$?", "$ x^2 $")), [], "(it is math only without the blanks inside the dollars)");
  assert.deepEqual(codes(qa("Which one: ![snip](att:a_1) or ![snip](att:a_2)?", "![snip](att:a_2)")), ["either_or"], "so is an image");
  assert.deepEqual(codes(qa("Which is the lepton: Newton's or Pauli's particle?", "Paulis particle")), ["either_or"], "apostrophes are dropped");
  assert.deepEqual(codes(qa("Which is it: spin-up or spin-down?", "spin down")), ["either_or"], "other punctuation reads as a blank");
});

test("either_or: a question with \"or\" whose answer is not one of its choices gives no hint", () => {
  assert.deepEqual(codes(qa("What is the unit of work or energy?", "the joule")), []);
  assert.deepEqual(codes(qa("Which is heavier, a proton or an electron?", "a neutron")), []);
  assert.deepEqual(codes(qa("Which is larger, $a$ or $b$?", "$c$")), [], "another formula is another word");
  assert.deepEqual(codes(qa("Which one: ![snip](att:a_1) or ![snip](att:a_2)?", "![snip](att:a_3)")), []);
  // whole words only
  assert.deepEqual(codes(qa("Which is used, a factor or a factorial?", "fact")), []);
  assert.deepEqual(codes(qa("Which is used, a factor or a factorial?", "a fact")), []);
  // the phrase must stand there in one piece, in order
  assert.deepEqual(codes(qa("Which is heavier, a proton or an electron?", "electron an")), []);
  assert.deepEqual(codes(qa("Which is heavier, a proton or an electron?", "a electron")), []);
});

test("either_or: it needs the word \"or\", a non-empty answer of at most 6 words, and never comes with yes_no", () => {
  assert.equal(P.EITHER_OR_WORDS, 6);
  assert.deepEqual(codes(qa("A proton and an electron: which is heavier?", "a proton")), [], "no \"or\"");
  assert.deepEqual(codes(qa("Which force acts for a proton at rest?", "a proton")), [], "\"or\" inside \"for\" and \"force\" is no word");
  assert.deepEqual(codes(qa("ORBITAL OR SPIN: which one is intrinsic?", "spin")), ["either_or"], "OR in capitals is the word");
  const six = "energy is conserved in closed systems", seven = "energy is always conserved in closed systems";
  assert.deepEqual(codes(qa("Which holds: " + six + " or momentum is?", six)), ["either_or"]);
  assert.deepEqual(codes(qa("Which holds: " + seven + " or momentum is?", seven)), []);
  assert.deepEqual(codes(qa("Which holds, A or B?", "")), ["empty_answer"]);
  assert.deepEqual(codes(qa("Which holds, A or B?", "…")), [], "an answer of punctuation only has no words");
  // FIXES-1 FIX-3: either_or before yes_no, also after a yes/no start word; a yes / no / true / false answer stays yes_no
  assert.deepEqual(P.parse(qa("Is light a wave or a particle?", "a wave")).lints, [EITHER_OR]);
  assert.deepEqual(P.parse(qa("Which is it, yes or no?", "Yes.")).lints, [YES_NO]);
  assert.deepEqual(P.parse(qa("Should we use a wave or a particle here?", "a particle")).lints, [EITHER_OR]);
});

// ------------------------------------------------------------------ list_answer

test("list_answer: three or more item lines are a list of that many items", () => {
  assert.deepEqual(P.parse(qa("Name the quarks of the first two generations", "up\ndown\ncharm\nstrange")).lints, [listMsg(4)]);
  assert.deepEqual(P.parse("Q. Name three leptons\nA.\nelectron\n\nmuon\n   \ntau\n").lints, [listMsg(3)], "blank lines do not count");
  assert.deepEqual(codes(qa("Name two leptons", "electron\nmuon")), [], "two lines are no list");
  assert.deepEqual(codes(qa("What does V stand for?", "The potential\nenergy function")), []);
  // a formula is one item however many lines it has
  assert.deepEqual(codes(qa("The wave equation?", "\n$$\n\\partial_t^2 u\n= c^2 \\partial_x^2 u\n$$\n")), []);
  assert.deepEqual(codes(qa("The wave equation?", "It reads\n$$\n\\partial_t^2 u\n= c^2 \\partial_x^2 u\n$$")), [], "a line of words and a formula: two");
  assert.deepEqual(P.parse(qa("Maxwell's equations in vacuum?", "$$\n\\nabla \\cdot E = 0\n$$\n$$\n\\nabla \\cdot B = 0\n$$\n\\[\n\\nabla \\times E = -\\partial_t B\n\\]")).lints, [listMsg(3)]);
});

test("list_answer: a sentence, a formula and a second sentence are no list; markers and an intro line", () => {
  // a formula between two lines of words: only the lines of words can be items, and two are no list
  assert.deepEqual(codes(qa("The Schrödinger equation?", "It reads\n$$i\\hbar\\partial_t\\Psi = H\\Psi$$\nfor every state")), []);
  assert.deepEqual(codes(qa("Newton's second law?", "$$F = ma$$\nF is the force\nm is the mass")), []);
  // an intro line that ends with a colon is no item; the three lines after it are
  assert.deepEqual(P.parse(qa("Stock aromatics?", "Aromatics:\nonion\ncarrots\ncelery")).lints, [listMsg(3)]);
  assert.deepEqual(codes(qa("Stock aromatics?", "Aromatics:\nonion\ncarrots")), []);
  // a line of more than 5 words is a sentence, not an item, unless it starts with a list marker
  assert.deepEqual(codes(qa("Why?", words(6, "a") + "\n" + words(6, "b") + "\n" + words(6, "c"))).filter((c) => c === "list_answer"), []);
  assert.deepEqual(P.parse(qa("The steps?", "- " + words(6, "a") + "\n- " + words(6, "b") + "\n- " + words(6, "c"))).lints.map((l) => l.code), ["list_answer", "long_answer"]);
  for (const marks of [["1. ", "2. ", "3. "], ["a) ", "b) ", "c) "], ["* ", "* ", "* "], ["• ", "• ", "• "]]) {
    assert.equal(P.parse(qa("The steps?", marks.map((m, i) => m + words(7, "s" + i)).join("\n"))).lints[0].code, "list_answer", marks[0]);
  }
  // a negative number or a dash without a space after it is no marker; the lines are short, so they are items anyway
  assert.deepEqual(codes(qa("Three values?", "-5 m/s\n-3 m/s\n-1 m/s")), ["list_answer"]);
  assert.deepEqual(codes(qa("Why?", "-" + words(7, "a") + "\n-" + words(7, "b") + "\n-" + words(7, "c"))).filter((c) => c === "list_answer"), []);
  // FIXES-1 FIX-6 c: with no sentence and no intro line, two or more formula lines count as items beside the lines of words
  assert.deepEqual(P.parse(qa("Three laws?", "$$a$$\n$$b$$\n$$c$$\nall hold")).lints, [listMsg(4)]);
});

test("list_answer: one line that splits into three or more parts at commas, semicolons, \" and \" or \" or \"", () => {
  assert.deepEqual(P.parse(qa("The primary colours of light?", "red, green and blue")).lints, [listMsg(3)]);
  assert.deepEqual(P.parse(qa("The primary colours of light?", "red, green, and blue")).lints, [listMsg(3)], "a comma before \"and\" adds no empty item");
  assert.deepEqual(P.parse(qa("The primary colours of light?", "Red; green; blue.")).lints, [listMsg(3)]);
  assert.deepEqual(P.parse(qa("Which may it be?", "up or down or strange or charm")).lints, [listMsg(4)]);
  assert.deepEqual(P.parse(qa("Name them", "electrons AND muons And taus")).lints, [listMsg(3)]);
  // four parts are a list whatever joins them (LIST_MANY_PARTS); three parts joined by commas alone, with a part of
  // more than two words, read as a sentence (FIXES-1 FIX-6 b)
  assert.deepEqual(P.parse(qa("The four forces?", "gravity, the weak force, the strong force, electromagnetism")).lints, [listMsg(4)]);
  assert.deepEqual(codes(qa("Three forces?", "gravity, the weak force, the strong force")), []);
  assert.deepEqual(P.parse(qa("The four forces?", "gravity, the weak force, the strong force and electromagnetism")).lints, [listMsg(4)]);
  assert.deepEqual(P.parse(qa("The conserved quantities?", "$E$, $\\vec{p}$ and $\\vec{L}$")).lints, [listMsg(3)], "formulas are items too");
  assert.deepEqual(P.parse(qa("Which figures?", "![snip](att:a_1), ![snip](att:a_2), ![snip](att:a_3)")).lints, [listMsg(3)]);
  assert.equal(P.LIST_MIN_ITEMS, 3);
});

test("list_answer: an answer of two items is no list, and math with commas is no list", () => {
  for (const a of ["red and blue", "red, blue", "red; blue", "red or blue", "red", "red,", ", red, ", "red and", "and red and"]) {
    assert.deepEqual(codes(qa("The colours?", a)), [], JSON.stringify(a));
  }
  assert.deepEqual(codes(qa("Which function?", "$f(x, y, z)$")), []);
  assert.deepEqual(codes(qa("Which function?", "the function $f(x, y, z)$ of three variables")), []);
  assert.deepEqual(codes(qa("Which set?", "\\(\\{a, b, c\\}\\) and \\[\\{d; e; f\\}\\]")), [], "two formulas: two items");
  assert.deepEqual(codes(qa("Which vector?", "$$(1, 0, 0)$$")), []);
  assert.deepEqual(codes(qa("Which states?", "$|a\\rangle \\text{ and } |b\\rangle \\text{ and } |c\\rangle$")), [], "\"and\" inside a formula splits nothing");
});

test("list_answer: every part of a one-line list has at most 5 words; digits keep their comma; words keep their \"and\"", () => {
  assert.equal(P.LIST_ITEM_WORDS, 5);
  assert.deepEqual(codes(qa("Why?", "energy is conserved in closed systems, momentum too, and so is charge")), [], "a first part of six words: a sentence, no list");
  assert.deepEqual(P.parse(qa("Why?", "energy is conserved in total, momentum too, and so is charge")).lints, [listMsg(3)], "five words: an item");
  assert.deepEqual(codes(qa("How far?", "about 1,000,000 km")), [], "a comma between two digits is no separator");
  assert.deepEqual(codes(qa("How far?", "1,5 and 2,5")), []);
  assert.deepEqual(P.parse(qa("Which years?", "1,905, 1,915 and 1,925")).lints, [listMsg(3)]);
  assert.deepEqual(P.parse(qa("Which values?", "1, 2, 3")).lints, [listMsg(3)]);
  assert.deepEqual(codes(qa("Which words?", "sand and android")), [], "\"and\" and \"or\" inside words split nothing");
  assert.deepEqual(codes(qa("Which words?", "candy/origin and floor")), []);
  // the one-line rule needs exactly one non-blank line
  assert.deepEqual(codes(qa("Which?", "red, green and blue\n(the additive primaries)")), []);
});

test("list_answer may come together with long_answer and with either_or", () => {
  const long = "the electron which is light, the muon which is heavier, the tau which is the heaviest of them all";
  assert.deepEqual(codes(qa("Name the charged leptons", long)), ["long_answer"], "parts of more than five words: only long");
  assert.deepEqual(codes(qa("Name them", words(5, "a") + "\n" + words(5, "b") + "\n" + words(5, "c") + "\n" + words(5, "d"))), ["list_answer", "long_answer"]);
  assert.deepEqual(codes(qa("Name them", "a b, c d, e f, g h, i j, k l, m n, o p")), ["list_answer", "long_answer"]);
  assert.deepEqual(codes(qa("Which three: up, down and strange or top?", "up, down and strange")), ["either_or", "list_answer"]);
  assert.deepEqual(codes(qa("Is it red, green or blue?", "red, green and blue")), ["yes_no", "list_answer"]);
});

// ------------------------------------------------------------------ long_cloze

test("long_cloze: more than 30 words; a cloze of exactly 30 words gives no hint", () => {
  assert.equal(P.LONG_CLOZE_WORDS, 30);
  const body = (n) => "The {answer} " + words(n - 2);
  assert.deepEqual(codes(body(30)), []);
  assert.deepEqual(P.parse(body(31)).lints, [longClozeMsg(31)]);
  assert.deepEqual(P.parse(body(45)).lints, [longClozeMsg(45)]);
  assert.deepEqual(codes(body(8)), []);
  // counted as the other hints count: a formula or an image is one word
  assert.deepEqual(codes("The {answer} $" + words(40) + "$ " + words(27)), []);
  assert.deepEqual(P.parse("The {answer} $" + words(40) + "$ ![snip](att:a_1) " + words(27)).lints, [longClozeMsg(31)]);
  // Q./A. prompts and notes never get it
  assert.deepEqual(codes(words(40)), []);
  assert.deepEqual(codes(qa(words(20), words(12))), []);
});

test("long_cloze: a cue's words are not counted", () => {
  const thirty = "The {answer::" + words(12, "cue") + "} " + words(28);
  assert.deepEqual(codes(thirty), [], "30 words and a cue of 12");
  assert.deepEqual(codes("The {answer :: " + words(12, "cue") + " } " + words(28)), [], "blanks around the separator add no word");
  assert.deepEqual(P.parse("The {answer::" + words(12, "cue") + "} " + words(29)).lints, [longClozeMsg(31)]);
  assert.deepEqual(P.parse("The {a::x} and {b::y z} " + words(27)).lints, [longClozeMsg(31)], "several cues");
  assert.deepEqual(codes("The {a::x} and {b::y z} " + words(26)), []);
  // a deletion that holds a :: but has no cue counts as typed
  assert.deepEqual(P.parse("The {answer:: } " + words(28)).lints, [longClozeMsg(31)]);
});

test("long_cloze never comes with multi_sentence_cloze; the cloze hints read the body without its cues", () => {
  const two = "The {answer} " + words(20) + ". Then " + words(20) + ".";
  assert.deepEqual(codes(two), ["multi_sentence_cloze"], "long and two sentences: the sentences are the hint");
  assert.deepEqual(codes("The {wave function} is complex. It {evolves} in time."), ["multi_sentence_cloze"], "as before");
  // a cue's full stop ends no sentence
  assert.deepEqual(codes("The {Aare::a river. Not the Rhine} flows through Bern."), []);
  assert.deepEqual(P.parse("The {Aare::a river. Not the Rhine} " + words(29) + ".").lints, [longClozeMsg(31)]);
  assert.deepEqual(codes("The {Aare. It::a river} flows through Bern."), ["multi_sentence_cloze"], "the hidden part's does");
});

// ------------------------------------------------------------------ order, older hints, where hints show

test("the order, worst first: no_answer, empty_answer, yes_no, either_or, list_answer, long_answer, long_question, multi_sentence_cloze, long_cloze, many_deletions", () => {
  assert.deepEqual(codes("Q. only a question"), ["no_answer"]);
  assert.deepEqual(codes(qa("Is " + words(30), "")), ["empty_answer", "yes_no", "long_question"]);
  assert.deepEqual(codes(qa("Is " + words(30), words(5, "a") + "\n" + words(5, "b") + "\n" + words(5, "c") + "\n" + words(5, "d"))), ["yes_no", "list_answer", "long_answer", "long_question"]);
  assert.deepEqual(codes(qa("Which three of " + words(25) + ": up, down and strange or top?", "up, down and strange")), ["either_or", "list_answer", "long_question"]);
  assert.deepEqual(codes("A {b} and {c} and {d} " + words(26)), ["long_cloze", "many_deletions"]);
  assert.deepEqual(codes("A {b}. C {d}. E {f}. " + words(30)), ["multi_sentence_cloze", "many_deletions"]);
  // lint() sorts whatever it finds: the order holds for a parsed object handed in directly
  const p = P.parse(qa("Which three of " + words(25) + ": up, down and strange or top?", "up, down and strange"));
  assert.deepEqual(P.lint(p), p.lints);
  for (const l of p.lints) { assert.equal(typeof l.msg, "string"); assert.ok(l.msg.length > 0); }
});

test("the older hints keep their codes, messages and thresholds", () => {
  assert.deepEqual([P.LONG_ANSWER_WORDS, P.LONG_QUESTION_WORDS, P.MANY_DELETIONS], [15, 25, 3]);
  assert.deepEqual(P.parse("Q. What is this?").lints, [{ code: "no_answer", msg: "Add an A. line to make this reviewable" }]);
  assert.deepEqual(P.parse("Q. What is this?\nA. ").lints, [{ code: "empty_answer", msg: "The answer is empty" }]);
  assert.deepEqual(P.parse(qa("why", words(16))).lints, [{ code: "long_answer", msg: "Long answer (16 words) — split it into several prompts" }]);
  assert.deepEqual(codes(qa("why", words(15))), []);
  assert.deepEqual(P.parse(qa(words(26), "ok")).lints, [{ code: "long_question", msg: "Long question (26 words) — shorter prompts are easier to recall" }]);
  assert.deepEqual(codes(qa(words(25), "ok")), []);
  assert.deepEqual(P.parse("The {wave function} is complex. It {evolves} in time.").lints,
    [{ code: "multi_sentence_cloze", msg: "Several sentences in one cloze — one sentence per prompt reviews better" }]);
  assert.deepEqual(P.parse("{a} and {b} and {c}").lints, [{ code: "many_deletions", msg: "Makes 3 cards" }]);
  assert.deepEqual(codes("{a} and {b}"), []);
  assert.deepEqual(codes("a plain note, with commas, and three parts"), [], "notes get no hint");
  assert.deepEqual(codes(""), []);
});

test("lint() takes a parsed object as it is: missing fields and deletions without offsets do not throw", () => {
  assert.deepEqual(P.lint(null), []);
  assert.deepEqual(P.lint({ kind: "qa" }).map((l) => l.code), ["empty_answer"]);
  assert.deepEqual(P.lint({ kind: "qa", question: "A or B?", answer: "b" }).map((l) => l.code), ["either_or"]);
  assert.deepEqual(P.lint({ kind: "qa", question: "Which?", answer: "a, b, c" }).map((l) => l.code), ["list_answer"]);
  assert.deepEqual(P.lint({ kind: "cloze", body: "The {x::y} " + words(30), deletions: [{ text: "x", cue: "y" }] }).map((l) => l.code), ["long_cloze"]);
  assert.deepEqual(P.lint({ kind: "cloze", body: "The {x} " + words(10) }), []);
});

test("the new hints show where hints show: the editor's status line carries the worst one", () => {
  assert.equal(E.statusLine(P.parse(qa("Which is heavier, a proton or an electron?", "A proton"))),
    "Q/A · 1 card · The question offers the answer as a choice — ask for the fact itself");
  assert.equal(E.statusLine(P.parse(qa("The primary colours of light?", "red, green and blue"))),
    "Q/A · 1 card · The answer is a list of 3 items — a whole list is hard to recall; make one {blank} per item");
  assert.equal(E.statusLine(P.parse("The {answer} " + words(29))), "Cloze · 1 card · Long cloze (31 words) — keep only the words around the blank");
  assert.equal(E.statusLine(P.parse(qa("The ground state energy vanishes", "False."))),
    "Q/A · 1 card · Yes/no questions are easy to guess — ask for the fact itself");
  // each block of a batch gets its own
  const blocks = P.parseBatch(qa("A or B?", "B") + "\n\n" + qa("Colours?", "red, green, blue") + "\n\nThe {x} is plain.");
  assert.deepEqual(blocks.map((b) => b.parsed.lints.map((l) => l.code)), [["either_or"], ["list_answer"], []]);
});
