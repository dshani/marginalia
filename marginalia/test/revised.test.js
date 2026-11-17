"use strict";
// test/revised.test.js — FIXES-1 FIX-5 (2026-11-11): a prompt struggles counting from the last change of its TEXT.
// M.cache.savePrompt sets `revisedAt` (ms) when a content save ({content: true}) stores a text that differs from the text
// the cache last loaded or stored for that prompt; a new prompt has none; nothing else sets it. M.scheduler.promptMissDays
// counts from it (0 when absent), so a flag, tags, a move, or a delete and its undo keep a prompt struggling. The §9 import
// merge carries it with the text of the side that wins (M.exporter PROMPT_CONTENT_FIELDS).
// Real util, bus, scheduler, prompts, context, store (memory backend), cache and exporter. Run: node --test
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const js = (name) => path.join(__dirname, "..", "js", name + ".js");
["util", "bus", "settings", "scheduler", "prompts", "context", "store", "cache", "exporter"].forEach((n) => require(js(n)));
const M = globalThis.Marginalia;
const C = M.cache, S = M.scheduler, X = M.exporter;
const DAY = 86400000;

const now0 = Date.now();
const forgot = (daysAgo) => ({ at: now0 - daysAgo * DAY, outcome: "forgot", intervalMs: 600000, dueAt: now0 - daysAgo * DAY + 600000 });
function struggler(id, collectionId, text) {
  return {
    id, collectionId: collectionId || "bk_r", kind: "qa", text: text || "Q. What is the struggling prompt?\nA. this one", tags: [], flagged: false,
    anchor: null, context: null, createdAt: now0 - 30 * DAY,
    cards: [{ i: 0, createdAt: now0 - 30 * DAY, lastReviewedAt: now0 - 8 * DAY, intervalMs: 600000, dueAt: now0 + DAY, log: [forgot(10), forgot(9), forgot(8)] }]
  };
}
const struggles = (id) => S.promptMissDays(C.prompt(id)) >= S.STRUGGLE_DAYS;
const save = (fields, id) => C.savePrompt(Object.assign({}, C.prompt(id), fields), { content: true });

test.before(async () => {
  await C.load();
  await C.saveCollection({ id: "bk_r", kind: "book", name: "Revised book" });
  await C.saveCollection({ id: "dk_r", kind: "deck", name: "Revised deck" });
});

test("a new prompt has no revisedAt and struggles counting from 0", async () => {
  const p = await C.savePrompt(struggler("r_new"), { content: true });
  assert.equal("revisedAt" in p, false, "a new prompt has none");
  assert.equal(S.promptMissDays(p), 3);
  assert.equal(struggles("r_new"), true);
});

test("flag, unflag, tags, a move to a deck and a new passage keep it struggling; contentUpdatedAt still moves", async () => {
  await C.savePrompt(struggler("r_keep"), { content: true });
  const c0 = C.prompt("r_keep").contentUpdatedAt;
  await new Promise((r) => setTimeout(r, 5));
  await save({ flagged: true }, "r_keep");
  assert.ok(C.prompt("r_keep").contentUpdatedAt > c0, "the flag is a person's edit (§9 merge)");
  assert.equal(C.prompt("r_keep").revisedAt, undefined, "but no change of the text");
  assert.equal(struggles("r_keep"), true, "flag");
  await save({ flagged: false }, "r_keep");
  assert.equal(struggles("r_keep"), true, "unflag");
  await save({ tags: ["moved", "tagged"] }, "r_keep");
  assert.equal(struggles("r_keep"), true, "tags");
  await save({ collectionId: "dk_r", anchor: null, context: { docName: "Revised deck", sectionLabel: null, pageIndex: null, pageLabel: null } }, "r_keep");
  assert.equal(struggles("r_keep"), true, "a move to a deck");
  await save({ anchor: { pageIndex: 2, y: 10, quote: "q", pages: [] } }, "r_keep");
  assert.equal(struggles("r_keep"), true, "another passage");
  assert.equal(C.prompt("r_keep").revisedAt, undefined);
});

test("an edit of the text sets revisedAt and clears the struggling state; an unchanged text saved again does not move it", async () => {
  await C.savePrompt(struggler("r_edit"), { content: true });
  const before = Date.now();
  await save({ text: "Q. What is the revised prompt?\nA. this one" }, "r_edit");
  const r = C.prompt("r_edit").revisedAt;
  assert.ok(typeof r === "number" && r >= before);
  assert.equal(S.promptMissDays(C.prompt("r_edit")), 0);
  assert.equal(struggles("r_edit"), false);
  await new Promise((res) => setTimeout(res, 5));
  await save({ flagged: true }, "r_edit");
  await save({}, "r_edit");
  assert.equal(C.prompt("r_edit").revisedAt, r, "a flag or a save of the same text leaves it");
  // a save that is not a content save (an import, derived fields) never sets it
  await C.savePrompt(Object.assign({}, C.prompt("r_edit"), { text: "Q. imported text\nA. x" }), { content: false });
  assert.equal(C.prompt("r_edit").revisedAt, r);
  // ...and the next content save compares with that stored text
  await save({ flagged: false }, "r_edit");
  assert.equal(C.prompt("r_edit").revisedAt, r);
});

test("delete and undo keep it struggling", async () => {
  await C.savePrompt(struggler("r_del"), { content: true });
  await C.removePrompt("r_del");
  await C.restorePrompt("r_del");
  assert.equal(C.prompt("r_del").revisedAt, undefined);
  assert.equal(struggles("r_del"), true);
});

test("the text compared is the one last loaded or stored (after load(), an edit is still seen)", async () => {
  await C.savePrompt(struggler("r_load"), { content: true });
  await C.load();
  await save({ flagged: true }, "r_load");
  assert.equal(C.prompt("r_load").revisedAt, undefined);
  await save({ text: "Q. changed after a load\nA. x" }, "r_load");
  assert.equal(typeof C.prompt("r_load").revisedAt, "number");
});

test("an old record without the field counts from 0; promptMissDays reads revisedAt, never contentUpdatedAt", () => {
  const old = struggler("r_old");
  old.contentUpdatedAt = now0 - DAY;                       // an old record edited (flagged) yesterday
  assert.equal(S.promptMissDays(old), 3);
  assert.equal(S.promptMissDays(Object.assign({}, old, { revisedAt: now0 - DAY })), 0);
  assert.equal(S.promptMissDays(Object.assign({}, old, { revisedAt: now0 - 9 * DAY - 3600000 })), 2, "misses since the edit only");
});

test("the import merge carries revisedAt with the text of the side that wins; an invalid one is dropped", () => {
  const col = { id: "bk_m", kind: "book", name: "M", sections: [], addedAt: 1, lastOpenedAt: 1, updatedAt: 1, deletedAt: null, v: 1 };
  const base = { id: "pm_r", collectionId: "bk_m", kind: "qa", tags: [], flagged: false, anchor: null, context: null, cards: [], createdAt: 1, deletedAt: null, v: 1 };
  const local = Object.assign({}, base, { text: "Q. local\nA. x", contentUpdatedAt: 100, updatedAt: 100, revisedAt: 90 });
  const newer = Object.assign({}, base, { text: "Q. backup\nA. x", contentUpdatedAt: 200, updatedAt: 200, revisedAt: 180 });
  let m = X.merge({ collections: [col], prompts: [local], attachments: [] }, { collections: [col], prompts: [newer], attachments: [] }).state.prompts[0];
  assert.equal(m.text, "Q. backup\nA. x");
  assert.equal(m.revisedAt, 180, "the backup's text won, with its revisedAt");
  const older = Object.assign({}, base, { text: "Q. older\nA. x", contentUpdatedAt: 50, updatedAt: 50, revisedAt: 40 });
  m = X.merge({ collections: [col], prompts: [local], attachments: [] }, { collections: [col], prompts: [older], attachments: [] }).state.prompts[0];
  assert.equal(m.text, "Q. local\nA. x");
  assert.equal(m.revisedAt, 90, "the local text stayed, with its revisedAt");
  const bare = Object.assign({}, newer);
  delete bare.revisedAt;
  m = X.merge({ collections: [col], prompts: [local], attachments: [] }, { collections: [col], prompts: [bare], attachments: [] }).state.prompts[0];
  assert.equal(m.text, "Q. backup\nA. x");
  assert.equal("revisedAt" in m, false, "a winner without the field: the merged record has none (it counts from 0)");
  const fresh = Object.assign({}, newer, { id: "pm_new", revisedAt: "soon" });
  m = X.merge({ collections: [col], prompts: [], attachments: [] }, { collections: [col], prompts: [fresh], attachments: [] }).state.prompts[0];
  assert.equal("revisedAt" in m, false, "not a number: dropped");
  const ok = Object.assign({}, newer, { id: "pm_ok" });
  m = X.merge({ collections: [col], prompts: [], attachments: [] }, { collections: [col], prompts: [ok], attachments: [] }).state.prompts[0];
  assert.equal(m.revisedAt, 180, "a new prompt from a backup keeps it");
});
