"use strict";
// Marginalia for Zotero (DECISIONS D34): "Open in Marginalia" in the item list's right-click menu opens the PDF of
// each selected item in the Mac app. It asks macOS to (`/usr/bin/open -b local.marginalia.desktop <file>…`), which
// hands the app each file as "open-file" (main.js, lib/openfile.js); the app adds it as a dropped PDF, or opens its
// book when the library has it. Nothing but the files goes from Zotero to Marginalia.
//
// Step 2 (D34): the items whose PDF it opened get the tag "Marginalia" and one child note "<n> prompts in Marginalia"
// while the app's library has prompts for that PDF. The plugin remembers each PDF it opened by its SHA-256 (the one
// the library keys a book's PDF by) with the attachment's library and key, in the Zotero preference PREF. While the
// app runs, its server answers GET http://127.0.0.1:8765/api/zotero/books with each book's SHA-256 and its prompts as
// the library counts them (js/desktop.js sends them); sync() reads that FIRST_SYNC_MS after Zotero starts the plugin, every
// SYNC_MS, and AFTER_OPEN_MS after an open. When the list's "at" (the time the app last said it) is the one it applied
// last, and no PDF was opened since, it stops there: most checks change nothing in Zotero. Otherwise:
//   - an item (the attachment's parent, else the attachment itself) whose PDFs have prompts gets the tag, and, when it
//     is a regular item, the note, made or changed only when its count changed (a standalone PDF has no child notes);
//   - an item whose PDFs have none (the book has no prompts, or is not in the library any more) loses the tag, and its
//     note goes to Zotero's trash;
//   - the tag gets Marginalia's red (TAG_COLOR) in each library where it has no colour yet, once per library (a
//     colour the user picks, or takes away, stays), and only while the library has fewer than 9 coloured tags;
//   - an attachment that is gone from Zotero is forgotten; nothing changes while the app's server does not answer.
//
// bootstrap.js loads this file into the plugin's scope (Services.scriptloader.loadSubScript) and calls make() with
// Zotero's own objects; test/zotero.test.js loads it in Node with stand-ins. make({Zotero, exec, alert, id, sha256,
// fetchBooks, prefs, every, later}) → { register(), unregister(), addToWindow(win), removeFromWindow(win),
// canOpen(items), pathsFor(items), open(items), remember(pdfs), sync(), start(), stop() }:
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
  const TAG = "Marginalia";
  const TAG_COLOR = "#E04A2F";                      // Marginalia's accent (styles.css --accent), the user's choice (D34 (10))
  const MAX_COLORED_TAGS = 9;                       // Zotero.Tags.MAX_COLORED_TAGS
  // JSON {books: {sha256: [{libraryID, key}]}, notes: {"<libraryID>/<key>": {key, prompts}}, colored: [libraryID]}
  const PREF = "extensions.marginalia.zotero";
  const BOOKS_URL = "http://127.0.0.1:8765/api/zotero/books";   // the app's server (its port is fixed: CLAUDE.md)
  const SYNC_MS = 30 * 1000;                       // a new prompt shows in Zotero within this (D34 (11))
  const FIRST_SYNC_MS = 30 * 1000;                 // after Zotero starts the plugin
  const AFTER_OPEN_MS = [15 * 1000, 60 * 1000];    // the app adds the PDF, then says its books 2 s after a change
  const SHA256_RE = /^[0-9a-f]{64}$/;
  const TEXT = {
    noFile: "The PDF of this item is not on this Mac. Download it in Zotero first.",
    someMissing: (n) => n + (n === 1 ? " PDF was" : " PDFs were") + " left out: the file is not on this Mac.",
    tooMany: "Marginalia opens at most " + MAX_ITEMS + " PDFs at once; the first " + MAX_ITEMS + " are opened.",
    noApp: "Marginalia could not be opened. Is the Marginalia app installed? Build and install it with: marginalia app",
    note: (n) => n + (n === 1 ? " prompt" : " prompts") + " in Marginalia"
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
    // pathsFor(items) → {paths, pdfs: [{pdf, file}], missing, cut}: the files to open, each once and in the order of
    // the items, with their attachments
    async function pathsFor(items) {
      const list = items || [], paths = [], pdfs = [];
      let missing = 0;
      for (const item of list.slice(0, MAX_ITEMS)) {
        const pdf = await pdfOf(item);
        if (!pdf) continue;
        let file = null;
        try { file = await pdf.getFilePathAsync(); } catch (e) { file = null; }
        if (typeof file !== "string" || !file) { missing++; continue; }
        if (paths.indexOf(file) < 0) { paths.push(file); pdfs.push({ pdf, file }); }
      }
      return { paths, pdfs, missing, cut: list.length > MAX_ITEMS };
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
        try { await remember(got.pdfs); } catch (e) { /* the open went through; only the tag waits for the next open */ }
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

    // ---- step 2: the tag and the note
    function readState() {
      let raw = null;
      try { raw = JSON.parse(env.prefs.get() || "null"); } catch (e) { raw = null; }
      const state = { books: {}, notes: {}, colored: [] };
      if (raw && typeof raw.books === "object" && raw.books) {
        for (const sha of Object.keys(raw.books)) {
          const list = Array.isArray(raw.books[sha]) ? raw.books[sha].filter((a) => a && typeof a.key === "string" && Number.isInteger(a.libraryID)) : [];
          if (SHA256_RE.test(sha) && list.length) state.books[sha] = list;
        }
      }
      if (raw && typeof raw.notes === "object" && raw.notes) {
        for (const k of Object.keys(raw.notes)) {
          const n = raw.notes[k];
          if (n && typeof n.key === "string" && Number.isInteger(n.prompts)) state.notes[k] = { key: n.key, prompts: n.prompts };
        }
      }
      if (raw && Array.isArray(raw.colored)) state.colored = raw.colored.filter((x) => Number.isInteger(x));
      return state;
    }
    function writeState(state) { env.prefs.set(JSON.stringify(state)); }

    // The PDFs just opened, by their SHA-256, with their attachments; a sync follows once the app has added them.
    async function remember(pdfs) {
      const state = readState();
      let added = 0;
      for (const { pdf, file } of pdfs || []) {
        let sha = null;
        try { sha = String(await env.sha256(file)).toLowerCase(); } catch (e) { sha = null; }
        if (!sha || !SHA256_RE.test(sha)) continue;
        const list = state.books[sha] || (state.books[sha] = []);
        if (!list.some((a) => a.libraryID === pdf.libraryID && a.key === pdf.key)) { list.push({ libraryID: pdf.libraryID, key: pdf.key }); added++; }
      }
      if (added) writeState(state);
      fresh = true;
      for (const ms of AFTER_OPEN_MS) env.later(ms, () => { sync(); });
      return added;
    }

    function itemOf(libraryID, key) {
      let it = null;
      try { it = Z.Items.getByLibraryAndKey(libraryID, key) || null; } catch (e) { it = null; }
      return it && !it.deleted ? it : null;
    }
    // The item the tag goes on: an attachment's parent, else the attachment itself (a standalone PDF).
    function targetOf(att) {
      const parent = att.parentItemID ? Z.Items.get(att.parentItemID) : null;
      return parent && !parent.deleted ? parent : att;
    }

    // sync() → Promise<{ok, tagged, untagged, notes, forgotten} | {ok: false, why}>; one at a time, never rejects.
    let running = null, stopped = false;
    let applied = null, fresh = true;                // the "at" of the list applied last; a PDF was opened since
    function sync() {
      if (stopped) return Promise.resolve({ ok: false, why: "the plugin was turned off" });
      if (running) return running;
      running = syncOnce().then((r) => r, (e) => ({ ok: false, why: String(e && e.message ? e.message : e) }))
        .then((r) => { running = null; return r; });
      return running;
    }
    async function syncOnce() {
      const state = readState();
      if (!Object.keys(state.books).length) return { ok: false, why: "no PDF was opened in Marginalia yet" };
      let answer = null;
      try { answer = await env.fetchBooks(BOOKS_URL); } catch (e) { answer = null; }
      const books = answer && answer.ok === true && answer.books && typeof answer.books === "object" ? answer.books : null;
      if (!books) return { ok: false, why: "the Marginalia app did not answer" };
      const at = Number.isInteger(answer.at) ? answer.at : null;
      if (!fresh && at !== null && at === applied) return { ok: true, unchanged: true };
      const out = { ok: true, tagged: 0, untagged: 0, notes: 0, forgotten: 0, colored: 0 };
      const targets = new Map();                      // "<lib>/<key>" → {item, prompts}
      for (const sha of Object.keys(state.books)) {
        const n = Number.isInteger(books[sha]) && books[sha] > 0 ? books[sha] : 0;
        state.books[sha] = state.books[sha].filter((a) => {
          const att = itemOf(a.libraryID, a.key);
          if (!att) { out.forgotten++; return false; }
          const t = targetOf(att), id = t.libraryID + "/" + t.key;
          const entry = targets.get(id) || { item: t, prompts: 0 };
          entry.prompts += n;
          targets.set(id, entry);
          return true;
        });
        if (!state.books[sha].length) delete state.books[sha];
      }
      for (const [id, { item, prompts }] of targets) {
        try {
          if (prompts > 0 && !item.hasTag(TAG)) { item.addTag(TAG); await item.saveTx(); out.tagged++; }
          if (prompts === 0 && item.hasTag(TAG)) { item.removeTag(TAG); await item.saveTx(); out.untagged++; }
          if (await keepNote(state, id, item, prompts)) out.notes++;
          if (prompts > 0 && await colorTag(state, item.libraryID)) out.colored++;
        } catch (e) { /* a library that cannot be changed (a read-only group): left as it is */ }
      }
      writeState(state);
      applied = at;
      fresh = false;
      return out;
    }
    // The tag's colour in a library, once: only when the tag has none and the library has fewer than 9 coloured tags
    // (Zotero's limit, which setColor does not check). → whether it set one.
    async function colorTag(state, libraryID) {
      const T = Z.Tags;
      if (state.colored.includes(libraryID)) return false;
      if (!T || typeof T.getColor !== "function" || typeof T.getColors !== "function" || typeof T.setColor !== "function") return false;
      state.colored.push(libraryID);                 // whatever happens now, this library is not tried again
      if (T.getColor(libraryID, TAG)) return false;  // a colour of the user's own
      const max = Number.isInteger(T.MAX_COLORED_TAGS) ? T.MAX_COLORED_TAGS : MAX_COLORED_TAGS;
      if (T.getColors(libraryID).size >= max) return false;
      await T.setColor(libraryID, TAG, TAG_COLOR);
      return true;
    }
    // The item's note "<n> prompts in Marginalia": made, changed or trashed as the count says. → whether it changed.
    async function keepNote(state, id, item, prompts) {
      const had = state.notes[id] || null;
      let note = had ? itemOf(item.libraryID, had.key) : null;
      if (prompts === 0 || !isRegular(item)) {
        if (!note) { delete state.notes[id]; return false; }
        note.deleted = true;
        await note.saveTx();
        delete state.notes[id];
        return true;
      }
      if (note && had.prompts === prompts) return false;
      if (!note) {
        note = new Z.Item("note");
        note.libraryID = item.libraryID;
        note.parentID = item.id;
      }
      note.setNote("<p>" + TEXT.note(prompts) + "</p>");
      await note.saveTx();
      state.notes[id] = { key: note.key, prompts };
      return true;
    }

    let stopTimer = null;
    function start() {
      stopped = false;
      if (!stopTimer) stopTimer = env.every(SYNC_MS, () => { sync(); });
      env.later(FIRST_SYNC_MS, () => { sync(); });
    }
    function stop() {
      stopped = true;
      if (stopTimer) stopTimer();
      stopTimer = null;
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

    return { register, unregister, addToWindow, removeFromWindow, canOpen, pathsFor, open, sync, start, stop, remember };
  }

  const api = { make, BUNDLE_ID, OPEN, MENU_ID, L10N_ID, FTL, MAX_ITEMS, TEXT, TAG, TAG_COLOR, PREF, BOOKS_URL, SYNC_MS, FIRST_SYNC_MS, AFTER_OPEN_MS };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MarginaliaZotero = api;
})(this);
