"use strict";
// Marginalia — test/marginui.test.js: js/editor.js and js/margin.js load without a DOM, expose the
// §17 / BUILD-NOTES contract, stay inert before mount, and their pure helpers behave.
// Run: node --test test/marginui.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const editor = require(path.join(__dirname, "..", "js", "editor.js"));
const margin = require(path.join(__dirname, "..", "js", "margin.js"));
const prompts = require(path.join(__dirname, "..", "js", "prompts.js"));

test("both modules load in node and expose the contract", () => {
  assert.equal(typeof editor.create, "function");
  const fns = ["mount", "setItems", "layout", "focus", "next", "prev", "setMode", "openEditor", "closeEditor",
    "activeEditor", "setAnswersHidden", "run", "escape", "closePopover", "focusedId", "setHot"];
  for (const fn of fns) assert.equal(typeof margin[fn], "function", "M.margin." + fn);
  assert.equal(globalThis.Marginalia.editor, editor);
  assert.equal(globalThis.Marginalia.margin, margin);
});

test("editor.create without a document throws code no_dom", () => {
  assert.throws(() => editor.create({}), (e) => e instanceof Error && e.code === "no_dom");
});

test("margin is inert before mount (no DOM): every call is safe and run() reports unhandled", () => {
  margin.mount();                       // no document → no-op
  assert.equal(margin.isMounted(), false);
  assert.equal(margin.run("next"), false);
  assert.equal(margin.run("prev"), false);
  assert.equal(margin.run("delete"), false);
  assert.equal(margin.run("undoDelete"), false);
  assert.equal(margin.run("escape"), false);
  assert.equal(margin.run("bogus"), false);
  assert.equal(margin.focusedId(), null);
  assert.equal(margin.activeEditor(), null);
  assert.equal(margin.escape(), false);
  assert.equal(margin.closePopover(), false);
  assert.equal(margin.closeEditor({ save: true }), false);
  assert.equal(margin.openEditor({ promptId: null, anchor: null, initialText: "Q. " }), null);
  assert.equal(margin.focus("nope"), false);
  margin.setItems([{ id: "x", text: "Q. a\nA. b" }]);
  margin.setHot("x");
  margin.setMode("markers");
  assert.equal(margin.mode(), "markers");
  margin.setMode("cards");
  margin.setAnswersHidden(true);
  margin.layout({ activeId: "x" });
});

test("Tab targets: empty → Q., Q.-only → append A., qa → caret after A.; Shift+Tab → after Q.", () => {
  assert.deepEqual(editor.tabTarget(""), { action: "insert", text: "Q. ", caret: 3 });
  const t = editor.tabTarget("Q. What does V stand for?");
  assert.equal(t.action, "append");
  assert.equal(t.base + t.text, "Q. What does V stand for?\nA. ");
  assert.equal(t.caret, "Q. What does V stand for?\nA. ".length);
  const c = editor.tabTarget("Q. What?\nA. The thing");
  assert.equal(c.action, "caret");
  assert.equal(c.caret, "Q. What?\nA. ".length);
  assert.equal(editor.tabTarget("The {wave} function"), null);
  assert.equal(editor.tabCapturable("The {wave} function"), false);
  assert.equal(editor.tabCapturable("Q. only"), true);
  assert.equal(editor.tabCapturable("Q. a\nA. b"), true);
  assert.equal(editor.tabCapturable("   "), true);
  assert.deepEqual(editor.shiftTabTarget("Q. What?\nA. x"), { action: "caret", caret: 3 });
  assert.equal(editor.shiftTabTarget("a plain note"), null);
});

test("wrapBraces wraps the selection and selects the inside; empty selection gives {} with the caret inside", () => {
  assert.deepEqual(editor.wrapBraces("the wave function", 4, 8), { text: "the {wave} function", start: 5, end: 9 });
  assert.deepEqual(editor.wrapBraces("ab", 1, 1), { text: "a{}b", start: 2, end: 2 });
  assert.deepEqual(editor.wrapBraces("ab", 5, 9), { text: "ab{}", start: 3, end: 3 });
});

test("draft keys: prompt id, new:<anchorHash> (stable), or an explicit override", () => {
  assert.equal(editor.draftKey({ id: "p_1" }, null), "marginalia.draft.p_1");
  const a = { pageIndex: 3, y: 100.5, quote: "a potential energy function", pages: [{ pageIndex: 3, rects: [[1, 2, 3, 4]] }], lost: false };
  assert.equal(editor.draftKey(null, a), "marginalia.draft.new:" + editor.anchorHash(a));
  assert.equal(editor.anchorHash(a), editor.anchorHash(JSON.parse(JSON.stringify(a))));
  assert.notEqual(editor.anchorHash(a), editor.anchorHash({ pageIndex: 4, y: 100.5, quote: "x", pages: [] }));
  assert.equal(editor.anchorHash(null), "0");
  assert.equal(editor.draftKey(null, null, "deck:d1"), "marginalia.draft.deck:d1");
  assert.equal(editor.DRAFT_PREFIX, "marginalia.draft.");
});

test("status line, card counts, save labels and the dropped-card question", () => {
  assert.equal(editor.cardCount(prompts.parse("Q. a\nA. b")), 1);
  assert.equal(editor.cardCount(prompts.parse("The {a} and {b} and {c}.")), 3);
  assert.equal(editor.cardCount(prompts.parse("just a note")), 0);
  assert.equal(editor.statusLine(prompts.parse("The {a} and {b} and {c}.")), "Cloze · 3 cards · Makes 3 cards");
  assert.equal(editor.statusLine(prompts.parse("Q. a\nA. b")), "Q/A · 1 card");
  assert.match(editor.statusLine(prompts.parse("Q. a")), /^Note · not reviewed · Add an A\. line/);
  assert.equal(editor.statusLine(prompts.parse(""), true), "Empty · saves as a highlight");
  assert.equal(editor.statusLine(prompts.parse(""), false), "Empty");
  assert.equal(editor.saveLabel(false, 0), "Save");
  assert.equal(editor.saveLabel(true, 0), "Add prompts");
  assert.equal(editor.saveLabel(true, 1), "Add 1 prompt");
  assert.equal(editor.saveLabel(true, 3), "Add 3 prompts");
  assert.equal(editor.droppedMessage([]), null);
  assert.equal(editor.droppedMessage([{ log: [] }]), null);
  assert.equal(editor.droppedMessage([{ log: [1, 2, 3, 4] }]), "This edit removes a card with 4 reviews. Save anyway?");
  assert.equal(editor.droppedMessage([{ log: [1] }, { log: [1, 2] }, { log: [] }]), "This edit removes 2 cards with 3 reviews. Save anyway?");
});

test("rail buckets merge anchors within 60 px; document order is (anchorY, createdAt); height estimate", () => {
  const b = margin.bucket([{ id: "d", y: 400 }, { id: "a", y: 10 }, { id: "b", y: 50 }, { id: "c", y: 71 }], 60);
  assert.deepEqual(b, [{ y: 10, ids: ["a", "b"] }, { y: 71, ids: ["c"] }, { y: 400, ids: ["d"] }]);
  assert.deepEqual(margin.bucket([], 60), []);
  assert.deepEqual(margin.bucket([{ id: "z", y: NaN }, { id: "y", y: 1 }], 60), [{ y: 1, ids: ["y"] }]);
  assert.deepEqual(margin.sortIds([{ id: "x", anchorY: 20, createdAt: 2 }, { id: "y", anchorY: 20, createdAt: 1 }, { id: "z", anchorY: 5, createdAt: 9 }]), ["z", "y", "x"]);
  assert.equal(margin.estimateHeight(""), 38);
  assert.equal(margin.estimateHeight("x".repeat(38)), 38);
  assert.equal(margin.estimateHeight("x".repeat(39)), 56);
  assert.equal(margin.BUCKET_PX, 60);
  assert.equal(margin.COLLAPSED_H, 24);
});

// ------------------------------------------------------------------------------------------------
// B7: image paste / drop placeholders (js/attachments.js attach + js/editor.js placePending/resolvePending)
// ------------------------------------------------------------------------------------------------
const attachments = require(path.join(__dirname, "..", "js", "attachments.js"));
const M = globalThis.Marginalia;

// A fake store + cache so url(), gc() and discard() run without IndexedDB; `removed` records deletions.
const removed = [];
let livePrompts = [];
const fakeStore = {
  attachments: {
    get: async () => null,
    remove: async (id) => { removed.push(id); },
    allIds: async () => [],
    put: async () => undefined
  },
  meta: { set: async () => undefined, get: async () => null }
};
const fakeCache = { prompts: () => livePrompts };

function withFakes(fn) {
  const hadStore = Object.prototype.hasOwnProperty.call(M, "store"), oldStore = M.store;
  const hadCache = Object.prototype.hasOwnProperty.call(M, "cache"), oldCache = M.cache;
  const origFromBlob = attachments.fromBlob;
  M.store = fakeStore;
  M.cache = fakeCache;
  removed.length = 0;
  livePrompts = [];
  return Promise.resolve().then(fn).finally(() => {
    attachments.fromBlob = origFromBlob;
    if (hadStore) M.store = oldStore; else delete M.store;
    if (hadCache) M.cache = oldCache; else delete M.cache;
  });
}

// A minimal element fake: enough DOM for M.editor.create (innerHTML is a string; querySelector hands out
// one child per selector; the textarea implements setRangeText per the HTML spec's selection modes).
function fakeEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(), className: "", value: "", placeholder: "", title: "", disabled: false,
    innerHTML: "", textContent: "", style: {}, attributes: {}, children: [], parentNode: null, listeners: {}, parts: {},
    selectionStart: 0, selectionEnd: 0, scrollHeight: 0,
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() { return false; } },
    addEventListener(t, fn) { (el.listeners[t] = el.listeners[t] || []).push(fn); },
    removeEventListener(t, fn) { const l = el.listeners[t] || []; const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); },
    dispatchEvent(ev) { (el.listeners[ev.type] || []).slice().forEach((fn) => fn.call(el, ev)); return true; },
    appendChild(c) { el.children.push(c); c.parentNode = el; return c; },
    removeChild(c) { const i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1); c.parentNode = null; return c; },
    setAttribute(k, v) { el.attributes[k] = String(v); },
    removeAttribute(k) { delete el.attributes[k]; },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(el.attributes, k) ? el.attributes[k] : null; },
    focus() {}, blur() {},
    setSelectionRange(a, b) { el.selectionStart = a; el.selectionEnd = b; },
    setRangeText(text, start, end, mode) {
      if (start === undefined) { start = el.selectionStart; end = el.selectionEnd; }
      const v = el.value, delta = text.length - (end - start);
      el.value = v.slice(0, start) + text + v.slice(end);
      let s = el.selectionStart, e = el.selectionEnd;
      if (mode === "select") { s = start; e = start + text.length; }
      else if (mode === "start") { s = e = start; }
      else if (mode === "end") { s = e = start + text.length; }
      else {
        if (s > end) s += delta; else if (s > start) s = start;
        if (e > end) e += delta; else if (e > start) e = start + text.length;
      }
      el.selectionStart = s; el.selectionEnd = e;
    },
    querySelector(sel) {
      if (!el.parts[sel]) el.parts[sel] = fakeEl(sel.indexOf("textarea") >= 0 ? "textarea" : "div");
      return el.parts[sel];
    }
  };
  return el;
}
function withFakeDom(fn) {
  return withFakes(() => {
    const had = Object.prototype.hasOwnProperty.call(globalThis, "document"), old = globalThis.document;
    globalThis.document = { createElement: fakeEl };
    return Promise.resolve().then(fn).finally(() => { if (had) globalThis.document = old; else delete globalThis.document; });
  });
}
function deferred() { const d = {}; d.promise = new Promise((res, rej) => { d.resolve = res; d.reject = rej; }); return d; }
const PENDING_TOKEN_RE = /!\[snip\]\(att:(pending-[\w-]+)\)/;

test("pendingChips swaps only this editor's placeholders for the Adding image… chip", () => {
  const missing = (id) => '<span class="att att--missing" data-id="' + id + '">Image missing</span>';
  assert.equal(editor.pendingChips("a " + missing("pending-ab-1") + " b", ["pending-ab-1"]),
    'a <span class="chip att--pending" data-id="pending-ab-1">Adding image…</span> b');
  assert.equal(editor.pendingChips(missing("a_x") + missing("pending-zz-9"), ["pending-ab-1"]), missing("a_x") + missing("pending-zz-9"));
  assert.equal(editor.pendingChips("<p>plain</p>", []), "<p>plain</p>");
  assert.equal(editor.PENDING_LABEL, "Adding image…");
});

test("attachments.attach: the placeholder lands first, the stored id replaces it; url/realId/resolveText follow the registry", () => withFakes(async () => {
  const calls = [];
  const ed = { placePending(pid) { calls.push(["place", pid]); return true; }, resolvePending(pid, id) { calls.push(["resolve", pid, id]); return true; } };
  attachments.fromBlob = () => Promise.resolve({ id: "a_ok" });
  const att = await attachments.attach({ size: 1, type: "image/png" }, ed);
  assert.equal(att.id, "a_ok");
  assert.equal(calls.length, 2);
  const pid = calls[0][1];
  assert.equal(calls[0][0], "place");
  assert.ok(attachments.isPendingId(pid), pid);
  assert.ok(pid.startsWith(attachments.PENDING_PREFIX));
  assert.deepEqual(calls[1], ["resolve", pid, "a_ok"]);
  assert.equal(attachments.realId(pid), "a_ok");
  assert.equal(attachments.realId("a_plain"), "a_plain");
  assert.equal(attachments.realId("pending-never-1"), null);
  assert.equal(attachments.isPendingId("a_ok"), false);
  assert.equal(attachments.resolveText("x ![snip](att:" + pid + ") y ![snip](att:pending-never-1)"), "x ![snip](att:a_ok) y ![snip](att:pending-never-1)");
  assert.equal(attachments.resolveText("no tokens"), "no tokens");
  assert.equal(attachments.url("pending-never-1"), null);        // unresolved: no store lookup, no URL
  assert.deepEqual(removed, []);
}));

test("attachments.attach: a failed image removes its placeholder with a toast; a closed editor discards the orphan", () => withFakes(async () => {
  const toasts = [];
  const hadApp = Object.prototype.hasOwnProperty.call(M, "app"), oldApp = M.app;
  M.app = { toast: (o) => { toasts.push(o.text); } };
  try {
    const calls = [];
    const ed = { placePending(pid) { calls.push(["place", pid]); return true; }, resolvePending(pid, id) { calls.push(["resolve", pid, id]); return id !== null; } };
    attachments.fromBlob = () => Promise.reject(Object.assign(new Error("big"), { code: "too_large" }));
    assert.equal(await attachments.attach({ size: 1, type: "image/png" }, ed), null);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1], ["resolve", calls[0][1], null]);
    assert.equal(attachments.realId(calls[0][1]), null);
    assert.match(toasts[0], /too large/i);
    assert.deepEqual(removed, []);

    // the editor closed before the image was stored: nothing holds the token → the attachment is deleted
    const gone = { placePending() { return true; }, resolvePending() { return false; } };
    attachments.fromBlob = () => Promise.resolve({ id: "a_orphan" });
    assert.equal(await attachments.attach({ size: 1, type: "image/png" }, gone), null);
    assert.deepEqual(removed, ["a_orphan"]);

    // … unless a live prompt references it
    livePrompts = [{ text: "Q. ![snip](att:a_kept)\nA. x", deletedAt: null }];
    attachments.fromBlob = () => Promise.resolve({ id: "a_kept" });
    assert.equal(await attachments.attach({ size: 1, type: "image/png" }, gone), null);
    assert.deepEqual(removed, ["a_orphan"]);
  } finally { if (hadApp) M.app = oldApp; else delete M.app; }
}));

test("attachments.gc never deletes an attachment a placeholder stands for; plain ids that left the text still go", () => withFakes(async () => {
  // an unresolved placeholder names nothing in the store
  assert.deepEqual(await attachments.gc("![snip](att:pending-zz-9)", ""), []);
  assert.deepEqual(removed, []);
  // a gc that runs while the swap is in flight (resolved, not yet written) must keep the attachment
  let pid = null, during = null;
  const ed = {
    placePending(p) { pid = p; return true; },
    resolvePending(p, id) { during = attachments.gc("![snip](att:" + p + ")", "", { draftIds: [] }); return true; }
  };
  attachments.fromBlob = () => Promise.resolve({ id: "a_live" });
  await attachments.attach({ size: 1, type: "image/png" }, ed);
  assert.deepEqual(await during, []);
  assert.deepEqual(removed, []);
  // after the swap the text holds the stored id: a resolved placeholder in an old text maps to it, and
  // the id is protected while any text still references it …
  assert.deepEqual(await attachments.gc("![snip](att:" + pid + ")", "![snip](att:a_live)"), []);
  assert.deepEqual(removed, []);
  // … and deleted once it left the text with nothing else referencing it
  assert.deepEqual(await attachments.gc("![snip](att:" + pid + ")", ""), ["a_live"]);
  assert.deepEqual(removed, ["a_live"]);
  assert.deepEqual(await attachments.gc("![snip](att:a_old) ![snip](att:a_stay)", "![snip](att:a_stay)"), ["a_old"]);
}));

test("editor: a pasted image shows a placeholder, Save reads Adding image…, Cmd+Enter waits and saves with the stored id", () => withFakeDom(async () => {
  const saved = [], blob = deferred();
  attachments.fromBlob = () => blob.promise;
  const ed = editor.create({ host: fakeEl("div"), prompt: null, initialText: "Q. see\nA. ", anchor: null,
    onSave: (text, o) => { saved.push([text, o.another]); }, onCancel: () => {} });
  const ta = ed.textarea, save = ed.el.querySelector(".editor__save");
  assert.equal(save.disabled, false);
  assert.match(save.innerHTML, /^Save /);
  const done = ed.insertAttachment({ size: 1, type: "image/png" });
  assert.equal(ed.pendingCount(), 1);
  const m = PENDING_TOKEN_RE.exec(ta.value);
  assert.ok(m, "placeholder at the caret: " + ta.value);
  assert.equal(ta.value, "Q. see\nA. ![snip](att:" + m[1] + ")");
  assert.equal(ta.selectionStart, ta.value.length, "caret after the token");
  assert.equal(save.disabled, true);
  assert.equal(save.innerHTML, "Adding image…");
  assert.equal(save.getAttribute("aria-busy"), "true");
  assert.match(ed.el.querySelector(".editor__preview").innerHTML, /class="chip att--pending"[^>]*>Adding image…</);
  // Cmd+Enter now: queued, not lost
  assert.equal(ed.run("save"), true);
  assert.equal(saved.length, 0);
  assert.match(ed.el.querySelector(".editor__lint").textContent, /Saves when the image is added/);
  // typing after the token while the image decodes keeps its place
  ta.setRangeText(" tail", ta.value.length, ta.value.length, "end");
  blob.resolve({ id: "a_real" });
  const att = await done;
  assert.equal(att.id, "a_real");
  assert.equal(ed.pendingCount(), 0);
  assert.deepEqual(saved, [["Q. see\nA. ![snip](att:a_real) tail", false]]);
  assert.equal(ta.value, "Q. see\nA. ![snip](att:a_real) tail");
  assert.equal(ta.selectionStart, ta.value.length, "caret shifted with the shorter token");
  assert.deepEqual(removed, []);
  ed.destroy();
}));

test("editor: a failed image drops its placeholder and the queued save still runs; the Save button recovers", () => withFakeDom(async () => {
  const saved = [], blob = deferred(), toasts = [];
  const hadApp = Object.prototype.hasOwnProperty.call(M, "app"), oldApp = M.app;
  M.app = { toast: (o) => { toasts.push(o.text); } };
  try {
    attachments.fromBlob = () => blob.promise;
    const ed = editor.create({ host: fakeEl("div"), prompt: null, initialText: "Q. a\nA. b", anchor: null,
      onSave: (text, o) => { saved.push([text, o.another]); }, onCancel: () => {} });
    const ta = ed.textarea, save = ed.el.querySelector(".editor__save");
    ta.setSelectionRange(4, 4);                                  // caret after "Q. a"
    const done = ed.insertAttachment({ size: 1, type: "image/png" });
    const m = PENDING_TOKEN_RE.exec(ta.value);
    assert.equal(ta.value, "Q. a![snip](att:" + m[1] + ")\nA. b");
    assert.equal(ed.run("saveAnother"), true);
    assert.equal(saved.length, 0);
    blob.reject(Object.assign(new Error("nope"), { code: "decode" }));
    assert.equal(await done, null);
    assert.equal(ta.value, "Q. a\nA. b");
    assert.deepEqual(saved, [["Q. a\nA. b", true]]);
    assert.match(toasts[0], /could not read/i);
    assert.equal(ed.pendingCount(), 0);
    assert.equal(save.disabled, false);
    assert.match(save.innerHTML, /^Save /);
    assert.equal(save.getAttribute("aria-busy"), null);
    ed.destroy();
  } finally { if (hadApp) M.app = oldApp; else delete M.app; }
}));

test("editor: Esc while an image is pending cancels at once; the late attachment is discarded", () => withFakeDom(async () => {
  const blob = deferred(); let cancelled = 0, ed = null;
  attachments.fromBlob = () => blob.promise;
  ed = editor.create({ host: fakeEl("div"), prompt: null, initialText: "Q. x\nA. ", anchor: null,
    onSave: () => { throw new Error("must not save"); }, onCancel: () => { cancelled++; ed.destroy(); } });
  const done = ed.insertAttachment({ size: 1, type: "image/png" });
  assert.equal(ed.run("save"), true);                            // queued …
  assert.equal(ed.run("cancel"), true);                          // … then abandoned
  assert.equal(cancelled, 1);
  assert.equal(ed.isDestroyed(), true);
  blob.resolve({ id: "a_late" });
  assert.equal(await done, null);
  assert.deepEqual(removed, ["a_late"]);
}));

test("editor: handleDrop places every placeholder at once, in order, and swaps each as it is stored", () => withFakeDom(async () => {
  const blobs = [deferred(), deferred()];
  let n = 0;
  attachments.fromBlob = () => blobs[n++].promise;
  const ed = editor.create({ host: fakeEl("div"), prompt: null, initialText: "", anchor: null, onSave: () => {}, onCancel: () => {} });
  const ta = ed.textarea;
  const ev = { dataTransfer: { items: [], files: [{ type: "image/png", size: 1 }, { type: "image/jpeg", size: 1 }] }, preventDefault() { this.prevented = true; } };
  assert.equal(attachments.handleDrop(ev, ed), true);
  assert.equal(ev.prevented, true);
  assert.equal(ed.pendingCount(), 2);
  const ids = ta.value.match(/pending-[\w-]+/g);
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1]);
  assert.equal(ta.value, "![snip](att:" + ids[0] + ")![snip](att:" + ids[1] + ")");
  blobs[0].resolve({ id: "a_first" });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(ta.value, "![snip](att:a_first)![snip](att:" + ids[1] + ")");
  assert.equal(ed.pendingCount(), 1);
  blobs[1].resolve({ id: "a_second" });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(ta.value, "![snip](att:a_first)![snip](att:a_second)");
  assert.equal(ed.pendingCount(), 0);
  assert.equal(ed.el.querySelector(".editor__save").disabled, false);
  ed.destroy();
}));

test("editor: a restored draft rewrites resolved placeholders to their stored ids; setText releases the saving flag", () => withFakeDom(async () => {
  // resolve a placeholder through attach so the registry knows it, then restore a draft that still names it
  let pid = null;
  attachments.fromBlob = () => Promise.resolve({ id: "a_draft" });
  await attachments.attach({ size: 1 }, { placePending(p) { pid = p; return true; }, resolvePending() { return true; } });
  const key = "deck:restore";
  const ls = new Map();
  globalThis.localStorage = { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => { ls.set(k, String(v)); }, removeItem: (k) => { ls.delete(k); }, get length() { return ls.size; }, key: (i) => Array.from(ls.keys())[i] };
  try {
    ls.set(editor.DRAFT_PREFIX + key, "Q. ![snip](att:" + pid + ")\nA. y");
    const saved = [];
    const ed = editor.create({ host: fakeEl("div"), prompt: null, initialText: "", anchor: null, batch: true, draftKey: key,
      onSave: (text) => { saved.push(text); }, onCancel: () => {} });
    assert.equal(ed.getText(), "Q. ![snip](att:a_draft)\nA. y");
    assert.equal(ed.run("save"), true);
    assert.deepEqual(saved, ["Q. ![snip](att:a_draft)\nA. y"]);
    assert.equal(ed.run("save"), true);                          // a synchronous host keeps `saving` …
    assert.equal(saved.length, 1);
    ed.setText("Q. again\nA. z");                                // … until it resets the editor for the next batch
    assert.equal(ed.run("save"), true);
    assert.deepEqual(saved, ["Q. ![snip](att:a_draft)\nA. y", "Q. again\nA. z"]);
    // a placeholder that was still decoding when the draft was restored is rewritten at save time
    ed.setText("Q. late ![snip](att:" + pid + ")\nA. z");
    assert.equal(ed.run("save"), true);
    assert.equal(saved[2], "Q. late ![snip](att:a_draft)\nA. z");
    ed.destroy();
  } finally { delete globalThis.localStorage; }
}));

test("card height estimates scale with the card width: 38 · cardWidth / 256 characters per line (compact cards are 192 px)", () => {
  assert.equal(margin.CARD_W, 256);
  // default (256): 38 characters per line, ceil(chars/38)·18 + 20
  assert.equal(margin.estimateHeight("x".repeat(38), null, 256), 38);
  assert.equal(margin.estimateHeight("x".repeat(76), null, 256), 56);
  assert.equal(margin.estimateHeight("x".repeat(76)), 56, "no width given: 256");
  // compact (192): 28.5 characters per line
  assert.equal(margin.estimateHeight("x".repeat(28), null, 192), 38);
  assert.equal(margin.estimateHeight("x".repeat(29), null, 192), 56);
  assert.equal(margin.estimateHeight("x".repeat(38), null, 192), 56, "a line at 256 wraps at 192");
  assert.equal(margin.estimateHeight("x".repeat(76), null, 192), 2 * 18 + 20 + 18, "ceil(76 / 28.5) = 3 lines");
  // a wider card never estimates taller; a narrower one never shorter
  for (const n of [1, 10, 37, 38, 39, 100, 500]) {
    const t = "x".repeat(n);
    assert.ok(margin.estimateHeight(t, null, 192) >= margin.estimateHeight(t, null, 256), "n=" + n);
    assert.ok(margin.estimateHeight(t, null, 320) <= margin.estimateHeight(t, null, 256), "n=" + n);
  }
  // Q/A counts question + answer; the image and row allowances do not depend on the width
  assert.equal(margin.estimateHeight("Q. " + "q".repeat(20) + "\nA. " + "a".repeat(20), null, 192), 2 * 18 + 20);
  assert.equal(margin.estimateHeight("x", null, 0), margin.estimateHeight("x", null, 256), "a bad width falls back to 256");
});
