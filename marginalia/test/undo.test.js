"use strict";
// test/undo.test.js — DECISIONS D33 (BUILD-NOTES "Undo and redo"): undo and redo for cards.
// M.cache hands M.undo a step when a writer gets opts.step; M.undo.undo() / redo() write through
// M.cache.revertPrompts, which refuses a prompt that is no longer in the state the step left it in, and changes and
// stores the prompts of one entry all together or not at all.
// Real util, bus, settings, scheduler, prompts, context, store (memory backend), cache and undo. Run: node --test
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const js = (name) => path.join(__dirname, "..", "js", name + ".js");
["util", "bus", "settings", "scheduler", "prompts", "context", "store", "cache", "undo"].forEach((n) => require(js(n)));
const M = globalThis.Marginalia;
const C = M.cache, U = M.undo, P = M.prompts;
const DAY = 86400000;
const STEP = { content: true, step: true };

// what the page gives M.undo: notices, the focus owner, the writer role
const page = { toasts: [], owner: "reader", role: true, asked: 0 };
M.app = {
  toast(opts) { page.toasts.push(opts); return { close() {} }; },
  focusOwner() { return page.owner; },
  takeRole() { page.asked++; return Promise.resolve(page.role); }
};
const events = [];
["prompt:saved", "prompt:deleted", "prompt:restored"].forEach((type) => M.bus.on(type, (e) => events.push({ type, id: e.promptId || (e.prompt && e.prompt.id) })));

let seq = 0;
// a record as the views build it (js/margin.js buildRecord, js/reader.js saveHighlight): a new object each time
function fresh(text, extra) {
  const parsed = P.parse(text), t = Date.now(), n = ++seq;
  return Object.assign({
    id: "u_" + n, collectionId: "bk_u", kind: parsed.kind, text, tags: parsed.tags.slice(), flagged: false,
    anchor: { quote: "the passage of card " + n, prefix: "before ", suffix: " after", pageIndex: 2, pages: [{ pageIndex: 2, rects: [[10, 20, 30, 40]] }] },
    context: { docName: "Undo book", sectionLabel: null, pageIndex: 2, pageLabel: "3" },
    cards: P.reconcileCards(null, parsed, t).cards, createdAt: t, contentUpdatedAt: t, updatedAt: t, deletedAt: null, v: 1
  }, extra || {});
}
// an edit as the editors save it: a copy of the cached record with the new text and the reconciled cards
function edited(id, text) {
  const p = C.prompt(id), parsed = P.parse(text);
  return Object.assign({}, p, { text, kind: parsed.kind, tags: parsed.tags.slice(), cards: P.reconcileCards(p, parsed, Date.now()).cards });
}
const copy = (v) => JSON.parse(JSON.stringify(v));
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 3));
const isLive = (id) => { const p = C.prompt(id); return !!p && p.deletedAt === null; };
function reset() { U.clear(); page.toasts.length = 0; page.owner = "reader"; page.role = true; page.asked = 0; events.length = 0; }
// a review answer, as js/review.js stores it: the card's schedule changes, with {content: false} and no step
async function answer(id, i) {
  const p = C.prompt(id), cards = p.cards.map((c) => Object.assign({}, c));
  const t = Date.now();
  cards[i || 0] = Object.assign({}, cards[i || 0], { lastReviewedAt: t, intervalMs: 5 * DAY, dueAt: t + 5 * DAY,
    log: (cards[i || 0].log || []).concat([{ at: t, outcome: "remembered", intervalMs: 5 * DAY, dueAt: t + 5 * DAY }]) });
  return C.savePrompt(Object.assign({}, p, { cards }), { content: false });
}

test.before(async () => {
  await C.load();
  await C.saveCollection({ id: "bk_u", kind: "book", name: "Undo book", sections: [{ pageIndex: 0, label: "One" }, { pageIndex: 5, label: "Two" }] });
  await C.saveCollection({ id: "dk_u", kind: "deck", name: "Undo deck" });
});

/* ------------------------------------------------------------------ the steps of the writers */

test("a new prompt is a step: undo deletes it, redo brings it back", async () => {
  reset();
  const p = await C.savePrompt(fresh("Q. What does a step hold?\nA. The card before and after"), STEP);
  assert.deepEqual(U.size(), { undo: 1, redo: 0 });
  assert.equal(U.canUndo(), true);
  assert.equal(U.canRedo(), false);

  const r = await U.undo();
  assert.deepEqual({ ok: r.ok, action: r.action, label: r.label, ids: r.ids }, { ok: true, action: "undo", label: "New prompt", ids: [p.id] });
  assert.equal(isLive(p.id), false, "the new prompt is deleted (a tombstone, as a delete by hand leaves)");
  assert.ok(C.prompt(p.id), "the record stays in the cache");
  assert.deepEqual(U.size(), { undo: 0, redo: 1 });
  assert.deepEqual(events.map((e) => e.type), ["prompt:saved", "prompt:deleted"]);

  const gone = copy(C.prompt(p.id));
  assert.equal(gone.deletedAt, gone.updatedAt);
  await tick();
  const r2 = await U.redo();
  assert.equal(r2.ok, true);
  assert.equal(isLive(p.id), true);
  assert.equal(C.prompt(p.id).text, "Q. What does a step hold?\nA. The card before and after");
  assert.deepEqual(U.size(), { undo: 1, redo: 0 });
  assert.equal(events[events.length - 1].type, "prompt:restored");
  assert.ok(C.prompt(p.id).contentUpdatedAt > gone.updatedAt, "the prompt that is back outranks its deleted record in an import merge");
  assert.equal(C.prompt(p.id).contentUpdatedAt, C.prompt(p.id).updatedAt);
  assert.equal(typeof C.prompt(p.id).dueAt, "number", "and it is due again");
});

test("an edit: undo brings back the text, the kind, the tags and every card with its schedule; redo makes the edit again", async () => {
  reset();
  const p = await C.savePrompt(fresh("The {Aare} flows through {Bern}.\n#rivers"), { content: true });
  await answer(p.id, 1);                                    // the second blank has a history
  const before = copy(C.prompt(p.id));
  assert.equal(before.cards.length, 2);
  assert.equal(before.cards[1].log.length, 1);
  await tick();

  const after = copy(await C.savePrompt(edited(p.id, "Q. Which river flows through the city?\nA. The Aare\n#geo"), STEP));
  assert.equal(after.kind, "qa");
  assert.equal(after.cards.length, 1, "the edit dropped the second card");
  assert.equal(typeof after.revisedAt, "number", "the edit changed the text");
  assert.deepEqual(U.size(), { undo: 1, redo: 0 });
  assert.equal(U.peek("undo").label, "Edit");
  await tick();

  const r = await U.undo();
  assert.equal(r.ok, true);
  const back = C.prompt(p.id);
  assert.equal(back.text, before.text);
  assert.equal(back.kind, "cloze");
  assert.deepEqual(back.tags, ["rivers"]);
  assert.deepEqual(back.cards, before.cards, "both cards, each with its schedule and its history");
  assert.equal("revisedAt" in back, false, "the struggling count goes on as before the edit");
  assert.ok(back.contentUpdatedAt > after.contentUpdatedAt, "the undo is a person's change: it wins an import merge");
  assert.ok(back.updatedAt >= back.contentUpdatedAt);
  assert.equal(back.createdAt, before.createdAt);
  assert.equal(back.dueAt, Math.min(before.cards[0].dueAt, before.cards[1].dueAt), "dueAt follows the cards again");
  assert.equal(C.stateKey(back), C.stateKey(before));
  await tick();

  const r2 = await U.redo();
  assert.equal(r2.ok, true);
  const again = C.prompt(p.id);
  assert.equal(again.text, after.text);
  assert.equal(again.kind, "qa");
  assert.deepEqual(again.tags, ["geo"]);
  assert.deepEqual(again.cards, after.cards);
  assert.equal(again.revisedAt, after.revisedAt, "the time of the edit itself");
  assert.equal(C.stateKey(again), C.stateKey(after));
  assert.deepEqual(U.size(), { undo: 1, redo: 0 });
});

test("after an undo the cache compares later saves with the state that came back", async () => {
  reset();
  const p = await C.savePrompt(fresh("Q. Before the edit?\nA. yes"), { content: true });
  await C.savePrompt(edited(p.id, "Q. After the edit?\nA. yes"), STEP);
  await tick();
  assert.equal((await U.undo()).ok, true);
  const back = copy(C.prompt(p.id));
  assert.equal("revisedAt" in back, false);
  await tick();
  // a save that changes nothing a person edits (a found position): contentUpdatedAt and revisedAt stay
  await C.savePrompt(Object.assign({}, C.prompt(p.id), { anchor: Object.assign({}, C.prompt(p.id).anchor, { pageIndex: 3 }) }), { content: true });
  assert.equal(C.prompt(p.id).contentUpdatedAt, back.contentUpdatedAt, "the content key is the one of the state that came back");
  assert.equal("revisedAt" in C.prompt(p.id), false, "and so is the text that the cache compares");
  // a real edit after it moves both
  await C.savePrompt(edited(p.id, "Q. A third wording?\nA. yes"), { content: true });
  assert.ok(C.prompt(p.id).contentUpdatedAt > back.contentUpdatedAt);
  assert.equal(typeof C.prompt(p.id).revisedAt, "number");
});

test("the views hear an undo and a redo of an edit as a save of the cached record", async () => {
  reset();
  const p = await C.savePrompt(fresh("Q. One?\nA. 1"), { content: true });
  await C.savePrompt(edited(p.id, "Q. Two?\nA. 2"), STEP);
  events.length = 0;
  await U.undo();
  assert.deepEqual(events, [{ type: "prompt:saved", id: p.id }]);
  assert.equal(C.prompt(p.id).text, "Q. One?\nA. 1");
});

test("a review answer after the step: undo refuses, writes nothing, and every entry of that card goes", async () => {
  reset();
  const p = await C.savePrompt(fresh("Q. Old wording?\nA. yes"), STEP);            // entry 1
  await C.savePrompt(edited(p.id, "Q. New wording?\nA. yes"), STEP);               // entry 2
  const other = await C.savePrompt(fresh("Q. Another card?\nA. yes"), STEP);       // entry 3
  await U.undo();                                                                   // entry 3 is in the redo list
  assert.deepEqual(U.size(), { undo: 2, redo: 1 });
  await answer(p.id, 0);
  const stored = copy(C.prompt(p.id));
  events.length = 0;
  page.toasts.length = 0;

  const r = await U.undo();
  assert.deepEqual({ ok: r.ok, reason: r.reason, ids: r.ids }, { ok: false, reason: "changed", ids: [p.id] });
  assert.deepEqual(copy(C.prompt(p.id)), stored, "nothing was written");
  assert.deepEqual(events, []);
  assert.deepEqual(U.size(), { undo: 0, redo: 1 }, "both entries of the card are gone; the other card's entry stays");
  assert.equal(page.toasts.length, 1);
  assert.equal(page.toasts[0].text, "Not undone: the card changed after that step.");
  assert.equal(page.toasts[0].detail, "Edit · “New wording?”");
  assert.equal(page.toasts[0].actions, undefined);
  assert.equal((await U.redo()).ok, true, "the other card's step still runs");
  assert.equal(isLive(other.id), true);
});

test("the Obsidian send record stays through undo and redo, and the card counts as edited since its send", async () => {
  reset();
  const p = await C.savePrompt(fresh("Q. Sent wording?\nA. yes"), { content: true });
  await C.savePrompt(edited(p.id, "Q. Edited wording?\nA. yes"), STEP);
  await tick();
  const sentAt = Date.now();
  await C.patchPrompts([{ id: p.id, fields: { obsidianSentAt: sentAt, obsidianFile: "Notes/Marginalia/Undo book.md", obsidianPendingFile: "Notes/Marginalia/Undo book.md" } }]);
  await tick();

  assert.equal((await U.undo()).ok, true, "a send is no change of the card's state");
  let now = C.prompt(p.id);
  assert.equal(now.text, "Q. Sent wording?\nA. yes");
  assert.equal(now.obsidianSentAt, sentAt);
  assert.equal(now.obsidianFile, "Notes/Marginalia/Undo book.md");
  assert.equal(now.obsidianPendingFile, "Notes/Marginalia/Undo book.md");
  assert.ok(now.contentUpdatedAt > now.obsidianSentAt, "edited since the last send: Update in Obsidian replaces the copy");

  await C.patchPrompts([{ id: p.id, fields: { obsidianPendingFile: undefined } }]);
  assert.equal((await U.redo()).ok, true);
  now = C.prompt(p.id);
  assert.equal(now.text, "Q. Edited wording?\nA. yes");
  assert.equal(now.obsidianSentAt, sentAt);
  assert.equal("obsidianPendingFile" in now, false, "the field as the record had it when the redo ran");
});

test("a found position does not stop an undo, and the newer position stays", async () => {
  reset();
  const p = await C.savePrompt(fresh("Q. Where is it?\nA. on page 3"), { content: true });
  await C.savePrompt(edited(p.id, "Q. Where is it now?\nA. on page 4"), STEP);
  // js/reader.js refindPrompt: the passage was found on another page; the cached record itself is changed and saved
  const cached = C.prompt(p.id);
  cached.anchor = Object.assign({}, cached.anchor, { pageIndex: 3, pages: [{ pageIndex: 3, rects: [[1, 2, 3, 4]] }], lost: false });
  cached.context = Object.assign({}, cached.context, { pageIndex: 3, pageLabel: "4" });
  await C.savePrompt(cached, { content: true });
  assert.deepEqual(U.size(), { undo: 1, redo: 0 }, "the found position is no step");

  assert.equal((await U.undo()).ok, true);
  const back = C.prompt(p.id);
  assert.equal(back.text, "Q. Where is it?\nA. on page 3");
  assert.equal(back.anchor.pageIndex, 3, "the position of the passage as it was found");
  assert.equal(back.context.pageLabel, "4");
});

test("delete, then Z (a restore by hand): the delete is undone, and redo deletes again", async () => {
  reset();
  const p = await C.savePrompt(fresh("Q. Deleted by mistake?\nA. yes"), { content: true });
  await C.removePrompt(p.id, { step: true });
  assert.equal(isLive(p.id), false);
  assert.deepEqual(U.size(), { undo: 1, redo: 0 });
  assert.equal(U.peek("undo").label, "Delete");

  await C.restorePrompt(p.id, { step: true });              // the margin's and the list's Z
  assert.equal(isLive(p.id), true);
  assert.deepEqual(U.size(), { undo: 0, redo: 1 }, "the hand-made restore counts as the undo of the delete");

  assert.equal((await U.redo()).ok, true);
  assert.equal(isLive(p.id), false);
  assert.equal((await U.undo()).ok, true);
  assert.equal(isLive(p.id), true);
  assert.equal(C.prompt(p.id).text, "Q. Deleted by mistake?\nA. yes");
});

test("a restore that is not the newest step's way back is a step of its own", async () => {
  reset();
  const a = await C.savePrompt(fresh("Q. First?\nA. 1"), { content: true });
  const b = await C.savePrompt(fresh("Q. Second?\nA. 2"), { content: true });
  await C.removePrompt(a.id, { step: true });
  await C.savePrompt(Object.assign({}, C.prompt(b.id), { flagged: true }), STEP);
  await C.restorePrompt(a.id, { step: true });
  assert.deepEqual(U.size(), { undo: 3, redo: 0 });
  assert.equal(U.peek("undo").label, "Restore");
  assert.equal((await U.undo()).ok, true);
  assert.equal(isLive(a.id), false, "undo of the restore");
});

test("flag is a step; the same key again takes it back", async () => {
  reset();
  const p = await C.savePrompt(fresh("Q. Flag me?\nA. yes"), { content: true });
  const at = C.prompt(p.id).revisedAt;
  await C.savePrompt(Object.assign({}, C.prompt(p.id), { flagged: true }), STEP);
  assert.equal(U.peek("undo").label, "Flag");
  assert.equal((await U.undo()).ok, true);
  assert.equal(C.prompt(p.id).flagged, false);
  assert.equal(C.prompt(p.id).revisedAt, at, "a flag never moves revisedAt, and neither does its undo");
  assert.equal((await U.redo()).ok, true);
  assert.equal(C.prompt(p.id).flagged, true);

  await C.savePrompt(Object.assign({}, C.prompt(p.id), { flagged: false }), STEP);   // F again, by hand
  assert.deepEqual(U.size(), { undo: 0, redo: 1 }, "back where the flag began: the flag is undone");
  assert.equal(U.peek("redo").label, "Flag");
});

test("Move to a deck: undo puts the prompt back into its book, with its passage and its context", async () => {
  reset();
  const p = await C.savePrompt(fresh("Q. Where do I live?\nA. in the book"), { content: true });
  const before = copy(C.prompt(p.id));
  // js/margin.js moveTo and js/list.js movePrompt: a copy with the deck's id, no anchor and the deck's context
  await C.savePrompt(Object.assign({}, C.prompt(p.id), { collectionId: "dk_u", anchor: null,
    context: { docName: "Undo deck", sectionLabel: null, pageIndex: null, pageLabel: null } }), STEP);
  assert.equal(U.peek("undo").label, "Move");
  assert.equal(C.prompt(p.id).collectionId, "dk_u");

  assert.equal((await U.undo()).ok, true);
  const back = C.prompt(p.id);
  assert.equal(back.collectionId, "bk_u");
  assert.deepEqual(back.anchor, before.anchor);
  assert.deepEqual(back.context, { docName: "Undo book", sectionLabel: "One", pageIndex: 2, pageLabel: "3" }, "computed again for the book as it is now");
  assert.deepEqual(back.cards, before.cards, "the schedule is kept");

  assert.equal((await U.redo()).ok, true);
  assert.equal(C.prompt(p.id).collectionId, "dk_u");
  assert.equal(C.prompt(p.id).anchor, null);
  assert.equal(C.prompt(p.id).context.docName, "Undo deck");
});

test("a move from one deck to another: undo gives the prompt its first deck's context again, with its section", async () => {
  reset();
  await C.saveCollection({ id: "dk_u2", kind: "deck", name: "Second deck" });
  const first = { docName: "Undo deck", sectionLabel: "Rivers", pageIndex: null, pageLabel: null };
  const p = await C.savePrompt(fresh("Q. Which deck?\nA. the first", { collectionId: "dk_u", anchor: null, context: first }), { content: true });
  // js/list.js movePrompt between decks: no anchor on either side, the section's name goes along
  await C.savePrompt(Object.assign({}, C.prompt(p.id), { collectionId: "dk_u2", anchor: null,
    context: { docName: "Second deck", sectionLabel: "Rivers", pageIndex: null, pageLabel: null } }), STEP);
  assert.equal(C.prompt(p.id).context.docName, "Second deck");
  assert.equal((await U.undo()).ok, true);
  assert.equal(C.prompt(p.id).collectionId, "dk_u");
  assert.deepEqual(C.prompt(p.id).context, first);
  assert.equal((await U.redo()).ok, true);
  assert.equal(C.prompt(p.id).context.docName, "Second deck");
  assert.equal(C.prompt(p.id).context.sectionLabel, "Rivers");
});

test("a prompt is never put back into a book or a deck that is deleted", async () => {
  reset();
  await C.saveCollection({ id: "bk_gone", kind: "book", name: "Gone book" });
  const p = await C.savePrompt(fresh("Q. Will the book stay?\nA. no", { collectionId: "bk_gone" }), { content: true });
  await C.savePrompt(Object.assign({}, C.prompt(p.id), { collectionId: "dk_u", anchor: null,
    context: { docName: "Undo deck", sectionLabel: null, pageIndex: null, pageLabel: null } }), STEP);
  await C.removeCollection("bk_gone");
  const stored = copy(C.prompt(p.id));

  const r = await U.undo();
  assert.deepEqual({ ok: r.ok, reason: r.reason }, { ok: false, reason: "gone" });
  assert.deepEqual(copy(C.prompt(p.id)), stored, "nothing was written");
  assert.equal(page.toasts[page.toasts.length - 1].text, "Not undone: its book or deck is deleted.");
  assert.deepEqual(U.size(), { undo: 0, redo: 0 });
});

test("Anchor to selection: undo brings the old passage back", async () => {
  reset();
  const p = await C.savePrompt(fresh("Q. Which passage?\nA. the first"), { content: true });
  const before = copy(C.prompt(p.id));
  const anchor = { quote: "a passage on page 7", prefix: "", suffix: "", pageIndex: 6, pages: [{ pageIndex: 6, rects: [[5, 5, 9, 9]] }], lost: false };
  await C.savePrompt(Object.assign({}, C.prompt(p.id), { anchor, context: { docName: "Undo book", sectionLabel: "Two", pageIndex: 6, pageLabel: "7" } }), STEP);
  assert.equal(U.peek("undo").label, "Anchor change");
  assert.equal((await U.undo()).ok, true);
  assert.deepEqual(C.prompt(p.id).anchor, before.anchor);
  assert.equal(C.prompt(p.id).context.pageLabel, "3");
  assert.equal(C.prompt(p.id).context.sectionLabel, "One");
  assert.equal((await U.redo()).ok, true);
  assert.equal(C.prompt(p.id).anchor.quote, "a passage on page 7");
  assert.equal(C.prompt(p.id).context.sectionLabel, "Two");
});

test("Write prompt on a highlight is a new prompt; its undo leaves the highlight", async () => {
  reset();
  const hl = await C.savePrompt(fresh("", { kind: "highlight", cards: [] }), STEP);
  assert.equal(U.peek("undo").label, "New highlight");
  await C.savePrompt(edited(hl.id, "Q. What did I mark?\nA. this passage"), STEP);
  assert.equal(U.peek("undo").label, "New prompt");
  assert.equal(U.peek("undo").excerpt, "What did I mark?");
  assert.equal((await U.undo()).ok, true);
  assert.equal(C.prompt(hl.id).kind, "highlight");
  assert.equal(C.prompt(hl.id).text, "");
  assert.equal(isLive(hl.id), true);
  assert.equal("dueAt" in C.prompt(hl.id), false, "a highlight is never due: dueAt follows the kind and the cards");
  assert.equal(U.peek("undo").excerpt, "the passage of card " + hl.id.slice(2), "a highlight is named by its passage");
});

/* ------------------------------------------------------------------ groups, the lists and their limits */

test("the steps of one group are one entry: undo takes them all back, redo makes them all again", async () => {
  reset();
  const g = U.group(), made = [];
  for (const text of ["Q. One?\nA. 1", "Q. Two?\nA. 2", "Q. Three?\nA. 3"]) {
    made.push(await C.savePrompt(fresh(text, { collectionId: "dk_u", anchor: null, context: { docName: "Undo deck", sectionLabel: null, pageIndex: null, pageLabel: null } }), { content: true, step: g }));
  }
  assert.deepEqual(U.size(), { undo: 1, redo: 0 });
  assert.deepEqual(U.peek("undo"), { label: "3 new prompts", excerpt: "", where: "Undo deck" });

  const r = await U.undo();
  assert.equal(r.ok, true);
  assert.deepEqual(r.ids.slice().sort(), made.map((p) => p.id).sort());
  assert.deepEqual(made.map((p) => isLive(p.id)), [false, false, false]);
  assert.equal(page.toasts[page.toasts.length - 1].text, "3 new prompts undone");
  assert.equal((await U.redo()).ok, true);
  assert.deepEqual(made.map((p) => isLive(p.id)), [true, true, true]);
});

test("a group with one card that changed since is refused as a whole: nothing is written", async () => {
  reset();
  const g = U.group(), made = [];
  for (const text of ["Q. Four?\nA. 4", "Q. Five?\nA. 5"]) made.push(await C.savePrompt(fresh(text), { content: true, step: g }));
  await answer(made[0].id, 0);
  events.length = 0;
  const r = await U.undo();
  assert.deepEqual({ ok: r.ok, reason: r.reason, ids: r.ids }, { ok: false, reason: "changed", ids: [made[0].id] });
  assert.deepEqual(made.map((p) => isLive(p.id)), [true, true], "the card that did not change stays too");
  assert.deepEqual(events, []);
  assert.equal(page.toasts[page.toasts.length - 1].text, "Not undone: one of its cards changed after that step.");
  assert.deepEqual(U.size(), { undo: 0, redo: 0 });
});

test("two groups do not mix, and a step without a group ends a group", async () => {
  reset();
  const g1 = U.group(), g2 = U.group();
  await C.savePrompt(fresh("Q. g1 a?\nA. 1"), { content: true, step: g1 });
  await C.savePrompt(fresh("Q. g1 b?\nA. 1"), { content: true, step: g1 });
  await C.savePrompt(fresh("Q. g2 a?\nA. 2"), { content: true, step: g2 });
  await C.savePrompt(fresh("Q. alone?\nA. 3"), STEP);
  await C.savePrompt(fresh("Q. g2 b?\nA. 2"), { content: true, step: g2 });
  assert.deepEqual(U.size(), { undo: 4, redo: 0 }, "g1 (two prompts), g2, the single step, g2 again");
});

test("in a group one card is one change: a second step on it goes on from the first, and a way back leaves nothing", async () => {
  reset();
  const g = U.group();
  const p = await C.savePrompt(fresh("Q. Made in a group?\nA. yes"), { content: true, step: g });
  await C.savePrompt(edited(p.id, "Q. Made and edited in a group?\nA. yes"), { content: true, step: g });
  const q = await C.savePrompt(fresh("Q. A second card of the group?\nA. yes"), { content: true, step: g });
  assert.deepEqual(U.size(), { undo: 1, redo: 0 });
  assert.equal(U.peek("undo").label, "2 new prompts");
  assert.equal((await U.undo()).ok, true);
  assert.deepEqual([isLive(p.id), isLive(q.id)], [false, false]);
  assert.equal((await U.redo()).ok, true);
  assert.equal(C.prompt(p.id).text, "Q. Made and edited in a group?\nA. yes", "the card as the group left it");

  U.clear();
  const g2 = U.group(), r = await C.savePrompt(fresh("Q. Flag and unflag in a group?\nA. yes"), { content: true });
  await C.savePrompt(Object.assign({}, C.prompt(r.id), { flagged: true }), { content: true, step: g2 });
  assert.deepEqual(U.size(), { undo: 1, redo: 0 });
  await C.savePrompt(Object.assign({}, C.prompt(r.id), { flagged: false }), { content: true, step: g2 });
  assert.deepEqual(U.size(), { undo: 0, redo: 0 }, "the card is where it began: no step is left");
});

test("a new step empties the redo list", async () => {
  reset();
  const p = await C.savePrompt(fresh("Q. A?\nA. a"), STEP);
  await C.savePrompt(edited(p.id, "Q. B?\nA. b"), STEP);
  await U.undo();
  assert.deepEqual(U.size(), { undo: 1, redo: 1 });
  await C.savePrompt(edited(p.id, "Q. C?\nA. c"), STEP);
  assert.deepEqual(U.size(), { undo: 2, redo: 0 });
  const r = await U.redo();
  assert.deepEqual({ ok: r.ok, reason: r.reason }, { ok: false, reason: "empty" });
  assert.equal(page.toasts[page.toasts.length - 1].text, "Nothing to redo");
});

test("at most LIMIT entries are kept: the oldest goes first", async () => {
  reset();
  assert.equal(U.LIMIT, 100);
  const p = await C.savePrompt(fresh("Q. Step 0?\nA. x"), { content: true });
  for (let i = 1; i <= U.LIMIT + 5; i++) await C.savePrompt(edited(p.id, "Q. Step " + i + "?\nA. x"), STEP);
  assert.deepEqual(U.size(), { undo: U.LIMIT, redo: 0 });
  for (let i = 0; i < U.LIMIT; i++) assert.equal((await U.undo()).ok, true);
  assert.equal(C.prompt(p.id).text, "Q. Step 5?\nA. x", "the five oldest steps are gone");
  assert.equal((await U.undo()).reason, "empty");
  assert.equal(page.toasts[page.toasts.length - 1].text, "Nothing to undo");
});

test("no step: a save without opts.step, a save of the cached record itself, a save that changes no state", async () => {
  reset();
  const p = await C.savePrompt(fresh("Q. Quiet?\nA. yes"), { content: true });
  assert.deepEqual(U.size(), { undo: 0, redo: 0 }, "no opts.step");
  await answer(p.id, 0);
  await C.patchPrompts([{ id: p.id, fields: { obsidianSentAt: Date.now() } }]);
  await C.removePrompt(p.id);
  await C.restorePrompt(p.id);
  assert.deepEqual(U.size(), { undo: 0, redo: 0 }, "a review answer, a send record, a delete and a restore without opts.step");

  const cached = C.prompt(p.id);
  cached.text = "Q. Changed in place?\nA. yes";
  await C.savePrompt(cached, STEP);
  assert.deepEqual(U.size(), { undo: 0, redo: 0 }, "the cached record itself: the cache has nothing to compare it with");

  await C.savePrompt(Object.assign({}, C.prompt(p.id)), STEP);
  await C.savePrompt(Object.assign({}, C.prompt(p.id), { context: { docName: "Undo book", sectionLabel: "One", pageIndex: 2, pageLabel: "iii" } }), STEP);
  assert.deepEqual(U.size(), { undo: 0, redo: 0 }, "the same state (a copy; a context snapshot only)");

  await C.removePrompt(p.id, { step: true });
  await C.removePrompt(p.id, { step: true });              // already deleted: nothing happens
  assert.deepEqual(U.size(), { undo: 1, redo: 0 });
  await C.restorePrompt(p.id);
  await C.restorePrompt(p.id, { step: true });             // already live: nothing happens
  assert.deepEqual(U.size(), { undo: 1, redo: 0 });
});

test("a new prompt whose first write fails is no step; an edit whose write fails is one (the session keeps it)", async () => {
  reset();
  const real = M.store.prompts.put;
  M.store.prompts.put = function () { return Promise.reject(new Error("disk full")); };
  try {
    const rec = fresh("Q. Never stored?\nA. no");
    await assert.rejects(C.savePrompt(rec, STEP), (e) => e.code === "store");
    assert.equal(C.prompt(rec.id), null, "the cache dropped it again");
    assert.deepEqual(U.size(), { undo: 0, redo: 0 });
  } finally { M.store.prompts.put = real; }

  const p = await C.savePrompt(fresh("Q. Stored?\nA. yes"), { content: true });
  M.store.prompts.put = function () { return Promise.reject(new Error("disk full")); };
  try {
    await assert.rejects(C.savePrompt(edited(p.id, "Q. Edited in the session only?\nA. yes"), STEP), (e) => e.code === "store");
  } finally { M.store.prompts.put = real; }
  assert.equal(C.prompt(p.id).text, "Q. Edited in the session only?\nA. yes");
  assert.deepEqual(U.size(), { undo: 1, redo: 0 });
  assert.equal((await U.undo()).ok, true);
  assert.equal(C.prompt(p.id).text, "Q. Stored?\nA. yes");
});

test("an undo whose store write fails still counts: the session holds the change, and redo is on offer", async () => {
  reset();
  const p = await C.savePrompt(fresh("Q. Before?\nA. yes"), { content: true });
  await C.savePrompt(edited(p.id, "Q. After?\nA. yes"), STEP);
  const real = M.store.prompts.putMany;
  M.store.prompts.putMany = function () { return Promise.reject(new Error("disk full")); };
  let r;
  try { r = await U.undo(); } finally { M.store.prompts.putMany = real; }
  assert.equal(r.ok, true);
  assert.equal(C.prompt(p.id).text, "Q. Before?\nA. yes");
  assert.deepEqual(U.size(), { undo: 0, redo: 1 });
  assert.ok(page.toasts.some((t) => t.text === "Could not save"), "the cache said that the write failed");
});

test("the prompts of one entry are stored in ONE write: all of them, or none", async () => {
  reset();
  const g = U.group(), made = [];
  for (const text of ["Q. one write, 1?\nA. 1", "Q. one write, 2?\nA. 2", "Q. one write, 3?\nA. 3"]) made.push(await C.savePrompt(fresh(text), { content: true, step: g }));
  const stored = async () => { const all = await M.store.prompts.all(); return made.map((p) => all.find((x) => x.id === p.id).deletedAt === null); };
  const realMany = M.store.prompts.putMany, realPut = M.store.prompts.put;
  let many = 0, single = 0, sizes = [];
  M.store.prompts.putMany = function (list) { many++; sizes.push(list.length); return realMany.apply(this, arguments); };
  M.store.prompts.put = function () { single++; return realPut.apply(this, arguments); };
  try {
    assert.equal((await U.undo()).ok, true);
    assert.deepEqual({ many, single, sizes }, { many: 1, single: 0, sizes: [3] }, "one transaction for the three prompts");
    assert.deepEqual(await stored(), [false, false, false]);
    // the one write is refused: the store holds none of the three as restored, the session holds them all
    M.store.prompts.putMany = function () { many++; return Promise.reject(new Error("disk full")); };
    const r = await U.redo();
    assert.equal(r.ok, true, "the step counts as taken: the session is the truth, as after an edit that could not be saved");
    assert.deepEqual(made.map((p) => isLive(p.id)), [true, true, true]);
    assert.deepEqual(await stored(), [false, false, false], "never one or two of the three");
  } finally { M.store.prompts.putMany = realMany; M.store.prompts.put = realPut; }
});

test("a store write that the lock refuses: the session holds the change, the step counts, and the cache says nothing", async () => {
  reset();
  const p = await C.savePrompt(fresh("Q. Refused by the lock?\nA. yes"), STEP);
  const real = M.store.prompts.putMany;
  M.store.prompts.putMany = function () { const e = new Error("locked"); e.code = "locked"; return Promise.reject(e); };
  page.toasts.length = 0;
  let r;
  try { r = await U.undo(); } finally { M.store.prompts.putMany = real; }
  assert.equal(r.ok, true, "the records changed in the session, so the entry moves with them");
  assert.equal(isLive(p.id), false);
  assert.deepEqual(U.size(), { undo: 0, redo: 1 }, "the entry and the cache agree");
  assert.equal(page.toasts.some((t) => t.text === "Could not save"), false, "the page that stepped aside says that itself");
  assert.equal((await U.redo()).ok, true, "and the next command finds the state that it expects");
  assert.equal(isLive(p.id), true);
});

/* ------------------------------------------------------------------ when nothing runs */

test("nothing runs while an import saves, in a review, in a tab that stepped aside, without the role", async () => {
  reset();
  const p = await C.savePrompt(fresh("Q. Gate?\nA. yes"), STEP);
  const stays = async (reason, text) => {
    page.toasts.length = 0;
    const r = await U.undo();
    assert.deepEqual({ ok: r.ok, reason: r.reason }, { ok: false, reason });
    assert.equal(isLive(p.id), true, reason + ": nothing was written");
    assert.deepEqual(U.size(), { undo: 1, redo: 0 }, reason + ": the entry stays");
    assert.deepEqual(page.toasts.map((t) => t.text), text ? [text] : []);
  };

  M.exporter = { isImporting: () => true };
  try { await stays("importing", "Wait until the import finishes, then try again."); } finally { delete M.exporter; }

  page.owner = "editor";                                    // an open editor alone stops nothing (see the next test)
  M.review = { isActive: () => true, isSuspended: () => false };
  try { await stays("review", "Not during a review: the review has its own undo."); } finally { delete M.review; page.owner = "reader"; }

  M.app.modal = () => true;                                 // a question, a dialog, the settings or the ? sheet is up
  try { await stays("modal", null); } finally { delete M.app.modal; }

  const locked = M.store.locked;
  M.store.locked = () => true;
  try { await stays("locked", null); } finally { M.store.locked = locked; }

  page.role = false;
  await stays("role", null);
  page.role = true;

  page.asked = 0;
  assert.equal((await U.undo()).ok, true);
  assert.equal(page.asked, 1, "the window takes the writer role before it writes (DECISIONS D31)");
  assert.equal(isLive(p.id), false);
});

test("a card that is open in an editor is not changed under it; any other card is", async () => {
  reset();
  const a = await C.savePrompt(fresh("Q. Open in the editor?\nA. yes"), { content: true });
  const b = await C.savePrompt(fresh("Q. Not open?\nA. yes"), { content: true });
  await C.savePrompt(edited(a.id, "Q. Open in the editor, edited?\nA. yes"), STEP);
  await C.savePrompt(edited(b.id, "Q. Not open, edited?\nA. yes"), STEP);
  let marginHolds = null, listHolds = null;
  M.margin = { editing: () => (marginHolds === undefined ? null : { promptId: marginHolds, anchor: null }) };
  M.list = { editingId: () => listHolds };
  page.owner = "editor";
  try {
    marginHolds = a.id;                                     // the margin's editor holds a: the newest step is b's
    assert.equal((await U.undo()).ok, true, "b is not in an editor");
    assert.equal(C.prompt(b.id).text, "Q. Not open?\nA. yes");
    page.toasts.length = 0;
    let r = await U.undo();                                 // now a's step
    assert.deepEqual({ ok: r.ok, reason: r.reason }, { ok: false, reason: "editor" });
    assert.equal(C.prompt(a.id).text, "Q. Open in the editor, edited?\nA. yes", "nothing was written");
    assert.deepEqual(U.size(), { undo: 1, redo: 1 }, "the step stays for later");
    assert.deepEqual(page.toasts.map((x) => x.text), ["Save or cancel the editor of that card first."]);

    marginHolds = null;                                     // a new prompt's editor (promptId null) holds no card
    listHolds = a.id;                                       // the list's editor holds a
    r = await U.undo();
    assert.equal(r.reason, "editor");
    listHolds = b.id;                                       // the list's editor holds b: b's step is in the redo list
    r = await U.redo();
    assert.equal(r.reason, "editor", "redo alike");
    assert.equal(C.prompt(b.id).text, "Q. Not open?\nA. yes");
    listHolds = null;
    // the second editor of a Split is for a new prompt, but it holds the first half too (its draft is "split:<id>")
    M.margin = { editing: () => ({ promptId: null, anchor: null, draftKey: "split:" + a.id, keepDraft: true }) };
    assert.equal((await U.undo()).reason, "editor", "the first half of a Split waits for its second half");
    M.margin = { editing: () => ({ promptId: null, anchor: null, draftKey: "split:" }) };   // no id behind the prefix: no card
    // an editor that waits with a tab that is not on screen (js/tabs.js)
    M.tabs = { heldEditors: () => [{ promptId: "u_some_other", anchor: null }, { promptId: a.id, anchor: null }] };
    page.toasts.length = 0;
    assert.equal((await U.undo()).reason, "editor", "the card of a background tab's editor");
    assert.deepEqual(page.toasts.map((x) => x.text), ["Save or cancel the editor of that card first. It waits in another tab."], "the notice says where that editor is");
    M.margin = { editing: () => ({ promptId: a.id, anchor: null }) };       // on screen too: the plain words
    page.toasts.length = 0;
    assert.equal((await U.undo()).reason, "editor");
    assert.deepEqual(page.toasts.map((x) => x.text), ["Save or cancel the editor of that card first."]);
    M.margin = { editing: () => null };
    M.tabs = { heldEditors: () => [{ promptId: null, anchor: null, draftKey: "split:" + a.id }] };
    assert.equal((await U.undo()).reason, "editor");
    M.tabs = { heldEditors: () => [{ promptId: "u_some_other", anchor: null }, null, "x"] };
    assert.equal(C.prompt(a.id).text, "Q. Open in the editor, edited?\nA. yes", "nothing was written meanwhile");
    assert.equal((await U.undo()).ok, true, "with no editor on a, its step is taken back");
    assert.equal(C.prompt(a.id).text, "Q. Open in the editor?\nA. yes");
  } finally { delete M.margin; delete M.list; delete M.tabs; page.owner = "reader"; }
});

test("undo({group}) takes back that group only while it is the newest step (the Undo of “Added n prompts”)", async () => {
  reset();
  const g = U.group(), made = [];
  for (const text of ["Q. g one?\nA. 1", "Q. g two?\nA. 2"]) made.push(await C.savePrompt(fresh(text), { content: true, step: g }));
  const later = await C.savePrompt(fresh("Q. A later step?\nA. yes"), STEP);
  let r = await U.undo({ group: g });
  assert.deepEqual({ ok: r.ok, reason: r.reason }, { ok: false, reason: "moved" });
  assert.deepEqual(made.map((p) => isLive(p.id)).concat(isLive(later.id)), [true, true, true], "nothing was written");
  assert.deepEqual(U.size(), { undo: 2, redo: 0 });
  assert.equal(page.toasts[page.toasts.length - 1].text, "Not undone: you made other changes after that one.");

  await U.undo();                                           // the later step
  r = await U.undo({ group: g });
  assert.equal(r.ok, true);
  assert.deepEqual(made.map((p) => isLive(p.id)), [false, false]);
  assert.deepEqual(U.size(), { undo: 0, redo: 2 });

  // the same button again (its notice is still on screen), or after Cmd+Z took the Add back: it is undone already
  r = await U.undo({ group: g });
  assert.deepEqual({ ok: r.ok, reason: r.reason }, { ok: false, reason: "already" });
  assert.equal(page.toasts[page.toasts.length - 1].text, "That is undone already.");
  assert.deepEqual(U.size(), { undo: 0, redo: 2 }, "and the redo list is as it was");
  // … also when a new step emptied the redo list meanwhile, and that step is there to undo
  const other = await C.savePrompt(fresh("Q. Not of that group?\nA. yes"), STEP);
  assert.deepEqual(U.size(), { undo: 1, redo: 0 });
  r = await U.undo({ group: g });
  assert.equal(r.reason, "already");
  assert.equal(page.toasts[page.toasts.length - 1].text, "That is undone already.", "not “Nothing to undo”: there is a step to undo");
  assert.equal(isLive(other.id), true, "the other step is not taken instead");

  // made again and taken back by the keys: the token follows
  U.clear();
  const g2 = U.group();
  const q = await C.savePrompt(fresh("Q. g2?\nA. 1"), { content: true, step: g2 });
  await U.undo();
  await U.redo();
  assert.equal((await U.undo({ group: g2 })).ok, true, "made again: it can be taken back");
  assert.equal(isLive(q.id), false);

  // a token whose entry is not in the list for another reason (it was never there, or the list dropped it)
  r = await U.undo({ group: U.group() });
  assert.equal(r.reason, "late");
  assert.equal(page.toasts[page.toasts.length - 1].text, "That step cannot be undone any more.");
  // taken back, made again, and then refused because its card changed: it is not "undone already"
  U.clear();
  const g3 = U.group();
  const s = await C.savePrompt(fresh("Q. g3?\nA. 1"), { content: true, step: g3 });
  await U.undo();
  await U.redo();
  await answer(s.id, 0);
  assert.equal((await U.undo({ group: g3 })).reason, "changed");
  r = await U.undo({ group: g3 });
  assert.equal(r.reason, "late");
});

test("a group that another step cut in two: its Undo takes the newest part while that is the newest step", async () => {
  reset();
  const g = U.group();
  const a = await C.savePrompt(fresh("Q. part one?\nA. 1"), { content: true, step: g });
  const between = await C.savePrompt(fresh("Q. came in between?\nA. yes"), STEP);      // the Add stores its prompts one after the other
  const b = await C.savePrompt(fresh("Q. part two?\nA. 2"), { content: true, step: g });
  assert.deepEqual(U.size(), { undo: 3, redo: 0 });
  let r = await U.undo({ group: g });
  assert.equal(r.ok, true, "the newest entry is of that group");
  assert.deepEqual([isLive(a.id), isLive(between.id), isLive(b.id)], [true, true, false]);
  r = await U.undo({ group: g });
  assert.equal(r.reason, "moved", "the older part is behind another step");
  assert.deepEqual([isLive(a.id), isLive(between.id)], [true, true]);
});

test("the work of one command keeps the writer role (M.store.during), from the comparing to the write", async () => {
  reset();
  const g = U.group(), made = [];
  for (const text of ["Q. kept one?\nA. 1", "Q. kept two?\nA. 2"]) made.push(await C.savePrompt(fresh(text), { content: true, step: g }));
  const during = M.store.during, revert = C.revertPrompts, putMany = M.store.prompts.putMany, seen = [];
  let inside = 0, works = 0;
  M.store.during = function (work) { works++; inside++; const p = Promise.resolve(work()); const out = () => { inside--; }; p.then(out, out); return p; };
  C.revertPrompts = function () { seen.push("revert " + inside); return revert.apply(C, arguments); };
  M.store.prompts.putMany = function () { seen.push("write " + inside); return putMany.apply(this, arguments); };
  try {
    assert.equal((await U.undo()).ok, true);
    assert.equal((await U.redo()).ok, true);
    assert.equal((await U.undo()).ok, true);
    assert.equal((await U.undo()).reason, "empty");
  } finally { M.store.during = during; C.revertPrompts = revert; M.store.prompts.putMany = putMany; }
  assert.deepEqual(seen, ["revert 1", "write 1", "revert 1", "write 1", "revert 1", "write 1"], "the check and the write of each command ran while the role was kept");
  assert.equal(works, 4, "one piece of work for each command, also for the one that found nothing");
  assert.equal(inside, 0);
});

test("a new prompt whose first write fails gives the redo list back", async () => {
  reset();
  const p = await C.savePrompt(fresh("Q. Undone, to be made again?\nA. yes"), STEP);
  await U.undo();
  assert.deepEqual(U.size(), { undo: 0, redo: 1 });
  const real = M.store.prompts.put;
  M.store.prompts.put = function () { return Promise.reject(new Error("disk full")); };
  try { await assert.rejects(C.savePrompt(fresh("Q. Never stored 2?\nA. no"), STEP), (e) => e.code === "store"); } finally { M.store.prompts.put = real; }
  assert.deepEqual(U.size(), { undo: 0, redo: 1 }, "the step never happened: redo is still on offer");
  assert.equal((await U.redo()).ok, true);
  assert.equal(isLive(p.id), true);

  // but not when another step came in between
  await U.undo();
  let fail = true;
  M.store.prompts.put = function () { if (fail) { fail = false; return new Promise((res, rej) => setTimeout(() => rej(new Error("disk full")), 15)); } return real.apply(this, arguments); };
  let failing;
  try {
    failing = C.savePrompt(fresh("Q. Never stored 3?\nA. no"), STEP).then(() => "stored", (e) => e.code);
    await C.savePrompt(fresh("Q. A real step meanwhile?\nA. yes"), STEP);
    assert.equal(await failing, "store");
  } finally { M.store.prompts.put = real; }
  assert.deepEqual(U.size(), { undo: 1, redo: 0 }, "the real step emptied the redo list for good");
});

test("idle() resolves when the commands that the keys began have ended", async () => {
  reset();
  const p = await C.savePrompt(fresh("Q. Idle?\nA. yes"), STEP);
  assert.equal(U.run("undo"), true);
  assert.equal(isLive(p.id), true, "not yet");
  await U.idle();
  assert.equal(isLive(p.id), false);
  U.run("redo");
  U.run("undo");
  U.run("redo");
  await U.idle();
  assert.equal(isLive(p.id), true);
});

test("a review that waits behind the reader does not stop an undo", async () => {
  reset();
  const p = await C.savePrompt(fresh("Q. Fixed during a review?\nA. yes"), STEP);
  M.review = { isActive: () => true, isSuspended: () => true };
  try { assert.equal((await U.undo()).ok, true); } finally { delete M.review; }
  assert.equal(isLive(p.id), false);
});

test("without a cache that can revert, undo answers unavailable and keeps its entries", async () => {
  reset();
  await C.savePrompt(fresh("Q. Old cache?\nA. yes"), STEP);
  const revert = C.revertPrompts;
  delete C.revertPrompts;
  let r;
  try { r = await U.undo(); } finally { C.revertPrompts = revert; }
  assert.deepEqual({ ok: r.ok, reason: r.reason }, { ok: false, reason: "unavailable" });
  assert.deepEqual(U.size(), { undo: 1, redo: 0 });
  assert.deepEqual(page.toasts, []);
});

/* ------------------------------------------------------------------ the commands and their notices */

test("the notice names the action, the first line and the place, and its button goes the other way", async () => {
  reset();
  const p = await C.savePrompt(fresh("Q. What is the testing effect?\nA. A test of memory helps more than a second reading."), { content: true });
  await C.savePrompt(edited(p.id, "Q. What is the testing effect, in one sentence, for a reader who has never heard of it before?\nA. …"), STEP);
  await U.undo();
  let t = page.toasts[page.toasts.length - 1];
  assert.equal(t.id, "undo");
  assert.equal(t.text, "Edit undone · “What is the testing effect?”", "the card as it is now");
  assert.equal(t.detail, "Undo book · p. 3");
  assert.deepEqual(t.actions.map((a) => a.label), ["Redo"]);

  t.actions[0].run();                                       // the button of the notice: Redo
  await U.idle();
  assert.equal(C.prompt(p.id).text.indexOf("in one sentence") > 0, true, "the button made the edit again");
  assert.deepEqual(U.size(), { undo: 1, redo: 0 });
  t = page.toasts[page.toasts.length - 1];
  assert.equal(t.text, "Edit redone · “What is the testing effect, in one sentence, fo…”", "48 characters at most, the … included");
  assert.deepEqual(t.actions.map((a) => a.label), ["Undo"]);
  t.actions[0].run();                                       // and this notice's button: Undo
  await U.idle();
  assert.equal(C.prompt(p.id).text, "Q. What is the testing effect?\nA. A test of memory helps more than a second reading.");
  assert.deepEqual(U.size(), { undo: 0, redo: 1 });
  assert.equal(page.toasts[page.toasts.length - 1].text, "Edit undone · “What is the testing effect?”");
});

test("excerpt: the first line without its Q., a picture as [image], a highlight's passage", () => {
  assert.equal(U.excerpt({ text: "Q. What?\nA. That" }), "What?");
  assert.equal(U.excerpt({ text: "  \n  A plain note\nwith two lines" }), "A plain note");
  assert.equal(U.excerpt({ text: "![snip](att:abc) below the figure" }), "[image] below the figure");
  assert.equal(U.excerpt({ text: "", anchor: { quote: "  the  marked\n words " } }), "the marked words");
  assert.equal(U.excerpt({ text: "x".repeat(60) }), "x".repeat(47) + "…");
  assert.equal(U.excerpt(null), "");
});

test("undo and redo run one after the other, in the order of the calls", async () => {
  reset();
  const p = await C.savePrompt(fresh("Q. 0?\nA. x"), { content: true });
  await C.savePrompt(edited(p.id, "Q. 1?\nA. x"), STEP);
  await C.savePrompt(edited(p.id, "Q. 2?\nA. x"), STEP);
  const all = await Promise.all([U.undo(), U.undo(), U.redo(), U.undo(), U.undo()]);
  assert.deepEqual(all.map((r) => r.ok + ":" + (r.reason || r.action)), ["true:undo", "true:undo", "true:redo", "true:undo", "false:empty"]);
  assert.equal(C.prompt(p.id).text, "Q. 0?\nA. x");
  assert.deepEqual(U.size(), { undo: 0, redo: 2 });
});

test("run(id) takes undo and redo only", async () => {
  reset();
  const p = await C.savePrompt(fresh("Q. Run?\nA. yes"), STEP);
  assert.equal(U.run("delete"), false);
  assert.equal(U.run(""), false);
  assert.equal(U.run("undo"), true);
  await U.redo();                                           // waits for the undo that run() began
  assert.equal(isLive(p.id), true);
  assert.deepEqual(U.size(), { undo: 1, redo: 0 });
  assert.equal(U.run("redo"), true, "true also when there is nothing to redo: the key was meant for it");
  await U.undo();
  assert.equal(isLive(p.id), false);
});

test("texts(): the text of every snapshot, of both lists; clear() empties them", async () => {
  reset();
  const p = await C.savePrompt(fresh("Q. Figure?\nA. ![snip](att:pic1)"), { content: true });
  await C.savePrompt(edited(p.id, "Q. Figure?\nA. gone"), STEP);
  const q = await C.savePrompt(fresh("![snip](att:pic2) a note"), STEP);
  await U.undo();
  assert.deepEqual(U.size(), { undo: 1, redo: 1 });
  assert.deepEqual(U.texts().sort(), ["![snip](att:pic2) a note", "Q. Figure?\nA. ![snip](att:pic1)", "Q. Figure?\nA. gone"].sort());
  U.clear();
  assert.deepEqual(U.texts(), []);
  assert.deepEqual(U.size(), { undo: 0, redo: 0 });
  assert.equal(isLive(q.id), false);
});

test("note() takes no step without an id, without a record, or when the state stays", () => {
  reset();
  const a = fresh("Q. a?\nA. a");
  assert.equal(U.note(null, true), null);
  assert.equal(U.note({ id: "", before: null, after: a }, true), null);
  assert.equal(U.note({ id: "x", before: null, after: null }, true), null);
  const dead = Object.assign({}, a, { deletedAt: 5 });
  assert.equal(U.note({ id: a.id, before: dead, after: Object.assign({}, dead, { text: "Q. changed while deleted?\nA. yes" }) }, true), null, "a deleted card before and after: no step");
  assert.equal(U.note({ id: a.id, before: null, after: dead }, true), null);
  assert.equal(U.note({ id: a.id, before: a, after: Object.assign({}, a, { updatedAt: a.updatedAt + 9 }) }, true), null);
  assert.deepEqual(U.size(), { undo: 0, redo: 0 });
  const h = U.note({ id: a.id, before: null, after: a }, true);
  assert.equal(typeof h.retract, "function");
  assert.deepEqual(U.size(), { undo: 1, redo: 0 });
  h.retract();
  h.retract();
  assert.deepEqual(U.size(), { undo: 0, redo: 0 });
});

/* ------------------------------------------------------------------ M.cache: the state key and the writer */

test("stateKey: the person's fields, the cards and whether the prompt is live; nothing else", () => {
  const p = fresh("Q. Key?\nA. yes\n#tag");
  const k = C.stateKey(p);
  const same = (fields) => assert.equal(C.stateKey(Object.assign(copy(p), fields)), k, JSON.stringify(Object.keys(fields)));
  const differs = (fields) => assert.notEqual(C.stateKey(Object.assign(copy(p), fields)), k, JSON.stringify(Object.keys(fields)));
  same({ updatedAt: 1, contentUpdatedAt: 2, revisedAt: 3, createdAt: 4, dueAt: 5 });
  same({ obsidianSentAt: 1, obsidianFile: "a.md", obsidianPendingFile: "a.md" });
  same({ context: { docName: "Other name", sectionLabel: "Two", pageIndex: 9, pageLabel: "x" } });
  same({ anchor: Object.assign(copy(p.anchor), { pageIndex: 4, pages: [], lost: true }) });   // a found position, a lost mark
  differs({ text: "Q. Key?\nA. no\n#tag" });
  differs({ kind: "note" });
  differs({ tags: ["other"] });
  differs({ flagged: true });
  differs({ collectionId: "dk_u" });
  differs({ anchor: Object.assign(copy(p.anchor), { quote: "another passage" }) });
  differs({ anchor: null });
  differs({ deletedAt: 5 });
  differs({ cards: [Object.assign(copy(p.cards[0]), { dueAt: p.cards[0].dueAt + 1 })] });
  differs({ cards: [] });
  assert.equal(C.stateKey(null), "-");
  assert.equal(C.stateKey(undefined), "-");
  const loop = copy(p); loop.cards = [loop];
  assert.equal(C.stateKey(loop), null, "data that cannot be written down equals nothing");
});

test("revertPrompts: changed, gone, locked and a bad list reject and change nothing; it is never a step", async () => {
  reset();
  const p = await C.savePrompt(fresh("Q. Revert?\nA. yes"), { content: true });
  const a = copy(C.prompt(p.id));
  const b = copy(await C.savePrompt(edited(p.id, "Q. Reverted?\nA. yes"), { content: true }));
  events.length = 0;
  const one = (from, to, id) => C.revertPrompts([{ id: id || p.id, from, to }]);
  const code = (promise) => promise.then(() => "resolved", (e) => e.code + (e.ids ? " " + e.ids.join(",") : ""));

  assert.equal(await code(one(a, b)), "changed " + p.id, "the prompt is in state b, not a");
  assert.equal(await code(one(null, b)), "changed " + p.id, "null: the prompt must be missing or deleted");
  assert.equal(await code(one(a, b, "u_missing")), "changed u_missing");
  assert.equal(await code(one(null, b, "u_missing")), "gone u_missing", "no record to bring back");
  assert.equal(await code(one(b, Object.assign(copy(a), { collectionId: "bk_none" }))), "gone " + p.id);
  assert.equal(await code(C.revertPrompts([{ id: p.id, from: b, to: a }, { id: p.id, from: a, to: b }])), "bad_revert", "a prompt twice");
  assert.equal(await code(C.revertPrompts([{ from: b, to: a }])), "bad_revert", "no id");
  const locked = M.store.locked;
  M.store.locked = () => true;
  try {
    assert.equal(await code(one(b, a)), "locked");
    assert.equal(await code(one(b, null)), "locked", "a delete too is refused, not passed over in silence");
  } finally { M.store.locked = locked; }
  assert.deepEqual(copy(C.prompt(p.id)), b);
  assert.deepEqual(events, []);
  assert.deepEqual(await C.revertPrompts([]), [], "nothing to do");

  const back = (await C.revertPrompts([{ id: p.id, from: b, to: a }], { now: b.updatedAt + 1000 }))[0];
  assert.equal(back, C.prompt(p.id));
  assert.equal(back.text, a.text);
  assert.equal(back.updatedAt, b.updatedAt + 1000);
  assert.equal(back.contentUpdatedAt, b.updatedAt + 1000);
  assert.deepEqual(U.size(), { undo: 0, redo: 0 }, "never a step");

  const dead = (await one(a, null))[0];                      // to "no record": deleted, as removePrompt does
  assert.equal(dead.deletedAt !== null, true);
  assert.equal(dead.deletedAt, dead.updatedAt);
  assert.equal(dead.contentUpdatedAt, b.updatedAt + 1000, "a delete does not move contentUpdatedAt");
  const stamp = C.prompt(p.id).updatedAt;
  await tick();
  assert.equal((await one(null, null))[0], C.prompt(p.id), "already gone: nothing to do");
  assert.equal(C.prompt(p.id).updatedAt, stamp, "and nothing is written");
  assert.deepEqual(await one(null, null, "u_missing"), [null], "no record and none wanted: nothing to do either");
  const alive = (await one(null, b))[0];                     // from "no record" to b: restored, then the fields of b
  assert.equal(alive.deletedAt, null);
  assert.equal(alive.text, b.text);
  assert.equal(alive.revisedAt, b.revisedAt);
  assert.deepEqual(events.map((e) => e.type), ["prompt:saved", "prompt:deleted", "prompt:restored", "prompt:saved"]);
});

test("revertPrompts: a deleted state with other fields comes back exactly, so the way forward still fits", async () => {
  reset();
  // what js/list.js saveEdit does when the prompt was deleted while its editor was open: one save from "deleted, old
  // text" to "live, new text"
  const p = await C.savePrompt(fresh("Q. Old text?\nA. yes"), { content: true });
  await C.removePrompt(p.id);
  const parsed = P.parse("Q. New text?\nA. yes");
  await C.savePrompt(Object.assign({}, C.prompt(p.id), { text: "Q. New text?\nA. yes", kind: parsed.kind, tags: [], deletedAt: null }), STEP);
  assert.equal(isLive(p.id), true);
  assert.equal(U.peek("undo").label, "Restore");
  events.length = 0;

  assert.equal((await U.undo()).ok, true);
  assert.equal(isLive(p.id), false, "deleted again");
  assert.equal(C.prompt(p.id).text, "Q. Old text?\nA. yes", "with the text that the deleted record had");
  assert.equal("dueAt" in C.prompt(p.id), false);
  assert.deepEqual(events.map((e) => e.type), ["prompt:deleted"]);
  events.length = 0;
  assert.equal((await U.redo()).ok, true, "the redo finds the state that it expects");
  assert.equal(isLive(p.id), true);
  assert.equal(C.prompt(p.id).text, "Q. New text?\nA. yes");
  assert.deepEqual(events.map((e) => e.type), ["prompt:restored", "prompt:saved"]);
  const all = await M.store.prompts.all();
  assert.equal(all.find((x) => x.id === p.id).text, "Q. New text?\nA. yes");
});

test("revertPrompts: several prompts go together, and one that is in the way stops them all", async () => {
  reset();
  const x = await C.savePrompt(fresh("Q. x?\nA. 1"), { content: true }), y = await C.savePrompt(fresh("Q. y?\nA. 2"), { content: true });
  const x0 = copy(C.prompt(x.id)), y0 = copy(C.prompt(y.id));
  const x1 = copy(await C.savePrompt(edited(x.id, "Q. x, edited?\nA. 1"), { content: true }));
  const y1 = copy(await C.savePrompt(edited(y.id, "Q. y, edited?\nA. 2"), { content: true }));
  await answer(y.id, 0);                                     // y is no longer in state y1
  events.length = 0;
  const e = await C.revertPrompts([{ id: x.id, from: x1, to: x0 }, { id: y.id, from: y1, to: y0 }]).then(() => null, (err) => err);
  assert.equal(e.code, "changed");
  assert.deepEqual(e.ids, [y.id], "the one that is in the way is named");
  assert.equal(C.prompt(x.id).text, "Q. x, edited?\nA. 1", "x did not go either");
  assert.deepEqual(events, []);
  const y2 = copy(C.prompt(y.id));
  const both = await C.revertPrompts([{ id: x.id, from: x1, to: x0 }, { id: y.id, from: y2, to: null }]);
  assert.deepEqual(both.map((r) => r.id), [x.id, y.id]);
  assert.equal(C.prompt(x.id).text, "Q. x?\nA. 1");
  assert.equal(isLive(y.id), false);
  assert.deepEqual(events.map((ev) => ev.type), ["prompt:saved", "prompt:deleted"], "the events come when all the records are as they will be");
});

test("a revert that changes the cards only is a person's change too: contentUpdatedAt moves", async () => {
  reset();
  const p = await C.savePrompt(fresh("Q. Cards only?\nA. yes"), { content: true });
  const a = copy(C.prompt(p.id));
  await tick();
  await answer(p.id, 0);
  const b = copy(C.prompt(p.id));
  assert.notEqual(C.stateKey(a), C.stateKey(b));
  assert.equal(b.contentUpdatedAt, a.contentUpdatedAt, "an answer is no content change");
  await tick();
  const back = (await C.revertPrompts([{ id: p.id, from: b, to: a }]))[0];
  assert.deepEqual(back.cards, a.cards);
  assert.ok(back.contentUpdatedAt > a.contentUpdatedAt, "so the state that came back wins an import merge");
  assert.equal(back.contentUpdatedAt, back.updatedAt);
});

test("a redo of a new prompt whose book was deleted meanwhile is refused", async () => {
  reset();
  await C.saveCollection({ id: "bk_gone2", kind: "book", name: "Gone book 2" });
  const p = await C.savePrompt(fresh("Q. New in a book that goes?\nA. yes", { collectionId: "bk_gone2" }), STEP);
  await U.undo();
  await C.removeCollection("bk_gone2");
  const r = await U.redo();
  assert.deepEqual({ ok: r.ok, reason: r.reason }, { ok: false, reason: "gone" });
  assert.equal(isLive(p.id), false);
  assert.equal(page.toasts[page.toasts.length - 1].text, "Not redone: its book or deck is deleted.");
});

test("the stored record follows: after an undo the store holds what the cache holds", async () => {
  reset();
  const p = await C.savePrompt(fresh("Q. Stored before?\nA. yes"), { content: true });
  await C.savePrompt(edited(p.id, "Q. Stored after?\nA. yes"), STEP);
  await U.undo();
  const all = await M.store.prompts.all();
  const stored = all.find((x) => x.id === p.id);
  assert.deepEqual(copy(stored), copy(C.prompt(p.id)));
  assert.equal(stored.text, "Q. Stored before?\nA. yes");
});
