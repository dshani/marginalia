// node --test test/library.test.js — M.library loads without a DOM; its pure helpers follow SPEC §11, §14, §7
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const library = require(path.join(__dirname, "..", "js", "library.js"));
const keys = require(path.join(__dirname, "..", "js", "keys.js"));
const P = library._pure;

test("loads in node with no DOM and registers M.library", () => {
  assert.equal(typeof window, "undefined");
  assert.ok(globalThis.Marginalia && globalThis.Marginalia.library === library);
});

test("every §17.2 / BUILD-NOTES contract function exists", () => {
  for (const name of ["render", "openDeck", "createDeck", "renameCollection", "deleteCollection", "addPdf", "openSettings",
    "addPdfFromUrl", "closeSettings", "activeEditor"]) {
    assert.equal(typeof library[name], "function", name);
  }
});

test("DOM entry points are safe no-ops without a document", async () => {
  assert.equal(library.render(), false);
  assert.equal(library.openDeck("deck_x"), false);
  assert.equal(library.openSettings("data"), false);
  assert.equal(library.closeSettings(), false);
  assert.equal(library.activeEditor(), null);
  await assert.rejects(library.addPdf({ arrayBuffer() { return Promise.resolve(new ArrayBuffer(0)); }, name: "a.pdf", size: 1 }), (e) => e.code === "no_dom");
  await assert.rejects(library.addPdfFromUrl("test/sample.pdf"), (e) => e.code === "no_dom");
  await assert.rejects(library.createDeck("   "), (e) => e.code === "bad_name");
});

test("nickname rule (SPEC §14): sane title, else file name without extension cut to 24", () => {
  assert.equal(P.nicknameFor({ Title: "Introduction to Quantum Mechanics" }, "griffiths.pdf"), "Introduction to Quantum Mechanics");
  assert.equal(P.nicknameFor({ Title: "  Spaced   out  " }, "x.pdf"), "Spaced out");
  assert.equal(P.nicknameFor({ Title: "griffiths.pdf" }, "griffiths.pdf"), "griffiths");
  assert.equal(P.nicknameFor({ Title: "Untitled" }, "My Notes File.pdf"), "My Notes File");
  assert.equal(P.nicknameFor({ Title: "ab" }, "/tmp/thermo.pdf"), "thermo");
  assert.equal(P.nicknameFor({ Title: "x".repeat(81) }, "a_very_long_file_name_with_many_words_indeed.pdf"), "a very long file name wi");
  assert.equal(P.nicknameFor({ Title: "Microsoft Word - thesis.doc" }, "thesis.pdf"), "thesis");
  assert.equal(P.nicknameFor({ Title: "bad\u0001title" }, "ok.pdf"), "ok");
  assert.equal(P.nicknameFor(null, "folder/sub/chapter-1.PDF"), "chapter-1");
  assert.equal(P.nicknameFor({}, ""), "Untitled");
  assert.equal(P.saneTitle("The Wave Function"), true);
  assert.equal(P.saneTitle("notes.tex"), false);
});

test("mergeSections keeps the record's manual marks and sorts stably by page", () => {
  const outline = [{ title: "2 B", label: "Ch. 2 · B", pageIndex: 20, level: 1 }, { title: "1 A", label: "Ch. 1 · A", pageIndex: 5, level: 1 }];
  const existing = [{ title: "old", label: "old", pageIndex: 7, level: 1, source: "outline" }, { title: "Mine", label: "Mine", pageIndex: 7, level: 1, source: "manual" }];
  const merged = P.mergeSections(outline, existing);
  assert.deepEqual(merged.map((s) => [s.pageIndex, s.source]), [[5, "outline"], [7, "manual"], [20, "outline"]]);
  assert.deepEqual(P.mergeSections([], null), []);
});

test("rows: live collections sorted by lastOpenedAt desc; meta lines", () => {
  const cols = [
    { id: "a", kind: "book", name: "A", lastOpenedAt: 10, addedAt: 1 },
    { id: "b", kind: "book", name: "B", lastOpenedAt: 30, addedAt: 2 },
    { id: "c", kind: "deck", name: "C", lastOpenedAt: 20, addedAt: 3 },
    { id: "d", kind: "deck", name: "D", lastOpenedAt: 99, addedAt: 4, deletedAt: 5 }
  ];
  assert.deepEqual(P.sortCollections(cols).map((c) => c.id), ["b", "c", "a"]);
  assert.equal(P.bookMeta({ pageCount: 322, lastPosition: { pageIndex: 35 } }, { prompts: 41, due: 7 }), "322 pp · 41 prompts · 7 due · p. 36");
  assert.equal(P.bookMeta({ pageCount: 10, pageLabels: ["i", "ii", "1"], lastPosition: { pageIndex: 1 }, hasBytes: false }, { prompts: 1, due: 0 }), "10 pp · 1 prompt · 0 due · p. ii · PDF not in library");
  assert.equal(P.deckMeta({ prompts: 18, due: 3 }), "18 prompts · 3 due");
  assert.equal(P.deckCountsText({}, { prompts: 2, due: 0, nextDueAt: Date.now() + 86400000 }), "2 prompts · 0 due · next due tomorrow");
});

test("duplicate decision (SPEC §11)", () => {
  const ctx = { fingerprint: "fp1", sha256: "sha-new" };
  const same = { id: "fp1", kind: "book", sha256: "sha-new", hasBytes: true };
  const other = { id: "fp1", kind: "book", sha256: "sha-old", hasBytes: true };
  assert.deepEqual(P.decideDuplicate(ctx, [], null), { action: "new", id: "fp1" });
  assert.deepEqual(P.decideDuplicate(ctx, [same], null), { action: "reopen", existing: same });
  const noBytes = Object.assign({}, same, { hasBytes: false });
  assert.deepEqual(P.decideDuplicate(ctx, [noBytes], null), { action: "restoreBytes", existing: noBytes });
  assert.deepEqual(P.decideDuplicate(ctx, [other], null), { action: "ask", existing: other, separateId: "fp1:sha-new" });
  const imported = { id: "other-id", kind: "book", sha256: "sha-new", hasBytes: false };
  assert.deepEqual(P.decideDuplicate(ctx, [imported], null), { action: "restoreBytes", existing: imported });
  assert.deepEqual(P.decideDuplicate(ctx, [other], "fp1"), { action: "replace", existing: other });
  const tomb = Object.assign({}, same, { deletedAt: 5 });
  assert.deepEqual(P.decideDuplicate(ctx, [tomb], null), { action: "new", id: "fp1" });
  const deck = { id: "fp1", kind: "deck", sha256: "sha-new" };
  assert.deepEqual(P.decideDuplicate(ctx, [deck], null), { action: "new", id: "fp1" });
});

test("bookRecord: a new book vs a replaced file (nickname, manual marks and position kept)", () => {
  const ctx = { info: { Title: "Introduction to Quantum Mechanics" }, fileName: "griffiths.pdf", sha256: "9f2a", hashAlgo: "sha-256",
    bytes: new Uint8Array(10), numPages: 322, pageLabels: null, sections: [{ title: "1 A", label: "Ch. 1 · A", pageIndex: 10, level: 1, source: "outline" }] };
  const fresh = P.bookRecord(ctx, "fp1", null, 1000);
  assert.equal(fresh.id, "fp1");
  assert.equal(fresh.kind, "book");
  assert.equal(fresh.name, "Introduction to Quantum Mechanics");
  assert.equal(fresh.title, "Introduction to Quantum Mechanics");
  assert.equal(fresh.fileName, "griffiths.pdf");
  assert.equal(fresh.sha256, "9f2a");
  assert.equal(fresh.hashAlgo, "sha-256");
  assert.equal(fresh.byteLength, 10);
  assert.equal(fresh.pageCount, 322);
  assert.equal(fresh.hasBytes, false);
  assert.deepEqual(fresh.lastPosition, { pageIndex: 0, fraction: 0, zoom: "fit" });
  assert.equal(fresh.sections.length, 1);
  assert.equal(fresh.addedAt, 1000);
  assert.equal(fresh.deletedAt, null);
  assert.equal(fresh.v, 1);
  const existing = { id: "fp1", kind: "book", name: "Griffiths", addedAt: 5, hasBytes: true, chunkCount: 7, lastPosition: { pageIndex: 35, fraction: .4, zoom: "fit" },
    sections: [{ title: "Mine", label: "Mine", pageIndex: 3, level: 1, source: "manual" }], deletedAt: null };
  const rep = P.bookRecord(ctx, "fp1", existing, 2000);
  assert.equal(rep.name, "Griffiths");
  assert.equal(rep.addedAt, 5);
  assert.equal(rep.lastOpenedAt, 2000);
  assert.deepEqual(rep.lastPosition, existing.lastPosition);
  assert.deepEqual(rep.sections.map((s) => s.source), ["manual", "outline"]);
  const shrunk = P.bookRecord(Object.assign({}, ctx, { numPages: 20 }), "fp1", existing, 2000);
  assert.deepEqual(shrunk.lastPosition, { pageIndex: 0, fraction: 0, zoom: "fit" });
});

test("review shortcuts: the edited action keeps the key, the duplicate becomes unbound; presets", () => {
  const def = Object.assign({}, keys.PRESETS.Default);
  assert.equal(P.presetName(def), "Default");
  assert.equal(P.presetName(Object.assign({}, def, { exit: "Esc" })), "Default");       // canonical comparison
  assert.equal(P.presetName(keys.PRESETS.Arrows), "Arrows");
  const r = P.applyBinding(def, "skip", "1");
  assert.equal(r.map.skip, "1");
  assert.equal(r.map.forgot, null);
  assert.deepEqual(r.conflicted, ["forgot"]);
  assert.equal(P.presetName(r.map), null);
  const r2 = P.applyBinding(r.map, "forgot", "ArrowLeft");
  assert.equal(r2.map.forgot, "ArrowLeft");
  assert.deepEqual(r2.conflicted, []);
  assert.equal(P.sameBinding("Space", " "), true);
  assert.equal(P.sameBinding("Shift+r", "Shift+R"), true);
  assert.equal(P.sameBinding("1", "2"), false);
  assert.equal(P.sameBinding(null, "1"), false);
  assert.equal(P.sameBinding({ binding: "u" }, "u"), true);
});

test("small helpers: tabs, url file names, pdf sniffing, fingerprints, storage line", () => {
  assert.equal(P.normalizeTab("Review shortcuts"), "shortcuts");
  assert.equal(P.normalizeTab("latex"), "latex");
  assert.equal(P.normalizeTab("export"), "data");
  assert.equal(P.normalizeTab(undefined), "appearance");
  assert.equal(P.fileNameFromUrl("test/sample.pdf?x=1#y"), "sample.pdf");
  assert.equal(P.fileNameFromUrl("https://h/a/b/My%20Book"), "My Book.pdf");
  assert.equal(P.fileNameFromUrl(""), "document.pdf");
  assert.equal(P.isPdfFile({ type: "application/pdf", name: "x" }), true);
  assert.equal(P.isPdfFile({ type: "", name: "x.PDF" }), true);
  assert.equal(P.isPdfFile({ type: "image/png", name: "x.png" }), false);
  assert.equal(P.looksLikePdf(new TextEncoder().encode("junk\n%PDF-1.7\n")), true);
  assert.equal(P.looksLikePdf(new TextEncoder().encode("hello")), false);
  assert.equal(P.fingerprintOf({ fingerprint: "abc" }), "abc");
  assert.equal(P.fingerprintOf({ fingerprints: ["abc", null] }), "abc");
  assert.equal(P.fingerprintOf({}), "");
  assert.equal(P.storageLine({ usage: 64000000, quota: 2000000000, persisted: true }), "61 MB used of 1.9 GB · persistent");
  assert.equal(P.storageLine({ usage: 1024, quota: null, persisted: false }), "1 KB used · not persistent");
  assert.equal(P.storageLine(null), "Storage usage unknown");
});

test("Replace file, keep prompts: only quoted passages and anchors past the new end are lost (SPEC §5, §11)", () => {
  const note = (pageIndex, lost) => ({ pageIndex, pages: [], quote: "", y: 500, lost: !!lost });
  assert.equal(P.lostAfterReplace(note(11), 40), false, "a free note sits at its y");
  assert.equal(P.lostAfterReplace(note(11, true), 40), false, "and comes back when its page exists again");
  assert.equal(P.lostAfterReplace(note(39), 40), false);
  assert.equal(P.lostAfterReplace(note(40), 40), true, "pageIndex ≥ pageCount");
  const passage = { pageIndex: 4, pages: [{ pageIndex: 4, rects: [[1, 2, 3, 4]] }], quote: "a potential energy function", lost: false };
  assert.equal(P.lostAfterReplace(passage, 40), true, "re-found lazily by quote");
  assert.equal(P.lostAfterReplace(Object.assign({}, passage, { quote: "   " }), 40), false, "nothing to re-find");
  assert.equal(P.lostAfterReplace(note(5), 0), false, "an unknown page count marks nothing");
  assert.equal(P.lostAfterReplace(null, 40), false);
});

test("book ⋯ menu marks: manual marks only, removal and its undo keep page order (SPEC §14)", () => {
  const outline = { title: "1 A", label: "Ch. 1 · A", pageIndex: 5, level: 1, source: "outline" };
  const mine = { title: "Ch. 3 · Formalism", label: "Ch. 3 · Formalism", pageIndex: 39, level: 1, source: "manual" };
  const other = { title: "Appendix", label: "Appendix", pageIndex: 80, level: 1, source: "manual" };
  assert.deepEqual(P.manualMarks([outline, mine, null, other]), [mine, other]);
  assert.deepEqual(P.manualMarks(undefined), []);
  const without = P.withoutMark([outline, mine, other], Object.assign({}, mine));
  assert.deepEqual(without, [outline, other]);
  assert.deepEqual(P.withoutMark([outline], mine), [outline], "an outline item is never removed");
  const back = P.withMark(without, mine);
  assert.deepEqual(back.map((s) => s.pageIndex), [5, 39, 80]);
  const replaced = P.withMark([outline, Object.assign({}, mine, { label: "Wrong" }), other], mine);
  assert.deepEqual(replaced.map((s) => s.label), ["Ch. 1 · A", "Ch. 3 · Formalism", "Appendix"], "a manual mark on that page is replaced");
  assert.equal(P.markMenuLabel(mine, null), "Remove mark “Ch. 3 · Formalism” · p. 40");
  assert.equal(P.markMenuLabel(mine, Object.assign(new Array(40).fill(""), { 39: "28" })), "Remove mark “Ch. 3 · Formalism” · p. 28");
  assert.equal(P.markMenuLabel({ label: "x".repeat(50), pageIndex: 0, source: "manual" }, null), "Remove mark “" + "x".repeat(40) + "…” · p. 1");
});
