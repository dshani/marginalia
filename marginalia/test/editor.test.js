"use strict";
// Marginalia — test/editor.test.js: M.editor's own keydown handling and save hand-off on a minimal fake DOM.
//  - Auto-repeat never re-runs an editor action (SPEC §3: ev.repeat is ignored). The textarea's listener stops
//    propagation for its actions, so M.app's repeat guard never sees these keydowns and the editor must consume
//    the repeats itself: a held Alt+Shift+C wraps once, a held Cmd+Enter / Cmd+Shift+Enter saves once.
//  - A key already held when the textarea took the focus (the N / E / C that opened the editor) does not repeat
//    into it until a keydown starts there; real typing, which starts with one, repeats normally.
//  - A host whose onSave returns nothing (the deck box) gets a double press saved once, but an edit, its reset or
//    the end of the window in which it may still be writing releases that hold, so a host that never resets the
//    editor (nothing to add, a failed write) cannot lock it, and an unedited retry reaches it again.
// Run: node --test test/editor.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const editor = require(path.join(__dirname, "..", "js", "editor.js"));

// ---- fake DOM: what M.editor.create touches, plus focus events on the textarea ------------------------
let activeElement = null;
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
    // like a browser: focus() on the focused element fires nothing; otherwise the element gets a focus event
    focus() { if (activeElement !== el) { activeElement = el; el.dispatchEvent({ type: "focus" }); } },
    blur() { if (activeElement === el) activeElement = null; },
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
function withDom(fn) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, "document"), old = globalThis.document;
  globalThis.document = { createElement: fakeEl };
  activeElement = null;
  return Promise.resolve().then(fn).finally(() => { if (had) globalThis.document = old; else delete globalThis.document; });
}
function make(o) {
  return editor.create(Object.assign({ host: fakeEl("div"), prompt: null, initialText: "", anchor: null,
    onSave: () => {}, onCancel: () => {} }, o));
}

// A keydown as the browser delivers it to the focused textarea. When nobody cancelled it, a printable key
// (no Cmd / Ctrl) types its character at the caret, as the browser's default action does.
function press(target, key, o) {
  o = o || {};
  const ev = {
    type: "keydown", target, key, code: o.code || "", repeat: !!o.repeat, isComposing: false, keyCode: 0,
    metaKey: !!o.meta, ctrlKey: !!o.ctrl, altKey: !!o.alt, shiftKey: !!o.shift, defaultPrevented: false, stopped: false,
    preventDefault() { ev.defaultPrevented = true; },
    stopPropagation() { ev.stopped = true; }
  };
  target.dispatchEvent(ev);
  if (!ev.defaultPrevented && key.length === 1 && !ev.metaKey && !ev.ctrlKey) {
    target.setRangeText(key, target.selectionStart, target.selectionEnd, "end");
    target.dispatchEvent(new Event("input"));
  }
  return ev;
}
function consumed(ev) { return ev.defaultPrevented === true && ev.stopped === true; }
function edit(ta, value) { ta.value = value; ta.dispatchEvent(new Event("input")); }
function click(btn) { btn.dispatchEvent({ type: "click" }); }
function flush() { return new Promise((resolve) => setImmediate(resolve)); }
function deferred() { const d = {}; d.promise = new Promise((res, rej) => { d.resolve = res; d.reject = rej; }); return d; }

// ---- auto-repeat of the editor's own actions ------------------------------------------------------------
test("a held Alt+Shift+C wraps the selection once; every repeat is consumed and never reaches M.app", () => withDom(() => {
  const ed = make({ initialText: "the wave function" });
  const ta = ed.textarea;
  ed.focus();
  ta.setSelectionRange(4, 8);
  const first = press(ta, "Ç", { alt: true, shift: true, code: "KeyC" });     // macOS Option+Shift+C
  assert.ok(consumed(first));
  assert.equal(ta.value, "the {wave} function");
  for (let i = 0; i < 5; i++) {
    assert.ok(consumed(press(ta, "Ç", { alt: true, shift: true, code: "KeyC", repeat: true })), "repeat " + i);
  }
  assert.equal(ta.value, "the {wave} function");
  assert.deepEqual([ta.selectionStart, ta.selectionEnd], [5, 9], "the inner word stays selected");
  press(ta, "Ç", { alt: true, shift: true, code: "KeyC" });                    // a new press is deliberate
  assert.equal(ta.value, "the {{wave}} function");
  ed.destroy();
}));

test("a held Cmd+Enter saves once, even when the host resets the editor at once", () => withDom(() => {
  const saved = [];
  let ed = null;
  ed = make({ initialText: "Q. a\nA. b", onSave: (text) => { saved.push(text); ed.setText("Q. a\nA. b"); } });
  const ta = ed.textarea;
  ed.focus();
  assert.ok(consumed(press(ta, "Enter", { meta: true })));
  for (let i = 0; i < 4; i++) assert.ok(consumed(press(ta, "Enter", { meta: true, repeat: true })), "repeat " + i);
  assert.deepEqual(saved, ["Q. a\nA. b"]);
  assert.ok(consumed(press(ta, "Enter", { meta: true })));                     // a new press saves again
  assert.equal(saved.length, 2);
  ed.destroy();
}));

test("a held Cmd+Shift+Enter stores one prompt: the editor it reopens with Q. swallows the repeats", () => withDom(async () => {
  const host = fakeEl("div"), saves = [];
  let current = null;
  function open(text) {                                    // like M.margin.openEditor / onEditorSave
    const ed = editor.create({ host, prompt: null, initialText: text, anchor: null,
      onSave: (t, o) => {
        saves.push(t);
        ed.destroy();
        return Promise.resolve().then(() => { if (o.another) open("Q. "); });
      },
      onCancel: () => {} });
    current = ed;
    ed.focus();
    return ed;
  }
  const first = open("Q. first\nA. one");
  assert.ok(consumed(press(first.textarea, "Enter", { meta: true, shift: true })));
  await flush();
  assert.notEqual(current, first, "saveAnother opened a fresh editor");
  for (let i = 0; i < 6; i++) {
    assert.ok(consumed(press(current.textarea, "Enter", { meta: true, shift: true, repeat: true })), "repeat " + i);
    await flush();
  }
  assert.deepEqual(saves, ["Q. first\nA. one"], "no empty Q. prompts");
  assert.equal(current.textarea.value, "Q. ");
  current.destroy();
}));

test("Tab acts once per press: its repeats neither re-run it nor move the focus", () => withDom(() => {
  const ed = make({ initialText: "" });
  const ta = ed.textarea;
  ed.focus();
  assert.ok(consumed(press(ta, "Tab")));
  assert.equal(ta.value, "Q. ");
  for (let i = 0; i < 3; i++) assert.ok(consumed(press(ta, "Tab", { repeat: true })), "repeat " + i);
  assert.equal(ta.value, "Q. ");
  const step = editor.tabTarget("Q. ");
  assert.ok(consumed(press(ta, "Tab")));                                      // the next press takes the next step
  assert.equal(ta.value, step.base + step.text);
  ed.destroy();
}));

// ---- a key held while the editor opened ----------------------------------------------------------------
test("the N that opened the editor does not auto-repeat into it; typing that starts here repeats normally", () => withDom(() => {
  const ed = make({ initialText: "Q. " });
  const ta = ed.textarea;
  ed.focus();                                              // the host focuses the editor inside the N keydown
  for (let i = 0; i < 4; i++) assert.ok(consumed(press(ta, "n", { repeat: true })), "repeat " + i);
  assert.equal(ta.value, "Q. ");
  const x = press(ta, "x");                                // a fresh key: typed, and left to M.app's listener
  assert.equal(x.defaultPrevented, false);
  assert.equal(x.stopped, false);
  const xr = press(ta, "x", { repeat: true });             // its own auto-repeat types as usual
  assert.equal(xr.defaultPrevented, false);
  assert.equal(xr.stopped, false);
  assert.equal(ta.value, "Q. xx");
  ed.destroy();
}));

test("an existing prompt opened with E keeps its text; the guard re-arms whenever the textarea takes the focus", () => withDom(() => {
  const p = { id: "p_1", text: "Q. What?\nA. That" };
  const ed = make({ prompt: p, initialText: p.text });     // as M.margin.openEditor passes it
  const ta = ed.textarea;
  ed.focus();
  for (let i = 0; i < 3; i++) assert.ok(consumed(press(ta, "e", { repeat: true })));
  assert.equal(ta.value, "Q. What?\nA. That");
  press(ta, "s");
  assert.equal(ta.value, "Q. What?\nA. Thats");
  ta.blur();
  ed.focus();                                              // a key held while the focus comes back in
  assert.ok(consumed(press(ta, "c", { repeat: true })));
  assert.ok(consumed(press(ta, "Tab", { repeat: true })));
  assert.equal(ta.value, "Q. What?\nA. Thats");
  press(ta, "!");
  assert.equal(ta.value, "Q. What?\nA. Thats!");
  ed.destroy();
}));

// ---- a host whose onSave returns nothing -----------------------------------------------------------------
test("a host that returns nothing and never resets the editor cannot lock it; a double press still saves once", () => withDom(() => {
  const saved = [];
  // the deck box on a tags-only block: "Nothing to add", no setText
  const ed = make({ batch: true, draftKey: "deck:test", initialText: "#physics", onSave: (text) => { saved.push(text); } });
  const ta = ed.textarea, save = ed.el.querySelector(".editor__save");
  ed.focus();
  assert.ok(consumed(press(ta, "Enter", { meta: true })));
  assert.deepEqual(saved, ["#physics"]);
  assert.ok(consumed(press(ta, "Enter", { meta: true })));                     // the same, unedited text: held
  click(save);
  assert.deepEqual(saved, ["#physics"]);
  edit(ta, "Q. a\nA. b");                                  // an edit releases the hold
  assert.ok(consumed(press(ta, "Enter", { meta: true })));
  assert.deepEqual(saved, ["#physics", "Q. a\nA. b"]);
  edit(ta, "Q. c\nA. d");
  click(save);                                             // … for the Add button too
  assert.deepEqual(saved, ["#physics", "Q. a\nA. b", "Q. c\nA. d"]);
  edit(ta, "Q. c\nA. d!");
  edit(ta, "Q. c\nA. d");                                  // edited back to the same text: still a new round
  assert.equal(ed.run("save"), true);
  assert.equal(saved.length, 4);
  ed.setText("Q. e\nA. f");                                // the host's reset releases it as before
  assert.equal(ed.run("save"), true);
  assert.equal(ed.run("save"), true);
  assert.deepEqual(saved.slice(4), ["Q. e\nA. f"]);
  ed.destroy();
}));

test("an unedited retry reaches a host that returned nothing once it can no longer be writing (a failed write)", () => withDom(() => {
  const saved = [], realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    // the deck box when its write fails: "Could not save the prompts", the text stays, no setText
    const two = "Q. a\nA. b\n\nQ. c\nA. d";
    const ed = make({ batch: true, draftKey: "deck:retry", initialText: two, onSave: (text) => { saved.push(text); } });
    assert.equal(ed.run("save"), true);
    now += 1000;
    assert.equal(ed.run("save"), true);                    // 2 prompts: held for 1.55 s
    assert.equal(saved.length, 1);
    now += 600;
    assert.equal(ed.run("save"), true);                    // past it: the retry goes to the host
    assert.deepEqual(saved, [two, two]);
    assert.equal(ed.run("save"), true);                    // … and opens a new window
    assert.equal(saved.length, 2);
    // a bigger batch is held for longer: the host writes its prompts one by one
    const many = Array.from({ length: 41 }, (_, i) => "Q. q" + i + "\nA. a" + i).join("\n\n");
    ed.setText(many);
    assert.equal(ed.run("save"), true);
    assert.equal(saved.length, 3);
    now += 3000;
    assert.equal(ed.run("save"), true);                    // 41 prompts: held for 1.5 s + 40 × 50 ms
    assert.equal(saved.length, 3);
    now += 600;
    assert.equal(ed.run("save"), true);
    assert.equal(saved.length, 4);
    ed.destroy();
  } finally { Date.now = realNow; }
}));

test("a host promise holds further saves until it settles; after a rejection the same text can be retried", () => withDom(async () => {
  const saved = [], writes = [];
  const ed = make({ initialText: "Q. a\nA. b", onSave: (text) => { saved.push(text); const d = deferred(); writes.push(d); return d.promise; } });
  assert.equal(ed.run("save"), true);
  assert.equal(ed.run("save"), true);
  assert.equal(saved.length, 1, "held while the write is in flight");
  writes[0].reject(new Error("write failed"));
  await flush();
  assert.equal(ed.run("save"), true);
  assert.deepEqual(saved, ["Q. a\nA. b", "Q. a\nA. b"]);
  writes[1].resolve();
  await flush();
  ed.destroy();
}));

test("hint(msg) shows a host's word on a declined save in the lint line until the text changes; the save can be retried", () => withDom(async () => {
  const saved = [];
  let ed = null;
  // like M.margin for a blank free note: the host declines, keeps the editor open and says why
  ed = make({ initialText: "", onSave: (text) => {
    saved.push(text);
    if (!text.trim()) { ed.hint("Type a note first"); return Promise.resolve(null); }
    return Promise.resolve();
  } });
  const lint = ed.el.querySelector(".editor__lint");
  assert.equal(ed.run("save"), true);
  assert.equal(lint.textContent, "Type a note first");
  assert.equal(lint.className, "editor__lint editor__lint--warn");
  await flush();
  assert.equal(ed.run("save"), true, "a declined save holds nothing back");
  assert.equal(saved.length, 2);
  await flush();
  ed.setText("A real note");                               // the next refresh replaces the hint with the status line
  assert.notEqual(lint.textContent, "Type a note first");
  assert.equal(ed.run("save"), true);
  assert.deepEqual(saved, ["", "", "A real note"]);
  ed.destroy();
  ed.hint("ignored once destroyed");
  assert.notEqual(lint.textContent, "ignored once destroyed");
}));

// ---- Alt+Shift+C and a "::" in the selection (FEATURES P1.1 e) -----------------------------------------------
test("Alt+Shift+C writes a :: of the selection it wraps as \\::, keeps the wrapped text selected, and the preview shows a typed cue", () => withDom(async () => {
  const prompts = require(path.join(__dirname, "..", "js", "prompts.js"));
  const ed = make({ initialText: "see a::b here, and c::d too" });
  const ta = ed.textarea;
  ed.focus();
  ta.setSelectionRange(4, 8);
  assert.ok(consumed(press(ta, "Ç", { alt: true, shift: true, code: "KeyC" })));
  assert.equal(ta.value, "see {a\\::b} here, and c::d too", "only the wrapped part is escaped");
  assert.deepEqual([ta.selectionStart, ta.selectionEnd], [5, 10], "the wrapped text, with its backslash, stays selected");
  assert.deepEqual(prompts.parse(ta.value).deletions, [{ start: 4, end: 11, text: "a\\::b" }], "one deletion, no cue");
  // the {} button does the same
  ta.setSelectionRange(22, 26);
  click(ed.el.querySelector(".editor__wrap"));
  assert.equal(ta.value, "see {a\\::b} here, and {c\\::d} too");
  assert.deepEqual([ta.selectionStart, ta.selectionEnd], [23, 28]);
  // a selection without :: is wrapped as before
  edit(ta, "the wave function");
  ta.setSelectionRange(4, 8);
  press(ta, "Ç", { alt: true, shift: true, code: "KeyC" });
  assert.equal(ta.value, "the {wave} function");
  assert.deepEqual([ta.selectionStart, ta.selectionEnd], [5, 9]);

  // a cue typed by hand: the preview (card 0 hidden) shows the blank and its cue; the other deletion its hidden part
  edit(ta, "The {wave function::two words} is {complex::not real}.");
  await new Promise((resolve) => setTimeout(resolve, 200));          // the preview is debounced (120 ms)
  const preview = ed.el.querySelector(".editor__preview"), lint = ed.el.querySelector(".editor__lint");
  assert.equal(preview.innerHTML, '<div class="editor__pq">The <span class="cloze-blank" style="display:inline-block;width:7.2em" data-len="13"></span>' +
    ' <span class="cloze-cue">(two words)</span> is complex.</div>');
  assert.equal(lint.textContent, "Cloze · 2 cards");
  ed.destroy();
}));
