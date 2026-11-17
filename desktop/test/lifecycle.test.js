"use strict";
// lib/lifecycle.js: the one switch (CLOSE_HIDES) and what closing the window does in both of its positions
// (test/main.test.js runs main.js with it, also switched off).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const lifecycle = require("../lib/lifecycle");

test("the switch is on: closing the window hides it (FEATURES E2.3 b), and it is a named constant main.js reads", () => {
  assert.equal(lifecycle.CLOSE_HIDES, true);
  const main = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  assert.match(main, /^const CLOSE_HIDES = lifecycle\.CLOSE_HIDES;/m);
  assert.match(main, /lifecycle\.closeAction\(\{ closeHides: CLOSE_HIDES, quitting: state\.quitting, fullScreen: win\.isFullScreen\(\), windows: openCount\(\) \}\)/);
  assert.match(main, /app\.on\("window-all-closed", \(\) => \{ if \(lifecycle\.quitWhenAllClosed\(CLOSE_HIDES\)\) app\.quit\(\); \}\);/);
  assert.match(main, /app\.on\("before-quit", \(\) => \{ state\.quitting = true; state\.quitFront = theWindow\(\); \}\);/);
});

test("switch on: a close hides the window, a full-screen one leaves full screen first; while quitting it closes", () => {
  assert.equal(lifecycle.closeAction({ closeHides: true, quitting: false, fullScreen: false }), "hide");
  assert.equal(lifecycle.closeAction({ closeHides: true, quitting: false, fullScreen: true }), "leave-full-screen");
  assert.equal(lifecycle.closeAction({ closeHides: true, quitting: true, fullScreen: false }), "close");
  assert.equal(lifecycle.closeAction({ closeHides: true, quitting: true, fullScreen: true }), "close");
  assert.equal(lifecycle.quitWhenAllClosed(true), false);
});

test("switch off (part 1): a close closes, and the last window closing quits the app", () => {
  for (const quitting of [false, true]) for (const fullScreen of [false, true]) {
    assert.equal(lifecycle.closeAction({ closeHides: false, quitting, fullScreen }), "close");
  }
  assert.equal(lifecycle.quitWhenAllClosed(false), true);
  assert.equal(lifecycle.closeAction(null), "close");
  assert.equal(lifecycle.closeAction({}), "close");
});

test("several windows (DECISIONS D31): a window that is not the last one closes for good; the last one hides, as before", () => {
  const A = lifecycle.closeAction;
  for (const fullScreen of [false, true]) {
    for (const windows of [2, 3, 8]) assert.equal(A({ closeHides: true, quitting: false, fullScreen, windows }), "close-window", String(windows));
    assert.equal(A({ closeHides: true, quitting: true, fullScreen, windows: 3 }), "close", "while the app quits every window just closes");
    assert.equal(A({ closeHides: false, quitting: false, fullScreen, windows: 3 }), "close", "the switch off: as part 1");
  }
  assert.equal(A({ closeHides: true, quitting: false, fullScreen: false, windows: 1 }), "hide");
  assert.equal(A({ closeHides: true, quitting: false, fullScreen: true, windows: 1 }), "leave-full-screen");
  // a count that is no whole number above 1 is "this is the only window"
  for (const bad of [0, -1, 1.5, 2.5, "2", null, undefined, NaN, Infinity]) {
    assert.equal(A({ closeHides: true, quitting: false, fullScreen: false, windows: bad }), "hide", String(bad));
  }
  const main = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  assert.match(main, /if \(action === "close-window"\) \{ closeForGood\(win\); return; \}/);
});

test("tabAction: what a tab command of the Window menu does in each state of the windows (DECISIONS D30)", () => {
  const A = lifecycle.tabAction;
  const front = { front: true, window: true }, behind = { front: false, window: true }, none = { front: false, window: false };
  // the main window in front: the page runs every command
  for (const id of ["newTab", "closeTab", "reopenTab", "nextTab", "prevTab"]) assert.equal(A(id, front), "run", id);
  // hidden, minimized or behind another window: the two that open something bring it to the front first
  assert.equal(A("newTab", behind), "show-and-run");
  assert.equal(A("reopenTab", behind), "show-and-run");
  // Cmd+W then belongs to the window that is in front (the About panel, Developer Tools of their own)
  assert.equal(A("closeTab", behind), "close-front");
  assert.equal(A("nextTab", behind), "none");
  assert.equal(A("prevTab", behind), "none");
  // no main window at all
  assert.equal(A("newTab", none), "show");
  assert.equal(A("reopenTab", none), "show");
  assert.equal(A("closeTab", none), "close-front");
  assert.equal(A("nextTab", none), "none");
  // while the app quits nothing runs; a name that is no menu command never does
  for (const id of ["newTab", "closeTab", "reopenTab", "nextTab", "prevTab"]) assert.equal(A(id, { front: true, window: true, quitting: true }), "none", id);
  for (const bad of ["tab1", "lastTab", "bogus", "", null, undefined]) for (const s of [front, behind, none]) assert.equal(A(bad, s), "none", String(bad));
  assert.equal(A("newTab"), "show");
  assert.equal(A("closeTab", null), "close-front");
});

test("closesWindow: only Close Tab closes the window, and only when the page has no tab of its own to close", () => {
  const C = lifecycle.closesWindow;
  assert.equal(C("closeTab", "last"), true, "one tab left: Cmd+W closes the window, which hides it");
  assert.equal(C("closeTab", "none"), true, "a page that did not load");
  assert.equal(C("closeTab", "done"), false, "a tab closed");
  assert.equal(C("closeTab", "blocked"), false, "more tabs, and a review or a dialog on screen: the window stays");
  for (const id of ["newTab", "reopenTab", "nextTab", "prevTab", "tab1", "", null]) {
    for (const answer of ["done", "last", "blocked", "none"]) assert.equal(C(id, answer), false, id + " " + answer);
  }
  for (const answer of [undefined, null, true, false, "", "closed"]) assert.equal(C("closeTab", answer), false, String(answer));
});

test("main.js shows a window that the user asked for at once; the self-test shows none, and counts one that was made visible", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  assert.match(main, /\n    show: !!extra && !SELF_TEST,\n/, "an extra window is on screen at once, but never in the self-test");
  assert.match(main, /\n  if \(win\.isVisible\(\)\) state\.windowEverShown = true;\n/);
  assert.match(main, /win\.once\("ready-to-show", \(\) => \{\n    if \(SELF_TEST\) return;\n    if \(!win\.isVisible\(\)\) win\.show\(\);/);
  assert.match(main, /windowEverShown: state\.windowEverShown \|\| /);
});

test("main.js asks tabAction with the window's real state and runs only lib/menu.js tabScript in the page", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  assert.match(main, /lifecycle\.tabAction\(id, \{ front: !!w && w\.isFocused\(\), window: !!w, quitting: state\.quitting \}\)/);
  assert.match(main, /const script = menu\.tabScript\(id\);/);
  assert.match(main, /\.then\(\(v\) => menu\.tabAnswer\(v\), \(\) => "none"\)/);
  assert.match(main, /if \(lifecycle\.closesWindow\(id, answer\) && state\.win === w && !w\.isDestroyed\(\) && !state\.quitting\) w\.close\(\);/);
  assert.match(main, /Menu\.sendActionToFirstResponder\("performClose:"\)/);
  assert.equal(/ipcMain|ipcRenderer|contextBridge/.test(main), false, "still no ipc channel");
  // the self-test runs the probe and gives its answer to the verdict; the probe asks tabScript itself
  assert.match(main, /extra\.tabs = await probeTabs\(wc\);/);
  // … and the windows probe (DECISIONS D31), whose answer goes into the report
  assert.match(main, /extra\.windows = await probeWindows\(win\);/);
  assert.match(main, /windows: extra \? extra\.windows : null,/);
  assert.match(main, /tabs: extra \? extra\.tabs : null,/);
  assert.match(main, /selftest\.tabsProbe\(\{ run: runTab, look: \(\) => wc\.executeJavaScript\(selftest\.TABS_LOOK\), settle: \(\) => delay\(150\),\n\s+script: \(name\) => menu\.tabScript\(name\) \}\)/);
});
