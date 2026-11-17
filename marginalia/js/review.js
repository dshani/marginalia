/* Marginalia — js/review.js
 * M.review: the review session and the review overlay (SPEC §2 "Review overlay"; §7 "Session",
 * "Grading UI", "Starburst", "Configurable shortcuts", "End of session", "Go to source"; §14 context
 * line; §16 rendering; §17.2 signatures; BUILD-NOTES "Routing and review triggers").
 *
 * Two layers in one file:
 *  - the session (queue from M.scheduler.buildQueue over the live prompts of M.cache, reveal / grade /
 *    skip / undo, the MAX_ASKS retry tail, suspend / resume, the summary) is DOM-free and runs in node;
 *  - the overlay (context line, question, answer, source quote, grading bar with M.keys.label caps, the
 *    starburst SVG + legend, the empty and end screens) exists only when a document and #review exist.
 * Nothing is key-bound here: M.app dispatches the review bindings and calls the functions below; after
 * every action focus moves to #review (tabindex −1), never to a button. Grades are persisted at once
 * with M.cache.savePrompt(prompt, {content: false}).
 * The focus owner is "review" from start() until stop(): the end screen ("All caught up …") and the
 * empty screen (nothing due / nothing written today / no reviewable prompts) keep the overlay up, so
 * the exit binding and the Back / Exit buttons still reach stop(), which restores the previous owner.
 * Scope "folder" (FEATURES L1.5; collectionId = the folder's id): the due cards (one per prompt, D27) of every book
 * and deck in the folder and its sub-folders at any depth (M.cache.folderMembers, read once at start), queued exactly as "all"
 * queues them (M.scheduler.buildQueue with scope "all" over those prompts); the context line and grading are as
 * ever, and the end and empty screens name the folder ("Folder “Physics”").
 */
(function (root) {
  "use strict";
  var M = root.Marginalia = root.Marginalia || {};
  function dep(name) { return M[name] || (typeof require === "function" ? require("./" + name + ".js") : undefined); }

  var HOST_ID = "review";
  var LABELS = ["5d", "2wk", "1mo", "2mo", "4mo", "1yr"];
  var UNDO_DELETE_TTL = 8000;  // the "Prompt deleted" toast (FEATURES P1.3 c), as long as the reader's and the list's
  var UNDO_TOAST_ID = "review-undo-delete";
  var session = null;       // the §7 session object (+ ui state); null when no session exists
  var ui = null;            // mounted overlay elements; null in node and between sessions
  var offs = [];            // bus unsubscribers of the running session
  var resizeHandler = null;
  var deleteToast = null;   // {promptId, handle} of the "Prompt deleted" toast while it may still show

  // ---- module access: pure modules through dep(); DOM/storage modules only when present ----
  function S() { return dep("scheduler"); }
  function U() { return dep("util"); }
  function P() { return dep("prompts"); }
  function C() { return dep("context"); }
  function K() { return dep("keys"); }
  function settingsMod() { return dep("settings"); }
  function busMod() { return M.bus || dep("bus"); }
  function emit(type, payload) { var b = busMod(); if (b && typeof b.emit === "function") b.emit(type, payload); }
  function listen(type, fn) { var b = busMod(); if (b && typeof b.on === "function") offs.push(b.on(type, fn)); }
  function unlisten() { while (offs.length) { try { offs.pop()(); } catch (e) { /* already gone */ } } }
  function now() { return Date.now(); }
  function esc(s) { return U().escapeHtml(s); }
  function keyOf(it) { return String(it.promptId) + "#" + it.cardIndex; }
  function itemCopy(it) { return { promptId: it.promptId, cardIndex: it.cardIndex }; }

  function cache() { return M.cache || null; }
  function cachePrompts() { var c = cache(); try { return c && typeof c.prompts === "function" ? (c.prompts() || []) : []; } catch (e) { return []; } }
  function cachePrompt(id) { var c = cache(); try { return c && typeof c.prompt === "function" ? (c.prompt(id) || null) : null; } catch (e) { return null; } }
  function cacheCollection(id) { var c = cache(); try { return c && typeof c.collection === "function" ? (c.collection(id) || null) : null; } catch (e) { return null; } }

  function liveCollection(p) { var c = cacheCollection(p.collectionId); return !(c && c.deletedAt); }
  function isLive(p) { return !!p && (p.deletedAt === null || p.deletedAt === undefined) && (p.kind === "qa" || p.kind === "cloze") && liveCollection(p); }

  // The prompt and card behind a queue item, or null when the prompt was deleted, lost its
  // reviewable kind or lost that card meanwhile (such an item is skipped).
  function resolve(item) {
    if (!item) return null;
    var p = cachePrompt(item.promptId);
    if (!isLive(p)) return null;
    var card = Array.isArray(p.cards) ? p.cards[item.cardIndex] : null;
    return card ? { prompt: p, card: card } : null;
  }

  function minDue(cards) {
    var m = null;
    for (var i = 0; i < cards.length; i++) {
      var d = cards[i] ? cards[i].dueAt : null;
      if (typeof d === "number" && isFinite(d) && (m === null || d < m)) m = d;
    }
    return m;
  }

  // Write one card back into its prompt: dueAt = min over cards (§8), persisted at once through the
  // cache (which sets updatedAt, writes the store and toasts "Could not save" on failure).
  function persistCard(prompt, cardIndex, card) {
    var cards = (Array.isArray(prompt.cards) ? prompt.cards : []).slice();
    cards[cardIndex] = card;
    var next = Object.assign({}, prompt, { cards: cards });
    var due = minDue(cards);
    if (due === null) delete next.dueAt; else next.dueAt = due;
    var c = cache();
    if (!c || typeof c.savePrompt !== "function") return;
    try {
      var r = c.savePrompt(next, { content: false });
      if (r && typeof r.catch === "function") r.catch(function () { /* the cache reports it */ });
    } catch (e) { /* the cache reports storage failures */ }
  }

  function inScope(p, s) {
    if (s.scope === "folder") return !!s.members && s.members.has(p.collectionId);
    if (s.scope === "book" || s.scope === "deck") return p.collectionId === s.collectionId;
    if (s.scope === "today" && s.collectionId !== null) return p.collectionId === s.collectionId;
    return true;
  }

  function isNum(v) { return typeof v === "number" && isFinite(v); }

  // The time from which card k of prompt p can be asked (M.scheduler.readyTime: its due time less the 16-hour
  // lookahead, and never before 16 hours after an answer to it or to another card of its prompt, D29). A card never
  // asked is due at once (D27) whatever its createdAt says (a clock set back, an import from a clock that ran ahead):
  // unless another card holds it back, its time is never later than `t`.
  function readyOf(p, k, t) { return S().readyTime(p, k, t); }

  // The earliest time from which a live card in the session's scope can be asked, skipping the keys in `exclude`
  // (the held blanks, which the end line names itself); null when nothing is scheduled.
  function nextDue(s, exclude, t) {
    var ps = cachePrompts(), best = null;
    for (var i = 0; i < ps.length; i++) {
      var p = ps[i];
      if (!isLive(p) || !inScope(p, s) || !Array.isArray(p.cards)) continue;
      for (var k = 0; k < p.cards.length; k++) {
        if (!p.cards[k] || exclude.has(keyOf({ promptId: p.id, cardIndex: k }))) continue;
        var d = readyOf(p, k, t);
        if (isNum(d) && (best === null || d < best)) best = d;
      }
    }
    return best;
  }

  // How many live cards of the session's scope can be asked at `t` (M.scheduler.isReady).
  function readyCount(s, t) {
    var ps = cachePrompts(), sc = S(), n = 0;
    for (var i = 0; i < ps.length; i++) {
      var p = ps[i];
      if (!isLive(p) || !inScope(p, s) || !Array.isArray(p.cards)) continue;
      for (var k = 0; k < p.cards.length; k++) if (p.cards[k] && sc.isReady(p, k, t)) n++;
    }
    return n;
  }

  // The outcome of the item's latest answer in this session ("" when it was not answered in it).
  function lastOutcome(s, k) {
    for (var i = s.log.length - 1; i >= 0; i--) if (keyOf(s.log[i]) === k) return s.log[i].outcome;
    return "";
  }

  // ---- session ---------------------------------------------------------------
  // A folder review's books and decks (FEATURES L1.5): the live collections in the folder at any depth, and its name.
  function folderScope(folderId) {
    var c = cache(), members = new Set(), name = "";
    try {
      var m = c && typeof c.folderMembers === "function" ? c.folderMembers(folderId) : null;
      ((m && m.collections) || []).forEach(function (id) { members.add(id); });
      var f = c && typeof c.folder === "function" ? c.folder(folderId) : null;
      name = f && f.name ? String(f.name) : "";
    } catch (e) { /* no folders: an empty scope */ }
    return { members: members, name: name };
  }

  function newSession(scope, collectionId, t, items) {
    return {
      scope: scope, collectionId: collectionId,
      items: items.slice(),             // the first pass, in queue order (rays, retry tails, summary)
      queue: items.slice(), index: 0,   // the working list: skips move items, retry tails append
      asks: new Map(), skips: new Map(), dropped: new Set(),
      removed: new Set(),               // ids of the prompts deleted in this session (FEATURES P1.3 c): they never rejoin it
      shown: new Map(),                 // promptId → the first card index shown (the end screen's flagged list)
      undo: null, startedAt: t, seed: t, log: [],
      revealed: false, preview: null, suspended: false,
      ended: false, completed: false, endedAt: null, endedEmitted: false, summary: null,
      prevOwner: null, invoker: null
    };
  }

  function start(opts) {
    return new Promise(function (resolveP, rejectP) {
      try {
        opts = opts || {};
        var scope = opts.scope;
        var collectionId = (opts.collectionId === undefined || opts.collectionId === null) ? null : opts.collectionId;
        var t = (typeof opts.now === "number" && isFinite(opts.now)) ? opts.now : now();
        var pool = cachePrompts().filter(liveCollection), folder = null;
        if (scope === "folder") {
          if (collectionId === null) { var bad = new Error("A folder review needs the folder's id"); bad.code = "bad_scope"; throw bad; }
          folder = folderScope(collectionId);
          pool = pool.filter(function (p) { return folder.members.has(p.collectionId); });
        }
        // a folder is queued exactly as "Review all" (FEATURES L1.5)
        var items = S().buildQueue({ prompts: pool, scope: folder ? "all" : scope, collectionId: folder ? null : collectionId, now: t, seed: t }); // throws code "bad_scope"
        if (session) stop();                          // a new session replaces a running or suspended one
        var s = session = newSession(scope, collectionId, t, items);
        if (folder) { s.members = folder.members; s.folderName = folder.name; }
        s.prevOwner = currentOwner();
        s.invoker = activeElement();
        setOwner("review");
        subscribe();
        mount();
        showCurrent(false);
        focusHost();
        resolveP();
      } catch (e) { rejectP(e); }
    });
  }

  // Settle on the item at `index`, skipping cards whose prompt was deleted (or edited away) meanwhile;
  // at the end of the queue the pass ends. keep = keep the revealed state (resume, re-render).
  function showCurrent(keep) {
    var s = session;
    while (s.index < s.queue.length && !resolve(s.queue[s.index])) s.queue.splice(s.index, 1);
    if (s.index >= s.queue.length) { endOfPass(); return; }
    if (!keep) s.revealed = false;
    var shown = s.queue[s.index];
    if (!s.shown.has(shown.promptId)) s.shown.set(shown.promptId, shown.cardIndex);
    s.preview = null;
    render();
  }

  // §7: the items answered wrong come again, in original order, unless asks ≥ MAX_ASKS; the session ends when
  // nothing is appended. The retry is the session's own business (D28): a card answered wrong is due the next day,
  // so the scheduler no longer says "due" for it. An item that was not answered in this session at all (its prompt
  // was away when its turn came) comes again while its card can still be asked.
  function endOfPass() {
    var s = session, sc = S(), t = now();
    if (!s.items.length) { s.ended = true; s.completed = true; render(); return; }   // nothing to review: the empty screen
    var tail = [];
    for (var i = 0; i < s.items.length; i++) {
      var it = s.items[i], k = keyOf(it);
      if (s.removed.has(it.promptId) || s.dropped.has(k) || (s.asks.get(k) || 0) >= sc.MAX_ASKS) continue;
      var r = resolve(it), last = lastOutcome(s, k);
      if (r && (last === "forgot" || (last === "" && sc.isReady(r.prompt, it.cardIndex, t)))) tail.push(it);
    }
    if (tail.length) { s.queue = s.queue.concat(tail); showCurrent(false); return; }
    finish();
  }

  // The end screen keeps the overlay up. review:ended is emitted here (the summary is final), but a
  // listener that hands the focus owner back to the screen on it (M.app does) must not take the keys
  // away from the overlay: the owner is retaken and stays "review" until stop() — the exit binding and
  // the Back / Exit buttons — and focus stays on #review.
  function finish() {
    var s = session;
    s.ended = true; s.completed = true; s.endedAt = now();
    s.summary = buildSummary();
    if (!s.endedEmitted) {
      s.endedEmitted = true;
      emit("review:ended", { summary: s.summary });
      if (session === s && !s.suspended) setOwner("review");
    }
    render();
    focusHost();
  }

  // A prompt deleted in this session (FEATURES P1.3 c) is counted apart: its grades and skips are not counted, and
  // `deleted` counts the deleted prompts that are still deleted when the summary is made.
  function promptOfKey(k) { var i = k.lastIndexOf("#"); return i < 0 ? k : k.slice(0, i); }
  function buildSummary() {
    var s = session, sc = S(), t = s.endedAt || now();
    var graded = new Set(), remembered = 0, forgot = 0, log = [], i;
    for (i = 0; i < s.log.length; i++) {
      if (s.removed.has(s.log[i].promptId)) continue;
      log.push(s.log[i]);
      graded.add(keyOf(s.log[i]));
      if (s.log[i].outcome === "remembered") remembered++; else forgot++;
    }
    // the still-shaky cards come again 16 hours after their last answer (D28, D29): shakyDueAt is the earliest of those times
    var shaky = [], shakyKeys = new Set(), shakyPrompts = new Set(), shakyDueAt = null;
    for (i = 0; i < s.items.length; i++) {
      var it = s.items[i], k = keyOf(it);
      if (!graded.has(k)) continue;
      var r = resolve(it);
      if (r && lastOutcome(s, k) === "forgot") {
        shaky.push(itemCopy(it)); shakyKeys.add(k); shakyPrompts.add(it.promptId);
        var st = readyOf(r.prompt, it.cardIndex, t);
        if (isNum(st) && (shakyDueAt === null || st < shakyDueAt)) shakyDueAt = st;
      }
    }
    // D27: a queue holds one card per prompt. D29: the other due cards of this session's prompts (the other blanks of
    // its sentences) wait until the next day: `held` counts those that an answer holds back now, heldUntil is the
    // earliest time one of them can be asked, and nextDueAt leaves them out (the end line names them).
    var held = 0, heldUntil = null, heldKeys = new Set(), itemKeys = new Set(), sessionPrompts = new Set();
    for (i = 0; i < s.items.length; i++) {
      itemKeys.add(keyOf(s.items[i]));
      if (!s.removed.has(s.items[i].promptId)) sessionPrompts.add(s.items[i].promptId);
    }
    sessionPrompts.forEach(function (id) {
      var p = cachePrompt(id);
      if (!isLive(p) || !inScope(p, s) || !Array.isArray(p.cards)) return;   // moved out of the scope meanwhile: its blanks come elsewhere
      for (var c = 0; c < p.cards.length; c++) {
        var hk = keyOf({ promptId: id, cardIndex: c });
        if (!p.cards[c] || itemKeys.has(hk) || !sc.isDue(p.cards[c], t) || !(sc.heldUntil(p, c) > t)) continue;
        held++; heldKeys.add(hk);
        var ht = readyOf(p, c, t);
        if (isNum(ht) && (heldUntil === null || ht < heldUntil)) heldUntil = ht;
      }
    });
    var skipped = 0, deleted = 0;
    s.dropped.forEach(function (k) { if (!s.removed.has(promptOfKey(k))) skipped++; });
    s.removed.forEach(function (id) { var p = cachePrompt(id); if (!p || (p.deletedAt !== null && p.deletedAt !== undefined)) deleted++; });
    // the prompts shown in this session that are flagged now, in the order they were first shown; a still-shaky one
    // is listed there instead (with a ⚑ mark)
    var flagged = [];
    s.shown.forEach(function (cardIndex, id) {
      if (s.removed.has(id) || shakyPrompts.has(id)) return;
      var p = cachePrompt(id);
      if (isLive(p) && p.flagged === true) flagged.push({ promptId: id, cardIndex: cardIndex });
    });
    var sum = {
      scope: s.scope, collectionId: s.collectionId, startedAt: s.startedAt, endedAt: t, completed: !!s.completed,
      total: s.items.length, reviewed: graded.size, grades: log.length, remembered: remembered, forgot: forgot,
      skipped: skipped, deleted: deleted, stillShaky: shaky, shakyDueAt: shakyDueAt, flagged: flagged, held: held, heldUntil: heldUntil,
      dueNow: readyCount(s, t), nextDueAt: nextDue(s, heldKeys, t), log: log
    };
    if (s.scope === "folder") sum.folderName = s.folderName || "";
    return sum;
  }

  function snapshot(kind, item, prevCard) {
    var s = session;
    s.undo = {
      kind: kind, item: itemCopy(item), prevCard: prevCard, index: s.index, queue: s.queue.slice(),
      asks: new Map(s.asks), skips: new Map(s.skips), dropped: new Set(s.dropped), removed: new Set(s.removed),
      logLen: s.log.length, revealed: s.revealed
    };
  }

  function reveal() {
    var s = session;
    if (!s || s.suspended || s.ended || s.revealed || s.index >= s.queue.length) return;   // Space after reveal is inert
    s.revealed = true;
    revealUI();
    focusHost();
  }

  function grade(outcome) {
    var s = session;
    if (!s || s.suspended || s.ended || !s.revealed || s.index >= s.queue.length) return;   // grading needs the answer shown
    var item = s.queue[s.index], r = resolve(item);
    if (!r) { showCurrent(false); return; }
    var t = now();
    var next = S().grade(r.card, t, outcome);          // throws code "bad_outcome"
    snapshot("grade", item, r.card);                   // single-level undo keeps the exact previous object
    persistCard(r.prompt, item.cardIndex, next);
    var k = keyOf(item);
    s.asks.set(k, (s.asks.get(k) || 0) + 1);
    s.log.push({ promptId: item.promptId, cardIndex: item.cardIndex, outcome: outcome, at: t, intervalMs: next.intervalMs, dueAt: next.dueAt });
    emit("review:graded", { promptId: item.promptId, cardIndex: item.cardIndex, outcome: outcome });
    s.index++;
    showCurrent(false);
    focusHost();
  }

  function skip() {
    var s = session;
    if (!s || s.suspended || s.ended || s.index >= s.queue.length) return;
    var item = s.queue[s.index], k = keyOf(item);
    snapshot("skip", item, null);
    var n = s.skips.get(k) || 0;
    s.queue.splice(s.index, 1);
    if (n === 0) { s.skips.set(k, 1); s.queue.push(item); }      // once: to the end of the session
    else { s.skips.set(k, n + 1); s.dropped.add(k); }            // twice: out of the session, ungraded
    showCurrent(false);
    focusHost();
  }

  // F (FEATURES P1.3 b): the current card's prompt flagged or unflagged, saved as the reader's F saves it (a content
  // save; it does not move revisedAt, so a struggling prompt stays struggling: FIXES-1 FIX-5). Before and after the answer shows;
  // the prompt:saved the cache emits re-renders the card (the revealed state stays). Not an undo step.
  function flag() {
    var s = session;
    if (!s || s.suspended || s.ended || s.index >= s.queue.length) return;
    var r = resolve(s.queue[s.index]), c = cache();
    if (!r) { showCurrent(false); return; }
    if (!c || typeof c.savePrompt !== "function") return;
    try {
      var res = c.savePrompt(Object.assign({}, r.prompt, { flagged: !r.prompt.flagged }), { content: true });
      if (res && typeof res.catch === "function") res.catch(function () { /* the cache reports it */ });
    } catch (e) { /* the cache reports storage failures */ }
    focusHost();
  }

  // Backspace (FEATURES P1.3 c): the current card's prompt is deleted at once (M.cache.removePrompt: the whole prompt,
  // all its cards), with no confirm, as the reader deletes. Every queued card of that prompt leaves the session first,
  // so the prompt:deleted the cache emits finds another current card (nothing is handled twice). One undo step.
  function remove() {
    var s = session;
    if (!s || s.suspended || s.ended || s.index >= s.queue.length) return;
    var item = s.queue[s.index], r = resolve(item), c = cache();
    if (!r) { showCurrent(false); return; }
    if (!c || typeof c.removePrompt !== "function") return;
    var id = item.promptId;
    snapshot("delete", item, null);
    for (var i = s.queue.length - 1; i >= s.index; i--) if (s.queue[i].promptId === id) s.queue.splice(i, 1);
    s.removed.add(id);
    s.revealed = false;
    try {
      var res = c.removePrompt(id);
      if (res && typeof res.catch === "function") res.catch(function () { /* the cache reports storage failures */ });
    } catch (e) { /* handled below */ }
    if (isLive(cachePrompt(id))) {                     // refused (a tab that stepped aside): the session stays as it was
      var u = s.undo;
      s.undo = null;
      s.queue = u.queue; s.index = u.index; s.removed = u.removed; s.revealed = u.revealed;
      showCurrent(true);
      focusHost();
      return;
    }
    openDeleteToast(id);
    showCurrent(false);
    focusHost();
  }

  // "Prompt deleted" with Undo (8 s): while the delete is still the session's last step, Undo is the session's undo();
  // after a later grade or skip (or once the session is gone) it only restores the prompt, which does not rejoin it.
  function openDeleteToast(promptId) {
    var a = M.app;
    deleteToast = { promptId: promptId, handle: null };
    var mine = deleteToast;
    try {
      if (a && typeof a.toast === "function") {
        mine.handle = a.toast({ id: UNDO_TOAST_ID, text: "Prompt deleted", ttl: UNDO_DELETE_TTL,
          actions: [{ label: "Undo", run: function () { undoFromToast(promptId, mine); } }] });
      }
    } catch (e) { /* no toasts */ }
  }
  function closeDeleteToast(promptId) {
    var t = deleteToast;
    if (!t || t.promptId !== promptId) return;
    deleteToast = null;
    try { if (t.handle && typeof t.handle.close === "function") t.handle.close(); } catch (e) { /* already closed */ }
  }
  function undoFromToast(promptId, mine) {
    if (deleteToast === mine) deleteToast = null;
    var s = session;
    if (s && !s.suspended && s.undo && s.undo.kind === "delete" && s.undo.item.promptId === promptId) { undo(); return; }
    restoreInCache(promptId);
  }
  function restoreInCache(promptId) {
    var c = cache();
    if (!c || typeof c.restorePrompt !== "function") return;
    try {
      var res = c.restorePrompt(promptId);
      if (res && typeof res.catch === "function") res.catch(function () { /* the cache reports storage failures */ });
    } catch (e) { /* the cache reports storage failures */ }
  }

  function undo() {
    var s = session;
    if (!s || s.suspended || !s.undo) return;
    var u = s.undo;
    s.undo = null;
    s.queue = u.queue; s.index = u.index; s.asks = u.asks; s.skips = u.skips; s.dropped = u.dropped; s.removed = u.removed;
    s.log.length = u.logLen;
    if (s.ended) { s.ended = false; s.completed = false; s.endedAt = null; s.summary = null; s.endedEmitted = false; }
    if (u.kind === "grade") {
      var p = cachePrompt(u.item.promptId);
      if (p && Array.isArray(p.cards)) persistCard(p, u.item.cardIndex, u.prevCard);   // the previous card object, as it was
      s.revealed = true;                                                               // the answer was already seen
    } else if (u.kind === "delete") {
      closeDeleteToast(u.item.promptId);
      restoreInCache(u.item.promptId);                 // synchronous in the cache: the card resolves again at once
      s.revealed = u.revealed;
    } else {
      s.revealed = u.revealed;
    }
    showCurrent(true);
    focusHost();
  }

  function remaining() { var s = session; return s ? Math.max(0, s.queue.length - s.index) : 0; }

  function suspend() {
    var s = session;
    if (!s || s.suspended) return;
    s.suspended = true;
    s.preview = null;
    hideHost();
    setOwner(s.prevOwner || "reader");
    metaSet("pausedSession", { scope: s.scope, collectionId: s.collectionId, index: s.index });
    emit("review:suspended", { remaining: remaining() });
  }

  function resume() {
    var s = session;
    if (!s || !s.suspended) return;
    s.suspended = false;
    s.prevOwner = currentOwner();
    s.invoker = activeElement();
    setOwner("review");
    showHost();
    if (!s.ended) showCurrent(true); else render();
    emit("review:resumed", { remaining: remaining() });
    focusHost();
  }

  function goToSource() {
    var s = session;
    if (!s || s.suspended || s.ended || s.index >= s.queue.length) return;
    var r = resolve(s.queue[s.index]);
    if (!r || !sourceState(r.prompt, cacheCollection(r.prompt.collectionId)).enabled) return;
    suspend();
    emit("review:gotoSource", { promptId: r.prompt.id });
  }

  function current() {
    var s = session;
    if (!s || s.ended || s.index >= s.queue.length) return null;
    var item = s.queue[s.index], r = resolve(item);
    if (!r) return null;
    return { item: itemCopy(item), prompt: r.prompt, card: r.card, revealed: !!s.revealed, position: s.index + 1, total: s.queue.length };
  }

  function isActive() { return !!session && !session.suspended; }
  function isSuspended() { return !!session && session.suspended; }

  function stop() {
    var s = session;
    if (!s) return;
    if (!s.endedEmitted) {
      s.endedEmitted = true;
      s.endedAt = now();
      s.summary = buildSummary();
      emit("review:ended", { summary: s.summary });
    }
    session = null;
    unlisten();
    unmount();
    metaSet("pausedSession", null);
    if (!s.suspended) {                 // a suspended session already handed the focus owner back
      setOwner(s.prevOwner || "library");
      restoreFocus(s.invoker);
    }
  }

  // Deck prompts and lost anchors have no source; a book without its PDF shows "PDF not in library".
  function sourceState(p, col) {
    var isDeck = col ? col.kind === "deck" : !p.anchor;
    if (isDeck || !p.anchor || typeof p.anchor !== "object" || p.anchor.lost === true) return { show: false, enabled: false, label: "" };
    if (col && col.hasBytes === false) return { show: true, enabled: false, label: "PDF not in library" };
    return { show: true, enabled: true, label: "Go to source" };
  }

  function metaSet(key, value) {
    var st = M.store;
    try {
      if (st && st.meta && typeof st.meta.set === "function") {
        var r = st.meta.set(key, value);
        if (r && typeof r.catch === "function") r.catch(function () { /* storage unavailable */ });
      }
    } catch (e) { /* storage unavailable */ }
  }

  function subscribe() {
    unlisten();
    listen("settings:changed", function (e) { if (e && e.key === "reviewKeys" && session && !session.suspended) render(); });
    listen("prompt:saved", function (e) { var p = e && e.prompt; if (p && isCurrentPrompt(p.id)) refresh(); });
    listen("prompt:deleted", function (e) { if (e && isCurrentPrompt(e.promptId)) refresh(); });
    listen("prompts:recontexted", function (e) {
      var c = current();
      if (c && e && c.prompt.collectionId === e.collectionId) refresh();
    });
  }
  function isCurrentPrompt(id) { var s = session; return !!s && !s.ended && s.index < s.queue.length && s.queue[s.index].promptId === id; }
  function refresh() { if (session && !session.suspended && !session.ended) showCurrent(true); }

  // ======================= overlay (DOM only; every entry point returns without a document) =======================
  function doc() { return typeof document === "undefined" ? null : document; }
  function activeElement() { var d = doc(); return d ? d.activeElement : null; }
  function currentOwner() { var a = M.app; try { return a && typeof a.focusOwner === "function" ? (a.focusOwner() || null) : null; } catch (e) { return null; } }
  function setOwner(owner) { var a = M.app; try { if (a && typeof a.setFocusOwner === "function") a.setFocusOwner(owner); } catch (e) { /* app not booted */ } }
  function toast(text) { var a = M.app; try { if (a && typeof a.toast === "function") a.toast({ text: text, ttl: 2500 }); } catch (e) { /* no toasts */ } }
  function route(screen, params) { var a = M.app; try { if (a && typeof a.route === "function") a.route(screen, params); } catch (e) { /* app not booted */ } }
  function isReadingOwner(o) { return o === "reader" || o === "card" || o === "editor"; }

  function focusHost() {
    if (!ui) return;
    try { ui.host.focus({ preventScroll: true }); } catch (e) { try { ui.host.focus(); } catch (e2) { /* detached */ } }
  }
  // A rendered element: display:none on it or on an ancestor (.is-hidden, the source block before reveal)
  // leaves it without client rects, and focus() on it is a silent no-op.
  function isShown(el) {
    try { return !!el && el.isConnected !== false && el.getClientRects().length > 0; } catch (e) { return false; }
  }
  // stop(): back to the invoker while it can still take focus, else to #reader when the reader is open. The
  // invoker can be hidden by then: reader.resumeReview() hides the "Resume review" pill before resume()
  // records document.activeElement, and a no-op focus() on it would leave focus on the body element.
  function restoreFocus(el) {
    var d = doc();
    if (!d) return;
    try {
      if (el && el !== d.body && d.contains(el) && typeof el.focus === "function" && isShown(el)) {
        el.focus({ preventScroll: true });
        if (d.activeElement === el) return;
      }
      var reader = d.getElementById("reader");
      if (reader && !reader.classList.contains("is-hidden")) reader.focus({ preventScroll: true });
    } catch (e) { /* nothing to focus */ }
  }

  function mount() {
    var d = doc();
    if (!d) return;
    var host = d.getElementById(HOST_ID);
    if (!host) return;
    if (ui) unmount();
    host.innerHTML =
      '<div class="review__burst" aria-hidden="true"><svg class="review__svg" xmlns="http://www.w3.org/2000/svg"></svg></div>' +
      '<div class="review__legend" aria-hidden="true"></div>' +
      '<div class="review__count"></div>' +
      '<button type="button" class="review__exit" data-action="exit">Exit review ✕</button>' +
      '<div class="review__column"></div>' +
      '<textarea class="review__copybuf" readonly aria-hidden="true" tabindex="-1"></textarea>';
    host.setAttribute("tabindex", "-1");
    host.setAttribute("role", "dialog");
    host.setAttribute("aria-modal", "true");
    host.setAttribute("aria-label", "Review");
    host.classList.remove("review--done");
    host.classList.remove("is-hidden");
    ui = {
      host: host,
      svg: host.querySelector(".review__svg"),
      legend: host.querySelector(".review__legend"),
      count: host.querySelector(".review__count"),
      column: host.querySelector(".review__column"),
      copybuf: host.querySelector(".review__copybuf"),
      q: null, answer: null, source: null, bar: null, undoEl: null, struggle: null,
      spaceDown: null,      // the last Space keydown on a button of the overlay (onKeyup reads its outcome)
      handlers: { click: onClick, mouseover: onOver, mouseout: onOut, focusin: onOver, focusout: onOut, keydown: onKeydown, keyup: onKeyup }
    };
    Object.keys(ui.handlers).forEach(function (type) { host.addEventListener(type, ui.handlers[type]); });
    ui.copybuf.addEventListener("blur", hideCopybuf);
    resizeHandler = U().debounce(function () { if (ui && session && !session.suspended) renderBurst(); }, 80);
    if (typeof window !== "undefined") window.addEventListener("resize", resizeHandler);
  }

  function unmount() {
    if (!ui) return;
    var host = ui.host, h = ui.handlers;
    Object.keys(h).forEach(function (type) { host.removeEventListener(type, h[type]); });
    if (resizeHandler) {
      if (typeof window !== "undefined") window.removeEventListener("resize", resizeHandler);
      if (typeof resizeHandler.cancel === "function") resizeHandler.cancel();
      resizeHandler = null;
    }
    host.classList.add("is-hidden");
    host.classList.remove("review--done");
    host.innerHTML = "";
    ui = null;
  }
  function hideHost() { if (ui) ui.host.classList.add("is-hidden"); }
  function showHost() { if (ui) ui.host.classList.remove("is-hidden"); }

  // ---- events (delegated; nothing here is a key binding) ----
  function closestAttr(target, attr) {
    var el = target;
    while (el && el !== (ui && ui.host)) {
      if (el.getAttribute && el.getAttribute(attr) !== null) return el;
      el = el.parentNode;
    }
    return null;
  }
  function onClick(ev) {
    var el = closestAttr(ev.target, "data-action");
    if (!el || !ui || el.disabled) return;
    var act = el.getAttribute("data-action");
    ev.preventDefault();
    switch (act) {
      case "exit": case "back": stop(); break;
      case "library": stop(); route("library", {}); break;
      case "reveal": reveal(); break;
      case "skip": skip(); break;
      case "forgot": grade("forgot"); break;
      case "remembered": grade("remembered"); break;
      case "undo": undo(); break;
      case "goToSource": goToSource(); break;
      case "flag": flag(); break;
      case "delete": remove(); break;
      case "copyLatex": copyQuestion(); break;
      case "edit": editPrompt(el.getAttribute("data-id")); break;
      default: break;
    }
  }
  function onOver(ev) { var b = closestAttr(ev.target, "data-outcome"); if (b) setPreview(b.getAttribute("data-outcome")); }
  function onOut(ev) {
    var b = closestAttr(ev.target, "data-outcome");
    if (!b) return;
    var to = ev.relatedTarget;
    if (to && b.contains(to)) return;
    setPreview(null);
  }
  function setPreview(outcome) {
    var s = session;
    if (!s || s.ended || s.suspended) return;
    var o = outcome === "forgot" || outcome === "remembered" ? outcome : null;
    if (o === s.preview) return;
    s.preview = o;
    renderBurst();
  }
  // Tab stays inside the overlay and cycles #review itself plus every shown, enabled button (and the shown copy
  // box) in DOM order: it comes back to the host and never sticks on a button of the hidden source block.
  // Space on a Tab-focused button goes to M.app's dispatcher first, so its keydown passes through untouched
  // here (M.app skips a keydown that is already cancelled). When a review binding takes Space, M.app cancels
  // the keydown, so Chromium / WebKit never arm the button, and onKeyup cancels the keyup activation that
  // Gecko can still fire: the bound action runs instead of also clicking the button. An unbound Space keeps
  // the button's native activation.
  function onKeydown(ev) {
    if (!ui) return;
    if (ev.key === "Tab") {
      ev.preventDefault();
      moveFocus(ev.shiftKey ? -1 : 1);
      return;
    }
    if (ev.key === " ") ui.spaceDown = isButtonTarget(ev.target) ? ev : null;
  }
  function onKeyup(ev) {
    if (!ui || ev.key !== " ") return;
    var down = ui.spaceDown;
    ui.spaceDown = null;
    if (!isButtonTarget(ev.target)) return;
    // Activate only the button whose own Space keydown went unhandled; the keydown's outcome is final by now.
    if (!down || down.target !== ev.target || down.defaultPrevented) ev.preventDefault();
  }
  function isButtonTarget(t) { return !!t && !!ui && t !== ui.host && t.tagName === "BUTTON"; }
  function moveFocus(step) {
    var f = focusables(), d = doc(), n = f.length;
    if (!n || !d) return;
    var i = f.indexOf(d.activeElement);
    if (i < 0) i = 0;                                   // focus elsewhere in the overlay: step as if from the host
    for (var tries = 0; tries < n; tries++) {
      i = (i + step + n) % n;
      try { f[i].focus({ preventScroll: true }); } catch (e) { /* try the next one */ }
      if (d.activeElement === f[i]) return;
    }
  }
  function focusables() {
    if (!ui) return [];
    var out = [ui.host];
    var list = ui.host.querySelectorAll("button:not([disabled]), textarea.is-shown");
    for (var i = 0; i < list.length; i++) if (isShown(list[i])) out.push(list[i]);
    return out;
  }

  // ---- rendering ----
  function render() {
    if (!ui || !session) return;
    var s = session;
    ui.host.classList.toggle("review--done", !!s.ended && s.items.length > 0);
    if (!s.items.length) { renderEmpty(); return; }
    if (s.ended) { renderEnd(); return; }
    renderCard();
    renderBurst();
  }

  function renderMarkup(text, opts) {
    var mk = M.markup;
    if (mk && typeof mk.render === "function") {
      try { return mk.render(text, opts); } catch (e) { /* fall back to escaped text */ }
    }
    return esc(text).replace(/\n/g, "<br>");
  }
  function imageUrl(id) {
    var a = M.attachments;
    try { return a && typeof a.url === "function" ? (a.url(id) || null) : null; } catch (e) { return null; }
  }
  function promptHtml(p, parsed, cardIndex, revealed, side) {
    if (p.kind === "cloze") return renderMarkup(parsed.body, { mode: "review", mask: { index: cardIndex, reveal: !!revealed }, imageUrl: imageUrl });
    return renderMarkup(side === "answer" ? parsed.answer : parsed.question, { mode: "review", mask: null, imageUrl: imageUrl });
  }
  function contextLine(col, p) { var c = C(); return c.fit(c.line(col || {}, p)); }
  function qSizeClass(text) {
    var n = String(text || "").replace(/!\[[^\]\n]*\]\(att:[^)\s]+\)/g, "").length;
    return n <= 140 ? "" : (n <= 300 ? " review__q--m" : " review__q--s");
  }
  function bindingFor(action) {
    var keys = null;
    try { keys = settingsMod().get("reviewKeys"); } catch (e) { keys = null; }
    var b = keys && Object.prototype.hasOwnProperty.call(keys, action) ? keys[action] : K().PRESETS.Default[action];
    if (b && typeof b === "object" && !Array.isArray(b)) b = b.binding;
    return b || null;
  }
  function kbdHtml(action) {
    var b = bindingFor(action), label = "";
    try { label = b ? K().label(b) : ""; } catch (e) { label = ""; }
    return label ? '<kbd class="review__kbd">' + esc(label) + "</kbd>" : "";
  }
  function btnHtml(action, label, keyAction, sub, extraClass, outcome) {
    return '<button type="button" class="review__btn' + (extraClass || "") + '" data-action="' + action + '"' +
      (outcome ? ' data-outcome="' + outcome + '"' : "") + '><span class="review__btn-label">' + esc(label) + "</span>" +
      kbdHtml(keyAction) + (sub ? '<span class="review__sub">· ' + esc(sub) + "</span>" : "") + "</button>";
  }

  function renderCard() {
    var s = session, item = s.queue[s.index], r = resolve(item);
    if (!r) { showCurrent(true); return; }
    var p = r.prompt, parsed = P().parse(p.text || ""), isCloze = p.kind === "cloze";
    var col = cacheCollection(p.collectionId);
    var line = contextLine(col, p);
    var quote = p.anchor && typeof p.anchor.quote === "string" ? p.anchor.quote.trim() : "";
    var src = sourceState(p, col);
    var html = '<div class="review__context" title="' + esc(line) + '">' + esc(line) + "</div>" +
      '<div class="review__q' + qSizeClass(isCloze ? parsed.body : parsed.question) + (isCloze && s.revealed ? " review__q--revealed" : "") + '">' +
      promptHtml(p, parsed, item.cardIndex, s.revealed, "question") + "</div>";
    if (!isCloze) {
      html += '<div class="review__a' + (s.revealed ? " is-shown" : "") + '"' + (s.revealed ? "" : ' aria-hidden="true"') + ">" +
        promptHtml(p, parsed, item.cardIndex, true, "answer") + "</div>";
    }
    html += '<div class="review__source' + (s.revealed ? "" : " is-hidden") + '">' +
      (quote ? '<blockquote class="review__quote">' + esc(quote) + "</blockquote>" : "") +
      '<div class="review__actions">' +
      (src.show ? '<button type="button" class="review__link" data-action="goToSource"' + (src.enabled ? "" : " disabled") + ">" +
        esc(src.label) + (src.enabled ? kbdHtml("goToSource") : "") + "</button>" : "") +
      '<button type="button" class="review__link" data-action="copyLatex">Copy question LaTeX</button>' +
      "</div></div>" +
      '<div class="review__struggle-slot">' + (s.revealed ? struggleHtml(p, r.card) : "") + "</div>" +
      '<div class="review__bar"></div><div class="review__undo"></div>' +
      '<div class="review__tools">' + (p.flagged ? '<span class="review__flag">⚑ Flagged</span>' : "") +
      '<button type="button" class="review__link review__tool" data-action="flag">' + (p.flagged ? "Unflag" : "Flag") + " " + kbdHtml("flag") + "</button>" +
      '<button type="button" class="review__link review__tool review__tool--danger" data-action="delete">Delete ' + kbdHtml("delete") + "</button>" +
      "</div>";
    ui.column.innerHTML = html;
    ui.column.style.paddingTop = "";
    ui.q = ui.column.querySelector(".review__q");
    ui.answer = ui.column.querySelector(".review__a");
    ui.source = ui.column.querySelector(".review__source");
    ui.bar = ui.column.querySelector(".review__bar");
    ui.undoEl = ui.column.querySelector(".review__undo");
    ui.struggle = ui.column.querySelector(".review__struggle-slot");
    renderBar();
    ui.count.textContent = (s.index + 1) + " of " + s.queue.length;
  }

  function renderBar() {
    var s = session;
    if (!ui || !ui.bar || !s || s.index >= s.queue.length) return;
    var r = resolve(s.queue[s.index]);
    if (!r) return;
    var html;
    if (!s.revealed) {
      html = btnHtml("reveal", "Show answer", "showAnswer", "", "", null) + btnHtml("skip", "Skip", "skip", "", " review__btn--skip", null);
    } else {
      var sc = S(), u = U(), t = now(), nextIn;
      try { nextIn = "next in " + u.fmtInterval(sc.preview(r.card, t, "remembered")); } catch (e) { nextIn = ""; }
      // D28: a wrong answer comes again in this session while the item has an ask left, and the next day in any case
      var again = (s.asks.get(keyOf(s.queue[s.index])) || 0) + 1 < sc.MAX_ASKS ? "again this session" : "again in " + u.fmtInterval(sc.LAPSE);
      html = btnHtml("forgot", "Forgot", "forgot", again, "", "forgot") +
        btnHtml("remembered", "Remembered", "remembered", nextIn, "", "remembered");
    }
    ui.bar.innerHTML = html;
    ui.undoEl.innerHTML = s.undo ? '<button type="button" class="review__link" data-action="undo">' + (s.undo.kind === "delete" ? "Undo delete " : "Undo ") + kbdHtml("undo") + "</button>" : "";
  }

  // In place: the answer springs in (opacity/transform 160 ms), a cloze cross-fades to .cloze-reveal,
  // the source quote appears and the bar switches to Forgot | Remembered.
  function revealUI() {
    var s = session;
    if (!ui || !ui.q) return;
    var item = s.queue[s.index], r = resolve(item);
    if (!r) { render(); return; }
    if (r.prompt.kind === "cloze") {
      ui.q.innerHTML = promptHtml(r.prompt, P().parse(r.prompt.text || ""), item.cardIndex, true, "question");
      ui.q.classList.add("review__q--revealed");
    } else if (ui.answer) {
      ui.answer.removeAttribute("aria-hidden");
      ui.answer.classList.add("is-shown");
    }
    if (ui.source) ui.source.classList.remove("is-hidden");
    if (ui.struggle) ui.struggle.innerHTML = struggleHtml(r.prompt, r.card);
    renderBar();
    renderBurst();
  }

  // FEATURES P1.4 c: once the answer shows, a card forgotten on STRUGGLE_DAYS or more days since its prompt's text last
  // changed (revisedAt, FIXES-1 FIX-5) says so in one line; never before the answer shows.
  function struggleHtml(p, card) {
    var sc = S(), since = typeof p.revisedAt === "number" && isFinite(p.revisedAt) ? p.revisedAt : 0;
    var n = sc.missDays(card, since);
    if (n < sc.STRUGGLE_DAYS) return "";
    return '<div class="review__struggle">' + esc("Forgotten on " + n + " days — split it or add a cue") + "</div>";
  }

  // ---- starburst (§7): one tapered 3-px ray per session item, the current item's ray pointing right;
  // centre at page (18, 30) so the overlay clips the left and upper halves; legend ticks on the
  // horizontal ray at LEGEND, labels under them; on completion it springs to the centre.
  function burstRadius() {
    var cw = 592;
    try {
      var cs = window.getComputedStyle(ui.column);
      cw = ui.column.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    } catch (e) { cw = 592; }
    if (!(cw > 0)) cw = 592;
    return Math.max(24, Math.min(220, (cw - 40) / 2));
  }
  function renderBurst() {
    if (!ui || !session) return;
    var s = session, sc = S(), r = burstRadius(), i;
    var items = s.items.filter(function (it) { return !s.removed.has(it.promptId); }), n = items.length;   // no ray for a deleted prompt
    var svg = ui.svg, done = !!s.ended;
    if (!n) { svg.innerHTML = ""; svg.style.display = "none"; ui.legend.innerHTML = ""; return; }
    svg.style.display = "";
    var t = now(), curKey = (!done && s.index < s.queue.length) ? keyOf(s.queue[s.index]) : null, curIdx = 0;
    if (curKey) for (i = 0; i < n; i++) if (keyOf(items[i]) === curKey) { curIdx = i; break; }
    var curInterval = sc.FIRST, parts = [];
    for (i = 0; i < n; i++) {
      var it = items[i], k = keyOf(it), res = resolve(it);
      var interval = res ? res.card.intervalMs : sc.FIRST, cls = "review__ray";
      if (k === curKey) {
        cls += " review__ray--current";
        if (s.preview && res) { try { interval = sc.preview(res.card, t, s.preview); } catch (e) { /* keep */ } }
        curInterval = interval;
      } else if (done || (s.asks.get(k) || 0) > 0) {
        cls += " review__ray--graded";
      }
      var len = Math.max(2, sc.rayValue(interval) * r), angle = ((i - curIdx) * 360) / n;
      parts.push('<path class="' + cls + '" d="M0 -1.5 L' + len.toFixed(1) + ' 0 L0 1.5 Z" transform="translate(' + r + " " + r + ") rotate(" + angle.toFixed(2) + ')"/>');
    }
    var labels = [];
    if (!done) {
      var present = sc.rung(curInterval), names = sc.LEGEND_LABELS || LABELS;
      for (i = 0; i < sc.LEGEND.length; i++) {
        var v = sc.rayValue(sc.LEGEND[i]), x = (r + v * r).toFixed(1);
        if (i <= present) parts.push('<line class="review__tick" x1="' + x + '" x2="' + x + '" y1="' + (r - 3) + '" y2="' + (r + 3) + '"/>');
        else parts.push('<circle class="review__dot" cx="' + x + '" cy="' + r + '" r="1.5"/>');
        labels.push('<span class="' + (i <= present ? "is-past" : "") + '" style="left:' + (18 + v * r).toFixed(1) + 'px">' + esc(names[i]) + "</span>");
      }
    }
    var size = 2 * r;
    svg.setAttribute("width", String(size));
    svg.setAttribute("height", String(size));
    svg.setAttribute("viewBox", "0 0 " + size + " " + size);
    svg.innerHTML = parts.join("");
    if (done) {                                       // springs to the centre (CSS transition on left/top/transform)
      var hostW = ui.host.clientWidth || 0;
      svg.style.left = Math.round(hostW / 2 - r) + "px";
      svg.style.top = Math.round(24 + 0.55 * r - r) + "px";
      svg.style.transform = "scale(.55)";
    } else {
      svg.style.left = (18 - r) + "px";
      svg.style.top = (30 - r) + "px";
      svg.style.transform = "none";
    }
    ui.legend.innerHTML = labels.join("");
  }

  // Something of the scope can be asked right now although the session is over: a card that was skipped away, or one
  // that became due meanwhile (a prompt written during the session is due at once). The end screen then reads "Done
  // for now". Held blanks and cards answered wrong do not count: they come the next day (D28, D29).
  function moreNow(sum) { return sum.dueNow > 0; }
  // The day of a time that lies ahead: "later today", "tomorrow", "Thursday", "12 Nov" (M.util.nextDayLabel).
  function dayWord(ms, t) { var w = U().nextDayLabel(ms, t); return w === "today" ? "later today" : w; }
  // other: something of this session still waits (held blanks), so the line says "nothing else due until …"
  function dueLine(nextDueAt, t, other, dueNow) {
    if (dueNow > 0) return "more due now";
    if (nextDueAt === null || nextDueAt === undefined) return "nothing else scheduled";
    return (other ? "nothing else due until " : "nothing due until ") + dayWord(nextDueAt, t);
  }
  function summaryLine(sum) {
    var parts = [sum.reviewed + " reviewed", sum.remembered + " remembered", sum.forgot + " forgot"];
    if (sum.skipped) parts.push(sum.skipped + " skipped");
    if (sum.deleted) parts.push(sum.deleted + " deleted");
    if (sum.stillShaky.length) parts.push(sum.stillShaky.length + " still shaky" + (isNum(sum.shakyDueAt) ? " (due again " + dayWord(sum.shakyDueAt, sum.endedAt) + ")" : ""));
    if (sum.held) parts.push(sum.held + (sum.held === 1 ? " more blank waits" : " more blanks wait") + " until " + dayWord(sum.heldUntil, sum.endedAt));
    parts.push(dueLine(sum.nextDueAt, sum.endedAt, sum.held > 0, sum.dueNow));
    return parts.join(" · ");
  }
  // The end and empty screens of a folder review name the folder (FEATURES L1.5).
  function scopeHtml(s) {
    if (!s || s.scope !== "folder") return "";
    return '<div class="review__scope">' + esc("Folder “" + (s.folderName || "Untitled folder") + "”") + "</div>";
  }
  function endButtons(s) {
    var back = isReadingOwner(s.prevOwner) ? "Back to reading" : "Back";
    return '<div class="review__end-actions"><button type="button" class="review__btn review__btn--small" data-action="back">' + back + "</button>" +
      (s.prevOwner === "library" ? "" : '<button type="button" class="review__btn review__btn--small" data-action="library">Library</button>') + "</div>";
  }

  function renderEnd() {
    var s = session, sum = s.summary || buildSummary(), r = burstRadius(), rows = [], flaggedRows = [], i;
    var endRow = function (it, mark) {
      var res = resolve(it);
      if (!res) return null;
      var p = res.prompt, parsed = P().parse(p.text || "");
      return '<li><div class="review__shaky-body"><div class="review__context">' + esc(contextLine(cacheCollection(p.collectionId), p)) +
        (mark && p.flagged === true ? ' <span class="review__shaky-flag" title="Flagged for revision">⚑</span>' : "") + "</div>" +
        '<div class="review__shaky-q">' + promptHtml(p, parsed, it.cardIndex, true, "question") + "</div></div>" +
        '<button type="button" class="review__link" data-action="edit" data-id="' + esc(p.id) + '">Edit</button></li>';
    };
    for (i = 0; i < sum.stillShaky.length; i++) { var row = endRow(sum.stillShaky[i], true); if (row) rows.push(row); }
    for (i = 0; i < (sum.flagged || []).length; i++) { var frow = endRow(sum.flagged[i], false); if (frow) flaggedRows.push(frow); }
    ui.column.innerHTML = '<div class="review__end">' + scopeHtml(s) +
      '<div class="review__done-caption">' + sum.reviewed + (sum.reviewed === 1 ? " prompt" : " prompts") + " reviewed</div>" +
      "<h1>" + (moreNow(sum) ? "Done for now" : "All caught up") + "</h1>" +
      '<p class="review__summary">' + esc(summaryLine(sum)) + "</p>" +
      '<div class="review__undo">' + (s.undo ? '<button type="button" class="review__link" data-action="undo">' + (s.undo.kind === "delete" ? "Undo delete " : "Undo last grade ") + kbdHtml("undo") + "</button>" : "") + "</div>" +
      (rows.length ? '<ul class="review__shaky">' + rows.join("") + "</ul>" : "") +
      (flaggedRows.length ? '<h2 class="review__flagged-title">Flagged for revision</h2><ul class="review__shaky review__flagged">' + flaggedRows.join("") + "</ul>" : "") +
      endButtons(s) + "</div>";
    ui.column.style.paddingTop = Math.round(24 + 1.1 * r + 24) + "px";
    ui.q = ui.answer = ui.source = ui.bar = ui.undoEl = ui.struggle = null;
    ui.count.textContent = "";
    renderBurst();
  }

  // Any live Q./A. or cloze prompt with a card in the session's scope?
  function hasReviewable(s) {
    var ps = cachePrompts();
    for (var i = 0; i < ps.length; i++) {
      var p = ps[i];
      if (isLive(p) && inScope(p, s) && Array.isArray(p.cards) && p.cards.length) return true;
    }
    return false;
  }

  // The empty session (§7, BUILD-NOTES): a scope with nothing due reads "All caught up · nothing due
  // until <day>" (M.util.nextDayLabel); "today" with nothing written today "No prompts written today";
  // a scope without a single reviewable prompt "No reviewable prompts yet".
  function emptyState(s, t) {
    if (s.scope === "today") return { title: "No prompts written today", line: "Prompts written today can be reviewed here, due or not." };
    if (!hasReviewable(s)) return { title: "No reviewable prompts yet", line: "Only Q./A. and cloze prompts are reviewed — notes and highlights are not." };
    return { title: "All caught up", line: dueLine(nextDue(s, new Set(), t), t, false, 0) };   // an empty queue: nothing can be asked now
  }

  // The overlay stays up (isActive() is true, the owner is "review") with a Back button; the exit binding
  // and Back call stop().
  function renderEmpty() {
    var s = session, empty = emptyState(s, now());
    ui.column.innerHTML = '<div class="review__empty">' + scopeHtml(s) + "<h1>" + esc(empty.title) + "</h1>" +
      '<p class="review__summary">' + esc(empty.line) + "</p>" + endButtons(s) + "</div>";
    ui.column.style.paddingTop = "";
    ui.q = ui.answer = ui.source = ui.bar = ui.undoEl = ui.struggle = null;
    ui.count.textContent = "";
    renderBurst();
  }

  // "Copy question LaTeX": the raw question text (the cloze body for a cloze), writeText inside the
  // click, select-the-text fallback when the clipboard is unavailable or rejects.
  function copyQuestion() {
    var s = session;
    if (!s || s.index >= s.queue.length) return;
    var r = resolve(s.queue[s.index]);
    if (!r) return;
    var parsed = P().parse(r.prompt.text || "");
    var text = r.prompt.kind === "cloze" ? parsed.body : parsed.question;
    var started = false;
    try {
      var nav = root.navigator;
      if (nav && nav.clipboard && typeof nav.clipboard.writeText === "function") {
        nav.clipboard.writeText(text).then(function () { toast("Question copied"); focusHost(); }, function () { selectFallback(text); });
        started = true;
      }
    } catch (e) { started = false; }
    if (!started) selectFallback(text);
  }
  function selectFallback(text) {
    if (!ui) return;
    var ta = ui.copybuf;
    ta.value = text;
    ta.classList.add("is-shown");
    ta.removeAttribute("aria-hidden");
    try { ta.focus(); ta.select(); } catch (e) { /* ignore */ }
    toast("Copy with ⌘C / Ctrl+C");
  }
  function hideCopybuf() {
    if (!ui) return;
    ui.copybuf.classList.remove("is-shown");
    ui.copybuf.setAttribute("aria-hidden", "true");
  }

  // "Edit" on a still-shaky row: leave the overlay and open the prompt where it is edited.
  function editPrompt(id) {
    var p = cachePrompt(id);
    stop();
    if (!p) return;
    var col = cacheCollection(p.collectionId);
    if (col && col.kind === "deck") route("deck", { collectionId: p.collectionId });
    else route("reader", { collectionId: p.collectionId, promptId: p.id });
  }

  var api = {
    start: start, stop: stop, suspend: suspend, resume: resume,
    reveal: reveal, grade: grade, skip: skip, undo: undo, goToSource: goToSource, flag: flag, remove: remove,
    current: current, isActive: isActive, isSuspended: isSuspended
  };
  M.review = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

/* SELF-CHECK (SPEC §17.2 M.review): start({scope, collectionId, now}) → Promise (rejects code "bad_scope"
 * from M.scheduler.buildQueue); stop(); suspend(); resume(); reveal(); grade(outcome) (throws code
 * "bad_outcome"); skip(); undo(); goToSource(); current() → {item, prompt, card, revealed, position, total}|null;
 * isActive(); isSuspended(). The focus owner is "review" from start() until stop(), on the end and empty
 * screens too (retaken after review:ended); stop() restores the previous owner and the invoker's focus.
 * Extension (FEATURES L1.5): scope "folder" with collectionId = a folder id (M.cache.folderMembers, M.cache.folder):
 * the folder's books and decks at any depth, queued as "all"; the summary carries folderName; the end and empty
 * screens show .review__scope "Folder “<name>”". A folder scope without an id rejects code "bad_scope".
 * BUILD-NOTES "Prompt craft" (FEATURES P1.3, P1.4): flag() toggles the current prompt's flagged (M.cache.savePrompt(p,
 * {content: true}), before or after reveal; the card shows .review__flag "⚑ Flagged" and the quiet .review__tool buttons
 * "Flag"/"Unflag" and "Delete" with key hints); remove() deletes the current prompt (M.cache.removePrompt, no confirm):
 * its queued cards leave the session, one undo step ("delete": undo() restores it with M.cache.restorePrompt and the
 * session exactly; the link reads "Undo delete"), a toast "Prompt deleted" with Undo (8 s; after a later grade or skip
 * it only restores the prompt); the summary gains deleted and flagged ("N deleted" in the line; deleted prompts' grades
 * and skips are not counted); the end screen lists "Flagged for revision" (shown in the session, flagged at the end,
 * not still shaky; a still-shaky flagged row carries .review__shaky-flag "⚑"). After reveal a card with
 * M.scheduler.missDays(card, prompt.revisedAt || 0) >= STRUGGLE_DAYS shows .review__struggle "Forgotten on N
 * days — split it or add a cue". Calls also M.cache.{removePrompt, restorePrompt}, M.scheduler.{missDays, STRUGGLE_DAYS}.
 * D27 (BUILD-NOTES "Scheduling and statistics"): a queue holds one card per prompt, so the summary has `held` (the
 * due cards of the session's prompts that were not its items: a sentence's other blanks); nextDueAt leaves them out.
 * `held` counts cards of the session's scope only.
 * D28, D29 (BUILD-NOTES "Wrong answers and the next day"): the retry is the session's own (an item whose latest answer
 * in this session was "forgot" comes again at the end of the pass, up to MAX_ASKS asks; stillShaky = those whose
 * latest answer stayed "forgot"); `held` counts the blanks that an answer holds back now, heldUntil is the earliest
 * time one of them can be asked (null without one), shakyDueAt the earliest time a still-shaky card can be asked (null
 * without one), dueNow the cards of the scope that can be asked when the session ends, nextDueAt the earliest
 * M.scheduler.readyTime of the scope without the held cards. The end screen reads "Done for now" only while dueNow > 0;
 * its line: "N still shaky (due again tomorrow) · N more blanks wait until tomorrow · nothing else due until …" (each
 * day word from its own time: "later today" for a time on the same day, as after a session before 8 in the morning;
 * "more due now" while dueNow > 0). The Forgot button reads "again this session" while the item has an ask left after
 * this one, else "again in 1 d" (the new wait, as Remembered shows its new wait).
 * Events emitted (§17.3): review:graded {promptId, cardIndex, outcome}; review:ended {summary};
 * review:suspended / review:resumed {remaining}; review:gotoSource {promptId}.
 * Consumes: settings:changed (reviewKeys), prompt:saved, prompt:deleted, prompts:recontexted.
 * Calls only: M.scheduler.{buildQueue, grade, preview, isDue, isReady, readyTime, heldUntil, rung, rayValue,
 * FIRST, LAPSE, LEGEND, LEGEND_LABELS, MAX_ASKS}; M.cache.{prompts, prompt, collection, savePrompt(p, {content: false})};
 * M.bus.{on, emit}; M.app.{setFocusOwner, focusOwner, toast, route}; M.store.meta.set("pausedSession", …);
 * M.settings.get("reviewKeys"); M.keys.{label, PRESETS}; M.context.{line, fit}; M.prompts.parse;
 * M.markup.render(text, {mode: "review", mask, imageUrl}); M.attachments.url; M.util.{escapeHtml, debounce,
 * fmtInterval, nextDayLabel}. */
