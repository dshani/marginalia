"use strict";
// test/review-keys.test.js — the review actions flag and delete (FEATURES P1.3 a; BUILD-NOTES "Prompt craft"):
// M.keys.REVIEW_ACTIONS and PRESETS, a settings.reviewKeys stored before they existed (M.keys.reviewMap and
// js/settings.js fill it by the same rule: never two review actions on one key), presetOf, and M.settings loading
// such a stored map from localStorage.
// Run from the project root: node --test
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// a localStorage that already holds settings from before this build (Vim keys, skip moved to "f")
const store = new Map([["marginalia.settings", JSON.stringify({ theme: "dark", reviewKeys: {
  showAnswer: "Space", forgot: "j", remembered: "k", undo: "u", skip: "F", goToSource: "g", exit: "q" } })]]);
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};
const js = (name) => path.join(__dirname, "..", "js", name + ".js");
const settings = require(js("settings"));
const keys = require(js("keys"));
test.after(() => { delete globalThis.localStorage; });

const LEGACY = { showAnswer: "Space", forgot: "1", remembered: "2", undo: "u", skip: "s", goToSource: "g", exit: "Escape" };
const late = (m) => [m.flag && typeof m.flag === "object" ? m.flag.binding : m.flag, m.delete && typeof m.delete === "object" ? m.delete.binding : m.delete];
const ev = (key) => ({ key, code: "", ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, target: null });

test("M.settings loads a stored map from before this build with the rule applied", () => {
  // the first test: M.settings reads localStorage at its first get(), before any set() below writes it
  const fresh = settings;
  const rk = fresh.get("reviewKeys");
  assert.equal(rk.skip, "F");
  assert.equal(rk.flag, null, "f is the stored skip: flag stays unbound");
  assert.equal(rk.delete, "Backspace");
  assert.equal(fresh.get("theme"), "dark");
  assert.equal(keys.presetOf(rk), null, "a custom map");
  assert.deepEqual(keys.conflicts(rk), []);
});

test("flag and delete are review actions after goToSource and before exit, bound f and Backspace in every preset", () => {
  assert.deepEqual(keys.REVIEW_ACTIONS.slice(-3), ["flag", "delete", "exit"]);
  assert.deepEqual(keys.LATE_REVIEW_ACTIONS, ["flag", "delete"]);
  Object.keys(keys.PRESETS).forEach((name) => {
    assert.equal(keys.PRESETS[name].flag, "f", name);
    assert.equal(keys.PRESETS[name].delete, "Backspace", name);
    assert.deepEqual(keys.conflicts(keys.PRESETS[name]), [], name);
  });
  const m = keys.reviewMap(keys.PRESETS.Default);
  assert.equal(keys.dispatch(ev("f"), [m]), "flag");
  assert.equal(keys.dispatch(ev("F"), [m]), "flag");
  assert.equal(keys.dispatch(ev("Backspace"), [m]), "delete");
  assert.equal(keys.dispatch(ev("Delete"), [m]), null, "only Backspace");
  assert.equal(keys.dispatch(Object.assign(ev("Backspace"), { target: { tagName: "TEXTAREA" } }), [m]), null, "never inside a text field");
});

test("a stored map from before this build gets flag f and delete Backspace", () => {
  assert.deepEqual(late(keys.reviewMap(LEGACY)), ["f", "Backspace"]);
  assert.deepEqual(late(keys.reviewMap({})), ["f", "Backspace"]);
  assert.deepEqual(late(keys.reviewMap(null)), ["f", "Backspace"]);
  assert.deepEqual(keys.conflicts(keys.reviewMap(LEGACY)), []);
});

test("a stored map whose other action already uses f or Backspace leaves the new action unbound", () => {
  const cases = [
    [{ skip: "f" }, [null, "Backspace"]],
    [{ skip: "F" }, [null, "Backspace"], "canonical: a letter's case"],
    [{ goToSource: " f " }, [null, "Backspace"]],
    [{ exit: ["q", "f"] }, [null, "Backspace"], "one key of several"],
    [{ exit: { binding: "f" } }, [null, "Backspace"], "dispatch-shaped"],
    [{ undo: "backspace" }, ["f", null]],
    [{ undo: "BackSpace" }, ["f", null]],
    [{ showAnswer: "Backspace", skip: "f" }, [null, null]],
    [{ delete: "f" }, [null, "f"], "a stored late action counts too"],
    [{ flag: "Backspace" }, ["Backspace", null]],
    [{ flag: null }, [null, "Backspace"], "an explicit null stays unbound"],
    [{ skip: "Shift+f" }, ["f", "Backspace"], "another key"],
    [{ skip: "Mod+f" }, ["f", "Backspace"], "another key"],
    [{ skip: "Alt+Backspace" }, ["f", "Backspace"], "another key"],
    [{ notAnAction: "f" }, ["f", "Backspace"], "unknown ids do not count"],
  ];
  for (const [stored, want, why] of cases) {
    const full = Object.assign({}, LEGACY, stored);
    const m = keys.reviewMap(full);
    assert.deepEqual(late(m), want, JSON.stringify(stored) + (why ? " — " + why : ""));
    const pairs = keys.conflicts(m).filter((p) => p.includes("flag") || p.includes("delete"));
    if (!(stored.delete === "f" || stored.flag === "Backspace" || stored.showAnswer === "Backspace")) assert.deepEqual(pairs, [], JSON.stringify(stored));
    assert.ok(late(m).every((b, i) => b === null || !Object.keys(full).some((a) => a !== ["flag", "delete"][i] && keys.REVIEW_ACTIONS.includes(a) &&
      [].concat(full[a] && typeof full[a] === "object" && !Array.isArray(full[a]) ? full[a].binding : full[a]).some((x) => keys.canonical(x) === keys.canonical(b)))),
      "never two review actions on one key: " + JSON.stringify(stored));
  }
});

test("js/settings.js fills a stored map exactly as M.keys.reviewMap does", () => {
  const vectors = [{}, LEGACY, { skip: "f" }, { skip: "F" }, { skip: " f " }, { skip: "Shift+f" }, { skip: "Mod+f" }, { skip: "Meta+f" },
    { undo: "backspace" }, { undo: "BackSpace" }, { exit: ["q", "f"] }, { exit: { binding: "f" } }, { forgot: "Foo+f" },
    { delete: "f" }, { flag: "Backspace" }, { flag: null }, { delete: "" }, { showAnswer: "Backspace", skip: "f" }, { foo: "f" },
    { forgot: 5 }, { skip: "Ctrl+Backspace" }, { remembered: ["Backspace"] }, { skip: "f", undo: "Backspace", flag: "x" }];
  for (const v of vectors) {
    settings.set("reviewKeys", Object.assign({}, v));
    const filled = settings.get("reviewKeys");
    const m = keys.reviewMap(v);
    assert.deepEqual(late(filled), late(m), JSON.stringify(v));
    keys.REVIEW_ACTIONS.forEach((a) => assert.ok(Object.prototype.hasOwnProperty.call(filled, a), a + " in the filled map"));
    assert.deepEqual(late(keys.reviewMap(filled)), late(m), "the filled map dispatches the same: " + JSON.stringify(v));
  }
});

test("presetOf: a stored map equal to a preset on the seven old actions, without the new ones, still reports it", () => {
  assert.equal(keys.presetOf(LEGACY), "Default");
  assert.equal(keys.presetOf({ showAnswer: "Space", forgot: "j", remembered: "k", undo: "u", skip: "s", goToSource: "g", exit: "q" }), "Vim");
  assert.equal(keys.presetOf(Object.assign({}, LEGACY, { flag: "f" })), "Default", "one of the two present");
  assert.equal(keys.presetOf(Object.assign({}, LEGACY, { flag: "x" })), null, "a present new action must match");
  assert.equal(keys.presetOf(Object.assign({}, LEGACY, { delete: null })), null, "an unbound delete is custom");
  assert.equal(keys.presetOf(keys.PRESETS.Arrows), "Arrows");
  const old7 = Object.assign({}, LEGACY); delete old7.skip;
  assert.equal(keys.presetOf(old7), null, "an old action missing is no preset, as before");
});
