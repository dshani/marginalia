"use strict";
// Zotero's entry points for Marginalia for Zotero (a bootstrapped plugin; DECISIONS D34). The rules are in
// marginalia.js: this file only hands it Zotero's objects (and Gecko's: a SHA-256 of a file, timers), adds the menu
// item's label to each main window, starts the sync of step 2, and takes it all away again when the plugin is turned
// off or removed (every timer it started is cancelled).
/* global Zotero, Services, Components */
const { classes: Cc, interfaces: Ci } = Components;
let plugin = null;
const timers = new Set();

function timer(ms, fn, repeat) {
  const t = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
  t.initWithCallback({ notify: () => { if (!repeat) timers.delete(t); fn(); } }, ms,
    repeat ? Ci.nsITimer.TYPE_REPEATING_SLACK : Ci.nsITimer.TYPE_ONE_SHOT);
  timers.add(t);
  return () => { t.cancel(); timers.delete(t); };
}

// The SHA-256 of a file, read as a stream (a PDF is never held whole), in 64 hex digits.
function sha256(file) {
  const stream = Cc["@mozilla.org/network/file-input-stream;1"].createInstance(Ci.nsIFileInputStream);
  stream.init(Zotero.File.pathToFile(file), 0x01, 0, 0);        // PR_RDONLY
  try {
    const hash = Cc["@mozilla.org/security/hash;1"].createInstance(Ci.nsICryptoHash);
    hash.init(Ci.nsICryptoHash.SHA256);
    hash.updateFromStream(stream, 0xffffffff);                 // PR_UINT32_MAX: to the end of the file
    return Array.from(hash.finish(false), (c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  } finally {
    stream.close();
  }
}

function install() {}

async function startup({ id, rootURI }) {
  await Zotero.initializationPromise;
  const scope = {};
  Services.scriptloader.loadSubScript(rootURI + "marginalia.js", scope);
  const M = scope.MarginaliaZotero;
  plugin = M.make({
    Zotero, id,
    exec: (cmd, args) => {
      Zotero.Utilities.Internal.Environment.clearMozillaVariables();   // as Zotero.launchFileWithApplication does
      return Zotero.Utilities.Internal.exec(cmd, args);
    },
    alert: (title, text) => Services.prompt.alert(Zotero.getMainWindow(), title, text),
    sha256: async (file) => sha256(file),
    // the app's server: a JSON answer, or a rejection when the app does not run (Zotero.HTTP rejects then)
    fetchBooks: async (url) => (await Zotero.HTTP.request("GET", url, { headers: { "X-Marginalia": "1" }, responseType: "json",
      timeout: 5000, successCodes: [200] })).response,
    prefs: { get: () => Zotero.Prefs.get(M.PREF, true), set: (text) => Zotero.Prefs.set(M.PREF, text, true) },
    every: (ms, fn) => timer(ms, fn, true),
    later: (ms, fn) => timer(ms, fn, false)
  });
  for (const win of Zotero.getMainWindows()) plugin.addToWindow(win);
  plugin.register();
  plugin.start();
}

function onMainWindowLoad({ window }) {
  if (plugin) plugin.addToWindow(window);
}

function onMainWindowUnload({ window }) {
  if (plugin) plugin.removeFromWindow(window);
}

function shutdown() {
  for (const t of timers) t.cancel();
  timers.clear();
  if (!plugin) return;
  plugin.stop();
  plugin.unregister();
  for (const win of Zotero.getMainWindows()) plugin.removeFromWindow(win);
  plugin = null;
}

function uninstall() {}
