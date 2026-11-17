"use strict";
// test/hints-p2.test.js — FEATURES P2.1, three more writing hints in M.prompts.lint(parsed, now):
//  - example_prompt (qa): the question asks for examples;
//  - book_bound (qa: the question; cloze: the body): wording that only makes sense beside the source;
//  - undated (qa: question and answer; cloze: the body): a word that will age, and no year in the prompt;
//  - lint's optional `now` (the year in undated's message), the order worst first, never inside math.
// Run: node --test test/hints-p2.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const P = require(path.join(__dirname, "..", "js", "prompts.js"));

const NOW = new Date(2026, 10, 11, 12).getTime();          // 11 Nov 2026, local time
const lints = (text, now) => P.lint(P.parse(text), now === undefined ? NOW : now);
const codes = (text) => lints(text).map((l) => l.code);
const has = (text, code) => codes(text).includes(code);
const qa = (q, a) => "Q. " + q + "\nA. " + (a === undefined ? "an answer" : a);

const EXAMPLE = { code: "example_prompt", msg: "Example questions train one remembered instance — also ask from an instance to the idea" };
const bound = (m) => ({ code: "book_bound", msg: "The wording points into the book (“" + m + "”) — phrase it so it stands alone" });
const undated = (m, y) => ({ code: "undated", msg: "“" + m + "” will age — add a date (for example “as of " + (y || 2026) + "”)" });

// ------------------------------------------------------------------ example_prompt

test("example_prompt: a question that asks for examples (at the start, or after give/name/list/state/provide/what is/what are)", () => {
  assert.deepEqual(lints(qa("Name an example of a stock", "Apple")), [EXAMPLE]);
  for (const q of ["Give two examples of bosons", "give an example of a conserved current", "List three examples of fermions",
    "State an example of a gauge symmetry", "Provide some examples of phase transitions", "What are examples of fermions?",
    "What is an example of a Hermitian operator?", "What are some good examples of $SU(2)$ representations?", "Examples of bosons?",
    "Example of a non-abelian group?", "Two examples of conserved quantities?", "WHAT IS AN EXAMPLE of a scalar?",
    "For a free particle, name one example of a stationary state"]) {
    assert.ok(has(qa(q), "example_prompt"), q);
  }
});

test("example_prompt: the word in another role does not fire", () => {
  for (const q of ["In which example does the force vanish?", "What is the force in the example of the inclined plane?",
    "Which example uses a pendulum?", "What does this example show about entropy?", "Why is the harmonic oscillator a good example?",
    "What is the example's main assumption?", "What is the name of the example particle?", "What is the counterexample to naive set theory?",
    "Name the particle that mediates the weak force", "What is $\\text{example}$ in the code?", "What are the examples' common feature?",
    "List the steps of the derivation", "What state does the example end in?"]) {
    assert.equal(has(qa(q), "example_prompt"), false, q);
  }
  assert.equal(has("Name an {example} of a stock", "example_prompt"), false, "Q./A. only");
  assert.equal(has(qa("Name an example of a stock", "Apple"), "example_prompt"), true);
});

// ------------------------------------------------------------------ book_bound

test("book_bound: “this/the” + a part of the book, the following, the previous, earlier in", () => {
  assert.deepEqual(lints(qa("What does the author conclude?", "that it works")), [bound("the author")]);
  for (const [q, m] of [["What do the authors assume?", "the authors"], ["What is the main claim of this chapter?", "this chapter"],
    ["What does this section derive?", "this section"], ["What does the book call this effect?", "the book"],
    ["What does the paper measure?", "the paper"], ["What is the article's thesis?", "the article"],
    ["What does This Text argue?", "This Text"], ["What does the passage describe?", "the passage"],
    ["What is the following integral equal to?", "the following"], ["What does the previous result imply?", "the previous"],
    ["Which law was introduced earlier in the chapter?", "earlier in"], ["What   does  the\nauthor say?", "the author"]]) {
    assert.deepEqual(lints(qa(q, "x")).filter((l) => l.code === "book_bound"), [bound(m)], q);
  }
});

test("book_bound: numbered references, also in parentheses", () => {
  assert.deepEqual(lints(qa("What does Eq. (1.5) say?", "energy is conserved")), [bound("Eq. (1.5)")]);
  for (const [q, m] of [["What is shown in Fig. 2.3?", "Fig. 2.3"], ["What does Figure 4 show?", "Figure 4"],
    ["What is listed in Table 1?", "Table 1"], ["What does Equation (3.12) state?", "Equation (3.12)"],
    ["What is Eqn. 7 used for?", "Eqn. 7"], ["What does eq.(2) give?", "eq.(2)"], ["What does Section 2.1 prove?", "Section 2.1"],
    ["What is Chapter 4 about?", "Chapter 4"], ["What is on page 12?", "page 12"], ["What is defined on p. 37?", "p. 37"],
    ["What do Eqs. (1) and (2) say?", "Eqs. (1)"], ["What is Eq. (A.3)?", "Eq. (A.3)"], ["Which result is on pp. 10-12?", "pp. 10-12"]]) {
    assert.deepEqual(lints(qa(q, "x")).filter((l) => l.code === "book_bound"), [bound(m)], q);
  }
});

test("book_bound: physics wording, a named source and math never fire", () => {
  for (const q of ["What is the equation of motion?", "What is the equation of motion for a damped oscillator?",
    "According to Griffiths, what is the spin of an electron?", "What does Noether's theorem state?",
    "What happens to the resistance below $T_c$?", "What is the energy above the Fermi level?", "Light incident from above hits what?",
    "What is the cross section for Thomson scattering?", "Solve the equation 2x = 4 for what?", "What is $\\text{above}$ in this formula?",
    "What does $\\text{the following}$ denote?", "What is $\\text{Eq. } (1.5)$?", "Which page of a book is numbered first?",
    "What is the textbook value of g?", "What does a figure of merit measure?", "Why does the theorem follow?",
    "What is a conic section called?", "What is the authority of a theory?", "What chapter of physics studies heat?"]) {
    assert.equal(has(qa(q, "x"), "book_bound"), false, q);
  }
  assert.equal(has(qa("What does it say?", "as the author shows"), "book_bound"), false, "Q./A.: the question only");
  // "the" + a word that also names a thing (section, book, paper, article, text, passage) fires only as a reference
  for (const q of ["What is the section of a cone called?", "What force does the table exert on the book?",
    "Why does the paper burn at 233 °C?", "What is the text on the screen made of?", "How long is the passage through the tunnel?"]) {
    assert.equal(has(qa(q, "x"), "book_bound"), false, q);
  }
  for (const [q, m] of [["In the text, which symbol denotes spin?", "In the text"], ["According to the paper, what limits the yield?", "According to the paper"],
    ["Which unit is used throughout the book?", "throughout the book"], ["What does the section discuss first?", "the section"],
    ["What is the book’s definition of work?", "the book"], ["Which case does the text mention?", "the text"]]) {
    assert.deepEqual(lints(qa(q, "x")).filter((l) => l.code === "book_bound"), [bound(m)], q);
  }
});

test("book_bound: “above” / “below” only as a reference", () => {
  for (const [q, m] of [["What does the equation above say?", "equation above"], ["What is the example above about?", "example above"],
    ["What do the results shown above imply?", "shown above"], ["What is the above expression?", "the above"],
    ["What does the figure below show?", "figure below"], ["Which law, as above, holds?", "as above"], ["What is defined below?", "defined below"]]) {
    assert.deepEqual(lints(qa(q, "x")).filter((l) => l.code === "book_bound"), [bound(m)], q);
  }
  for (const q of ["What happens below the critical temperature?", "What is above the event horizon?", "Is the energy above zero?",
    "What lies below $E_F$?", "What falls from above?"]) {
    assert.equal(has(qa(q, "x"), "book_bound"), false, q);
  }
});

test("book_bound in a cloze reads the body (braces aside, never math)", () => {
  assert.deepEqual(lints("In {this chapter} the {author} argues that energy is conserved.").filter((l) => l.code === "book_bound"), [bound("this chapter")]);
  assert.deepEqual(lints("As the {author} shows, {entropy} grows.").filter((l) => l.code === "book_bound"), [bound("the author")]);
  assert.deepEqual(lints("The {ground state} is given in Eq. (2.1).").filter((l) => l.code === "book_bound"), [bound("Eq. (2.1)")]);
  assert.equal(has("The {ground state} is $\\text{the following}$.", "book_bound"), false);
  assert.equal(has("A note about the author", "book_bound"), false, "notes get no hint");
});

// ------------------------------------------------------------------ undated

test("undated: a word that will age, without a year; the year comes from `now`", () => {
  assert.deepEqual(lints(qa("Where is the particle currently?", "at the origin")), [undated("currently")]);
  assert.deepEqual(lints(qa("Where is the particle currently?", "at the origin"), new Date(2031, 0, 2).getTime()), [undated("currently", 2031)]);
  assert.deepEqual(lints(qa("Where is the particle currently?", "at the origin"), new Date(2027, 5, 1)), [undated("currently", 2027)], "a Date works");
  const clock = P.lint(P.parse(qa("Where is it currently?", "here")));
  assert.equal(clock[0].msg, undated("currently", new Date().getFullYear()).msg, "default: the clock");
  for (const [text, m] of [[qa("What is the latest measurement of g-2?", "x"), "latest"], [qa("Which is the newest model?", "x"), "newest"],
    [qa("What is the most recent value?", "x"), "most recent"], [qa("What do the most recently data show?", "x"), "most recently"],
    [qa("What was found recently?", "x"), "recently"], [qa("How many are known so far?", "x"), "so far"],
    [qa("How many are known to date?", "x"), "to date"], [qa("What happened this year?", "x"), "this year"],
    [qa("What happened last year?", "x"), "last year"], [qa("What is the state of the art?", "x"), "state of the art"],
    [qa("What is state-of-the-art?", "x"), "state-of-the-art"], [qa("What is used at present?", "x"), "at present"],
    [qa("What is used nowadays?", "x"), "nowadays"], [qa("What is it as of now?", "x"), "as of now"],
    [qa("Which detector is best?", "the one Currently running at CERN"), "Currently"], ["The {Higgs} mass is {currently} known to 0.1%.", "currently"]]) {
    assert.deepEqual(lints(text).filter((l) => l.code === "undated"), [undated(m)], text);
  }
});

test("undated: a year anywhere in the prompt's text silences it; math, other words and numbers do not fire", () => {
  for (const text of [qa("Where is the particle currently, in 2024?", "at the origin"), qa("Where is the particle currently?", "at the origin (1998)"),
    qa("What is the latest value (as of 1500)?", "x"), qa("What is the latest value?", "x in 2199"), "As of {2025}, the {latest} value is 3."]) {
    assert.equal(has(text, "undated"), false, text);
  }
  for (const text of [qa("What is $\\text{currently}$ conserved?", "x"), qa("What is the current density?", "x"), qa("Who wrote it lately?", "x"),
    qa("What is the most recentest?", "x"), qa("What is the latest?", "x"), qa("What is the latest?", "x 2200"), qa("What is the latest?", "x 1499"),
    qa("What is the latest?", "x 3.2026"), qa("What is the latest?", "x 12026")]) {
    // FIXES-1 FIX-6 a: "latest" alone (not before a word of UNDATED_NOUNS) no longer fires; with "value" it does
    assert.equal(has(text, "undated"), false, text);
    const valued = text.replace("the latest?", "the latest value?");
    assert.equal(has(valued, "undated"), /latest value\?/.test(valued), valued);   // 2200, 1499, 3.2026, 12026 are no year
  }
  assert.equal(has(qa("What is $\\text{currently}$ conserved?", "x"), "undated"), false);
});

// ------------------------------------------------------------------ order and the rest

test("the order, worst first, with the three new codes; the older hints are unchanged", () => {
  const all = lints(qa("What is an example of a particle currently described in the following chapter? " + "w ".repeat(25), "yes"));
  assert.deepEqual(all.map((l) => l.code), ["yes_no", "example_prompt", "long_question", "book_bound", "undated"]);
  assert.deepEqual(codes(qa("Name three examples of what the author lists currently", "a, b and c")),
    ["example_prompt", "list_answer", "book_bound", "undated"]);
  const cl = codes("In {this chapter}, the {latest} result is {x}. It holds.");
  assert.deepEqual(cl, ["book_bound", "undated", "multi_sentence_cloze", "many_deletions"]);
  assert.deepEqual(codes(qa("What is the spin of an electron?", "one half")), []);
  assert.deepEqual(codes("Q. Which example above?"), ["no_answer"], "a note gets no P2 hint");
  assert.deepEqual(P.lint(null), []);
});
