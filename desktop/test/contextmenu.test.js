"use strict";
// lib/contextmenu.js: the right-click menu, from the params Electron's "context-menu" event carries (F1).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const cm = require("../lib/contextmenu");

const EDIT = { canUndo: true, canRedo: false, canCut: true, canCopy: true, canPaste: true, canDelete: true, canSelectAll: true, canEditRichly: false };
const NONE = { canUndo: false, canRedo: false, canCut: false, canCopy: false, canPaste: false, canDelete: false, canSelectAll: false, canEditRichly: false };
const params = (over) => Object.assign({ x: 10, y: 20, mediaType: "none", isEditable: false, selectionText: "", misspelledWord: "",
  dictionarySuggestions: [], editFlags: NONE, linkURL: "", hasImageContents: false }, over || {});

test("a misspelled word in the card editor: suggestions, Add to Dictionary, then the editing items", () => {
  const calls = [];
  const t = cm.buildTemplate(params({ isEditable: true, misspelledWord: "brwon", dictionarySuggestions: ["brown", "brow"], editFlags: EDIT }),
    { replaceMisspelling: (w) => calls.push(["replace", w]), addToDictionary: (w) => calls.push(["add", w]) });
  assert.deepEqual(cm.labels(t), ["brown", "brow", "Add to Dictionary", "-", "Cut", "Copy", "Paste", "Paste and Match Style", "Select All"]);
  t[0].click();
  t[2].click();
  assert.deepEqual(calls, [["replace", "brown"], ["add", "brwon"]]);
  assert.ok(t.filter((i) => i.role).every((i) => i.enabled === true));
});

test("no suggestions: a disabled No Guesses Found; at most five suggestions", () => {
  const none = cm.buildTemplate(params({ isEditable: true, misspelledWord: "qzxv", editFlags: EDIT }));
  assert.deepEqual(cm.labels(none).slice(0, 2), ["No Guesses Found", "Add to Dictionary"]);
  assert.equal(none[0].enabled, false);
  const many = cm.buildTemplate(params({ isEditable: true, misspelledWord: "x", dictionarySuggestions: ["a", "b", "c", "d", "e", "f", "g"], editFlags: EDIT }));
  assert.deepEqual(cm.labels(many).slice(0, 6), ["a", "b", "c", "d", "e", "Add to Dictionary"]);
});

test("an empty text field: the editing items, enabled as the page says", () => {
  const t = cm.buildTemplate(params({ isEditable: true, editFlags: Object.assign({}, NONE, { canPaste: true, canSelectAll: true }) }));
  assert.deepEqual(cm.labels(t), ["Cut", "Copy", "Paste", "Paste and Match Style", "Select All"]);
  assert.deepEqual(t.map((i) => i.enabled), [false, false, true, true, true]);
  assert.deepEqual(t.map((i) => i.role), ["cut", "copy", "paste", "pasteAndMatchStyle", "selectAll"]);
});

test("selected PDF text: Copy and Look Up", () => {
  const calls = [];
  const t = cm.buildTemplate(params({ selectionText: "  1 The Wave\nFunction  ", editFlags: Object.assign({}, NONE, { canCopy: true }) }),
    { lookUp: () => calls.push("lookUp") });
  assert.deepEqual(cm.labels(t), ["Copy", "-", "Look Up “1 The Wave Function”"]);
  t[2].click();
  assert.deepEqual(calls, ["lookUp"]);
  const long = cm.buildTemplate(params({ selectionText: "x".repeat(100), editFlags: EDIT }));
  assert.ok(cm.labels(long)[2].length <= "Look Up “”".length + 24);
});

test("a PDF page (a canvas) or an image: Copy Image at the click", () => {
  const calls = [];
  const t = cm.buildTemplate(params({ mediaType: "canvas", x: 78.4, y: 344 }), { copyImage: (x, y) => calls.push([x, y]) });
  assert.deepEqual(cm.labels(t), ["Copy Image"]);
  t[0].click();
  assert.deepEqual(calls, [[78, 344]]);
  assert.deepEqual(cm.labels(cm.buildTemplate(params({ mediaType: "image", hasImageContents: true }))), ["Copy Image"]);
  assert.deepEqual(cm.labels(cm.buildTemplate(params({ mediaType: "image", hasImageContents: false }))), []);
  assert.deepEqual(cm.labels(cm.buildTemplate(params({ mediaType: "canvas", selectionText: "word", editFlags: EDIT }))),
    ["Copy", "-", "Look Up “word”", "-", "Copy Image"]);
});

test("anything else gets no menu; no item navigates, saves, prints or opens tools", () => {
  assert.deepEqual(cm.buildTemplate(params()), []);
  assert.deepEqual(cm.buildTemplate(params({ linkURL: "https://example.invalid/" })), []);
  assert.deepEqual(cm.buildTemplate(null), []);
  const all = [
    cm.buildTemplate(params({ isEditable: true, misspelledWord: "x", dictionarySuggestions: ["y"], editFlags: EDIT, selectionText: "x" })),
    cm.buildTemplate(params({ mediaType: "canvas", selectionText: "x", editFlags: EDIT })),
    cm.buildTemplate(params({ mediaType: "video" }))
  ].flat();
  const roles = all.filter((i) => i.role).map((i) => i.role);
  assert.ok(roles.every((r) => ["cut", "copy", "paste", "pasteAndMatchStyle", "selectAll"].includes(r)), roles.join(","));
  for (const bad of ["Inspect", "Reload", "Back", "Save", "Print", "Open"]) assert.ok(!cm.labels(all).some((l) => l.startsWith(bad)), bad);
  assert.ok(all.every((i) => !i.accelerator), "a context menu registers no shortcut");
});

test("main.js shows the menu for each right-click and records it instead in self-test mode", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  assert.match(main, /wc\.on\("context-menu", \(event, params\) => showContextMenu\(win, params\)\);/);
  assert.match(main, /if \(SELF_TEST\) \{ state\.contextMenus\.push\(/);
  assert.match(main, /Menu\.buildFromTemplate\(template\)\.popup\(\{ window: win \}\)/);
});
