"use strict";
// Marginalia — test/context.test.js (SPEC §12 context bullets). Run: node --test test/context.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const context = require(path.join(__dirname, "..", "js", "context.js"));
const { normalizeTitle, sectionsFromOutline, labelFor, line, fit, sectionLabelFor, contextFor } = context;

// ------------------------------------------------------------------ normalizeTitle

test("normalizeTitle: the four spec examples", () => {
  assert.equal(normalizeTitle("1 The Wave Function", 1), "Ch. 1 · The Wave Function");
  assert.equal(normalizeTitle("Chapter 3: Formalism", 1), "Ch. 3 · Formalism");
  assert.equal(normalizeTitle("1.2 Normalization", 2), "§1.2 Normalization");
  assert.equal(normalizeTitle("IV Spin", 1), "Ch. 4 · Spin");
});

test("normalizeTitle: chapter word with roman numerals, dashes and no title", () => {
  assert.equal(normalizeTitle("Chapter IV: Spin", 1), "Ch. 4 · Spin");
  assert.equal(normalizeTitle("Ch. ix. The Atom", 1), "Ch. 9 · The Atom");
  assert.equal(normalizeTitle("Chapter 10 - The Hydrogen Atom", 1), "Ch. 10 · The Hydrogen Atom");
  assert.equal(normalizeTitle("Chapter 3", 1), "Ch. 3");
  // the explicit "Chapter" word is recognised at level 2 too
  assert.equal(normalizeTitle("Chapter 3: Formalism", 2), "Ch. 3 · Formalism");
});

test("normalizeTitle: bare numbers only at level 1, dotted numbers at any level", () => {
  assert.equal(normalizeTitle("3 Formalism", 2), "3 Formalism");
  assert.equal(normalizeTitle("IV Spin", 2), "IV Spin");
  assert.equal(normalizeTitle("1.2.3. Deep section", 2), "§1.2.3 Deep section");
  assert.equal(normalizeTitle("1.2 Normalization", 1), "§1.2 Normalization");
  assert.equal(normalizeTitle("12. The Hydrogen Atom", 1), "Ch. 12 · The Hydrogen Atom");
  // level defaults to 1
  assert.equal(normalizeTitle("1 The Wave Function"), "Ch. 1 · The Wave Function");
});

test("normalizeTitle: leaves ordinary titles alone and is idempotent on its own output", () => {
  assert.equal(normalizeTitle("Preface", 1), "Preface");
  assert.equal(normalizeTitle("Chi squared tests", 1), "Chi squared tests");
  assert.equal(normalizeTitle("XXI Beyond twenty", 1), "XXI Beyond twenty");
  assert.equal(normalizeTitle("2024 Review", 1), "2024 Review");
  assert.equal(normalizeTitle("Ch. 1 · The Wave Function", 1), "Ch. 1 · The Wave Function");
  assert.equal(normalizeTitle("§1.2 Normalization", 2), "§1.2 Normalization");
});

test("normalizeTitle: whitespace collapsed, 60-char cut, garbage input", () => {
  assert.equal(normalizeTitle("  1   The  Wave\n\tFunction ", 1), "Ch. 1 · The Wave Function");
  const long = "Chapter 7: " + "A very long chapter title about many things ".repeat(3);
  const out = normalizeTitle(long, 1);
  assert.ok(Array.from(out).length <= 60, "cut to 60 characters");
  assert.ok(out.endsWith("…"), "ends with an ellipsis when cut");
  assert.ok(out.startsWith("Ch. 7 · A very long"));
  assert.equal(normalizeTitle("", 1), "");
  assert.equal(normalizeTitle(null, 1), "");
  assert.equal(normalizeTitle(undefined), "");
  assert.equal(normalizeTitle(42, 1), "42");
});

// ------------------------------------------------------------------ sectionsFromOutline

const pages = { pref: 2, ref1: 10, s11: 10, deep: 11, s12: 14, broken: null, c2: 30, half: 3.5 };
function resolvePageIndex(dest) {
  const key = Array.isArray(dest) ? dest[0] : dest;
  if (key === "throws") return Promise.reject(new Error("boom"));
  if (key === "sync-throw") throw new Error("sync boom");
  return Promise.resolve(key in pages ? pages[key] : null);
}

test("sectionsFromOutline: depth-first to level 2, url-only skipped, unresolved skipped, stable sort", async () => {
  const outline = [
    { title: "Preface", dest: "pref", url: null, items: [] },
    { title: "  1   The Wave\nFunction ", dest: ["ref1", { name: "XYZ" }], url: null, items: [
      { title: "1.1 The Schrödinger Equation", dest: "s11", url: null, items: [
        { title: "1.1.1 Deep", dest: "deep", url: null, items: [] } // level 3: ignored
      ] },
      { title: "Buy the book", dest: null, url: "https://example.com", items: [
        { title: "Hidden under a link", dest: "s11", url: null, items: [] } // skipped with its parent
      ] },
      { title: "1.2 Normalization", dest: "s12", url: null, items: [] },
      { title: "Broken", dest: "broken", url: null, items: [] },          // resolves null
      { title: "Throws", dest: "throws", url: null, items: [] },          // rejects
      { title: "Sync throw", dest: "sync-throw", url: null, items: [] },  // throws synchronously
      { title: "Half", dest: "half", url: null, items: [] },              // non-integer page
      { title: "   ", dest: "s12", url: null, items: [] }                 // empty title
    ] },
    { title: "Chapter 2: Time-Independent Schrödinger Equation", dest: "c2", url: null, items: [] },
    { title: "Index", dest: null, url: null, items: [] },                 // no dest at all
    null, "junk"
  ];
  const sections = await sectionsFromOutline(outline, resolvePageIndex);
  assert.deepEqual(sections, [
    { title: "Preface", label: "Preface", pageIndex: 2, level: 1, source: "outline" },
    { title: "1 The Wave Function", label: "Ch. 1 · The Wave Function", pageIndex: 10, level: 1, source: "outline" },
    { title: "1.1 The Schrödinger Equation", label: "§1.1 The Schrödinger Equation", pageIndex: 10, level: 2, source: "outline" },
    { title: "1.2 Normalization", label: "§1.2 Normalization", pageIndex: 14, level: 2, source: "outline" },
    { title: "Chapter 2: Time-Independent Schrödinger Equation", label: "Ch. 2 · Time-Independent Schrödinger Equation", pageIndex: 30, level: 1, source: "outline" }
  ]);
});

test("sectionsFromOutline: children of a page-less heading are still walked; sort is stable", async () => {
  const outline = [
    { title: "Part I", dest: null, url: null, items: [
      { title: "A", dest: "a", url: null, items: [] },
      { title: "B", dest: "b", url: null, items: [] }
    ] },
    { title: "C", dest: "c", url: null, items: [] }
  ];
  const map = { a: 5, b: 3, c: 5 };
  const sections = await sectionsFromOutline(outline, (d) => Promise.resolve(map[d]));
  assert.deepEqual(sections.map((s) => [s.title, s.pageIndex, s.level]), [["B", 3, 2], ["A", 5, 2], ["C", 5, 1]]);
});

test("sectionsFromOutline: null outline, no resolver, synchronous resolver", async () => {
  assert.deepEqual(await sectionsFromOutline(null, resolvePageIndex), []);
  assert.deepEqual(await sectionsFromOutline(undefined, resolvePageIndex), []);
  assert.deepEqual(await sectionsFromOutline([{ title: "A", dest: "pref", items: [] }], undefined), []);
  const sync = await sectionsFromOutline([{ title: "A", dest: "x", items: [] }], () => 7);
  assert.deepEqual(sync, [{ title: "A", label: "A", pageIndex: 7, level: 1, source: "outline" }]);
});

// ------------------------------------------------------------------ labelFor

const SECTIONS = [
  { title: "1 The Wave Function", label: "Ch. 1 · The Wave Function", pageIndex: 10, level: 1, source: "outline" },
  { title: "1.1 The Schrödinger Equation", label: "§1.1 The Schrödinger Equation", pageIndex: 10, level: 2, source: "outline" },
  { title: "1.2 Normalization", label: "§1.2 Normalization", pageIndex: 14, level: 2, source: "outline" },
  { title: "2 Time-Independent", label: "Ch. 2 · Time-Independent", pageIndex: 30, level: 1, source: "outline" }
];

test("labelFor: deepest item at or before the page, chapter + section composition", () => {
  assert.equal(labelFor(SECTIONS, 5), null);
  assert.equal(labelFor(SECTIONS, 9), null);
  assert.equal(labelFor(SECTIONS, 10), "Ch. 1 · The Wave Function · §1.1 The Schrödinger Equation");
  assert.equal(labelFor(SECTIONS, 12), "Ch. 1 · The Wave Function · §1.1 The Schrödinger Equation");
  assert.equal(labelFor(SECTIONS, 14), "Ch. 1 · The Wave Function · §1.2 Normalization");
  assert.equal(labelFor(SECTIONS, 29), "Ch. 1 · The Wave Function · §1.2 Normalization");
  assert.equal(labelFor(SECTIONS, 30), "Ch. 2 · Time-Independent");
  assert.equal(labelFor(SECTIONS, 400), "Ch. 2 · Time-Independent");
  // order of the array does not matter
  assert.equal(labelFor(SECTIONS.slice().reverse(), 14), "Ch. 1 · The Wave Function · §1.2 Normalization");
});

test("labelFor: a manual mark wins over outline items on its page and serves as the level-1 ancestor", () => {
  const manual = { title: "Ch. 1 · My mark", label: "Ch. 1 · My mark", pageIndex: 10, level: 1, source: "manual" };
  const withMark = SECTIONS.concat([manual]);
  assert.equal(labelFor(withMark, 10), "Ch. 1 · My mark");
  assert.equal(labelFor(withMark, 11), "Ch. 1 · My mark");
  assert.equal(labelFor(withMark, 14), "Ch. 1 · My mark · §1.2 Normalization");
  assert.equal(labelFor(withMark, 30), "Ch. 2 · Time-Independent");
  // the manual mark first in the array gives the same answer
  assert.equal(labelFor([manual].concat(SECTIONS), 10), "Ch. 1 · My mark");
  // a level-2 item with no level-1 ancestor stands alone
  assert.equal(labelFor([SECTIONS[1], SECTIONS[2]], 15), "§1.2 Normalization");
});

test("labelFor: tolerates bad input and falls back from label to title", () => {
  assert.equal(labelFor(null, 3), null);
  assert.equal(labelFor([], 3), null);
  assert.equal(labelFor(SECTIONS, null), null);
  assert.equal(labelFor(SECTIONS, "10"), null);
  assert.equal(labelFor([null, { pageIndex: "x" }, { title: "3 Foo", pageIndex: 1, level: 1 }], 2), "Ch. 3 · Foo");
  assert.equal(labelFor([{ title: "", label: "", pageIndex: 1, level: 1 }], 2), null);
});

test("sectionLabelFor: labelFor over collection.sections", () => {
  assert.equal(sectionLabelFor({ sections: SECTIONS }, 14), "Ch. 1 · The Wave Function · §1.2 Normalization");
  assert.equal(sectionLabelFor({ sections: [] }, 14), null);
  assert.equal(sectionLabelFor(null, 14), null);
});

// ------------------------------------------------------------------ line

const BOOK = { id: "b1", kind: "book", name: "Griffiths", sections: SECTIONS, pageLabels: null };
const DECK = { id: "d1", kind: "deck", name: "Thermo formulas", sections: [] };

test("line: book with a section label, without one, and the p. xii fallback", () => {
  const p1 = { context: { docName: "Griffiths", sectionLabel: "Ch. 1 · The Wave Function", pageIndex: 11, pageLabel: "12" } };
  assert.equal(line(BOOK, p1), "Griffiths · Ch. 1 · The Wave Function");
  const p2 = { context: { docName: "Griffiths", sectionLabel: null, pageIndex: 5, pageLabel: "6" } };
  assert.equal(line({ ...BOOK, sections: [] }, p2), "Griffiths · p. 6");
  const p3 = { context: { docName: "Griffiths", sectionLabel: null, pageIndex: 11, pageLabel: "xii" } };
  assert.equal(line({ ...BOOK, sections: [] }, p3), "Griffiths · p. xii");
  // no pageLabel in the snapshot: pageIndex + 1
  const p4 = { context: { docName: "Griffiths", sectionLabel: null, pageIndex: 11, pageLabel: null } };
  assert.equal(line({ ...BOOK, sections: [] }, p4), "Griffiths · p. 12");
  // no snapshot at all: the anchor's page, and the collection's sections when it has some
  assert.equal(line({ ...BOOK, sections: [] }, { anchor: { pageIndex: 11 } }), "Griffiths · p. 12");
  assert.equal(line(BOOK, { anchor: { pageIndex: 11 } }), "Griffiths · Ch. 1 · The Wave Function · §1.1 The Schrödinger Equation".length > 64
    ? "Griffiths · Ch. 1 · The Wave Function" : "unreachable");
  // nothing known: just the name
  assert.equal(line({ ...BOOK, sections: [] }, { anchor: null, context: null }), "Griffiths");
});

test("line: decks use name · sectionLabel, else the name", () => {
  assert.equal(line(DECK, { context: { docName: "Thermo formulas", sectionLabel: "Verbs", pageIndex: null, pageLabel: null } }), "Thermo formulas · Verbs");
  assert.equal(line(DECK, { context: { docName: "Thermo formulas", sectionLabel: null, pageIndex: null, pageLabel: null } }), "Thermo formulas");
  assert.equal(line(DECK, { context: null }), "Thermo formulas");
  assert.equal(line(DECK, null), "Thermo formulas");
});

test("line: the live collection name wins over a stale snapshot; snapshot used without a collection", () => {
  const p = { context: { docName: "Old name", sectionLabel: "Ch. 2 · Formalism", pageIndex: 40, pageLabel: "41" } };
  assert.equal(line({ ...BOOK, name: "Griffiths QM" }, p), "Griffiths QM · Ch. 2 · Formalism");
  assert.equal(line(null, p), "Old name · Ch. 2 · Formalism");
  assert.equal(line(null, { context: { docName: "Old name", sectionLabel: null, pageIndex: 40, pageLabel: "41" } }), "Old name · p. 41");
  assert.equal(line(null, null), "");
});

test("line: overflow rule drops the level-2 part first, then middle-ellipsises", () => {
  const full = "Ch. 1 · The Wave Function · §1.1 The Schrödinger Equation";
  const p = { context: { docName: "Griffiths", sectionLabel: full, pageIndex: 11, pageLabel: "12" } };
  assert.ok(("Griffiths · " + full).length > 64, "the fixture really overflows");
  assert.equal(line(BOOK, p), "Griffiths · Ch. 1 · The Wave Function");

  // dropping the level-2 part is not enough: middle ellipsis to 64
  const longChapter = "Ch. 12 · Afterword: The Interpretation of Quantum Mechanics in Everyday Life";
  const p2 = { context: { docName: "Introduction to Quantum Mechanics", sectionLabel: longChapter + " · §12.3 Many worlds", pageIndex: 300, pageLabel: "301" } };
  const out = line(BOOK, p2);
  assert.ok(Array.from(out).length <= 64, "fits in 64 characters");
  assert.ok(out.includes("…"), "middle ellipsis");
  assert.ok(out.startsWith("Griffiths · Ch. 12 · Afterword"), "keeps the head");
  assert.ok(out.endsWith("Everyday Life"), "keeps the tail");
  assert.ok(!out.includes("§12.3"), "the level-2 part is gone");

  // a line with no level-2 part is never shortened by segment dropping, only by the ellipsis
  const p3 = { context: { docName: "Griffiths", sectionLabel: longChapter, pageIndex: 300, pageLabel: "301" } };
  const out3 = line(BOOK, p3);
  assert.ok(Array.from(out3).length <= 64);
  assert.ok(out3.startsWith("Griffiths · Ch. 12 · Afterword"));
  assert.ok(out3.endsWith("Everyday Life"));
});

// ------------------------------------------------------------------ fit

test("fit: short lines untouched, exact limit untouched, custom max", () => {
  assert.equal(fit("Griffiths · Ch. 1 · The Wave Function"), "Griffiths · Ch. 1 · The Wave Function");
  const exact = "x".repeat(64);
  assert.equal(fit(exact), exact);
  const over = "x".repeat(65);
  const out = fit(over);
  assert.equal(Array.from(out).length, 64);
  assert.equal(out, "x".repeat(32) + "…" + "x".repeat(31));
  assert.equal(fit("abcdefghij", 5), "ab…ij");
  assert.equal(fit("abcdefghij", 1), "…");
  assert.equal(fit("  spaced   out  "), "spaced out");
  assert.equal(fit(null), "");
});

test("fit: recognises the level-2 part with and without a § marker", () => {
  const withSection = "Griffiths · Ch. 1 · The Wave Function · §1.1 The Schrödinger Equation";
  assert.equal(fit(withSection), "Griffiths · Ch. 1 · The Wave Function");
  const partChapter = "Griffiths · Part I: Theory · Chapter 1: The Wave Function and the Rest";
  assert.ok(partChapter.length > 64);
  assert.equal(fit(partChapter), "Griffiths · Part I: Theory");
  // "Ch. N · Title" is one level-1 label: a third segment after it is not dropped
  const chapterOnly = "Griffiths · Ch. 12 · A chapter title that is long enough to overflow the line";
  const out = fit(chapterOnly);
  assert.ok(out.includes("…"));
  assert.ok(out.startsWith("Griffiths · Ch. 12 · A chapter"));
  // when dropping the level-2 part is not enough, the shortened line is ellipsised
  const twoLong = "A rather long document nickname here · A very long level one label that overflows by itself · §9.9 Tail";
  const out2 = fit(twoLong);
  assert.ok(Array.from(out2).length <= 64);
  assert.ok(!out2.includes("§9.9"));
  assert.ok(out2.includes("…"));
});

// ------------------------------------------------------------------ contextFor

test("contextFor: book snapshot from the anchor, page label from the argument, the record or the index", () => {
  const prompt = { anchor: { pageIndex: 11, pages: [], quote: "", y: 0 }, context: null };
  assert.deepEqual(contextFor(BOOK, prompt, "12"), {
    docName: "Griffiths", sectionLabel: "Ch. 1 · The Wave Function · §1.1 The Schrödinger Equation", pageIndex: 11, pageLabel: "12"
  });
  // no argument: the collection's page labels when present
  const labels = ["i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x", "xi", "xii"];
  assert.equal(contextFor({ ...BOOK, pageLabels: labels }, prompt).pageLabel, "xii");
  // no labels: keep the old snapshot's label when the page is unchanged
  const withOld = { ...prompt, context: { docName: "Griffiths", sectionLabel: null, pageIndex: 11, pageLabel: "xii" } };
  assert.equal(contextFor(BOOK, withOld).pageLabel, "xii");
  // page changed: default to pageIndex + 1
  const moved = { anchor: { pageIndex: 20 }, context: { docName: "Griffiths", sectionLabel: null, pageIndex: 11, pageLabel: "xii" } };
  assert.deepEqual(contextFor(BOOK, moved), {
    docName: "Griffiths", sectionLabel: "Ch. 1 · The Wave Function · §1.2 Normalization", pageIndex: 20, pageLabel: "21"
  });
  // a numeric page label argument is stringified
  assert.equal(contextFor(BOOK, prompt, 12).pageLabel, "12");
});

test("contextFor: a book prompt without an anchor keeps the snapshot's page; nothing known → nulls", () => {
  const imported = { anchor: null, context: { docName: "Elsewhere", sectionLabel: "stale", pageIndex: 14, pageLabel: "15" } };
  assert.deepEqual(contextFor(BOOK, imported), {
    docName: "Griffiths", sectionLabel: "Ch. 1 · The Wave Function · §1.2 Normalization", pageIndex: 14, pageLabel: "15"
  });
  assert.deepEqual(contextFor(BOOK, { anchor: null, context: null }), { docName: "Griffiths", sectionLabel: null, pageIndex: null, pageLabel: null });
  assert.deepEqual(contextFor({ kind: "book", name: "Bare" }, { anchor: { pageIndex: 3 } }), { docName: "Bare", sectionLabel: null, pageIndex: 3, pageLabel: "4" });
});

test("contextFor: deck prompts keep a # Section label, drop a book chapter label on move, follow renames", () => {
  // batch-created deck prompt
  const fresh = { anchor: null, context: { sectionLabel: "Verbs" } };
  assert.deepEqual(contextFor(DECK, fresh), { docName: "Thermo formulas", sectionLabel: "Verbs", pageIndex: null, pageLabel: null });
  // recontext after a rename keeps the section
  const renamed = { ...DECK, name: "German verbs" };
  const existing = { anchor: null, context: { docName: "Thermo formulas", sectionLabel: "Verbs", pageIndex: null, pageLabel: null } };
  assert.deepEqual(contextFor(renamed, existing), { docName: "German verbs", sectionLabel: "Verbs", pageIndex: null, pageLabel: null });
  // moved from a book: the chapter label (a snapshot with a pageIndex) is dropped
  const movedIn = { anchor: null, context: { docName: "Griffiths", sectionLabel: "Ch. 1 · The Wave Function", pageIndex: 11, pageLabel: "12" } };
  assert.deepEqual(contextFor(DECK, movedIn), { docName: "Thermo formulas", sectionLabel: null, pageIndex: null, pageLabel: null });
  // no section at all
  assert.deepEqual(contextFor(DECK, { anchor: null, context: null }), { docName: "Thermo formulas", sectionLabel: null, pageIndex: null, pageLabel: null });
  // the snapshot round-trips through line()
  assert.equal(line(DECK, { context: contextFor(DECK, fresh) }), "Thermo formulas · Verbs");
});

test("contextFor: never mutates its inputs", () => {
  const prompt = { anchor: { pageIndex: 11 }, context: { docName: "x", sectionLabel: "y", pageIndex: 1, pageLabel: "2" } };
  const before = JSON.stringify(prompt);
  const col = { ...BOOK };
  contextFor(col, prompt, "12");
  assert.equal(JSON.stringify(prompt), before);
  assert.deepEqual(col, BOOK);
});

/* SELF-CHECK: covers SPEC §12 context bullets — normalizeTitle (four examples), labelFor (deepest item,
 * manual wins on its page, chapter + section composition), line() overflow rule, p. xii fallback —
 * plus sectionsFromOutline, fit, sectionLabelFor and contextFor. */
