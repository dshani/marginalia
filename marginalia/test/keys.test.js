"use strict";
// Tests for js/keys.js (SPEC §7 "Configurable shortcuts", §12, §17.2 M.keys; BUILD-NOTES "Key routing").
// Run: node --test test/keys.test.js
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const keys = require("../js/keys.js");

// A fake keydown event. `target` defaults to a plain element (not a text field).
function ev(key, opts) {
  const o = opts || {};
  return {
    key, code: o.code || "",
    ctrlKey: !!o.ctrlKey, altKey: !!o.altKey, shiftKey: !!o.shiftKey, metaKey: !!o.metaKey,
    repeat: !!o.repeat, isComposing: !!o.isComposing,
    target: o.target || { tagName: "DIV" }
  };
}
const TEXTAREA = { tagName: "TEXTAREA" };
const INPUT = { tagName: "INPUT", type: "text" };
const CHECKBOX = { tagName: "INPUT", type: "checkbox" };
const SELECT = { tagName: "SELECT" };
const EDITABLE = { tagName: "DIV", isContentEditable: true };
const EDITABLE_ATTR = { tagName: "P", getAttribute: (n) => (n === "contenteditable" ? "" : null) };

describe("keys", () => {
  before(() => keys.setPlatform("mac"));
  after(() => keys.setPlatform(null));

  describe("normalize", () => {
    test("maps ' ' to Space", () => {
      assert.equal(keys.normalize(ev(" ")), "Space");
      assert.equal(keys.normalize(ev(" ", { shiftKey: true })), "Shift+Space");
      assert.equal(keys.normalize(ev("Spacebar")), "Space");
    });
    test("lower-cases letters and keeps Shift+ for them", () => {
      assert.equal(keys.normalize(ev("r")), "r");
      assert.equal(keys.normalize(ev("R", { shiftKey: true })), "Shift+r");
      assert.equal(keys.normalize(ev("A")), "a");                 // caps lock: no Shift flag, no Shift+
      assert.equal(keys.normalize(ev("S", { shiftKey: true })), "Shift+s");
    });
    test("keeps arrow and named keys as-is (with Shift)", () => {
      assert.equal(keys.normalize(ev("ArrowLeft")), "ArrowLeft");
      assert.equal(keys.normalize(ev("ArrowRight")), "ArrowRight");
      assert.equal(keys.normalize(ev("Enter", { shiftKey: true })), "Shift+Enter");
      assert.equal(keys.normalize(ev("Escape")), "Escape");
      assert.equal(keys.normalize(ev("Esc")), "Escape");           // legacy name
      assert.equal(keys.normalize(ev("Left")), "ArrowLeft");       // legacy name
      assert.equal(keys.normalize(ev("Backspace")), "Backspace");
      assert.equal(keys.normalize(ev("Delete")), "Delete");
    });
    test("takes the letter from ev.code when Alt is held (macOS Option symbols)", () => {
      assert.equal(keys.normalize(ev("ç", { code: "KeyC", altKey: true })), "Alt+c");
      assert.equal(keys.normalize(ev("Ç", { code: "KeyC", altKey: true, shiftKey: true })), "Alt+Shift+c");
      assert.equal(keys.normalize(ev("Dead", { code: "KeyE", altKey: true })), "Alt+e");
      assert.equal(keys.normalize(ev("c", { code: "KeyC", altKey: true })), "Alt+c"); // Windows reports the plain letter
    });
    test("uses other single characters as-is and never adds Shift to them", () => {
      assert.equal(keys.normalize(ev("?", { shiftKey: true })), "?");
      assert.equal(keys.normalize(ev(",")), ",");
      assert.equal(keys.normalize(ev("=", { metaKey: true })), "Meta+=");
      assert.equal(keys.normalize(ev("+", { metaKey: true, shiftKey: true })), "Meta++");
      assert.equal(keys.normalize(ev("-", { metaKey: true })), "Meta+-");
      assert.equal(keys.normalize(ev("1")), "1");
      assert.equal(keys.normalize(ev("1", { code: "Numpad1" })), "1");
    });
    test("orders modifiers Ctrl, Alt, Shift, Meta", () => {
      assert.equal(keys.normalize(ev("f", { ctrlKey: true, altKey: true, shiftKey: true, metaKey: true })), "Ctrl+Alt+Shift+Meta+f");
      assert.equal(keys.normalize(ev("f", { metaKey: true })), "Meta+f");
      assert.equal(keys.normalize(ev("f", { ctrlKey: true })), "Ctrl+f");
      assert.equal(keys.normalize(ev("Enter", { metaKey: true, shiftKey: true })), "Shift+Meta+Enter");
    });
    test("reports a bare modifier press as the modifier itself", () => {
      assert.equal(keys.normalize(ev("Shift", { shiftKey: true })), "Shift");
      assert.equal(keys.normalize(ev("Meta", { metaKey: true })), "Meta");
      assert.equal(keys.normalize(ev("Control", { ctrlKey: true })), "Ctrl");
      assert.equal(keys.normalize(ev("Alt", { altKey: true })), "Alt");
    });
    test("tolerates events without a key", () => {
      assert.equal(keys.normalize({ code: "KeyJ" }), "j");
      assert.equal(keys.normalize({}), "");
    });
  });

  describe("parse", () => {
    test("splits modifiers and the key", () => {
      assert.deepEqual(keys.parse("Shift+s"), { key: "s", ctrl: false, alt: false, shift: true, meta: false });
      assert.deepEqual(keys.parse("Alt+Shift+c"), { key: "c", ctrl: false, alt: true, shift: true, meta: false });
      assert.deepEqual(keys.parse("ctrl+alt+shift+meta+X"), { key: "x", ctrl: true, alt: true, shift: true, meta: true });
      assert.deepEqual(keys.parse("Space"), { key: "Space", ctrl: false, alt: false, shift: false, meta: false });
      assert.deepEqual(keys.parse(" "), { key: "Space", ctrl: false, alt: false, shift: false, meta: false });
      assert.deepEqual(keys.parse("Escape"), { key: "Escape", ctrl: false, alt: false, shift: false, meta: false });
      assert.deepEqual(keys.parse("esc"), { key: "Escape", ctrl: false, alt: false, shift: false, meta: false });
    });
    test("handles '+' as a key", () => {
      assert.deepEqual(keys.parse("Mod++"), { key: "+", ctrl: false, alt: false, shift: false, meta: true });
      assert.deepEqual(keys.parse("+"), { key: "+", ctrl: false, alt: false, shift: false, meta: false });
      assert.deepEqual(keys.parse("Mod+="), { key: "=", ctrl: false, alt: false, shift: false, meta: true });
    });
    test("expands Mod+ to Meta on macOS and Ctrl elsewhere", () => {
      keys.setPlatform("mac");
      assert.equal(keys.isMac(), true);
      assert.deepEqual(keys.parse("Mod+Enter"), { key: "Enter", ctrl: false, alt: false, shift: false, meta: true });
      keys.setPlatform("other");
      assert.equal(keys.isMac(), false);
      assert.deepEqual(keys.parse("Mod+Enter"), { key: "Enter", ctrl: true, alt: false, shift: false, meta: false });
      assert.deepEqual(keys.parse("Mod+Shift+Enter"), { key: "Enter", ctrl: true, alt: false, shift: true, meta: false });
      keys.setPlatform("mac");
    });
    test("returns an empty key for unbound / invalid bindings", () => {
      assert.equal(keys.parse(null).key, "");
      assert.equal(keys.parse("").key, "");
      assert.equal(keys.parse(undefined).key, "");
      assert.equal(keys.parse(42).key, "");
    });
    test("drops Shift on non-letter single characters, mirroring normalize", () => {
      assert.deepEqual(keys.parse("Shift+?"), { key: "?", ctrl: false, alt: false, shift: false, meta: false });
    });
    test("platform detection does not throw without a navigator", () => {
      keys.setPlatform(null);
      assert.doesNotThrow(() => keys.isMac());
      assert.equal(typeof keys.isMac(), "boolean");
      keys.setPlatform("mac");
    });
  });

  describe("match", () => {
    test("compares the normalized event with the binding", () => {
      assert.equal(keys.match(ev("f", { metaKey: true }), "Mod+f"), true);
      assert.equal(keys.match(ev("f", { ctrlKey: true }), "Mod+f"), false);
      assert.equal(keys.match(ev("R", { shiftKey: true }), "Shift+r"), true);
      assert.equal(keys.match(ev("R", { shiftKey: true }), "r"), false);
      assert.equal(keys.match(ev("r"), "Shift+r"), false);
      assert.equal(keys.match(ev(" "), "Space"), true);
      assert.equal(keys.match(ev("?", { shiftKey: true }), "?"), true);
      assert.equal(keys.match(ev("Enter", { shiftKey: true }), "Enter"), false);
      assert.equal(keys.match(ev("Enter", { metaKey: true }), "Mod+Enter"), true);
      assert.equal(keys.match(ev("+", { metaKey: true, shiftKey: true }), "Mod++"), true);
      keys.setPlatform("other");
      assert.equal(keys.match(ev("f", { ctrlKey: true }), "Mod+f"), true);
      assert.equal(keys.match(ev("f", { metaKey: true }), "Mod+f"), false);
      keys.setPlatform("mac");
    });
    test("accepts an array of bindings", () => {
      const both = ["Backspace", "Delete"];
      assert.equal(keys.match(ev("Backspace"), both), true);
      assert.equal(keys.match(ev("Delete"), both), true);
      assert.equal(keys.match(ev("x"), both), false);
      assert.equal(keys.match(ev("="), ["Mod+=", "Mod++"]), false);
      assert.equal(keys.match(ev("=", { metaKey: true }), ["Mod+=", "Mod++"]), true);
    });
    test("ignores ev.repeat", () => {
      assert.equal(keys.match(ev("j", { repeat: true }), "j"), true);
    });
    test("never matches an unbound action", () => {
      assert.equal(keys.match(ev("x"), null), false);
      assert.equal(keys.match(ev("x"), ""), false);
      assert.equal(keys.match(ev("x"), undefined), false);
      assert.equal(keys.match(ev("x"), []), false);
    });
    test("accepts a canonical string in place of the event", () => {
      assert.equal(keys.match("Shift+r", "Shift+r"), true);
      assert.equal(keys.match("Meta+f", "Mod+f"), true);
    });
  });

  describe("dispatch", () => {
    test("returns the first matching action id across maps, in order", () => {
      assert.equal(keys.dispatch(ev("j"), [keys.READER_MAP]), "next");
      assert.equal(keys.dispatch(ev("K", { shiftKey: true }), [keys.READER_MAP]), null); // Shift+k is unbound
      assert.equal(keys.dispatch(ev("Enter"), [keys.READER_MAP]), "toggleAnswer");
      assert.equal(keys.dispatch(ev("?", { shiftKey: true }), [keys.READER_MAP]), "shortcuts");
      assert.equal(keys.dispatch(ev(","), [keys.READER_MAP]), "settings");
      assert.equal(keys.dispatch(ev("=", { metaKey: true }), [keys.READER_MAP]), "zoomIn");
      assert.equal(keys.dispatch(ev("+", { metaKey: true, shiftKey: true }), [keys.READER_MAP]), "zoomIn");
      assert.equal(keys.dispatch(ev("-", { metaKey: true }), [keys.READER_MAP]), "zoomOut");
      assert.equal(keys.dispatch(ev("0", { metaKey: true }), [keys.READER_MAP]), "zoomFit");
      assert.equal(keys.dispatch(ev("f", { metaKey: true }), [keys.READER_MAP]), "find");
      assert.equal(keys.dispatch(ev("Delete"), [keys.READER_MAP]), "delete");
      assert.equal(keys.dispatch(ev("Backspace"), [keys.READER_MAP]), "delete");
      assert.equal(keys.dispatch(ev("S", { shiftKey: true }), [keys.READER_MAP]), "snipMode");
      assert.equal(keys.dispatch(ev("s"), [keys.READER_MAP]), "snip");
      assert.equal(keys.dispatch(ev("C", { shiftKey: true }), [keys.READER_MAP]), "markChapter");
      assert.equal(keys.dispatch(ev("q"), [keys.READER_MAP]), null);
      const first = { a: { binding: "x", inField: false } }, second = { b: { binding: "x", inField: false } };
      assert.equal(keys.dispatch(ev("x"), [first, second]), "a");
      assert.equal(keys.dispatch(ev("x"), [second, first]), "b");
      assert.equal(keys.dispatch(ev("x"), first), "a"); // a single map is accepted too
    });
    test("skips inField:false entries inside text fields and keeps inField:true ones", () => {
      assert.equal(keys.dispatch(ev("j", { target: TEXTAREA }), [keys.READER_MAP]), null);
      assert.equal(keys.dispatch(ev("j", { target: INPUT }), [keys.READER_MAP]), null);
      assert.equal(keys.dispatch(ev("j", { target: SELECT }), [keys.READER_MAP]), null);
      assert.equal(keys.dispatch(ev("j", { target: EDITABLE }), [keys.READER_MAP]), null);
      assert.equal(keys.dispatch(ev("j", { target: EDITABLE_ATTR }), [keys.READER_MAP]), null);
      assert.equal(keys.dispatch(ev("Enter", { metaKey: true, target: TEXTAREA }), [keys.EDITOR_MAP]), "save");
      assert.equal(keys.dispatch(ev("Enter", { metaKey: true, shiftKey: true, target: TEXTAREA }), [keys.EDITOR_MAP]), "saveAnother");
      assert.equal(keys.dispatch(ev("Escape", { target: TEXTAREA }), [keys.EDITOR_MAP]), "cancel");
      assert.equal(keys.dispatch(ev("Ç", { code: "KeyC", altKey: true, shiftKey: true, target: TEXTAREA }), [keys.EDITOR_MAP]), "wrapCloze");
      assert.equal(keys.dispatch(ev("c", { metaKey: true, shiftKey: true, target: TEXTAREA }), [keys.EDITOR_MAP]), null); // Cmd+Shift+C is left to the browser
      // entries without an explicit inField are treated as inField:false
      assert.equal(keys.dispatch(ev("x", { target: TEXTAREA }), [{ a: { binding: "x" } }]), null);
      assert.equal(keys.dispatch(ev("x", { target: TEXTAREA }), [{ a: "x" }]), null);
      // non-text inputs are not text fields
      assert.equal(keys.dispatch(ev("Escape", { target: CHECKBOX }), [keys.READER_MAP]), "escape");
      // review bindings never fire inside a text field
      assert.equal(keys.dispatch(ev(" ", { target: TEXTAREA }), [keys.reviewMap(keys.PRESETS.Default)]), null);
    });
    test("ignores composing events only (not repeats)", () => {
      assert.equal(keys.dispatch(ev("j", { isComposing: true }), [keys.READER_MAP]), null);
      assert.equal(keys.dispatch(ev("j", { repeat: true }), [keys.READER_MAP]), "next");
    });
    test("calls run(ev) when present and does not preventDefault", () => {
      let got = null, prevented = false;
      const e = ev("x");
      e.preventDefault = () => { prevented = true; };
      const map = { act: { binding: "x", inField: false, run: (x) => { got = x; } } };
      assert.equal(keys.dispatch(e, [map]), "act");
      assert.equal(got, e);
      assert.equal(prevented, false);
    });
    test("accepts plain string / array entries and skips unbound ones", () => {
      assert.equal(keys.dispatch(ev("x"), [{ a: "x" }]), "a");
      assert.equal(keys.dispatch(ev("y"), [{ a: ["x", "y"] }]), "a");
      assert.equal(keys.dispatch(ev("x"), [{ a: null, b: { binding: null }, c: "x" }]), "c");
      assert.equal(keys.dispatch(null, [keys.READER_MAP]), null);
      assert.equal(keys.dispatch(ev("x"), []), null);
      assert.equal(keys.dispatch(ev("x"), null), null);
    });
  });

  describe("presets and maps", () => {
    test("PRESETS are exactly the four of §7", () => {
      assert.deepEqual(Object.keys(keys.PRESETS), ["Default", "Arrows", "Vim", "Anki-like"]);
      // FEATURES P1.3 a: flag "f" and delete "Backspace" in every preset, after goToSource and before exit
      assert.deepEqual(keys.REVIEW_ACTIONS, ["showAnswer", "forgot", "remembered", "undo", "skip", "goToSource", "flag", "delete", "exit"]);
      const order = (p) => keys.REVIEW_ACTIONS.map((a) => p[a]).join(" ");
      assert.equal(order(keys.PRESETS.Default), "Space 1 2 u s g f Backspace Escape");
      assert.equal(order(keys.PRESETS.Arrows), "Space ArrowLeft ArrowRight u s g f Backspace Escape");
      assert.equal(order(keys.PRESETS.Vim), "Space j k u s g f Backspace q");
      assert.equal(order(keys.PRESETS["Anki-like"]), "Space 1 3 z s g f Backspace Escape");
      Object.keys(keys.PRESETS).forEach((name) => {
        assert.deepEqual(Object.keys(keys.PRESETS[name]), keys.REVIEW_ACTIONS, name);
        assert.deepEqual(keys.conflicts(keys.PRESETS[name]), [], name);
        assert.ok(Object.isFrozen(keys.PRESETS[name]));
      });
      assert.ok(Object.isFrozen(keys.PRESETS));
      assert.ok(Object.isFrozen(keys.READER_MAP));
      assert.ok(Object.isFrozen(keys.EDITOR_MAP));
      assert.ok(Object.isFrozen(keys.REVIEW_ACTIONS));
    });
    test("READER_MAP and EDITOR_MAP follow BUILD-NOTES", () => {
      const r = keys.READER_MAP;
      assert.deepEqual(Object.keys(r), ["prompt", "cloze", "highlight", "obsidianNote", "next", "prev", "edit", "toggleAnswer", "goToPassage", "flag",
        "delete", "undoDelete", "hideAnswers", "markers", "dim", "list", "find", "pageBox", "snip", "snipMode", "escape",
        "reviewBook", "reviewAll", "reviewToday", "markChapter", "zoomIn", "zoomOut", "zoomFit", "openPdf", "shortcuts", "settings"]);
      Object.keys(r).forEach((id) => assert.equal(r[id].inField, false, id));
      assert.equal(r.prompt.binding, "n");
      assert.equal(r.obsidianNote.binding, "o", "BUILD-NOTES \"Obsidian\": O, never inside text fields");
      assert.equal(keys.dispatch(ev("o"), [r]), "obsidianNote");
      assert.equal(keys.dispatch(ev("o", { target: TEXTAREA }), [r]), null);
      assert.equal(keys.dispatch(ev("o", { metaKey: true }), [r]), "openPdf", "Mod+O stays Add PDF");
      assert.deepEqual(r.delete.binding, ["Backspace", "Delete"]);
      assert.deepEqual(r.zoomIn.binding, ["Mod+=", "Mod++"]);
      assert.equal(r.find.binding, "Mod+f");
      assert.equal(r.markChapter.binding, "Shift+c");
      const e = keys.EDITOR_MAP;
      assert.deepEqual(Object.keys(e), ["save", "saveAnother", "cancel", "wrapCloze"]);
      Object.keys(e).forEach((id) => assert.equal(e[id].inField, true, id));
      assert.equal(e.save.binding, "Mod+Enter");
      assert.equal(e.saveAnother.binding, "Mod+Shift+Enter");
      assert.equal(e.cancel.binding, "Escape");
      assert.equal(e.wrapCloze.binding, "Alt+Shift+c");
      assert.deepEqual(keys.conflicts(r), []);
      assert.deepEqual(keys.conflicts(e), []);
    });
    test("reviewMap builds the dispatch shape, defaulting missing actions and keeping unbound ones", () => {
      const m = keys.reviewMap(keys.PRESETS.Arrows);
      keys.REVIEW_ACTIONS.forEach((a) => {
        assert.equal(m[a].inField, false, a);
        assert.equal(m[a].binding, keys.PRESETS.Arrows[a], a);
      });
      assert.equal(m.shortcuts.binding, "?");
      assert.equal(keys.dispatch(ev("ArrowLeft"), [m]), "forgot");
      assert.equal(keys.dispatch(ev("ArrowRight"), [m]), "remembered");
      assert.equal(keys.dispatch(ev(" "), [m]), "showAnswer");
      assert.equal(keys.dispatch(ev("Escape"), [m]), "exit");
      assert.equal(keys.dispatch(ev("?", { shiftKey: true }), [m]), "shortcuts");
      const partial = keys.reviewMap({ forgot: "ArrowLeft", remembered: null });
      assert.equal(partial.forgot.binding, "ArrowLeft");
      assert.equal(partial.remembered.binding, null);
      assert.equal(partial.showAnswer.binding, "Space");
      assert.equal(keys.dispatch(ev("2"), [partial]), null);
      assert.equal(keys.dispatch(ev("1"), [partial]), null);
      assert.equal(keys.dispatch(ev("ArrowLeft"), [partial]), "forgot");
      const fromMap = keys.reviewMap(keys.reviewMap(keys.PRESETS.Vim));
      assert.equal(fromMap.exit.binding, "q");
    });
    test("presetOf names the matching preset or returns null", () => {
      assert.equal(keys.presetOf(keys.PRESETS.Default), "Default");
      assert.equal(keys.presetOf({ showAnswer: " ", forgot: "1", remembered: "3", undo: "z", skip: "s", goToSource: "g", exit: "esc" }), "Anki-like");
      assert.equal(keys.presetOf(Object.assign({}, keys.PRESETS.Default, { forgot: "ArrowLeft" })), null);
      assert.equal(keys.presetOf(null), null);
    });
  });

  describe("conflicts", () => {
    test("lists each pair of action ids sharing a canonical binding once", () => {
      assert.deepEqual(keys.conflicts({ a: "x", b: "x", c: "y" }), [["a", "b"]]);
      assert.deepEqual(keys.conflicts({ a: "Mod+f", b: "Meta+f" }), [["a", "b"]]);
      assert.deepEqual(keys.conflicts({ a: ["x", "y"], b: "y" }), [["a", "b"]]);
      assert.deepEqual(keys.conflicts({ a: { binding: "Space" }, b: { binding: " " } }), [["a", "b"]]);
      assert.deepEqual(keys.conflicts({ a: "x", b: "x", c: "x" }), [["a", "b"], ["a", "c"], ["b", "c"]]);
      assert.deepEqual(keys.conflicts({ a: ["x", "x"], b: "y" }), []);
      assert.deepEqual(keys.conflicts({ a: null, b: null, c: "" }), []);
      assert.deepEqual(keys.conflicts({ a: "R", b: "Shift+r" }), []);          // "R" is the letter r, not Shift+r
      assert.deepEqual(keys.conflicts(Object.assign({}, keys.PRESETS.Default, { forgot: "s" })), [["forgot", "skip"]]);
      assert.deepEqual(keys.conflicts({}), []);
      assert.deepEqual(keys.conflicts(null), []);
    });
  });

  describe("label", () => {
    test("renders macOS symbols", () => {
      keys.setPlatform("mac");
      assert.equal(keys.label("Space"), "␣");
      assert.equal(keys.label("ArrowLeft"), "←");
      assert.equal(keys.label("ArrowRight"), "→");
      assert.equal(keys.label("ArrowUp"), "↑");
      assert.equal(keys.label("ArrowDown"), "↓");
      assert.equal(keys.label("Escape"), "esc");
      assert.equal(keys.label("Enter"), "↩");
      assert.equal(keys.label("Backspace"), "⌫");
      assert.equal(keys.label("Delete"), "⌦");
      assert.equal(keys.label("1"), "1");
      assert.equal(keys.label("u"), "U");
      assert.equal(keys.label("?"), "?");
      assert.equal(keys.label("Shift+s"), "⇧S");
      assert.equal(keys.label("Mod+Enter"), "⌘↩");
      assert.equal(keys.label("Mod+Shift+Enter"), "⇧⌘↩");
      assert.equal(keys.label("Alt+Shift+c"), "⌥⇧C");
      assert.equal(keys.label("Ctrl+f"), "⌃F");
      assert.equal(keys.label("Mod++"), "⌘+");
      assert.equal(keys.label("Meta"), "⌘");
      assert.equal(keys.label("Shift"), "⇧");
      assert.equal(keys.label("Alt"), "⌥");
      assert.equal(keys.label("Ctrl"), "⌃");
    });
    test("renders words for Ctrl/Alt elsewhere, joined with +", () => {
      keys.setPlatform("other");
      assert.equal(keys.label("Mod+Enter"), "Ctrl+↩");
      assert.equal(keys.label("Alt+Shift+c"), "Alt+⇧+C");
      assert.equal(keys.label("Ctrl+Alt+Shift+Meta+f"), "Ctrl+Alt+⇧+⌘+F");
      assert.equal(keys.label("Alt"), "Alt");
      assert.equal(keys.label("Ctrl"), "Ctrl");
      assert.equal(keys.label("Space"), "␣");
      keys.setPlatform("mac");
    });
    test("joins arrays with ' / ' and renders unbound as an empty string", () => {
      assert.equal(keys.label(["Backspace", "Delete"]), "⌫ / ⌦");
      assert.equal(keys.label(["Mod+=", "Mod++"]), "⌘= / ⌘+");
      assert.equal(keys.label(null), "");
      assert.equal(keys.label(""), "");
      assert.equal(keys.label([]), "");
    });
  });

  describe("helpers", () => {
    test("canonical expands Mod+ and normalises casing", () => {
      assert.equal(keys.canonical("mod+F"), "Meta+f");
      assert.equal(keys.canonical("shift+ESC"), "Shift+Escape");
      assert.equal(keys.canonical(" "), "Space");
      assert.equal(keys.canonical(null), "");
      assert.deepEqual(keys.canonical(["Mod+=", null]), ["Meta+="]);
    });
    test("isTextTarget recognises text fields", () => {
      assert.equal(keys.isTextTarget(TEXTAREA), true);
      assert.equal(keys.isTextTarget(INPUT), true);
      assert.equal(keys.isTextTarget({ tagName: "INPUT" }), true);
      assert.equal(keys.isTextTarget({ tagName: "input", type: "password" }), true);
      assert.equal(keys.isTextTarget(SELECT), true);
      assert.equal(keys.isTextTarget(EDITABLE), true);
      assert.equal(keys.isTextTarget(EDITABLE_ATTR), true);
      assert.equal(keys.isTextTarget({ tagName: "SPAN", parentNode: EDITABLE }), true);
      assert.equal(keys.isTextTarget(CHECKBOX), false);
      assert.equal(keys.isTextTarget({ tagName: "INPUT", type: "button" }), false);
      assert.equal(keys.isTextTarget({ tagName: "BUTTON" }), false);
      assert.equal(keys.isTextTarget({ tagName: "DIV" }), false);
      assert.equal(keys.isTextTarget(null), false);
    });
  });
});
