/* js/cache.js — Marginalia in-memory mirror of collections and prompts (SPEC §8 "Cache", §17).
 *
 * load() reads every collection and prompt record (tombstones included) into Maps so that counts,
 * queues and export strings are synchronous. Writes go cache → store: the Map is updated and the
 * bus event is emitted at once, then the store write is awaited; a store failure toasts
 * "Could not save" (through M.app.toast when present).
 * - savePrompt then REJECTS with code "store" (err.cause = the store error, err.prompt = the record), so a
 *   caller never runs an irreversible follow-up such as attachments.gc on a write that did not land. An edited
 *   prompt keeps its in-memory state (the session's truth; the next write that lands stores it). A brand-new
 *   prompt whose first write failed is dropped again with prompt:deleted, so a retry cannot duplicate it.
 * - The other writers still resolve after the toast, except patchPrompts (below), which rejects the same way.
 *   removeCollection and restoreCollection write their whole cascade in ONE transaction, so the store never keeps
 *   half of it.
 * - revisedAt (FIXES-1 FIX-5) marks the last change of a prompt's TEXT: savePrompt(p, {content: true}) sets it to now
 *   when the text differs from the text this cache last loaded or stored for that prompt (a new prompt has none). It is
 *   a content field of the §9 merge; M.scheduler.promptMissDays and the review's struggle line count from it.
 * - contentUpdatedAt marks edits a person made (§8, used by the §9 merge): savePrompt(p, {content: true})
 *   bumps it when the prompt is new or its kind, text, tags, flag, collection or anchored passage differ from
 *   the last loaded/saved version. Lost-marking, refound anchor positions and context snapshots (recontext)
 *   are derived and never bump it, so they cannot outrank another machine's real edits in an import.
 * - One writing tab per origin (js/store.js): once a newer Marginalia tab took over (M.store.locked()), no writer
 *   here touches the maps, emits or writes, because this tab's copy may be older than what that tab stored.
 *   savePrompt rejects code "locked" (err.prompt = the record) and announces a refused text change as
 *   prompt:refused {prompt, reason: "locked"}, so M.app's notice can show the text; the other writers resolve
 *   with the record as it is, except patchPrompts and the seven folder writers (createFolder, renameFolder,
 *   moveFolder, moveCollection, removeFolder, restoreFolder, saveFolders; FEATURES L1.8, the "Folders" block
 *   below), which reject code "locked". A store write refused by the lock is never toasted as "Could not save".
 * - patchPrompts(changes) (an extension, FEATURES A9, BUILD-NOTES "Obsidian") is the quiet batch save for fields that
 *   are neither content nor derived here (the Obsidian send record: obsidianSentAt, obsidianFile, obsidianPendingFile).
 *   It changes the cached records IN PLACE, so every view and editor that holds one sees the change, emits no event
 *   (no view renders these fields; the card and row menus read them when they open) and stores them all in ONE
 *   store write: a send-all of a few hundred cards costs no re-render per card. updatedAt moves; contentUpdatedAt
 *   and dueAt never do. A store write that fails rejects (code "store", after the toast; "locked" when the lock
 *   refused it), so the Obsidian write-ahead never sends on a marker that was not stored.
 */
(function (root) {
  "use strict";
  var M = root.Marginalia = root.Marginalia || {};
  function dep(name) { return M[name] || (typeof require === "function" ? require("./" + name + ".js") : undefined); }
  function tryDep(name) { try { return dep(name); } catch (e) { return undefined; } }

  function util() { return dep("util"); }
  function scheduler() { return dep("scheduler"); }
  function contextMod() { return tryDep("context"); }
  function store() { return dep("store"); }

  var REVIEWABLE = { qa: true, cloze: true };
  var COUNTED = { qa: true, cloze: true, note: true };

  var cols = new Map();      // collectionId → Collection (tombstones included)
  var ps = new Map();        // promptId → Prompt (tombstones included)
  var sigs = new Map();      // promptId → contentKey() of the last loaded/saved version
  var texts = new Map();     // promptId → the text of the last loaded/saved version (revisedAt, FIXES-1 FIX-5)
  var csigs = new Map();     // collectionId → collectionKey() of the last loaded/saved version
  var firstWrites = new Map(); // promptId → token of a new prompt's first store write still in flight
  var isLoaded = false;

  /* ------------------------------------------------------------------ helpers */

  function err(code, message, cause) {
    var e = new Error(message || code);
    e.code = code;
    if (cause !== undefined) e.cause = cause;
    return e;
  }

  function emit(type, payload) {
    var bus = M.bus || tryDep("bus");
    if (bus && typeof bus.emit === "function") {
      try { bus.emit(type, payload); } catch (e) { /* listeners are isolated by the bus */ }
    }
  }

  function live(r) { return !!r && (r.deletedAt === null || r.deletedAt === undefined); }

  function stamp(opts) { return opts && typeof opts.now === "number" ? opts.now : Date.now(); }

  function toast(text) {
    var app = M.app;
    if (app && typeof app.toast === "function") {
      try { app.toast({ text: text, ttl: 8000, id: "cache-save-failed" }); } catch (e) { /* ignore */ }
    }
  }

  // Awaits a store write; on failure toasts and resolves anyway (the in-memory state is the session's truth).
  function persist(promise) {
    return Promise.resolve(promise).then(function () { return true; }, function (e) {
      if (!isLockError(e)) toast("Could not save");
      return false;
    });
  }

  // One writing tab per origin (see the header): true once a newer tab took over this origin's database.
  function lockedOut() {
    var st = M.store || tryDep("store");
    try { return !!(st && typeof st.locked === "function" && st.locked()); } catch (e) { return false; }
  }

  function isLockError(e) { return !!e && e.code === "locked"; }

  // savePrompt in a tab that stepped aside: nothing changes here. Typed text that differs from this tab's copy
  // is announced (prompt:refused), so the notice that covers the page can show it instead of dropping it.
  function refuse(p) {
    var text = typeof p.text === "string" ? p.text : "";
    var known = p.id ? ps.get(p.id) : null;
    if (text.trim() && (!known || known.text !== text)) emit("prompt:refused", { prompt: p, reason: "locked" });
    var e = err("locked", "Marginalia is open in another tab");
    e.prompt = p;
    return Promise.reject(e);
  }

  // Calls fn() and always hands back a Promise (a synchronous throw becomes a rejection).
  function attempt(fn) {
    try { return Promise.resolve(fn()); } catch (e) { return Promise.reject(e); }
  }

  // Runs run(...objectStores) as ONE readwrite transaction over `names` (store.backend.tx: IndexedDB aborts,
  // the memory backend rolls back), so its writes commit or fail together. A store object without
  // multi-store transactions (a test double) gets fallback() instead.
  function atomically(st, names, run, fallback) {
    var b = st && st.backend;
    var canRange = names.indexOf("chunks") < 0 || (st.range && typeof st.range.bound === "function");
    if (b && typeof b.tx === "function" && canRange) return attempt(function () { return b.tx(names, "readwrite", run); });
    return attempt(fallback);
  }

  // Every chunk row of a document: keys [docId, i] (§8), the same range store.docs.deleteBytes uses.
  function chunkRange(st, docId) { return st.range.bound([docId, 0], [docId, Infinity]); }

  // A later write of the same prompt decides what the store holds, so a pending first-write rollback is off.
  function supersede(id) { firstWrites.delete(id); }

  /* ------------------------------------------------------------------ content key */

  // 53-bit string hash (cyrb53): content keys stay small however long the prompt text is.
  function hash53(s) {
    var h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (var i = 0; i < s.length; i++) {
      var ch = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
  }

  function strOf(v) { return typeof v === "string" ? v : ""; }
  function numOf(v) { return typeof v === "number" && isFinite(v) ? v : null; }

  // The passage an anchor stands for: its quote with prefix/suffix (a refind keeps them, only positions and
  // `lost` change), or page + y for a free margin note. null when the prompt has no anchor.
  function passageOf(a) {
    if (!a || typeof a !== "object") return null;
    var quote = strOf(a.quote);
    if (quote) return ["q", quote, strOf(a.prefix), strOf(a.suffix)];
    return ["n", numOf(a.pageIndex), numOf(a.y)];
  }

  // Key of the fields a person edits (the §9 content fields minus the derived context snapshot), read the way
  // normalizePrompt() fills them so a load → save round trip of an old record does not count as an edit.
  // null (unserialisable data) makes every save count as an edit.
  // name, description and sections are what a person edits on a collection; lastPosition/lastOpenedAt are not
  function collectionKey(c) {
    try { return JSON.stringify([c.name || "", c.description || "", Array.isArray(c.sections) ? c.sections : []]); }
    catch (e) { return null; }
  }

  function contentKey(p) {
    try {
      var text = typeof p.text === "string" ? p.text : (p.text === null || p.text === undefined ? "" : String(p.text));
      var kind = typeof p.kind === "string" && p.kind ? p.kind : "note";
      var json = JSON.stringify([kind, text, Array.isArray(p.tags) ? p.tags : [], !!p.flagged, p.collectionId || null, passageOf(p.anchor)]);
      return json.length + ":" + hash53(json);
    } catch (e) { return null; }
  }

  function filterOpt(list, opts) { return opts && opts.live ? list.filter(live) : list; }

  // dueAt = min over cards for live qa/cloze prompts; the property is DELETED otherwise (§8),
  // so the byDue index never returns notes, highlights or tombstones.
  function deriveDue(p) {
    if (live(p) && REVIEWABLE[p.kind] && Array.isArray(p.cards) && p.cards.length) {
      var min = Infinity;
      for (var i = 0; i < p.cards.length; i++) {
        var c = p.cards[i];
        if (c && typeof c.dueAt === "number" && c.dueAt < min) min = c.dueAt;
      }
      if (min !== Infinity) { p.dueAt = min; return p; }
    }
    delete p.dueAt;
    return p;
  }

  function normalizePrompt(p, now, isNew) {
    if (typeof p.kind !== "string" || !p.kind) p.kind = "note";
    if (typeof p.text !== "string") p.text = p.text === null || p.text === undefined ? "" : String(p.text);
    if (!Array.isArray(p.tags)) p.tags = [];
    p.flagged = !!p.flagged;
    if (p.anchor === undefined) p.anchor = null;
    if (p.context === undefined) p.context = null;
    if (!Array.isArray(p.cards)) p.cards = [];
    if (typeof p.createdAt !== "number") p.createdAt = now;
    if (p.deletedAt === undefined) p.deletedAt = null;
    if (typeof p.contentUpdatedAt !== "number") p.contentUpdatedAt = isNew ? now : p.createdAt;
    if (p.v === undefined || p.v === null) p.v = 1;
    return p;
  }

  function normalizeCollection(c, now) {
    if (c.kind !== "book" && c.kind !== "deck") c.kind = c.kind === undefined ? "deck" : c.kind;
    if (!c.id) c.id = util().uuid(c.kind === "deck" ? "deck_" : "book_");
    if (typeof c.name !== "string") c.name = c.name === null || c.name === undefined ? "" : String(c.name);
    if (!Array.isArray(c.sections)) c.sections = [];
    if (c.kind === "deck" && typeof c.description !== "string") c.description = "";
    if (typeof c.addedAt !== "number") c.addedAt = now;
    if (typeof c.lastOpenedAt !== "number") c.lastOpenedAt = c.addedAt;
    if (c.deletedAt === undefined) c.deletedAt = null;
    if (c.v === undefined || c.v === null) c.v = 1;
    return c;
  }

  /* ------------------------------------------------------------------ context */

  function sameContext(a, b) {
    if (!a || !b) return false;
    return a.docName === b.docName && a.sectionLabel === b.sectionLabel &&
      a.pageIndex === b.pageIndex && a.pageLabel === b.pageLabel;
  }

  function fallbackContext(c, p, ctx) {
    var prev = p.context || {};
    var pageIndex = null;
    if (p.anchor && typeof p.anchor.pageIndex === "number") pageIndex = p.anchor.pageIndex;
    else if (typeof prev.pageIndex === "number") pageIndex = prev.pageIndex;
    var sectionLabel = null;
    if (c.kind === "book" && pageIndex !== null && ctx && typeof ctx.labelFor === "function") {
      try { sectionLabel = ctx.labelFor(c.sections || [], pageIndex); } catch (e) { sectionLabel = null; }
      if (sectionLabel === undefined) sectionLabel = null;
    } else {
      sectionLabel = typeof prev.sectionLabel === "string" ? prev.sectionLabel : null;   // deck "# Section" lines are user data
    }
    var pageLabel = null;
    if (pageIndex !== null) {
      if (c.pageLabels && c.pageLabels[pageIndex] !== undefined && c.pageLabels[pageIndex] !== null) pageLabel = String(c.pageLabels[pageIndex]);
      else if (typeof prev.pageLabel === "string" && prev.pageIndex === pageIndex) pageLabel = prev.pageLabel;
      else pageLabel = String(pageIndex + 1);
    }
    return { docName: c.name || "", sectionLabel: sectionLabel, pageIndex: pageIndex, pageLabel: pageLabel };
  }

  function computeContext(c, p) {
    var ctx = contextMod();
    if (ctx && typeof ctx.contextFor === "function") {
      try {
        var r = ctx.contextFor(c, p);
        if (r && typeof r === "object") return r;
      } catch (e) { /* fall back below */ }
    }
    return fallbackContext(c, p, ctx);
  }

  /* ------------------------------------------------------------------ load + readers */

  function load() {
    var st = store();
    return st.open().then(function () {
      // the folders (FEATURES L1): one meta record; a store without meta (a test double) has none
      var folderList = st.meta && typeof st.meta.get === "function" ? st.meta.get(FOLDERS_KEY) : null;
      return Promise.all([st.collections.all(), st.prompts.all(), folderList]);
    }).then(function (res) {
      cols = new Map();
      ps = new Map();
      sigs = new Map();
      texts = new Map();
      csigs = new Map();
      (res[0] || []).forEach(function (c) { if (c && c.id) { cols.set(c.id, c); csigs.set(c.id, collectionKey(c)); } });
      (res[1] || []).forEach(function (p) { if (p && p.id) { ps.set(p.id, p); sigs.set(p.id, contentKey(p)); texts.set(p.id, p.text); } });
      loadFolders(res[2]);
      isLoaded = true;
      return { collections: cols.size, prompts: ps.size };
    });
  }

  // Reads the library again and brings this cache to the store's state (DECISIONS D31, BUILD-NOTES "Windows": a
  // window that takes the writer role after another window wrote). A record that is the same in the store keeps
  // its object here (the views hold it); a changed one is replaced by the stored record. Then the bus events of a
  // local change go out, so every view follows: prompt:saved {prompt, isNew}, prompt:deleted, prompt:restored,
  // collection:changed, collection:deleted, folders:changed. → Promise<{prompts, collections, folders}> (how many
  // changed). It writes nothing.
  function sameRecord(a, b) {
    if (a === b) return true;
    try { return JSON.stringify(a) === JSON.stringify(b); } catch (e) { return false; }
  }

  // Each reload() has a number. A read that a newer reload() overtook changes nothing: what it read is older than
  // (or the same as) what the newer one reads, and it may end AFTER the newer one (D31: a window whose ask for the
  // role was ended while it read lets the lock go at once, reads on, and may have taken the role again meanwhile).
  var reloads = 0;
  function reload() {
    var st = store(), mine = ++reloads;
    return st.open().then(function () {
      var folderList = st.meta && typeof st.meta.get === "function" ? st.meta.get(FOLDERS_KEY) : null;
      return Promise.all([st.collections.all(), st.prompts.all(), folderList]);
    }).then(function (res) {
      var changed = { prompts: 0, collections: 0, folders: 0 };
      if (mine !== reloads) return changed;
      var first = [], then = [], last = [];                 // collections that came or changed; prompts; collections that went
      var seen = new Set();
      (res[0] || []).forEach(function (c) {
        if (!c || !c.id) return;
        seen.add(c.id);
        var old = cols.get(c.id);
        if (old && sameRecord(old, c)) return;
        cols.set(c.id, c);
        csigs.set(c.id, collectionKey(c));
        changed.collections++;
        if (old && live(old) && !live(c)) last.push(["collection:deleted", { collectionId: c.id }]);
        else if (live(c)) first.push(["collection:changed", { collectionId: c.id }]);
      });
      Array.from(cols.keys()).forEach(function (id) {       // in this cache, not in the store: it was never stored
        if (seen.has(id)) return;
        var gone = cols.get(id);
        cols.delete(id);
        csigs.delete(id);
        changed.collections++;
        if (live(gone)) last.push(["collection:deleted", { collectionId: id }]);
      });
      seen = new Set();
      (res[1] || []).forEach(function (p) {
        if (!p || !p.id) return;
        seen.add(p.id);
        var old = ps.get(p.id);
        if (old && sameRecord(old, p)) return;
        ps.set(p.id, p);
        sigs.set(p.id, contentKey(p));
        texts.set(p.id, p.text);
        firstWrites.delete(p.id);
        changed.prompts++;
        if (!old) { if (live(p)) then.push(["prompt:saved", { prompt: p, isNew: true }]); }
        else if (live(old) && !live(p)) then.push(["prompt:deleted", { promptId: p.id, collectionId: old.collectionId }]);
        else if (!live(old) && live(p)) then.push(["prompt:restored", { promptId: p.id, collectionId: p.collectionId }]);
        else if (live(p)) then.push(["prompt:saved", { prompt: p, isNew: false }]);
      });
      Array.from(ps.keys()).forEach(function (id) {
        if (seen.has(id)) return;
        var gone = ps.get(id);
        ps.delete(id);
        sigs.delete(id);
        texts.delete(id);
        firstWrites.delete(id);
        changed.prompts++;
        if (live(gone)) then.push(["prompt:deleted", { promptId: id, collectionId: gone.collectionId }]);
      });
      var stored = Array.isArray(res[2]) ? res[2] : [];
      if (!sameRecord(Array.from(fols.values()), stored)) {
        loadFolders(stored);
        changed.folders = 1;
        first.push(["folders:changed", { reloaded: true }]);
      }
      isLoaded = true;
      first.concat(then, last).forEach(function (e) { emit(e[0], e[1]); });
      return changed;
    });
  }

  function collections(opts) { return filterOpt(Array.from(cols.values()), opts); }
  function collection(id) { return cols.get(id) || null; }
  function prompts(opts) { return filterOpt(Array.from(ps.values()), opts); }
  function promptsOf(collectionId, opts) {
    var out = [];
    ps.forEach(function (p) { if (p.collectionId === collectionId) out.push(p); });
    return filterOpt(out, opts);
  }
  function prompt(id) { return ps.get(id) || null; }

  /* ------------------------------------------------------------------ prompt writes */

  // Resolves with the record once it is stored; rejects code "store" when the store write failed (see header).
  function savePrompt(p, opts) {
    opts = opts || {};
    if (!p || typeof p !== "object") return Promise.reject(err("bad_prompt", "savePrompt needs a prompt record"));
    if (!p.collectionId) return Promise.reject(err("bad_prompt", "A prompt needs a collectionId"));
    if (lockedOut()) return refuse(p);
    var now = stamp(opts);
    if (!p.id) p.id = util().uuid("p_");
    var id = p.id;
    var isNew = !ps.has(id);
    normalizePrompt(p, now, isNew);
    p.updatedAt = now;
    var key = contentKey(p);
    // {content: true} callers may save derived changes too (lost-marking, refind, context): only a changed
    // person-edited field moves contentUpdatedAt, which the import merge compares (§8, §9).
    if (opts.content && (isNew || key === null || sigs.get(id) !== key)) p.contentUpdatedAt = now;
    sigs.set(id, key);
    // revisedAt (FIXES-1 FIX-5): only a content save whose text differs from the text last stored here moves it (the
    // struggling count starts there); a flag, tags, a move or a delete and its undo leave it. A new prompt has none.
    if (opts.content && !isNew && texts.has(id) && texts.get(id) !== p.text) p.revisedAt = now;
    texts.set(id, p.text);
    deriveDue(p);
    ps.set(id, p);
    var token = null;
    if (isNew) { token = {}; firstWrites.set(id, token); } else supersede(id);
    emit("prompt:saved", { prompt: p, isNew: isNew });
    return attempt(function () { return store().prompts.put(p); }).then(function () {
      if (token && firstWrites.get(id) === token) firstWrites.delete(id);
      return p;
    }, function (cause) {
      if (!isLockError(cause)) toast("Could not save");
      var first = !!token && firstWrites.get(id) === token;
      if (first) firstWrites.delete(id);
      if (first && ps.get(id) === p) {
        // never stored and not written since: drop it so the session matches the store (prompt:deleted
        // takes its card and highlight away; the caller still holds the record and the user's text)
        ps.delete(id);
        sigs.delete(id);
        texts.delete(id);
        emit("prompt:deleted", { promptId: id, collectionId: p.collectionId });
      }
      var e = err("store", "Could not save the prompt", cause);
      e.prompt = p;
      throw e;
    });
  }

  // The fields patchPrompts never touches: a person's content (the §9 content fields), what the cache derives or
  // stamps itself, and the record's identity. Everything a person edits goes through savePrompt.
  var UNPATCHABLE = Object.create(null);
  ["id", "collectionId", "kind", "text", "tags", "flagged", "anchor", "context", "cards", "dueAt", "createdAt",
    "updatedAt", "contentUpdatedAt", "deletedAt", "v"].forEach(function (k) { UNPATCHABLE[k] = true; });
  var FIELD_RE = /^[A-Za-z][A-Za-z0-9]*$/;

  // patchPrompts(changes, {now}) → Promise<number>: changes = [{id, fields: {name: value}}]; a value of undefined
  // removes that field. Each cached record (a tombstone too; an unknown id is skipped) gets the fields IN PLACE, so it
  // keeps its identity and whatever holds it (a margin card, a list row, an open editor) sees them; no event is
  // emitted. Only a record that really changes gets updatedAt = now; contentUpdatedAt, the content key and dueAt stay
  // as they are. The changed records go to the store in ONE write (prompts.putMany, one transaction). Resolves with the
  // number of records changed once they are stored. Rejects code "bad_patch" (nothing changed) for an entry without an
  // id or fields, or a field name that is content, derived or not a plain name (UNPATCHABLE, FIELD_RE); code "locked"
  // (nothing changed) in a tab that stepped aside. A store write that fails rejects too, as savePrompt's does, so a
  // caller never sends anything on a write that did not land (the Obsidian write-ahead, repair A9-R3 of 2026-11-10):
  // code "store" (err.cause = the store's error) after the toast "Could not save", or code "locked" when the lock
  // refused it (no toast); the changed records keep their in-memory state (the session's truth, as an edit does).
  function patchPrompts(changes, opts) {
    var list = Array.isArray(changes) ? changes : [];
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (!c || typeof c.id !== "string" || !c.id || !c.fields || typeof c.fields !== "object") {
        return Promise.reject(err("bad_patch", "patchPrompts needs {id, fields} entries"));
      }
      var names = Object.keys(c.fields);
      for (var k = 0; k < names.length; k++) {
        if (!FIELD_RE.test(names[k]) || UNPATCHABLE[names[k]] === true) {
          return Promise.reject(err("bad_patch", "patchPrompts cannot change " + names[k]));
        }
      }
    }
    if (lockedOut()) return Promise.reject(err("locked", "Marginalia is open in another tab"));
    var now = stamp(opts), changed = [], seen = new Set();
    list.forEach(function (c) {
      var p = ps.get(c.id), touched = false;
      if (!p) return;
      Object.keys(c.fields).forEach(function (name) {
        var v = c.fields[name];
        if (v === undefined) {
          if (Object.prototype.hasOwnProperty.call(p, name)) { delete p[name]; touched = true; }
        } else if (!Object.prototype.hasOwnProperty.call(p, name) || p[name] !== v) {
          p[name] = v;
          touched = true;
        }
      });
      if (!touched) return;
      p.updatedAt = now;
      supersede(p.id);
      if (!seen.has(p.id)) { seen.add(p.id); changed.push(p); }
    });
    if (!changed.length) return Promise.resolve(0);
    return attempt(function () { return store().prompts.putMany(changed); }).then(function () { return changed.length; }, function (cause) {
      if (isLockError(cause)) throw err("locked", "Marginalia is open in another tab", cause);
      toast("Could not save");
      throw err("store", "Could not save the send record", cause);
    });
  }

  function removePrompt(id, opts) {
    var p = ps.get(id);
    if (!p) return Promise.reject(err("not_found", "No prompt " + id));
    if (!live(p) || lockedOut()) return Promise.resolve(p);
    var now = stamp(opts);
    p.deletedAt = now;
    p.updatedAt = now;
    deriveDue(p);
    supersede(p.id);
    emit("prompt:deleted", { promptId: p.id, collectionId: p.collectionId });
    return persist(store().prompts.put(p)).then(function () { return p; });
  }

  function restorePrompt(id, opts) {
    var p = ps.get(id);
    if (!p) return Promise.reject(err("not_found", "No prompt " + id));
    if (live(p) || lockedOut()) return Promise.resolve(p);
    var now = stamp(opts);
    p.deletedAt = null;
    p.updatedAt = now;
    p.contentUpdatedAt = now;          // a resurrection must outrank an older tombstone in import merges
    deriveDue(p);
    supersede(p.id);
    emit("prompt:restored", { promptId: p.id, collectionId: p.collectionId });
    return persist(store().prompts.put(p)).then(function () { return p; });
  }

  /* ------------------------------------------------------------------ collection writes */

  function saveCollection(c, opts) {
    if (!c || typeof c !== "object") return Promise.reject(err("bad_collection", "saveCollection needs a collection record"));
    if (lockedOut()) return Promise.resolve(c);
    var now = stamp(opts);
    normalizeCollection(c, now);
    // contentUpdatedAt moves only when name, description or sections changed (the import merge compares it, §9);
    // {content: false} (imports) keeps the record's own stamp
    var ckey = collectionKey(c), known = csigs.has(c.id);
    if ((opts && opts.content === false) || (known && ckey !== null && csigs.get(c.id) === ckey)) {
      if (typeof c.contentUpdatedAt !== "number") c.contentUpdatedAt = typeof c.addedAt === "number" ? c.addedAt : now;
    } else if (!known && typeof c.contentUpdatedAt === "number") {
      /* a new record that brings its own stamp keeps it */
    } else {
      c.contentUpdatedAt = now;
    }
    csigs.set(c.id, ckey);
    c.updatedAt = now;
    cols.set(c.id, c);
    emit("collection:changed", { collectionId: c.id });
    return persist(store().collections.put(c)).then(function () { return c; });
  }

  // Tombstones the collection and its live prompts and deletes the book's chunks (§8, §14), all in one
  // store transaction: a failure (quota, a dropped connection) rolls the whole cascade back, so the store
  // never holds a dead collection with live prompts or chunks nothing can free.
  function removeCollection(id, opts) {
    var c = cols.get(id);
    if (!c) return Promise.reject(err("not_found", "No collection " + id));
    if (lockedOut()) return Promise.resolve(c);
    var now = stamp(opts);
    var wasLive = live(c);
    if (wasLive) c.deletedAt = now;
    c.updatedAt = now;
    var affected = [];
    ps.forEach(function (p) {
      if (p.collectionId !== id || !live(p)) return;
      p.deletedAt = now;
      p.updatedAt = now;
      deriveDue(p);
      supersede(p.id);
      affected.push(p);
    });
    var isBook = c.kind === "book";
    if (isBook) { c.hasBytes = false; c.chunkCount = 0; }
    affected.forEach(function (p) { emit("prompt:deleted", { promptId: p.id, collectionId: id }); });
    emit("collection:deleted", { collectionId: id });
    var st = store();
    var names = isBook ? ["collections", "prompts", "chunks"] : ["collections", "prompts"];
    var write = atomically(st, names, function (colStore, promptStore, chunkStore) {
      var first = isBook ? chunkStore.del(chunkRange(st, id)) : colStore.put(c);
      return first.then(function () {
        return isBook ? colStore.put(c) : undefined;
      }).then(function () {
        return Promise.all(affected.map(function (p) { return promptStore.put(p); }));
      });
    }, function () {
      return st.collections.put(c).then(function () {
        return st.prompts.putMany(affected);
      }).then(function () {
        return isBook ? st.docs.deleteBytes(id) : undefined;
      });
    });
    return persist(write).then(function () { return c; });
  }

  // Undo for removeCollection: brings back the collection and the prompts tombstoned with it
  // (same deletedAt stamp), in one store transaction. A book's bytes are gone, so it comes back with hasBytes: false.
  function restoreCollection(id, opts) {
    var c = cols.get(id);
    if (!c) return Promise.reject(err("not_found", "No collection " + id));
    if (live(c) || lockedOut()) return Promise.resolve(c);
    var mark = c.deletedAt, now = stamp(opts);
    c.deletedAt = null;
    c.updatedAt = now;
    var restored = [];
    ps.forEach(function (p) {
      if (p.collectionId !== id || p.deletedAt !== mark) return;
      p.deletedAt = null;
      p.updatedAt = now;
      p.contentUpdatedAt = now;
      deriveDue(p);
      supersede(p.id);
      restored.push(p);
    });
    emit("collection:changed", { collectionId: id });
    restored.forEach(function (p) { emit("prompt:restored", { promptId: p.id, collectionId: id }); });
    var st = store();
    var write = atomically(st, ["collections", "prompts"], function (colStore, promptStore) {
      return colStore.put(c).then(function () {
        return Promise.all(restored.map(function (p) { return promptStore.put(p); }));
      });
    }, function () {
      return st.collections.put(c).then(function () { return st.prompts.putMany(restored); });
    });
    return persist(write).then(function () { return c; });
  }

  /* ------------------------------------------------------------------ counts + recontext */

  // counts(collectionId|null, now): prompts = live qa/cloze/note; cards and due over live qa/cloze cards
  // (due = the cards that can be asked now, scheduler.isReady: due by their schedule with its 16 h lookahead, and not
  // held back by an answer to another card of their prompt, D29); nextDueAt = the earliest scheduler.readyTime of a
  // card, the time from which a session can ask it (null when none; never later than now while a card is due);
  // writtenToday = counted prompts with createdAt >= localMidnight(now).
  // null scope = every live collection.
  function counts(collectionId, now) {
    var t = typeof now === "number" ? now : Date.now();
    var sch = scheduler(), u = util();
    var midnight = u.localMidnight(t);
    var out = { prompts: 0, cards: 0, due: 0, nextDueAt: null, writtenToday: 0 };
    ps.forEach(function (p) {
      if (!live(p)) return;
      if (collectionId !== null && collectionId !== undefined) {
        if (p.collectionId !== collectionId) return;
      } else {
        var c = cols.get(p.collectionId);
        if (c && !live(c)) return;
      }
      if (!COUNTED[p.kind]) return;
      out.prompts++;
      if (typeof p.createdAt === "number" && p.createdAt >= midnight) out.writtenToday++;
      if (!REVIEWABLE[p.kind] || !Array.isArray(p.cards)) return;
      for (var i = 0; i < p.cards.length; i++) {
        var card = p.cards[i];
        if (!card) continue;
        out.cards++;
        if (sch.isReady(p, i, t)) out.due++;
        var ready = sch.readyTime(p, i, t);
        if (typeof ready === "number" && (out.nextDueAt === null || ready < out.nextDueAt)) out.nextDueAt = ready;
      }
    });
    return out;
  }

  // Recomputes every live prompt's context snapshot for a collection (nickname or sections changed).
  // The snapshot is derived from the collection, not edited by a person: updatedAt moves, contentUpdatedAt
  // does not, so a rename here never outranks another machine's text edits in an import merge (§9).
  function recontext(collectionId, opts) {
    var c = cols.get(collectionId);
    if (!c) return Promise.reject(err("not_found", "No collection " + collectionId));
    if (lockedOut()) return Promise.resolve(0);
    var now = stamp(opts);
    var changed = [];
    ps.forEach(function (p) {
      if (p.collectionId !== collectionId || !live(p)) return;
      var ctx = computeContext(c, p);
      if (sameContext(p.context, ctx)) return;
      p.context = ctx;
      p.updatedAt = now;
      supersede(p.id);
      changed.push(p);
    });
    emit("prompts:recontexted", { collectionId: collectionId, count: changed.length });
    return persist(store().prompts.putMany(changed)).then(function () { return changed.length; });
  }

  // countsBy(now) → Map<collectionId, counts>: counts(id, now) for every collection at once, in ONE pass over the
  // prompts (the home screen asks for every row, and folder rows add them up; counts(id) per row would walk every
  // prompt once per row). A collection without a counted live prompt has no entry.
  function countsBy(now) {
    var t = typeof now === "number" ? now : Date.now();
    var sch = scheduler(), midnight = util().localMidnight(t), out = new Map();
    ps.forEach(function (p) {
      if (!live(p) || !COUNTED[p.kind]) return;
      var o = out.get(p.collectionId);
      if (!o) { o = { prompts: 0, cards: 0, due: 0, nextDueAt: null, writtenToday: 0 }; out.set(p.collectionId, o); }
      o.prompts++;
      if (typeof p.createdAt === "number" && p.createdAt >= midnight) o.writtenToday++;
      if (!REVIEWABLE[p.kind] || !Array.isArray(p.cards)) return;
      for (var i = 0; i < p.cards.length; i++) {
        var card = p.cards[i];
        if (!card) continue;
        o.cards++;
        if (sch.isReady(p, i, t)) o.due++;
        var ready = sch.readyTime(p, i, t);
        if (typeof ready === "number" && (o.nextDueAt === null || ready < o.nextDueAt)) o.nextDueAt = ready;
      }
    });
    return out;
  }

  /* ------------------------------------------------------------------ folders (FEATURES L1; BUILD-NOTES "Library folders")
   *
   * Every folder lives in ONE meta record, "folders": [{id, name, parentId|null, createdAt, updatedAt, deletedAt}],
   * tombstones included (a deleted folder keeps its parentId, so what still points at it finds the nearest live folder
   * above it). No IndexedDB version bump: an older copy of the app ignores the record. A book or deck carries
   * folderId (missing or null = the top level) and folderUpdatedAt (when its folderId last changed; the import merge
   * compares it). Readers never trust a stored reference blindly: a folderId or parentId naming a deleted folder means
   * the nearest live folder up that folder's chain, one naming no folder at all means the top level, and a loop in the
   * stored parents is cut at its folder with the newest updatedAt (it sits at the top level), as the import does.
   * Every write (create, rename, move, delete, restore, an import's saveFolders) is ONE readwrite transaction over meta
   * and collections and ONE folders:changed {folderIds, collectionIds} event, emitted before the write as the other
   * writers do, so a folder delete that moves 100 books re-renders the home screen once. In a tab that stepped aside
   * (M.store.locked()) every folder writer rejects code "locked" and changes nothing. A folder write never touches a
   * book, deck, prompt or review record beyond a collection's folderId, folderUpdatedAt and updatedAt. */

  var FOLDERS_KEY = "folders";
  var FOLDER_NAME_MAX = 80;            // characters, as the rename fields of the home screen
  var fols = new Map();                // folderId → Folder (tombstones included), in stored order
  var folderIdx = null;                // derived {parent: Map(id → parent id|null), kids: Map(parent|null → [id])}; null = stale

  function loadFolders(value) {
    fols = new Map();
    folderIdx = null;
    (Array.isArray(value) ? value : []).forEach(function (f) {
      if (f && typeof f === "object" && typeof f.id === "string" && f.id && !fols.has(f.id)) fols.set(f.id, f);
    });
  }

  function lockError() { return err("locked", "Marginalia is open in another tab"); }

  // A folder name as typed: whitespace collapsed, at most FOLDER_NAME_MAX characters (never half a surrogate pair).
  function folderName(name) {
    var s = String(name == null ? "" : name).replace(/\s+/g, " ").trim();
    var a = Array.from(s);
    return a.length > FOLDER_NAME_MAX ? a.slice(0, FOLDER_NAME_MAX).join("").trim() : s;
  }
  function liveFolder(id) { var f = typeof id === "string" ? fols.get(id) : null; return f && live(f) ? f : null; }
  function newerFolder(a, b) {
    var au = typeof a.updatedAt === "number" ? a.updatedAt : 0, bu = typeof b.updatedAt === "number" ? b.updatedAt : 0;
    return au > bu || (au === bu && String(a.id) > String(b.id));
  }

  // The live folder a stored reference stands for (see the header); null = the top level. Bounded by the folder count.
  function resolveRef(ref) {
    var cur = ref, steps = 0;
    while (typeof cur === "string" && cur && steps++ <= fols.size) {
      var f = fols.get(cur);
      if (!f) return null;
      if (live(f)) return cur;
      cur = f.parentId;
    }
    return null;
  }

  // The live folders' parents (references resolved, loops cut) and children (unsorted), rebuilt after a change;
  // cuts: the folders a loop was cut at (saveFolders stores them as the readers see them, repair LIB-2).
  function folderIndex() {
    if (folderIdx) return folderIdx;
    var parent = new Map(), state = new Map(), kids = new Map(), cuts = [];
    fols.forEach(function (f, id) { if (live(f)) parent.set(id, resolveRef(f.parentId)); });
    parent.forEach(function (unused, start) {
      if (state.get(start) === 2) return;
      var path = [], cur = start;
      while (cur !== null && state.get(cur) !== 2) {
        if (state.get(cur) === 1) {
          var loop = path.slice(path.indexOf(cur)), cut = loop[0];
          loop.forEach(function (id) { if (newerFolder(fols.get(id), fols.get(cut))) cut = id; });
          parent.set(cut, null);
          cuts.push(cut);
          break;
        }
        state.set(cur, 1);
        path.push(cur);
        cur = parent.get(cur);
      }
      path.forEach(function (id) { state.set(id, 2); });
    });
    parent.forEach(function (p, id) {
      var list = kids.get(p);
      if (!list) { list = []; kids.set(p, list); }
      list.push(id);
    });
    folderIdx = { parent: parent, kids: kids, cuts: cuts };
    return folderIdx;
  }

  function folders(opts) { return filterOpt(Array.from(fols.values()), opts); }
  function folder(id) { return fols.get(id) || null; }
  // The live folder a live folder sits in (null: the top level, or not a live folder).
  function folderParent(id) { var p = folderIndex().parent.get(id); return p === undefined ? null : p; }
  // The live folders directly inside a folder (null: the top level), in stored order (the home screen sorts them).
  function folderChildren(parentId) {
    var list = folderIndex().kids.get(parentId === undefined || parentId === "" ? null : parentId) || [];
    return list.map(function (id) { return fols.get(id); });
  }
  // [top-level folder, …, the folder]: the live folders from the top down to `id` ([] for anything else).
  function folderPath(id) {
    var idx = folderIndex(), out = [], cur = idx.parent.has(id) ? id : null;
    while (cur !== null && out.length <= idx.parent.size) { out.unshift(cur); cur = idx.parent.get(cur); }
    return out;
  }
  // The live folder a collection (record or id) is in; null = the top level.
  function folderOf(c) {
    var rec = typeof c === "string" ? cols.get(c) : c;
    if (!rec || rec.folderId === null || rec.folderId === undefined) return null;
    return resolveRef(rec.folderId);
  }
  // Everything live inside a folder, at any depth: {folders: [ids of its sub-folders], collections: [ids]}.
  function folderMembers(id) {
    var idx = folderIndex(), inside = new Set(), out = { folders: [], collections: [] };
    if (!idx.parent.has(id)) return out;
    var queue = [id];
    inside.add(id);
    while (queue.length) {
      var cur = queue.shift();
      (idx.kids.get(cur) || []).forEach(function (k) { if (!inside.has(k)) { inside.add(k); out.folders.push(k); queue.push(k); } });
    }
    cols.forEach(function (c, cid) { if (live(c) && inside.has(folderOf(c))) out.collections.push(cid); });
    return out;
  }

  // ONE readwrite transaction over meta (every folder, as they are now) and collections (`changedCols`), after ONE
  // folders:changed event. A refusal by the lock is never toasted; another failure toasts "Could not save" and keeps
  // the in-memory state (the session's truth, as for the other writers): resolves true when it landed.
  function writeFolders(changedCols, payload) {
    folderIdx = null;
    var list = Array.from(fols.values()).map(function (f) { return Object.assign({}, f); });
    emit("folders:changed", payload);
    var st = store();
    var write = atomically(st, ["meta", "collections"], function (metaStore, colStore) {
      return metaStore.put({ key: FOLDERS_KEY, value: list }).then(function () {
        return Promise.all(changedCols.map(function (c) { return colStore.put(c); }));
      });
    }, function () {
      return st.meta.set(FOLDERS_KEY, list).then(function () {
        return Promise.all(changedCols.map(function (c) { return st.collections.put(c); }));
      });
    });
    return persist(write);
  }

  function targetFolder(folderId) { return folderId === null || folderId === undefined || folderId === "" ? null : String(folderId); }

  // createFolder(name, parentId|null, {now}) → Promise<Folder>; rejects "locked", "bad_name" (nothing but spaces),
  // "not_found" (no live folder parentId).
  function createFolder(name, parentId, opts) {
    if (lockedOut()) return Promise.reject(lockError());
    var v = folderName(name), parent = targetFolder(parentId);
    if (!v) return Promise.reject(err("bad_name", "A folder needs a name"));
    if (parent !== null && !liveFolder(parent)) return Promise.reject(err("not_found", "No folder " + parent));
    var now = stamp(opts);
    var f = { id: util().uuid("folder_"), name: v, parentId: parent, createdAt: now, updatedAt: now, deletedAt: null };
    fols.set(f.id, f);
    return writeFolders([], { folderIds: [f.id], collectionIds: [], reason: "create" }).then(function () { return f; });
  }

  // renameFolder(id, name, {now}) → Promise<Folder>; the same name writes nothing.
  function renameFolder(id, name, opts) {
    if (lockedOut()) return Promise.reject(lockError());
    var f = liveFolder(id), v = folderName(name);
    if (!f) return Promise.reject(err("not_found", "No folder " + id));
    if (!v) return Promise.reject(err("bad_name", "A folder needs a name"));
    if (v === f.name) return Promise.resolve(f);
    f.name = v;
    f.updatedAt = stamp(opts);
    return writeFolders([], { folderIds: [id], collectionIds: [], reason: "rename" }).then(function () { return f; });
  }

  // moveFolder(id, parentId|null, {now}) → Promise<{folder, from, to, moved}>; rejects "cycle" when parentId is the
  // folder itself or one of its sub-folders (at any depth), "not_found" without a live folder or target.
  function moveFolder(id, parentId, opts) {
    if (lockedOut()) return Promise.reject(lockError());
    var f = liveFolder(id), to = targetFolder(parentId);
    if (!f) return Promise.reject(err("not_found", "No folder " + id));
    if (to !== null && !liveFolder(to)) return Promise.reject(err("not_found", "No folder " + to));
    if (to === id || (to !== null && folderPath(to).indexOf(id) >= 0)) return Promise.reject(err("cycle", "A folder cannot go inside itself"));
    var from = folderParent(id);
    if (from === to && (f.parentId === undefined ? null : f.parentId) === to) return Promise.resolve({ folder: f, from: from, to: to, moved: false });
    f.parentId = to;
    f.updatedAt = stamp(opts);
    return writeFolders([], { folderIds: [id], collectionIds: [], reason: "move" }).then(function () {
      return { folder: f, from: from, to: to, moved: true };
    });
  }

  // moveCollection(id, folderId|null, {now}) → Promise<{collection, from, to, moved}>: a live book or deck into a live
  // folder or the top level. Only folderId, folderUpdatedAt and updatedAt change (never contentUpdatedAt).
  function moveCollection(id, folderId, opts) {
    if (lockedOut()) return Promise.reject(lockError());
    var c = cols.get(id), to = targetFolder(folderId);
    if (!c || !live(c)) return Promise.reject(err("not_found", "No collection " + id));
    if (to !== null && !liveFolder(to)) return Promise.reject(err("not_found", "No folder " + to));
    var from = folderOf(c);
    if (from === to && (c.folderId === undefined ? null : c.folderId) === to) return Promise.resolve({ collection: c, from: from, to: to, moved: false });
    var now = stamp(opts);
    c.folderId = to;
    c.folderUpdatedAt = now;
    c.updatedAt = now;
    return writeFolders([c], { folderIds: [], collectionIds: [id], reason: "move" }).then(function () {
      return { collection: c, from: from, to: to, moved: true };
    });
  }

  // removeFolder(id, {now}) → Promise<{folder, to, folders, collections}>: the folder becomes a tombstone and what was
  // directly in it (sub-folders, books, decks) moves up one level, to `to` (its parent, or null: the top level).
  // Nothing else changes: a book, deck, prompt or review record is never deleted by it.
  function removeFolder(id, opts) {
    if (lockedOut()) return Promise.reject(lockError());
    var f = liveFolder(id);
    if (!f) return Promise.reject(err("not_found", "No folder " + id));
    var now = stamp(opts), to = folderParent(id), subs = [], moved = [];
    fols.forEach(function (g, gid) { if (gid !== id && live(g) && folderParent(gid) === id) subs.push(g); });
    cols.forEach(function (c) { if (live(c) && folderOf(c) === id) moved.push(c); });
    subs.forEach(function (g) { g.parentId = to; g.updatedAt = now; });
    moved.forEach(function (c) { c.folderId = to; c.folderUpdatedAt = now; c.updatedAt = now; });
    f.deletedAt = now;
    f.updatedAt = now;
    var subIds = subs.map(function (g) { return g.id; }), colIds = moved.map(function (c) { return c.id; });
    return writeFolders(moved, { folderIds: [id].concat(subIds), collectionIds: colIds, reason: "delete" }).then(function () {
      return { folder: f, to: to, folders: subIds, collections: colIds };
    });
  }

  // restoreFolder(id, {folders, collections}, {now}) → Promise<Folder>: the undo of removeFolder. The folder comes back
  // where it was, and each listed child that is still where the delete put it (nothing moved or renamed it since: its
  // stamp is still the delete's) goes back in.
  function restoreFolder(id, moved, opts) {
    if (lockedOut()) return Promise.reject(lockError());
    var f = fols.get(id);
    if (!f) return Promise.reject(err("not_found", "No folder " + id));
    if (live(f)) return Promise.resolve(f);
    var mark = f.deletedAt, now = stamp(opts), back = [], subIds = [];
    f.deletedAt = null;
    f.updatedAt = now;
    folderIdx = null;
    var above = folderPath(id);                  // a child that sits above the folder now never goes back in (no loop)
    ((moved && moved.folders) || []).forEach(function (gid) {
      var g = liveFolder(gid);
      if (g && g.updatedAt === mark && above.indexOf(gid) < 0) { g.parentId = id; g.updatedAt = now; subIds.push(gid); }
    });
    ((moved && moved.collections) || []).forEach(function (cid) {
      var c = cols.get(cid);
      if (c && live(c) && c.folderUpdatedAt === mark) { c.folderId = id; c.folderUpdatedAt = now; c.updatedAt = now; back.push(c); }
    });
    return writeFolders(back, { folderIds: [id].concat(subIds), collectionIds: back.map(function (c) { return c.id; }), reason: "restore" })
      .then(function () { return f; });
  }

  // saveFolders(records) → Promise<number>: an import's merged folders (M.exporter.importJSON), upserted by id with
  // their own stamps (an import is not an edit), in ONE write; the other folders stay as they are. A parent that would
  // close a loop, or that names no live folder, is stored as the readers see it (so no loop is ever stored): a loop
  // the records close with folders already here is cut where the readers cut it (its newest folder goes to the top
  // level), and that folder is stored so even when it is not one of the records (repair LIB-2, 2026-11-11).
  function saveFolders(records) {
    if (lockedOut()) return Promise.reject(lockError());
    var ids = [];
    (Array.isArray(records) ? records : []).forEach(function (f) {
      if (!f || typeof f !== "object" || typeof f.id !== "string" || !f.id) return;
      var rec = {};
      Object.keys(f).forEach(function (k) { if (k !== "__proto__") rec[k] = f[k]; });
      if (rec.deletedAt === undefined) rec.deletedAt = null;
      fols.set(rec.id, rec);
      ids.push(rec.id);
    });
    if (!ids.length) return Promise.resolve(0);
    folderIdx = null;
    var idx = folderIndex();
    ids.forEach(function (id) {
      var f = fols.get(id);
      if (!live(f)) return;
      var p = idx.parent.get(id), stored = typeof f.parentId === "string" && f.parentId ? f.parentId : null;
      if (p !== undefined && p !== stored) f.parentId = p;
    });
    var changed = ids.slice();
    idx.cuts.forEach(function (id) {
      var f = fols.get(id);
      if (!live(f) || f.parentId === null || f.parentId === undefined || ids.indexOf(id) >= 0) return;
      f.parentId = null;
      changed.push(id);
    });
    return writeFolders([], { folderIds: changed, collectionIds: [], reason: "import" }).then(function () { return ids.length; });
  }

  var api = {
    load: load,
    reload: reload,
    loaded: function () { return isLoaded; },
    collections: collections,
    collection: collection,
    prompts: prompts,
    promptsOf: promptsOf,
    prompt: prompt,
    savePrompt: savePrompt,
    patchPrompts: patchPrompts,
    removePrompt: removePrompt,
    restorePrompt: restorePrompt,
    saveCollection: saveCollection,
    removeCollection: removeCollection,
    restoreCollection: restoreCollection,
    counts: counts,
    recontext: recontext,
    contextFor: computeContext,
    // FEATURES L1 (BUILD-NOTES "Library folders"): one-pass counts, and the folders
    countsBy: countsBy,
    folders: folders,
    folder: folder,
    folderParent: folderParent,
    folderChildren: folderChildren,
    folderPath: folderPath,
    folderOf: folderOf,
    folderMembers: folderMembers,
    createFolder: createFolder,
    renameFolder: renameFolder,
    moveFolder: moveFolder,
    moveCollection: moveCollection,
    removeFolder: removeFolder,
    restoreFolder: restoreFolder,
    saveFolders: saveFolders,
    FOLDERS_KEY: FOLDERS_KEY,
    FOLDER_NAME_MAX: FOLDER_NAME_MAX
  };

  M.cache = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

/* SELF-CHECK (SPEC §17 M.cache): load() → Promise; collections(); collection(id); prompts(); promptsOf(collectionId); prompt(id);
 * savePrompt(p, {content}) → Promise<Prompt> (sets updatedAt (+contentUpdatedAt when a person-edited field changed, +revisedAt
 * when a content save changed the text: FIXES-1 FIX-5), derives/deletes
 * dueAt, emits prompt:saved {prompt, isNew}; rejects code "store" when the store write fails, a never-stored new prompt is dropped
 * with prompt:deleted); removePrompt(id) (tombstone, prompt:deleted); restorePrompt(id) (prompt:restored); saveCollection(c)
 * (collection:changed); removeCollection(id) (cascades in one transaction: prompts tombstoned, chunks deleted, collection:deleted);
 * counts(collectionId|null, now) → {prompts, cards, due, nextDueAt, writtenToday}; recontext(collectionId) → Promise (prompts:recontexted;
 * updatedAt only). Extras: loaded(), restoreCollection(id) (one transaction), contextFor(collection, prompt), {live: true} filter
 * option, {now} option on writes. One writing tab per origin: while M.store.locked() every writer leaves the maps, events and
 * store alone; savePrompt rejects code "locked" and emits prompt:refused {prompt, reason: "locked"} (new event) when the
 * record's text is not blank and differs from this tab's copy; the others resolve with the record unchanged (recontext: 0),
 * except patchPrompts and the folder writers below, which reject code "locked".
 * Extension (FEATURES A9): patchPrompts([{id, fields}], {now}) → Promise<number> — the quiet batch save of fields that are
 * neither content nor derived (the Obsidian send record): in place, no event, updatedAt only (never contentUpdatedAt or
 * dueAt), one prompts.putMany; rejects "bad_patch" for a content, derived or odd field name and "locked" while
 * M.store.locked(), and "store" (toasted) or "locked" when the store write fails, the in-memory change kept.
 * Extension (FEATURES L1, BUILD-NOTES "Library folders"): countsBy(now) → Map<collectionId, counts> (one pass); the
 * folders, kept in ONE meta record "folders" (FOLDERS_KEY; tombstones included; no DB version bump): folders({live}),
 * folder(id), folderParent(id) → id|null, folderChildren(parentId|null) → Folder[], folderPath(id) → [ids from the top],
 * folderOf(collection|id) → folderId|null (a reference to a deleted folder → the nearest live folder above it, to no
 * folder → null; stored loops cut at their newest folder), folderMembers(id) → {folders, collections} (any depth, live);
 * writers createFolder(name, parentId) → Folder, renameFolder(id, name), moveFolder(id, parentId) → {folder, from, to,
 * moved} (rejects "cycle"), moveCollection(id, folderId) → {collection, from, to, moved}, removeFolder(id) → {folder,
 * to, folders, collections} (children up one level, the folder a tombstone), restoreFolder(id, {folders, collections}),
 * saveFolders(records) (import upsert; a loop the records close with folders already here is stored cut where the readers
 * cut it, that folder included, repair LIB-2): each ONE transaction over meta + collections and ONE folders:changed
 * {folderIds, collectionIds, reason} event (new, SPEC §17.3 addition); "locked" rejections in a tab that stepped aside;
 * codes "bad_name", "not_found", "cycle". FOLDER_NAME_MAX (80). */
