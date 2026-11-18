/* js/undo.js — Marginalia undo and redo for cards (DECISIONS D33, BUILD-NOTES "Undo and redo").
 *
 * A STEP is one thing a person did to a card (a prompt, a note or a highlight): a new one, a saved edit, a delete,
 * a flag, "Move to…", "Anchor to selection". M.cache tells this module about a step when a writer is called with
 * opts.step (js/cache.js savePrompt, removePrompt, restorePrompt): note({id, before, after}, step), where before and
 * after are copies of the record as it was and as it is now (null: there was no record). Steps noted with the same
 * token of group() are ONE entry (the deck page's "Add prompts" stores several prompts).
 *
 * undo() takes the newest entry back and redo() makes it again, both through M.cache.revertPrompts, which refuses a
 * prompt that is no longer in the state the step left it in (a review, another window, an import: code "changed") and
 * a prompt whose book or deck is deleted (code "gone"). A refused entry goes away, with every other entry of the same
 * prompts (they all build on a state that is gone), and a notice says why. An entry is never half applied: the cache
 * checks every prompt of it before it changes one, changes them in one go, and stores them in one write; this page
 * keeps the writer role meanwhile (M.store.during).
 *
 * The entries live in this page only (each window of the Mac app has its own, DECISIONS D31): a reload empties them.
 * At most LIMIT entries are kept; the oldest goes first. A new step empties the redo list. A step that takes the
 * newest entry back by hand (Z after a delete, F after F) counts as its undo.
 *
 * No DOM, no storage: the notices go through M.app.toast when it is there. Loads in node.
 */
(function (root) {
  "use strict";
  var M = root.Marginalia = root.Marginalia || {};

  var LIMIT = 100;             // entries kept for undo (and so for redo)
  var EXCERPT = 48;            // characters of a card's text in a notice
  var NOTICE_ID = "undo";      // one notice at a time
  var NOTICE_TTL = 6000;
  var EMPTY_TTL = 2500;

  var TEXT = {
    nothingUndo: "Nothing to undo",
    nothingRedo: "Nothing to redo",
    importing: "Wait until the import finishes, then try again.",
    editor: "Save or cancel the editor of that card first.",
    editorTab: "Save or cancel the editor of that card first. It waits in another tab.",
    moved: "Not undone: you made other changes after that one.",
    already: "That is undone already.",
    late: "That step cannot be undone any more.",
    review: "Not during a review: the review has its own undo.",
    changed: "the card changed after that step",
    changedMany: "one of its cards changed after that step",
    gone: "its book or deck is deleted",
    failed: "Marginalia could not save the change"
  };

  var undos = [];              // entries, oldest first: {changes: [{id, before, after}], group}
  var redos = [];              // entries taken back, the one to make again last
  var tail = Promise.resolve();   // undo() and redo() run one after the other
  var undone = new WeakSet();     // the tokens of the groups whose entry was taken back (and not made again)

  /* ------------------------------------------------------------------ helpers */

  function noop() {}
  function cache() { return M.cache || null; }
  function live(r) { return !!r && (r.deletedAt === null || r.deletedAt === undefined); }

  // The state M.cache compares (js/cache.js stateKey). Without a cache: a plain copy of what it would read.
  function keyOf(rec) {
    var C = cache();
    if (C && typeof C.stateKey === "function") return C.stateKey(rec);
    if (!rec) return "-";
    try { return JSON.stringify([live(rec), rec.kind, rec.text, rec.tags, !!rec.flagged, rec.collectionId, rec.anchor, rec.cards]); }
    catch (e) { return null; }
  }

  function toast(opts) {
    var app = M.app;
    if (!app || typeof app.toast !== "function") return null;
    try { return app.toast(opts); } catch (e) { return null; }
  }

  /* ------------------------------------------------------------------ words for a notice */

  function nameOf(rec) { return rec && rec.kind === "highlight" ? "highlight" : (rec && rec.kind === "note" ? "note" : "prompt"); }

  // The first line of a card, as plain words (a highlight: its passage).
  function excerpt(rec) {
    if (!rec) return "";
    var text = typeof rec.text === "string" ? rec.text.replace(/!\[[^\]]*\]\(att:[^)]*\)/g, "[image]") : "";
    var lines = text.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
    var first = lines.length ? lines[0].replace(/^Q[.:]\s*/i, "") : "";
    if (!first && rec.anchor && typeof rec.anchor.quote === "string") first = rec.anchor.quote.trim();
    first = first.replace(/\s+/g, " ");
    return first.length > EXCERPT ? first.slice(0, EXCERPT - 1).replace(/\s+$/, "") + "…" : first;
  }

  function json(v) { try { return JSON.stringify(v === undefined ? null : v); } catch (e) { return ""; } }

  // What one change did, in the words of the commands: "New note", "Edit", "Delete", "Move", "Flag" …
  function actionOf(change) {
    var b = change.before, a = change.after;
    if (!b) return "New " + nameOf(a);
    if (live(b) && !live(a)) return "Delete";
    if (!live(b) && live(a)) return "Restore";
    if (!a) return "Change";
    if (b.collectionId !== a.collectionId) return "Move";
    // "Write prompt" on a highlight gives it a text: a new prompt or note, as the reader's N would
    if (b.text !== a.text || b.kind !== a.kind) return b.kind === "highlight" && a.kind !== "highlight" ? "New " + nameOf(a) : "Edit";
    if (!!b.flagged !== !!a.flagged) return a.flagged ? "Flag" : "Unflag";
    if (json(b.anchor) !== json(a.anchor)) return "Anchor change";
    return "Edit";
  }

  // {label, excerpt, where} of an entry. `side` ("before" | "after") is the state its card is in now: the words name
  // the card as the person sees it (after an undo: as it was before the step), or as it last was when it is deleted.
  function describe(entry, side) {
    var list = entry.changes, first = list[0];
    if (list.length > 1) {
      var allNew = list.every(function (c) { return !c.before; });
      var ctxMany = (first.after || first.before || {}).context;
      return { label: list.length + (allNew ? " new prompts" : " changes"), excerpt: "", where: ctxMany && ctxMany.docName ? String(ctxMany.docName) : "" };
    }
    var now = side === "before" ? first.before : first.after, other = side === "before" ? first.after : first.before;
    var shown = live(now) ? now : (live(other) ? other : (now || other));
    var ctx = shown && shown.context && typeof shown.context === "object" ? shown.context : null;
    var where = ctx && ctx.docName ? String(ctx.docName) : "";
    if (ctx && ctx.pageLabel !== null && ctx.pageLabel !== undefined && String(ctx.pageLabel) !== "") where += (where ? " · " : "") + "p. " + ctx.pageLabel;
    return { label: actionOf(first), excerpt: excerpt(shown), where: where };
  }

  function quoted(s) { return s ? " · “" + s + "”" : ""; }

  /* ------------------------------------------------------------------ the entries */

  function entriesWith(ids, list) {
    return list.filter(function (e) { return e.changes.some(function (c) { return ids.indexOf(c.id) >= 0; }); });
  }
  function dropEntries(ids) {
    undos = undos.filter(function (e) { return entriesWith(ids, [e]).length === 0; });
    redos = redos.filter(function (e) { return entriesWith(ids, [e]).length === 0; });
  }
  function removeEntry(entry) {
    var i = undos.indexOf(entry);
    if (i >= 0) undos.splice(i, 1);
    i = redos.indexOf(entry);
    if (i >= 0) redos.splice(i, 1);
  }

  // group() → a token: every step noted with it is one entry. The steps must come one after the other.
  function group() { return { group: true }; }

  // note({id, before, after}, step) → {retract()} | null. M.cache calls it for a writer that got opts.step: `step` is
  // true or a token of group(). before / after: copies of the record (null: no record). A change that leaves the
  // state as it was (stateKey) is no step.
  function note(change, step) {
    if (!change || typeof change.id !== "string" || !change.id) return null;
    var before = change.before === undefined ? null : change.before, after = change.after === undefined ? null : change.after;
    if (!live(before) && !live(after)) return null;         // no card before and none after: nothing a person did to a card
    var kb = keyOf(before), ka = keyOf(after);
    if (kb === null || ka === null || kb === ka) return null;
    var c = { id: change.id, before: before, after: after };
    var token = step && typeof step === "object" ? step : null;
    var top = undos.length ? undos[undos.length - 1] : null;
    // by hand back to where the newest entry began (Z after a delete, F after F): that entry is undone
    if (!token && top && top.changes.length === 1 && top.changes[0].id === c.id &&
        keyOf(top.changes[0].after) === kb && keyOf(top.changes[0].before) === ka) {
      undos.pop();
      redos.push(top);
      return { retract: noop };
    }
    var entry;
    if (token && top && top.group === token) {
      entry = top;
      // one card, one change in an entry: a second step of the group on the same card goes on from the first
      var first = entry.changes.filter(function (x) { return x.id === c.id; })[0];
      if (first) { first.after = c.after; c = first; }
      else entry.changes.push(c);
      if (keyOf(c.before) === keyOf(c.after)) entry.changes.splice(entry.changes.indexOf(c), 1);   // back where it began
      if (!entry.changes.length) removeEntry(entry);
    } else {
      entry = { changes: [c], group: token };
      undos.push(entry);
      while (undos.length > LIMIT) undos.shift();
    }
    var cleared = redos, mine = [];
    redos = mine;
    return {
      // the write of a new prompt failed and the cache dropped the prompt again: this step never happened. The steps
      // that it took out of the redo list are there again, unless another step or an undo came since.
      retract: function () {
        var i = entry.changes.indexOf(c);
        if (i >= 0) entry.changes.splice(i, 1);
        if (entry.changes.length) return;
        removeEntry(entry);
        if (redos === mine && !mine.length) redos = cleared;
      }
    };
  }

  /* ------------------------------------------------------------------ undo and redo */

  // Why no step can run now, or null.
  function blocked() {
    var C = cache(), X = M.exporter, R = M.review, A = M.app;
    if (!C || typeof C.revertPrompts !== "function") return { reason: "unavailable", text: null };
    try { if (typeof C.loaded === "function" && C.loaded() !== true) return { reason: "unavailable", text: null }; } catch (e) { /* go on */ }
    try { if (X && typeof X.isImporting === "function" && X.isImporting() === true) return { reason: "importing", text: TEXT.importing }; } catch (e3) { /* go on */ }
    try {
      if (R && typeof R.isActive === "function" && R.isActive() === true &&
          !(typeof R.isSuspended === "function" && R.isSuspended() === true)) return { reason: "review", text: TEXT.review };
    } catch (e4) { /* go on */ }
    // a question, a dialog, the settings or the ? sheet is up (a notice's button can still be clicked then)
    try { if (A && typeof A.modal === "function" && A.modal() === true) return { reason: "modal", text: null }; } catch (e5) { /* go on */ }
    return null;
  }

  // The prompts that an editor holds now: the margin's editor, the editors that wait with tabs not on screen
  // (js/tabs.js), the prompt list's row editor. Their text is in that editor, so no step changes such a card under it.
  // The second editor of a Split is for a new prompt, but it holds the first half too (the two belong together until
  // it is saved or cancelled): its draft is "split:<the first half's id>". Any other editor for a NEW prompt (the deck
  // page's add box too) holds no card.
  var SPLIT_DRAFT_PREFIX = "split:";                         // as js/editor.js, js/margin.js and js/list.js
  function heldBy(ed, out) {
    if (!ed || typeof ed !== "object") return;
    if (typeof ed.promptId === "string" && ed.promptId) out.push(ed.promptId);
    if (typeof ed.draftKey === "string" && ed.draftKey.indexOf(SPLIT_DRAFT_PREFIX) === 0 && ed.draftKey.length > SPLIT_DRAFT_PREFIX.length) {
      out.push(ed.draftKey.slice(SPLIT_DRAFT_PREFIX.length));
    }
  }
  // → {here, tabs}: the prompts that an editor on screen holds, and those of the editors that wait with other tabs.
  function editingIds() {
    var here = [], tabs = [], G = M.margin, T = M.tabs, L = M.list;
    try { heldBy(G && typeof G.editing === "function" ? G.editing() : null, here); } catch (e) { /* no margin */ }
    try { (T && typeof T.heldEditors === "function" ? T.heldEditors() || [] : []).forEach(function (ed) { heldBy(ed, tabs); }); } catch (e1) { /* no tabs */ }
    try {
      var id = L && typeof L.editingId === "function" ? L.editingId() : null;
      if (typeof id === "string" && id) here.push(id);
    } catch (e2) { /* no list */ }
    return { here: here, tabs: tabs };
  }

  // The Mac app (DECISIONS D31): only the window that holds the writer role writes, and a window that takes the role
  // reads the library again first. So the role comes BEFORE anything is compared. → Promise<boolean>
  function role() {
    var A = M.app;
    if (!A || typeof A.takeRole !== "function") return Promise.resolve(true);
    try { return Promise.resolve(A.takeRole()).then(function (ok) { return ok === true; }, function () { return false; }); }
    catch (e) { return Promise.resolve(false); }
  }

  // The writes of one entry belong together: while they run this page keeps the writer role (js/store.js during();
  // a window that asks for the role meanwhile waits until they have ended).
  function keeping(work) {
    var S = M.store;
    try { return Promise.resolve(S && typeof S.during === "function" ? S.during(work) : work()); }
    catch (e) { return Promise.reject(e); }
  }

  function refuse(dir, entry, why, ids) {
    var d = describe(entry, dir === "undo" ? "after" : "before"), text = "Not " + (dir === "undo" ? "undone" : "redone") + ": " + why + ".";
    dropEntries(ids);                                       // the entry itself holds them, so it goes too
    toast({ id: NOTICE_ID, text: text, detail: (d.label + quoted(d.excerpt)).trim(), ttl: NOTICE_TTL });
  }

  function apply(dir, opts) {
    var stop = blocked();
    if (stop) {
      if (stop.text) toast({ id: NOTICE_ID, text: stop.text, ttl: NOTICE_TTL });
      return Promise.resolve({ ok: false, action: dir, reason: stop.reason });
    }
    return role().then(function (writer) {
      if (!writer) return { ok: false, action: dir, reason: "role" };
      return keeping(function () { return applyEntry(dir, opts); });
    });
  }

  // The newest entry of the list. M.cache.revertPrompts checks it as a whole and writes it as a whole.
  function applyEntry(dir, opts) {
    var from = dir === "undo" ? undos : redos, entry = from.length ? from[from.length - 1] : null;
    // undo({group}): that group's entry only (the "Undo" of the notice "Added n prompts"), and only while it is the
    // newest one. (A group has two entries when another step came between its writes: the newest of them counts.)
    if (opts && opts.group) {
      var mine = null;
      for (var i = undos.length - 1; i >= 0 && !mine; i--) if (undos[i].group === opts.group) mine = undos[i];
      if (mine && mine !== entry) {
        toast({ id: NOTICE_ID, text: TEXT.moved, ttl: NOTICE_TTL });
        return { ok: false, action: dir, reason: "moved" };
      }
      if (!mine) {                                            // it was taken back already, or it is gone from the list
        var was = undone.has(opts.group);
        toast({ id: NOTICE_ID, text: was ? TEXT.already : TEXT.late, ttl: EMPTY_TTL });
        return { ok: false, action: dir, reason: was ? "already" : "late" };
      }
    }                                                         // here the group's entry is `entry`, the newest one
    if (!entry) {
      toast({ id: NOTICE_ID, text: dir === "undo" ? TEXT.nothingUndo : TEXT.nothingRedo, ttl: EMPTY_TTL });
      return { ok: false, action: dir, reason: "empty" };
    }
    var list = entry.changes, held = editingIds();
    var onScreen = list.some(function (c) { return held.here.indexOf(c.id) >= 0; });
    if (onScreen || list.some(function (c) { return held.tabs.indexOf(c.id) >= 0; })) {
      toast({ id: NOTICE_ID, text: onScreen ? TEXT.editor : TEXT.editorTab, ttl: NOTICE_TTL });
      return { ok: false, action: dir, reason: "editor" };
    }
    // undo: each prompt from its `after` to its `before`; redo: the other way round
    var changes = list.map(function (c) { return dir === "undo" ? { id: c.id, from: c.after, to: c.before } : { id: c.id, from: c.before, to: c.after }; });
    return Promise.resolve().then(function () { return cache().revertPrompts(changes, { now: Date.now() }); }).then(function () {
      return taken(dir, entry);
    }, function (e) {
      var code = e && e.code ? String(e.code) : "error";
      // "store": the write failed, the cache keeps the change in memory (and has said so); the step counts as taken
      if (code === "store") return taken(dir, entry);
      // "locked": this page stopped writing (it says that itself). The cache refused before it changed anything, so
      // the entry stays
      if (code === "locked") return { ok: false, action: dir, reason: "locked" };
      var ids = e && Array.isArray(e.ids) && e.ids.length ? e.ids.slice() : list.map(function (c) { return c.id; });
      var why = code === "gone" ? TEXT.gone : (code === "changed" ? (list.length > 1 ? TEXT.changedMany : TEXT.changed) : TEXT.failed);
      refuse(dir, entry, why, ids);
      return { ok: false, action: dir, reason: code, ids: ids };
    });
  }

  // The entry is written: it moves to the other list, and the notice offers the way back.
  function taken(dir, entry) {
    removeEntry(entry);
    (dir === "undo" ? redos : undos).push(entry);
    if (entry.group) { if (dir === "undo") undone.add(entry.group); else undone.delete(entry.group); }
    var d = describe(entry, dir === "undo" ? "before" : "after"), back = dir === "undo" ? "redo" : "undo";
    toast({
      id: NOTICE_ID, text: d.label + (dir === "undo" ? " undone" : " redone") + quoted(d.excerpt), detail: d.where, ttl: NOTICE_TTL,
      actions: [{ label: back === "redo" ? "Redo" : "Undo", run: function () { (back === "redo" ? redo : undo)(); } }]
    });
    return { ok: true, action: dir, label: d.label, ids: entry.changes.map(function (c) { return c.id; }) };
  }

  function enqueue(dir, opts) {
    var r = tail.then(function () { return apply(dir, opts); });
    tail = r.then(noop, noop);
    return r;
  }

  // undo() / redo() → Promise<{ok, action, reason?, label?, ids?}>. reason: "empty" (nothing to take back),
  // "changed", "gone", "importing", "review", "modal", "editor" (a card of the step is open in an editor), "locked",
  // "role", "unavailable", or the cache's error code. undo({group: token}) takes back only the entry of that group,
  // and only while it is the newest one ("moved" when another step came after it, "already" when it was taken back,
  // "late" when it is not in the list for another reason).
  function undo(opts) { return enqueue("undo", opts && opts.group ? { group: opts.group } : null); }
  function redo() { return enqueue("redo"); }

  // run("undo" | "redo") → boolean: M.app's key routing (the work goes on by itself; the notice tells the result).
  function run(id) {
    if (id !== "undo" && id !== "redo") return false;
    enqueue(id).then(noop, noop);
    return true;
  }

  function peek(dir) {
    var from = dir === "redo" ? redos : undos, entry = from.length ? from[from.length - 1] : null;
    return entry ? describe(entry, dir === "redo" ? "before" : "after") : null;
  }

  // The texts of every snapshot: M.attachments keeps the pictures they name (an undo may bring such a text back).
  function texts() {
    var out = [];
    undos.concat(redos).forEach(function (e) {
      e.changes.forEach(function (c) {
        if (c.before && typeof c.before.text === "string" && c.before.text) out.push(c.before.text);
        if (c.after && typeof c.after.text === "string" && c.after.text) out.push(c.after.text);
      });
    });
    return out;
  }

  function clear() { undos = []; redos = []; }

  var api = {
    note: note, group: group, undo: undo, redo: redo, run: run,
    canUndo: function () { return undos.length > 0; },
    canRedo: function () { return redos.length > 0; },
    size: function () { return { undo: undos.length, redo: redos.length }; },
    peek: peek, texts: texts, clear: clear, excerpt: excerpt,
    // resolves when no undo() or redo() is under way any more (the keys start them and do not wait)
    idle: function () { return tail; },
    LIMIT: LIMIT, TEXT: TEXT, NOTICE_ID: NOTICE_ID
  };
  M.undo = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

/* Contract (BUILD-NOTES "Undo and redo", DECISIONS D33):
 * note({id, before, after}, step) → {retract()} | null (M.cache only); group() → token;
 * undo({group}?) / redo() → Promise<{ok, action: "undo" | "redo", reason?, label?, ids?}>; run("undo" | "redo") → boolean;
 * canUndo() / canRedo() → boolean; size() → {undo, redo}; peek("undo" | "redo") → {label, excerpt, where} | null;
 * texts() → string[] (the texts of the snapshots, for M.attachments); clear(); excerpt(record) → string;
 * LIMIT (100), TEXT (the notices), NOTICE_ID ("undo").
 * Notices (M.app.toast, id "undo"): "<Action> undone · “<first line>”" with Redo, "<Action> redone · “…”" with Undo
 * (detail: the book or deck and the page); "Nothing to undo" / "Nothing to redo"; "Not undone: the card changed after
 * that step." / "… its book or deck is deleted." / "… Marginalia could not save the change." (detail: the action and
 * the first line); "Wait until the import finishes, then try again."; "Save or cancel the editor of that card first."
 * (with "It waits in another tab." when no editor on screen holds the card); "Not undone: you made other changes after
 * that one."; "That is undone already."; "That step cannot be undone any more."; "Not during a review: the review has
 * its own undo."
 * idle() → Promise (no undo or redo is under way).
 * Actions: New prompt | New note | New highlight | Edit | Delete | Restore | Move | Flag | Unflag | Anchor change |
 * "<n> new prompts" | "<n> changes".
 */
