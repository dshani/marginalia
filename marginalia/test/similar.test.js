"use strict";
// Marginalia — test/similar.test.js: FEATURES P2.4 a, b (look-alike prompts), the pure part.
//  - M.similar.words / score / alike vectors: stop words, math as one word, images ignored, cloze braces and cues
//    removed, the two thresholds (MIN_SCORE 0.6, MIN_SHARED 3) at their edges;
//  - pairs with ignored keys, deleted prompts, notes; nearest (never the prompt itself, notAlike honoured);
//  - the speed test: 2,000 prompts;
//  - settings.notAlike sanitising (5,001 entries, non-strings, overlong keys, repeats, a non-array) and its trip
//    through a JSON backup (toJSON carries it, importJSON with restoreSettings puts it back).
// Run: node --test test/similar.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const JS = (n) => path.join(__dirname, "..", "js", n + ".js");
const S = require(JS("similar"));
const settings = require(JS("settings"));
const M = globalThis.Marginalia;

const qa = (q) => "Q. " + q + "\nA. answer";

test("words: the question of a Q./A. prompt, lower case, punctuation and stop words gone, each word once", () => {
  assert.deepEqual(S.words(qa("What is the Fermi energy of a free-electron gas, in a metal?")),
    ["fermi", "energy", "free", "electron", "gas", "metal"]);
  assert.deepEqual(S.words("Q. Why doesn't the Moon's orbit decay?\nA. tides"), ["moons", "orbit", "decay"],
    "apostrophes are dropped, not split (doesn't → doesnt, a form of do)");
  assert.deepEqual(S.words(qa("Energy energy ENERGY")), ["energy"], "a word counts once");
  assert.deepEqual(S.words("Q. Fermi energy?\nA. the fermi level of the metal"), ["fermi", "energy"], "the answer is not compared");
  assert.deepEqual(S.words(qa("Running runs ran")), ["running", "runs", "ran"], "no stemming");
  // articles, be / do / have, prepositions, question words
  for (const w of ["a", "an", "the", "is", "are", "was", "were", "be", "been", "do", "does", "did", "have", "has", "had",
    "of", "in", "on", "at", "to", "from", "with", "by", "for", "into", "about", "what", "which", "who", "when", "where", "why", "how"]) {
    assert.ok(S.STOP_WORDS.includes(w), w);
  }
  assert.deepEqual(S.words(qa("What is in the box?")), ["box"]);
});

test("words: each math run is one word made of its source without blanks; images are ignored", () => {
  assert.deepEqual(S.words(qa("What is $E = m c^2$ for ![snip](att:a1) a photon?")), ["$E=mc^2", "photon"]);
  assert.deepEqual(S.words(qa("$x$ then \\(x\\)")), ["$x"], "the delimiters do not matter, the source does (\"then\" is a stop word: FIXES-1 FIX-7 a)");
  assert.notDeepEqual(S.words(qa("$E$ field")), S.words(qa("$e$ field")), "the case of a formula is kept");
  assert.deepEqual(S.words(qa("$a, b$ in $\\{a\\}$")), ["$a,b", "$\\{a\\}"], "punctuation inside math stays");
});

test("words: a cloze is compared on its whole sentence, braces and cues removed; notes and highlights have none", () => {
  assert.deepEqual(S.words("The {Aare::river} flows through {Bern} in Switzerland."), ["aare", "flows", "bern", "switzerland"]);
  assert.deepEqual(S.words("The {Aare} flows through Bern in Switzerland.\n#geo"), ["aare", "flows", "bern", "switzerland"],
    "the tags line is not compared");
  assert.deepEqual(S.words("{$\\hbar$::constant} sets the {scale}"), ["$\\hbar", "sets", "scale"]);
  assert.deepEqual(S.words("Just a note about Bern"), []);
  assert.deepEqual(S.words(""), []);
  assert.deepEqual(S.words("Q. only a question"), [], "a Q. line without A. is a note");
});

test("score and alike: Jaccard over the word sets; MIN_SCORE 0.6 and MIN_SHARED 3 at their edges", () => {
  assert.equal(S.MIN_SCORE, 0.6);
  assert.equal(S.MIN_SHARED, 3);
  assert.equal(S.score([], ["a"]), 0);
  assert.equal(S.score(["x"], []), 0);
  assert.equal(S.score(["x", "y"], ["y", "z"]), 1 / 3);
  // 3 shared of 5 = 0.6 exactly: alike
  assert.equal(S.score(["a1", "a2", "a3", "a4"], ["a1", "a2", "a3", "b4"]), 3 / 5);
  assert.equal(S.alike(["a1", "a2", "a3", "a4"], ["a1", "a2", "a3", "b4"]), true);
  // 3 shared of 6 = 0.5: not alike
  assert.equal(S.alike(["a1", "a2", "a3", "a4", "a5"], ["a1", "a2", "a3", "b4"]), false);
  // 2 shared of 2 = 1.0 but fewer than 3 shared words: not alike
  assert.equal(S.score(["a1", "a2"], ["a1", "a2"]), 1);
  assert.equal(S.alike(["a1", "a2"], ["a1", "a2"]), false);
  // exactly 3 shared and the same set: alike
  assert.equal(S.alike(["a1", "a2", "a3"], ["a3", "a2", "a1"]), true);
  // texts work as well as word lists
  assert.equal(S.alike(qa("What is the Fermi energy of a metal at zero temperature?"), qa("What is the Fermi energy of a metal at room temperature?")), true);
  assert.equal(S.alike(qa("What is the capital of France?"), qa("What is the capital of Germany?")), false, "one shared word");
});

test("two cloze prompts made from one sentence with different blanks look alike (the same sentence)", () => {
  const a = "The {Aare} flows through Bern in Switzerland.", b = "The Aare flows through {Bern} in {Switzerland::country}.";
  assert.equal(S.score(a, b), 1);
  assert.equal(S.alike(a, b), true);
});

test("two prompts that differ only in a formula: the formula is one word of several", () => {
  const a = qa("Which equation does Gauss law give for $\\nabla \\cdot E$ in vacuum?"), b = qa("Which equation does Gauss law give for $\\nabla \\cdot B$ in vacuum?");
  // words: equation, gauss, law, give, <formula>, vacuum → 5 shared of 7
  assert.equal(S.score(a, b), 5 / 7);
  assert.equal(S.alike(a, b), true);
  assert.equal(S.alike(qa("What is $E = mc^2$?"), qa("What is $E = h\\nu$?")), false, "only the formula: nothing shared");
});

test("key: the two ids sorted and joined with |", () => {
  assert.equal(S.key("p_b", "p_a"), "p_a|p_b");
  assert.equal(S.key("p_a", "p_b"), "p_a|p_b");
});

const P = (id, text, extra) => Object.assign({ id, text, deletedAt: null }, extra || {});

test("pairs: every alike pair of live Q./A. and cloze prompts once, best first; ignored keys, deleted prompts and notes left out", () => {
  const ps = [
    P("p1", qa("What is the Fermi energy of a metal at zero temperature?")),
    P("p2", qa("What is the Fermi energy of a metal at room temperature?")),
    P("p3", "The Fermi {energy} of a metal at zero temperature."),
    P("p4", qa("Why do stars shine?")),
    P("p5", qa("What is the Fermi energy of a metal at zero temperature?"), { deletedAt: 5 }),
    P("p6", "Fermi energy of a metal at zero temperature, a note")
  ];
  const all = S.pairs(ps, []);
  assert.deepEqual(all.map((x) => S.key(x.a, x.b)), ["p1|p3", "p1|p2", "p2|p3"]);
  assert.equal(all[0].score, 1);
  assert.ok(all.every((x) => x.a < x.b));
  assert.deepEqual(S.pairs(ps, ["p1|p3"]).map((x) => S.key(x.a, x.b)), ["p1|p2", "p2|p3"]);
  assert.deepEqual(S.pairs(ps, new Set(["p2|p1", "p1|p2"])).map((x) => S.key(x.a, x.b)), ["p1|p3", "p2|p3"], "a Set works; keys are sorted ids");
  assert.deepEqual(S.pairs(ps, null).length, 3);
  assert.deepEqual(S.pairs([], []), []);
  assert.deepEqual(S.pairs(null, null), []);
  assert.deepEqual(S.pairs([P("x", qa("Fermi energy metal")), P("x", qa("Fermi energy metal"))], []), [], "one id is never a pair with itself");
});

test("nearest: the most alike prompt, never the prompt itself, never a pair in notAlike; null for notes and when nothing is alike", () => {
  const ps = [
    P("p1", qa("What is the Fermi energy of a metal at zero temperature?")),
    P("p2", qa("What is the Fermi energy of a metal at room temperature?")),
    P("p3", qa("Why do stars shine?"))
  ];
  const text = qa("What is the Fermi energy of a metal at zero temperature?");
  assert.equal(S.nearest(text, ps, null).id, "p1", "a new prompt: the identical one first");
  assert.equal(S.nearest(text, ps, "p1").id, "p2", "while p1 is edited it is never compared with itself");
  assert.equal(S.nearest(text, ps, "p1", ["p1|p2"]), null, "p1 and p2 are marked not alike");
  assert.equal(S.nearest(text, ps, null, ["p1|p2", "p1|p3"]).id, "p1", "a new prompt has no pair key");
  assert.equal(S.nearest("Fermi energy of a metal at zero temperature", ps, null), null, "a note");
  assert.equal(S.nearest(qa("Why do galaxies spin?"), ps, null), null);
  assert.equal(S.nearest(text, [], null), null);
});

test("a pair marked Not alike stays out after either prompt changes (the mark belongs to the two ids)", () => {
  const before = [P("p1", qa("What is the Fermi energy of a metal?")), P("p2", qa("What is the Fermi energy of a metal at zero?"))];
  assert.equal(S.pairs(before, []).length, 1);
  const after = [P("p1", qa("What is the Fermi energy of a metal at zero kelvin?")), P("p2", qa("What is the Fermi energy of a metal at zero kelvin?"))];
  assert.equal(S.pairs(after, []).length, 1);
  assert.equal(S.pairs(after, [S.key("p2", "p1")]).length, 0);
});

test("oneLine: the asking side on one line, cut with …", () => {
  assert.equal(S.oneLine("Q. What is\n  $x^2$ ![s](att:1)?\nA. y"), "What is $x^2$ [image]?");
  assert.equal(S.oneLine("The {Aare::river} flows {through} Bern."), "The Aare flows through Bern.");
  const long = S.oneLine(qa("word ".repeat(40)));
  assert.ok(long.length <= S.ONE_LINE_CHARS && long.endsWith("…"), long);
  assert.equal(S.oneLine(qa("abcdef ghij"), 8), "abcdef…");
});

test("speed: a templated collection (every two prompts alike) stops at MAX_PAIRS and stays fast", () => {
  // review safety F1: 2,000 prompts from one template have 2 million pairs; pairs() reports MAX_PAIRS and stops
  assert.equal(S.MAX_PAIRS, 5000);
  const ps = [];
  for (let i = 0; i < 2000; i++) ps.push(P("t" + String(i).padStart(4, "0"), qa("What is the capital city of country" + i + " called", "x")));
  assert.equal(S.alike(ps[0].text, ps[1].text), true);
  const t0 = process.hrtime.bigint();
  const out = S.pairs(ps, []);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(out.length, S.MAX_PAIRS);
  assert.ok(ms < 1000, "2,000 templated prompts took " + ms.toFixed(0) + " ms");
  assert.ok(out.every((x) => x.a < x.b && x.score >= S.MIN_SCORE));
  // below the limit nothing changes: 100 templated prompts give every pair
  assert.equal(S.pairs(ps.slice(0, 100), []).length, 100 * 99 / 2);
});

test("speed: 2,000 prompts that share many words are paired well under a second (index by word)", () => {
  const vocab = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega energy field charge mass spin wave".split(" ");
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const ps = [];
  for (let i = 0; i < 2000; i++) {
    const n = 4 + Math.floor(rnd() * 8), w = [];
    for (let k = 0; k < n; k++) w.push(vocab[Math.floor(rnd() * vocab.length)]);
    ps.push(P("p" + i, i % 2 ? qa(w.join(" ") + " $x_" + (i % 50) + "$") : "The " + w.slice(0, -1).join(" ") + " {" + w[n - 1] + "}."));
  }
  const t0 = process.hrtime.bigint();
  const out = S.pairs(ps, []);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(out.length > 0);
  assert.ok(ms < 2000, "2,000 prompts took " + ms.toFixed(0) + " ms");
  const t1 = process.hrtime.bigint();
  S.nearest(qa("alpha beta gamma delta"), ps, null);
  assert.ok(Number(process.hrtime.bigint() - t1) / 1e6 < 500, "nearest over 2,000 prompts");
});

// ---- P2.4 b: settings.notAlike --------------------------------------------------------------------------

test("settings.notAlike: default [], an array of pair keys; invalid entries dropped; at most 5,000 (the newest)", () => {
  settings.reset();
  assert.deepEqual(settings.DEFAULTS.notAlike, []);
  assert.deepEqual(settings.get("notAlike"), []);
  assert.equal(settings.NOT_ALIKE_MAX, 5000);
  assert.equal(settings.NOT_ALIKE_KEY_MAX, 200);
  const long = "p_" + "x".repeat(199);                 // 201 characters
  const edge = "p_" + "y".repeat(198);                 // 200 characters
  assert.equal(settings.set("notAlike", ["a|b", 7, null, { k: 1 }, ["c|d"], "", long, edge, "a|b", "c|d"]), true);
  assert.deepEqual(settings.get("notAlike"), ["a|b", edge, "c|d"]);
  const many = Array.from({ length: 5001 }, (_, i) => "p" + i + "|q" + i);
  assert.equal(settings.set("notAlike", many), true);
  const kept = settings.get("notAlike");
  assert.equal(kept.length, 5000);
  assert.equal(kept[0], "p1|q1", "the oldest key goes");
  assert.equal(kept[4999], "p5000|q5000");
  // a non-array is refused and the list stays
  for (const bad of ["a|b", 5, null, { a: 1 }]) assert.equal(settings.set("notAlike", bad), false);
  assert.equal(settings.get("notAlike").length, 5000);
  // get returns a copy
  settings.get("notAlike").push("zz|zz");
  assert.equal(settings.get("notAlike").length, 5000);
  settings.reset();
  assert.deepEqual(settings.get("notAlike"), []);
});

test("settings.notAlike travels in JSON backups and an import with \"Also restore settings\" puts it back", async () => {
  const exporter = require(JS("exporter"));
  assert.ok(exporter.SETTINGS_KEYS.includes("notAlike"));
  const json = exporter.toJSON({ attachments: [], collections: [], prompts: [], settings: { notAlike: ["p1|p2"], theme: "dark" } });
  assert.deepEqual(JSON.parse(json).settings, { notAlike: ["p1|p2"] });
  // the import: a stand-in cache and store, the real settings
  const prev = { cache: M.cache, store: M.store, app: M.app };
  M.cache = { collections: () => [], collection: () => null, prompts: () => [], prompt: () => null, promptsOf: () => [],
    saveCollection: (c) => Promise.resolve(c), savePrompt: (p) => Promise.resolve(p), load: () => Promise.resolve() };
  M.store = { attachments: { get: () => Promise.resolve(null), put: (a) => Promise.resolve(a) }, collections: { all: () => Promise.resolve([]) }, prompts: { all: () => Promise.resolve([]) } };
  M.app = { toast() { return { close() {} }; } };
  try {
    settings.reset();
    settings.set("notAlike", ["old|pair"]);
    await exporter.importJSON(json, { restoreSettings: false });
    assert.deepEqual(settings.get("notAlike"), ["old|pair"], "without the box ticked nothing changes");
    const bad = exporter.toJSON({ attachments: [], collections: [], prompts: [], settings: { notAlike: ["x|y", 3, "z".repeat(300)] } });
    await exporter.importJSON(bad, { restoreSettings: true });
    assert.deepEqual(settings.get("notAlike"), ["x|y"], "restored, invalid entries dropped");
    await exporter.importJSON(json, { restoreSettings: true });
    assert.deepEqual(settings.get("notAlike"), ["p1|p2"]);
  } finally {
    M.cache = prev.cache; M.store = prev.store; M.app = prev.app;
    settings.reset();
  }
});

// ---- FIXES-1 (2026-11-11) -------------------------------------------------------------------------------------------
test("FIX-4: oneLine adds no blank where a blank stood and shows \\:: as ::", () => {
  assert.equal(S.oneLine("The {electron} has a {density}."), "The electron has a density.");
  assert.equal(S.oneLine("The {mass::m}, then the {charge :: q}; done."), "The mass, then the charge; done.");
  assert.equal(S.oneLine("A {b}{c} d"), "A bc d", "as typed: two blanks side by side stay side by side");
  assert.equal(S.oneLine("Q. What does a\\::b mean?\nA. x"), "What does a::b mean?");
  assert.equal(S.oneLine("Q. Is $a\\::b$ math?\nA. x"), "Is $a\\::b$ math?", "math stays as typed");
  assert.equal(S.oneLine("Q. Two backslashes a\\\\::b?\nA. x"), "Two backslashes a\\\\::b?", "an even number of backslashes escapes nothing");
  assert.equal(S.oneLine("The {ratio a\\::b} is {fixed}."), "The ratio a::b is fixed.");
});

test("FIX-8 d: oneLine at exactly ONE_LINE_CHARS (90) characters is whole; at 91 it is cut with …", () => {
  assert.equal(S.ONE_LINE_CHARS, 90);
  const q90 = "x".repeat(89) + "?", q91 = "x".repeat(90) + "?";
  assert.equal(S.oneLine(qa(q90)), q90);
  const cut = S.oneLine(qa(q91));
  assert.equal(Array.from(cut).length, 90);
  assert.equal(cut, "x".repeat(89) + "…");
});

test("FIX-7 a: the stop words gain conjunctions, pronouns, modal verbs and a few adverbs", () => {
  for (const w of ["and", "or", "but", "nor", "not", "it", "its", "this", "that", "these", "those", "than", "then", "so", "if", "can",
    "will", "must", "may", "would", "should", "could", "we", "you", "they", "their", "there", "here", "also", "only"]) {
    assert.ok(S.STOP_WORDS.includes(w), w);
  }
  assert.deepEqual(S.words(qa("Why can it not be that we also see this and only those?")), ["see"]);
  // two questions that shared only such words were alike before; they are not now
  assert.equal(S.alike(qa("Why can we say that it must be so?"), qa("Why can we say that it must be true?")), false);
});

test("FIX-7 b: two clozes of one sentence with different blanks are no pair; with the same blanks they are; Q./A. unchanged", () => {
  const P2 = (id, text) => ({ id, text, deletedAt: null });
  const a = "The {Aare} flows through Bern in Switzerland.", b = "The Aare flows through {Bern} in {Switzerland::country}.";
  assert.equal(S.alike(a, b), true, "the words alone still match (score and alike are about words)");
  assert.deepEqual(S.pairs([P2("a", a), P2("b", b)], []), [], "pairs() skips them");
  assert.equal(S.nearest(a, [P2("b", b)], null), null, "nearest() too");
  const dup = "The {Aare} flows through  Bern in Switzerland.";
  assert.deepEqual(S.pairs([P2("a", a), P2("c", dup)], []).map((x) => [x.a, x.b]), [["a", "c"]], "same sentence, same blanks: a duplicate");
  assert.equal(S.nearest(a, [P2("c", dup)], null).id, "c");
  const cue = "The {Aare::river} flows through Bern in Switzerland.";
  assert.equal(S.pairs([P2("a", a), P2("d", cue)], []).length, 1, "a cue changes no blank: still the same blanks");
  const other = "The {Aare} river flows through Bern in Switzerland.";
  assert.equal(S.pairs([P2("b", b), P2("e", other)], []).length, 1, "another sentence with other blanks: alike as before");
  const q1 = qa("What is the Fermi energy of a metal at zero temperature?"), q2 = qa("What is the Fermi energy of a metal at room temperature?");
  assert.equal(S.pairs([P2("q1", q1), P2("q2", q2)], []).length, 1, "Q./A. prompts are unchanged");
  assert.equal(S.pairs([P2("x", "The {Aare} flows through Bern in Switzerland."), P2("y", qa("The Aare flows through Bern in Switzerland"))], []).length, 1,
    "a cloze and a Q./A. prompt never take the cloze rule");
});
