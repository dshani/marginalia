"use strict";
// Zotero's entry points for Marginalia for Zotero (a bootstrapped plugin; DECISIONS D34). The rules are in
// marginalia.js: this file only hands it Zotero's objects, adds the menu item's label to each main window, and takes it
// all away again when the plugin is turned off or removed.
/* global Zotero, Services */
let plugin = null;

function install() {}

async function startup({ id, rootURI }) {
  await Zotero.initializationPromise;
  const scope = {};
  Services.scriptloader.loadSubScript(rootURI + "marginalia.js", scope);
  plugin = scope.MarginaliaZotero.make({
    Zotero, id,
    exec: (cmd, args) => {
      Zotero.Utilities.Internal.Environment.clearMozillaVariables();   // as Zotero.launchFileWithApplication does
      return Zotero.Utilities.Internal.exec(cmd, args);
    },
    alert: (title, text) => Services.prompt.alert(Zotero.getMainWindow(), title, text)
  });
  for (const win of Zotero.getMainWindows()) plugin.addToWindow(win);
  plugin.register();
}

function onMainWindowLoad({ window }) {
  if (plugin) plugin.addToWindow(window);
}

function onMainWindowUnload({ window }) {
  if (plugin) plugin.removeFromWindow(window);
}

function shutdown() {
  if (!plugin) return;
  plugin.unregister();
  for (const win of Zotero.getMainWindows()) plugin.removeFromWindow(win);
  plugin = null;
}

function uninstall() {}
