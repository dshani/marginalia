"use strict";
// test/review.test.js — M.review session semantics (SPEC §7 "Session", §17.2, §17.3) without a DOM.
// Run from the project root: node --test test/review.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const M = (globalThis.Marginalia = globalThis.Marginalia || {});
const js = (name) => path.join(__dirname, "..", "js", name + ".js");
// Real pure modules (all present in this tree); stubs for the DOM/storage ones review.js talks to.
["util", "bus", "settings", "scheduler", "prompts", "context", "keys"].forEach((n) => require(js(n)));
const S = M.scheduler;
const { DAY, FIRST, LOOKAHEAD, MAX_ASKS } = S;

// ---- clock ---------------------------------------------------------------
let clock = 1762250000000; // t % 1000 === 0 → jitter 0 (2026-11-04, local)
const realNow = Date.now;
Date.now = () => clock;
test.after(() => { Date.now = realNow; });

// ---- stubs ---------------------------------------------------------------
const cacheState = { prompts: new Map(), collections: new Map(), saves: [] };
M.cache = {
  prompt: (id) => cacheState.prompts.get(id) || null,
  prompts: () => Array.from(cacheState.prompts.values()),
  promptsOf: (cid) => Array.from(cacheState.prompts.values()).filter((p) => p.collectionId === cid),
  collection: (id) => cacheState.collections.get(id) || null,
  collections: () => Array.from(cacheState.collections.values()),
  savePrompt(p, opts) {
    cacheState.saves.push({ prompt: p, opts });
    const saved = Object.assign({}, p, { updatedAt: Date.now() });
    cacheState.prompts.set(p.id, saved);
    M.bus.emit("prompt:saved", { prompt: saved, isNew: false });
    return Promise.resolve(saved);
  },
};
const appState = { owner: "library", routes: [], toasts: [] };
M.app = {
  setFocusOwner: (o) => { appState.owner = o; },
  focusOwner: () => appState.owner,
  toast: (t) => { appState.toasts.push(t); return { close() {} }; },
  route: (screen, params) => { appState.routes.push([screen, params]); },
};
const metaState = { data: {}, sets: [] };
M.store = {
  meta: {
    get: (k) => Promise.resolve(metaState.data[k]),
    set: (k, v) => { metaState.data[k] = v; metaState.sets.push([k, v]); return Promise.resolve(); },
  },
};

const R = require(js("review"));

// ---- event capture -------------------------------------------------------
const events = [];
["review:graded", "review:ended", "review:suspended", "review:resumed", "review:gotoSource"].forEach((type) => {
  M.bus.on(type, (payload) => events.push({ type, payload }));
});
const ofType = (t) => events.filter((e) => e.type === t);

// ---- fixtures ------------------------------------------------------------
function card(i, fields) {
  return Object.assign({ i, createdAt: clock - 30 * DAY, lastReviewedAt: null, intervalMs: FIRST, dueAt: clock - 1000, log: [] }, fields);
}
function mkPrompt(fields) {
  const p = Object.assign({
    id: "p_" + Math.random().toString(16).slice(2), collectionId: "b1", kind: "qa",
    text: "Q. What is x?\nA. 42", tags: [], flagged: false,
    anchor: { pageIndex: 3, pages: [{ pageIndex: 3, rects: [[72, 600, 300, 612]] }], quote: "x is 42", prefix: "", suffix: "", items: null, y: 612, lost: false },
    context: { docName: "Griffiths", sectionLabel: "Ch. 1 · The Wave Function", pageIndex: 3, pageLabel: "4" },
    createdAt: clock - 30 * DAY, contentUpdatedAt: clock - 30 * DAY, updatedAt: clock - 30 * DAY, deletedAt: null, v: 1,
  }, fields);
  if (!p.cards) p.cards = [card(0)];
  p.dueAt = Math.min(...p.cards.map((c) => c.dueAt));
  return p;
}
function reset(prompts, collections) {
  if (R.isActive() || R.isSuspended()) R.stop();
  cacheState.prompts.clear(); cacheState.collections.clear(); cacheState.saves.length = 0;
  (collections || [{ id: "b1", kind: "book", name: "Griffiths", hasBytes: true, sections: [] }, { id: "d1", kind: "deck", name: "Thermo", sections: [] }])
    .forEach((c) => cacheState.collections.set(c.id, c));
  (prompts || []).forEach((p) => cacheState.prompts.set(p.id, p));
  appState.owner = "library"; appState.routes.length = 0; appState.toasts.length = 0;
  metaState.data = {}; metaState.sets.length = 0;
  events.length = 0;
}
const key = (it) => it.promptId + "#" + it.cardIndex;

// ===========================================================================
test("start builds the queue, sets the focus owner and exposes current()", async () => {
  const a = mkPrompt({ id: "p_a" }), b = mkPrompt({ id: "p_b", anchor: Object.assign({}, mkPrompt({}).anchor, { pageIndex: 5 }) });
  reset([a, b]);
  await R.start({ scope: "book", collectionId: "b1" });
  assert.equal(R.isActive(), true);
  assert.equal(R.isSuspended(), false);
  assert.equal(appState.owner, "review");
  const c = R.current();
  assert.deepEqual(c.item, { promptId: "p_a", cardIndex: 0 });
  assert.equal(c.prompt.id, "p_a");
  assert.equal(c.card, a.cards[0]);
  assert.equal(c.revealed, false);
  assert.equal(c.position, 1);
  assert.equal(c.total, 2);
  R.stop();
  assert.equal(R.isActive(), false);
  assert.equal(R.current(), null);
});

test("grade is inert before reveal; reveal + grade persists at once with {content: false} and emits review:graded", async () => {
  const a = mkPrompt({ id: "p_a" });
  reset([a]);
  await R.start({ scope: "book", collectionId: "b1" });
  R.grade("remembered");                                  // nothing shown yet → ignored
  assert.equal(cacheState.saves.length, 0);
  assert.equal(R.current().position, 1);
  R.reveal();
  assert.equal(R.current().revealed, true);
  R.reveal();                                             // Space after reveal is inert
  assert.equal(R.current().revealed, true);
  const prev = a.cards[0];
  R.grade("remembered");
  assert.equal(cacheState.saves.length, 1);
  assert.deepEqual(cacheState.saves[0].opts, { content: false });
  const saved = cacheState.prompts.get("p_a");
  assert.notEqual(saved.cards[0], prev, "grade() produces a new card object");
  assert.equal(saved.cards[0].i, 0);
  assert.equal(saved.cards[0].lastReviewedAt, clock);
  assert.equal(saved.cards[0].log.length, 1);
  assert.equal(saved.cards[0].log[0].outcome, "remembered");
  assert.equal(saved.dueAt, saved.cards[0].dueAt, "prompt.dueAt = min(cards.dueAt)");
  assert.deepEqual(ofType("review:graded").map((e) => e.payload), [{ promptId: "p_a", cardIndex: 0, outcome: "remembered" }]);
  // the only card was remembered → the pass ends with nothing appended → the session ends
  assert.equal(R.current(), null);
  assert.equal(R.isActive(), true, "the end screen is still the overlay");
  const ended = ofType("review:ended");
  assert.equal(ended.length, 1);
  const sum = ended[0].payload.summary;
  assert.equal(sum.completed, true);
  assert.equal(sum.reviewed, 1);
  assert.equal(sum.remembered, 1);
  assert.equal(sum.forgot, 0);
  assert.equal(sum.skipped, 0);
  assert.deepEqual(sum.stillShaky, []);
  assert.equal(sum.scope, "book");
  assert.equal(sum.collectionId, "b1");
  assert.ok(sum.nextDueAt > clock + LOOKAHEAD, "next due is the remembered card, 5 d away");
  R.stop();
  assert.equal(ofType("review:ended").length, 1, "review:ended is emitted once per session");
  assert.equal(appState.owner, "library", "the previous focus owner is restored");
  assert.deepEqual(metaState.sets, [["pausedSession", null]], "pausedSession cleared on stop");
});

test("forgot cards return at the end of the pass until MAX_ASKS, then are 'still shaky'", async () => {
  const a = mkPrompt({ id: "p_a" }), b = mkPrompt({ id: "p_b" });
  reset([a, b]);
  await R.start({ scope: "book", collectionId: "b1" });
  R.reveal(); R.grade("forgot");                          // a: asks 1; the session brings it back (D28)
  assert.equal(R.current().item.promptId, "p_b");
  assert.equal(R.current().total, 2);
  clock += 1000;
  R.reveal(); R.grade("remembered");                      // end of pass 1 → a appended
  assert.equal(R.current().item.promptId, "p_a");
  assert.equal(R.current().position, 3);
  assert.equal(R.current().total, 3);
  clock += 1000;
  R.reveal(); R.grade("forgot");                          // asks 2 → appended again
  assert.equal(R.current().item.promptId, "p_a");
  assert.equal(R.current().total, 4);
  clock += 1000;
  R.reveal(); R.grade("forgot");                          // asks 3 = MAX_ASKS → not appended → session ends
  assert.equal(MAX_ASKS, 3);
  assert.equal(R.current(), null);
  const sum = ofType("review:ended")[0].payload.summary;
  assert.equal(sum.total, 2);
  assert.equal(sum.reviewed, 2);
  assert.equal(sum.grades, 4);
  assert.equal(sum.remembered, 1);
  assert.equal(sum.forgot, 3);
  assert.deepEqual(sum.stillShaky, [{ promptId: "p_a", cardIndex: 0 }]);
  assert.equal(cacheState.prompts.get("p_a").cards[0].log.length, 3);
  const shaky = cacheState.prompts.get("p_a").cards[0];
  assert.equal(S.isDue(shaky, clock), false, "a is not due again today (D28: the next day)");
  assert.equal(S.isDue(shaky, clock + S.NEXT_DAY), true);
  assert.deepEqual([shaky.intervalMs, shaky.growth], [S.LAPSE, 1725], "1 day, and one lapse for the three wrong answers");
  assert.equal(sum.nextDueAt, shaky.lastReviewedAt + S.NEXT_DAY, "the next due time is the still-shaky card's: 16 hours after its last answer");
  assert.equal(sum.shakyDueAt, shaky.lastReviewedAt + S.NEXT_DAY);
  assert.equal(sum.dueNow, 0, "nothing can be asked right now");
  R.stop();
});

test("an item whose prompt was away when its turn came returns at the end of the pass, while its card can still be asked", async () => {
  const at = (pageIndex) => Object.assign({}, mkPrompt({}).anchor, { pageIndex });
  const mk = () => [mkPrompt({ id: "p_a", anchor: at(1) }), mkPrompt({ id: "p_b", anchor: at(2) }), mkPrompt({ id: "p_c", anchor: at(3) })];
  reset(mk());
  await R.start({ scope: "book", collectionId: "b1" });
  const gone = cacheState.prompts.get("p_b");
  cacheState.prompts.delete("p_b");                        // away: deleted from elsewhere, not by the session's own delete
  R.reveal(); R.grade("remembered");                       // a; b's turn is passed over
  assert.equal(R.current().item.promptId, "p_c");
  cacheState.prompts.set("p_b", gone);                     // back before the pass ends
  R.reveal(); R.grade("remembered");                       // c: the end of the pass. b was never answered and is due: it comes now
  assert.equal(R.current().item.promptId, "p_b");
  R.reveal(); R.grade("remembered");
  assert.equal(R.current(), null);
  let sum = ofType("review:ended")[0].payload.summary;
  assert.deepEqual([sum.total, sum.reviewed, sum.remembered, sum.dueNow], [3, 3, 3, 0]);
  R.stop();
  // … but not when its card cannot be asked any more (it was answered elsewhere meanwhile)
  reset(mk());
  await R.start({ scope: "book", collectionId: "b1" });
  const b = cacheState.prompts.get("p_b");
  cacheState.prompts.delete("p_b");
  R.reveal(); R.grade("remembered");
  cacheState.prompts.set("p_b", Object.assign({}, b, { cards: [card(0, { lastReviewedAt: clock, dueAt: clock + 5 * DAY })] }));
  R.reveal(); R.grade("remembered");
  assert.equal(R.current(), null, "the session ends: b is not due");
  sum = ofType("review:ended")[0].payload.summary;
  assert.deepEqual([sum.total, sum.reviewed], [3, 2]);
  R.stop();
});

test("skip moves the item to the end once; a second skip drops it ungraded", async () => {
  const a = mkPrompt({ id: "p_a" }), b = mkPrompt({ id: "p_b" });
  reset([a, b]);
  await R.start({ scope: "book", collectionId: "b1" });
  R.skip();                                              // a → end: [b, a]
  assert.equal(R.current().item.promptId, "p_b");
  assert.equal(R.current().total, 2);
  R.skip();                                              // b → end: [a, b]
  assert.equal(R.current().item.promptId, "p_a");
  R.skip();                                              // a second time → dropped: [b]
  assert.equal(R.current().item.promptId, "p_b");
  assert.equal(R.current().total, 1);
  R.skip();                                              // b second time → dropped → nothing appended → ends
  assert.equal(R.current(), null);
  const sum = ofType("review:ended")[0].payload.summary;
  assert.equal(sum.skipped, 2);
  assert.equal(sum.reviewed, 0);
  assert.deepEqual(sum.stillShaky, []);
  assert.equal(cacheState.saves.length, 0, "skips persist nothing");
  assert.ok(sum.nextDueAt <= clock + LOOKAHEAD, "the dropped cards are still due now");
  R.stop();
});

test("undo restores the exact previous card object, persists it, steps back and removes the retry tail", async () => {
  const a = mkPrompt({ id: "p_a" }), b = mkPrompt({ id: "p_b" });
  reset([a, b]);
  await R.start({ scope: "book", collectionId: "b1" });
  R.reveal(); R.grade("forgot");                         // a forgot (asks 1)
  const prevB = cacheState.prompts.get("p_b").cards[0];
  R.reveal(); R.grade("remembered");                     // b remembered → end of pass → tail [a]
  assert.equal(R.current().item.promptId, "p_a");
  assert.equal(R.current().total, 3);
  assert.equal(ofType("review:graded").length, 2);
  const savesBefore = cacheState.saves.length;
  R.undo();
  const c = R.current();
  assert.equal(c.item.promptId, "p_b", "stepped back to the graded card");
  assert.equal(c.position, 2);
  assert.equal(c.total, 2, "the retry tail the undone grade appended is gone");
  assert.equal(c.revealed, true, "the answer was already seen");
  assert.equal(cacheState.prompts.get("p_b").cards[0], prevB, "the exact previous object is back");
  assert.equal(cacheState.saves.length, savesBefore + 1, "the restore is persisted");
  assert.equal(cacheState.saves[savesBefore].prompt.dueAt, prevB.dueAt);
  R.undo();                                              // single level: nothing more to undo
  assert.equal(R.current().item.promptId, "p_b");
  assert.equal(cacheState.saves.length, savesBefore + 1);
  // regrade b as forgot: the log of b holds exactly one entry (the undone one was dropped)
  R.grade("forgot");
  assert.equal(cacheState.prompts.get("p_b").cards[0].log.length, 1);
  assert.equal(R.current().item.promptId, "p_a");
  assert.equal(R.current().total, 4, "pass 2 = [a, b]");
  R.stop();
});

test("undo of a skip restores the queue order; undo from the end screen reopens the session", async () => {
  const a = mkPrompt({ id: "p_a" }), b = mkPrompt({ id: "p_b" });
  reset([a, b]);
  await R.start({ scope: "book", collectionId: "b1" });
  R.skip();
  assert.equal(R.current().item.promptId, "p_b");
  R.undo();
  assert.equal(R.current().item.promptId, "p_a");
  assert.equal(R.current().revealed, false);
  R.reveal(); R.grade("remembered");
  R.reveal(); R.grade("remembered");                     // session ends
  assert.equal(R.current(), null);
  assert.equal(ofType("review:ended").length, 1);
  R.undo();
  assert.equal(R.current().item.promptId, "p_b");
  assert.equal(R.current().revealed, true);
  R.grade("remembered");
  assert.equal(R.current(), null);
  assert.equal(ofType("review:ended").length, 2, "ending again after an undo emits review:ended again");
  R.stop();
  assert.equal(ofType("review:ended").length, 2);
});

test("a card whose prompt was deleted meanwhile is skipped", async () => {
  const a = mkPrompt({ id: "p_a" }), b = mkPrompt({ id: "p_b" }), c = mkPrompt({ id: "p_c" });
  reset([a, b, c]);
  await R.start({ scope: "book", collectionId: "b1" });
  cacheState.prompts.set("p_b", Object.assign({}, b, { deletedAt: clock }));
  R.reveal(); R.grade("remembered");
  assert.equal(R.current().item.promptId, "p_c", "b is skipped");
  assert.equal(R.current().total, 2);
  // the current prompt deleted while shown → prompt:deleted moves on
  cacheState.prompts.set("p_c", Object.assign({}, c, { deletedAt: clock }));
  M.bus.emit("prompt:deleted", { promptId: "p_c", collectionId: "b1" });
  assert.equal(R.current(), null, "nothing left → the session ended");
  const sum = ofType("review:ended")[0].payload.summary;
  assert.equal(sum.total, 3);
  assert.equal(sum.reviewed, 1);
  R.stop();
});

test("nothing due → an empty session: active, current() null, review:ended once on stop", async () => {
  const a = mkPrompt({ id: "p_a", cards: [card(0, { dueAt: clock + 10 * DAY, lastReviewedAt: clock - DAY })] });   // answered before; a card never asked is due at once (D27)
  reset([a]);
  await R.start({ scope: "book", collectionId: "b1" });
  assert.equal(R.isActive(), true);
  assert.equal(R.current(), null);
  assert.equal(ofType("review:ended").length, 0);
  R.reveal(); R.grade("remembered"); R.skip(); R.undo();  // all inert
  assert.equal(cacheState.saves.length, 0);
  R.stop();
  assert.equal(ofType("review:ended").length, 1);
  const sum = ofType("review:ended")[0].payload.summary;
  assert.equal(sum.total, 0);
  assert.equal(sum.reviewed, 0);
  assert.equal(sum.nextDueAt, clock + 10 * DAY - LOOKAHEAD, "the time from which a session can ask the card: its due time less the lookahead");
  assert.deepEqual([sum.dueNow, sum.held, sum.heldUntil, sum.shakyDueAt], [0, 0, null, null]);
});

test("today: prompts written today regardless of dueness; nothing written today → empty", async () => {
  const old = mkPrompt({ id: "p_old", cards: [card(0, { dueAt: clock + 3 * DAY })] });
  const fresh = mkPrompt({ id: "p_new", createdAt: clock - 1000, cards: [card(0, { createdAt: clock - 1000, dueAt: clock - 1000 + FIRST })] });
  reset([old]);
  await R.start({ scope: "today", collectionId: null });
  assert.equal(R.current(), null, "nothing written today");
  R.stop();
  reset([old, fresh]);
  await R.start({ scope: "today", collectionId: null });
  assert.deepEqual(R.current().item, { promptId: "p_new", cardIndex: 0 });
  assert.equal(R.current().total, 1);
  R.stop();
});

test("goToSource suspends (owner restored, pausedSession saved, events) and resume brings the session back", async () => {
  const a = mkPrompt({ id: "p_a" }), b = mkPrompt({ id: "p_b" });
  reset([a, b]);
  await R.start({ scope: "book", collectionId: "b1" });
  R.goToSource();
  assert.equal(R.isSuspended(), true);
  assert.equal(R.isActive(), false);
  assert.equal(appState.owner, "library", "the owner from before start is handed back");
  assert.deepEqual(ofType("review:suspended").map((e) => e.payload), [{ remaining: 2 }]);
  assert.deepEqual(ofType("review:gotoSource").map((e) => e.payload), [{ promptId: "p_a" }]);
  assert.deepEqual(metaState.data.pausedSession, { scope: "book", collectionId: "b1", index: 0 });
  assert.ok(R.current(), "the session stays in memory");
  R.reveal(); R.grade("remembered");                      // inert while suspended
  assert.equal(cacheState.saves.length, 0);
  appState.owner = "reader";                              // the app routed to the reader meanwhile
  R.resume();
  assert.equal(R.isActive(), true);
  assert.equal(appState.owner, "review");
  assert.deepEqual(ofType("review:resumed").map((e) => e.payload), [{ remaining: 2 }]);
  assert.equal(R.current().item.promptId, "p_a");
  R.suspend();
  assert.deepEqual(ofType("review:suspended").map((e) => e.payload), [{ remaining: 2 }, { remaining: 2 }]);
  R.suspend();                                            // idempotent
  assert.equal(ofType("review:suspended").length, 2);
  assert.equal(appState.owner, "reader", "the owner captured at resume is restored");
  R.resume();
  R.stop();
  assert.equal(appState.owner, "reader");
  assert.equal(metaState.data.pausedSession, null);
  assert.equal(R.isSuspended(), false);
});

test("goToSource is a no-op for deck prompts, lost anchors and books without bytes", async () => {
  const deck = mkPrompt({ id: "p_d", collectionId: "d1", anchor: null, context: { docName: "Thermo", sectionLabel: null, pageIndex: null, pageLabel: null } });
  const lost = mkPrompt({ id: "p_l", anchor: Object.assign({}, mkPrompt({}).anchor, { lost: true, pages: [] }) });
  const noBytes = mkPrompt({ id: "p_n", collectionId: "b2" });
  reset([deck, lost, noBytes], [
    { id: "b1", kind: "book", name: "Griffiths", hasBytes: true, sections: [] },
    { id: "b2", kind: "book", name: "Other", hasBytes: false, sections: [] },
    { id: "d1", kind: "deck", name: "Thermo", sections: [] },
  ]);
  for (const [scope, cid] of [["deck", "d1"], ["book", "b1"], ["book", "b2"]]) {
    await R.start({ scope, collectionId: cid });
    assert.ok(R.current(), scope + " " + cid);
    R.goToSource();
    assert.equal(R.isSuspended(), false, scope + " " + cid);
    R.stop();
  }
  assert.equal(ofType("review:gotoSource").length, 0);
  assert.equal(ofType("review:suspended").length, 0);
});

test("error codes: start rejects bad_scope; grade throws bad_outcome", async () => {
  reset([mkPrompt({ id: "p_a" })]);
  await assert.rejects(R.start({ scope: "weekly", collectionId: null }), (e) => e.code === "bad_scope");
  assert.equal(R.isActive(), false);
  await R.start({ scope: "all", collectionId: null });
  R.reveal();
  assert.throws(() => R.grade("meh"), (e) => e.code === "bad_outcome");
  assert.equal(R.current().position, 1, "a bad grade changes nothing");
  assert.equal(cacheState.saves.length, 0);
  R.stop();
});

test("a new start replaces a running or suspended session (ending it) and reviewKeys changes are harmless", async () => {
  const a = mkPrompt({ id: "p_a" });
  reset([a]);
  await R.start({ scope: "book", collectionId: "b1" });
  R.suspend();
  await R.start({ scope: "all", collectionId: null });
  assert.equal(ofType("review:ended").length, 1, "the suspended session ended");
  assert.equal(R.isActive(), true);
  assert.equal(R.isSuspended(), false);
  assert.equal(appState.owner, "review");
  M.settings.set("reviewKeys", M.keys.PRESETS.Arrows);
  assert.equal(R.current().item.promptId, "p_a");
  M.settings.set("reviewKeys", M.keys.PRESETS.Default);
  R.stop();
  assert.equal(ofType("review:ended").length, 2);
  assert.equal(appState.owner, "library");
});

/* SELF-CHECK: covers M.review start/stop/suspend/resume/reveal/grade/skip/undo/goToSource/current/isActive/
   isSuspended and the events review:graded, review:ended, review:suspended, review:resumed, review:gotoSource
   (SPEC §7 session semantics, §17.2, §17.3) with the real util/bus/settings/scheduler/prompts/context/keys and
   stubbed cache/app/store. */
