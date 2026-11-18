/*
 * Marginalia — js/tabs.js
 * Tabs inside the one page (DECISIONS D30; BUILD-NOTES "Tabs").
 *
 * A tab is a PLACE of the app: {id, screen, collectionId, position, promptId}. The page still shows one screen and
 * holds one open PDF: showing another tab is an M.app.route() to its place. So nothing changes in how the library
 * is saved (a page is one writer; the windows of the Mac app hand that role to each other, D31). This module owns the list of tabs, the strip #tabs (css/tabs.css), the tab
 * commands and their storage (localStorage "marginalia.tabs": this Mac only, never in a backup).
 *
 *  - The active tab follows every navigation: M.app emits app:routed and the active tab takes that place.
 *  - A book tab that is left remembers where it was (M.reader.position()); it opens there again (M.app.route(…,
 *    {position}) → M.reader.open(id, {position})). Two tabs can show two places of one book.
 *  - A book tab that is left with a prompt editor open gets the editor back when it is shown again and its book is
 *    open (M.margin.editing() → M.margin.openEditor(…)); what was typed is the editor's own draft.
 *  - Nothing changes tabs while a review or a dialog is on screen (blocked()): no command, no click, no link.
 *  - Windows (DECISIONS D31, BUILD-NOTES "Windows"; the Mac app): each window is a page with its own list of tabs,
 *    under its own key ("?w=<id>" in its address). A tab can go to a new window (moveToWindow: the menu, or a tab
 *    dragged out of the strip), into another window (a tab dragged onto that window's strip), or to another place
 *    of its strip. The lists of windows that are gone come back in the first window.
 *  - The strip shows only while there are two or more tabs.
 *  - In the Mac app the menu owns Cmd+T, Cmd+W and Shift+Cmd+T and calls run(id) here; the page then leaves those
 *    keys alone (MENU_KEYS), so a key never runs twice. Every other tab key is the page's there too.
 *  - Back and Forward (a browser's buttons) move the tab on screen; only a new address picks a tab (M.app tells them
 *    apart and calls link()).
 *
 * The functions under _pure load in Node without a DOM.
 */
(function (root) {
  "use strict";
  var M = root.Marginalia = root.Marginalia || {};
  function dep(name) { return M[name] || (typeof require === "function" ? require("./" + name + ".js") : undefined); }
  function tryDep(name) { try { return dep(name); } catch (e) { return undefined; } }

  var HOST_ID = "tabs";
  var STORE_KEY = "marginalia.tabs";
  var TABS_MAX = 20;            // open tabs
  var CLOSED_MAX = 10;          // closed tabs that Cmd+Shift+T can bring back (memory only)
  var SAVE_MS = 200;
  var SCREENS = ["library", "deck", "reader", "stats"];
  var WINDOW_RE = /^[a-z0-9]{6,16}$/;      // a window's id: "?w=<id>" (the first window has none)
  var WINDOWS_MAX = 8;                     // open windows (desktop/main.js has the same number)
  var WINDOW_WAIT_MS = 4000;               // how long a new window may take to show up before its tab comes back
  var TAB_TYPE = "application/x-marginalia-tab";   // the data of a tab that is dragged
  var CHANNEL = "marginalia.tabs";         // BroadcastChannel: a window says that it took a dragged tab
  var DROP_WAIT_MS = 200;                  // a tab dropped on nothing waits this long for a window that took it after all
  var DRAG_TYPE = "application/x-marginalia-drag-";   // + the drag's number: a type of its own, so that a page can tell
                                           // WHICH drag is over it (a page reads the types during a drag, the data only at the drop)
  var OVER_MS = 700;                       // a tab that was held over this page has left when no dragover came for this long
                                           // (an engine may let 550 ms pass between two)
  var TEAR_PX = 24;                        // a tab let go this close to its strip stays in the strip; farther away it leaves
  var SHOT_W = 220, SHOT_H = 150, SHOT_BAR = 24;   // the small picture of a tab that is dragged (CSS pixels): its size, its title bar
  var APP_NAME = "Marginalia";
  var MENU_KEYS = ["Mod+t", "Mod+w", "Mod+Shift+t"];       // the Mac app's Window menu has these (desktop/lib/menu.js)
  var COMMANDS = ["newTab", "closeTab", "reopenTab", "nextTab", "prevTab", "tab1", "tab2", "tab3", "tab4", "tab5", "tab6", "tab7", "tab8", "lastTab"];

  var st = { tabs: [], active: null, closed: [], started: false, saveTimer: 0, n: 0, offs: [], unload: null, left: null,
    fresh: false, drag: null, sent: null, was: null, dumped: null, channel: undefined, dropzone: false, dropTimer: 0 };

  // ---------------------------------------------------------------- pure

  function isNum(v) { return typeof v === "number" && isFinite(v); }

  // A route or a stored tab as a place: {screen, collectionId}. The library and the statistics page have no
  // collection; a deck or a book without one is the library.
  function place(route) {
    var r = route && typeof route === "object" ? route : {};
    var screen = SCREENS.indexOf(r.screen) >= 0 ? r.screen : "library";
    var cid = r.collectionId == null || r.collectionId === "" ? null : String(r.collectionId);
    if (screen === "library" || screen === "stats") cid = null;
    else if (!cid) screen = "library";
    return { screen: screen, collectionId: cid };
  }

  function samePlace(a, b) { return !!a && !!b && a.screen === b.screen && (a.collectionId || null) === (b.collectionId || null); }

  // A place in a book as M.reader gives and takes it, or null.
  function validPosition(p) {
    if (!p || typeof p !== "object" || !isNum(p.pageIndex) || p.pageIndex < 0) return null;
    return {
      pageIndex: Math.floor(p.pageIndex),
      fraction: isNum(p.fraction) ? Math.min(1, Math.max(0, p.fraction)) : 0,
      zoom: isNum(p.zoom) && p.zoom > 0 ? p.zoom : "fit"
    };
  }

  function title(tab, collection) {
    if (!tab || tab.screen === "library") return "Library";
    if (tab.screen === "stats") return "Statistics";
    if (collection && collection.name) return String(collection.name);
    return tab.screen === "deck" || (collection && collection.kind === "deck") ? "Untitled deck" : "Untitled";
  }

  function indexOf(list, id) {
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].id === id) return i;
    return -1;
  }

  // The list with `tab` right after the active tab (at the end when there is no active tab).
  function after(list, activeId, tab) {
    var out = list.slice(), i = indexOf(out, activeId);
    out.splice(i < 0 ? out.length : i + 1, 0, tab);
    return out;
  }

  // The list without tab `id`. When that tab was the active one, its right neighbour becomes active, else its left one.
  function without(list, activeId, id) {
    var out = list.slice(), i = indexOf(out, id);
    if (i < 0) return { tabs: out, active: activeId };
    out.splice(i, 1);
    var active = activeId;
    if (activeId === id) active = out.length ? out[Math.min(i, out.length - 1)].id : null;
    return { tabs: out, active: active };
  }

  // The id `delta` places from the active tab, going round.
  function step(list, activeId, delta) {
    var n = list.length;
    if (!n) return null;
    var i = indexOf(list, activeId);
    if (i < 0) i = 0;
    return list[(((i + delta) % n) + n) % n].id;
  }

  // Tab 1 to 8 by its place in the strip; 9 is the last tab. null when there is no such tab.
  function nth(list, n) {
    if (!list.length) return null;
    if (n === 9) return list[list.length - 1].id;
    var t = isNum(n) && n >= 1 && n <= 8 ? list[n - 1] : null;
    return t ? t.id : null;
  }

  // Stored JSON → {tabs: [{screen, collectionId, position}], active: index}. find(id) → a live collection or null.
  // Anything that is no tab is dropped, and so is a tab whose book or deck is gone; a book stored as a deck (or the
  // reverse) takes the screen of its kind; at most TABS_MAX tabs. {tabs: [], active: -1} when nothing is left.
  // The prompt editor a tab brings along (M.margin.editing()'s answer), or null. Only a tab that moved to another
  // window carries one in storage (D31); serialize() never writes it.
  function validEditing(e) {
    if (!e || typeof e !== "object" || Array.isArray(e)) return null;
    if (!(e.promptId === null || typeof e.promptId === "string")) return null;
    if (!(e.anchor === null || (typeof e.anchor === "object" && !Array.isArray(e.anchor)))) return null;
    return e;
  }

  function clean(saved, find) {
    var list = saved && typeof saved === "object" && Array.isArray(saved.tabs) ? saved.tabs : [];
    var want = saved && isNum(saved.active) ? Math.floor(saved.active) : 0;
    var out = [], active = -1;
    for (var i = 0; i < list.length && out.length < TABS_MAX; i++) {
      var raw = list[i];
      if (!raw || typeof raw !== "object" || SCREENS.indexOf(raw.screen) < 0) continue;
      var p = place(raw), position = null, editing = null;
      if (p.screen === "reader" || p.screen === "deck") {
        var c = null;
        try { c = typeof find === "function" ? find(p.collectionId) : null; } catch (e) { c = null; }
        if (!c || c.deletedAt) continue;
        if (c.kind === "deck") p.screen = "deck";
        else if (c.kind === "book") p.screen = "reader";
        if (p.screen === "reader") { position = validPosition(raw.position); editing = validEditing(raw.editing); }
      }
      if (i === want) active = out.length;
      out.push({ screen: p.screen, collectionId: p.collectionId, position: position, editing: editing });
    }
    if (out.length && active < 0) active = Math.min(Math.max(want, 0), out.length - 1);
    return { tabs: out, active: active };
  }

  // What is stored: the places in order and the active tab's index. No ids, no prompt, no closed tabs.
  function serialize(tabs, activeId) {
    return {
      v: 1,
      tabs: tabs.map(function (t) { return { screen: t.screen, collectionId: t.collectionId, position: t.position || null }; }),
      active: Math.max(0, indexOf(tabs, activeId))
    };
  }

  // ---------------------------------------------------------------- the page

  function doc() { try { return root.document && typeof root.document.getElementById === "function" ? root.document : null; } catch (e) { return null; } }
  function host() { var d = doc(); return d ? d.getElementById(HOST_ID) : null; }
  function report(where, e) { try { console.error("[tabs] " + where + ":", e); } catch (e2) { /* no console */ } }

  function collectionOf(id) {
    if (id == null) return null;
    try {
      var c = M.cache && typeof M.cache.collection === "function" ? M.cache.collection(id) : null;
      return c && !c.deletedAt ? c : null;
    } catch (e) { return null; }
  }

  // A place with the screen of its collection's kind: a deck asked as "reader" is a deck tab (M.app.route does the same).
  function placeOf(route) {
    var p = place(route), c = p.collectionId ? collectionOf(p.collectionId) : null;
    if (c && c.kind === "deck") p.screen = "deck";
    else if (c && c.kind === "book") p.screen = "reader";
    return p;
  }

  function activeTab() { var i = indexOf(st.tabs, st.active); return i < 0 ? null : st.tabs[i]; }
  function make(p) {
    st.n++;
    return { id: "tab" + st.n, screen: p.screen, collectionId: p.collectionId, position: null, promptId: null, shown: null, editing: null, shot: null };
  }
  function titleOf(t) { return title(t, t.collectionId ? collectionOf(t.collectionId) : null); }

  function isApp() {
    try { return !!(M.desktop && typeof M.desktop.isApp === "function" && M.desktop.isApp()); } catch (e) { return false; }
  }

  // The tab commands do nothing while a review is on screen, or while something that takes every key is up (the
  // ? sheet, a confirm question, Settings, Export / Import, the "Move to folder…" picker, the "other tab" notice,
  // the cover).
  function blocked() {
    try { if (M.app && typeof M.app.modal === "function" && M.app.modal()) return true; } catch (e) { /* no app */ }
    try { if (M.review && typeof M.review.isActive === "function" && M.review.isActive()) return true; } catch (e2) { /* no review */ }
    return false;
  }

  function toast(text) {
    try { if (M.app && typeof M.app.toast === "function") M.app.toast({ text: text, id: "tabs" }); } catch (e) { /* no toasts */ }
  }

  // ---- storage: this Mac only; a page that stepped aside, or the cover, writes nothing

  function storage() {
    try { var s = root.localStorage; return s && typeof s.getItem === "function" ? s : null; } catch (e) { return null; }
  }
  // This window's id: the "w" of its address ("?w=<id>"), or null for the first window (and in a browser).
  function windowId() {
    try {
      var search = root.location && typeof root.location.search === "string" ? root.location.search : "";
      var m = /^\?w=([a-z0-9]+)$/.exec(search);            // the whole query: as desktop/lib/policy.js windowOf reads it
      return m && WINDOW_RE.test(m[1]) ? m[1] : null;
    } catch (e) { return null; }
  }
  function keyOf(w) { return w ? STORE_KEY + "." + w : STORE_KEY; }
  function storeKey() { return keyOf(windowId()); }

  // The windows of the Mac app (M.store in handover mode): each window is a page with its own tabs.
  function windows() {
    try { return !!(M.store && typeof M.store.handover === "function" && M.store.handover() === true); } catch (e) { return false; }
  }

  function readStored(key) {
    var s = storage();
    if (!s) return null;
    try { var raw = s.getItem(key || storeKey()); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
  }
  // A page that stepped aside for a newer tab stores nothing (the newer page's list is the one). A window of the
  // Mac app that is only a reader for now stores its own list all the same: it is its own key.
  function mayStore() {
    try {
      var l = M.store && typeof M.store.locked === "function" ? M.store.locked() : null;
      if (l && !(l.reason === "window" && windows())) return false;
    } catch (e) { /* no store */ }
    try { if (M.desktop && typeof M.desktop.covered === "function" && M.desktop.covered()) return false; } catch (e2) { /* no desktop */ }
    return true;
  }
  // What is stored: the list, and for the tab on screen the place its book shows now (the reader holds it). So a
  // window finds its place again after a restart, also when it could not store the book's lastPosition (D31: a
  // window that is not the writer).
  function record() {
    var out = serialize(st.tabs, st.active), a = activeTab(), i = indexOf(st.tabs, st.active);
    if (a && a.screen === "reader" && i >= 0) out.tabs[i].position = readerPosition(a.collectionId) || a.shown || null;
    return out;
  }
  function saveNow() {
    if (st.saveTimer) { try { clearTimeout(st.saveTimer); } catch (e) { /* gone */ } st.saveTimer = 0; }
    if (!st.started || st.gone || !mayStore()) return false;
    var s = storage();
    if (!s) return false;
    try { s.setItem(storeKey(), JSON.stringify(record())); return true; } catch (e) { return false; }
  }
  function saveSoon() {
    if (st.saveTimer) return;
    try {
      st.saveTimer = setTimeout(function () { st.saveTimer = 0; saveNow(); }, SAVE_MS);
      if (st.saveTimer && typeof st.saveTimer.unref === "function") st.saveTimer.unref();   // node: never keeps a process alive
    } catch (e) { st.saveTimer = 0; saveNow(); }
  }

  // ---- showing a tab

  // The place of the book that is on screen now, for the tab that shows it.
  function readerPosition(collectionId) {
    try {
      var cur = M.app && typeof M.app.current === "function" ? M.app.current() : null;
      if (!cur || cur.screen !== "reader" || cur.collectionId !== collectionId) return null;
      return M.reader && typeof M.reader.position === "function" ? validPosition(M.reader.position()) : null;
    } catch (e) { return null; }
  }

  // Is this book on screen with its document loaded? (A book that still loads, or whose open another open replaced,
  // is not: M.reader.isOpen.)
  function bookOpen(collectionId) {
    try {
      var cur = M.app && typeof M.app.current === "function" ? M.app.current() : null;
      if (!cur || cur.screen !== "reader" || cur.collectionId !== collectionId) return false;
      return !!(M.reader && typeof M.reader.isOpen === "function" && M.reader.isOpen(collectionId));
    } catch (e) { return false; }
  }

  // The prompt editor that is open in the book on screen, as M.margin.openEditor takes it again (null: none).
  function readerEditing(collectionId) {
    try {
      if (!bookOpen(collectionId)) return null;
      return M.margin && typeof M.margin.editing === "function" ? (M.margin.editing() || null) : null;
    } catch (e) { return null; }
  }

  // A text field that has the focus (a name being changed, the page box) takes its text before the screen goes: its
  // own blur handler does that. The prompt editor needs nothing: its text is its draft.
  function blurField() {
    try {
      var d = doc(), a = d ? d.activeElement : null, tag = a && a.tagName ? String(a.tagName).toUpperCase() : "";
      if (a && (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") && typeof a.blur === "function") a.blur();
    } catch (e) { /* no focus to move */ }
  }

  // The active tab is about to leave the screen: a book tab remembers where it is (the place it was shown with while
  // its book is still loading and has no place of its own yet) and the prompt editor that is open in it (the editor
  // it still has to bring back, while its book never got as far as open).
  function leaveActive(going) {
    var t = activeTab();
    st.left = t;
    if (!t) return;
    blurField();
    if (t.screen === "reader") {
      t.position = readerPosition(t.collectionId) || t.shown || null;
      t.editing = readerEditing(t.collectionId) || t.editing || null;
      // what the book showed, for the picture of a dragged tab (not for a tab that leaves this window for good)
      if (!going) t.shot = readerShot(t.collectionId) || t.shot || null;
    } else { t.position = null; t.editing = null; }
    t.shown = null;
  }

  // The tab on screen has a prompt editor to bring back, and its book is open: open it, once. The reader closed that
  // editor with its book, and the editor kept what was typed as its draft (js/editor.js), so it opens with that text.
  // Called when the route to the tab is done and on doc:opened (a route's promise can come before its book is open:
  // the same book was loading already, or a newer open replaced this one); and when a review ends.
  function restoreEditor() {
    var t = activeTab();
    if (!t || !t.editing || t.screen !== "reader" || blocked() || !bookOpen(t.collectionId)) return false;
    var editing = t.editing;
    t.editing = null;                                       // once, whatever the margin answers
    try {
      if (!M.margin || typeof M.margin.openEditor !== "function") return false;
      if (typeof M.margin.activeEditor === "function" && M.margin.activeEditor()) return false;   // one is open already
      return !!M.margin.openEditor(editing);
    } catch (e) { report("editor", e); return false; }
  }

  // Route the page to a tab. Its stored place and its prompt are used once: while a tab is on screen the reader
  // holds its place. Its editor stays with the tab until restoreEditor has opened it.
  function show(t, extra) {
    if (!t) return;
    // The tab that just left shows the same book: the reader keeps that book open, and its editor with it. The
    // editor is on screen still, so the tab that left has none to bring back.
    var left = st.left;
    st.left = null;
    if (left && left !== t && left.editing && t.screen === "reader" && left.screen === "reader" && left.collectionId === t.collectionId) left.editing = null;
    var params = { collectionId: t.collectionId, replace: true };
    if (t.promptId) { params.promptId = t.promptId; t.editing = null; }   // a tab asked to show one prompt shows that prompt
    if (t.position) params.position = t.position;
    if (extra && extra.fromHistory) params.fromHistory = true;
    t.shown = t.position || null;
    t.position = null;
    t.promptId = null;
    try {
      if (M.app && typeof M.app.route === "function") {
        Promise.resolve(M.app.route(t.screen, params)).then(function (ok) {
          if (ok === true) restoreEditor();
        }).catch(function (e) { report("route", e); });
      }
    } catch (e) { report("route", e); }
  }

  // A place asked from outside (a link, the address at boot) picks its tab: a tab that shows that book or deck
  // already, else the active tab when it is a library tab, else a new tab after the active one. That tab becomes active.
  function target(want, promptId) {
    var t = null, a = activeTab();
    if (a && samePlace(a, want)) t = a;
    for (var i = 0; !t && i < st.tabs.length; i++) if (samePlace(st.tabs[i], want)) t = st.tabs[i];
    if (!t && a && a.screen === "library") { t = a; t.screen = want.screen; t.collectionId = want.collectionId; t.position = null; t.editing = null; }
    if (!t) {
      t = make(want);
      if (st.tabs.length >= TABS_MAX) {                     // no room for a tab: the tab on screen takes the place, and says so
        t = a || st.tabs[0]; t.screen = want.screen; t.collectionId = want.collectionId; t.position = null; t.editing = null; t.shot = null;
        toast(TABS_MAX + " tabs are open: this tab took the link");
      }
      else st.tabs = after(st.tabs, st.active, t);
    }
    t.promptId = promptId == null || promptId === "" ? null : String(promptId);
    st.active = t.id;
    return t;
  }

  // ---------------------------------------------------------------- api

  // Boot (M.app): the stored tabs come back. `route` is what the address asks for; explicit = it names a place (a
  // link), which then goes before the stored active tab. → the first route {screen, collectionId, promptId, position}.
  // It never routes itself.
  function start(route, explicit) {
    var want = placeOf(route), saved = clean(readStored(), collectionOf);
    st.tabs = saved.tabs.map(function (s) { var t = make(s); t.position = s.position; t.editing = s.editing || null; return t; });
    st.active = st.tabs.length ? st.tabs[saved.active].id : null;
    st.closed = [];
    st.gone = false;
    st.fresh = !st.tabs.length && !explicit;                // nothing of its own to show: the library
    var promptId = route && route.promptId != null && route.promptId !== "" ? String(route.promptId) : null;
    if (!st.tabs.length) { var first = make(want); first.promptId = promptId; st.tabs = [first]; st.active = first.id; }
    else if (explicit) target(want, promptId);
    st.started = true;
    bind();
    startWindow();
    var a = activeTab(), out = { screen: a.screen, collectionId: a.collectionId, promptId: a.promptId, position: a.position };
    a.shown = a.position || null;
    a.position = null;
    a.promptId = null;
    render();
    saveSoon();
    return out;
  }

  // app:routed: the active tab takes the place the page went to.
  function onRouted(e) {
    if (!st.started) return;
    var t = activeTab(), now = place(e);
    if (!t || samePlace(t, now)) return;
    t.screen = now.screen;
    t.collectionId = now.collectionId;
    t.position = null;
    t.promptId = null;
    t.shown = null;
    t.editing = null;
    t.shot = null;
    render();
    saveSoon();
  }

  function select(id) {
    if (!st.started || id === st.active || indexOf(st.tabs, id) < 0 || blocked()) return false;
    leaveActive();
    st.active = id;
    render();
    saveSoon();
    show(activeTab());
    return true;
  }

  // A new tab after the active one. {background: true}: it does not become active. → its id, or null (not started,
  // or TABS_MAX tabs are open).
  function open(p, opts) {
    if (!st.started || blocked()) return null;
    if (st.tabs.length >= TABS_MAX) { toast("Close a tab first: " + TABS_MAX + " tabs are open"); return null; }
    var t = make(placeOf(p));
    t.promptId = p && p.promptId != null && p.promptId !== "" ? String(p.promptId) : null;
    st.tabs = after(st.tabs, st.active, t);
    if (opts && opts.background) { render(); saveSoon(); return t.id; }
    leaveActive();
    st.active = t.id;
    render();
    saveSoon();
    show(t);
    return t.id;
  }

  // false with one tab left: the last tab is not the page's to close.
  function close(id) {
    if (!st.started || st.tabs.length < 2 || blocked()) return false;
    var i = indexOf(st.tabs, id);
    if (i < 0) return false;
    var wasActive = id === st.active, t = st.tabs[i];
    if (wasActive) leaveActive(true);
    var r = without(st.tabs, st.active, id);
    // The tab that takes the screen shows the same book: the reader keeps the book and its editor on screen, so the
    // closed tab has no editor to bring back (the user goes on with it, and may save it, in the other tab).
    var next = wasActive ? r.tabs[indexOf(r.tabs, r.active)] : null;
    var stays = !!next && t.screen === "reader" && next.screen === "reader" && next.collectionId === t.collectionId;
    st.closed.push({ screen: t.screen, collectionId: t.collectionId, position: t.position, editing: stays ? null : (t.editing || null) });
    while (st.closed.length > CLOSED_MAX) st.closed.shift();
    st.tabs = r.tabs;
    st.active = r.active;
    render();
    saveSoon();
    if (wasActive) show(activeTab());
    return true;
  }

  function reopen() {
    if (!st.started || blocked()) return false;
    while (st.closed.length) {
      var c = st.closed.pop();
      if ((c.screen === "reader" || c.screen === "deck") && !collectionOf(c.collectionId)) continue;   // its book is gone
      if (st.tabs.length >= TABS_MAX) { st.closed.push(c); toast("Close a tab first: " + TABS_MAX + " tabs are open"); return false; }
      var t = make(place(c));
      t.position = validPosition(c.position);
      t.editing = c.editing || null;
      st.tabs = after(st.tabs, st.active, t);
      leaveActive();
      st.active = t.id;
      render();
      saveSoon();
      show(t);
      return true;
    }
    return false;
  }

  // A tab command by its id (M.keys.TABS_MAP; the Mac app's Window menu). → true when it did something.
  function run(id) {
    if (!st.started || blocked()) return false;
    if (id === "newTab") return open({ screen: "library" }, {}) !== null;
    if (id === "closeTab") return close(st.active);
    if (id === "reopenTab") return reopen();
    if (id === "nextTab" || id === "prevTab") {
      if (st.tabs.length < 2) return false;
      select(step(st.tabs, st.active, id === "nextTab" ? 1 : -1));
      return true;
    }
    var n = id === "lastTab" ? 9 : (/^tab[1-8]$/.test(String(id)) ? Number(String(id).slice(3)) : 0);
    if (!n) return false;
    var want = nth(st.tabs, n);
    if (!want) return false;
    select(want);                                           // the tab that is on screen already: nothing to do
    return true;
  }

  // M.app's keydown listener asks first. In the Mac app the menu runs MENU_KEYS (through run), so the page leaves
  // them alone there; it only swallows a held one (a key the page takes never reaches the menu), so a held key acts
  // once there too. Cmd+W with one tab is not the page's key.
  function handleKey(ev) {
    if (!st.started || !ev) return false;
    var K = tryDep("keys");
    if (!K || !K.TABS_MAP || typeof K.dispatch !== "function") return false;
    if (isApp() && typeof K.match === "function" && K.match(ev, MENU_KEYS)) return ev.repeat === true;
    var id = K.dispatch(ev, [K.TABS_MAP]) || bracketKey(ev, K);
    if (!id || blocked()) return false;
    if (id === "closeTab" && st.tabs.length < 2) return false;
    if (ev.repeat) return true;                             // a held key acts once
    return run(id);
  }

  // Cmd+Shift+] and Cmd+Shift+[ by the keys' place on the keyboard (ev.code), for an engine that reports the key as
  // "]" with Shift instead of "}" (M.keys.TABS_MAP has "Mod+}" and "Mod+{").
  function bracketKey(ev, K) {
    if (!ev || ev.shiftKey !== true || ev.altKey === true || (ev.code !== "BracketRight" && ev.code !== "BracketLeft")) return null;
    var mac = true;
    try { mac = typeof K.isMac !== "function" || K.isMac() === true; } catch (e) { mac = true; }
    if (mac ? !(ev.metaKey === true && ev.ctrlKey !== true) : !(ev.ctrlKey === true && ev.metaKey !== true)) return null;
    return ev.code === "BracketRight" ? "nextTab" : "prevTab";
  }

  // Is this click a "new tab" click? Cmd on the Mac, Ctrl elsewhere.
  function newTabClick(ev) {
    if (!ev) return false;
    var K = tryDep("keys"), mac = true;
    try { mac = !K || typeof K.isMac !== "function" || K.isMac() === true; } catch (e) { mac = true; }
    return mac ? ev.metaKey === true : ev.ctrlKey === true;
  }

  // Will go() open a tab for this click?
  function wantsTab(ev) { return st.started && newTabClick(ev) && !blocked(); }

  // For the click handlers that open a place: a Cmd+click opens it in a new tab (in the background; with Shift it
  // becomes active) and returns true; any other click routes as before and returns false.
  function go(ev, screen, params) {
    var p = params || {};
    if (wantsTab(ev)) {
      open({ screen: screen, collectionId: p.collectionId, promptId: p.promptId }, { background: ev.shiftKey !== true });
      return true;
    }
    try { if (M.app && typeof M.app.route === "function") M.app.route(screen, p); } catch (e) { report("route", e); }
    return false;
  }

  // A link from outside (M.app on a hashchange). → true when this module routed; false: M.app routes as before.
  function link(route) {
    if (!st.started || blocked()) return false;
    leaveActive();
    var t = target(placeOf(route), route ? route.promptId : null);
    render();
    saveSoon();
    show(t, { fromHistory: !!(route && route.fromHistory) });
    return true;
  }

  function list() {
    return st.tabs.map(function (t) {
      return { id: t.id, screen: t.screen, collectionId: t.collectionId, title: titleOf(t), active: t.id === st.active };
    });
  }

  // ---------------------------------------------------------------- windows (D31; the Mac app)

  // What the windows say to each other about tabs, each with the drag's number: {type: "took", drag}: the window
  // that says it took the tab of that drag into its strip; {type: "letgo", drag, x, y}: the tab was let go on the
  // page of the window that says it, at that point of the screen. (The library has its own channel, M.store's.)
  function tabChannel() {
    if (st.channel !== undefined) return st.channel;
    st.channel = null;
    try {
      if (windows() && typeof root.BroadcastChannel === "function") {
        st.channel = new root.BroadcastChannel(CHANNEL);
        st.channel.addEventListener("message", onTabMessage);
      }
    } catch (e) { st.channel = null; }
    return st.channel;
  }
  function onTabMessage(ev) {
    var d = ev && ev.data;
    if (!d || typeof d.drag !== "string" || (d.type !== "took" && d.type !== "letgo")) return;
    // The word is about the tab that was dragged out of this window, before or after the drag's end. (The drag is
    // over for this page then, whether a dragend follows or not: the strip is drawn again here, and the element
    // that was dragged leaves the page.)
    var drag = st.drag, sent = st.sent, was = st.was, id = null;
    if (drag && drag.nonce === d.drag) { st.drag = null; undim(); id = drag.id; }
    else if (sent && sent.nonce === d.drag) { st.sent = null; id = sent.id; }
    else if (was && was.nonce === d.drag) { st.was = null; id = was.id; }   // the drag that this page took for over went on
    if (id === null) return;
    // "took": another window took the tab into its strip: only now does the tab leave this window
    if (d.type === "took") { takeOut(id); return; }
    // "letgo": the tab was let go on another window's page: it gets a window of its own at that point
    moveToWindow(id, isNum(d.x) && isNum(d.y) ? { x: d.x, y: d.y } : null);
  }

  // The first window takes over the lists of windows that are gone: every key "marginalia.tabs.<id>" whose window
  // nobody holds (the app was quit with several windows open). Their book and deck tabs come after its own, as far
  // as TABS_MAX allows; what finds no room stays stored under its key, for a later start. When this window had
  // nothing of its own to show, they take its place. (M.app holds the Web Lock "marginalia.window.<id>" of this
  // page from the first moment of its start.)
  function startWindow() {
    if (!windows()) return;
    tabChannel();
    if (windowId()) return;
    var fresh = st.fresh;
    Promise.resolve().then(function () { return M.store.held(); }).then(function (held) {
      if (!Array.isArray(held) || !st.started) return;
      var s = storage(), keys = [];
      try { for (var i = 0; s && i < s.length; i++) { var k = s.key(i); if (typeof k === "string" && k.indexOf(STORE_KEY + ".") === 0) keys.push(k); } }
      catch (e) { keys = []; }
      // this window has only its first library tab, and the user has not gone anywhere: that tab makes way, and does
      // not count against TABS_MAX
      var only = st.tabs[0];
      var lone = fresh && st.tabs.length === 1 && activeTab() === only && only.screen === "library" && !blocked();
      var room = TABS_MAX - (lone ? 0 : st.tabs.length), came = [];
      keys.sort().forEach(function (k) {
        var id = k.slice(STORE_KEY.length + 1);
        if (!WINDOW_RE.test(id) || held.indexOf("window." + id) >= 0) return;     // not a window's key, or its window is there
        // a library tab holds nothing to bring back
        var list = clean(readStored(k), collectionOf).tabs.filter(function (x) { return x.screen !== "library"; });
        var take = list.slice(0, Math.max(0, room)), rest = list.slice(take.length);
        // the key first: when it cannot be written, the whole list stays for the next start, and no tab of it comes
        // in now (else those tabs would come a second time then)
        try {
          if (rest.length) {
            s.setItem(k, JSON.stringify({ v: 1, active: 0,
              tabs: rest.map(function (x) { return { screen: x.screen, collectionId: x.collectionId, position: x.position || null }; }) }));
          } else s.removeItem(k);
        } catch (e2) { return; }
        room -= take.length;
        take.forEach(function (x) {
          var t = make(x);
          t.position = x.position;
          t.editing = x.editing || null;
          came.push(t);
        });
      });
      if (!came.length) return;
      if (lone) {
        st.tabs = came;
        st.active = came[0].id;
        render();
        saveSoon();
        show(came[0]);
        return;
      }
      st.tabs = st.tabs.concat(came);
      render();
      saveSoon();
    }).then(null, function (e) { report("windows", e); });
  }

  // The tabs of this window as another window can take them: [{screen, collectionId, position, editing}], in order.
  // The tab on screen gives the place and the editor it has now. null while a review or a dialog is on screen here:
  // then this window's tabs stay where they are. drop() goes by the tabs of the last dump().
  function dump() {
    if (!st.started || blocked()) return null;
    var a = activeTab();
    st.dumped = st.tabs.map(function (t) { return t.id; });
    return st.tabs.map(function (t) {
      var position = t.position || null, editing = t.editing || null;
      if (t === a && t.screen === "reader") {
        position = readerPosition(t.collectionId) || t.shown || null;
        editing = readerEditing(t.collectionId) || t.editing || null;
      }
      return { screen: t.screen, collectionId: t.collectionId, position: position, editing: editing };
    });
  }

  // Tabs from another window come in: after the tab on screen, or at `index`; as many as TABS_MAX allows; only tabs
  // of this library as this page knows it (a book that is gone, or that this page has not read yet, gives no tab).
  // With {active: true} the first of them is shown. → the indexes of `list` that came in.
  function takeIn(list, index, opts) {
    if (!st.started || !Array.isArray(list)) return [];
    var at = isNum(index) ? Math.max(0, Math.min(st.tabs.length, Math.floor(index))) : indexOf(st.tabs, st.active) + 1;
    var made = [], took = [], wanted = 0;
    for (var i = 0; i < list.length; i++) {
      var x = clean({ tabs: [list[i]], active: 0 }, collectionOf).tabs[0];
      if (!x) continue;
      wanted++;
      if (st.tabs.length + made.length >= TABS_MAX) continue;
      var t = make(x);
      t.position = x.position;
      t.editing = x.editing || null;
      made.push(t);
      took.push(i);
    }
    if (!made.length) { if (wanted) toast("Close a tab first: " + TABS_MAX + " tabs are open"); return []; }
    st.tabs = st.tabs.slice(0, at).concat(made, st.tabs.slice(at));
    if (opts && opts.active && !blocked()) {
      leaveActive();
      st.active = made[0].id;
      render();
      saveSoon();
      show(made[0]);
    } else { render(); saveSoon(); }
    return took;
  }
  // → how many came in. Nothing comes in while a review or a dialog is on screen.
  function adopt(list, index, opts) { return blocked() ? 0 : takeIn(list, index, opts).length; }
  // Window › Merge All Windows: as adopt(list), but → the indexes of `list` that came in. The Mac app lets the
  // other window drop exactly those: a tab that found no room here, or that this page does not know, stays there.
  function take(list) { return blocked() ? [] : takeIn(list); }

  // The tabs that another window took leave this window: `indexes` are indexes of the last dump() (what take()
  // answered there). → how many tabs are left; 0 = nothing is left, and this window's list is forgotten (the Mac
  // app then closes the window); -1 = nothing to go by (no list of indexes, or no dump() before).
  function drop(indexes) {
    if (!st.started || !Array.isArray(indexes) || !Array.isArray(st.dumped)) return -1;
    var dumped = st.dumped, ids = [];
    st.dumped = null;
    indexes.forEach(function (i) {
      if (isNum(i) && i === Math.floor(i) && i >= 0 && i < dumped.length && ids.indexOf(dumped[i]) < 0) ids.push(dumped[i]);
    });
    var stays = function (t) { return ids.indexOf(t.id) < 0; };
    var rest = st.tabs.filter(stays);
    if (rest.length === st.tabs.length) return st.tabs.length;
    if (!rest.length) { forget(); return 0; }
    var wasActive = !stays(activeTab());
    if (wasActive) {
      leaveActive(true);
      // the tab that takes the screen: the next one that stays, else the last one that stays
      var next = null;
      for (var j = indexOf(st.tabs, st.active) + 1; j < st.tabs.length && !next; j++) if (stays(st.tabs[j])) next = st.tabs[j];
      st.active = (next || rest[rest.length - 1]).id;
    }
    st.tabs = rest;
    render();
    saveSoon();
    if (wasActive) show(activeTab());
    return st.tabs.length;
  }

  // This window is closing for good: its list goes (its tabs are not wanted back at the next start).
  function forget() {
    if (st.saveTimer) { try { clearTimeout(st.saveTimer); } catch (e) { /* gone */ } st.saveTimer = 0; }
    st.gone = true;
    var s = storage();
    if (!s) return false;
    try { s.removeItem(storeKey()); return true; } catch (e) { return false; }
  }

  function newWindowId() {
    var out = "", abc = "abcdefghijklmnopqrstuvwxyz0123456789";
    try {
      var bytes = new Uint8Array(10);
      root.crypto.getRandomValues(bytes);
      for (var i = 0; i < bytes.length; i++) out += abc[bytes[i] % abc.length];
    } catch (e) {
      out = "";
      for (var j = 0; j < 10; j++) out += abc[Math.floor(Math.random() * abc.length)];
    }
    return out;
  }

  // A tab goes to a window of its own (Window › Move Tab to New Window; a tab dragged out of the strip): the new
  // window's list (that one tab, with its place and its editor) is written under a new id, then the window is asked
  // for ("?w=<id>"; the Mac app's main process makes it), then the tab leaves this window. `pos` {x, y}: where on
  // the screen (the drop); else next to this window. → Promise<boolean>. Nothing happens (false) with one tab, while
  // blocked, outside the Mac app, or with WINDOWS_MAX windows open. When the new window does not show up in
  // WINDOW_WAIT_MS, its list is taken back and the tab stays here.
  function moveToWindow(id, pos) {
    var tabId = id || st.active, i = indexOf(st.tabs, tabId);
    if (!st.started || !windows() || blocked() || i < 0 || st.tabs.length < 2) return Promise.resolve(false);
    var store = M.store;
    return Promise.resolve().then(function () { return store.held(); }).then(function (held) {
      var open = Array.isArray(held) ? held.filter(function (n) { return n.indexOf("window.") === 0; }).length : 1;
      if (open >= WINDOWS_MAX) { toast("Close a window first: " + WINDOWS_MAX + " windows are open"); return false; }
      i = indexOf(st.tabs, tabId);
      if (i < 0 || st.tabs.length < 2 || blocked()) return false;
      var t = st.tabs[i], wasActive = tabId === st.active;
      if (wasActive) leaveActive(true);
      var r = without(st.tabs, st.active, tabId);
      // the tab that takes the screen here shows the same book: the editor stays on screen here, so the tab that
      // goes takes none along (as a tab that is closed, close())
      var next = wasActive ? r.tabs[indexOf(r.tabs, r.active)] : null;
      var stays = !!next && t.screen === "reader" && next.screen === "reader" && next.collectionId === t.collectionId;
      var w = newWindowId(), s = storage();
      var record = { v: 1, tabs: [{ screen: t.screen, collectionId: t.collectionId, position: t.position || null, editing: stays ? null : (t.editing || null) }], active: 0 };
      try { s.setItem(keyOf(w), JSON.stringify(record)); } catch (e) { toast("The window could not be opened"); return false; }
      if (!openWindow(w, pos)) { try { s.removeItem(keyOf(w)); } catch (e2) { /* stays for the next start */ } return false; }
      st.tabs = r.tabs;
      st.active = r.active;
      render();
      saveSoon();
      if (wasActive) show(activeTab());
      // the new window did not come (the app refused it): its list comes back as a tab of this window
      waitForWindow(w, record);
      return true;
    }).then(null, function (e) { report("moveToWindow", e); return false; });
  }

  // window.open for "?w=<id>": in the Mac app its answer is always null (the main process makes the window itself),
  // so a throw is the only failure seen here; waitForWindow sees the rest.
  function openWindow(w, pos) {
    try {
      var loc = root.location, url = (loc && loc.pathname ? loc.pathname : "/") + "?w=" + w;
      var width = isNum(root.outerWidth) && root.outerWidth > 0 ? Math.round(root.outerWidth) : 1100;
      var height = isNum(root.outerHeight) && root.outerHeight > 0 ? Math.round(root.outerHeight) : 800;
      var features = "popup=yes,width=" + width + ",height=" + height;
      if (pos && isNum(pos.x) && isNum(pos.y)) features += ",left=" + Math.round(pos.x - 80) + ",top=" + Math.round(pos.y - 20);
      if (typeof root.open !== "function") return false;
      root.open(url, "_blank", features);
      return true;
    } catch (e) { report("window.open", e); return false; }
  }

  // The new window says that it is there with its Web Lock, which its page takes first thing at its start, long
  // before it reads its list. So a list that this page takes back was not read by the new page.
  function waitForWindow(w, record) {
    var started = Date.now();
    var check = function () {
      Promise.resolve(M.store.held()).then(function (held) {
        if (Array.isArray(held) && held.indexOf("window." + w) >= 0) return;        // it is there
        if (Date.now() - started < WINDOW_WAIT_MS) { timer(check, 250); return; }
        var s = storage(), raw = null;
        try { raw = s.getItem(keyOf(w)); s.removeItem(keyOf(w)); } catch (e) { raw = null; }
        if (raw === null) return;                             // another page took the list over
        takeIn(record.tabs);                                  // also behind a dialog: the tab must not be lost
        toast("The new window did not open: its tab is back in this window");
      }).then(null, function (e) { report("windows", e); });
    };
    timer(check, 250);
  }
  function timer(fn, ms) {
    try { var id = setTimeout(fn, ms); if (id && typeof id.unref === "function") id.unref(); } catch (e) { /* no timers */ }
  }

  // ---- a tab that is dragged (HTML drag and drop on the strip)
  // Along its own strip the tab takes another place (everywhere). In the Mac app it also goes into another window
  // (dropped on that window's strip) or becomes a window of its own (dropped outside every window).
  // A tab leaves its window only when another window SAYS that it took the tab ("took" on the channel, with the
  // drag's number): what the drag's end reports (dropEffect) is not proof. So a drop that took nothing (a strip that
  // is full, a window that does not know the book, another program) leaves the tab where it was.

  // What travels with the drag: this window, the tab's id here, the drag's number, and the tab as another window can
  // take it (dump()'s shape). The tab on screen gives the place it has now, and its open editor, unless the tab that
  // takes its place here shows the same book: then the editor stays on screen in this window (as when such a tab is
  // closed).
  function dragData(t, nonce) {
    var a = activeTab(), position = t.position || null, editing = t.editing || null;
    if (t === a && t.screen === "reader") {
      position = readerPosition(t.collectionId) || t.shown || null;
      var r = without(st.tabs, st.active, t.id), next = r.tabs[indexOf(r.tabs, r.active)] || null;
      var stays = !!next && next.screen === "reader" && next.collectionId === t.collectionId;
      editing = stays ? null : (readerEditing(t.collectionId) || t.editing || null);
    }
    return { w: windowId() || "", id: t.id, drag: nonce, tab: { screen: t.screen, collectionId: t.collectionId, position: position, editing: editing } };
  }

  function carriesTab(ev) {
    try {
      var types = ev && ev.dataTransfer ? ev.dataTransfer.types : null;
      return !!types && Array.prototype.indexOf.call(types, TAB_TYPE) >= 0;
    } catch (e) { return false; }
  }

  // Where a tab dropped at this point of the strip goes: before the first tab whose middle is right of the pointer.
  function dropIndex(ev) {
    var el = host(), tabsEls = el ? Array.prototype.slice.call(el.querySelectorAll(".tabs__tab")) : [];
    for (var i = 0; i < tabsEls.length; i++) {
      var r = null;
      try { r = tabsEls[i].getBoundingClientRect(); } catch (e) { r = null; }
      if (r && isNum(ev.clientX) && ev.clientX < r.left + r.width / 2) return i;
    }
    return tabsEls.length;
  }

  // The mark that shows where the tab would go: on the tab it would stand before, or on "+" at the end.
  function markDrop(index) {
    var el = host();
    if (!el) return;
    var tabsEls = Array.prototype.slice.call(el.querySelectorAll(".tabs__tab")), plus = el.querySelector(".tabs__new");
    tabsEls.forEach(function (x, i) { try { if (i === index) x.classList.add("is-drop"); else x.classList.remove("is-drop"); } catch (e) { /* no classList */ } });
    if (plus) { try { if (index !== null && index >= tabsEls.length) plus.classList.add("is-drop"); else plus.classList.remove("is-drop"); } catch (e2) { /* no classList */ } }
  }

  function onDragStart(ev, t, el) {
    if (!ev || !ev.dataTransfer || blocked()) { try { ev.preventDefault(); } catch (e) { /* synthetic */ } return; }
    var nonce = newWindowId();
    try {
      ev.dataTransfer.setData(TAB_TYPE, JSON.stringify(dragData(t, nonce)));
      ev.dataTransfer.setData(DRAG_TYPE + nonce, "1");
      ev.dataTransfer.effectAllowed = "move";
    } catch (e2) { try { ev.preventDefault(); } catch (e3) { /* synthetic */ } return; }   // no drag that carries half of this
    st.drag = { id: t.id, nonce: nonce, el: el || null };  // el: the tab's element, to which the drag's end comes
    st.sent = null;
    st.was = null;
    showDragImage(ev, t);
    dim(t.id);
  }

  // What the book of the tab on screen shows now, as a small canvas (M.reader.snapshot), or null.
  function readerShot(collectionId) {
    try {
      if (!bookOpen(collectionId) || !M.reader || typeof M.reader.snapshot !== "function") return null;
      return M.reader.snapshot(SHOT_W, SHOT_H - SHOT_BAR) || null;
    } catch (e) { return null; }
  }

  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }
  function fitText(g, text, max) {
    var s = String(text == null ? "" : text);
    if (g.measureText(s).width <= max) return s;
    while (s.length > 1 && g.measureText(s + "\u2026").width > max) s = s.slice(0, -1);
    return s + "\u2026";
  }

  // The small picture of a tab: a little window with the tab's name on its bar and, under it, what the tab shows
  // (a book's pages, when a picture of them is there; else the kind of place). → a canvas, or null without one (an
  // engine without canvas, a test page): then the system shows the tab itself.
  function tabPicture(t) {
    var d = doc();
    if (!d || typeof d.createElement !== "function") return null;
    var c = d.createElement("canvas"), g = c && typeof c.getContext === "function" ? c.getContext("2d") : null;
    if (!g) return null;
    var dpr = isNum(root.devicePixelRatio) && root.devicePixelRatio > 0 ? Math.min(3, root.devicePixelRatio) : 1;
    c.width = Math.round(SHOT_W * dpr);
    c.height = Math.round(SHOT_H * dpr);
    c.style.width = SHOT_W + "px";
    c.style.height = SHOT_H + "px";
    g.scale(dpr, dpr);
    var css = null;
    try { css = root.getComputedStyle(d.documentElement); } catch (e) { css = null; }
    var color = function (name, fallback) {
      var v = "";
      try { v = css ? String(css.getPropertyValue(name) || "").trim() : ""; } catch (e) { v = ""; }
      return v || fallback;
    };
    roundRect(g, 0.5, 0.5, SHOT_W - 1, SHOT_H - 1, 8);
    g.save();
    g.clip();
    g.fillStyle = color("--bg", "#efece4");
    g.fillRect(0, 0, SHOT_W, SHOT_H);
    var shot = t === activeTab() ? (readerShot(t.collectionId) || t.shot) : t.shot, drew = false;
    if (shot && shot.width > 0 && shot.height > 0) {
      try { g.drawImage(shot, 0, SHOT_BAR, SHOT_W, SHOT_W * shot.height / shot.width); drew = true; } catch (e2) { drew = false; }
    }
    if (!drew) {
      g.fillStyle = color("--ink-3", "#8f8a7f");
      g.font = "13px system-ui, -apple-system, sans-serif";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(t.screen === "library" ? "Library" : t.screen === "stats" ? "Statistics" : t.screen === "deck" ? "Deck" : "Book", SHOT_W / 2, SHOT_BAR + (SHOT_H - SHOT_BAR) / 2);
    }
    g.fillStyle = color("--surface", "#faf8f3");
    g.fillRect(0, 0, SHOT_W, SHOT_BAR);
    g.fillStyle = color("--line", "#ddd7ca");
    g.fillRect(0, SHOT_BAR - 1, SHOT_W, 1);
    g.fillStyle = color("--ink", "#1f1d1a");
    g.font = "600 12px system-ui, -apple-system, sans-serif";
    g.textAlign = "left";
    g.textBaseline = "middle";
    g.fillText(fitText(g, titleOf(t), SHOT_W - 24), 12, SHOT_BAR / 2);
    g.restore();
    g.strokeStyle = color("--ink-3", "#8f8a7f");
    g.lineWidth = 1;
    roundRect(g, 0.5, 0.5, SHOT_W - 1, SHOT_H - 1, 8);
    g.stroke();
    return c;
  }

  // The picture follows the pointer while the tab is dragged, also outside the window (the system draws it), as
  // Preview shows a small window. It must be in the page for the moment in which the system takes it.
  function showDragImage(ev, t) {
    try {
      var d = doc(), dt = ev.dataTransfer;
      if (!d || !d.body || typeof dt.setDragImage !== "function") return false;
      var c = tabPicture(t);
      if (!c) return false;
      c.style.position = "fixed";
      c.style.left = "-10000px";
      c.style.top = "0";
      c.style.pointerEvents = "none";
      d.body.appendChild(c);
      dt.setDragImage(c, 28, Math.round(SHOT_BAR / 2));
      timer(function () { try { if (c.parentNode) c.parentNode.removeChild(c); } catch (e) { /* gone */ } }, 0);
      return true;
    } catch (e2) { return false; }
  }

  // The tab that is dragged looks lifted out of its strip (a moment after the drag began: the strip must not change
  // while the system starts the drag); undim() when the drag is over.
  function tabElement(id) {
    var el = host(), list = el ? Array.prototype.slice.call(el.querySelectorAll(".tabs__tab")) : [];
    for (var i = 0; i < list.length; i++) { try { if (list[i].getAttribute("data-id") === id) return list[i]; } catch (e) { /* no attributes */ } }
    return null;
  }
  function dim(id) {
    timer(function () {
      if (!st.drag || st.drag.id !== id) return;
      var el = tabElement(id);
      if (el) { try { el.classList.add("is-dragging"); } catch (e) { /* no classList */ } }
    }, 0);
  }
  function undim() {
    var el = host(), list = el ? Array.prototype.slice.call(el.querySelectorAll(".tabs__tab")) : [];
    list.forEach(function (x) { try { x.classList.remove("is-dragging"); } catch (e) { /* no classList */ } });
  }

  function inStrip(node) {
    var el = host();
    try { for (var n = node; el && n; n = n.parentNode) if (n === el) return true; } catch (e) { /* no such node */ }
    return false;
  }
  // Is the pointer still close to the strip? A tab that is let go a little beside the strip was not meant to leave it.
  function nearStrip(ev) {
    var el = host(), r = null;
    try { r = el ? el.getBoundingClientRect() : null; } catch (e) { r = null; }
    if (!r || !isNum(ev.clientX) || !isNum(ev.clientY)) return false;
    return ev.clientY >= r.top - TEAR_PX && ev.clientY <= r.bottom + TEAR_PX && ev.clientX >= r.left - TEAR_PX && ev.clientX <= r.right + TEAR_PX;
  }

  // Is the tab of this event the one whose drag began in this page? (By the drag's own type: see DRAG_TYPE; no other
  // page can make that type.) A drag that this page took for over (endDrag) and that goes on all the same is this
  // page's own again: its tab never comes into its own window as the tab of another one.
  function carries(ev, drag) {
    try { return !!drag && Array.prototype.indexOf.call(ev.dataTransfer.types, DRAG_TYPE + drag.nonce) >= 0; } catch (e) { return false; }
  }
  function ownDrag(ev) {
    if (carries(ev, st.drag)) return true;
    if (st.drag || !carries(ev, st.was)) return false;
    st.drag = st.was;
    st.was = null;
    return true;
  }
  // This page's drag is over, and its end did not come here: the strip was drawn again during the drag, the tab's
  // element left the page, and an engine may then send no dragend. Seen by another drag's tab over this page or
  // dropped on it, or by the mouse (onMouse). The drag is kept (st.was) until the next one begins: when it goes on
  // all the same, its events (ownDrag), its end (onDragEnd) and a window's word about it (onTabMessage) still count.
  function endDrag() {
    if (!st.drag) return;
    st.was = st.drag;
    st.drag = null;
    markDrop(null);
    undim();
  }
  // No mouse event reaches a page while something is dragged; but an engine may send one in the first moment of a
  // drag. So a move or a press of the mouse ends this page's drag only when the element that was dragged is no
  // longer a tab of the strip: while it is one, the drag's end comes to it (dragend).
  function onMouse() {
    var drag = st.drag, el = host();
    if (!drag) return;
    var list = el ? el.querySelectorAll(".tabs__tab") : [];
    if (Array.prototype.indexOf.call(list, drag.el) < 0) endDrag();
  }

  // Does this window's strip take a tab of another window that is held here? On the strip, or close to it on the
  // page; never without room (TABS_MAX), never while blocked.
  function stripTakes(ev) {
    return !blocked() && !noRoom() && (inStrip(ev.target) || nearStrip(ev));
  }
  // The tab that was held over this page has left it, or its drag ended elsewhere: no dragover came for OVER_MS
  // (the page hears of neither). The mark in the strip goes, and the strip of a window with one tab.
  function overSoon() {
    if (st.dropTimer) { try { clearTimeout(st.dropTimer); } catch (e) { /* gone */ } }
    try {
      st.dropTimer = setTimeout(function () { st.dropTimer = 0; markDrop(null); endDropzone(); }, OVER_MS);
      if (st.dropTimer && typeof st.dropTimer.unref === "function") st.dropTimer.unref();
    } catch (e2) { st.dropTimer = 0; }
  }

  // A tab is let go on the page, not on a strip.
  // This window's own tab: close to the strip it takes its place there; else it gets a window of its own at that
  // point, at once (as when a tab is dragged down in Preview).
  // A tab of another window (the Mac app): close to this strip it comes into the strip (as a drop on it); else this
  // page tells the tab's window ("letgo", with the point), which gives the tab a window there. That is also so on a
  // strip that takes no tab (it has TABS_MAX tabs), and in a window with a dialog or a review up (it takes no tab,
  // but it can say where the tab was let go). So a tab that is let go on a Marginalia window gets a window, unless
  // a strip takes it.
  // The page takes these drops (onDocDragOver) so that a tab that is let go differs from a drag that is cancelled
  // with Escape: a cancelled drag gives no drop, and then nothing happens.
  function onDocDrop(ev) {
    if (!st.started || !carriesTab(ev)) return;
    if (!ownDrag(ev)) endDrag();                            // another drag's tab: this page's own drag is over
    var drag = st.drag;
    if (drag) {
      // this window's own tab: behind a dialog nothing happens; on the strip, the strip takes it (onDrop)
      if (blocked() || inStrip(ev.target)) return;
      try { ev.preventDefault(); ev.stopPropagation(); } catch (e) { /* synthetic */ }
      markDrop(null);
      st.drag = null;                                       // the drag is over for this page
      undim();
      if (nearStrip(ev)) { moveTab(drag.id, dropIndex(ev)); return; }
      moveToWindow(drag.id, isNum(ev.screenX) && isNum(ev.screenY) ? { x: ev.screenX, y: ev.screenY } : null);
      return;
    }
    if (!windows()) return;                                 // a tab of another window: the Mac app only
    var takes = stripTakes(ev);
    if (takes && inStrip(ev.target)) return;                // on the strip, which takes it (onDrop)
    // (where it would go, before the strip of a window with one tab goes again)
    var data = null, ch = tabChannel(), at = takes ? dropIndex(ev) : 0;
    try { data = JSON.parse(ev.dataTransfer.getData(TAB_TYPE)); } catch (e2) { data = null; }
    markDrop(null);
    endDropzone();
    if (!ch || !data || typeof data !== "object" || typeof data.drag !== "string" || !data.drag) return;
    try { ev.preventDefault(); ev.stopPropagation(); } catch (e3) { /* synthetic */ }
    if (takes) { takeFrom(data, at); return; }
    try { ch.postMessage({ type: "letgo", drag: data.drag, x: isNum(ev.screenX) ? ev.screenX : null, y: isNum(ev.screenY) ? ev.screenY : null }); }
    catch (e4) { report("letgo", e4); }
  }

  // A strip that is full takes no tab of another window: the page then takes the drop and says "letgo" (onDocDrop),
  // so the tab gets a window of its own.
  function noRoom() { return !st.drag && st.tabs.length >= TABS_MAX; }

  function onDragOver(ev) {
    if (!carriesTab(ev) || blocked()) return;
    if (!ownDrag(ev)) endDrag();                            // another drag's tab: this page's own drag is over
    if (noRoom()) return;
    if (!st.drag && !windows()) return;                     // a tab of another page: only between the app's windows
    try { ev.preventDefault(); } catch (e) { /* synthetic */ }   // this strip takes the tab
    try { ev.dataTransfer.dropEffect = "move"; } catch (e2) { /* read-only in some engines */ }
    markDrop(dropIndex(ev));
  }

  function onDrop(ev) {
    if (!carriesTab(ev) || blocked()) return;
    if (!ownDrag(ev)) endDrag();                            // another drag's tab: this page's own drag is over
    if (noRoom()) return;
    var data = null, at = dropIndex(ev);
    try { data = JSON.parse(ev.dataTransfer.getData(TAB_TYPE)); } catch (e) { data = null; }
    markDrop(null);
    endDropzone();
    if (!data || typeof data !== "object") return;
    var drag = st.drag;                                     // the drag that began in this page (ownDrag), or none
    if (!drag && !windows()) return;
    try { ev.preventDefault(); ev.stopPropagation(); } catch (e2) { /* synthetic */ }
    if (drag) {
      // Its own strip took the tab: for this page the drag is over, whether a dragend follows or not (the strip is
      // drawn again here, and the element that was dragged leaves the page).
      st.drag = null;
      undim();                                              // (a tab that is dropped where it is: nothing is drawn again)
      moveTab(drag.id, at);
      return;
    }
    takeFrom(data, at);
  }

  // A tab of another window was dropped on this strip. It comes in, on screen, and this window says so ("took"):
  // then the tab leaves its own window. It comes in AT the drop or not at all: the tab's own window decides a moment
  // after the drop what becomes of the tab, and a "took" that came later would leave the tab in two windows. When
  // this page does not know the tab's book (the page is not the writer, and the book is new), the tab stays in its
  // window; this page reads the library again (it takes the role) and says that the tab can be dragged once more.
  function takeFrom(data, at) {
    var nonce = typeof data.drag === "string" && data.drag ? data.drag : null, ch = tabChannel();
    if (!nonce || !ch) return;                              // nobody to tell: the tab stays in its window
    if (takeIn([data.tab], at, { active: true }).length) {
      try { ch.postMessage({ type: "took", drag: nonce }); } catch (e) { report("took", e); }
      return;
    }
    var want = clean({ tabs: [data.tab], active: 0 }, function (id) { return { id: id, kind: "book" }; }).tabs[0];
    var reader = false;
    try { reader = typeof M.store.writer === "function" && M.store.writer() !== true; } catch (e2) { reader = false; }
    if (!want || !want.collectionId || !reader || !M.app || typeof M.app.takeRole !== "function") return;
    Promise.resolve(M.app.takeRole()).then(function (ok) {
      if (ok === true && collectionOf(want.collectionId)) toast("Drag the tab once more: this window did not know that book yet");
    }).then(null, function (e3) { report("drop", e3); });
  }

  function onDragEnd(ev, t) {
    var drag = st.drag;
    if (!drag && st.was && st.was.id === t.id) drag = st.was;   // the drag that this page took for over went on, and ends now
    st.drag = null;
    st.was = null;
    markDrop(null);
    undim();
    if (!drag || drag.id !== t.id) return;                  // no drag of this tab, or a window took it already ("took")
    var effect = "none";
    try { effect = ev.dataTransfer.dropEffect; } catch (e) { effect = "none"; }
    // A window that took the tab says so; its word can come a moment after the drag's end (onTabMessage).
    st.sent = { nonce: drag.nonce, id: t.id };
    // Taken as a move, a copy or a link by something: by another window's strip (its "took" follows), or by another
    // program (nothing follows, and the tab stays). In a browser page there are no windows to go to.
    if (effect !== "none" || !windows()) return;
    // Dropped on nothing. Outside this window: a window of its own, at that point of the screen. It waits a moment
    // for a "took": an engine may report no effect for a drop that another window's strip did take.
    var x = ev.clientX, y = ev.clientY;
    var inside = isNum(x) && isNum(y) && x >= 0 && y >= 0 && x <= root.innerWidth && y <= root.innerHeight;
    if (inside) return;
    var pos = isNum(ev.screenX) && isNum(ev.screenY) ? { x: ev.screenX, y: ev.screenY } : null;
    timer(function () {
      if (!st.sent || st.sent.nonce !== drag.nonce) return; // a window took the tab meanwhile, or the next drag began
      st.sent = null;
      moveToWindow(t.id, pos);
    }, DROP_WAIT_MS);
  }

  // The tab takes another place in this strip: before the tab that is at `index` now.
  function moveTab(id, index) {
    var i = indexOf(st.tabs, id);
    if (i < 0) return false;
    var at = isNum(index) ? Math.max(0, Math.min(st.tabs.length, Math.floor(index))) : st.tabs.length;
    if (at === i || at === i + 1) return false;             // where it is already
    var t = st.tabs[i], rest = st.tabs.slice(0, i).concat(st.tabs.slice(i + 1));
    if (at > i) at--;
    st.tabs = rest.slice(0, at).concat([t], rest.slice(at));
    render();
    saveSoon();
    return true;
  }

  // The tab lives in another window now: it leaves this one (it is no closed tab: Cmd+Shift+T does not bring it back).
  function takeOut(id) {
    var i = indexOf(st.tabs, id);
    if (i < 0 || st.tabs.length < 2) return false;
    var wasActive = id === st.active;
    if (wasActive) leaveActive(true);
    var r = without(st.tabs, st.active, id);
    st.tabs = r.tabs;
    st.active = r.active;
    render();
    saveSoon();
    if (wasActive) show(activeTab());
    return true;
  }

  // A window with one tab shows no strip. While a tab of another window is dragged over it, the strip shows, as the
  // place to drop; it goes again a moment after the drag left the window or ended (overSoon).
  function onDocDragOver(ev) {
    if (!st.started || !carriesTab(ev)) return;
    if (!ownDrag(ev)) endDrag();                            // another drag's tab: this page's own drag is over
    overSoon();
    if (st.drag) {
      // this window's own tab over its page: the page takes it (see onDocDrop); over the strip, the strip does;
      // behind a dialog nothing does
      if (blocked() || inStrip(ev.target)) return;
      try { ev.preventDefault(); } catch (e3) { /* synthetic */ }
      try { ev.dataTransfer.dropEffect = "move"; } catch (e4) { /* read-only in some engines */ }
      markDrop(nearStrip(ev) ? dropIndex(ev) : null);
      return;
    }
    if (!windows()) return;
    // A tab of another window. On the strip, when the strip takes it: the strip's own handlers. Anywhere else the
    // page takes the drop: close to the strip (when the strip takes it) the tab comes into the strip, and the place
    // is marked; else the tab's own window gives the tab a window at that point (onDocDrop).
    var takes = stripTakes(ev);
    if (!takes || !inStrip(ev.target)) {
      try { ev.preventDefault(); } catch (e5) { /* synthetic */ }
      try { ev.dataTransfer.dropEffect = "move"; } catch (e6) { /* read-only in some engines */ }
      markDrop(takes ? dropIndex(ev) : null);
    }
    // a window with one tab shows its strip, as the place to drop (not while it takes no tab)
    if (!st.dropzone && st.tabs.length < 2 && !blocked()) { st.dropzone = true; render(); }
  }
  function endDropzone() {
    if (st.dropTimer) { try { clearTimeout(st.dropTimer); } catch (e) { /* gone */ } st.dropTimer = 0; }
    if (!st.dropzone) return;
    st.dropzone = false;
    render();
  }

  // The window's name: the tab on screen, then the app ("Griffiths — Marginalia"; the library: the app alone).
  function setTitle() {
    var d = doc(), a = activeTab();
    if (!d || !a || !st.started) return;
    var name = a.screen === "library" ? "" : titleOf(a);
    try { d.title = name ? name + " \u2014 " + APP_NAME : APP_NAME; } catch (e) { /* no title */ }
  }

  // ---------------------------------------------------------------- the strip

  function h(tag, attrs, children) {
    var el = doc().createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === "text") el.textContent = String(v);
      else el.setAttribute(k, String(v));
    });
    (children || []).forEach(function (c) { if (c) el.appendChild(c); });
    return el;
  }
  function on(el, type, fn) { try { el.addEventListener(type, fn); } catch (e) { /* no events */ } return el; }

  function render() {
    var el = host();
    if (!el) return false;
    // the keyboard focus is in the strip: it stays there, on the tab that is on screen after the redraw
    var d = doc(), hadFocus = false;
    try { hadFocus = !!d && !!d.activeElement && d.activeElement !== el && typeof el.contains === "function" && el.contains(d.activeElement); } catch (e0) { hadFocus = false; }
    setTitle();
    var shown = st.started && (st.tabs.length > 1 || st.dropzone);
    try { if (shown) el.classList.remove("is-hidden"); else el.classList.add("is-hidden"); } catch (e) { /* no classList */ }
    try { if (st.dropzone) el.classList.add("is-dropzone"); else el.classList.remove("is-dropzone"); } catch (e5) { /* no classList */ }
    // the strip goes (one tab left) while it has the focus: the focus leaves the button that is about to go
    if (hadFocus && !shown) { try { d.activeElement.blur(); } catch (e4) { /* not focusable */ } }
    while (el.firstChild) el.removeChild(el.firstChild);
    if (!shown) return true;
    var strip = h("div", { "class": "tabs__list", role: "tablist", "aria-label": "Tabs" }), activeEl = null;
    st.tabs.forEach(function (t) {
      var name = titleOf(t), active = t.id === st.active;
      var pick = on(h("button", {
        type: "button", "class": "tabs__select", role: "tab", "aria-selected": active ? "true" : "false",
        tabindex: active ? "0" : "-1", title: name, "data-id": t.id, text: name
      }), "click", function () { select(t.id); });
      var shut = on(h("button", { type: "button", "class": "tabs__close", "aria-label": "Close tab " + name, title: "Close tab", tabindex: "-1", text: "×" }),
        "click", function (ev) { try { ev.stopPropagation(); } catch (e) { /* synthetic */ } close(t.id); });
      var lifted = !!st.drag && st.drag.id === t.id;        // the tab that is being dragged looks lifted out of the strip
      var wrap = h("div", { "class": "tabs__tab" + (active ? " is-active" : "") + (lifted ? " is-dragging" : ""), role: "presentation", "data-id": t.id, draggable: "true" }, [pick, shut]);
      on(wrap, "dragstart", function (ev) { onDragStart(ev, t, wrap); });
      on(wrap, "dragend", function (ev) { onDragEnd(ev, t); });
      on(wrap, "auxclick", function (ev) {                  // a middle click closes the tab
        if (!ev || ev.button !== 1) return;
        try { ev.preventDefault(); } catch (e) { /* synthetic */ }
        close(t.id);
      });
      if (active) activeEl = wrap;
      strip.appendChild(wrap);
    });
    // Keys on a tab that has the focus: ← and → move the focus along the strip; Enter and Space show the tab; Delete
    // and Backspace close it. They stop here: M.app's listener would give them to the screen below (in the reader,
    // Enter shows a card's answer and Backspace deletes a card).
    on(strip, "keydown", function (ev) {
      if (!ev || ev.metaKey || ev.ctrlKey || ev.altKey) return;
      var picks = Array.prototype.slice.call(strip.querySelectorAll(".tabs__select")), i = picks.indexOf(ev.target);
      if (i < 0) return;
      var key = ev.key, arrow = key === "ArrowLeft" || key === "ArrowRight";
      var showKey = key === "Enter" || key === " " || key === "Spacebar", closeKey = key === "Delete" || key === "Backspace";
      if (!arrow && !showKey && !closeKey) return;
      try { ev.preventDefault(); ev.stopPropagation(); } catch (e) { /* synthetic */ }
      if (ev.repeat && !arrow) return;
      var id = ev.target.getAttribute("data-id");
      if (arrow) {
        if (picks.length < 2) return;
        var next = picks[(i + (key === "ArrowRight" ? 1 : picks.length - 1)) % picks.length];
        try { next.focus(); } catch (e2) { /* not focusable */ }
      }
      else if (showKey) select(id);
      else close(id);
    });
    el.appendChild(strip);
    el.appendChild(on(h("button", { type: "button", "class": "tabs__new", "aria-label": "New tab", title: "New tab", text: "+" }),
      "click", function () { run("newTab"); }));
    if (activeEl && typeof activeEl.scrollIntoView === "function") {
      try { activeEl.scrollIntoView({ block: "nearest", inline: "nearest" }); } catch (e) { /* old engine */ }
    }
    if (hadFocus && activeEl) {
      try { var pick = activeEl.querySelector(".tabs__select"); if (pick && typeof pick.focus === "function") pick.focus(); } catch (e3) { /* not focusable */ }
    }
    return true;
  }

  // ---------------------------------------------------------------- events

  function onCollectionDeleted(e) {
    var id = e && e.collectionId != null ? String(e.collectionId) : null;
    if (!id || !st.started) return;
    var changed = false;
    st.tabs.forEach(function (t) {
      if (t.collectionId !== id || t.id === st.active) return;    // the active tab: M.app routes it home (app:routed)
      t.screen = "library"; t.collectionId = null; t.position = null; t.promptId = null; t.editing = null; t.shot = null;
      changed = true;
    });
    st.closed = st.closed.filter(function (c) { return c.collectionId !== id; });
    if (changed) { render(); saveSoon(); }
  }

  function bind() {
    if (st.offs.length) return;
    var bus = tryDep("bus");
    if (bus && typeof bus.on === "function") {
      st.offs.push(bus.on("app:routed", onRouted));
      st.offs.push(bus.on("collection:changed", function () { if (st.started) render(); }));
      st.offs.push(bus.on("collection:deleted", onCollectionDeleted));
      st.offs.push(bus.on("doc:opened", function () { restoreEditor(); }));       // the book of the tab on screen is open
      st.offs.push(bus.on("review:ended", function () { restoreEditor(); }));     // nothing opens under a review
      st.offs.push(bus.on("scroll:settled", function () { if (st.started) saveSoon(); }));   // the place of the tab on screen
    }
    try {
      if (!st.unload && typeof root.addEventListener === "function") {
        st.unload = function () { saveNow(); };              // the last change is not lost when the window closes
        root.addEventListener("pagehide", st.unload);
      }
    } catch (e) { /* no window events */ }
    // D31: a dragged tab. The strip's host stays through every redraw, so its listeners are bound once.
    var el = host(), d = doc();
    if (el && !st.dragBound) {
      st.dragBound = true;
      on(el, "dragover", onDragOver);
      on(el, "drop", onDrop);
      on(el, "dragleave", function () { markDrop(null); });
      if (d && typeof d.addEventListener === "function") {
        try {
          d.addEventListener("dragover", onDocDragOver, true);
          d.addEventListener("drop", onDocDrop, true);
          d.addEventListener("mousemove", onMouse, true);     // a drag whose end never came is over (see onMouse)
          d.addEventListener("mousedown", onMouse, true);
        } catch (e2) { /* no events */ }
      }
    }
  }

  // Test hook: back to "not started" (listeners off, nothing stored).
  function reset() {
    while (st.offs.length) { var off = st.offs.pop(); try { if (typeof off === "function") off(); } catch (e) { /* gone */ } }
    try { if (st.unload && typeof root.removeEventListener === "function") root.removeEventListener("pagehide", st.unload); } catch (e2) { /* none */ }
    if (st.saveTimer) { try { clearTimeout(st.saveTimer); } catch (e3) { /* gone */ } }
    var bound = st.dragBound === true;                      // the host's and the document's drag listeners stay bound
    if (st.channel) { try { st.channel.close(); } catch (e4) { /* closed */ } }
    st = { tabs: [], active: null, closed: [], started: false, saveTimer: 0, n: 0, offs: [], unload: null, left: null,
      fresh: false, drag: null, sent: null, was: null, dumped: null, channel: undefined, dropzone: false, dropTimer: 0, dragBound: bound };
    render();
  }

  var api = {
    start: start,
    run: run,
    handleKey: handleKey,
    go: go,
    wantsTab: wantsTab,
    link: link,
    open: open,
    close: close,
    select: select,
    reopen: reopen,
    list: list,
    // DECISIONS D33: the options of the prompt editors that wait with their tabs (a book tab that was left with its
    // editor open, see leaveActive and restoreEditor): M.undo leaves the cards of those editors alone
    heldEditors: function () { return st.tabs.filter(function (t) { return !!t.editing && typeof t.editing === "object"; }).map(function (t) { return Object.assign({}, t.editing); }); },
    active: function () { return st.active; },
    started: function () { return st.started; },
    render: render,
    save: saveNow,
    // D31: windows
    windowId: windowId,
    dump: dump,
    adopt: adopt,
    take: take,
    drop: drop,
    forget: forget,
    moveToWindow: moveToWindow,
    move: moveTab,
    WINDOWS_MAX: WINDOWS_MAX,
    TAB_TYPE: TAB_TYPE,
    DRAG_TYPE: DRAG_TYPE,
    COMMANDS: COMMANDS.slice(),
    MENU_KEYS: MENU_KEYS.slice(),
    TABS_MAX: TABS_MAX,
    CLOSED_MAX: CLOSED_MAX,
    STORE_KEY: STORE_KEY,
    _reset: reset,
    _pure: { place: place, samePlace: samePlace, validPosition: validPosition, title: title, after: after, without: without, step: step, nth: nth, clean: clean, serialize: serialize }
  };
  M.tabs = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

/* SELF-CHECK (SPEC §17.2 M.tabs; BUILD-NOTES "Tabs"; DECISIONS D30):
 * start(route, explicit) → {screen, collectionId, promptId, position} (the stored tabs come back; explicit: the place
 * the address names takes a tab that shows it, else a library tab, else a new one; never routes); run(id) → boolean
 * (newTab, closeTab, reopenTab, nextTab, prevTab, tab1 … tab8, lastTab; false while blocked or with nothing to do);
 * handleKey(ev) → boolean (M.keys.TABS_MAP; in the Mac app MENU_KEYS are left to the menu, only a held one is
 * swallowed; Cmd+W with one tab is not handled; a held key acts once); wantsTab(ev) → boolean (a Cmd+click, Ctrl+click off the Mac, while started and not
 * blocked); go(ev, screen, params) → boolean (such a click opens a tab in the background, with Shift an active one,
 * and returns true; else M.app.route(screen, params) and false);
 * link(route) → boolean (a hashchange: true when a tab took it); open(place, {background}) → id|null (after the active
 * tab; null with TABS_MAX 20 tabs open, with a toast); close(id) → boolean (never the last tab; the right neighbour
 * becomes active, else the left); select(id) → boolean; reopen() → boolean (CLOSED_MAX 10, memory only);
 * list() → [{id, screen, collectionId, title, active}]; active() → id; started(); render(); save() → boolean.
 * A tab's place follows app:routed; a book tab that is left keeps M.reader.position() and gives it back through
 * M.app.route(…, {position}), and keeps M.margin.editing() (a prompt editor that is open) and opens it again with
 * M.margin.openEditor once its book is open (M.reader.isOpen: after the route, on doc:opened, after review:ended;
 * not when the next tab shows the same book: the editor then stays on screen; not for a tab asked to show one
 * prompt; memory only); a text field with the focus is blurred before a tab leaves; collection:changed redraws; collection:deleted turns that collection's tabs into
 * library tabs. The strip #tabs (role tablist; .tabs__list > .tabs__tab[.is-active] > button.tabs__select[role=tab] +
 * button.tabs__close; button.tabs__new) is shown with two or more tabs; every text is textContent. Storage:
 * localStorage STORE_KEY "marginalia.tabs" = {v: 1, tabs: [{screen, collectionId, position}], active: index}, written
 * SAVE_MS after a change (also a scroll that settled) and on pagehide, never in a tab that stepped aside
 * (M.store.locked() with a reason other than "window") and never while M.desktop.covered(); the tab on screen is
 * stored with the place its book shows now.
 * Windows (D31; the Mac app, M.store.handover()): windowId() → the "w" of the address, or null (the first window);
 * the list of a window with an id is under "marginalia.tabs.<id>", and a window that is not the writer stores its
 * own list too; M.app holds the page's Web Lock "marginalia.window.<id>"; the first window takes over the lists of
 * windows that are gone (book and deck tabs, as far as TABS_MAX allows; the rest stays stored).
 * moveToWindow(tabId?, {x, y}?) → Promise<boolean> (the tab's list under a new id, window.open("/?w=<id>"), the tab
 * leaves; false with one tab, while blocked, outside the app, with WINDOWS_MAX 8 windows; the tab comes back when
 * the window does not show in WINDOW_WAIT_MS); dump() → [{screen, collectionId, position, editing}] | null (blocked);
 * take(list) → the indexes that came in; adopt(list, index?, {active}?) → count (both: nothing while blocked);
 * drop(indexes) → tabs left after those tabs of the last dump() went (0: forgotten; -1: nothing to go by);
 * forget() → boolean; move(id, index) → boolean. A tab is draggable (TAB_TYPE "application/x-marginalia-tab", and a
 * type of the drag's own, DRAG_TYPE + its number, by which a page knows its own drag): along its strip (everywhere),
 * onto another window's strip or close to it (TEAR_PX 24), or out of its strip (the Mac app): let go on the page of
 * its own window (farther than TEAR_PX from the strip), on another window (on its page, on a strip with TABS_MAX
 * tabs, also behind a dialog: that page says {type: "letgo", drag, x, y}) or outside every window (after
 * DROP_WAIT_MS 200), it gets a window of its own at that point. A mark that the page set, and the strip of a
 * window with one tab, go OVER_MS 700 after the last dragover.
 * While it is dragged, a small picture of it follows the pointer (setDragImage with a canvas: its name, and
 * M.reader.snapshot of its book), and its place in the strip looks lifted (.is-dragging). A tab leaves its window
 * for another one only when the window that took it says so ({type: "took", drag} on the BroadcastChannel
 * "marginalia.tabs"). A drag whose end never came (the strip was drawn again meanwhile) is over when another
 * drag's tab comes over the page, or at the next move or press of the mouse; when it goes on all the same, it is
 * this page's own again (by its type), so its tab never comes into its own window a second time.
 * document.title is the tab on screen, then "Marginalia".
 * Blocked (nothing runs: run, handleKey, link, wantsTab, go, open, close, select, reopen): M.app.modal() or
 * M.review.isActive(). Keys on a focused tab of the strip: ← → move the focus, Enter and Space show the tab, Delete
 * and Backspace close it; the focus stays in the strip after a redraw.
 * Pure (_pure): place, samePlace, validPosition, title, after, without, step, nth, clean, serialize.
 * Calls only: M.app.{route, current, modal, toast}; M.reader.{position, isOpen, snapshot}; M.margin.{editing, openEditor, activeEditor};
 * M.cache.collection; M.keys.{TABS_MAP, dispatch,
 * match, isMac}; M.desktop.{isApp, covered}; M.review.isActive; M.store.{locked, handover, hold, held}; M.bus.on;
 * window.open (moveToWindow). */
