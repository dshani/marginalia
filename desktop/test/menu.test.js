"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const menu = require("../lib/menu");

const KEYS_JS = path.join(__dirname, "..", "..", "marginalia", "js", "keys.js");
const TABS_JS = path.join(__dirname, "..", "..", "marginalia", "js", "tabs.js");

function items(template) {
  const out = [];
  (function walk(list) { for (const it of list) { out.push(it); if (Array.isArray(it.submenu)) walk(it.submenu); } })(template);
  return out;
}

test("the four standard macOS menus, with the items the contract lists", () => {
  const t = menu.buildTemplate({});
  assert.deepEqual(t.map((m) => m.label), ["Marginalia", "Edit", "View", "Window"]);
  const labels = (i) => t[i].submenu.filter((x) => x.type !== "separator").map((x) => x.label);
  assert.deepEqual(labels(0), ["About Marginalia", "Hide Marginalia", "Hide Others", "Show All", "Quit Marginalia"]);
  assert.deepEqual(labels(1), ["Undo", "Redo", "Cut", "Copy", "Paste", "Paste and Match Style", "Select All"]);
  assert.deepEqual(labels(2), ["Reload", "Force Reload", "Toggle Developer Tools", "Actual Size", "Zoom In", "Zoom Out", "Toggle Full Screen"]);
  assert.deepEqual(labels(3), ["New Window", "Minimize", "Zoom", "New Tab", "Close Tab", "Reopen Closed Tab", "Show Next Tab", "Show Previous Tab",
    "Move Tab to New Window", "Merge All Windows", "Close Window", "Bring All to Front", "Marginalia"]);
  assert.equal(t[3].role, "window");
});

test("the tab commands (DECISIONS D30): five items, three with a key, each calls its action; Close Window is Shift+Cmd+W", () => {
  const calls = [];
  const actions = Object.fromEntries(menu.TAB_COMMANDS.map((id) => [id, () => calls.push(id)]));
  const win = menu.buildTemplate(actions)[3].submenu;
  const byLabel = Object.fromEntries(win.filter((i) => i.label).map((i) => [i.label, i]));
  // Show Next Tab and Show Previous Tab are for a click: their keys (Ctrl+Tab, Cmd+Shift+] and [) are the page's own
  const want = [["New Tab", "newTab", "Command+T"], ["Close Tab", "closeTab", "Command+W"], ["Reopen Closed Tab", "reopenTab", "Shift+Command+T"],
    ["Show Next Tab", "nextTab", undefined], ["Show Previous Tab", "prevTab", undefined]];
  assert.deepEqual(menu.TAB_COMMANDS.slice(), want.map((w) => w[1]));
  for (const [label, id, accel] of want) {
    const it = byLabel[label];
    assert.equal(it.accelerator, accel, label);
    assert.equal(it.accelerator, menu.ACCEL[id], label);
    assert.equal(it.role, undefined, label + " is the app's own command, no macOS role (macOS has window tabs of its own)");
    it.click();
    assert.equal(calls[calls.length - 1], id, label);
  }
  assert.equal(calls.length, 5);
  // the close of the window keeps its native role and moved to Shift+Cmd+W; Cmd+W is the tab's
  assert.equal(byLabel["Close Window"].role, "close");
  assert.equal(byLabel["Close Window"].accelerator, "Shift+Command+W");
  assert.equal(items(menu.buildTemplate({})).filter((i) => i.accelerator === "Command+W").length, 1);
  // a template without actions (the self-test's expected list) still builds, and its clicks do nothing
  for (const it of items(menu.buildTemplate({}))) if (typeof it.click === "function") it.click();
});

test("the window commands (DECISIONS D31): New Window is Cmd+N and comes first; Move Tab to New Window and Merge All Windows have no key", () => {
  const calls = [];
  const actions = { newWindow: () => calls.push("newWindow"), moveTab: () => calls.push("moveTab"), mergeWindows: () => calls.push("mergeWindows") };
  const win = menu.buildTemplate(actions)[3].submenu;
  assert.equal(win[0].label, "New Window");
  assert.equal(win[0].accelerator, "Command+N");
  assert.equal(win[0].accelerator, menu.ACCEL.newWindow);
  assert.equal(win[1].type, "separator");
  const byLabel = Object.fromEntries(win.filter((i) => i.label).map((i) => [i.label, i]));
  for (const [label, id] of [["New Window", "newWindow"], ["Move Tab to New Window", "moveTab"], ["Merge All Windows", "mergeWindows"]]) {
    assert.equal(byLabel[label].role, undefined, label + " is the app's own command (macOS has window tabs of its own)");
    byLabel[label].click();
    assert.equal(calls.pop(), id, label);
  }
  assert.equal(calls.length, 0);
  assert.equal(byLabel["Move Tab to New Window"].accelerator, undefined);
  assert.equal(byLabel["Merge All Windows"].accelerator, undefined);
  assert.equal(items(menu.buildTemplate({})).filter((i) => i.accelerator === "Command+N").length, 1);
  // the two that move tabs stand with the tab commands, before Close Window
  const order = win.filter((i) => i.label).map((i) => i.label);
  assert.ok(order.indexOf("Show Previous Tab") < order.indexOf("Move Tab to New Window"));
  assert.ok(order.indexOf("Merge All Windows") < order.indexOf("Close Window"));
});

test("windowScript (DECISIONS D31): what main.js runs in a window's page for a tab that moves out, a merge and a close", async () => {
  const run = (script, win) => vm.runInNewContext(script, { window: win });
  const plain = (v) => JSON.parse(JSON.stringify(v));
  assert.deepEqual(menu.WINDOW_COMMANDS.slice(), ["moveTab", "dump", "take", "drop", "leave", "role"]);
  const calls = [];
  const dumped = [{ screen: "reader", collectionId: "b1", position: { pageIndex: 3, fraction: 0.5, zoom: "fit" }, editing: null },
    { screen: "deck", collectionId: "d1", position: null, editing: null }];
  const tabs = {
    moveToWindow() { calls.push(["moveToWindow"]); return Promise.resolve(true); },
    dump() { calls.push(["dump"]); return dumped; },
    take(list) { calls.push(["take", list]); return [1]; },          // only the second tab found room
    drop(list) { calls.push(["drop", list]); return 2; }
  };
  const app = { leave() { calls.push(["leave"]); return Promise.resolve(true); }, takeRole() { calls.push(["takeRole"]); return Promise.resolve(true); } };
  const page = { Marginalia: { tabs, app } };
  assert.equal(await run(menu.windowScript("moveTab"), page), true);
  const text = run(menu.windowScript("dump"), page);
  assert.equal(typeof text, "string");
  assert.deepEqual(JSON.parse(text), dumped);
  calls.length = 0;
  assert.deepEqual(plain(run(menu.windowScript("take", text), page)), [1]);
  assert.deepEqual(plain(calls), [["take", dumped]]);
  assert.equal(run(menu.windowScript("drop", [1]), page), 2);
  assert.equal(await run(menu.windowScript("leave"), page), true);
  assert.equal(await run(menu.windowScript("role"), page), true);
  assert.deepEqual(plain(calls.slice(1)), [["drop", [1]], ["leave"], ["takeRole"]]);
  // a window that gives no tabs (a review or a dialog is on screen there): no text, so nothing is taken from it
  assert.equal(run(menu.windowScript("dump"), { Marginalia: { tabs: { dump() { return null; } } } }), null);
  assert.equal(menu.windowScript("take", null), null);
  // a page that is not the web app, or an older web app: a plain "no", never a throw at the menu
  for (const bad of [{}, { Marginalia: {} }, { Marginalia: { tabs: {}, app: {} } }]) {
    assert.equal(run(menu.windowScript("moveTab"), bad), false);
    assert.equal(run(menu.windowScript("dump"), bad), null);
    assert.deepEqual(plain(run(menu.windowScript("take", "[]"), bad)), []);
    assert.equal(run(menu.windowScript("drop", [1]), bad), -1);
    assert.equal(run(menu.windowScript("leave"), bad), false);
    assert.equal(run(menu.windowScript("role"), bad), false);
  }
  // an error in the page is a "no" too
  const boom = () => { throw new Error("boom"); };
  const broken = { Marginalia: { tabs: { moveToWindow: boom, dump: boom, take: boom, drop: boom }, app: { leave: boom, takeRole() { return Promise.reject(new Error("boom")); } } } };
  assert.equal(run(menu.windowScript("moveTab"), broken), false);
  assert.equal(run(menu.windowScript("dump"), broken), null);
  assert.deepEqual(plain(run(menu.windowScript("take", "[]"), broken)), []);
  assert.equal(run(menu.windowScript("drop", [1]), broken), -1);
  assert.equal(run(menu.windowScript("leave"), broken), false);
  assert.equal(await run(menu.windowScript("role"), broken), false);
  // anything but true is not a yes; an answer that is no list or no number counts as nothing
  const vague = { Marginalia: { tabs: { moveToWindow() { return "yes"; }, take() { return "3"; }, drop() { return null; } }, app: { leave() { return 1; }, takeRole() { return undefined; } } } };
  assert.equal(await run(menu.windowScript("moveTab"), vague), false);
  assert.equal(await run(menu.windowScript("leave"), vague), false);
  assert.equal(await run(menu.windowScript("role"), vague), false);
  assert.deepEqual(plain(run(menu.windowScript("take", "[]"), vague)), []);
  assert.equal(run(menu.windowScript("drop", [1]), vague), -1);
  // take gets the text of a JSON list and nothing else, and that text is never read as script
  for (const bad of [undefined, null, "", "{}", "\"x\"", "7", "[", 7, [], "[" + "1,".repeat(menu.DUMP_MAX) + "1]"]) {
    assert.equal(menu.windowScript("take", bad), null, String(bad).slice(0, 12));
  }
  const evil = JSON.stringify([{ screen: "library", collectionId: "\"); window.hacked = 1; (\"", position: null, editing: null }, "</script>", " \\"]);
  const victim = { Marginalia: { tabs: { take(list) { victim.got = list; return [0, 1, 2]; } } } };
  assert.deepEqual(plain(run(menu.windowScript("take", evil), victim)), [0, 1, 2]);
  assert.equal(victim.hacked, undefined);
  assert.deepEqual(plain(victim.got), JSON.parse(evil));
  // drop gets a list of indexes: whole numbers, each once, as takenIndexes reads the page's answer
  for (const bad of [1, -1, "1", null, undefined, [], [-1], [1.5], ["1"], [1, 1], [1000], [null], [NaN], [Infinity], Array.from({ length: 21 }, (x, i) => i), { 0: 1, length: 1 }]) {
    assert.equal(menu.windowScript("drop", bad), null, JSON.stringify(bad));
  }
  assert.equal(typeof menu.windowScript("drop", [0]), "string");
  assert.match(menu.windowScript("drop", [0, 19, 3]), /t\.drop\(\[0,19,3\]\)/);
  for (const bad of ["adopt", "forget", "newWindow", "mergeWindows", "bogus", "", null, undefined, 7, "constructor", "__proto__"]) assert.equal(menu.windowScript(bad), null, String(bad));
  for (const id of menu.WINDOW_COMMANDS) {
    const script = menu.windowScript(id, id === "take" ? "[]" : id === "drop" ? [1] : undefined);
    assert.equal(typeof script, "string", id);
    assert.equal(/[\n\r]/.test(script), false, id);
  }
});

test("takenIndexes: what a page answered to \"take\", as a list of indexes, or nothing", () => {
  const T = menu.takenIndexes;
  assert.deepEqual(T([0, 2, 1]), [0, 2, 1]);
  assert.deepEqual(T([]), []);
  assert.deepEqual(T(Array.from({ length: 20 }, (x, i) => i)).length, 20);
  for (const bad of [null, undefined, 3, "0,1", { length: 2, 0: 0, 1: 1 }, [0, 0], [-1], [1.5], ["1"], [1000], [NaN], [0, null], [[0]],
    Array.from({ length: 21 }, (x, i) => i)]) {
    assert.deepEqual(T(bad), [], JSON.stringify(bad));
  }
  // an answer from another realm (the page's own array) is read the same way
  assert.deepEqual(T(vm.runInNewContext("[4, 5]")), [4, 5]);
});

test("the menu's tab keys are exactly the keys the web app leaves to the menu (js/tabs.js MENU_KEYS), for the same commands", () => {
  const keys = require(KEYS_JS);
  const tabs = require(TABS_JS);
  keys.setPlatform("mac");
  const canon = (b) => keys.canonical(b);
  const withKey = menu.TAB_COMMANDS.filter((id) => menu.ACCEL[id]);
  assert.deepEqual(withKey, ["newTab", "closeTab", "reopenTab"]);
  const mine = withKey.map((id) => canon(menu.toKeysBinding(menu.ACCEL[id])));
  assert.deepEqual(mine.slice().sort(), tabs.MENU_KEYS.map(canon).sort(), "the page leaves alone what the menu runs, and nothing else");
  // each menu key is the web app's own key for that command (M.keys.TABS_MAP), so the app and a browser agree
  for (const id of withKey) {
    const own = [].concat(keys.TABS_MAP[id].binding).map(canon);
    assert.ok(own.includes(canon(menu.toKeysBinding(menu.ACCEL[id]))), id + ": " + menu.ACCEL[id] + " is one of " + own.join(", "));
  }
  // every other tab key (Ctrl+Tab, Ctrl+Shift+Tab, Cmd+Shift+] and [, Cmd+1 … Cmd+9) is the page's: no menu item
  // takes one, so it can neither run twice nor go dead when macOS keeps a key without Cmd away from the menus
  const all = menu.accelerators(menu.buildTemplate({})).map((a) => canon(menu.toKeysBinding(a)));
  for (const id of Object.keys(keys.TABS_MAP)) {
    if (withKey.includes(id)) continue;
    for (const b of [].concat(keys.TABS_MAP[id].binding)) assert.equal(all.includes(canon(b)), false, id + " " + b + " has no menu shortcut");
  }
  for (const a of menu.accelerators(menu.buildTemplate({}))) assert.equal(/Tab$/.test(a), false, "no menu shortcut on the Tab key: " + a);
  assert.equal(new Set(all).size, all.length, "no shortcut twice in the menu");
});

test("tabScript: the page's own M.tabs.run(id), answered as done, last, blocked or none; nothing for a name that is no tab command", () => {
  const run = (script, win) => vm.runInNewContext(script, { window: win });
  const calls = [];
  const page = (answer, tabs) => ({ Marginalia: { tabs: { run(id) { calls.push(id); return answer; }, list() { return new Array(tabs).fill({}); } } } });
  assert.deepEqual(menu.TAB_ANSWERS.slice(), ["done", "last", "blocked", "none"]);
  for (const id of menu.TAB_COMMANDS) {
    const script = menu.tabScript(id);
    assert.equal(typeof script, "string");
    assert.equal(run(script, page(true, 3)), "done", id);
    assert.equal(calls.pop(), id);
    assert.equal(run(script, page(true, 1)), "done");
    // the page did nothing: with more tabs something blocks the command (a review, a dialog); with one tab that tab
    // is not the page's to close
    assert.equal(run(script, page(false, 3)), "blocked");
    assert.equal(run(script, page(false, 2)), "blocked");
    assert.equal(run(script, page(false, 1)), "last");
    assert.equal(run(script, page(false, 0)), "last", "a page that still starts has no tab yet");
    assert.equal(run(script, page("yes", 2)), "blocked", "anything but true is not done");
    assert.equal(run(script, page(undefined, 1)), "last");
    assert.equal(run(script, {}), "none", "a page that is not the web app");
    assert.equal(run(script, { Marginalia: {} }), "none");
    assert.equal(run(script, { Marginalia: { tabs: { run() { return true; } } } }), "none", "an older web app without list()");
    assert.equal(run(script, { Marginalia: { tabs: { run() { throw new Error("boom"); }, list() { return []; } } } }), "none", "an error is none, never thrown at the menu");
    assert.equal(run(script, { Marginalia: { tabs: { run() { return false; }, list() { throw new Error("boom"); } } } }), "none");
    assert.equal(/[\n\r]/.test(script), false);
  }
  for (const bad of ["tab1", "lastTab", "bogus", "", null, undefined, 7, "newTab\"); alert(1); (\"", "constructor", "__proto__"]) {
    assert.equal(menu.tabScript(bad), null, String(bad));
  }
  // what comes back from the page is one of the four answers, or it counts as none
  for (const v of menu.TAB_ANSWERS) assert.equal(menu.tabAnswer(v), v);
  for (const v of [true, false, null, undefined, 1, "DONE", "closed", {}, { then() {} }, ["done"]]) assert.equal(menu.tabAnswer(v), "none", String(v));
});

test("Window › Marginalia shows the window (also after closing hid it), with no shortcut (FEATURES E2.3 b)", () => {
  const calls = [];
  const win = menu.buildTemplate({ showWindow: () => calls.push("showWindow") })[3].submenu;
  const item = win[win.length - 1];
  assert.equal(item.label, "Marginalia");
  assert.equal(item.accelerator, undefined);
  assert.equal(item.role, undefined);
  assert.equal(win[win.length - 2].type, "separator");
  item.click();
  assert.deepEqual(calls, ["showWindow"]);
});

test("Cut, Copy, Paste, Undo and Select All are the native roles (Cmd+C, Cmd+V and Cmd+Z need them on macOS)", () => {
  const byLabel = Object.fromEntries(items(menu.buildTemplate({})).filter((i) => i.label).map((i) => [i.label, i]));
  for (const [label, role, accel] of [["Undo", "undo", "Command+Z"], ["Redo", "redo", "Shift+Command+Z"], ["Cut", "cut", "Command+X"],
    ["Copy", "copy", "Command+C"], ["Paste", "paste", "Command+V"], ["Select All", "selectAll", "Command+A"]]) {
    assert.equal(byLabel[label].role, role, label);
    assert.equal(byLabel[label].accelerator, accel, label);
  }
});

test("every role item states its shortcut, so no role default sneaks in; zoom items have none", () => {
  const all = items(menu.buildTemplate({}));
  const roleDefaults = ["hide", "hideOthers", "quit", "undo", "redo", "cut", "copy", "paste", "pasteAndMatchStyle", "selectAll",
    "toggleDevTools", "togglefullscreen", "minimize", "close"];
  // no macOS tab role: those are the window tabs of macOS, not the web app's tabs
  for (const it of all) if (/tab/i.test(String(it.role || ""))) assert.fail("no role " + it.role);
  for (const it of all) if (roleDefaults.includes(it.role)) assert.ok(it.accelerator, it.role);
  for (const it of all) if (["resetZoom", "zoomIn", "zoomOut", "reload", "forceReload"].includes(it.role)) assert.fail("no role " + it.role);
  for (const label of ["Actual Size", "Zoom In", "Zoom Out"]) {
    const it = all.find((x) => x.label === label);
    assert.equal(it.accelerator, undefined, label);
    assert.equal(typeof it.click, "function", label);
  }
});

test("menu clicks call the actions given", () => {
  const calls = [];
  const t = menu.buildTemplate({ reload: () => calls.push("reload"), zoomIn: () => calls.push("zoomIn") });
  for (const it of items(t)) if (typeof it.click === "function") it.click();
  assert.deepEqual(calls, ["reload", "zoomIn"]);
});

test("accelerators converts to js/keys.js bindings", () => {
  assert.equal(menu.toKeysBinding("Command+Z"), "Meta+z");
  assert.equal(menu.toKeysBinding("Shift+Command+Z"), "Shift+Meta+z");
  assert.equal(menu.toKeysBinding("Control+Command+F"), "Ctrl+Meta+f");
  assert.equal(menu.toKeysBinding("Command+Plus"), "Meta++");
  assert.deepEqual(menu.accelerators(menu.buildTemplate({})), Object.values(menu.ACCEL));
});

// The tab commands are the one exception (the test above): the menu runs them, and the page leaves those keys alone.
test("no menu shortcut takes a key the web app uses (js/keys.js reader, editor and review maps, every preset)", () => {
  assert.ok(fs.existsSync(KEYS_JS), "the web app is beside desktop/");
  const keys = require(KEYS_JS);
  keys.setPlatform("mac");
  const appBindings = new Set();
  const add = (b) => { for (const one of Array.isArray(b) ? b : [b]) if (one) appBindings.add(keys.canonical(one)); };
  for (const map of [keys.READER_MAP, keys.EDITOR_MAP]) for (const id of Object.keys(map)) add(map[id].binding);
  for (const preset of Object.values(keys.PRESETS)) for (const b of Object.values(preset)) add(b);
  for (const b of Object.values(keys.reviewMap({}))) add(b.binding);
  for (const must of ["n", "o", "Escape", "Meta+Enter", "Meta+0", "Meta+=", "Meta+-", "Meta+f", "Meta+o", "Space", "1", "2"]) {
    assert.ok(appBindings.has(keys.canonical(must)), "the web app binds " + must);
  }
  const menuBindings = menu.accelerators(menu.buildTemplate({})).map((a) => keys.canonical(menu.toKeysBinding(a)));
  const clash = menuBindings.filter((b) => appBindings.has(b));
  assert.deepEqual(clash, []);
  // Cmd+V is Paste's: the web app has no key binding for it; it reacts to the paste event Paste sends
  assert.ok(menuBindings.includes(keys.canonical("Meta+v")));
  assert.ok(!appBindings.has(keys.canonical("Meta+v")));
});
