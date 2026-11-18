"use strict";
// The macOS menu bar (pure: a template for Menu.buildFromTemplate; every shortcut is written out, none is left to a
// role's default, so test/menu.test.js checks exactly what the app registers).
//
// No shortcut may take a key the web app uses (js/keys.js: its reader, editor and review maps, all review presets).
// On macOS Electron hands every key to the page first and a menu shortcut runs only when the page leaves the key alone,
// but the menu still stays clear of the page's keys:
//   - Actual Size, Zoom In and Zoom Out have no shortcut: Cmd+0, Cmd+= / Cmd++ and Cmd+- zoom the PDF in the reader;
//   - there is no File menu: Cmd+O adds a PDF, and Cmd+F (find) and Cmd+Enter (save) belong to the page too.
// Cmd+V stays on Paste: Paste is what gives the page its paste event, which is how the web app's Cmd+V works (an
// image into the editor, or a free margin note when no editor is open). Cmd+C and Cmd+Z work through Copy and Undo.
// Window › Marginalia (no shortcut) shows the window, also after closing it hid the window (lib/lifecycle.js
// CLOSE_HIDES). While the app has one window, main.js keeps it out of macOS's own list of windows in that menu
// (excludedFromShownWindowsMenu), so it is listed once and always comes back; with two or more windows (DECISIONS
// D31) macOS lists them all, by their names.
//
// The tabs (DECISIONS D30) are the one exception to "no key of the web app": Window › New Tab (Cmd+T), Close Tab
// (Cmd+W) and Reopen Closed Tab (Shift+Cmd+T) carry tab shortcuts, and each calls the web app's own command
// (js/tabs.js M.tabs.run(id), through tabScript below). In the app the page leaves exactly these three keys alone
// (M.tabs.MENU_KEYS), so a key runs once whatever the order in which macOS offers it to the menu and to the page.
// Show Next Tab and Show Previous Tab have no shortcut here: Ctrl+Tab, Ctrl+Shift+Tab and Cmd+Shift+] / [ are the
// page's own keys in the app too (a key without Cmd may never reach a menu on macOS, so the menu must not own it);
// the items are there for a click. Close Tab closes the window (which hides it) when the page has one tab left, and
// does nothing when the page has more tabs but a review or a dialog is on screen; Close Window moved to Shift+Cmd+W.
//
// The windows (DECISIONS D31): Window › New Window (Cmd+N, a key the web app does not use), Move Tab to New Window and
// Merge All Windows (no shortcut). main.js runs them; what they ask of a page is in windowScript below.
//
// Undo and Redo (DECISIONS D33) are the second exception: Cmd+Z and Shift+Cmd+Z are also the web app's keys for the
// last change to a card (js/keys.js UNDO_MAP). The two items keep Electron's own roles, which act on the text field
// that has the focus. The page takes the keys only outside a text field and stops their default there, so the menu's
// Undo does not run then; inside a text field the page leaves them alone and the menu's Undo acts on the text. A
// click on Edit › Undo changes no card. Nothing here runs the web app's undo.
const ACCEL = Object.freeze({
  hide: "Command+H",
  hideOthers: "Command+Alt+H",
  quit: "Command+Q",
  undo: "Command+Z",
  redo: "Shift+Command+Z",
  cut: "Command+X",
  copy: "Command+C",
  paste: "Command+V",
  pasteAndMatchStyle: "Shift+Command+Alt+V",
  selectAll: "Command+A",
  reload: "Command+R",
  forceReload: "Shift+Command+R",
  toggleDevTools: "Alt+Command+I",
  togglefullscreen: "Control+Command+F",
  newWindow: "Command+N",
  minimize: "Command+M",
  newTab: "Command+T",
  closeTab: "Command+W",
  reopenTab: "Shift+Command+T",
  close: "Shift+Command+W"
});

// The web app's tab commands that the menu runs (js/tabs.js run(id)).
const TAB_COMMANDS = Object.freeze(["newTab", "closeTab", "reopenTab", "nextTab", "prevTab"]);

// What the page answers to a tab command (tabScript's value; TAB_ANSWERS):
//   "done"     the page ran the command;
//   "last"     it did not, and the page has at most one tab (Close Tab: that tab is not the page's to close);
//   "blocked"  it did not, and the page has more tabs: a review or a dialog is on screen, or there was nothing to do;
//   "none"     this page is not the web app (it did not load), or the command failed.
const TAB_ANSWERS = Object.freeze(["done", "last", "blocked", "none"]);

// The script that runs one tab command in the page and gives one of TAB_ANSWERS. null for an unknown command:
// nothing but these five names ever reaches the page.
function tabScript(id) {
  if (!TAB_COMMANDS.includes(id)) return null;
  return "(function () { try { var t = window.Marginalia && window.Marginalia.tabs; " +
    "if (!t || typeof t.run !== \"function\" || typeof t.list !== \"function\") return \"none\"; " +
    "if (t.run(" + JSON.stringify(id) + ") === true) return \"done\"; " +
    "return t.list().length > 1 ? \"blocked\" : \"last\"; } catch (e) { return \"none\"; } })()";
}

// tabAnswer(value) → one of TAB_ANSWERS ("none" for anything else the page gave back).
function tabAnswer(value) {
  return TAB_ANSWERS.indexOf(value) >= 0 ? value : "none";
}

// The windows (DECISIONS D31). What main.js runs in a window's page; each gives a plain value back and never throws.
//   windowScript("moveTab")       the tab on screen goes to a window of its own → a promise of true | false
//   windowScript("dump")          → this window's tabs as JSON text (M.tabs.dump()), or null (no web app there, or a
//                                 review or a dialog is on screen: its tabs stay)
//   windowScript("take", json)    the tabs of another window (dump's text) come in (M.tabs.take) → the indexes of
//                                 that list that came in (a tab that found no room, or that the page does not know,
//                                 is not among them)
//   windowScript("drop", list)    those tabs of the last dump went to another window (the indexes take answered)
//                                 → how many tabs are left (0: the window can close; -1: nothing was dropped)
//   windowScript("leave")         this window closes for good: its list of tabs goes, and a place in its book that it
//                                 held back is stored (M.app.leave()) → a promise of true | false
//   windowScript("role")          this window takes the writer role (M.app.takeRole()) → a promise of true | false
// null for anything else, and for arguments that are not what the command takes.
const WINDOW_COMMANDS = Object.freeze(["moveTab", "dump", "take", "drop", "leave", "role"]);
const DUMP_MAX = 200000;         // characters: 20 tabs, each with a place and an editor's options, are far below this
const TABS_MAX = 20;             // tabs in a window (js/tabs.js TABS_MAX): no list of indexes is longer

// takenIndexes(value) → what a page answered to "take", as a list of indexes: whole numbers from 0 to 999, each
// once, at most TABS_MAX of them; [] for anything else.
function takenIndexes(value) {
  if (!Array.isArray(value) || value.length > TABS_MAX) return [];
  const out = [];
  for (const i of value) {
    if (!Number.isInteger(i) || i < 0 || i > 999 || out.includes(i)) return [];
    out.push(i);
  }
  return out;
}

function windowScript(id, arg) {
  const page = "var t = window.Marginalia && window.Marginalia.tabs; ";
  if (id === "moveTab") {
    return "(function () { try { " + page + "if (!t || typeof t.moveToWindow !== \"function\") return false; " +
      "return Promise.resolve(t.moveToWindow()).then(function (v) { return v === true; }, function () { return false; }); } catch (e) { return false; } })()";
  }
  if (id === "dump") {
    return "(function () { try { " + page + "if (!t || typeof t.dump !== \"function\") return null; var d = t.dump(); return Array.isArray(d) ? JSON.stringify(d) : null; } catch (e) { return null; } })()";
  }
  if (id === "take") {
    if (typeof arg !== "string" || !arg || arg.length > DUMP_MAX) return null;
    let list = null;
    try { list = JSON.parse(arg); } catch (e) { list = null; }
    if (!Array.isArray(list)) return null;
    // the text goes in as one string, which the page parses: nothing in it is ever read as script
    return "(function () { try { " + page + "if (!t || typeof t.take !== \"function\") return []; " +
      "var r = t.take(JSON.parse(" + JSON.stringify(JSON.stringify(list)) + ")); return Array.isArray(r) ? r.slice() : []; } catch (e) { return []; } })()";
  }
  if (id === "drop") {
    const list = takenIndexes(arg);
    if (!Array.isArray(arg) || !arg.length || list.length !== arg.length) return null;
    return "(function () { try { " + page + "if (!t || typeof t.drop !== \"function\") return -1; " +
      "var n = t.drop(" + JSON.stringify(list) + "); return typeof n === \"number\" ? Math.floor(n) : -1; } catch (e) { return -1; } })()";
  }
  if (id === "leave" || id === "role") {
    const fn = id === "leave" ? "leave" : "takeRole";
    return "(function () { try { var a = window.Marginalia && window.Marginalia.app; if (!a || typeof a." + fn + " !== \"function\") return false; " +
      "return Promise.resolve(a." + fn + "()).then(function (v) { return v === true; }, function () { return false; }); } catch (e) { return false; } })()";
  }
  return null;
}

function buildTemplate(actions) {
  const a = actions || {};
  const call = (name) => () => { if (typeof a[name] === "function") a[name](); };
  const sep = { type: "separator" };
  return [
    {
      label: "Marginalia",
      submenu: [
        { role: "about", label: "About Marginalia" },
        sep,
        { role: "hide", label: "Hide Marginalia", accelerator: ACCEL.hide },
        { role: "hideOthers", label: "Hide Others", accelerator: ACCEL.hideOthers },
        { role: "unhide", label: "Show All" },
        sep,
        { role: "quit", label: "Quit Marginalia", accelerator: ACCEL.quit }
      ]
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo", label: "Undo", accelerator: ACCEL.undo },
        { role: "redo", label: "Redo", accelerator: ACCEL.redo },
        sep,
        { role: "cut", label: "Cut", accelerator: ACCEL.cut },
        { role: "copy", label: "Copy", accelerator: ACCEL.copy },
        { role: "paste", label: "Paste", accelerator: ACCEL.paste },
        { role: "pasteAndMatchStyle", label: "Paste and Match Style", accelerator: ACCEL.pasteAndMatchStyle },
        { role: "selectAll", label: "Select All", accelerator: ACCEL.selectAll }
      ]
    },
    {
      label: "View",
      submenu: [
        { label: "Reload", accelerator: ACCEL.reload, click: call("reload") },
        { label: "Force Reload", accelerator: ACCEL.forceReload, click: call("forceReload") },
        { role: "toggleDevTools", label: "Toggle Developer Tools", accelerator: ACCEL.toggleDevTools },
        sep,
        { label: "Actual Size", click: call("resetZoom") },
        { label: "Zoom In", click: call("zoomIn") },
        { label: "Zoom Out", click: call("zoomOut") },
        sep,
        { role: "togglefullscreen", label: "Toggle Full Screen", accelerator: ACCEL.togglefullscreen }
      ]
    },
    {
      label: "Window",
      role: "window",
      submenu: [
        { label: "New Window", accelerator: ACCEL.newWindow, click: call("newWindow") },
        sep,
        { role: "minimize", label: "Minimize", accelerator: ACCEL.minimize },
        { role: "zoom", label: "Zoom" },
        sep,
        { label: "New Tab", accelerator: ACCEL.newTab, click: call("newTab") },
        { label: "Close Tab", accelerator: ACCEL.closeTab, click: call("closeTab") },
        { label: "Reopen Closed Tab", accelerator: ACCEL.reopenTab, click: call("reopenTab") },
        { label: "Show Next Tab", click: call("nextTab") },
        { label: "Show Previous Tab", click: call("prevTab") },
        { label: "Move Tab to New Window", click: call("moveTab") },
        { label: "Merge All Windows", click: call("mergeWindows") },
        sep,
        { role: "close", label: "Close Window", accelerator: ACCEL.close },
        sep,
        { role: "front", label: "Bring All to Front" },
        sep,
        { label: "Marginalia", click: call("showWindow") }
      ]
    }
  ];
}

// Every accelerator in a template (or a built Menu's items), in order.
function accelerators(template) {
  const out = [];
  (function walk(items) {
    for (const it of items || []) {
      if (it.accelerator) out.push(String(it.accelerator));
      if (Array.isArray(it.submenu)) walk(it.submenu);
      else if (it.submenu && Array.isArray(it.submenu.items)) walk(it.submenu.items);
    }
  })(template);
  return out;
}

// "Shift+Command+Z" → the binding in js/keys.js canonical form, "Shift+Meta+z" (Command = Meta on macOS).
function toKeysBinding(accel) {
  const parts = String(accel).split("+");
  const key = parts.pop();
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  const has = (...names) => names.some((n) => mods.has(n));
  let k = key.length === 1 ? key.toLowerCase() : key;
  if (k === "Plus") k = "+";
  return (has("control", "ctrl") ? "Ctrl+" : "") + (has("alt", "option") ? "Alt+" : "") +
    (has("shift") && !(k.length === 1 && k.toLowerCase() === k.toUpperCase()) ? "Shift+" : "") +
    (has("command", "cmd", "commandorcontrol", "cmdorctrl", "super", "meta") ? "Meta+" : "") + k;
}

module.exports = { buildTemplate, accelerators, toKeysBinding, tabScript, tabAnswer, windowScript, takenIndexes, ACCEL, TAB_COMMANDS, TAB_ANSWERS,
  WINDOW_COMMANDS, DUMP_MAX };
