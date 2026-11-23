"use strict";
// main.js itself, loaded in plain Node with Electron mocked (FEATURES E2.3 f): marginalia:// links (valid, invalid,
// before the app is ready, at the first launch, from a second launch), closing the window (it hides; full screen is left
// first; the Dock icon, a link and Window › Marginalia show it again; the switch off quits as in part 1), quitting (Cmd+Q
// and SIGTERM stop the server first), the --app flag, the persistent-storage permission, and the Window menu's tab
// commands (DECISIONS D30: the page runs them; Cmd+W with one tab left hides the window), and several windows
// (DECISIONS D31: Cmd+N, a tab that moves out, Merge All Windows; a window that is not the last one closes for good).
// Nothing real runs: python3, the server and every Electron call are stand-ins; the app's folders are in a temp folder.
// `require("electron")` never reaches the electron package (whose index.js would download Electron): Module._load
// answers it with the mock while main.js loads.
const test = require("node:test");
const assert = require("node:assert/strict");
const EventEmitter = require("node:events");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");

const MAIN = require.resolve("../main.js");
const PKG = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
const python = require("../lib/python");
const server = require("../lib/server");
const lifecycle = require("../lib/lifecycle");
const menu = require("../lib/menu");
const selftest = require("../lib/selftest");
const REAL = { findPython: python.findPython, probePort: server.probePort, ServerProcess: server.ServerProcess, closeHides: lifecycle.CLOSE_HIDES };
const PORT = 49181;
const ORIGIN = "http://127.0.0.1:" + PORT;
const PROCESS_EVENTS = ["SIGTERM", "SIGINT", "SIGHUP", "uncaughtException", "unhandledRejection"];
const tick = () => new Promise((r) => setImmediate(r));

function event() {
  return { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
}

// ---- the Electron stand-in ------------------------------------------------------------------------------------------
function makeElectron(dir) {
  const app = new EventEmitter();
  let ready;
  const readyPromise = new Promise((r) => { ready = r; });
  const windows = [];
  app.windows = windows;
  app.paths = { appData: path.join(dir, "appData"), downloads: path.join(dir, "Downloads"), userData: path.join(dir, "appData", "Electron") };
  app.commandLine = { switches: [], appendSwitch(s) { this.switches.push(s); }, hasSwitch(s) { return this.switches.includes(s); } };
  app.enableSandbox = () => {};
  app.dock = { hidden: false, hide() { this.hidden = true; }, show() { this.hidden = false; }, isVisible() { return !this.hidden; } };
  app.setActivationPolicy = () => {};
  app.getPath = (name) => app.paths[name] || path.join(dir, name);
  app.setPath = (name, value) => { app.paths[name] = value; };
  app.getVersion = () => PKG.version;
  app.isPackaged = false;
  app.whenReady = () => readyPromise;
  app.readyCalled = false;
  app.ready = () => { app.readyCalled = true; ready(); };
  app.isReady = () => app.readyCalled;
  app.requestSingleInstanceLock = () => true;
  app.setAboutPanelOptions = () => {};
  app.focusCalls = [];
  app.focus = (o) => { app.focusCalls.push(o || null); };
  app.exitCode = null;
  app.exit = (code) => { app.exitCode = code; };
  app.quitCalls = 0;
  app.quitted = false;
  app.inQuit = false;
  // Electron's order: before-quit, then every window is closed (a window that refuses its close cancels the quit; no
  // window-all-closed while quitting), then will-quit (main.js may hold it while the server stops), then quit.
  app.quit = () => {
    app.quitCalls++;
    if (app.quitted) return;
    app.inQuit = true;
    try {
      const bq = event();
      app.emit("before-quit", bq);
      if (bq.defaultPrevented) return;
      for (const w of windows.slice()) { w.close(); if (!w.destroyed) return; }
      const wq = event();
      app.emit("will-quit", wq);
      if (wq.defaultPrevented) return;
      app.quitted = true;
      app.emit("quit");
    } finally { app.inQuit = false; }
  };

  class FakeWebContents extends EventEmitter {
    constructor(win) { super(); this.win = win; this.url = ""; this.loads = []; this.destroyed = false; this.reloads = 0; this.session = { addWordToSpellCheckerDictionary() {} };
      this.scripts = []; this.answer = null; this.messages = []; }
    send(channel, msg) { this.messages.push({ channel, msg }); }
    isLoading() { return !!this.loading; }
    setWindowOpenHandler(fn) { this.openHandler = fn; }
    getURL() { return this.url; }
    isDestroyed() { return this.destroyed; }
    reload() { this.reloads++; }
    reloadIgnoringCache() { this.reloads++; }
    // the page: what it was asked to run, and its answer (a test sets `answer`: a value, or a function of the script)
    executeJavaScript(script) {
      this.scripts.push(script);
      try { return Promise.resolve(typeof this.answer === "function" ? this.answer(script) : this.answer); } catch (e) { return Promise.reject(e); }
    }
    getZoomLevel() { return 0; }
    setZoomLevel() {}
  }
  class BrowserWindow extends EventEmitter {
    constructor(opts) {
      super();
      this.opts = opts;
      // as Electron: a window made with show: true is on screen, and in front, from the start
      this.visible = !!(opts && opts.show === true); this.destroyed = false; this.fullScreen = false; this.minimized = false; this.focused = this.visible;
      this.shows = 0; this.hides = 0; this.focuses = 0; this.fullScreenCalls = [];
      this.excludedFromShownWindowsMenu = false;
      this.webContents = new FakeWebContents(this);
      windows.push(this);
      app.emit("web-contents-created", {}, this.webContents);
    }
    loadURL(url) { this.webContents.url = url; this.webContents.loads.push(url); return Promise.resolve(); }
    show() { this.visible = true; this.focused = true; this.shows++; this.emit("show"); }      // macOS: a shown window is in front
    hide() { this.visible = false; this.focused = false; this.hides++; this.emit("hide"); }
    focus() { this.focuses++; this.focused = true; }
    isFocused() { return this.focused && this.visible && !this.minimized && !this.destroyed; }
    isVisible() { return this.visible; }
    isMinimized() { return this.minimized; }
    restore() { this.minimized = false; }
    isFullScreen() { return this.fullScreen; }
    setFullScreen(on) {
      this.fullScreenCalls.push(!!on);
      if (this.fullScreen === !!on) return;
      this.fullScreen = !!on;
      setImmediate(() => this.emit(on ? "enter-full-screen" : "leave-full-screen"));   // macOS animates it
    }
    isDestroyed() { return this.destroyed; }
    close() {
      if (this.destroyed) return;
      const ev = event();
      this.emit("close", ev);
      if (!ev.defaultPrevented) this.destroy();
    }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.visible = false;
      this.webContents.destroyed = true;
      this.emit("closed");
      windows.splice(windows.indexOf(this), 1);
      if (!windows.length && !app.inQuit) app.emit("window-all-closed");
    }
    getNormalBounds() { return { x: 20, y: 30, width: 1280, height: 860 }; }
    setBackgroundColor() {}
  }
  const handlers = {};
  const defaultSession = {
    setPermissionRequestHandler(fn) { handlers.request = fn; },
    setPermissionCheckHandler(fn) { handlers.check = fn; },
    setDevicePermissionHandler(fn) { handlers.device = fn; },
    on() {},
    webRequest: { onBeforeRequest() {} }
  };
  let current = null;
  const Menu = {
    buildFromTemplate: (items) => ({ items, popup() {} }),
    setApplicationMenu: (m) => { current = m; },
    getApplicationMenu: () => current,
    sent: [],                                              // what went to the window in front (macOS's first responder)
    sendActionToFirstResponder(action) { this.sent.push(action); }
  };
  const nativeTheme = new EventEmitter();
  nativeTheme.shouldUseDarkColors = false;
  const shown = [];
  return {
    app, BrowserWindow, Menu, nativeTheme, handlers,
    dialog: { showMessageBox: async (...a) => { shown.push(a); return { response: 1 }; }, showErrorBox: (...a) => { shown.push(a); } },
    dialogs: shown,
    screen: { getAllDisplays: () => [{ workArea: { x: 0, y: 25, width: 1512, height: 920 } }], getPrimaryDisplay: () => ({ workArea: { x: 0, y: 25, width: 1512, height: 920 } }) },
    session: { defaultSession, fromPartition: () => defaultSession },
    shell: { opened: [], openExternal(url) { this.opened.push(url); return Promise.resolve(); } }
  };
}

// The app's server, standing in for lib/server.js ServerProcess: it records what main.js gives it.
function fakeServers() {
  const made = [];
  class FakeServer extends EventEmitter {
    constructor(o) { super(); this.options = o; this.args = server.serverArgs(o); this.running = false; this.stopping = false; this.stops = 0; made.push(this); }
    start() { this.running = true; this.started = true; }
    async waitUntilReady() { return this.running; }
    async stop() {
      this.stops++;
      if (!this.running) return null;
      this.stopping = true;
      this.running = false;
      this.exited = { code: null, signal: "SIGTERM" };
      this.emit("exit", this.exited);
      return this.exited;
    }
  }
  return { FakeServer, made };
}

// Loads main.js fresh with the stand-ins; returns what a test needs. Everything is put back after the test.
function loadMain(t, o) {
  const opt = o || {};
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "main-test-")));
  const electron = makeElectron(dir);
  const servers = fakeServers();
  const before = {};
  for (const ev of PROCESS_EVENTS) before[ev] = process.listeners(ev).slice();
  python.findPython = async () => ({ python: "/stand-in/python3", tried: [{ path: "/stand-in/python3", ok: true, reason: "stand-in" }] });
  server.probePort = async () => "free";
  server.ServerProcess = servers.FakeServer;
  if (opt.closeHides !== undefined) lifecycle.CLOSE_HIDES = opt.closeHides;
  const argv = process.argv;
  const load = Module._load;
  process.argv = [process.execPath, "--user-data-dir=" + path.join(dir, "user-data"), "--port=" + PORT].concat(opt.argv || []);
  Module._load = function (request) { return request === "electron" ? electron : load.apply(this, arguments); };
  delete require.cache[MAIN];
  try { require(MAIN); } finally { process.argv = argv; Module._load = load; }
  const added = {};
  for (const ev of PROCESS_EVENTS) added[ev] = process.listeners(ev).filter((l) => before[ev].indexOf(l) < 0);
  t.after(() => {
    for (const ev of PROCESS_EVENTS) for (const l of added[ev]) process.removeListener(ev, l);
    python.findPython = REAL.findPython;
    server.probePort = REAL.probePort;
    server.ServerProcess = REAL.ServerProcess;
    lifecycle.CLOSE_HIDES = REAL.closeHides;
    delete require.cache[MAIN];
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { electron, app: electron.app, servers: servers.made, dir, signal: (ev) => added[ev].forEach((l) => l(ev)) };
}

async function until(pred, what) {
  for (let i = 0; i < 400; i++) { if (pred()) return; await new Promise((r) => setTimeout(r, 5)); }
  throw new Error("timed out waiting for " + (what || pred.toString()));
}

// ready → python, the server, the window (as the page paints, it is shown)
async function started(m) {
  m.app.ready();
  await until(() => m.app.windows.length === 1 && m.app.windows[0].webContents.loads.length === 1, "the window");
  const win = m.app.windows[0];
  win.emit("ready-to-show");
  return win;
}
const loads = (win) => win.webContents.loads;
const lastLoad = (win) => loads(win)[loads(win).length - 1];

// ---- --app ----------------------------------------------------------------------------------------------------------------
test("the server starts with --app <desktop/package.json's version>, after --dir (FEATURES E2.3 a)", async (t) => {
  const m = loadMain(t);
  await started(m);
  assert.equal(m.servers.length, 1);
  const srv = m.servers[0];
  assert.equal(srv.options.appVersion, PKG.version);
  assert.equal(srv.options.port, PORT);
  const i = srv.args.indexOf("--app");
  assert.ok(i > 0, srv.args.join(" "));
  assert.deepEqual(srv.args.slice(i - 2, i + 2), ["--dir", srv.options.webDir, "--app", PKG.version]);
  assert.match(PKG.version, /^[0-9]+\.[0-9]+\.[0-9]+$/, "serve.py takes only digits.digits.digits");
  assert.equal(m.app.windows[0].webContents.loads[0], ORIGIN + "/");
});

test("persistent storage is granted to the app's own page, and to nothing else (FEATURES E2.3 c)", async (t) => {
  const m = loadMain(t);
  await started(m);
  const { request, check } = m.electron.handlers;
  const ask = (permission, url) => new Promise((resolve) => request(null, permission, resolve, { requestingUrl: url }));
  assert.equal(await ask("persistent-storage", ORIGIN + "/#library"), true);
  assert.equal(await ask("persistent-storage", "http://127.0.0.1:8765/"), false);
  assert.equal(await ask("notifications", ORIGIN + "/"), false);
  assert.equal(check(null, "persistent-storage", ORIGIN), true);
  assert.equal(check(null, "persistent-storage", "https://example.com"), false);
});

// ---- marginalia:// links ------------------------------------------------------------------------------------------------
test("a link at the first launch (an argument) opens its page in the first window", async (t) => {
  const m = loadMain(t, { argv: ["marginalia://open?hash=%23reader%2Fbook_1%2Fp_9"] });
  const win = await started(m);
  assert.deepEqual(loads(win), [ORIGIN + "/#reader/book_1/p_9"]);
});

test("open-url before the app is ready waits for the window, which then opens on it", async (t) => {
  const m = loadMain(t);
  const ev = event();
  m.app.emit("open-url", ev, "marginalia://open?hash=%23deck%2Fdeck_1");
  assert.equal(ev.defaultPrevented, true, "macOS is told the app took the link");
  assert.equal(m.app.windows.length, 0);
  const win = await started(m);
  assert.deepEqual(loads(win), [ORIGIN + "/#deck/deck_1"]);
});

test("open-url: a valid link loads its page and shows the window; an invalid one opens the library", async (t) => {
  const m = loadMain(t);
  const win = await started(m);
  win.close();                                          // closed (hidden) first: a link brings it back
  assert.equal(win.isVisible(), false);
  m.app.emit("open-url", event(), "marginalia://open?hash=%23reader%2Fabc%2Fp_1");
  assert.equal(lastLoad(win), ORIGIN + "/#reader/abc/p_1");
  assert.equal(win.isVisible(), true);
  assert.ok(win.focuses >= 1);
  for (const bad of ["marginalia://open?hash=%23settings", "marginalia://evil?hash=%23reader%2Fx", "marginalia://open?hash=%23reader%2F..",
    "https://example.com/#reader/x", "marginalia://open"]) {
    m.app.emit("open-url", event(), bad);
    assert.equal(lastLoad(win), ORIGIN + "/#library", bad);
  }
  assert.equal(m.app.windows.length, 1, "links never open a second window");
});

test("a second launch hands its link over and brings the hidden window back", async (t) => {
  const m = loadMain(t);
  const win = await started(m);
  win.close();
  assert.equal(win.isVisible(), false);
  m.app.emit("second-instance", event(), [process.execPath, "--some-chromium-flag", "marginalia://open?hash=%23reader%2Fb2"], "/");
  assert.equal(lastLoad(win), ORIGIN + "/#reader/b2");
  assert.equal(win.isVisible(), true);
  assert.deepEqual(m.app.focusCalls, [{ steal: true }]);
  m.app.emit("second-instance", event(), [process.execPath], "/");      // no link: only to the front
  assert.equal(loads(win).length, 2);
});

// ---- closing the window --------------------------------------------------------------------------------------------------
test("closing the window hides it; the app and its server keep running; the Dock icon and Window › Marginalia show it again (E2.3 b)", async (t) => {
  assert.equal(lifecycle.CLOSE_HIDES, true, "the switch is on");
  const m = loadMain(t);
  const win = await started(m);
  assert.equal(win.isVisible(), true);
  assert.equal(win.excludedFromShownWindowsMenu, true, "Window › Marginalia lists it, macOS's own list does not");
  win.close();
  assert.equal(win.isDestroyed(), false);
  assert.equal(win.isVisible(), false);
  assert.equal(m.app.quitCalls, 0);
  assert.equal(m.servers[0].running, true);
  m.app.emit("activate", event(), false);              // a click on the Dock icon
  assert.equal(win.isVisible(), true);
  win.close();
  const windowMenu = m.electron.Menu.getApplicationMenu().items.find((x) => x.label === "Window");
  const item = windowMenu.submenu.find((x) => x.label === "Marginalia");
  assert.ok(item && typeof item.click === "function", "Window › Marginalia");
  item.click();
  assert.equal(win.isVisible(), true);
  assert.equal(m.app.windows.length, 1);
  assert.equal(loads(win).length, 1, "showing it again does not reload the page");
});

test("closing a window in full screen leaves full screen first, then hides it", async (t) => {
  const m = loadMain(t);
  const win = await started(m);
  win.setFullScreen(true);
  await tick();
  win.close();
  assert.deepEqual(win.fullScreenCalls, [true, false]);
  assert.equal(win.isDestroyed(), false);
  await until(() => win.hides === 1, "the hide after leaving full screen");
  assert.equal(win.isVisible(), false);
  assert.equal(win.isFullScreen(), false);
});

test("the self-test's close probe sees main.js's close handler hide the window, also from full screen (repair F2)", async (t) => {
  const m = loadMain(t);
  const win = await started(m);
  win.webContents.executeJavaScript = async (src) => (src === "1 + 1" ? 2 : null);   // the page answers
  const r = await selftest.closeProbe(win, { settle: tick, serverRunning: () => m.servers[0].running });
  assert.deepEqual(r, { closeHides: true, destroyed: false, visible: false, hid: true, hides: 1, pageAlive: true, serverRunning: true });
  assert.equal(win.hides, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(win, "hide"), false, "the probe's wrapper is gone");
  assert.equal(selftest.evaluate({}, { close: r }).checks["close-hides"].ok, true);
  m.app.emit("activate", event(), false);
  win.setFullScreen(true);
  await tick();
  const fs2 = await selftest.closeProbe(win, { settle: () => until(() => win.hides === 2, "the hide after leaving full screen"),
    serverRunning: () => m.servers[0].running });
  assert.deepEqual([fs2.hid, fs2.hides, fs2.visible, win.isFullScreen()], [true, 1, false, false]);
});

test("with the switch off, closing the window quits the app and stops its server (part 1's behaviour)", async (t) => {
  const m = loadMain(t, { closeHides: false });
  const win = await started(m);
  win.close();
  assert.equal(win.isDestroyed(), true);
  await until(() => m.app.quitted, "the quit");
  assert.equal(m.servers[0].stops >= 1, true);
  assert.equal(m.servers[0].running, false);
});

// ---- quitting -------------------------------------------------------------------------------------------------------------
test("Cmd+Q (the app menu's Quit, logging out, restarting) closes the window for real and stops the server before the app ends", async (t) => {
  const m = loadMain(t);
  const win = await started(m);
  const order = [];
  // main.js's will-quit listener runs first: it holds the quit and starts the stop; this one notes what it did
  m.app.on("will-quit", (ev) => order.push("will-quit " + (ev.defaultPrevented ? "held" : "went through")));
  const stop = m.servers[0].stop.bind(m.servers[0]);
  m.servers[0].stop = async () => { order.push("server stop"); return stop(); };
  m.app.quit();
  assert.equal(win.isDestroyed(), true, "the close is not turned into a hide while quitting");
  await until(() => m.app.quitted, "the quit");
  assert.equal(m.servers[0].running, false);
  assert.deepEqual(order, ["server stop", "will-quit held", "will-quit went through"]);
  assert.equal(m.app.quitCalls, 2, "main.js quits again once the server has stopped");
});

test("SIGTERM quits the same way, also while the window is hidden", async (t) => {
  const m = loadMain(t);
  const win = await started(m);
  win.close();
  m.signal("SIGTERM");
  await until(() => m.app.quitted, "the quit");
  assert.equal(win.isDestroyed(), true);
  assert.equal(m.servers[0].running, false);
  assert.ok(m.servers[0].stops >= 1);
});

test("a link that comes after the window was destroyed opens a new window on it", async (t) => {
  const m = loadMain(t);
  const win = await started(m);
  win.destroy();                                         // not by closing (that hides): the app keeps running
  assert.equal(m.app.quitted, false);
  assert.equal(m.app.windows.length, 0);
  m.app.emit("open-url", event(), "marginalia://open?hash=%23reader%2Fz");
  assert.equal(m.app.windows.length, 1);
  assert.deepEqual(loads(m.app.windows[0]), [ORIGIN + "/#reader/z"]);
  m.app.windows[0].destroy();
  m.app.emit("activate", event(), false);
  assert.equal(m.app.windows.length, 1, "the Dock icon opens one too");
  assert.deepEqual(loads(m.app.windows[0]), [ORIGIN + "/"]);
  m.app.windows[0].destroy();
  m.app.emit("second-instance", event(), [process.execPath], "/");
  assert.equal(m.app.windows.length, 1, "and so does a second launch without a link");
  assert.deepEqual(loads(m.app.windows[0]), [ORIGIN + "/"]);
  m.app.windows[0].destroy();
  m.app.emit("second-instance", event(), [process.execPath, "marginalia://open?hash=%23deck%2Fd9"], "/");
  assert.equal(m.app.windows.length, 1, "a second launch with a link opens exactly one window");
  assert.deepEqual(loads(m.app.windows[0]), [ORIGIN + "/#deck/d9"]);
});

// ---- tabs (DECISIONS D30) -------------------------------------------------------------------------------------------------
// A click on an item of the Window menu (what its shortcut does too).
function windowItem(m, label) {
  const windowMenu = m.electron.Menu.getApplicationMenu().items.find((x) => x.label === "Window");
  const item = windowMenu.submenu.find((x) => x.label === label);
  assert.ok(item && typeof item.click === "function", "Window › " + label);
  return item;
}
const TAB_ITEMS = [["New Tab", "newTab"], ["Close Tab", "closeTab"], ["Reopen Closed Tab", "reopenTab"], ["Show Next Tab", "nextTab"], ["Show Previous Tab", "prevTab"]];

test("the Window menu's tab commands run the web app's own command in the page of the window in front, and nothing else", async (t) => {
  const m = loadMain(t);
  const win = await started(m);
  const wc = win.webContents;
  wc.emit("did-finish-load");
  wc.answer = "done";                                      // the page ran the command
  assert.equal(win.isFocused(), true);
  for (const [label, id] of TAB_ITEMS) {
    windowItem(m, label).click();
    await tick();
    assert.deepEqual(wc.scripts, [menu.tabScript(id)], label);
    wc.scripts.length = 0;
  }
  assert.equal(win.isVisible(), true);
  assert.equal(win.hides, 0, "the window stays: every command had something to do");
  assert.equal(loads(win).length, 1, "no reload, no navigation");
  assert.deepEqual(m.electron.Menu.sent, []);
});

test("Cmd+W: with more tabs the page closes one and the window stays; with one tab left the window closes, which hides it", async (t) => {
  const m = loadMain(t);
  const win = await started(m);
  const wc = win.webContents;
  wc.emit("did-finish-load");
  wc.answer = "done";
  windowItem(m, "Close Tab").click();
  await tick();
  assert.equal(win.isVisible(), true, "a tab closed, not the window");
  // more tabs, but a review or a dialog is on screen: Cmd+W does nothing, and the window stays
  wc.answer = "blocked";
  windowItem(m, "Close Tab").click();
  await tick(); await tick();
  assert.equal(win.hides, 0);
  assert.equal(win.isVisible(), true, "a review is not hidden by Cmd+W while other tabs are open");
  wc.answer = "last";                                      // one tab left: not the page's to close
  windowItem(m, "Close Tab").click();
  await until(() => win.hides === 1, "the window to hide");
  assert.equal(win.isDestroyed(), false);
  assert.equal(win.isVisible(), false);
  assert.equal(m.servers[0].running, true, "the app and its server keep running");
  assert.equal(m.app.quitCalls, 0);
  // the other commands never close the window, whatever the page answers
  m.app.emit("activate", event(), false);
  assert.equal(win.isVisible(), true);
  for (const answer of ["last", "none", "blocked", "done", true, null]) {
    wc.answer = answer;
    for (const label of ["New Tab", "Reopen Closed Tab", "Show Next Tab", "Show Previous Tab"]) { windowItem(m, label).click(); await tick(); }
  }
  await tick();
  assert.equal(win.hides, 1);
  assert.equal(win.isVisible(), true);
  // a page that cannot answer (the script fails): Cmd+W still closes the window
  wc.answer = () => { throw new Error("the page is gone"); };
  windowItem(m, "Close Tab").click();
  await until(() => win.hides === 2, "the window to hide again");
  // an answer that is none of the four counts as "none" (not the web app): the window closes
  m.app.emit("activate", event(), false);
  wc.answer = true;
  windowItem(m, "Close Tab").click();
  await until(() => win.hides === 3, "the window to hide a third time");
  // a page that did not load (Chromium's error page: no web app in it) answers "none": Cmd+W hides the window
  m.app.emit("activate", event(), false);
  wc.emit("did-fail-load", {}, -102, "ERR_CONNECTION_REFUSED", ORIGIN + "/", true);
  wc.scripts.length = 0;
  wc.answer = "none";
  windowItem(m, "Close Tab").click();
  await until(() => win.hides === 4, "the window to hide a fourth time");
  assert.deepEqual(wc.scripts, [menu.tabScript("closeTab")], "the page itself is asked, whatever the app believes about it");
});

test("Cmd+W closes nothing when the app starts to quit, or the window is gone, before the page has answered", async (t) => {
  const m = loadMain(t);
  const win = await started(m);
  const wc = win.webContents;
  wc.emit("did-finish-load");
  let answer;
  wc.answer = () => new Promise((resolve) => { answer = resolve; });   // the page takes its time
  windowItem(m, "Close Tab").click();
  await tick();
  assert.equal(typeof answer, "function", "the page was asked");
  m.app.emit("before-quit", event());                      // Cmd+Q meanwhile
  answer("last");
  await tick(); await tick();
  assert.equal(win.hides, 0, "the quit closes the window, not Cmd+W's late answer");
  assert.equal(win.isDestroyed(), false);
  // the window is destroyed while the page is asked: nothing is closed, nothing throws
  const m2 = loadMain(t);
  const win2 = await started(m2);
  win2.webContents.emit("did-finish-load");
  let answer2;
  win2.webContents.answer = () => new Promise((resolve) => { answer2 = resolve; });
  windowItem(m2, "Close Tab").click();
  await tick();
  let closes = 0;
  win2.on("close", () => { closes++; });
  win2.destroy();
  answer2("last");
  await tick(); await tick();
  assert.equal(closes, 0);
  assert.equal(m2.app.windows.length, 0);
});

test("the tab commands ask the page itself: they work after a refused link, and while the server is down", async (t) => {
  const m = loadMain(t);
  const win = await started(m);
  const wc = win.webContents;
  wc.emit("did-finish-load");
  wc.answer = "done";
  // a link to another site: the navigation starts, the app refuses it (the link opens in the browser), and Chromium
  // reports it as given up. The page that was there stays, and so do its tabs.
  wc.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
  wc.emit("did-fail-provisional-load", {}, -3, "ERR_ABORTED", "https://example.invalid/", true);
  windowItem(m, "Close Tab").click();
  await tick();
  assert.deepEqual(wc.scripts, [menu.tabScript("closeTab")]);
  assert.equal(win.isVisible(), true, "a tab closed; the window did not hide");
  // the server stops: the page stays as it is, and its tabs need no server
  wc.scripts.length = 0;
  m.electron.dialog.showMessageBox = () => new Promise(() => {});   // the "server stopped" dialog stays open
  m.servers[0].running = false;
  m.servers[0].emit("exit", { code: 1, signal: null });
  await tick();
  windowItem(m, "New Tab").click();
  await tick();
  assert.deepEqual(wc.scripts, [menu.tabScript("newTab")]);
});

test("a refused link does not leave the page marked as not loaded: the page is not reloaded when the server comes back", async (t) => {
  const restart = async (m) => {
    m.electron.dialog.showMessageBox = async () => ({ response: 0 });     // "Restart"
    m.servers[0].running = false;
    m.servers[0].emit("exit", { code: 1, signal: null });
    await until(() => m.servers.length === 2 && m.servers[1].running, "the server to start again");
    await tick(); await tick();
  };
  // a page that loaded, then a refused link: the page that was there is fine
  let m = loadMain(t);
  let win = await started(m);
  win.webContents.emit("did-finish-load");
  win.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
  win.webContents.emit("did-fail-provisional-load", {}, -3, "ERR_ABORTED", "https://example.invalid/", true);
  await restart(m);
  assert.equal(win.webContents.reloads, 0, "no reload: an editor that is open in the page stays open");
  // a hash change (a marginalia:// link) never puts the page in doubt
  const sameDocument = async () => {
    const m3 = loadMain(t), w3 = await started(m3);
    w3.webContents.emit("did-finish-load");
    w3.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
    await restart(m3);
    assert.equal(w3.webContents.reloads, 0, "a link that only changed the hash");
  };
  await sameDocument();
  // … and neither does a frame inside the page, whether its navigation goes through or is given up
  const subFrame = async (events) => {
    const m4 = loadMain(t), w4 = await started(m4);
    w4.webContents.emit("did-finish-load");
    for (const e of events) w4.webContents.emit(...e);
    await restart(m4);
    return w4.webContents.reloads;
  };
  assert.equal(await subFrame([["did-start-navigation", { isMainFrame: false, isSameDocument: false }]]), 0, "a frame's navigation");
  // the page's own navigation is under way when a frame's one is given up: the page is not loaded yet, whatever the frame did
  assert.equal(await subFrame([
    ["did-start-navigation", { isMainFrame: true, isSameDocument: false }],
    ["did-fail-provisional-load", {}, -3, "ERR_ABORTED", "about:blank", false]]), 1, "the server came back in the middle of the page's reload");
  // a frame's given-up navigation must not put back an older value of the page's own flag: the page's reload failed …
  assert.equal(await subFrame([
    ["did-start-navigation", { isMainFrame: true, isSameDocument: false }],
    ["did-fail-provisional-load", {}, -3, "ERR_ABORTED", "about:blank", false],
    ["did-fail-provisional-load", {}, -102, "ERR_CONNECTION_REFUSED", ORIGIN + "/", true],
    ["did-fail-load", {}, -102, "ERR_CONNECTION_REFUSED", ORIGIN + "/", true]]), 1, "… and is tried again when the server is back");
  // two navigations that overlap, both given up: the page that was there all the time is still fine
  assert.equal(await subFrame([
    ["did-start-navigation", { isMainFrame: true, isSameDocument: false }],
    ["did-start-navigation", { isMainFrame: true, isSameDocument: false }],
    ["did-fail-provisional-load", {}, -3, "ERR_ABORTED", "https://example.invalid/a", true],
    ["did-fail-provisional-load", {}, -3, "ERR_ABORTED", "https://example.invalid/b", true]]), 0, "two refused links in a row");
  // a page whose own load failed is reloaded once the server answers, as before
  m = loadMain(t);
  win = await started(m);
  win.webContents.emit("did-finish-load");
  win.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });      // a reload …
  win.webContents.emit("did-fail-provisional-load", {}, -102, "ERR_CONNECTION_REFUSED", ORIGIN + "/", true);
  win.webContents.emit("did-fail-load", {}, -102, "ERR_CONNECTION_REFUSED", ORIGIN + "/", true);   // … that found no server
  await restart(m);
  assert.equal(win.webContents.reloads, 1);
  // and a navigation that is still under way when a refused one ends does not count as loaded
  m = loadMain(t);
  win = await started(m);                                 // the first load has not finished: not healthy yet
  win.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
  win.webContents.emit("did-fail-provisional-load", {}, -3, "ERR_ABORTED", "https://example.invalid/", true);
  await restart(m);
  assert.equal(win.webContents.reloads, 1, "a page that never loaded is still reloaded");
});

test("the tab commands while the window is hidden or behind another window, and with no window at all", async (t) => {
  const m = loadMain(t);
  const win = await started(m);
  const wc = win.webContents;
  wc.emit("did-finish-load");
  wc.answer = "done";
  win.close();                                             // hidden
  assert.equal(win.isVisible(), false);
  // Cmd+W belongs to whatever window is in front (the About panel); the hidden page is not asked
  windowItem(m, "Close Tab").click();
  await tick();
  assert.deepEqual(m.electron.Menu.sent, ["performClose:"]);
  assert.deepEqual(wc.scripts, []);
  // Show Next Tab and Show Previous Tab do nothing
  windowItem(m, "Show Next Tab").click();
  windowItem(m, "Show Previous Tab").click();
  await tick();
  assert.deepEqual(wc.scripts, []);
  assert.equal(win.isVisible(), false);
  // New Tab brings the window back, then the page adds the tab
  windowItem(m, "New Tab").click();
  await tick();
  assert.equal(win.isVisible(), true);
  assert.deepEqual(wc.scripts, [menu.tabScript("newTab")]);
  win.close();
  wc.scripts.length = 0;
  windowItem(m, "Reopen Closed Tab").click();
  await tick();
  assert.equal(win.isVisible(), true);
  assert.deepEqual(wc.scripts, [menu.tabScript("reopenTab")]);
  // shown, but another window of the app is in front (Developer Tools in a window of their own)
  win.focused = false;
  wc.scripts.length = 0;
  windowItem(m, "Close Tab").click();
  windowItem(m, "Show Next Tab").click();
  await tick();
  assert.deepEqual(m.electron.Menu.sent, ["performClose:", "performClose:"]);
  assert.deepEqual(wc.scripts, []);
  assert.equal(win.isVisible(), true, "the main window is not closed from behind");
  const focuses = win.focuses;
  windowItem(m, "New Tab").click();
  await tick();
  assert.equal(win.focuses, focuses + 1, "New Tab brings the main window to the front");
  assert.deepEqual(wc.scripts, [menu.tabScript("newTab")]);
  // minimized: the same as hidden
  win.minimized = true;
  wc.scripts.length = 0;
  windowItem(m, "Show Next Tab").click();
  await tick();
  assert.deepEqual(wc.scripts, []);
  windowItem(m, "New Tab").click();
  await tick();
  assert.equal(win.minimized, false);
  assert.deepEqual(wc.scripts, [menu.tabScript("newTab")]);
  // no window at all (it was destroyed, not closed): New Tab opens one, whose page brings its tabs back by itself
  win.destroy();
  assert.equal(m.app.windows.length, 0);
  windowItem(m, "Show Next Tab").click();
  windowItem(m, "Close Tab").click();
  await tick();
  assert.equal(m.app.windows.length, 0);
  windowItem(m, "New Tab").click();
  await tick();
  assert.equal(m.app.windows.length, 1);
  assert.deepEqual(loads(m.app.windows[0]), [ORIGIN + "/"]);
  assert.deepEqual(m.app.windows[0].webContents.scripts, [], "nothing runs in a page that is still loading");
});

test("no tab command runs while the app quits", async (t) => {
  const m = loadMain(t);
  const win = await started(m);
  const wc = win.webContents;
  wc.emit("did-finish-load");
  wc.answer = "last";
  m.app.emit("before-quit", event());                      // Cmd+Q is on its way
  for (const [label] of TAB_ITEMS) windowItem(m, label).click();
  await tick();
  await tick();
  assert.deepEqual(wc.scripts, []);
  assert.deepEqual(m.electron.Menu.sent, []);
  assert.equal(win.hides, 0);
});

test("the self-test's command sequence through the real menu items: the page follows each one, and Cmd+W hides the window once", async (t) => {
  // A page that behaves as js/tabs.js does. It is asked through the scripts main.js sends (lib/menu.js tabScript) and
  // looked at through the self-test's own look script.
  const m = loadMain(t);
  const win = await started(m);
  const wc = win.webContents;
  wc.emit("did-finish-load");
  const page = { places: ["reader:b1", "library"], active: 1, closed: [] };
  const run = (id) => {
    const n = page.places.length;
    if (id === "newTab") { page.places.splice(page.active + 1, 0, "library"); page.active++; return "done"; }
    if (id === "closeTab") { if (n < 2) return "last"; page.closed.push(page.places[page.active]); page.places.splice(page.active, 1); page.active = Math.min(page.active, page.places.length - 1); return "done"; }
    if (id === "reopenTab") { if (!page.closed.length) return n > 1 ? "blocked" : "last"; page.places.splice(page.active + 1, 0, page.closed.pop()); page.active++; return "done"; }
    if (id === "nextTab" || id === "prevTab") { if (n < 2) return "last"; page.active = (page.active + (id === "nextTab" ? 1 : n - 1)) % n; return "done"; }
    return "none";
  };
  const ids = Object.fromEntries(menu.TAB_COMMANDS.map((id) => [menu.tabScript(id), id]));
  let last = null;
  wc.answer = (script) => {
    if (script === selftest.TABS_LOOK) return { tabs: page.places.length, active: page.active, strip: page.places.length > 1, places: page.places.slice() };
    assert.ok(ids[script], "only the menu's five scripts reach the page: " + script.slice(0, 60));
    last = run(ids[script]);
    return last;
  };
  const label = { newTab: "New Tab", closeTab: "Close Tab", reopenTab: "Reopen Closed Tab", nextTab: "Show Next Tab", prevTab: "Show Previous Tab" };
  const probe = await selftest.tabsProbe({
    run: async (id) => { last = null; windowItem(m, label[id]).click(); await tick(); await tick(); return last; },
    look: () => wc.executeJavaScript(selftest.TABS_LOOK),
    script: (name) => menu.tabScript(name)
  });
  assert.deepEqual(selftest.tabsVerdict(probe), { ok: true, why: null }, JSON.stringify(probe.steps.map((s) => [s.id, s.answer])));
  assert.deepEqual(page.places, ["library"], "the page is left with one tab");
  // Close Tab found one tab left exactly once: the window hid then, and the next New Tab brought it back
  assert.equal(win.hides, 1);
  assert.equal(win.isVisible(), true);
  assert.equal(win.isDestroyed(), false);
  assert.deepEqual(m.electron.Menu.sent, []);
});

// ---- several windows (DECISIONS D31) -------------------------------------------------------------------------------
const WINDOW_URL = new RegExp("^" + ORIGIN.replace(/\./g, "\\.") + "/\\?w=[a-z0-9]{10}$");
// Window › New Window, clicked with the first window on screen. → the new window (as its page paints, it is shown)
function newWindow(m) {
  const before = m.app.windows.slice();
  windowItem(m, "New Window").click();
  const made = m.app.windows.filter((w) => !before.includes(w));
  assert.equal(made.length, 1, "one new window");
  made[0].emit("ready-to-show");
  return made[0];
}
// What the page of a window answers to main.js's window scripts (lib/menu.js windowScript).
function pageOf(win, answers) {
  win.webContents.answer = (script) => {
    for (const [id, arg, value] of answers) if (script === menu.windowScript(id, arg)) return typeof value === "function" ? value() : value;
    return undefined;
  };
}

test("Window › New Window (Cmd+N): a second window on a page of its own, as large as the first and set off from it", async (t) => {
  const m = loadMain(t);
  const win = await started(m);
  assert.equal(windowItem(m, "New Window").accelerator, "Command+N");
  const two = newWindow(m);
  assert.equal(m.app.windows.length, 2);
  assert.match(lastLoad(two), WINDOW_URL);
  assert.equal(loads(two).length, 1);
  assert.equal(loads(win).length, 1, "the first window's page is not touched");
  assert.equal(lastLoad(win), ORIGIN + "/");
  assert.deepEqual([two.opts.x, two.opts.y, two.opts.width, two.opts.height], [48, 58, 1280, 860]);
  assert.deepEqual(two.opts.webPreferences, win.opts.webPreferences, "the same locked-down page: sandbox, no Node, the same preload");
  assert.equal(two.opts.webPreferences.sandbox, true);
  assert.equal(two.opts.webPreferences.contextIsolation, true);
  assert.equal(two.opts.webPreferences.nodeIntegration, false);
  assert.equal(two.isVisible(), true);
  // a window that the user asked for is on screen at once (its page follows); the first window waits for its page
  assert.equal(two.opts.show, true);
  assert.equal(win.opts.show, false);
  assert.equal(two.shows, 0, "its page has painted: it is not shown a second time");
  assert.equal(win.shows, 1);
  // with two windows macOS lists them in the Window menu; with one, Window › Marginalia does
  assert.equal(win.excludedFromShownWindowsMenu, false);
  assert.equal(two.excludedFromShownWindowsMenu, false);
  // a third one gets an id of its own
  const three = newWindow(m);
  assert.match(lastLoad(three), WINDOW_URL);
  assert.notEqual(lastLoad(three), lastLoad(two));
  assert.equal(m.servers.length, 1, "one server for all windows");
});

test("Cmd+N brings back a window that closing hid, and opens the first window again when there is none", async (t) => {
  const m = loadMain(t);
  const win = await started(m);
  win.close();                                             // the last window: hidden
  assert.equal(win.isVisible(), false);
  windowItem(m, "New Window").click();
  assert.equal(m.app.windows.length, 1, "no second window while the first is hidden: it comes back");
  assert.equal(win.isVisible(), true);
  assert.equal(loads(win).length, 1);
  win.destroy();                                           // no window at all (the app keeps running)
  assert.equal(m.app.windows.length, 0);
  windowItem(m, "New Window").click();
  assert.equal(m.app.windows.length, 1);
  assert.equal(lastLoad(m.app.windows[0]), ORIGIN + "/", "the first window's own page, with the stored tabs");
  // while the app quits nothing opens
  const m2 = loadMain(t);
  await started(m2);
  m2.app.emit("before-quit", event());
  windowItem(m2, "New Window").click();
  assert.equal(m2.app.windows.length, 1);
});

test("closing with several windows: a window that is not the last one closes for good, after its page forgot its tabs; the last one hides", async (t) => {
  const m = loadMain(t);
  const win = await started(m);
  const two = newWindow(m);
  let answer;
  const asked = new Promise((r) => { answer = r; });     // the page answers when the test says so
  pageOf(two, [["leave", undefined, () => asked]]);
  pageOf(win, [["role", undefined, true]]);
  two.close();                                             // the red button, Shift+Cmd+W, or Cmd+W with one tab left
  await tick();
  assert.equal(two.isDestroyed(), false, "its page is asked first");
  assert.deepEqual(two.webContents.scripts, [menu.windowScript("leave")]);
  two.close();                                             // a second close while it is on its way out changes nothing
  await tick();
  assert.deepEqual(two.webContents.scripts, [menu.windowScript("leave")]);
  assert.equal(two.isDestroyed(), false);
  assert.equal(two.hides, 0, "it is not hidden: it goes");
  assert.deepEqual(win.webContents.scripts, [], "the window in front is asked nothing yet");
  answer(true);
  await tick(); await tick();
  assert.equal(two.isDestroyed(), true);
  assert.equal(m.app.windows.length, 1);
  assert.equal(win.isVisible(), true);
  assert.equal(win.excludedFromShownWindowsMenu, true, "one window again: Window › Marginalia lists it");
  // the closed window may have taken the writer role to store its place: the window in front takes it back
  assert.deepEqual(win.webContents.scripts, [menu.windowScript("role")]);
  assert.equal(m.app.quitCalls, 0);
  // now the first window is the last one: closing hides it, and the app and its server stay
  win.close();
  assert.equal(win.isDestroyed(), false);
  assert.equal(win.isVisible(), false);
  assert.equal(m.servers[0].running, true);
  assert.equal(win.webContents.scripts.length, 1, "a window that only hides is asked nothing");
});

test("the first window can close for good too: the window that stays is then the window (links, the Dock icon), and hides when it closes", async (t) => {
  const m = loadMain(t);
  const win = await started(m);
  const two = newWindow(m);
  pageOf(win, [["leave", undefined, true]]);
  pageOf(two, [["role", undefined, true]]);
  win.close();
  await tick(); await tick();
  assert.equal(win.isDestroyed(), true);
  assert.deepEqual(m.app.windows, [two]);
  assert.deepEqual(two.webContents.scripts, [menu.windowScript("role")]);
  // a link goes to the window that is left, and keeps that window's own page ("?w=<id>")
  const own = lastLoad(two);
  m.app.emit("open-url", event(), "marginalia://open?hash=%23reader%2Fabc%2Fp_1");
  assert.equal(lastLoad(two), own + "#reader/abc/p_1");
  two.close();
  assert.equal(two.isDestroyed(), false, "the last window hides");
  assert.equal(two.isVisible(), false);
  m.app.emit("activate", event(), false);                  // the Dock icon
  assert.equal(two.isVisible(), true);
  assert.equal(m.app.windows.length, 1);
});

test("a window whose page does not answer still closes (after 1.5 s), and two windows that close at once both go but the last", async (t) => {
  const m = loadMain(t);
  const win = await started(m);
  const two = newWindow(m);
  two.webContents.answer = () => new Promise(() => {});    // a page that hangs
  const t0 = Date.now();
  two.close();
  await tick();
  assert.equal(two.isDestroyed(), false);
  await until(() => two.isDestroyed(), "the window to close without its page's answer");
  assert.ok(Date.now() - t0 >= 1400, "it waited for the page first");
  assert.equal(win.isDestroyed(), false);
  // three windows; two are closed in the same moment: both go, and the one that is left is the last (it would hide)
  const a = newWindow(m), b = newWindow(m);
  pageOf(a, [["leave", undefined, true]]);
  pageOf(b, [["leave", undefined, true]]);
  a.close(); b.close();
  win.close();                                             // the only one that is not on its way out: it hides
  assert.equal(win.isVisible(), false);
  await tick(); await tick();
  assert.deepEqual(m.app.windows, [win]);
  assert.equal(win.isDestroyed(), false);
});

test("Cmd+Q with several windows closes them all for real and stops the server; no page is asked anything", async (t) => {
  const m = loadMain(t);
  const win = await started(m);
  const two = newWindow(m), three = newWindow(m);
  pageOf(three, [["leave", undefined, true]]);
  three.close();                                           // one is on its way out when the app quits
  m.app.quit();
  await until(() => m.app.quitted, "the app to quit");
  assert.equal(m.app.windows.length, 0);
  assert.equal(win.isDestroyed() && two.isDestroyed() && three.isDestroyed(), true);
  assert.equal(m.servers[0].running, false);
  assert.deepEqual(win.webContents.scripts.concat(two.webContents.scripts), [], "a quit keeps every window's tabs for the next start");
});

test("a tab that moves out: the page's window.open for \"/?w=<id>\" makes a window where it asked; never an id twice, never more than 8", async (t) => {
  const m = loadMain(t);
  const win = await started(m);
  const open = (w, url, features) => w.webContents.openHandler({ url, features: features || "" });
  assert.deepEqual(open(win, ORIGIN + "/?w=abc1234567", "popup=yes,width=900,height=700,left=300,top=120"), { action: "deny" }, "Electron itself never makes a window");
  assert.equal(m.app.windows.length, 2);
  const two = m.app.windows[1];
  assert.equal(lastLoad(two), ORIGIN + "/?w=abc1234567");
  assert.deepEqual([two.opts.x, two.opts.y, two.opts.width, two.opts.height], [300, 120, 900, 700], "where the tab was dropped");
  assert.deepEqual(two.opts.webPreferences, win.opts.webPreferences);
  assert.equal(loads(win).length, 1);
  // a place far outside every screen is brought back onto one
  open(win, ORIGIN + "/?w=faraway123", "popup=yes,width=900,height=700,left=90000,top=-90000");
  const far = m.app.windows[2];
  assert.ok(far.opts.x >= 0 && far.opts.x < 1512 && far.opts.y >= 25 && far.opts.y < 945, "on the screen: " + far.opts.x + "," + far.opts.y);
  // the same id again is refused
  assert.deepEqual(open(win, ORIGIN + "/?w=abc1234567"), { action: "deny" });
  assert.equal(m.app.windows.length, 3);
  // a link that a page opens in a new tab of the app's own page loads in the window that asked, which keeps its id
  open(two, ORIGIN + "/#deck/d1");
  assert.equal(lastLoad(two), ORIGIN + "/?w=abc1234567#deck/d1");
  open(win, ORIGIN + "/#deck/d1");
  assert.equal(lastLoad(win), ORIGIN + "/#deck/d1");
  assert.equal(m.app.windows.length, 3);
  // at most 8 windows
  for (let i = 0; i < 9; i++) open(win, ORIGIN + "/?w=window" + i);
  assert.equal(m.app.windows.length, 8);
  windowItem(m, "New Window").click();
  assert.equal(m.app.windows.length, 8, "Cmd+N too");
  // an address that is no window of the app never makes one
  for (const url of [ORIGIN + "/?w=ABC", ORIGIN + "/?w=abc1234567&x=1", "https://example.com/?w=abc1234567", "file:///?w=abc1234567", "javascript:void 0"]) {
    assert.deepEqual(open(win, url), { action: "deny" }, url);
    assert.equal(m.app.windows.length, 8, url);
  }
  assert.deepEqual(m.electron.shell.opened, [], "and nothing went outside without a click");
});

test("no window opens while the server is not there or the app quits", async (t) => {
  const m = loadMain(t);
  const win = await started(m);
  const open = (url) => win.webContents.openHandler({ url, features: "" });
  m.electron.dialog.showMessageBox = () => new Promise(() => {});      // the "server stopped" question stays open
  m.servers[0].running = false;
  m.servers[0].emit("exit", { code: 1, signal: null });
  await tick();
  open(ORIGIN + "/?w=abc1234567");
  assert.equal(m.app.windows.length, 1, "the server is down");
  const m2 = loadMain(t);
  const w2 = await started(m2);
  m2.app.emit("before-quit", event());
  w2.webContents.openHandler({ url: ORIGIN + "/?w=abc1234567", features: "" });
  assert.equal(m2.app.windows.length, 1, "the app quits");
});

test("a window never takes another window's page: a navigation to another id is turned back to its own", async (t) => {
  const m = loadMain(t);
  const win = await started(m);
  win.webContents.openHandler({ url: ORIGIN + "/?w=abc1234567", features: "" });
  const two = m.app.windows[1];
  const nav = (w, url) => { const ev = Object.assign(event(), { url }); w.webContents.emit("will-navigate", ev); return ev.defaultPrevented; };
  assert.equal(nav(two, ORIGIN + "/?w=abc1234567#library"), false, "its own page");
  assert.equal(loads(two).length, 1);
  assert.equal(nav(two, ORIGIN + "/?w=other12345"), true);
  assert.equal(lastLoad(two), ORIGIN + "/?w=abc1234567");
  assert.equal(nav(two, ORIGIN + "/#reader/b1"), true, "the first window's address, in a window with an id");
  assert.equal(lastLoad(two), ORIGIN + "/?w=abc1234567#reader/b1");
  assert.equal(nav(win, ORIGIN + "/?w=abc1234567"), true, "the first window never gets an id");
  assert.equal(lastLoad(win), ORIGIN + "/");
  assert.equal(nav(win, ORIGIN + "/#library"), false);
  assert.equal(nav(win, ORIGIN + "/"), false);
  assert.equal(loads(win).length, 2);
  // outside the app: as before (refused; opened in the browser only after a click)
  assert.equal(nav(two, "https://example.com/"), true);
  assert.equal(loads(two).length, 3);
});

test("Window › Move Tab to New Window asks the page of the window in front, and only that", async (t) => {
  const m = loadMain(t);
  const win = await started(m);
  win.webContents.answer = true;
  windowItem(m, "Move Tab to New Window").click();
  await tick();
  assert.deepEqual(win.webContents.scripts, [menu.windowScript("moveTab")]);
  assert.equal(m.app.windows.length, 1, "the page asks for the window itself (window.open)");
  // behind another window (the About panel), hidden, or while the app quits: nothing
  win.webContents.scripts.length = 0;
  win.focused = false;
  windowItem(m, "Move Tab to New Window").click();
  win.focused = true;
  win.hide();
  windowItem(m, "Move Tab to New Window").click();
  win.show();
  m.app.emit("before-quit", event());
  windowItem(m, "Move Tab to New Window").click();
  await tick();
  assert.deepEqual(win.webContents.scripts, []);
  // with two windows it is the one in front
  const m2 = loadMain(t);
  const w1 = await started(m2);
  const w2 = newWindow(m2);
  w1.webContents.answer = true; w2.webContents.answer = true;
  windowItem(m2, "Move Tab to New Window").click();
  await tick();
  assert.deepEqual([w1.webContents.scripts.length, w2.webContents.scripts.length], [0, 1], "the new window is in front");
  w1.focused = true; w1.emit("focus");
  w2.focused = false;
  windowItem(m2, "Move Tab to New Window").click();
  await tick();
  assert.deepEqual([w1.webContents.scripts.length, w2.webContents.scripts.length], [1, 1], "now the first one is");
});

test("Window › Merge All Windows: the window in front says which tabs came in, and the other windows let exactly those go; a window that gave all its tabs closes", async (t) => {
  const m = loadMain(t);
  const win = await started(m);
  const a = newWindow(m), b = newWindow(m);
  win.focused = true; win.emit("focus");                   // the first window is in front
  const one = JSON.stringify([{ screen: "library", collectionId: null, position: null, editing: null }]);
  const two = JSON.stringify([{ screen: "reader", collectionId: "b1", position: { pageIndex: 2, fraction: 0, zoom: "fit" }, editing: null },
    { screen: "deck", collectionId: "d1", position: null, editing: null }]);
  pageOf(a, [["dump", undefined, one], ["drop", [0], 0]]);
  pageOf(b, [["dump", undefined, two], ["drop", [1], 1]]);
  pageOf(win, [["take", one, [0]], ["take", two, [1]]]);   // of b's two tabs only the second came in (the first: no room, or a book that is gone)
  windowItem(m, "Merge All Windows").click();
  await until(() => a.isDestroyed(), "the window that gave all its tabs to close");
  await tick(); await tick(); await tick();
  assert.deepEqual(a.webContents.scripts, [menu.windowScript("dump"), menu.windowScript("drop", [0])]);
  assert.deepEqual(b.webContents.scripts, [menu.windowScript("dump"), menu.windowScript("drop", [1])], "b lets go the tab that came in, not its first tab");
  assert.deepEqual(win.webContents.scripts, [menu.windowScript("take", one), menu.windowScript("take", two)]);
  assert.deepEqual(m.app.windows, [win, b], "b keeps the tab that did not come in");
  assert.equal(b.isDestroyed(), false);
  // a window whose page gives nothing (no web app there, a review or a dialog on screen, an answer that is no list) is left alone
  const m2 = loadMain(t);
  const w1 = await started(m2);
  const w2 = newWindow(m2), w3 = newWindow(m2);
  w1.focused = true; w1.emit("focus");
  pageOf(w2, [["dump", undefined, null]]);
  pageOf(w3, [["dump", undefined, "{\"not\":\"a list\"}"]]);
  w1.webContents.answer = [0];
  windowItem(m2, "Merge All Windows").click();
  await tick(); await tick(); await tick(); await tick();
  assert.deepEqual(w1.webContents.scripts, [], "nothing came in");
  assert.deepEqual([w2.webContents.scripts.length, w3.webContents.scripts.length], [1, 1], "and nothing was dropped");
  assert.equal(m2.app.windows.length, 3);
  // the front window took nothing (it is full), or its answer is no list of indexes: the other windows keep their tabs and stay
  for (const answer of [[], 1, "all", [0, 0], [-1], null]) {
    const m3 = loadMain(t);
    const f1 = await started(m3);
    const f2 = newWindow(m3);
    f1.focused = true; f1.emit("focus");
    pageOf(f2, [["dump", undefined, one], ["drop", [0], 0]]);
    pageOf(f1, [["take", one, answer]]);
    windowItem(m3, "Merge All Windows").click();
    await tick(); await tick(); await tick(); await tick();
    assert.deepEqual(f2.webContents.scripts, [menu.windowScript("dump")], "nothing is dropped that was not taken: " + JSON.stringify(answer));
    assert.equal(f2.isDestroyed(), false);
  }
});

test("the tab commands and links go to the window in front; each window keeps its own page-loaded flag", async (t) => {
  const m = loadMain(t);
  const win = await started(m);
  const two = newWindow(m);
  win.webContents.answer = "done"; two.webContents.answer = "done";
  windowItem(m, "New Tab").click();
  await tick();
  assert.deepEqual([win.webContents.scripts.length, two.webContents.scripts.length], [0, 1]);
  win.focused = true; win.emit("focus"); two.focused = false;
  windowItem(m, "New Tab").click();
  await tick();
  assert.deepEqual([win.webContents.scripts.length, two.webContents.scripts.length], [1, 1]);
  // Cmd+W with one tab left in a window that is not the last one: the window closes for good
  two.focused = true; two.emit("focus"); win.focused = false;
  two.webContents.answer = (script) => (script === menu.tabScript("closeTab") ? "last" : script === menu.windowScript("leave") ? true : undefined);
  windowItem(m, "Close Tab").click();
  await until(() => two.isDestroyed(), "the window to close");
  assert.deepEqual(m.app.windows, [win]);
  assert.equal(win.isVisible(), true);
  // the server comes back: only the window whose page did not load is reloaded
  const m2 = loadMain(t);
  const w1 = await started(m2);
  const w2 = newWindow(m2);
  w1.webContents.emit("did-finish-load");                  // w2's page never loaded
  m2.electron.dialog.showMessageBox = async () => ({ response: 0 });     // "Restart"
  m2.servers[0].running = false;
  m2.servers[0].emit("exit", { code: 1, signal: null });
  await until(() => m2.servers.length === 2 && m2.servers[1].running, "the server to start again");
  await tick(); await tick();
  assert.deepEqual([w1.webContents.reloads, w2.webContents.reloads], [0, 1]);
});

test("a quit keeps the place of the window that was in front, for the one window of the next start", async (t) => {
  const m = loadMain(t);
  const win = await started(m);
  const two = newWindow(m), three = newWindow(m);
  win.getNormalBounds = () => ({ x: 10, y: 40, width: 900, height: 700 });
  two.getNormalBounds = () => ({ x: 300, y: 60, width: 1000, height: 720 });
  three.getNormalBounds = () => ({ x: 500, y: 80, width: 1100, height: 740 });
  two.focused = true; two.emit("focus");                   // the user works in the second window, then quits
  const file = path.join(m.dir, "user-data", "window-state.json");
  m.app.quit();
  await until(() => m.app.quitted, "the app to quit");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { x: 300, y: 60, width: 1000, height: 720, fullScreen: false });
  // without a quit, a window that closes for good or hides saves its place as before
  const m2 = loadMain(t);
  const w1 = await started(m2);
  const w2 = newWindow(m2);
  w2.getNormalBounds = () => ({ x: 320, y: 70, width: 950, height: 710 });
  pageOf(w2, [["leave", undefined, true]]);
  w2.close();
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(m2.dir, "user-data", "window-state.json"), "utf8")), { x: 320, y: 70, width: 950, height: 710, fullScreen: false });
  await until(() => w2.isDestroyed(), "the window to close");
  w1.getNormalBounds = () => ({ x: 15, y: 45, width: 905, height: 705 });
  w1.close();                                              // the last one: it hides
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(m2.dir, "user-data", "window-state.json"), "utf8")), { x: 15, y: 45, width: 905, height: 705, fullScreen: false });
});

test("a link, a reload and the Dock icon never go to a window that is destroyed, whenever its closed event comes", async (t) => {
  const m = loadMain(t);
  const win = await started(m);
  const two = newWindow(m);                                 // in front
  // the window in front is destroyed, and its "closed" has not come yet (main.js still names it as the window)
  two.destroyed = true;
  two.visible = false;
  two.webContents.destroyed = true;
  m.app.emit("open-url", event(), "marginalia://open?hash=%23reader%2Fabc%2Fp_1");
  assert.equal(lastLoad(win), ORIGIN + "/#reader/abc/p_1", "the link went to the window that is there");
  assert.equal(loads(two).length, 1);
  const view = m.electron.Menu.getApplicationMenu().items.find((x) => x.label === "View").submenu;
  view.find((x) => x.label === "Reload").click();
  assert.deepEqual([win.webContents.reloads, two.webContents.reloads], [1, 0]);
  win.hide();
  m.app.emit("activate", event(), false);                  // the Dock icon
  assert.equal(win.isVisible(), true);
  windowItem(m, "New Tab").click();
  await tick();
  assert.equal(two.webContents.scripts.length, 0, "no command goes to the window that is gone");
});

// ---- PDFs that macOS hands the app (DECISIONS D34) ---------------------------------------------------------------------
function pdfFiles(m) {
  const pdf = path.join(m.dir, "Paper (2024).pdf"), other = path.join(m.dir, "notes.txt");
  fs.writeFileSync(pdf, "%PDF-1.7\n" + "x".repeat(100));
  fs.writeFileSync(other, "not a pdf");
  return { pdf, other };
}

test("open-file before the app is ready waits for the window's page, which then gets the PDF's name and bytes", async (t) => {
  const m = loadMain(t);
  const { pdf } = pdfFiles(m);
  const ev = event();
  m.app.emit("open-file", ev, pdf);
  assert.equal(ev.defaultPrevented, true, "macOS is told the app took the file");
  const win = await started(m);
  assert.deepEqual(win.webContents.messages, [], "not before the page has loaded");
  win.webContents.emit("did-finish-load");
  assert.equal(win.webContents.messages.length, 1);
  const { channel, msg } = win.webContents.messages[0];
  assert.equal(channel, "marginalia:open-pdf");
  assert.deepEqual(Object.keys(msg).sort(), ["bytes", "name"], "the page never learns where the file is");
  assert.equal(msg.name, "Paper (2024).pdf");
  assert.equal(Buffer.from(msg.bytes).toString("latin1").slice(0, 8), "%PDF-1.7");
  win.webContents.emit("did-finish-load");
  assert.equal(win.webContents.messages.length, 1, "each PDF goes to the page once");
  // while the page loads another document, a PDF waits for it (the old page would lose it)
  win.webContents.loading = true;
  m.app.emit("open-file", event(), pdf);
  assert.equal(win.webContents.messages.length, 1);
  win.webContents.loading = false;
  win.webContents.emit("did-stop-loading");
  assert.equal(win.webContents.messages.length, 2);
});

test("open-file on a running app: the PDF goes to the window in front and shows it; a file that is no PDF is refused with a notice", async (t) => {
  const m = loadMain(t);
  const { pdf, other } = pdfFiles(m);
  const win = await started(m);
  win.webContents.emit("did-finish-load");
  win.close();                                          // closed (hidden) first: a PDF brings it back
  assert.equal(win.isVisible(), false);
  m.app.emit("open-file", event(), pdf);
  assert.equal(win.webContents.messages.length, 1);
  assert.equal(win.isVisible(), true);
  const shown = m.electron.dialogs.length;
  for (const bad of [other, path.join(m.dir, "missing.pdf"), m.dir, "relative.pdf"]) {
    m.app.emit("open-file", event(), bad);
  }
  assert.equal(win.webContents.messages.length, 1, "nothing that is no PDF reaches the page");
  assert.equal(m.electron.dialogs.length - shown, 4, "each refusal says so");
  assert.match(m.electron.dialogs[shown][1].message, /could not open “notes\.txt”/);
  assert.equal(m.app.windows.length, 1, "a PDF never opens a second window");
});
