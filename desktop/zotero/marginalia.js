"use strict";
// Marginalia for Zotero (DECISIONS D34): "Open in Marginalia" in the item list's right-click menu opens the PDF of
// each selected item in the Mac app. It asks macOS to (`/usr/bin/open -b local.marginalia.desktop <file>…`), which
// hands the app each file as "open-file" (main.js, lib/openfile.js); the app adds it as a dropped PDF, or opens its
// book when the library has it. Nothing else goes from Zotero to Marginalia, and nothing comes back.
//
// bootstrap.js loads this file into the plugin's scope (Services.scriptloader.loadSubScript) and calls make() with
// Zotero's own objects; test/zotero.test.js loads it in Node with stand-ins. make({Zotero, exec, alert, id}) → {
// register(), unregister(), addToWindow(win), removeFromWindow(win), canOpen(items), pathsFor(items), open(items) }:
//   - the menu item (Zotero.MenuManager, target "main/library/item") shows only on a Mac and only when a selected item
//     is a PDF attachment or a regular item with one; its label is in locale/en-US/marginalia-zotero.ftl;
//   - for a regular item the PDF is its best attachment when that is a PDF (Zotero's own choice for double-click),
//     else its first PDF attachment; at most MAX_ITEMS items are opened at once;
//   - a PDF whose file is not on this Mac (not downloaded, a linked file that moved) is left out, and a notice says
//     how many; when `open` fails (the app is not installed) a notice says so.
(function (root) {
  const BUNDLE_ID = "local.marginalia.desktop";       // desktop/scripts/build.js BUNDLE_ID
  const OPEN = "/usr/bin/open";
  const MENU_ID = "marginalia-open-in-marginalia";
  const L10N_ID = "marginalia-open-in-marginalia";
  const FTL = "marginalia-zotero.ftl";
  const MAX_ITEMS = 20;
  const TITLE = "Marginalia";
  const TEXT = {
    noFile: "The PDF of this item is not on this Mac. Download it in Zotero first.",
    someMissing: (n) => n + (n === 1 ? " PDF was" : " PDFs were") + " left out: the file is not on this Mac.",
    tooMany: "Marginalia opens at most " + MAX_ITEMS + " PDFs at once; the first " + MAX_ITEMS + " are opened.",
    noApp: "Marginalia could not be opened. Is the Marginalia app installed? Build and install it with: marginalia app"
  };

  function isPdf(item) {
    return !!item && typeof item.isPDFAttachment === "function" && item.isPDFAttachment() === true;
  }
  function isRegular(item) {
    return !!item && typeof item.isRegularItem === "function" && item.isRegularItem() === true;
  }

  function make(env) {
    const Z = env.Zotero;
    let menuID = null;

    function attachmentsOf(item) {
      if (!isRegular(item) || typeof item.getAttachments !== "function") return [];
      return item.getAttachments().map((id) => Z.Items.get(id)).filter(isPdf);
    }
    // Is there a PDF to open among these items? (synchronous: the menu decides as it shows)
    function canOpen(items) {
      return (items || []).some((it) => isPdf(it) || attachmentsOf(it).length > 0);
    }
    async function pdfOf(item) {
      if (isPdf(item)) return item;
      if (!isRegular(item)) return null;
      let best = null;
      try { best = typeof item.getBestAttachment === "function" ? await item.getBestAttachment() : null; } catch (e) { best = null; }
      return isPdf(best) ? best : attachmentsOf(item)[0] || null;
    }
    // pathsFor(items) → {paths, missing, cut}: the files to open, each once and in the order of the items
    async function pathsFor(items) {
      const list = items || [], paths = [];
      let missing = 0;
      for (const item of list.slice(0, MAX_ITEMS)) {
        const pdf = await pdfOf(item);
        if (!pdf) continue;
        let file = null;
        try { file = await pdf.getFilePathAsync(); } catch (e) { file = null; }
        if (typeof file !== "string" || !file) { missing++; continue; }
        if (paths.indexOf(file) < 0) paths.push(file);
      }
      return { paths, missing, cut: list.length > MAX_ITEMS };
    }
    // open(items) → Promise<{opened, missing, cut, error}>; never rejects
    async function open(items) {
      const got = await pathsFor(items);
      const out = { opened: 0, missing: got.missing, cut: got.cut, error: null };
      if (!got.paths.length) {
        if (got.missing) env.alert(TITLE, TEXT.noFile);
        return out;
      }
      try {
        await env.exec(OPEN, ["-b", BUNDLE_ID].concat(got.paths));
        out.opened = got.paths.length;
      } catch (e) {
        out.error = String(e && e.message ? e.message : e);
        env.alert(TITLE, TEXT.noApp);
        return out;
      }
      const notes = [];
      if (got.missing) notes.push(TEXT.someMissing(got.missing));
      if (got.cut) notes.push(TEXT.tooMany);
      if (notes.length) env.alert(TITLE, notes.join("\n\n"));
      return out;
    }

    function register() {
      if (menuID || !Z.MenuManager || typeof Z.MenuManager.registerMenu !== "function") return false;
      menuID = Z.MenuManager.registerMenu({
        menuID: MENU_ID, pluginID: env.id, target: "main/library/item",
        menus: [{
          menuType: "menuitem", l10nID: L10N_ID,
          onShowing: (event, context) => { context.setVisible(Z.isMac === true && canOpen(context.items)); },
          onCommand: (event, context) => { open(context.items); }
        }]
      }) || null;
      return !!menuID;
    }
    function unregister() {
      if (menuID && Z.MenuManager && typeof Z.MenuManager.unregisterMenu === "function") Z.MenuManager.unregisterMenu(menuID);
      menuID = null;
    }
    // Each main window reads the menu item's label from the plugin's Fluent file (Zotero registers locale/ itself).
    function addToWindow(win) {
      if (win && win.MozXULElement && typeof win.MozXULElement.insertFTLIfNeeded === "function") win.MozXULElement.insertFTLIfNeeded(FTL);
    }
    function removeFromWindow(win) {
      const link = win && win.document ? win.document.querySelector('[href="' + FTL + '"]') : null;
      if (link) link.remove();
    }

    return { register, unregister, addToWindow, removeFromWindow, canOpen, pathsFor, open };
  }

  const api = { make, BUNDLE_ID, OPEN, MENU_ID, L10N_ID, FTL, MAX_ITEMS, TEXT };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MarginaliaZotero = api;
})(this);
