"use strict";
// What closing the main window does, when the app quits, and what a tab command of the Window menu does (pure:
// main.js asks; node --test covers every answer).
//
// CLOSE_HIDES is the one switch (FEATURES E2.3 b; the user confirmed true on 2026-11-11, DECISIONS D23 (1)):
//   true   closing the LAST window (its red button, Window › Close Window Shift+Cmd+W, and Cmd+W with one tab left:
//          DECISIONS D30, tabAction below) hides it (a window that is not the last one closes: D31); the app and its server keep running, as Mac apps do, so "Open in
//          Marginalia" links from Obsidian notes keep working while the window is closed. A window in full screen leaves full screen first, then hides (hidden in full screen, it would leave
//          its empty Space behind). The Dock icon, a second launch, a marginalia:// link and Window › Marginalia show it
//          again. Cmd+Q, the app menu's Quit, SIGTERM, logging out and restarting the Mac quit the app and stop its
//          server (main.js: before-quit sets "quitting", so the close goes through, and will-quit stops the server).
//   false  part 1's behaviour: closing the window quits the app (and stops the server).
const CLOSE_HIDES = true;

// closeAction({closeHides, quitting, fullScreen, windows}) → "close": let the window close (the app is quitting, or
// the switch is off); "close-window" (DECISIONS D31): this window is not the last one, so it closes for good (main.js
// first lets its page forget its tabs); "hide": prevent the close and hide the window (the last one, so the app keeps
// running); "leave-full-screen": prevent the close, leave full screen, then hide. `windows`: how many windows the app
// has now, this one included (1 when it is not given).
function closeAction(o) {
  const x = o || {};
  if (!x.closeHides || x.quitting) return "close";
  if (Number.isInteger(x.windows) && x.windows > 1) return "close-window";
  return x.fullScreen ? "leave-full-screen" : "hide";
}

// quitWhenAllClosed(closeHides) → whether the app quits when its last window has closed ("window-all-closed", which
// Electron does not send while the app quits). With the switch on the window only hides, so this happens only if the
// window was destroyed some other way; the app then keeps running and the Dock icon opens a new window.
function quitWhenAllClosed(closeHides) {
  return !closeHides;
}

// The tab commands of the Window menu (lib/menu.js TAB_COMMANDS; DECISIONS D30).
// tabAction(id, {front, window, quitting}) → what one of them does. "The main window" below is the app's window that
// is in front, or was in front last (with several windows, DECISIONS D31: main.js state.win). front: that window is
// the window in front (it has the keyboard). window: there is such a window (shown, hidden or minimized).
//   "run"           the main window is in front: its page runs the command. For Close Tab, closesWindow below says
//                   whether the window then closes (which hides it).
//   "show-and-run"  New Tab and Reopen Closed Tab while the window is hidden, minimized or behind another window: it
//                   comes to the front, then its page runs the command.
//   "show"          the same two with no window at all: a new window opens (its page brings its tabs back by itself).
//   "close-front"   Close Tab while another window is in front (the About panel, Developer Tools in a window of their
//                   own): Cmd+W closes that window, as it did before the tabs.
//   "none"          Show Next Tab and Show Previous Tab (menu clicks: they have no shortcut in the menu) without the
//                   main window in front; an unknown name; every command while the app quits.
const TAB_OPENERS = ["newTab", "reopenTab"];
const TAB_OTHERS = ["closeTab", "nextTab", "prevTab"];
function tabAction(id, o) {
  const x = o || {};
  const opens = TAB_OPENERS.indexOf(id) >= 0;
  if (x.quitting || (!opens && TAB_OTHERS.indexOf(id) < 0)) return "none";
  if (x.front) return "run";
  if (opens) return x.window ? "show-and-run" : "show";
  return id === "closeTab" ? "close-front" : "none";
}

// closesWindow(id, answer) → does the window close after the page's answer (lib/menu.js TAB_ANSWERS) to a tab command?
// Only for Close Tab, and only when the page has no tab of its own to close: "last" (one tab left: Cmd+W then closes
// the window, as before the tabs) or "none" (a page that did not load). Not for "blocked": with more tabs open, a
// review or a dialog on screen stops Cmd+W, and the window stays.
function closesWindow(id, answer) {
  return id === "closeTab" && (answer === "last" || answer === "none");
}

module.exports = { CLOSE_HIDES, closeAction, quitWhenAllClosed, tabAction, closesWindow };
