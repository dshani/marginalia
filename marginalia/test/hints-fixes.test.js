"use strict";
// test/hints-fixes.test.js — FIXES-1 (2026-11-11), the repairs of the writing hints after the review (M.prompts.lint):
//  - FIX-3 either_or before yes_no;  - FIX-6 a undated, b and c list_answer, d book_bound, e yes_no, f example_prompt,
//    g multi_sentence_cloze (abbreviations);  - FIX-8 c one example per EXAMPLE_TRIGGERS entry, f a trailing letter.
// Each sentence quoted in FIXES-1 and in the behaviour review's corpus, as a positive or a negative.
// Run: node --test test/hints-fixes.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

require(path.join(__dirname, "..", "js", "util.js"));
const P = require(path.join(__dirname, "..", "js", "prompts.js"));

const NOW = new Date(2026, 10, 11, 12).getTime();
const lints = (text) => P.lint(P.parse(text), NOW);
const codes = (text) => lints(text).map((l) => l.code);
const has = (text, code) => codes(text).includes(code);
const qa = (q, a) => "Q. " + q + "\nA. " + (a === undefined ? "an answer" : a);
const boundOf = (text) => { const l = lints(text).find((x) => x.code === "book_bound"); return l ? /“(.*)”/.exec(l.msg)[1] : null; };
const listOf = (text) => { const l = lints(text).find((x) => x.code === "list_answer"); return l ? +/list of (\d+) items/.exec(l.msg)[1] : 0; };

test("FIX-3: either_or before yes_no when the answer is one of the offered choices and no yes/no/true/false; never both", () => {
  assert.deepEqual(codes(qa("Are electrons bosons or fermions?", "Fermions")), ["either_or"]);
  assert.deepEqual(codes(qa("Is the infinite square well ground state even or odd about the center?", "Even")), ["either_or"]);
  assert.deepEqual(codes(qa("Which spin state has lower energy in a field along +z, spin up or spin down (for $\\gamma > 0$)?", "Spin up")), ["either_or"]);
  assert.deepEqual(codes(qa("What kind of operator is $\\hat{H}$: Hermitian or anti-Hermitian?", "hermitian")), ["either_or"]);
  // yes_no when either_or does not hold
  assert.deepEqual(codes(qa("Is the hydrogen ground state spherically symmetric or not?", "It is spherically symmetric")), ["yes_no"]);
  assert.deepEqual(codes(qa("Does the delta well's bound state decay exponentially or oscillate outside?", "It decays exponentially")), ["yes_no"],
    "the answer is no phrase of the question: a miss that stays (FIXES-1 needs the answer to stand in the question)");
  assert.deepEqual(codes(qa("Is it true or false that $[x, p] = i\\hbar$?", "True")), ["yes_no"], "a true/false answer stays yes_no");
  assert.deepEqual(codes(qa("Which is it, yes or no?", "No, never")), ["yes_no"]);
  assert.deepEqual(codes(qa("The eigenvalues of a Hermitian operator are real. True or false?", "True.")), ["yes_no"]);
  for (const t of [qa("Are electrons bosons or fermions?", "Fermions"), qa("Is it red or blue?", "red"), qa("Is it red or blue?", "Yes")]) {
    const c = codes(t);
    assert.equal(c.includes("yes_no") && c.includes("either_or"), false, t);
  }
});

test("FIX-6 e: yes_no for an answer that starts with yes or no and a comma, a period or the end", () => {
  for (const a of ["No, never", "Yes, always", "Yes. Always", "No.", "yes", "No, parity commutes with H", "Yes, since it is part of the total Hamiltonian"]) {
    assert.deepEqual(codes(qa("In 1D, what about bound states", a)), ["yes_no"], a);
  }
  for (const a of ["No net force acts", "Nothing", "Yesterday", "Not at all", "No: it is half a quantum", "Yes and no"]) {
    assert.equal(has(qa("What about the net force", a), "yes_no"), false, a);
  }
});

test("FIX-6 a: undated — “so far” only in its time sense; latest / newest / most recent(ly) only before a word of UNDATED_NOUNS", () => {
  assert.deepEqual(P.UNDATED_NOUNS, ["measurement", "measurements", "value", "values", "result", "results", "data", "experiment",
    "experiments", "record", "records", "model", "models", "estimate", "estimates", "version", "versions", "edition", "editions",
    "findings", "limit", "limits", "bound", "bounds"]);
  for (const t of [qa("How does the potential behave so far from a neutral distribution?", "As the dipole term"),
    qa("Why is $\\psi$ continuous at the boundary even in so far as $V$ jumps?", "A jump would make $\\psi''$ a delta derivative"),
    "The charge is so far from the plate that its field there is {approximately uniform}.",
    qa("Why does it hold so far away?", "x"), qa("Is it so far beyond?", "x"), qa("How so far out?", "x"), qa("So far as we know?", "x"),
    qa("In the Drude model, what is the mean time since the most recent collision?", "$\\tau$, the relaxation time"),
    qa("What is the latest time a signal could leave the source and still reach $\\mathbf{r}$ at $t$?", "The retarded time"),
    qa("Which model is newest?", "x"), qa("Who most recently won?", "x"), qa("What is the latest?", "x"),
    "In 2019 the SI units were {redefined} so far as the kilogram is concerned."]) {
    assert.equal(has(t, "undated"), false, t);
  }
  for (const [t, m] of [["The {latest} measurement gives the proton radius as 0.84 fm.", "latest"],
    ["The {currently accepted} value of $\\alpha$ is about 1/137.", "currently"],
    [qa("What has been measured so far for the neutrino mass?", "Only upper bounds"), "so far"],
    [qa("What is the newest model of dark energy?", "x"), "newest"], [qa("What are the most recent data on $g-2$?", "x"), "most recent"],
    [qa("What do the most recently published bounds say?", "x"), null], [qa("What do the most recently bounds say?", "x"), "most recently"],
    [qa("What is the latest estimate of $H_0$?", "x"), "latest"], [qa("What was found recently?", "x"), "recently"],
    [qa("What is currently the most precise measurement of $g-2$?", "Fermilab's muon g-2 experiment"), "currently"]]) {
    const l = lints(t).find((x) => x.code === "undated");
    if (m === null) assert.equal(l, undefined, t);
    else assert.ok(l && l.msg.startsWith("“" + m + "”"), t + " → " + (l && l.msg));
  }
});

test("FIX-6 b: list_answer (ii) needs a last joint and / or, a semicolon, or parts of at most 2 words", () => {
  assert.equal(P.LIST_SHORT_PART_WORDS, 2);
  for (const a of ["The electric field, not the potential, is discontinuous",
    "The tangential component of $\\mathbf{B}$, perpendicular to $\\mathbf{K}$, jumps by $\\mu_0 K$",
    "Radially outward, as $1/r^2$, from the charge",
    // one semicolon joins two clauses: no list (the parent session's rule after the repair: LIST_SEMICOLONS 2)
    "Uniform inside, $-\\mathbf{P}/3\\epsilon_0$; a pure dipole outside"]) {
    assert.equal(has(qa("What happens?", a), "list_answer"), false, a);
  }
  for (const [a, n] of [["up, down and strange", 3], ["$\\hat x$, $\\hat p$, $\\hat H$", 3], ["red, green, and blue", 3], ["Red; green; blue.", 3],
    ["mass, charge, spin", 3], ["$n$, $l$ and $m$", 3],
    // four or more parts are a list whatever joins them (LIST_MANY_PARTS 4)
    ["gravity, the weak force, the strong force, electromagnetism", 4],
    ["Gauss's law, Gauss's law for magnetism, Faraday's law, Ampère-Maxwell law", 4],
    ["the weak force, the strong force or gravity", 3]]) {
    assert.equal(listOf(qa("Which?", a)), n, a);
  }
});

test("FIX-6 c: list_answer (i) counts formula lines too when no line is a sentence or an intro and two or more are formulas", () => {
  assert.equal(P.LIST_FORMULA_LINES, 2);
  assert.equal(listOf(qa("What three things does the Schrödinger equation need to fix $\\Psi(x,t)$?", "$V(x)$\n$\\Psi(x,0)$\nboundary conditions")), 3);
  assert.equal(listOf(qa("Which?", "$a$\n$b$\nboth real")), 3);
  assert.equal(listOf(qa("The Schrödinger equation?", "It reads\n$$i\\hbar\\partial_t\\Psi = H\\Psi$$\nfor every state")), 0, "one formula: unchanged");
  assert.equal(listOf(qa("Which?", "$a$\n$b$\nand that is because both are real numbers")), 0, "a sentence line: unchanged (two formulas only)");
  assert.equal(listOf(qa("Which?", "These two:\n$a$\n$b$")), 0, "an intro line: unchanged");
  assert.equal(listOf(qa("Which?", "$a$\n$b$")), 0, "two lines are no list");
});

test("FIX-6 d and FIX-8 f: book_bound — new labels, in / from the figure …, the last / next / following chapter, no above-barrier", () => {
  for (const [q, m] of [["What is the main result of Example 2.6 in Griffiths?", "Example 2.6"], ["What does Problem 4.12 ask you to show?", "Problem 4.12"],
    ["What does Sec. 4.3 derive?", "Sec. 4.3"], ["What does Ch. 7 add to Ampère's law?", "Ch. 7"], ["What is shown on pg. 112?", "pg. 112"],
    ["What do Secs. 4.1 and 4.2 treat?", "Secs. 4.1"], ["What do Chs. 2 and 3 cover?", "Chs. 2"], ["What does Prob. 3.1 show?", "Prob. 3.1"],
    ["What does Exercise 5 ask?", "Exercise 5"], ["Which Examples 2 and 3 agree?", "Examples 2"], ["In the figure, which way does the current flow?", "In the figure"],
    ["What is the force in the example on the charged ring?", "in the example"], ["What value comes from the table?", "from the table"],
    ["Which charge is in the diagram?", "in the diagram"], ["What is assumed in the problem?", "in the problem"],
    ["What did the last chapter show about the free particle?", "the last chapter"], ["What will the next section prove?", "the next section"],
    ["What does the following chapter add?", "the following chapter"], ["What is drawn in Figure 3a?", "Figure 3a"], ["What does Eq. 2.4b give?", "Eq. 2.4b"],
    ["Which term is in Fig. (2.3b)?", "Fig. (2.3b)"]]) {
    assert.equal(boundOf(qa(q)), m, q);
  }
  for (const q of ["What is the above-barrier reflection coefficient for a step potential?", "Why is the cross section below the threshold energy zero?",
    "Why is the cross-section above 1 TeV flat?", "What solves the equation 2x = 4?", "What solves the equation 2x+1 = 5?", "What is Figure 3ab?",
    "What is the example of a boson?", "What is the problem of measurement?", "What equation does Griffiths (2.17) give?"]) {
    assert.equal(boundOf(qa(q)), null, q);
  }
  assert.equal(boundOf(qa("What does the equation above say about $\\Psi$?")), "equation above", "a reference still fires");
});

test("FIX-6 f and FIX-8 c: example_prompt — an article or number word is no break; one positive per EXAMPLE_TRIGGERS entry", () => {
  assert.deepEqual(P.EXAMPLE_TRIGGERS, ["give", "name", "list", "state", "provide", "what is", "what are"]);
  for (const q of ["Give the standard example of a non-normalizable eigenfunction.", "Name an example of a stock", "List two examples of fermions",
    "State the simplest example of a gauge symmetry", "Provide an example of a Hermitian operator", "What is an example of a boson?",
    "What are the three examples of conserved currents?", "Give one example of a phase transition"]) {
    assert.equal(has(qa(q), "example_prompt"), true, q);
  }
  for (const q of ["What is the example's main assumption?", "What are the examples' common feature?", "In which example does the force vanish?",
    "What is the force in the example of the inclined plane?"]) {
    assert.equal(has(qa(q), "example_prompt"), false, q);
  }
});

test("FIX-6 g: the period of an abbreviation ends no sentence in multi_sentence_cloze", () => {
  for (const t of ["By Eq. (2.3) the {energy} is quantized.", "e.g. Hermitian operators have {real} eigenvalues.",
    "Hermitian operators, i.e. observables, have {real} eigenvalues.", "Compare Fig. 2 with the {ground state}.", "See Sec. 4 for the {proof}.",
    "Ch. 3 treats the {oscillator}.", "As Dr. Smith says the {mass} is small.", "Prof. Bohr gave the {radius}.", "No. 5 is the {answer}.",
    "Use Eqs. 1 and 2 for the {field}.", "Bosons vs. Fermions differ in {spin}.", "Spin, charge, etc. Are {conserved}.", "cf. Griffiths The {spin} is half."]) {
    assert.equal(has(t, "multi_sentence_cloze"), false, t);
  }
  for (const t of ["In the hydrogen atom the {energy} depends only on {n}. Degeneracy comes from {l} and {m}.", "The {mass} is small. It is fixed.",
    "The answer is no. The {spin} is half."]) {
    assert.equal(has(t, "multi_sentence_cloze"), true, t);
  }
});
