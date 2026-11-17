"use strict";
// test/review-craft.test.js — flag and delete during review, the summary's deleted count and flagged list
// (FEATURES P1.3 b–d; BUILD-NOTES "Prompt craft"), without a DOM. The cache stub keeps M.cache's contract for the calls
// review makes: savePrompt(p, {content: true}) moves contentUpdatedAt when a person-edited field changes,
// removePrompt / restorePrompt tombstone and restore in memory at once and emit prompt:deleted / prompt:restored.
// Run from the project root: node --test
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const M = (globalThis.Marginalia = globalThis.Marginalia || {});
const js = (name) => path.join(__dirname, "..", "js", name + ".js");
["util", "bus", "settings", "scheduler", "prompts", "context", "keys"].forEach((n) => require(js(n)));
const S = M.scheduler;
const { DAY, FIRST } = S;

let clock = 1762250000000;
const realNow = Date.now;
Date.now = () => clock;
test.after(() => { Date.now = realNow; });

const cacheState = { prompts: new Map(), collections: new Map(), saves: [], removes: [], restores: [] };
M.cache = {
  prompt: (id) => cacheState.prompts.get(id) || null,
  prompts: () => Array.from(cacheState.prompts.values()),
  promptsOf: (cid) => Array.from(cacheState.prompts.values()).filter((p) => p.collectionId === cid),
  collection: (id) => cacheState.collections.get(id) || null,
  collections: () => Array.from(cacheState.collections.values()),
  savePrompt(p, opts) {
    cacheState.saves.push({ prompt: p, opts });
    const old = cacheState.prompts.get(p.id);
    const saved = Object.assign({}, p, { updatedAt: Date.now() });
    if (opts && opts.content && old && (old.text !== p.text || old.flagged !== p.flagged)) saved.contentUpdatedAt = Date.now();
    cacheState.prompts.set(p.id, saved);
    M.bus.emit("prompt:saved", { prompt: saved, isNew: false });
    return Promise.resolve(saved);
  },
  removePrompt(id) {
    cacheState.removes.push(id);
    const p = cacheState.prompts.get(id);
    if (!p) return Promise.reject(Object.assign(new Error("No prompt"), { code: "not_found" }));
    if (p.deletedAt === null || p.deletedAt === undefined) {
      p.deletedAt = Date.now();
      M.bus.emit("prompt:deleted", { promptId: id, collectionId: p.collectionId });
    }
    return Promise.resolve(p);
  },
  restorePrompt(id) {
    cacheState.restores.push(id);
    const p = cacheState.prompts.get(id);
    if (!p) return Promise.reject(Object.assign(new Error("No prompt"), { code: "not_found" }));
    if (p.deletedAt !== null && p.deletedAt !== undefined) {
      p.deletedAt = null;
      p.contentUpdatedAt = Date.now();
      M.bus.emit("prompt:restored", { promptId: id, collectionId: p.collectionId });
    }
    return Promise.resolve(p);
  },
};
const appState = { owner: "library", toasts: [], closed: 0 };
M.app = {
  setFocusOwner: (o) => { appState.owner = o; },
  focusOwner: () => appState.owner,
  toast: (t) => { appState.toasts.push(t); return { close() { appState.closed++; } }; },
  route: () => {},
};
M.store = { meta: { get: () => Promise.resolve(undefined), set: () => Promise.resolve() } };

const R = require(js("review"));

const events = [];
["review:graded", "review:ended", "prompt:deleted", "prompt:restored"].forEach((type) => {
  M.bus.on(type, (payload) => events.push({ type, payload }));
});
const ofType = (t) => events.filter((e) => e.type === t);

function card(i, fields) {
  return Object.assign({ i, createdAt: clock - 30 * DAY, lastReviewedAt: null, intervalMs: FIRST, dueAt: clock - 1000, log: [] }, fields);
}
function mkPrompt(fields) {
  const p = Object.assign({
    id: "p_x", collectionId: "b1", kind: "qa", text: "Q. What is x?\nA. 42", tags: [], flagged: false,
    anchor: { pageIndex: 3, pages: [{ pageIndex: 3, rects: [[72, 600, 300, 612]] }], quote: "x is 42", prefix: "", suffix: "", items: null, y: 612, lost: false },
    context: { docName: "Griffiths", sectionLabel: "Ch. 1", pageIndex: 3, pageLabel: "4" },
    createdAt: clock - 30 * DAY, contentUpdatedAt: clock - 30 * DAY, updatedAt: clock - 30 * DAY, deletedAt: null, v: 1,
  }, fields);
  if (!p.cards) p.cards = [card(0)];
  p.dueAt = Math.min(...p.cards.map((c) => c.dueAt));
  return p;
}
function cloze(id, pageIndex) {
  return mkPrompt({ id, kind: "cloze", text: "The {wave} is {complex}.", cards: [card(0), card(1)],
    anchor: Object.assign({}, mkPrompt({}).anchor, { pageIndex }) });
}
function reset(prompts) {
  if (R.isActive() || R.isSuspended()) R.stop();
  cacheState.prompts.clear(); cacheState.collections.clear();
  cacheState.saves.length = 0; cacheState.removes.length = 0; cacheState.restores.length = 0;
  cacheState.collections.set("b1", { id: "b1", kind: "book", name: "Griffiths", hasBytes: true, sections: [] });
  prompts.forEach((p) => cacheState.prompts.set(p.id, p));
  appState.owner = "library"; appState.toasts.length = 0; appState.closed = 0;
  events.length = 0;
}
const at = (pageIndex) => Object.assign({}, mkPrompt({}).anchor, { pageIndex });
const three = () => [mkPrompt({ id: "p_a", anchor: at(1) }), mkPrompt({ id: "p_b", anchor: at(2) }), mkPrompt({ id: "p_c", anchor: at(3) })];
const cur = () => { const c = R.current(); return c ? [c.item.promptId, c.item.cardIndex, c.revealed, c.position, c.total] : null; };
// The rest of the session, graded "remembered" card by card: the ids in order.
function drain() {
  const ids = [];
  for (let c = R.current(); c; c = R.current()) { ids.push(c.item.promptId + "#" + c.item.cardIndex); R.reveal(); clock += 1000; R.grade("remembered"); }
  return ids;
}
const stable = (sum) => { const o = Object.assign({}, sum); delete o.startedAt; delete o.endedAt; delete o.nextDueAt; o.log = o.log.map((e) => [e.promptId, e.cardIndex, e.outcome]); return o; };

// ---------------------------------------------------------------- flag

test("flag() toggles flagged with a content save, before and after reveal; the card stays where it was", async () => {
  reset(three());
  await R.start({ scope: "book", collectionId: "b1" });
  R.flag();
  assert.equal(cacheState.prompts.get("p_a").flagged, true);
  assert.deepEqual(cacheState.saves.map((s) => s.opts), [{ content: true }], "the reader's F kind of save");
  assert.deepEqual(cur(), ["p_a", 0, false, 1, 3]);
  R.reveal();
  R.flag();
  assert.equal(cacheState.prompts.get("p_a").flagged, false);
  assert.deepEqual(cur(), ["p_a", 0, true, 1, 3], "the answer stays shown");
  R.flag();
  assert.equal(cacheState.prompts.get("p_a").flagged, true);
  R.grade("remembered");
  assert.equal(cacheState.prompts.get("p_a").flagged, true, "the grade keeps the flag");
  assert.equal(R.current().item.promptId, "p_b");
  R.stop();
});

test("flag() and remove() do nothing on the end screen, the empty screen or while suspended", async () => {
  reset([mkPrompt({ id: "p_a" })]);
  await R.start({ scope: "book", collectionId: "b1" });
  R.suspend();
  R.flag(); R.remove();
  assert.equal(cacheState.saves.length, 0);
  assert.deepEqual(cacheState.removes, []);
  R.resume();
  R.reveal(); R.grade("remembered");                       // the end screen
  const saves = cacheState.saves.length;
  R.flag(); R.remove();
  assert.equal(cacheState.saves.length, saves);
  assert.deepEqual(cacheState.removes, []);
  R.stop();
  reset([]);
  await R.start({ scope: "book", collectionId: "b1" });    // the empty screen
  R.flag(); R.remove();
  assert.equal(cacheState.saves.length, 0);
  R.stop();
});

// ---------------------------------------------------------------- delete

test("remove() in the middle deletes the whole prompt at once; the next card shows unrevealed; prompt:deleted is handled once", async () => {
  reset(three());
  await R.start({ scope: "book", collectionId: "b1" });
  R.reveal(); R.grade("remembered");
  R.reveal();
  assert.deepEqual(cur(), ["p_b", 0, true, 2, 3]);
  R.remove();
  assert.deepEqual(cacheState.removes, ["p_b"], "M.cache.removePrompt, no confirm");
  assert.ok(cacheState.prompts.get("p_b").deletedAt, "tombstoned");
  assert.equal(ofType("prompt:deleted").length, 1);
  assert.deepEqual(cur(), ["p_c", 0, false, 2, 2], "the next card, its answer hidden; the deleted card left the queue");
  assert.equal(appState.toasts.length, 1);
  assert.equal(appState.toasts[0].text, "Prompt deleted");
  assert.equal(appState.toasts[0].ttl, 8000);
  assert.deepEqual(appState.toasts[0].actions.map((a) => a.label), ["Undo"]);
  assert.deepEqual(drain(), ["p_c#0"]);
  const sum = ofType("review:ended")[0].payload.summary;
  assert.equal(sum.deleted, 1);
  assert.equal(sum.reviewed, 2);
  assert.equal(sum.skipped, 0);
  R.stop();
});

test("undo() after remove() restores the prompt and the session exactly; the session then runs as if nothing happened", async () => {
  const runs = [];
  for (const withDelete of [false, true]) {
    clock = 1762250000000;
    reset(three());
    await R.start({ scope: "book", collectionId: "b1" });
    R.reveal(); R.grade("forgot");                         // p_a: asks 1, a retry tail later
    R.skip();                                              // p_b to the end: [a, b, c, b]
    R.reveal();
    const before = cur();
    if (withDelete) {
      R.remove();                                          // p_c
      assert.notDeepEqual(cur(), before);
      R.undo();
      assert.deepEqual(cacheState.restores, ["p_c"], "M.cache.restorePrompt");
      assert.equal(cacheState.prompts.get("p_c").deletedAt, null);
      assert.deepEqual(cur(), before, "queue, index and revealed as before the delete");
      assert.equal(appState.closed, 1, "the toast goes with the session's undo");
      R.undo();                                            // one undo step: nothing more to undo
      assert.deepEqual(cur(), before);
    }
    const ids = drain();
    runs.push({ ids, sum: stable(ofType("review:ended")[0].payload.summary) });
    R.stop();
  }
  assert.deepEqual(runs[1].ids, runs[0].ids);
  assert.deepEqual(runs[1].sum, runs[0].sum, "asks, skips, dropped and the log are as they were");
  assert.equal(runs[1].sum.deleted, 0);
});

test("remove() on the last card ends the session; undo from the end screen brings the card back", async () => {
  reset([mkPrompt({ id: "p_a", anchor: at(1) }), mkPrompt({ id: "p_b", anchor: at(2) })]);
  await R.start({ scope: "book", collectionId: "b1" });
  R.reveal(); R.grade("remembered");
  R.remove();                                              // p_b, the last card
  assert.equal(R.current(), null);
  assert.equal(R.isActive(), true, "the end screen");
  let sum = ofType("review:ended")[0].payload.summary;
  assert.equal(sum.deleted, 1);
  assert.equal(sum.reviewed, 1);
  R.undo();
  assert.deepEqual(cur(), ["p_b", 0, false, 2, 2]);
  R.reveal(); R.grade("remembered");
  sum = ofType("review:ended")[1].payload.summary;
  assert.equal(sum.deleted, 0);
  assert.equal(sum.reviewed, 2);
  R.stop();
});

test("remove() of the only card of a session: the end screen with 1 deleted, nothing reviewed; undo restores it", async () => {
  reset([mkPrompt({ id: "p_a" })]);
  await R.start({ scope: "book", collectionId: "b1" });
  R.remove();
  assert.equal(R.current(), null);
  const sum = ofType("review:ended")[0].payload.summary;
  assert.deepEqual([sum.total, sum.reviewed, sum.remembered, sum.forgot, sum.skipped, sum.deleted], [1, 0, 0, 0, 0, 1]);
  assert.deepEqual(sum.stillShaky, []);
  R.undo();
  assert.deepEqual(cur(), ["p_a", 0, false, 1, 1]);
  R.stop();
});

// D27: a session takes ONE card of a prompt (the guide: one blank per session), so a cloze prompt with two due cards
// stands in the queue once; its other blank waits for the next session (summary.held).
test("a session takes one card of a cloze prompt with two due cards; remove() takes it out and undo puts it back in its place; the other blank is held", async () => {
  const fresh = () => [cloze("p_z", 1), mkPrompt({ id: "p_b", anchor: at(2) }), mkPrompt({ id: "p_c", anchor: at(3) })];
  reset(fresh());
  await R.start({ scope: "book", collectionId: "b1" });
  const first = cur();
  assert.deepEqual(first, ["p_z", 0, false, 1, 3], "one cloze card and two Q./A. cards");
  const plain = drain();                                   // the order of a run without a delete
  assert.deepEqual(plain, ["p_z#0", "p_b#0", "p_c#0"]);
  const done = ofType("review:ended")[0].payload.summary;
  assert.deepEqual([done.total, done.reviewed, done.held], [3, 3, 1], "the cloze prompt's second blank waits for the next session");
  assert.equal(S.isDue(cacheState.prompts.get("p_z").cards[1], clock), true, "it is still due, untouched");
  R.stop();

  reset(fresh());
  await R.start({ scope: "book", collectionId: "b1" });
  R.remove();
  assert.deepEqual(cur(), ["p_b", 0, false, 1, 2], "the cloze card left the queue");
  assert.equal(ofType("prompt:deleted").length, 1);
  R.undo();
  assert.deepEqual(cur(), first, "the cloze card is current again");
  assert.deepEqual(drain(), plain, "back in its place");
  assert.equal(ofType("review:ended")[0].payload.summary.deleted, 0);
  R.stop();
});

test("remove() of a prompt on its retry, after its card was graded: it does not count as reviewed, and nothing of it is held", async () => {
  reset([cloze("p_z", 1)]);
  await R.start({ scope: "book", collectionId: "b1" });
  R.reveal(); R.grade("forgot");                           // card 0: wrong, so it comes back at the end of the pass
  assert.deepEqual(cur(), ["p_z", 0, false, 2, 2], "the same card again (never its sibling)");
  R.remove();
  const sum = ofType("review:ended")[0].payload.summary;
  assert.deepEqual([sum.reviewed, sum.grades, sum.remembered, sum.forgot, sum.deleted, sum.held], [0, 0, 0, 0, 1, 0], "a deleted prompt is not reviewed, and its other blank is not held");
  assert.deepEqual(sum.log, []);
  R.stop();
});

test("delete, then grade, then the toast's Undo: the prompt comes back but does not rejoin the session", async () => {
  reset(three());
  await R.start({ scope: "book", collectionId: "b1" });
  R.remove();                                              // p_a
  const undoBtn = appState.toasts[0].actions[0];
  R.reveal(); R.grade("remembered");                       // p_b: now the last step is a grade
  assert.deepEqual(cur(), ["p_c", 0, false, 2, 2]);
  undoBtn.run();
  assert.deepEqual(cacheState.restores, ["p_a"]);
  assert.equal(cacheState.prompts.get("p_a").deletedAt, null, "the prompt is restored");
  assert.deepEqual(cur(), ["p_c", 0, false, 2, 2], "the session is unchanged");
  assert.deepEqual(drain(), ["p_c#0"], "p_a does not rejoin, not even as a retry tail");
  const sum = ofType("review:ended")[0].payload.summary;
  assert.equal(sum.deleted, 0, "restored: not counted as deleted");
  assert.equal(sum.reviewed, 2);
  R.undo();                                                // the session's undo is the last grade, as ever
  assert.deepEqual(cur(), ["p_c", 0, true, 2, 2]);
  R.stop();
});

test("the toast's Undo while the delete is still the last step is the session's undo; after stop() it restores only", async () => {
  reset(three());
  await R.start({ scope: "book", collectionId: "b1" });
  R.reveal();
  const before = cur();
  R.remove();
  appState.toasts[0].actions[0].run();
  assert.deepEqual(cur(), before);
  R.remove();
  const run = appState.toasts[1].actions[0].run;
  R.stop();
  run();
  assert.equal(cacheState.prompts.get("p_a").deletedAt, null);
  assert.equal(R.isActive(), false);
});

test("a delete the cache refuses (a tab that stepped aside) leaves the session as it was", async () => {
  reset(three());
  const realRemove = M.cache.removePrompt;
  M.cache.removePrompt = () => Promise.resolve(null);      // M.cache in a locked tab: nothing changes
  try {
    await R.start({ scope: "book", collectionId: "b1" });
    R.reveal();
    const before = cur();
    R.remove();
    assert.deepEqual(cur(), before);
    assert.equal(appState.toasts.length, 0);
    R.undo();
    assert.deepEqual(cur(), before, "no undo step was made");
  } finally { M.cache.removePrompt = realRemove; R.stop(); }
});

test("the summary lists the prompts shown and flagged at the end; a still-shaky one stays in the still-shaky list", async () => {
  reset(three().concat([mkPrompt({ id: "p_d", anchor: at(4), flagged: true })]));
  await R.start({ scope: "book", collectionId: "b1" });
  R.flag();                                                // p_a flagged
  R.reveal(); R.grade("remembered");
  R.flag();                                                // p_b flagged …
  R.reveal(); R.grade("forgot");                           // … and still shaky at the end
  R.flag(); R.flag();                                      // p_c flagged and unflagged
  R.reveal(); R.grade("remembered");
  R.remove();                                              // p_d (flagged) deleted
  for (let c = R.current(); c; c = R.current()) { R.reveal(); R.grade("forgot"); }
  const sum = ofType("review:ended")[0].payload.summary;
  assert.deepEqual(sum.flagged, [{ promptId: "p_a", cardIndex: 0 }]);
  assert.deepEqual(sum.stillShaky, [{ promptId: "p_b", cardIndex: 0 }]);
  assert.equal(sum.deleted, 1);
  R.stop();
});

test("prompt:deleted from elsewhere is still handled as before (the current card is skipped)", async () => {
  reset(three());
  await R.start({ scope: "book", collectionId: "b1" });
  M.cache.removePrompt("p_a");
  assert.deepEqual(cur(), ["p_b", 0, false, 1, 2]);
  R.undo();
  assert.deepEqual(cur(), ["p_b", 0, false, 1, 2], "nothing to undo: it was not this session's delete");
  R.stop();
});

test("a prompt deleted in the session and restored by the toast's Undo holds nothing: its blanks are simply due again", async () => {
  reset([cloze("p_z", 1), mkPrompt({ id: "p_b", anchor: at(2) }), mkPrompt({ id: "p_c", anchor: at(3) })]);
  await R.start({ scope: "book", collectionId: "b1" });
  R.remove();                                              // p_z (two due blanks), on its first blank
  const undoBtn = appState.toasts[0].actions[0];
  R.reveal(); clock += 1000; R.grade("remembered");        // p_b: the delete is no longer the last step
  undoBtn.run();                                           // p_z is back in the library, but not in the session
  assert.equal(cacheState.prompts.get("p_z").deletedAt, null);
  assert.deepEqual(cur(), ["p_c", 0, false, 2, 2]);
  R.reveal(); clock += 1000; R.grade("remembered");
  const sum = ofType("review:ended")[0].payload.summary;
  assert.equal(sum.held, 0, "it left the session, so the session holds none of its blanks");
  assert.ok(sum.nextDueAt <= clock, "they are due all the same: the end line says “more due now”");
  R.stop();
});

// FIXES-1 FIX-8 a: a deleted prompt's cards are not counted as skipped (js/review.js summary). Since D27 a prompt
// stands in a session once, so its card cannot be dropped and then deleted; the case that is left: skipped once (it
// went to the end), then deleted when it comes back.
test("FIX-8 a: a card skipped once and deleted when it comes back: 0 skipped, 1 deleted", async () => {
  reset([cloze("p_z", 1), mkPrompt({ id: "p_b", anchor: at(2) })]);
  await R.start({ scope: "book", collectionId: "b1" });
  assert.deepEqual(cur(), ["p_z", 0, false, 1, 2]);
  R.skip();                                                // p_z once: to the end
  assert.equal(R.current().item.promptId, "p_b");
  R.skip();                                                // p_b once: to the end
  assert.deepEqual([R.current().item.promptId, R.current().item.cardIndex], ["p_z", 0]);
  R.remove();                                              // p_z deleted
  R.skip();                                                // p_b twice: dropped, the session ends
  const sum = ofType("review:ended")[0].payload.summary;
  assert.equal(sum.skipped, 1, "p_b was dropped; the deleted prompt's skip is not counted");
  assert.equal(sum.held, 0, "a deleted prompt holds nothing back");
  assert.equal(sum.deleted, 1);
  assert.equal(sum.reviewed, 0);
  R.stop();
});
