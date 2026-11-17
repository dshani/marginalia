"use strict";
// test/review-owner.test.js — the focus owner across the review overlay's end and empty screens
// (SPEC §3 focus owner, §7 "End of session"; browser findings B1 / B4) without a DOM.
// M.app hands the owner back to the screen on review:ended; the overlay is still up on the end screen,
// so M.review must retake it and keep it until stop(). Run from the project root: node --test
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

// ---- stubs (the shapes review.js uses; M.app mimics js/app.js's review:ended listener) ----
const cacheState = { prompts: new Map(), collections: new Map() };
M.cache = {
  prompt: (id) => cacheState.prompts.get(id) || null,
  prompts: () => Array.from(cacheState.prompts.values()),
  collection: (id) => cacheState.collections.get(id) || null,
  savePrompt(p) {
    const saved = Object.assign({}, p, { updatedAt: Date.now() });
    cacheState.prompts.set(p.id, saved);
    M.bus.emit("prompt:saved", { prompt: saved, isNew: false });
    return Promise.resolve(saved);
  },
};
const appState = { owner: "library", screen: "library", ownerLog: [] };
M.app = {
  setFocusOwner: (o) => { appState.owner = o; appState.ownerLog.push(o); },
  focusOwner: () => appState.owner,
  toast: () => ({ close() {} }),
  route: () => {},
};
M.store = { meta: { get: () => Promise.resolve(undefined), set: () => Promise.resolve() } };
// js/app.js: on review:ended the owner goes back to the screen below the overlay.
M.bus.on("review:ended", () => {
  if (appState.owner !== "review") return;
  appState.owner = appState.screen === "reader" ? "reader" : "library";
  appState.ownerLog.push(appState.owner);
});
const R = require(js("review"));

const events = [];
["review:ended"].forEach((type) => M.bus.on(type, (payload) => events.push({ type, payload })));
const ended = () => events.filter((e) => e.type === "review:ended").length;

function card(fields) {
  return Object.assign({ createdAt: clock - 30 * DAY, lastReviewedAt: null, intervalMs: FIRST, dueAt: clock - 1000, log: [] }, fields);
}
function mkPrompt(fields) {
  const p = Object.assign({
    id: "p_" + Math.random().toString(16).slice(2), collectionId: "b1", kind: "qa", text: "Q. What is x?\nA. 42", tags: [], flagged: false,
    anchor: { pageIndex: 3, pages: [{ pageIndex: 3, rects: [[72, 600, 300, 612]] }], quote: "x is 42", prefix: "", suffix: "", items: null, y: 612, lost: false },
    context: { docName: "Griffiths", sectionLabel: "Ch. 1", pageIndex: 3, pageLabel: "4" },
    createdAt: clock - 30 * DAY, contentUpdatedAt: clock - 30 * DAY, updatedAt: clock - 30 * DAY, deletedAt: null, v: 1,
  }, fields);
  if (!p.cards) p.cards = [card({})];
  p.dueAt = Math.min(...p.cards.map((c) => c.dueAt));
  return p;
}
function reset(prompts, owner, screen) {
  if (R.isActive() || R.isSuspended()) R.stop();
  cacheState.prompts.clear(); cacheState.collections.clear();
  cacheState.collections.set("b1", { id: "b1", kind: "book", name: "Griffiths", hasBytes: true, sections: [] });
  cacheState.collections.set("d1", { id: "d1", kind: "deck", name: "Thermo", sections: [] });
  (prompts || []).forEach((p) => cacheState.prompts.set(p.id, p));
  appState.owner = owner || "library"; appState.screen = screen || "library"; appState.ownerLog.length = 0;
  events.length = 0;
}

// ===========================================================================
test("B1: the end screen keeps the owner \"review\" although review:ended handed it back; stop() restores it", async () => {
  reset([mkPrompt({ id: "p_a" })], "reader", "reader");
  await R.start({ scope: "book", collectionId: "b1" });
  assert.equal(appState.owner, "review");
  R.reveal(); R.grade("remembered");                      // the only card → the session ends on the end screen
  assert.equal(R.current(), null);
  assert.equal(R.isActive(), true, "the end screen is still the overlay");
  assert.equal(ended(), 1);
  assert.ok(appState.ownerLog.includes("reader"), "the app's listener did hand the owner back");
  assert.equal(appState.owner, "review", "…but the overlay retook it");
  R.stop();                                               // the exit binding / Back / Exit review
  assert.equal(R.isActive(), false);
  assert.equal(appState.owner, "reader", "the owner from before start() is back");
  assert.equal(ended(), 1, "review:ended is still emitted once per session");
});

test("B1: a session that ends from the library, and one re-ended after an undo, keep the owner too", async () => {
  reset([mkPrompt({ id: "p_a" }), mkPrompt({ id: "p_b" })], "library", "library");
  await R.start({ scope: "book", collectionId: "b1" });
  R.reveal(); R.grade("remembered");
  R.reveal(); R.grade("remembered");
  assert.equal(R.current(), null);
  assert.equal(appState.owner, "review");
  R.undo();                                               // reopens the session from the end screen
  assert.equal(R.current().item.promptId, "p_b");
  assert.equal(appState.owner, "review");
  R.grade("remembered");
  assert.equal(R.current(), null);
  assert.equal(ended(), 2, "ending again emits review:ended again");
  assert.equal(appState.owner, "review", "and the owner is retaken again");
  R.stop();
  assert.equal(appState.owner, "library");
});

test("B1: a prompt deleted while shown ends the session the same way", async () => {
  const a = mkPrompt({ id: "p_a" });
  reset([a], "reader", "reader");
  await R.start({ scope: "book", collectionId: "b1" });
  cacheState.prompts.set("p_a", Object.assign({}, a, { deletedAt: clock }));
  M.bus.emit("prompt:deleted", { promptId: "p_a", collectionId: "b1" });
  assert.equal(R.current(), null);
  assert.equal(R.isActive(), true);
  assert.equal(appState.owner, "review");
  R.stop();
  assert.equal(appState.owner, "reader");
});

test("B4: nothing due opens an active empty session that holds the owner until stop()", async () => {
  // a card answered before and not due yet (a card never asked would be due at once: D27)
  reset([mkPrompt({ id: "p_a", collectionId: "d1", anchor: null, cards: [card({ dueAt: clock + 5 * DAY, lastReviewedAt: clock - DAY })] })], "library", "library");
  for (const [scope, cid] of [["deck", "d1"], ["book", "b1"], ["all", null], ["today", "d1"], ["today", null]]) {
    await R.start({ scope, collectionId: cid });
    assert.equal(R.isActive(), true, scope + ": active");
    assert.equal(R.isSuspended(), false, scope);
    assert.equal(R.current(), null, scope + ": nothing to show");
    assert.equal(appState.owner, "review", scope + ": the overlay owns the keys");
    assert.equal(ended(), 0, scope + ": no review:ended before stop()");
    R.reveal(); R.grade("remembered"); R.skip(); R.undo(); // inert
    assert.equal(R.isActive(), true, scope);
    R.stop();                                             // the exit binding / Back
    assert.equal(R.isActive(), false, scope);
    assert.equal(appState.owner, "library", scope + ": the previous owner is restored");
    assert.equal(ended(), 1, scope + ": review:ended once, on stop()");
    const sum = events[0].payload.summary;
    assert.equal(sum.total, 0, scope);
    assert.equal(sum.scope, scope);
    events.length = 0;
  }
});

/* SELF-CHECK: the focus owner stays "review" on the end screen (after review:ended, which M.app answers by
   handing the owner to the screen) and on the empty screen until stop(), which restores the previous owner;
   review:ended is emitted once per ending (twice across an undo), and once on stop() for an empty session. */
