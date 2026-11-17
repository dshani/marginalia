"use strict";
// Marginalia's main process: starts the app's own copy of tools/serve.py (with --app <version>: the app's server, which
// takes writes only from the app's own page), shows the web app in its windows from http://127.0.0.1:<port>/ (one at
// the start; more with Cmd+N or a tab moved out: DECISIONS D31), hides the last window when it is closed
// (lib/lifecycle.js CLOSE_HIDES) and stops the server when the app quits. Contract: FEATURES-E1
// (E1.2, E1.5), FEATURES-E2 (E2.3) and docs/BUILD-NOTES.md "Desktop app (binding)"; the small pure rules live in lib/ and
// are covered by node --test (test/main.test.js loads this file with Electron mocked).
const { app, BrowserWindow, Menu, dialog, nativeTheme, screen, session, shell } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const args = require("./lib/args");
const contextmenu = require("./lib/contextmenu");
const hashes = require("./lib/hash");
const lifecycle = require("./lib/lifecycle");
const menu = require("./lib/menu");
const policy = require("./lib/policy");
const python = require("./lib/python");
const selftest = require("./lib/selftest");
const server = require("./lib/server");
const windowState = require("./lib/windowstate");
const { RotatingLog } = require("./lib/rotatelog");

const BACKGROUND = { light: "#efece4", dark: "#1b1a18" };   // styles.css --bg in the light and dark themes
const SELF_TEST_TIMEOUT_MS = 150000;
const VERSION_ARG = "--marginalia-desktop-version=";
const CLOSE_HIDES = lifecycle.CLOSE_HIDES;      // the one switch: closing the window hides it (FEATURES E2.3 b)

// ---- output that must reach a pipe before the process ends (stdout to a pipe is asynchronous on macOS) -------
function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function writeSync(fd, text) {
  const buf = Buffer.from(text, "utf8");
  let off = 0, tries = 0;
  while (off < buf.length && tries < 500) {
    try { off += fs.writeSync(fd, buf, off); } catch (e) { if (e.code !== "EAGAIN") return; tries++; sleepSync(10); }
  }
}
function jsonLine(obj) { writeSync(1, JSON.stringify(obj) + "\n"); }

// ---- 1. flags, before anything reads the userData path ---------------------------------------------------------
const opts = args.parse(process.argv.slice(1));
const SELF_TEST = opts.selfTest;
if (SELF_TEST) {
  // The account's home folder from the user database, never $HOME (a caller can change $HOME; the guard then also
  // refuses to run, since serve.py and Chromium would take their default folders from it).
  let accountHome = null;
  try { accountHome = os.userInfo().homedir; } catch (e) { accountHome = null; }
  const problems = args.selfTestProblems(opts, { home: accountHome, envHome: process.env.HOME, fs });
  if (problems.length) {
    jsonLine({ selfTest: "marginalia-desktop", ok: false, refused: problems });
    process.exit(2);
  }
} else if (opts.errors.length) {
  writeSync(2, "Marginalia: " + opts.errors.join("; ") + "\n");
  process.exit(2);
}

// Marginalia keeps nothing in the keychain; the mock keychain means no keychain prompt after each rebuild.
app.commandLine.appendSwitch("use-mock-keychain");
app.enableSandbox();
if (SELF_TEST) {
  if (app.dock) app.dock.hide();
  app.setActivationPolicy("accessory");
}
const USER_DATA = opts.userDataDir || path.join(app.getPath("appData"), "Marginalia");
app.setPath("userData", USER_DATA);

const PORT = opts.port;
const ORIGIN = policy.appOrigin(PORT);
const WEB_DIR = app.isPackaged ? path.join(process.resourcesPath, "web") : path.join(__dirname, "build", "web");
const SERVE_SCRIPT = path.join(WEB_DIR, "tools", "serve.py");
const LOG_FILE = path.join(USER_DATA, "logs", "server.log");
const STATE_FILE = path.join(USER_DATA, "window-state.json");

// state.wins: every window of the app → {w: its id ("?w=<id>" of its page; null for the first), healthy: its page is
// loaded, healthBefore, closing}. state.win: the window that links, the Dock and the menus act on: the one in front,
// else the one that was in front last.
const MAX_WINDOWS = policy.MAX_WINDOWS;
const state = {
  log: null, python: null, server: null, serverReady: false, serverDown: false, win: null, wins: new Map(), merging: false,
  pendingHash: null, quitting: false, quitFront: null, stoppingForQuit: false, dialogOpen: false, crashed: false, saveTimer: null,
  tail: [], lastInputAt: 0,
  // self-test records
  requests: [], externalOpens: [], downloads: [], permissions: [], consoleErrors: [], contextMenus: [], handedOverHashes: [],
  coverRequests: [], windowEverShown: false, finished: false
};

function log(text) {
  if (state.log) state.log.line(text);
  else if (!SELF_TEST) writeSync(2, "Marginalia: " + text + "\n");
}

// What a URL is, for the log (never a note's text: an obsidian:// link carries the whole note).
function describe(url) {
  try { const u = new URL(url); return u.protocol === "http:" || u.protocol === "https:" ? u.origin + u.pathname : u.protocol + "…"; }
  catch (e) { return "(not a URL)"; }
}

// ---- single instance and marginalia:// links ---------------------------------------------------------------------
app.on("open-url", (event, url) => {
  event.preventDefault();
  openHash(hashes.hashFromOpenUrl(url));
});
if (opts.urls.length) state.pendingHash = hashes.hashFromOpenUrl(opts.urls[opts.urls.length - 1]);
app.whenReady().then(() => (acquireLock() ? start() : null)).catch(crash);

// One app per userData folder (set above): Electron's single-instance lock, taken once the app is ready. When another
// app holds it, that app receives this launch's arguments (a marginalia:// link) in "second-instance" and this one
// ends. (Launches from Finder, the Dock and marginalia:// links never get here: macOS keeps one instance per app and
// sends the link to the running one as "open-url".)
function acquireLock() {
  if (app.requestSingleInstanceLock()) {
    app.on("second-instance", (event, argv) => {
      const again = args.parse((argv || []).slice(1));
      log("a second launch handed over " + again.urls.length + " link(s)");
      if (again.urls.length) openHash(hashes.hashFromOpenUrl(again.urls[again.urls.length - 1]));
      if (SELF_TEST) return;
      showWindow();                                  // also the window closing hid, or a new one when there is none
      if (state.win) app.focus({ steal: true });
    });
    return true;
  }
  if (SELF_TEST) jsonLine({ selfTest: "marginalia-desktop", ok: false, refused: ["another Marginalia already runs with this --user-data-dir (it got this launch's arguments)"] });
  app.exit(SELF_TEST ? 2 : 0);
  return false;
}

function openHash(hash) {
  if (SELF_TEST) { state.handedOverHashes.push(hash); return; }   // the self-test takes it after its page checks
  goToHash(hash);
}

// The window goes to http://127.0.0.1:<port>/<hash> (on an open page only the hash changes: no reload), and comes to the
// front (also when closing it had hidden it). With no window at all (it was destroyed) a new one opens on that hash.
function goToHash(hash) {
  const win = theWindow();
  if (!win && state.serverReady && !state.serverDown && !state.quitting && !SELF_TEST) { state.pendingHash = hash; createWindow(); return; }
  if (!win || !state.serverReady || state.serverDown) { state.pendingHash = hash; return; }
  log("opening " + hash.split("/")[0]);
  win.loadURL(urlFor(win, hash)).catch((e) => log("could not open " + hash.split("/")[0] + ": " + (e && e.message)));
  focusWindow();
}

// ---- the windows (DECISIONS D31) ----------------------------------------------------------------------------------
function liveWindows() { return Array.from(state.wins.keys()).filter((w) => !w.isDestroyed()); }
// "The window" for links, the Dock icon and the menu: the one in front, else the one that was in front last (never
// one that is destroyed, whenever its "closed" event comes).
function theWindow() {
  if (state.win && !state.win.isDestroyed()) return state.win;
  const rest = liveWindows();
  state.win = rest.length ? rest[rest.length - 1] : null;
  return state.win;
}
function infoOf(win) { return win ? state.wins.get(win) || null : null; }
// How many windows the app has, without those that are on their way out.
function openCount() { return liveWindows().filter((w) => !(infoOf(w) || {}).closing).length; }
// A window's page: the first window's is the plain address; every other one carries its id, which never changes.
function urlFor(win, hash) {
  const info = infoOf(win);
  return ORIGIN + "/" + (info && info.w ? "?w=" + info.w : "") + (hash || "");
}
// Runs a script of lib/menu.js in a window's page. → a promise of its value (undefined when it cannot run).
function runIn(win, script) {
  if (!script || !win || win.isDestroyed()) return Promise.resolve(undefined);
  return Promise.resolve().then(() => win.webContents.executeJavaScript(script)).then((v) => v, () => undefined);
}
// With two or more windows macOS lists them in the Window menu (by their names); with one, Window › Marginalia shows
// it (also while closing it has hidden it), and macOS's own entry would list it a second time.
function syncWindowsMenu() {
  const all = liveWindows();
  for (const w of all) w.excludedFromShownWindowsMenu = all.length < 2;
}

// Shows the main window (hidden by a close, or minimized) and brings it to the front: the Dock icon, a second launch,
// a marginalia:// link and Window › Marginalia. Never in self-test mode (its window is never shown).
function focusWindow() {
  const w = theWindow();
  if (!w || SELF_TEST) return;
  if (w.isMinimized()) w.restore();
  if (!w.isVisible()) w.show();
  w.focus();
}

// ---- external links ---------------------------------------------------------------------------------------------
// The only door out of the app. It opens a web page or an obsidian:/mailto: link only within USER_ACTIVATION_MS of the
// user's own click or key press in the window, one per input (as Brave, which lets a page open a tab or an app link only
// then), so page script alone opens nothing. In self-test mode it is a recorder and nothing ever opens.
function openOutside(url, why) {
  const kind = policy.classify(url, ORIGIN);
  if (kind !== "web" && kind !== "external") { log("refused to open " + describe(url) + " (" + why + ")"); return; }
  const now = Date.now();
  if (!policy.userActivated(state.lastInputAt, now)) {
    if (SELF_TEST) state.externalOpens.push({ url, opened: false });
    log("refused to open " + describe(url) + " (" + why + "): no click or key press just before");
    return;
  }
  state.lastInputAt = 0;     // one outside open per click or key press
  if (SELF_TEST) { state.externalOpens.push({ url, opened: true }); return; }
  log("opening outside the app: " + describe(url) + " (" + why + ")");
  shell.openExternal(url).catch((e) => log("could not open " + describe(url) + ": " + (e && e.message)));
}

function guardContents(contents) {
  contents.on("will-navigate", (event) => {
    const a = policy.navigation(event.url, ORIGIN);
    if (a.allow) {
      // a window never takes another window's id (its tabs are stored under it): the page stays this window's
      const win = liveWindows().find((w) => w.webContents === contents), info = infoOf(win);
      if (info && policy.windowOf(event.url, ORIGIN) !== (info.w || null) && (info.w || policy.windowOf(event.url, ORIGIN))) {
        event.preventDefault();
        win.loadURL(urlFor(win, hashOfUrl(event.url))).catch(() => { /* did-fail-load reports it */ });
      }
      return;
    }
    event.preventDefault();
    if (a.openExternal) openOutside(event.url, "link");
    else log("refused navigation to " + describe(event.url));
  });
  contents.on("will-frame-navigate", (event) => {
    if (event.isMainFrame) return;                       // will-navigate handles the main frame
    if (!policy.navigation(event.url, ORIGIN).allow) { event.preventDefault(); log("refused frame navigation to " + describe(event.url)); }
  });
  contents.on("will-redirect", (event) => {
    if (policy.navigation(event.url, ORIGIN).allow) return;
    event.preventDefault();
    log("refused redirect to " + describe(event.url));
  });
  contents.on("will-attach-webview", (event) => event.preventDefault());
  contents.on("select-bluetooth-device", (event, devices, callback) => { event.preventDefault(); callback(""); });
  contents.setWindowOpenHandler((details) => {
    const a = policy.windowOpen(details.url, ORIGIN);
    const from = liveWindows().find((w) => w.webContents === contents) || null;
    // D31: the page asks for a window of the app ("?w=<id>": a tab that moves out). main.js makes it; Electron never does.
    if (a.window && from) openAppWindow(a.window, details.features, from);
    else if (a.load && from) from.loadURL(infoOf(from).w ? urlFor(from, hashOfUrl(details.url)) : details.url);
    else if (a.openExternal) openOutside(details.url, "new window");
    else log("refused new window for " + describe(details.url));
    return { action: "deny" };
  });
}

// The web app's route in a URL of the app's page ("" when it has none that the web app knows).
function hashOfUrl(url) {
  try { const h = new URL(url).hash; return h ? hashes.validHash(h) || "" : ""; } catch (e) { return ""; }
}
app.on("web-contents-created", (event, contents) => guardContents(contents));

// ---- session: permissions, devices, downloads, the self-test's request recorder -----------------------------
// The device choosers are cancelled and device permissions refused in every session the app makes.
function refuseDevices(ses) {
  ses.setDevicePermissionHandler(() => false);
  ses.on("select-hid-device", (event, details, callback) => { event.preventDefault(); callback(null); });
  ses.on("select-serial-port", (event, ports, wc, callback) => { event.preventDefault(); callback(""); });
  ses.on("select-usb-device", (event, details, callback) => { event.preventDefault(); callback(); });
}

function setupSession() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const requesting = (details && details.requestingUrl) || (wc && !wc.isDestroyed() ? wc.getURL() : "");
    const granted = policy.permissionAllowed(permission, requesting, ORIGIN);
    if (SELF_TEST) state.permissions.push({ permission, granted });
    if (!granted) log("denied the permission " + permission);
    callback(granted);
  });
  ses.setPermissionCheckHandler((wc, permission, requestingOrigin) => policy.permissionAllowed(permission, requestingOrigin, ORIGIN));
  refuseDevices(ses);
  ses.on("will-download", onWillDownload);
  // One request listener (a session keeps only one): it cancels PDF.js's cMap requests to cdnjs (lib/policy.js
  // blockedRequest) and, in self-test mode, records every request.
  const onRequest = (details, callback) => {
    const blocked = policy.blockedRequest(details.url);
    if (SELF_TEST) state.requests.push({ url: details.url, method: details.method, type: details.resourceType, blocked });
    if (blocked) log("cancelled a request for " + describe(details.url) + " (cdnjs refuses PDF.js's character maps)");
    callback(blocked ? { cancel: true } : {});
  };
  if (SELF_TEST) ses.webRequest.onBeforeRequest(onRequest);
  else ses.webRequest.onBeforeRequest({ urls: ["https://cdnjs.cloudflare.com/ajax/libs/pdf.js/*"] }, onRequest);
}

// Exports and other downloads ask where to save, starting in the Downloads folder (Electron's save dialog). The
// self-test sets the same dialog options, then saves without a dialog and reads the options back.
function onWillDownload(event, item) {
  const name = path.basename(item.getFilename() || "") || "download";
  item.setSaveDialogOptions({ title: "Save", defaultPath: path.join(app.getPath("downloads"), name) });
  if (SELF_TEST) {
    const dir = path.join(USER_DATA, "self-test-downloads");
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, name);
    item.setSavePath(dest);
    const dialogOptions = item.getSaveDialogOptions() || {};
    const rec = { name, dialogDefaultPath: dialogOptions.defaultPath || null, state: "progressing", content: null };
    state.downloads.push(rec);
    item.once("done", (e, st) => { rec.state = st; try { rec.content = fs.readFileSync(dest, "utf8"); } catch (err) { rec.content = null; } });
  }
}

// ---- menu ---------------------------------------------------------------------------------------------------------
function setupMenu() {
  const wc = () => (state.win && !state.win.isDestroyed() ? state.win.webContents : null);
  const zoom = (f) => { const c = wc(); if (c) c.setZoomLevel(f(c.getZoomLevel())); };
  Menu.setApplicationMenu(Menu.buildFromTemplate(menu.buildTemplate({
    reload: () => reloadPage(false),
    forceReload: () => reloadPage(true),
    resetZoom: () => zoom(() => 0),
    zoomIn: () => zoom((z) => Math.min(z + 0.5, 9)),
    zoomOut: () => zoom((z) => Math.max(z - 0.5, -8)),
    showWindow: () => showWindow(),
    // DECISIONS D30: New Tab, Close Tab, Reopen Closed Tab, Show Next Tab, Show Previous Tab
    ...Object.fromEntries(menu.TAB_COMMANDS.map((id) => [id, () => { tabCommand(id); }])),
    // DECISIONS D31: New Window, Move Tab to New Window, Merge All Windows
    newWindow: () => { newWindow(); },
    moveTab: () => { moveTabToWindow(); },
    mergeWindows: () => { mergeWindows(); }
  })));
  app.setAboutPanelOptions({
    applicationName: "Marginalia",
    applicationVersion: app.getVersion(),
    version: "Electron " + process.versions.electron,
    credits: "A PDF reader for writing spaced-repetition prompts in the margins."
  });
}

// ---- tabs (DECISIONS D30) -------------------------------------------------------------------------------------------
// A tab command runs in the main window's page: lib/menu.js tabScript(id) calls the web app's own M.tabs.run(id). No ipc
// channel. → a promise of the page's answer (lib/menu.js TAB_ANSWERS): "done", "last", "blocked", or "none" for a
// page that is not the web app (it did not load: the script itself finds no window.Marginalia.tabs there), an error
// or no window. It asks the page each time and trusts no flag of the main process: the tabs need no server, so they
// work while it is down.
function runTab(id) {
  const script = menu.tabScript(id);
  const w = state.win;
  if (!script || !w || w.isDestroyed()) return Promise.resolve("none");
  return Promise.resolve().then(() => w.webContents.executeJavaScript(script)).then((v) => menu.tabAnswer(v), () => "none");
}

// One tab command of the Window menu; lib/lifecycle.js tabAction says what it does in the state the windows are in.
// → a promise of true when the page ran it.
function tabCommand(id) {
  const w = state.win && !state.win.isDestroyed() ? state.win : null;
  const action = lifecycle.tabAction(id, { front: !!w && w.isFocused(), window: !!w, quitting: state.quitting });
  if (action === "none") return Promise.resolve(false);
  if (action === "show") { showWindow(); return Promise.resolve(false); }
  if (action === "close-front") { Menu.sendActionToFirstResponder("performClose:"); return Promise.resolve(false); }
  if (action === "show-and-run") focusWindow();
  return runTab(id).then((answer) => {
    // Close Tab with one tab left (or on a page that did not load): the window closes, which hides it (CLOSE_HIDES).
    // (Close Tab gets here only with the main window in front: tabAction.)
    if (lifecycle.closesWindow(id, answer) && state.win === w && !w.isDestroyed() && !state.quitting) w.close();
    return answer === "done";
  });
}

// ---- windows (DECISIONS D31) ------------------------------------------------------------------------------------------
function newWindowId() { return crypto.randomBytes(5).toString("hex"); }      // 10 of 0–9 and a–f

// A window for the page "?w=<id>": asked by a page (a tab that moves out: window.open) or by Window › New Window.
// → the window, or null (refused: MAX_WINDOWS are open, the id is in use, the server is not there, the app quits).
// `throttled` (the self-test): this window's page is slowed down as the page of a window in the background is.
function openAppWindow(id, features, from, throttled) {
  if (!state.serverReady || state.serverDown || state.quitting) return null;
  const all = liveWindows();
  if (all.length >= MAX_WINDOWS) { log("refused a new window: " + MAX_WINDOWS + " are open"); return null; }
  if (all.some((w) => (infoOf(w) || {}).w === id)) { log("refused a new window: that window is open already"); return null; }
  return createWindow({ w: id, bounds: policy.windowFeatures(features), from, throttled: throttled === true });
}

// Window › New Window (Cmd+N). The window that closing hid comes back first; with no window at all one opens.
function newWindow() {
  if (SELF_TEST || state.quitting) return null;
  const all = liveWindows();
  if (!all.length || !all.some((w) => w.isVisible())) { showWindow(); return null; }
  return openAppWindow(newWindowId(), null, state.win);
}

// Window › Move Tab to New Window: the page of the window in front does it (js/tabs.js moveToWindow; it asks for the
// new window with window.open). → a promise of true when a tab moved.
function moveTabToWindow() {
  const w = state.win && !state.win.isDestroyed() ? state.win : null;
  if (!w || !w.isFocused() || state.quitting) return Promise.resolve(false);
  return runIn(w, menu.windowScript("moveTab")).then((v) => v === true);
}

// Window › Merge All Windows: the tabs of every other window come into the window in front, as far as it has room;
// a window that gave all its tabs closes. Each step is a script of lib/menu.js in a page (no ipc channel): the other
// window says which tabs it has ("dump"; nothing while a review or a dialog is on screen there), the window in front
// says which of them came in ("take"), and the other window lets exactly those go ("drop"). So a tab that found no
// room, or that the window in front does not know, stays where it was.
// → a promise of how many tabs moved.
async function mergeWindows() {
  const front = state.win && !state.win.isDestroyed() ? state.win : null;
  if (!front || state.merging || state.quitting) return 0;
  state.merging = true;
  let moved = 0;
  try {
    for (const other of liveWindows()) {
      if (other === front || other.isDestroyed() || (infoOf(other) || {}).closing) continue;
      const take = menu.windowScript("take", await runIn(other, menu.windowScript("dump")));
      if (!take) continue;
      const took = menu.takenIndexes(await runIn(front, take));
      if (!took.length) continue;
      moved += took.length;
      const left = await runIn(other, menu.windowScript("drop", took));
      if (left === 0 && !other.isDestroyed()) { const info = infoOf(other); if (info) info.closing = true; other.destroy(); }
    }
  } finally { state.merging = false; }
  return moved;
}

// A window that is not the last one closes for good (lib/lifecycle.js "close-window"): its page forgets its list of
// tabs first (else they would come back at the next start) and stores a place it held back, then the window goes.
// For that place the page may have taken the writer role: the window in front takes it back, so the next key or
// click there is not lost.
function closeForGood(win) {
  const info = infoOf(win);
  if (!info || info.closing) return;
  info.closing = true;
  let ended = false;
  const done = () => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    if (!win.isDestroyed()) win.destroy();
    const rest = liveWindows().filter((w) => w !== win);
    const front = state.win && state.win !== win && !state.win.isDestroyed() ? state.win : rest.length ? rest[rest.length - 1] : null;
    if (front && !state.quitting) runIn(front, menu.windowScript("role"));
  };
  const timer = setTimeout(done, 1500);
  runIn(win, menu.windowScript("leave")).then(done, done);
}

function reloadPage(ignoreCache) {
  const w = theWindow();
  if (!w) return;
  if (state.serverDown) { showServerStopped(); return; }
  if (ignoreCache) w.webContents.reloadIgnoringCache(); else w.webContents.reload();
}

// ---- the server -----------------------------------------------------------------------------------------------
function serverLog() {
  return {
    write(chunk) {
      if (state.log) state.log.write(chunk);
      const lines = String(chunk).split("\n").filter((l) => l.trim());
      state.tail = state.tail.concat(lines).slice(-12);
    },
    line(text) { log(text); }
  };
}

class SelfTestFailure extends Error {}

async function startServer() {
  for (;;) {
    const status = await server.probePort(PORT);
    if (status !== "free") {
      log("port " + PORT + " is in use (" + status + ")");
      if (SELF_TEST) throw new SelfTestFailure("port " + PORT + " is in use (" + status + ")");
      if ((await portInUseDialog(status)) !== "retry") { app.quit(); return false; }
      continue;
    }
    state.tail = [];
    // --app <version> (FEATURES E2.3 a): the app's server, which answers GET /api/app and takes POSTs only from the
    // app's own page (X-Marginalia-Client: app); the version is desktop/package.json's (the build checks its form)
    const srv = new server.ServerProcess({ python: state.python, serveScript: SERVE_SCRIPT, webDir: WEB_DIR, port: PORT,
      appVersion: app.getVersion(), obsidianSandbox: opts.obsidianSandbox, obsidianConfig: opts.obsidianConfig, backupDir: opts.backupDir,
      env: process.env, log: serverLog() });
    state.server = srv;
    state.serverReady = false;
    srv.on("exit", (info) => { if (state.server === srv) onServerExit(srv, info); });
    srv.start();
    if (await srv.waitUntilReady()) {
      srv.ready = true;
      state.serverReady = true;
      state.serverDown = false;
      log("server ready on " + ORIGIN + "/ with " + state.python);
      return true;
    }
    await srv.stop();
    if ((await server.probePort(PORT)) !== "free") continue;      // someone else took the port meanwhile
    const why = state.tail.slice(-6).join("\n") || "no output";
    if (SELF_TEST) throw new SelfTestFailure("the server did not start: " + why);
    if ((await serverFailedDialog(why)) !== "retry") { app.quit(); return false; }
  }
}

function onServerExit(srv, info) {
  if (!srv.ready || srv.stopping || state.quitting) return;
  state.serverReady = false;
  state.serverDown = true;
  if (SELF_TEST) { finishSelfTest(null, "the server stopped while the self-test ran (" + JSON.stringify(info) + ")"); return; }
  showServerStopped();
}

async function showServerStopped() {
  if (state.dialogOpen || state.quitting) return;
  state.dialogOpen = true;
  let choice;
  try {
    const { response } = await dialog.showMessageBox(state.win || undefined, {
      type: "warning",
      message: "Marginalia’s server stopped",
      detail: "The page stays open, but sending notes to Obsidian and the daily backup need the server.\n\n" +
        (state.tail.length ? "Its last output:\n" + state.tail.slice(-4).join("\n") + "\n\n" : "") + "Log: " + LOG_FILE,
      buttons: ["Restart", "Quit"], defaultId: 0, cancelId: 1, noLink: true
    });
    choice = response;
  } finally { state.dialogOpen = false; }
  if (choice !== 0) { app.quit(); return; }
  if (!(await startServer())) return;
  if (state.pendingHash && state.win) { const h = state.pendingHash; state.pendingHash = null; openHash(h); return; }
  for (const w of liveWindows()) {                        // only now that the server answers again
    const info = infoOf(w);
    if (info && !info.healthy) w.webContents.reload();
  }
}

async function portInUseDialog(status) {
  const ours = status === "marginalia";
  const { response } = await dialog.showMessageBox({
    type: "warning",
    message: ours ? "Marginalia is already running on port " + PORT : "Port " + PORT + " is in use",
    detail: ours
      ? "A Marginalia server already answers at http://127.0.0.1:" + PORT + "/, probably the one the marginalia command " +
        "started. The app needs that address for its own server.\n\nTo stop it, run this in Terminal:\n    marginalia stop\n" +
        "then click Try again. Marginalia never stops a program it did not start."
      : "Another program is using port " + PORT + " on this Mac, so Marginalia cannot start its server there.\n\n" +
        "To see which program it is, run this in Terminal:\n    lsof -nP -iTCP:" + PORT + " -sTCP:LISTEN\n" +
        "Quit it, then click Try again. Marginalia never stops a program it did not start.",
    buttons: ["Try again", "Quit"], defaultId: 0, cancelId: 1, noLink: true
  });
  return response === 0 ? "retry" : "quit";
}

async function serverFailedDialog(why) {
  const { response } = await dialog.showMessageBox({
    type: "error",
    message: "Marginalia’s server could not start",
    detail: why + "\n\nLog: " + LOG_FILE,
    buttons: ["Try again", "Quit"], defaultId: 0, cancelId: 1, noLink: true
  });
  return response === 0 ? "retry" : "quit";
}

// ---- the window ---------------------------------------------------------------------------------------------------
function backgroundColor() {
  return nativeTheme.shouldUseDarkColors ? BACKGROUND.dark : BACKGROUND.light;
}

function readWindowState() {
  try { return windowState.parseSaved(fs.readFileSync(STATE_FILE, "utf8")); } catch (e) { return null; }
}

function saveWindowState(win) {
  const w = win || state.win;
  if (SELF_TEST || !w || w.isDestroyed()) return;
  const snap = windowState.snapshot(w.getNormalBounds(), w.isFullScreen());
  if (!snap) return;
  try {
    const tmp = STATE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(snap), { mode: 0o600 });
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) { log("could not save the window state: " + e.message); }
}

function scheduleSave(win) {
  if (SELF_TEST) return;
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => saveWindowState(win), 800);
}

// Where a new window (not the first) goes: where window.open asked (a tab dropped there), else set off from the
// window it came from; as large as that window unless a size was asked. lib/windowstate.js makes it fit a screen.
function placeFor(o) {
  const from = o.from && !o.from.isDestroyed() ? o.from : null;
  let base = null;
  try { base = from ? from.getNormalBounds() : null; } catch (e) { base = null; }
  const asked = o.bounds || {};
  const n = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const out = { width: n(asked.width) !== null ? asked.width : base ? base.width : undefined,
    height: n(asked.height) !== null ? asked.height : base ? base.height : undefined };
  if (n(asked.x) !== null && n(asked.y) !== null) { out.x = asked.x; out.y = asked.y; }
  else if (base) { out.x = base.x + 28; out.y = base.y + 28; }
  return out;
}

// createWindow(): the first window (its place from window-state.json). createWindow({w, bounds, from}): a window for
// the page "?w=<w>" (DECISIONS D31).
function createWindow(o) {
  const extra = o && o.w ? o : null;
  const displays = screen.getAllDisplays().map((d) => d.workArea);
  const ws = windowState.sanitize(extra ? placeFor(extra) : readWindowState(), displays, screen.getPrimaryDisplay().workArea);
  if (extra) ws.fullScreen = false;
  const win = new BrowserWindow({
    title: "Marginalia",
    x: ws.x, y: ws.y, width: ws.width, height: ws.height,
    minWidth: windowState.MIN_SIZE.width, minHeight: windowState.MIN_SIZE.height,
    // A window that the user just asked for (Cmd+N, a tab that was dragged out) is on screen at once, in the page's
    // own background colour; its page follows. The first window shows when its page has painted (no empty window at
    // the app's start). The self-test never shows a window.
    show: !!extra && !SELF_TEST,
    backgroundColor: backgroundColor(),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      safeDialogs: true,
      // The self-test's pages are never shown: Chromium would slow their timers down. The self-test's second window
      // keeps that (`throttled`), so the hand-over of the writer role is tried with a page in the background too.
      backgroundThrottling: !SELF_TEST || !!(extra && extra.throttled),
      additionalArguments: [VERSION_ARG + app.getVersion()]
    }
  });
  const info = { w: extra ? extra.w : null, healthy: false, healthBefore: null, closing: false };
  state.wins.set(win, info);
  state.win = win;
  // (a window that was made visible gives no "show" event to listen for: the self-test's "hidden" check counts it here)
  if (win.isVisible()) state.windowEverShown = true;
  const wc = win.webContents;
  // Window › Marginalia (lib/menu.js) lists and shows the one window, also while closing it has hidden it; macOS's own
  // entry for it would list it a second time. With more windows macOS lists them all (syncWindowsMenu).
  syncWindowsMenu();
  // The page names its window after the tab on screen ("Griffiths — Marginalia", js/tabs.js; D31): the title bar and
  // the Window menu show it.
  win.on("focus", () => { state.win = win; });
  win.on("show", () => { state.windowEverShown = true; });
  win.once("ready-to-show", () => {
    if (SELF_TEST) return;
    if (!win.isVisible()) win.show();
    if (ws.fullScreen) win.setFullScreen(true);
  });
  for (const ev of ["resize", "move", "enter-full-screen", "leave-full-screen"]) win.on(ev, () => scheduleSave(win));
  win.on("close", (event) => {
    clearTimeout(state.saveTimer);
    // window-state.json has one entry. A quit closes every window: the entry is then the window that was in front, so
    // the one window of the next start opens where the user worked last.
    if (!state.quitting || !state.quitFront || win === state.quitFront) saveWindowState(win);
    const action = lifecycle.closeAction({ closeHides: CLOSE_HIDES, quitting: state.quitting, fullScreen: win.isFullScreen(), windows: openCount() });
    if (action === "close") return;
    event.preventDefault();                        // the app and its server keep running; Cmd+Q quits
    if (info.closing) return;                      // it is on its way out already (closeForGood waits for its page)
    if (action === "close-window") { closeForGood(win); return; }   // not the last window: it goes, with its tabs
    hideWindow(win, action === "leave-full-screen");
  });
  win.on("closed", () => {
    state.wins.delete(win);
    if (state.win === win) { const rest = liveWindows(); state.win = rest.length ? rest[rest.length - 1] : null; }
    syncWindowsMenu();
  });
  // pageHealthy: the web app's page is loaded (onServerBack reloads a page that is not). A navigation that starts
  // puts it in doubt; one that is refused or given up (a link to another site, which opens in the browser: Chromium
  // reports ERR_ABORTED, -3) leaves the page that was there, so the flag goes back to what it was. Found with D30:
  // before, one refused link left the flag false for good.
  wc.on("did-start-navigation", (event) => {
    if (!event.isMainFrame || event.isSameDocument) return;
    if (info.healthBefore === null) info.healthBefore = info.healthy;   // of the page that is there (the first of a series)
    info.healthy = false;
  });
  wc.on("did-fail-provisional-load", (event, code, description, url, isMainFrame) => {
    if (isMainFrame && code === -3 && info.healthBefore !== null) { info.healthy = info.healthBefore; info.healthBefore = null; }
  });
  wc.on("did-finish-load", () => { info.healthy = true; info.healthBefore = null; });
  wc.on("did-fail-load", (event, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;             // -3: aborted by a newer navigation
    info.healthy = false;
    info.healthBefore = null;
    log("the page did not load (" + code + " " + description + ")");
  });
  wc.on("render-process-gone", (event, details) => onRendererGone(win, details));
  wc.on("context-menu", (event, params) => showContextMenu(win, params));
  // The user's own clicks and key presses in this window (not in Developer Tools) let one outside open through.
  wc.on("input-event", (event, input) => { if (policy.activatesUser(input && input.type)) state.lastInputAt = Date.now(); });
  if (SELF_TEST) {
    wc.on("console-message", (event) => {
      if (event.level === "error") state.consoleErrors.push(String(event.message).slice(0, 300));
    });
  }
  const hash = extra ? "" : state.pendingHash || "";
  if (!extra) state.pendingHash = null;
  win.loadURL(urlFor(win, hash)).catch(() => { /* did-fail-load reports it */ });
  return win;
}

// Closing the window hides it (lib/lifecycle.js). A window in full screen leaves full screen first, then hides: hidden
// in full screen it would leave its empty Space behind.
function hideWindow(win, leaveFullScreen) {
  if (win.isDestroyed()) return;
  if (!leaveFullScreen) { win.hide(); return; }
  win.once("leave-full-screen", () => { if (!win.isDestroyed() && !state.quitting) win.hide(); });
  win.setFullScreen(false);
}

// Window › Marginalia, the Dock icon: the window that was in front last (a new one when there is none and the server
// answers).
function showWindow() {
  if (SELF_TEST || state.quitting) return;
  if (!state.win || state.win.isDestroyed()) { const rest = liveWindows(); state.win = rest.length ? rest[rest.length - 1] : null; }
  if (state.win) { focusWindow(); return; }
  if (state.serverReady && !state.serverDown) createWindow();
}

// The right-click menu (lib/contextmenu.js); in self-test mode it is recorded, never shown.
function showContextMenu(win, params) {
  if (win.isDestroyed()) return;
  const wc = win.webContents;
  const template = contextmenu.buildTemplate(params, {
    replaceMisspelling: (word) => wc.replaceMisspelling(word),
    addToDictionary: (word) => wc.session.addWordToSpellCheckerDictionary(word),
    lookUp: () => wc.showDefinitionForSelection(),
    copyImage: (x, y) => wc.copyImageAt(x, y)
  });
  if (SELF_TEST) { state.contextMenus.push({ x: params.x, y: params.y, mediaType: params.mediaType, labels: contextmenu.labels(template) }); return; }
  if (!template.length) return;
  Menu.buildFromTemplate(template).popup({ window: win });
}

async function onRendererGone(win, details) {
  log("the page stopped (" + (details && details.reason) + ")");
  if (SELF_TEST) { finishSelfTest(null, "the page process stopped: " + (details && details.reason)); return; }
  if (!win || win.isDestroyed() || (infoOf(win) || {}).closing || state.quitting || (details && details.reason === "clean-exit")) return;
  const { response } = await dialog.showMessageBox(win, {
    type: "error", message: "Marginalia’s window stopped working",
    detail: "Reload it to go on (" + (details && details.reason) + ").", buttons: ["Reload", "Quit"],
    defaultId: 0, cancelId: 1, noLink: true
  });
  if (response !== 0) { app.quit(); return; }
  if (win.isDestroyed()) return;
  if (state.serverDown) showServerStopped(); else win.webContents.reload();
}

// ---- start ----------------------------------------------------------------------------------------------------------
async function start() {
  if (SELF_TEST) {
    setTimeout(() => finishSelfTest(null, "timed out after " + SELF_TEST_TIMEOUT_MS / 1000 + " s"), SELF_TEST_TIMEOUT_MS).unref();
    if (app.dock) app.dock.hide();
  }
  state.log = new RotatingLog(LOG_FILE);
  log("Marginalia " + app.getVersion() + " (Electron " + process.versions.electron + ") starting" + (SELF_TEST ? " in self-test mode" : "") +
    "; userData " + USER_DATA + "; port " + PORT);
  if (opts.ignored.length) log("ignored arguments: " + opts.ignored.length);
  setupSession();
  setupMenu();
  nativeTheme.on("updated", () => { for (const w of liveWindows()) w.setBackgroundColor(backgroundColor()); });
  const found = await python.findPython({ serveScript: SERVE_SCRIPT });
  for (const t of found.tried) log("python " + t.path + ": " + (t.ok ? "ok" : t.reason));
  if (!found.python) {
    if (SELF_TEST) throw new SelfTestFailure("no python3 runs serve.py: " + JSON.stringify(found.tried));
    await dialog.showMessageBox({ type: "error", message: "Marginalia needs Python 3", detail: python.INSTALL_HELP,
      buttons: ["Quit"], defaultId: 0, noLink: true });
    app.quit();
    return;
  }
  state.python = found.python;
  if (!(await startServer())) return;
  const win = createWindow();
  if (SELF_TEST) await runSelfTest(win);
}

// The Dock icon (and opening the app again from Finder, Spotlight or the marginalia command) shows the window that
// closing hid, or opens one when there is none.
app.on("activate", () => showWindow());

// ---- quitting: the server stops with the app ---------------------------------------------------------------------
// Cmd+Q, the app menu's Quit, logging out and restarting the Mac: before-quit (Electron sends it before it closes the
// windows), so the window's close goes through instead of hiding it, then will-quit stops the server. With CLOSE_HIDES the
// last window closing does not quit the app (Electron sends window-all-closed only when it is not quitting anyway).
app.on("window-all-closed", () => { if (lifecycle.quitWhenAllClosed(CLOSE_HIDES)) app.quit(); });
app.on("before-quit", () => { state.quitting = true; state.quitFront = theWindow(); });
app.on("will-quit", (event) => {
  const srv = state.server;
  if (!srv || !srv.running) { if (state.log) state.log.close(); return; }
  event.preventDefault();
  if (state.stoppingForQuit) return;
  state.stoppingForQuit = true;
  srv.stop().catch(() => null).then(() => app.quit());
});
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(sig, () => { log("received " + sig); state.quitting = true; app.quit(); });
}
process.on("uncaughtException", (err) => crash(err));
process.on("unhandledRejection", (err) => log("unhandled rejection: " + (err && err.stack ? err.stack : String(err))));

function crash(err) {
  if (err instanceof SelfTestFailure) { finishSelfTest(null, err.message); return; }
  if (state.crashed) return;
  state.crashed = true;
  state.quitting = true;
  const msg = err && err.stack ? err.stack : String(err);
  log("unexpected error: " + msg);
  if (SELF_TEST) { finishSelfTest(null, "main process error: " + String(err && err.message || err)); return; }
  try {
    dialog.showErrorBox("Marginalia hit an unexpected error", "Marginalia is closing. The log is in " + LOG_FILE + "\n\n" + String(err && err.message || err));
  } catch (e) { /* no dialog before ready */ }
  setTimeout(() => app.exit(1), 9000).unref();
  const srv = state.server;
  Promise.resolve(srv && srv.running ? srv.stop() : null).catch(() => null).then(() => app.exit(1));
}

// ---- self-test ----------------------------------------------------------------------------------------------------
function displayPath(p) {
  const home = os.homedir();
  const n = path.normalize(p);
  if (n === home) return "~";
  return n.startsWith(home + path.sep) ? "~" + n.slice(home.length) : n;
}

function waitForLoad(win) {
  return new Promise((resolve, reject) => {
    const wc = win.webContents;
    const ok = () => { cleanup(); resolve(); };
    const fail = (e, code, desc, url, isMainFrame) => { if (isMainFrame && code !== -3) { cleanup(); reject(new SelfTestFailure("the page did not load: " + code + " " + desc)); } };
    const cleanup = () => { wc.removeListener("did-finish-load", ok); wc.removeListener("did-fail-load", fail); };
    wc.on("did-finish-load", ok);
    wc.on("did-fail-load", fail);
  });
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// The page checks run in two phases (lib/selftest.js): "start" (boot, app mode, the welcome card of the empty library,
// the refused POSTs, test/sample.pdf as PDF.js reads it), then, once the main process has put the prepared backup into
// the throwaway backup folder, "import" (the welcome card's import, the PDF restore, the reader, and part 1's checks).
async function runSelfTest(win) {
  await waitForLoad(win);
  const wc = win.webContents;
  const start = await wc.executeJavaScript(selftest.pageScript("start"), true);
  const folders = { afterRefusals: folderSnapshot() };       // the POSTs the server refused wrote nothing
  const prepared = prepareBackup(start && start.sample);
  const imported = prepared.ok ? await wc.executeJavaScript(selftest.pageScript("import", { expect: prepared.expect }), true)
    : { errors: ["the prepared backup was not written: " + prepared.error] };
  for (let i = 0; i < 50 && state.downloads.some((d) => d.state === "progressing"); i++) await delay(100);
  const raw = selftest.mergeRaw(start, imported);
  const extra = { contextMenus: await probeContextMenus(wc, raw && raw.targets), prepared, folders };
  await probeOpenAfterInput(wc);
  extra.handoff = await probeHandoff(wc);
  extra.tabs = await probeTabs(wc);
  extra.windows = await probeWindows(win);
  extra.appApi = await probeAppApi();
  extra.cover = await probeCover();
  extra.close = await probeClose(win);
  await delay(300);
  finishSelfTest(raw, null, extra);
}

// The backup folder and the sandbox vault as they are: {backupFiles: [names] (none: the folder is not there), vaultNotes:
// the number of .md files anywhere in the sandbox}.
function folderSnapshot() {
  let backupFiles = [];
  try { backupFiles = fs.readdirSync(opts.backupDir).sort(); } catch (e) { backupFiles = []; }
  let vaultNotes = 0;
  const walk = (dir, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      if (e.isDirectory() && depth < 8) walk(path.join(dir, e.name), depth + 1);
      else if (e.isFile() && e.name.endsWith(".md")) vaultNotes++;
    }
  };
  walk(opts.obsidianSandbox, 0);
  return { backupFiles, vaultNotes };
}

// FEATURES E2.3 g: a backup as Brave's cover writes it (lib/selftest.js preparedBackup: one book = the web copy's
// test/sample.pdf in one folder, two prompts) and that book's PDF as PDFs/<name> [<sha12>].pdf, written into the
// throwaway --backup-dir (the self-test guard keeps it out of every real folder), each file new (never over another).
// → {ok, name, pdfName, expect} | {ok: false, error}
function prepareBackup(sample) {
  try {
    if (!sample || typeof sample.fingerprint !== "string" || !sample.fingerprint || !(sample.numPages >= 1)) {
      throw new Error("the page could not read " + selftest.SAMPLE_PDF + " with PDF.js");
    }
    const pdf = fs.readFileSync(path.join(WEB_DIR, ...selftest.SAMPLE_PDF.split("/")));
    const sha256 = crypto.createHash("sha256").update(pdf).digest("hex");
    if (sample.sha256 !== sha256 || sample.byteLength !== pdf.length) throw new Error("the page read another " + selftest.SAMPLE_PDF + " than the web copy holds");
    const p = selftest.preparedBackup({ now: Date.now(), sha256, byteLength: pdf.length, fingerprint: sample.fingerprint, numPages: sample.numPages,
      folderId: "folder_" + crypto.randomUUID(), promptIds: ["p_" + crypto.randomUUID(), "p_" + crypto.randomUUID()] });
    const pdfDir = path.join(opts.backupDir, "PDFs");
    fs.mkdirSync(pdfDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(opts.backupDir, p.name), p.text, { mode: 0o600, flag: "wx" });
    fs.writeFileSync(path.join(pdfDir, p.pdfName), pdf, { mode: 0o600, flag: "wx" });
    log("self-test: put " + p.name + " and PDFs/" + p.pdfName + " into the throwaway backup folder");
    return { ok: true, name: p.name, pdfName: p.pdfName, expect: p.expect };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

// GET /api/app from the main process: the app's server answers {ok: true, app: true, version}.
async function probeAppApi() {
  try {
    const res = await server.httpGet(PORT, "/api/app", 3000);
    let body = null;
    try { body = JSON.parse(res.body); } catch (e) { body = null; }
    return { status: res.status, body };
  } catch (e) { return { status: null, body: null, error: String(e && e.message ? e.message : e) }; }
}

// FEATURES E2.3 g: a second hidden window on the same address, WITHOUT the preload (so window.marginaliaDesktop is absent,
// as in Brave) and with its own storage (a session partition in memory: on the app's session, the one-writing-tab rule
// would make the app's own window step aside), shows the cover in real Chromium. Its session refuses every permission
// and download, and records its requests; the "Open the app" link is read, never followed.
async function probeCover() {
  const ses = session.fromPartition(selftest.COVER_PARTITION);
  ses.setPermissionRequestHandler((wc, permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  refuseDevices(ses);
  ses.on("will-download", (event, item) => { try { item.cancel(); } catch (e) { /* gone */ } });
  ses.webRequest.onBeforeRequest((details, callback) => {
    const blocked = policy.blockedRequest(details.url);
    state.coverRequests.push({ url: details.url, method: details.method, type: details.resourceType, blocked });
    callback(blocked ? { cancel: true } : {});
  });
  const navigations = [];
  const consoleErrors = [];
  const w = new BrowserWindow({
    title: "Marginalia self-test: Brave stand-in", show: false, width: 1100, height: 800,
    webPreferences: { partition: selftest.COVER_PARTITION, contextIsolation: true, sandbox: true, nodeIntegration: false,
      nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, webSecurity: true, allowRunningInsecureContent: false,
      webviewTag: false, navigateOnDragDrop: false, safeDialogs: true, backgroundThrottling: false }
  });
  w.on("show", () => { state.windowEverShown = true; });
  w.webContents.on("will-navigate", (event) => navigations.push(describe(event.url)));
  w.webContents.on("console-message", (event) => { if (event.level === "error") consoleErrors.push(String(event.message).slice(0, 300)); });
  try {
    const loaded = waitForLoad(w);
    w.loadURL(ORIGIN + "/").catch(() => { /* did-fail-load reports it */ });
    await loaded;
    const raw = await w.webContents.executeJavaScript(selftest.coverScript(), true);
    return { raw, requests: state.coverRequests.slice(), navigations, consoleErrors: consoleErrors.slice(0, 5), error: null };
  } catch (e) {
    return { raw: null, requests: state.coverRequests.slice(), navigations, consoleErrors: consoleErrors.slice(0, 5), error: String(e && e.message ? e.message : e) };
  } finally {
    if (!w.isDestroyed()) w.destroy();
  }
}

// DECISIONS D31: a second window of the app, made as a page asks for one (openAppWindow) and never shown. Its page and
// the first window's hand the writer role to each other (lib/selftest.js windowsProbe tells the story), then it closes
// as its red button closes it: for good, since it is not the last window.
async function probeWindows(win) {
  let second = null;
  const gone = async (w) => { for (let i = 0; i < 50 && !w.isDestroyed(); i++) await delay(100); return w.isDestroyed(); };
  return selftest.windowsProbe({
    first: (script) => win.webContents.executeJavaScript(script),
    second: (script) => second.webContents.executeJavaScript(script),
    open: async () => {
      second = openAppWindow(selftest.WINDOW_ID, null, win, true);
      if (!second) return false;
      await waitForLoad(second);
      return true;
    },
    close: async () => {
      second.close();
      return { destroyed: await gone(second), firstAlive: !win.isDestroyed(), windows: liveWindows().length };
    },
    // A tab moves out of the first window as it does when it is dragged out: the page asks for the window
    // (js/tabs.js moveToWindow: window.open), lib/policy.js lets that through, and main.js makes the window.
    move: async () => {
      const before = liveWindows();
      const t0 = Date.now();
      const asked = await win.webContents.executeJavaScript(selftest.WINDOW_MOVE);
      let third = null;
      for (let i = 0; i < 400 && !third; i++) { third = liveWindows().find((w) => !before.includes(w)) || null; if (!third) await delay(10); }
      if (!third) return { asked, opened: false };
      const info = infoOf(third), made = Date.now() - t0;
      // the page loads; when it has loaded already, its own start is what the look waits for
      await Promise.race([waitForLoad(third), delay(3000)]);
      const loaded = Date.now() - t0;
      const look = await third.webContents.executeJavaScript(selftest.WINDOW_LOOK);
      // how long a tab that moves out waits for its window (milliseconds from the page's command): the window is made,
      // its page has loaded, the web app in it has started. For the record only: no check judges these numbers.
      const ms = { made, loaded, started: Date.now() - t0 };
      const windows = liveWindows().length;
      third.close();
      return { asked, opened: true, w: info ? info.w : null, look, windows, destroyed: await gone(third), left: liveWindows().length, ms };
    }
  });
}

// DECISIONS D30: the Window menu's tab commands, as runTab sends them to the page of the window that is never shown
// (lib/selftest.js tabsProbe says which and in which order; the menu items themselves are in the "menu" check).
async function probeTabs(wc) {
  return selftest.tabsProbe({ run: runTab, look: () => wc.executeJavaScript(selftest.TABS_LOOK), settle: () => delay(150),
    script: (name) => menu.tabScript(name) });
}

// FEATURES E2.3 b: the main window's close (what its red button and Shift+Cmd+W do, and Cmd+W with one tab left) hides
// it; the page and the server live on.
// Only with CLOSE_HIDES (with the switch off the close would quit the app in the middle of the self-test). The window
// was never shown, so lib/selftest.js closeProbe watches its hide() during the close (repair F2).
async function probeClose(win) {
  if (!CLOSE_HIDES) return { closeHides: false, skipped: true };
  return selftest.closeProbe(win, { settle: () => delay(300), serverRunning: () => !!(state.server && state.server.running) });
}

// Right-clicks (real input events, as macOS sends them) on the page's probe canvas and text field.
async function probeContextMenus(wc, targets) {
  const out = {};
  for (const name of ["canvas", "field"]) {
    const pt = targets && targets[name];
    if (!pt) { out[name] = null; continue; }
    const before = state.contextMenus.length;
    wc.sendInputEvent({ type: "mouseDown", x: pt.x, y: pt.y, button: "right", clickCount: 1 });
    wc.sendInputEvent({ type: "mouseUp", x: pt.x, y: pt.y, button: "right", clickCount: 1 });
    for (let i = 0; i < 40 && state.contextMenus.length === before; i++) await delay(50);
    out[name] = state.contextMenus.length > before ? state.contextMenus[state.contextMenus.length - 1] : null;
  }
  await wc.executeJavaScript("(function () { var b = document.getElementById(" + JSON.stringify(selftest.PROBE_ID) + "); if (b) b.remove(); return true; })()");
  return out;
}

// One key press (Shift alone: the web app ignores it), then two window.open calls: the first may open, the second not.
async function probeOpenAfterInput(wc) {
  state.lastInputAt = 0;
  wc.sendInputEvent({ type: "keyDown", keyCode: "Shift" });
  wc.sendInputEvent({ type: "keyUp", keyCode: "Shift" });
  for (let i = 0; i < 20 && !state.lastInputAt; i++) await delay(25);
  const urls = selftest.AFTER_INPUT_VIAS.map((v) => selftest.EXTERNAL_TEST_URL + "?via=" + v);
  await wc.executeJavaScript(urls.map((u) => "window.open(" + JSON.stringify(u) + ", \"_blank\");").join(" ") + " true");
  await delay(200);
}

// The runner's second launch hands over marginalia://open?hash=%23library (openHash queued it): go there now, through
// the same code as a real link, and see the open reader become the library on the same page.
async function probeHandoff(wc) {
  for (let i = 0; i < 50 && !state.handedOverHashes.length; i++) await delay(100);   // a second launch may be on its way
  if (!state.handedOverHashes.length) return null;
  const look = "({ screen: window.Marginalia.app.current().screen, hash: location.hash, marker: window.__marginaliaSelfTestMarker || null, timeOrigin: performance.timeOrigin })";
  const before = await wc.executeJavaScript(look);
  const hash = state.handedOverHashes[state.handedOverHashes.length - 1];
  goToHash(hash);
  let after = null;
  for (let i = 0; i < 50; i++) {
    await delay(100);
    try { after = await wc.executeJavaScript(look); } catch (e) { after = null; }
    if (after && after.screen === "library") break;
  }
  return { hashes: state.handedOverHashes.slice(), applied: true, before, after };
}

function backupFiles() {
  try { return fs.readdirSync(opts.backupDir).filter((n) => /^marginalia-backup-\d{4}-\d{2}-\d{2}\.json$/.test(n)); }
  catch (e) { return []; }
}

// What the prepared backup's file holds at the end (after M.backup.runNow replaced it): lib/selftest.js backupSummary.
function backupNow(prepared) {
  if (!prepared || !prepared.ok) return null;
  try { return selftest.backupSummary(fs.readFileSync(path.join(opts.backupDir, prepared.name), "utf8")); } catch (e) { return null; }
}

function finishSelfTest(raw, error, extra) {
  if (state.finished) return;
  state.finished = true;
  let verdict = { ok: false, checks: {} };
  if (raw) {
    const built = Menu.getApplicationMenu();
    verdict = selftest.evaluate(raw, {
      origin: ORIGIN,
      version: app.getVersion(),
      backupDir: displayPath(opts.backupDir),
      backupFiles: backupFiles(),
      externalOpens: state.externalOpens.slice(),
      downloads: state.downloads.slice(),
      downloadsFolder: app.getPath("downloads"),
      requests: state.requests.slice(),
      windowEverShown: state.windowEverShown || !!(state.win && !state.win.isDestroyed() && state.win.isVisible()),
      dockVisible: !!(app.dock && app.dock.isVisible()),
      mockKeychain: app.commandLine.hasSwitch("use-mock-keychain"),
      permissions: state.permissions.slice(),
      menuAccelerators: built ? menu.accelerators(built.items) : [],
      expectedAccelerators: menu.accelerators(menu.buildTemplate({})),
      contextMenus: extra ? extra.contextMenus : null,
      handoff: extra ? extra.handoff : null,
      appApi: extra ? extra.appApi : null,
      prepared: extra ? extra.prepared : null,
      folders: extra ? extra.folders : null,
      backupNow: extra ? backupNow(extra.prepared) : null,
      cover: extra ? extra.cover : null,
      close: extra ? extra.close : null,
      tabs: extra ? extra.tabs : null,
      windows: extra ? extra.windows : null,
      // the persistent-storage switch, so the persisted and permissions checks follow it (repair REQ-D)
      persistentStorage: policy.ALLOWED_PERMISSIONS.has("persistent-storage")
    });
  }
  const ok = !error && verdict.ok;
  jsonLine({
    selfTest: "marginalia-desktop", ok, error: error || null,
    version: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node,
    python: state.python, port: PORT, checks: verdict.checks,
    info: { persistedStorage: raw ? raw.persisted : null, consoleErrors: state.consoleErrors.slice(0, 10),
      requests: state.requests.length, coverRequests: state.coverRequests.length, permissionRequests: state.permissions.map((p) => p.permission),
      linksHandedOver: state.handedOverHashes.length, closeHides: CLOSE_HIDES,
      coverConsoleErrors: extra && extra.cover ? extra.cover.consoleErrors : null }
  });
  log("self-test " + (ok ? "passed" : "failed") + (error ? ": " + error : ""));
  const srv = state.server;
  setTimeout(() => app.exit(ok ? 0 : 1), 10000).unref();
  Promise.resolve(srv && srv.running ? srv.stop() : null).catch(() => null).then(() => {
    if (state.log) state.log.close();
    app.exit(ok ? 0 : 1);
  });
}
