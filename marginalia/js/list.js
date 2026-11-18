/* js/list.js — M.list: the prompt list (SPEC §3 "L" drawer, §14 "Deck page", §17.2).
 *
 * open(collectionId, {host}) renders the list of a collection's live prompts into `host`:
 * the #list drawer of the reader (right-side, 360 px) or the deck page's inline host.
 * Rows = section · rendered question (M.markup.render, mode "list") · muted answer · due-in · flag;
 * ⋯ → Edit in place (one M.editor inside the row), Split (FEATURES P2.2), Not alike (FEATURES P2.4, while the
 * Look-alikes chip is on), Flag, Move to… (decks only, §14 confirm for
 * book prompts), Send to Obsidian / Update in Obsidian (M.obsidian.send, BUILD-NOTES "Obsidian"),
 * Delete (Undo toast). In the reader drawer a row click goes to the passage
 * (M.reader.goToAnchor + M.margin.focus); on the deck page Enter/click edits. ↑↓ / Enter / Esc are
 * handled on the list element itself (never on document). Focus owner: "list" while the drawer is
 * open (restored on close); the inline list claims "list" only while focus is inside it, so the
 * deck page keeps the library keys otherwise. A held key repeats only ↑↓; after a delete (key or ⋯
 * menu) focus goes to the neighbouring row, or the rows container when none is left, so Z undoes it.
 *
 * Loads in node without a DOM: open() is a no-op there (returns false) and the pure helpers under
 * api._pure are testable.
 */
(function (root) {
  "use strict";
  var M = root.Marginalia = root.Marginalia || {};
  function dep(name) { return M[name] || (typeof require === "function" ? require("./" + name + ".js") : undefined); }
  function tryDep(name) { try { return dep(name); } catch (e) { return undefined; } }

  var SEARCH_DEBOUNCE_MS = 120;
  var UNDO_TTL_MS = 8000;
  var EVENTS = ["prompt:saved", "prompt:deleted", "prompt:restored", "prompts:recontexted"];
  var REVIEWABLE = { qa: true, cloze: true };
  // Split (FEATURES P2.2), as the margin does it: the quiet line of the second editor and its draft key prefix.
  var SPLIT_NOTE = "Second half of the split — keep what the first prompt no longer asks";
  var SPLIT_DRAFT_PREFIX = "split:";
  var CHIP_INERT_KEYS = { Backspace: true, Delete: true, f: true, F: true, e: true, E: true };   // FIXES-1 FIX-2

  // Filter chips in the list's head (FEATURES P1.3 e, P1.4 d; BUILD-NOTES "Prompt craft"), in display order. A chip is
  // a toggle button "<label> <n>", n = the live prompts of this list it matches (whatever the search and the other
  // chips say); it shows while n > 0 or while it is active. Active chips combine with each other and with the search
  // (AND). To add a chip, add an entry: {id, label, test(p, info, data)}. info = rowInfo(p) (computed once per prompt
  // and render); data = what the entry's optional prepare(prompts) returned for this render (prompts: the list's live
  // prompts in order). A chip with prepare re-renders the whole list on every change of one prompt (updateRow).
  var CHIPS = [
    { id: "flagged", label: "Flagged", test: function (p, info) { return info.flagged; } },
    { id: "struggling", label: "Struggling", test: function (p, info) { return info.struggling; } },
    { id: "alike", label: "Look-alikes", test: function (p, info) { return !!(info.alike && info.alike.length); } }
  ];
  // Look-alikes (FEATURES P2.4): the pairs of M.similar.pairs over this list's live prompts, minus settings.notAlike.
  // They are computed when the list opens and again only when a prompt's text, the set of live prompts or notAlike
  // changed (ensureAlike compares each prompt's text with the texts of the last computation): never because of a key
  // stroke in the search field. While the chip is on, rows are grouped by pair and carry the "≈" line.
  var ALIKE_CHIP = "alike";
  var ALIKE_MARK = "≈ ";
  var NOT_ALIKE_LABEL = "Not alike";

  var st = null; // open state (see open())

  // ------------------------------------------------------------------ small helpers

  function err(code, message) { var e = new Error(message || code); e.code = code; return e; }
  function noop() {}
  function tryCall(fn, fallback) { try { return fn(); } catch (e) { return fallback; } }
  function now() { return Date.now(); }
  function live(p) { return !!p && (p.deletedAt === null || p.deletedAt === undefined); }
  function isNum(v) { return typeof v === "number" && isFinite(v); }
  function str(v) { return v === null || v === undefined ? "" : String(v); }

  function escapeHtml(s) {
    var u = tryDep("util");
    if (u && typeof u.escapeHtml === "function") return u.escapeHtml(s);
    return str(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]; });
  }

  // The kind's line icon (constant SVG from M.util.kindIcon), or the old text glyph when util is missing.
  function kindIconHtml(kind) {
    var u = tryDep("util");
    if (u && typeof u.kindIcon === "function") return u.kindIcon(kind);
    return escapeHtml(kind === "cloze" ? "{}" : kind === "qa" ? "✦" : kind === "highlight" ? "·" : "▭");
  }

  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === "text") el.textContent = v;
        else if (k === "html") el.innerHTML = v;
        else if (k === "class") el.className = v;
        else if (k.slice(0, 2) === "on" && typeof v === "function") el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? "" : v);
      });
    }
    (children || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return el;
  }

  function toast(text, actions, ttl) {
    var app = M.app;
    if (!app || typeof app.toast !== "function") return null;
    return tryCall(function () { return app.toast({ text: text, actions: actions || [], ttl: ttl || 5000 }); }, null);
  }

  function confirm(opts) {
    var app = M.app;
    if (!app || typeof app.confirm !== "function") return Promise.resolve(true);
    return tryCall(function () { return Promise.resolve(app.confirm(opts)); }, Promise.resolve(false));
  }

  function setOwner(owner) {
    var app = M.app;
    if (app && typeof app.setFocusOwner === "function") tryCall(function () { app.setFocusOwner(owner); });
  }
  function currentOwner(fallback) {
    var app = M.app;
    if (app && typeof app.focusOwner === "function") return tryCall(function () { return app.focusOwner(); }, fallback) || fallback;
    return fallback;
  }

  function isTextTarget(t) {
    var k = tryDep("keys");
    if (k && typeof k.isTextTarget === "function") return !!k.isTextTarget(t);
    if (!t || !t.tagName) return false;
    var tag = String(t.tagName).toUpperCase();
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable === true;
  }

  // ------------------------------------------------------------------ pure helpers

  // Reading order for books (pageIndex, −y, createdAt); creation order for decks.
  function pageOf(p) {
    if (p.anchor && isNum(p.anchor.pageIndex)) return p.anchor.pageIndex;
    if (p.context && isNum(p.context.pageIndex)) return p.context.pageIndex;
    return 0;
  }
  function yOf(p) { return p.anchor && isNum(p.anchor.y) ? p.anchor.y : Infinity; }
  function createdOf(p) { return isNum(p.createdAt) ? p.createdAt : 0; }

  function compare(a, b, kind) {
    if (kind === "deck") return createdOf(a) - createdOf(b) || str(a.id).localeCompare(str(b.id));
    return (pageOf(a) - pageOf(b)) || (yOf(b) - yOf(a)) || (createdOf(a) - createdOf(b)) || str(a.id).localeCompare(str(b.id));
  }

  function sortPrompts(prompts, kind) {
    return (prompts || []).filter(live).sort(function (a, b) { return compare(a, b, kind); });
  }

  // Search over text (tags line stripped) and tags; "#tag" searches tags only.
  function matches(p, q) {
    var query = str(q).trim().toLowerCase();
    if (!query) return true;
    var tags = Array.isArray(p.tags) ? p.tags.map(function (t) { return str(t).toLowerCase(); }) : [];
    if (query.charAt(0) === "#") {
      var want = query.slice(1);
      if (!want) return tags.length > 0;
      return tags.some(function (t) { return t.indexOf(want) >= 0; });
    }
    var pr = tryDep("prompts");
    var body = pr && typeof pr.stripTags === "function" ? pr.stripTags(str(p.text)) : str(p.text);
    if (body.toLowerCase().indexOf(query) >= 0) return true;
    return tags.some(function (t) { return t.indexOf(query) >= 0; });
  }

  // What the chips and the row marks read of a prompt: flagged, and (FEATURES P1.4) the days its cards were forgotten
  // since its text last changed (M.scheduler.promptMissDays, revisedAt: FIXES-1 FIX-5) and whether that makes it struggle.
  function rowInfo(p) {
    var sc = tryDep("scheduler");
    var miss = sc && typeof sc.promptMissDays === "function" ? tryCall(function () { return sc.promptMissDays(p); }, 0) : 0;
    var limit = sc && isNum(sc.STRUGGLE_DAYS) ? sc.STRUGGLE_DAYS : 3;
    return { flagged: p.flagged === true, missDays: miss, struggling: miss >= limit };
  }

  // "note" | "not reviewed" | "due now" | "due in 4 d" (new cards get a "new · " prefix). The time is
  // M.scheduler.readyTime, the time from which a session can ask the card, so the text agrees with the due counts:
  // a card never asked is due from the moment it was made (D27), so a new prompt reads "new · due now"; a card
  // comes 16 hours before its due time (the lookahead), but not within 16 hours of an answer to it or to another
  // card of its prompt (D29), so a sentence whose first blank was just answered reads "due in 16 h".
  function dueText(p, t) {
    if (!REVIEWABLE[p.kind]) return "note";
    var all = Array.isArray(p.cards) ? p.cards : [], cards = all.filter(Boolean);
    if (!cards.length) return "not reviewed";
    var min = Infinity, reviewed = false;
    var sch = tryDep("scheduler");
    all.forEach(function (c, i) {
      if (!c) return;
      // with `t`, a card never asked is due now also when its createdAt lies ahead (a clock set back), as
      // M.scheduler.isDue says; another card's answer may still hold it back
      var d = sch && typeof sch.readyTime === "function" ? sch.readyTime(p, i, t) : c.dueAt;
      if (isNum(d) && d < min) min = d;
      if (c.lastReviewedAt !== null && c.lastReviewedAt !== undefined) reviewed = true;
    });
    if (min === Infinity) return "not reviewed";
    var u = tryDep("util");
    var fmt = u && typeof u.fmtInterval === "function" ? u.fmtInterval : function (ms) { return Math.round(ms / 86400000) + " d"; };
    var text = min <= t ? "due now" : "due in " + fmt(min - t);
    return reviewed ? text : "new · " + text;
  }

  function sectionText(p) {
    var ctx = p.context || {};
    if (typeof ctx.sectionLabel === "string" && ctx.sectionLabel.trim()) return ctx.sectionLabel.trim();
    if (ctx.pageLabel !== null && ctx.pageLabel !== undefined && str(ctx.pageLabel).trim()) return "p. " + str(ctx.pageLabel).trim();
    var page = p.anchor && isNum(p.anchor.pageIndex) ? p.anchor.pageIndex : (isNum(ctx.pageIndex) ? ctx.pageIndex : null);
    return page === null ? "" : "p. " + (page + 1);
  }

  // The question / answer sides as raw text (markup renders them).
  function sides(p) {
    var pr = tryDep("prompts");
    var parsed = pr && typeof pr.parse === "function" ? pr.parse(str(p.text)) : null;
    if (!parsed) return { question: str(p.text), answer: "" };
    if (parsed.kind === "qa") return { question: parsed.question, answer: parsed.answer };
    if (parsed.kind === "highlight") return { question: p.anchor && p.anchor.quote ? "“" + p.anchor.quote + "”" : "(highlight)", answer: "" };
    return { question: parsed.display, answer: "" };
  }

  function renderText(text) {
    var mk = M.markup || tryDep("markup");
    if (mk && typeof mk.render === "function") {
      var html = tryCall(function () {
        return mk.render(text, {
          mask: null, mode: "list",
          imageUrl: function (id) { return M.attachments && typeof M.attachments.url === "function" ? tryCall(function () { return M.attachments.url(id); }, null) : null; }
        });
      }, null);
      if (typeof html === "string") return html;
    }
    return escapeHtml(text).replace(/\n/g, " ");
  }

  // ------------------------------------------------------------------ rows

  function rowEl(id) {
    if (!st) return null;
    var nodes = st.el.list.children;
    for (var i = 0; i < nodes.length; i++) if (nodes[i].getAttribute("data-id") === id) return nodes[i];
    return null;
  }

  // The "≈" line of a row while the Look-alikes chip is on: the question of its most alike partner on one line, and
  // "(+N more)" when it has further partners.
  function alikeLine(info) {
    if (!st || !st.chips[ALIKE_CHIP] || !info || !info.alike || !info.alike.length) return "";
    var other = promptOf(info.alike[0].id);
    if (!other) return "";
    var S = tryDep("similar");
    var line = S && typeof S.oneLine === "function" ? tryCall(function () { return S.oneLine(str(other.text)); }, str(other.text)) : str(other.text);
    var more = info.alike.length - 1;
    return "<div class=\"list__alike\">" + escapeHtml(ALIKE_MARK + line + (more > 0 ? " (+" + more + " more)" : "")) + "</div>";
  }

  function buildRow(p, info) {
    var s = sides(p), t = now();
    info = info || infoOf(p);
    var tags = Array.isArray(p.tags) ? p.tags : [];
    var row = h("div", { class: "list__row" + (p.flagged ? " list__row--flagged" : ""), role: "option", tabindex: "-1", "data-id": p.id, "aria-selected": "false" });
    var main = h("div", { class: "list__row-main" });
    var section = sectionText(p);
    main.innerHTML =
      "<div class=\"list__section\">" + (section ? escapeHtml(section) : "&nbsp;") + "</div>" +
      "<div class=\"list__q\"><span class=\"list__glyph\" aria-hidden=\"true\">" + kindIconHtml(p.kind) + "</span>" + renderText(s.question) + "</div>" +
      alikeLine(info) +
      (s.answer ? "<div class=\"list__a\">" + renderText(s.answer) + "</div>" : "") +
      "<div class=\"list__meta\"><span class=\"list__due\">" + escapeHtml(dueText(p, t)) + "</span>" +
      (p.flagged ? "<span class=\"list__flag\" title=\"Flagged\">⚑</span>" : "") +
      (info.struggling ? "<span class=\"list__struggle\" title=\"" + escapeHtml("Forgotten on " + info.missDays + " days") + "\">struggling</span>" : "") +
      tags.map(function (tag) { return "<span class=\"chip list__tag\">#" + escapeHtml(tag) + "</span>"; }).join("") +
      "</div>";
    var more = h("button", { type: "button", class: "btn btn--ghost list__more", "aria-haspopup": "menu", "aria-label": "More actions", text: "⋯" });
    more.addEventListener("click", function (ev) { ev.stopPropagation(); select(p.id, false); openMenu(p, more); });
    row.appendChild(main);
    row.appendChild(more);
    row.addEventListener("click", function (ev) {
      if (st && st.editing && st.editing.id === p.id) return;
      if (ev.target === more) return;
      select(p.id, false);
      activate(p.id);
    });
    row.addEventListener("focus", function () { if (st && st.selected !== p.id && !(st.editing && st.editing.id === p.id)) select(p.id, false); });
    return row;
  }

  // ------------------------------------------------------------------ filter chips

  function chipData(sorted) {
    var data = {};
    CHIPS.forEach(function (c) { if (typeof c.prepare === "function") data[c.id] = tryCall(function () { return c.prepare(sorted); }, null); });
    return data;
  }
  function chipMatch(c, p) {
    var info = st.info.get(p.id) || infoOf(p);
    return !!tryCall(function () { return c.test(p, info, st.chipData[c.id]); }, false);
  }
  function anyChipActive() { return CHIPS.some(function (c) { return !!st.chips[c.id]; }); }
  // The search and every active chip.
  function passes(p) {
    if (!matches(p, st.query)) return false;
    for (var i = 0; i < CHIPS.length; i++) if (st.chips[CHIPS[i].id] && !chipMatch(CHIPS[i], p)) return false;
    return true;
  }

  // Counts and visibility of the chip buttons (kept across renders, so a focused chip keeps its focus).
  function renderChips() {
    if (!st) return;
    var any = false;
    CHIPS.forEach(function (c) {
      var n = 0;
      st.live.forEach(function (p) { if (chipMatch(c, p)) n++; });
      var b = st.el.chips[c.id].btn, on = !!st.chips[c.id], show = n > 0 || on;
      st.el.chips[c.id].count.textContent = String(n);
      b.setAttribute("aria-pressed", on ? "true" : "false");
      b.classList.toggle("list__chip--on", on);
      if (!show && document.activeElement === b) tryCall(function () { st.el.search.focus(); });
      b.classList.toggle("is-hidden", !show);
      if (show) any = true;
    });
    st.el.chipBar.classList.toggle("is-hidden", !any);
  }

  function toggleChip(id) {
    if (!st) return;
    st.chips[id] = !st.chips[id];
    if (st.editing) { st.dirty = true; renderChips(); return; }
    var hadFocus = st.el.list.contains(document.activeElement);
    renderRows();
    if (hadFocus) focusSelection();
  }

  function emptyText(sorted, col) {
    if (!sorted.length) return col && col.kind === "deck" ? "No prompts yet — add some below." : "No prompts yet — select text in the page and press N.";
    if (!anyChipActive()) return "No prompts match “" + st.query + "”";
    return str(st.query).trim() ? "No prompts match “" + st.query + "” with the filter" : "No prompts match the filter";
  }

  // ------------------------------------------------------------------ look-alikes (FEATURES P2.4)

  function notAlikeList() {
    var S = M.settings || tryDep("settings");
    var v = S && typeof S.get === "function" ? tryCall(function () { return S.get("notAlike"); }, null) : null;
    return Array.isArray(v) ? v.filter(function (k) { return typeof k === "string"; }) : [];
  }

  // Recomputes the pairs when the live prompts or their texts changed since the last computation, or notAlike did
  // (st.alike.stale); otherwise keeps them. → nothing; st.alike.partners: id → [{id, score}] (highest score first).
  function ensureAlike(sorted) {
    var a = st.alike, changed = a.stale || !a.texts || a.texts.size !== sorted.length;
    if (!changed) {
      for (var i = 0; i < sorted.length; i++) if (a.texts.get(sorted[i].id) !== str(sorted[i].text)) { changed = true; break; }
    }
    if (!changed) return;
    var texts = new Map();
    sorted.forEach(function (p) { texts.set(p.id, str(p.text)); });
    if (a.stale || !a.ignored) { a.ignored = notAlikeList(); a.ignoredSig = a.ignored.join("\n"); }
    var S = tryDep("similar");
    var list = S && typeof S.pairs === "function" ? tryCall(function () { return S.pairs(sorted, a.ignored); }, []) : [];
    var partners = new Map();
    function add(x, y, score) { (partners.get(x) || partners.set(x, []).get(x)).push({ id: y, score: score }); }
    (list || []).forEach(function (pr) { add(pr.a, pr.b, pr.score); add(pr.b, pr.a, pr.score); });
    a.texts = texts; a.pairs = list || []; a.partners = partners; a.stale = false;
  }

  function pairSig(list) { return (list || []).map(function (x) { return x.a + "|" + x.b; }).sort().join("\n"); }

  // rowInfo(p) plus `alike`: the row's look-alike partners [{id, score}] ([] when none).
  function infoOf(p) {
    var info = rowInfo(p);
    info.alike = st && st.alike.partners ? (st.alike.partners.get(p.id) || []) : [];
    return info;
  }

  // While the Look-alikes chip is on: the shown rows grouped so that the members of a pair stand together. Each group
  // (the prompts connected by pairs) starts where its earliest member stands in the list's order and lists its members
  // breadth first from there, partners in the list's order.
  function groupAlike(shown) {
    var pos = new Map(), keep = new Set(), seen = new Set(), out = [];
    st.live.forEach(function (p, i) { pos.set(p.id, i); });
    shown.forEach(function (p) { keep.add(p.id); });
    var byId = new Map();
    shown.forEach(function (p) { byId.set(p.id, p); });
    shown.forEach(function (p) {
      if (seen.has(p.id)) return;
      var queue = [p.id];
      seen.add(p.id);
      while (queue.length) {
        var id = queue.shift();
        if (byId.has(id)) out.push(byId.get(id));
        var next = (st.alike.partners.get(id) || []).map(function (x) { return x.id; })
          .filter(function (x) { return !seen.has(x) && pos.has(x); })
          .sort(function (x, y) { return pos.get(x) - pos.get(y); });
        next.forEach(function (x) { seen.add(x); queue.push(x); });
      }
    });
    return out.filter(function (p) { return keep.has(p.id); });
  }

  // ⋯ › "Not alike": every pair of this row goes into settings.notAlike, so the row (and a partner left without a pair)
  // leaves the Look-alikes filter. Focus goes to the neighbouring row.
  function markNotAlike(p) {
    if (!st) return;
    var S = tryDep("similar"), set = M.settings || tryDep("settings");
    var partners = st.alike.partners ? (st.alike.partners.get(p.id) || []) : [];
    if (!partners.length || !S || !set || typeof set.set !== "function") return;
    var current = notAlikeList(), have = new Set(current), next = current.slice();
    partners.forEach(function (x) { var k = S.key(p.id, x.id); if (!have.has(k)) { have.add(k); next.push(k); } });
    st.keepNeighbour = true;                              // the row leaves the filter: its neighbour takes the selection
    var ok = tryCall(function () { return set.set("notAlike", next); }, false);
    if (st && ok && st.alike.ignoredSig !== notAlikeList().join("\n")) { st.alike.stale = true; refresh(); }   // no bus: no event
    if (st) st.keepNeighbour = false;
    if (!ok) toast("Could not save “Not alike”");
  }

  // settings:changed for notAlike (a "Not alike" here or elsewhere, an import that restores settings, a reset).
  function onSettingsChanged(ev) {
    if (!st || !ev || ev.key !== "notAlike") return;
    var sig = Array.isArray(ev.value) ? ev.value.join("\n") : "";
    if (sig === st.alike.ignoredSig) return;
    st.alike.stale = true;
    refresh();
  }

  function renderRows() {
    if (!st) return;
    var cache = M.cache || tryDep("cache");
    var col = cache && typeof cache.collection === "function" ? cache.collection(st.collectionId) : null;
    var all = cache && typeof cache.promptsOf === "function" ? cache.promptsOf(st.collectionId) : [];
    var sorted = sortPrompts(all, col ? col.kind : "book");
    st.live = sorted;
    ensureAlike(sorted);
    st.info = new Map();
    sorted.forEach(function (p) { st.info.set(p.id, infoOf(p)); });
    st.chipData = chipData(sorted);
    var shown = sorted.filter(passes);
    if (st.chips[ALIKE_CHIP]) shown = groupAlike(shown);
    var before = st.rows;
    st.rows = shown.map(function (p) { return p.id; });
    var list = st.el.list;
    while (list.firstChild) list.removeChild(list.firstChild);
    if (!shown.length) {
      list.appendChild(h("div", { class: "list__empty", text: emptyText(sorted, col) }));
    } else {
      shown.forEach(function (p) { list.appendChild(buildRow(p, st.info.get(p.id))); });
    }
    renderChips();
    var n = sorted.length;
    st.el.count.textContent = n + (n === 1 ? " prompt" : " prompts") + (shown.length !== n ? " · " + shown.length + " shown" : "");
    if (st.selected && st.rows.indexOf(st.selected) < 0) {
      // A selected prompt that left the list (deleted, moved to a deck) hands the selection to its neighbour, the
      // next row else the previous one (SPEC §5: after a delete focus goes to the next card); a row that the
      // search hides starts the selection over at the top.
      var gone = !sorted.some(function (p) { return p.id === st.selected; });
      st.selected = gone || st.keepNeighbour ? neighbour(before, st.selected, st.rows) : null;
    }
    if (!st.selected && st.rows.length) st.selected = st.rows[0];
    applySelection(false);
  }

  // The row that takes the place of `id`: the first one after it in the previous order that is still shown,
  // else the nearest one before it.
  function neighbour(prev, id, rows) {
    var i = (prev || []).indexOf(id), j;
    if (i < 0) return null;
    for (j = i + 1; j < prev.length; j++) if (rows.indexOf(prev[j]) >= 0) return prev[j];
    for (j = i - 1; j >= 0; j--) if (rows.indexOf(prev[j]) >= 0) return prev[j];
    return null;
  }

  // Keyboard focus back into the rows after a re-render removed the focused one: the selected row, else (no row
  // left) the rows container.
  function focusSelection() {
    if (!st) return;
    if (st.selected && rowEl(st.selected)) { applySelection(true); return; }
    focusRows();
  }

  // The rows container as the focus target of last resort: a non-text target inside the list, so Z still undoes a
  // delete and ↑ / Esc keep working. Its tabindex lives only while it holds focus (removed on blur), so it is never
  // a Tab stop or a click target.
  function focusRows() {
    if (!st) return;
    var rows = st.el.list;
    rows.setAttribute("tabindex", "-1");
    tryCall(function () { rows.focus({ preventScroll: true }); });
    if (document.activeElement !== rows) rows.removeAttribute("tabindex");
  }

  function applySelection(focus) {
    if (!st) return;
    var nodes = st.el.list.children;
    for (var i = 0; i < nodes.length; i++) markRow(nodes[i], focus);
  }

  // One row's selected state (class, aria-selected, the roving tabindex); with `focus`, the selected row takes focus.
  function markRow(n, focus) {
    if (!n.classList.contains("list__row")) return;
    var on = n.getAttribute("data-id") === st.selected;
    n.classList.toggle("list__row--selected", on);
    n.setAttribute("aria-selected", on ? "true" : "false");
    n.setAttribute("tabindex", on ? "0" : "-1");
    if (on && focus) tryCall(function () { n.focus({ preventScroll: false }); });
  }

  function select(id, focus) {
    if (!st) return;
    st.selected = id;
    applySelection(focus);
  }

  function moveSelection(delta) {
    if (!st || !st.rows.length) return;
    var i = st.rows.indexOf(st.selected);
    var next = i < 0 ? (delta > 0 ? 0 : st.rows.length - 1) : Math.max(0, Math.min(st.rows.length - 1, i + delta));
    select(st.rows[next], true);
    var el = rowEl(st.rows[next]);
    if (el && typeof el.scrollIntoView === "function") tryCall(function () { el.scrollIntoView({ block: "nearest" }); });
  }

  function promptOf(id) {
    var cache = M.cache || tryDep("cache");
    return cache && typeof cache.prompt === "function" ? cache.prompt(id) : null;
  }

  // Row activation: reader drawer → go to the passage and focus its card; deck page → edit in place.
  function activate(id) {
    var p = promptOf(id);
    if (!p || !st) return;
    if (st.mode === "drawer") {
      if (p.anchor && M.reader && typeof M.reader.goToAnchor === "function") tryCall(function () { M.reader.goToAnchor(p.anchor, { flash: true }); });
      if (M.margin && typeof M.margin.focus === "function") tryCall(function () { M.margin.focus(p.id); });
    } else {
      editRow(p);
    }
  }

  // ------------------------------------------------------------------ menu

  // refocus (a chosen item, Esc): focus goes back to the row's ⋯ BEFORE the menu, which holds it, leaves the DOM;
  // otherwise it would fall to the body element, out of reach of the list's keys (Z after "Delete", ↑↓, E, F).
  function closeMenu(refocus) {
    if (!st || !st.menu) return;
    var m = st.menu;
    st.menu = null;
    var active = document.activeElement;
    if (refocus && (!active || active === document.body || m.el.contains(active))) focusAfterMenu(m);
    try { document.removeEventListener("mousedown", m.onDown, true); } catch (e) { /* ignore */ }
    if (m.el.parentNode) m.el.parentNode.removeChild(m.el);
    if (m.anchor) m.anchor.setAttribute("aria-expanded", "false");
  }

  function focusAfterMenu(m) {
    var target = m.anchor && st.el.list.contains(m.anchor) ? m.anchor : rowEl(m.id);   // the rows may have re-rendered
    if (target) tryCall(function () { target.focus({ preventScroll: true }); });
    else focusRows();
  }

  function openMenu(p, anchorBtn) {
    closeMenu();
    var menu = h("div", { class: "list__menu", role: "menu" });
    function fill(items) {
      while (menu.firstChild) menu.removeChild(menu.firstChild);
      items.forEach(function (it) {
        var b = h("button", { type: "button", role: "menuitem", class: "list__menu-item" + (it.danger ? " list__menu-item--danger" : ""), text: it.label });
        b.disabled = !!it.disabled;
        b.addEventListener("click", function (ev) { ev.stopPropagation(); if (it.keep) it.run(); else { closeMenu(true); it.run(); } });
        menu.appendChild(b);
      });
      focusFirst();
    }
    function focusFirst() {
      if (!menu.parentNode) return;                 // focus only once the menu is in the DOM
      var first = menu.querySelector("button:not([disabled])");
      if (first) tryCall(function () { first.focus(); });
    }
    function moveTargets() {
      var cache = M.cache || tryDep("cache");
      var cols = cache && typeof cache.collections === "function" ? cache.collections() : [];
      return cols.filter(function (c) { return live(c) && c.kind === "deck" && c.id !== st.collectionId; })
        .sort(function (a, b) { return str(a.name).localeCompare(str(b.name)); });
    }
    var alikeOn = !!st.chips[ALIKE_CHIP] && !!(st.alike.partners && (st.alike.partners.get(p.id) || []).length);
    var items = [
      { label: p.kind === "highlight" ? "Write prompt" : "Edit", run: function () { editRow(p); } },
      // FIXES-1 FIX-1 c: "Finish split" in the place of "Split" while the second half of an earlier split waits as a draft
      REVIEWABLE[p.kind] ? (splitDraft(p) !== null ? { label: "Finish split", run: function () { finishSplit(p); } }
        : { label: "Split", run: function () { editRow(p, { split: true }); } }) : null,
      alikeOn ? { label: NOT_ALIKE_LABEL, run: function () { markNotAlike(p); } } : null,
      { label: p.flagged ? "Unflag" : "Flag", run: function () { toggleFlag(p); } },
      { label: "Move to…", keep: true, run: function () {
        var decks = moveTargets();
        var sub = decks.map(function (d) { return { label: d.name || "Untitled deck", run: function () { movePrompt(p, d); } }; });
        if (!sub.length) sub.push({ label: "No other deck — create one in the library", disabled: true, run: noop });
        sub.push({ label: "‹ Back", keep: true, run: function () { fill(items); } });
        fill(sub);
      } },
      obsidianOn() ? { label: p.obsidianSentAt ? "Update in Obsidian" : "Send to Obsidian", run: function () { sendToObsidian(p); } } : null,   // D32
      { label: "Delete", danger: true, run: function () { deletePrompt(p); } }
    ].filter(Boolean);
    fill(items);
    var rootEl = st.el.root, rr = rootEl.getBoundingClientRect(), br = anchorBtn.getBoundingClientRect();
    menu.style.top = Math.max(0, br.bottom - rr.top + rootEl.scrollTop + 4) + "px";
    menu.style.right = Math.max(8, rr.right - br.right) + "px";
    rootEl.appendChild(menu);
    anchorBtn.setAttribute("aria-expanded", "true");
    menu.addEventListener("keydown", function (ev) {
      var btns = Array.prototype.slice.call(menu.querySelectorAll("button:not([disabled])"));
      var i = btns.indexOf(document.activeElement);
      if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); closeMenu(true); }
      else if (ev.key === "ArrowDown") { ev.preventDefault(); ev.stopPropagation(); if (btns.length) btns[(i + 1) % btns.length].focus(); }
      else if (ev.key === "ArrowUp") { ev.preventDefault(); ev.stopPropagation(); if (btns.length) btns[(i - 1 + btns.length) % btns.length].focus(); }
      else if (ev.key === "Tab") { closeMenu(); }
      else ev.stopPropagation();
    });
    var onDown = function (ev) { if (!menu.contains(ev.target) && ev.target !== anchorBtn) closeMenu(); };
    document.addEventListener("mousedown", onDown, true);
    st.menu = { el: menu, anchor: anchorBtn, onDown: onDown, id: p.id };
    focusFirst();
  }

  // ------------------------------------------------------------------ actions

  // `step`: true, or the token of a group when this save is one step together with another write (M.undo, D33).
  function savePrompt(p, step) {
    var cache = M.cache || tryDep("cache");
    if (!cache || typeof cache.savePrompt !== "function") return Promise.reject(err("no_cache", "Storage is not ready"));
    return Promise.resolve(cache.savePrompt(p, { content: true, step: step || true }));   // a step: callers hand in a copy
  }

  function toggleFlag(p) {
    savePrompt(Object.assign({}, p, { flagged: !p.flagged })).catch(noop);
  }

  // DECISIONS D32: Settings › Obsidian › "Connect Marginalia to Obsidian" (M.obsidian.enabled()). While it is off,
  // a row menu has no "Send to Obsidian". An M.obsidian without that switch counts as on.
  function obsidianOn() {
    var O = M.obsidian;
    if (!O) return false;
    if (typeof O.enabled !== "function") return true;
    try { return O.enabled() === true; } catch (e) { return false; }
  }
  // ⋯ › "Send to Obsidian" / "Update in Obsidian" (BUILD-NOTES "Obsidian"): deck prompts have no margin card, so the
  // list is where they go to Obsidian. M.obsidian writes the copy and toasts the result; the click is the gesture.
  function sendToObsidian(p) {
    var O = M.obsidian;
    if (!O || typeof O.send !== "function") { toast("Obsidian is not available here"); return; }
    tryCall(function () { Promise.resolve(O.send(p.id, { fromGesture: true })).catch(noop); });
  }

  function deletePrompt(p) {
    var cache = M.cache || tryDep("cache");
    if (!cache || typeof cache.removePrompt !== "function") return;
    if (st && st.editing && st.editing.id === p.id) closeEditor(false);
    // removePrompt tombstones and emits prompt:deleted synchronously: refresh() re-renders at once and hands focus
    // to the neighbouring row (or the rows container when none is left), so it never drops to the body element and Z works.
    var removal;
    try { removal = Promise.resolve(cache.removePrompt(p.id, { step: true })); } catch (e) { removal = Promise.reject(e); }
    removal.then(function () {
      if (!st) return;
      st.undoId = p.id;
      if (st.undoTimer) clearTimeout(st.undoTimer);
      st.undoTimer = setTimeout(function () { if (st) st.undoId = null; }, UNDO_TTL_MS);
      st.undoToast = { id: p.id, handle: toast("Prompt deleted · Undo (Z)", [{ label: "Undo", key: "z", run: function () { undoDelete(p.id); } }], UNDO_TTL_MS) };
    }, function () { toast("Could not delete the prompt"); });
  }

  function undoDelete(id) {
    var cache = M.cache || tryDep("cache");
    if (!cache || typeof cache.restorePrompt !== "function") return;
    if (st && st.undoId === id) st.undoId = null;
    var restore;
    try { restore = Promise.resolve(cache.restorePrompt(id, { step: true })); } catch (e) { restore = Promise.reject(e); }
    restore.then(function () {
      if (st && st.rows.indexOf(id) >= 0) select(id, true);   // not when it belongs to another list or the search hides it
    }, function () { toast("Could not restore the prompt"); });
  }

  function movePrompt(p, deck) {
    var hadAnchor = !!(p.anchor && Array.isArray(p.anchor.pages) && p.anchor.pages.length) || !!(p.anchor && p.anchor.quote);
    var page = p.anchor && isNum(p.anchor.pageIndex) ? p.anchor.pageIndex + 1 : null;
    var ask = p.anchor
      ? confirm({ title: "Move to deck?", body: hadAnchor ? "The highlight on p. " + (page === null ? "?" : page) + " is removed. The review schedule is kept." : "The note loses its place in the book. The review schedule is kept.", ok: "Move", cancel: "Cancel", danger: false })
      : Promise.resolve(true);
    ask.then(function (ok) {
      if (!ok) return;
      var keepSection = (!p.anchor && p.context && typeof p.context.sectionLabel === "string" && p.context.sectionLabel) ? p.context.sectionLabel : null;
      // a copy (DECISIONS D33): the cache takes the record as it was for the step, so the move can be undone
      var moved = Object.assign({}, p, { anchor: null, collectionId: deck.id,
        context: { docName: deck.name || "", sectionLabel: keepSection, pageIndex: null, pageLabel: null } });
      return savePrompt(moved).then(function () { toast("Moved to “" + (deck.name || "deck") + "”"); refresh(); });
    }).catch(function () { toast("Could not move the prompt"); });
  }

  // ------------------------------------------------------------------ edit in place

  function closeEditor(saved) {
    if (!st || !st.editing) return;
    var ed = st.editing;
    st.editing = null;
    if (ed.editor && typeof ed.editor.destroy === "function") tryCall(function () { ed.editor.destroy(); });
    if (ed.host && ed.host.parentNode) ed.host.parentNode.removeChild(ed.host);
    if (ed.temp) {                                        // the second editor of a split sits in a row of its own
      if (ed.row && ed.row.parentNode) ed.row.parentNode.removeChild(ed.row);
    } else if (ed.row) {
      ed.row.classList.remove("list__row--editing");
      var main = ed.row.querySelector(".list__row-main"), more = ed.row.querySelector(".list__more");
      if (main) main.classList.remove("is-hidden");
      if (more) more.classList.remove("is-hidden");
    }
    setOwner("list");
    if (st.dirty || saved) { st.dirty = false; renderRows(); }
    if (st.rows.indexOf(ed.id) >= 0) select(ed.id, true);
    else focusSelection();                                // deleted, moved or hidden by the search meanwhile
  }

  // opts.split (FEATURES P2.2): the row's save opens a second editor for a new prompt (splitSecond) that holds the text
  // the prompt had before this edit. Cancel in the first editor: nothing happens.
  function editRow(p, opts) {
    if (!st) return;
    var splitText = opts && opts.split === true && REVIEWABLE[p.kind] ? str(p.text) : null;
    if (!M.editor || typeof M.editor.create !== "function") { toast("The editor is not available"); return; }
    closeEditor(false);
    closeMenu();
    var row = rowEl(p.id);
    if (!row) return;
    var main = row.querySelector(".list__row-main"), more = row.querySelector(".list__more");
    if (main) main.classList.add("is-hidden");
    if (more) more.classList.add("is-hidden");
    row.classList.add("list__row--editing");
    var host = h("div", { class: "list__editor" });
    row.appendChild(host);
    var editor = null;
    try {
      editor = M.editor.create({
        host: host, prompt: p, initialText: str(p.text), anchor: p.anchor || null, batch: false,
        onSave: function (text) {
          if (saveEdit(p, text) === false) {                    // nothing was saved: the editor stays, with its text
            // The editor drops its draft at every save. It takes the text back here, so it keeps a draft of it again.
            if (editor && typeof editor.setText === "function") tryCall(function () { editor.setText(text); });
            return;
          }
          closeEditor(true);
          // FIXES-1 FIX-1 a: a stale "split:<id>" draft never replaces the text from before THIS edit
          if (splitText !== null) { dropSplitDraft(p); splitSecond(p, splitText); }
        },
        onCancel: function () { closeEditor(false); }
      });
    } catch (e) {
      if (host.parentNode) host.parentNode.removeChild(host);
      if (main) main.classList.remove("is-hidden");
      if (more) more.classList.remove("is-hidden");
      row.classList.remove("list__row--editing");
      toast("Could not open the editor");
      return;
    }
    st.editing = { id: p.id, editor: editor, row: row, host: host };
    setOwner("editor");
    if (editor && typeof editor.focus === "function") tryCall(function () { editor.focus(); });
  }

  // Split, second half (FEATURES P2.2): an editor for a NEW prompt in a row of its own, right after the first prompt's
  // row (at the top when that row is not shown), filled with `text`. Its save makes a new prompt as the margin's "save
  // and write another" does: same collection, a copy of the anchor and the context (in a deck: the same deck and
  // section), a fresh schedule, not flagged, never sent to Obsidian. A blank save, like Cancel, stores nothing.
  function splitSecond(first, text) {
    if (!st || !M.editor || typeof M.editor.create !== "function") return;
    closeEditor(false);
    closeMenu();
    var after = rowEl(first.id);
    var row = h("div", { class: "list__row list__row--editing list__row--split", "data-split": first.id });
    var host = h("div", { class: "list__editor" });
    row.appendChild(host);
    var list = st.el.list;
    if (after && after.parentNode === list) list.insertBefore(row, after.nextSibling);
    else list.insertBefore(row, list.firstChild);
    var editor = null, ed = null;
    try {
      editor = M.editor.create({
        host: host, prompt: null, initialText: str(text), anchor: first.anchor || null, batch: false,
        collectionId: first.collectionId, note: SPLIT_NOTE, draftKey: SPLIT_DRAFT_PREFIX + first.id, keepDraft: true,
        onSave: function (t) { var id = saveNew(first, t); if (id && ed) ed.id = id; closeEditor(!!id); },
        onCancel: function () { closeEditor(false); }
      });
    } catch (e) {
      if (row.parentNode) row.parentNode.removeChild(row);
      toast("Could not open the editor");
      return;
    }
    ed = { id: first.id, editor: editor, row: row, host: host, temp: true };
    st.editing = ed;
    setOwner("editor");
    if (editor && typeof editor.focus === "function") tryCall(function () { editor.focus(); });
  }

  // FIXES-1 FIX-1: the second half of an unfinished split is the draft "split:<id>" (M.editor keepDraft keeps it from the
  // moment its editor opens until its Save or Cancel). "Finish split" opens that editor again with it.
  function splitDraft(p) {
    var E = M.editor;
    if (!p || !REVIEWABLE[p.kind] || !E || typeof E.draftText !== "function") return null;
    return E.draftText(SPLIT_DRAFT_PREFIX + p.id);
  }
  function dropSplitDraft(p) {
    var E = M.editor;
    if (E && typeof E.dropDraft === "function") E.dropDraft(SPLIT_DRAFT_PREFIX + p.id);
  }
  function finishSplit(p) {
    if (!st) return;
    closeEditor(false);                                   // an open editor's latest text is stored before it is read
    var text = splitDraft(p);
    if (text !== null) splitSecond(p, text);
  }

  // The new prompt of a split's second half → its id, or null when there was nothing to save.
  function saveNew(first, text) {
    var pr = dep("prompts");
    var parsed = pr.parse(str(text));
    if (parsed.kind === "highlight") return null;         // blank: nothing to keep
    var t = now(), cache = M.cache || tryDep("cache");
    var col = cache && typeof cache.collection === "function" ? cache.collection(first.collectionId) : null;
    var anchor = first.anchor && typeof first.anchor === "object" ? tryCall(function () { return JSON.parse(JSON.stringify(first.anchor)); }, Object.assign({}, first.anchor)) : null;
    var ctx = first.context && typeof first.context === "object" ? Object.assign({}, first.context) : null;
    var u = tryDep("util");
    var rec = {
      id: u && typeof u.uuid === "function" ? u.uuid("p_") : "p_" + t.toString(36) + Math.random().toString(36).slice(2, 8),
      collectionId: first.collectionId, kind: parsed.kind, text: str(text), tags: parsed.tags.slice(), flagged: false,
      anchor: anchor, context: ctx, cards: pr.reconcileCards(null, parsed, t).cards,
      createdAt: t, contentUpdatedAt: t, updatedAt: t, deletedAt: null, v: 1
    };
    var C = tryDep("context");
    if (col && C && typeof C.contextFor === "function") {
      var c2 = tryCall(function () { return C.contextFor(col, rec, null); }, null);
      if (c2) rec.context = c2;
    }
    savePrompt(rec).catch(function () { if (st && !st.editing) splitSecond(first, text); });   // keep the user's text
    return rec.id;
  }

  // → false when nothing was saved: the editor then stays open with its text.
  function saveEdit(p, text) {
    var pr = dep("prompts"), cache = M.cache || tryDep("cache"), step = true;
    // The record as the cache has it NOW, not the one from when the editor opened: a flag, a move, a send record or
    // an answer that came since stays (the margin's editor does the same).
    var cur = cache && typeof cache.prompt === "function" ? tryCall(function () { return cache.prompt(p.id); }, null) : null;
    if (cur) p = cur;
    if (!live(p)) {
      // The prompt was deleted while this editor was open (another window did it). The text is never written into a
      // deleted record, where nobody sees it: the prompt comes back with the text that the person saves, as ONE step
      // (the restore and the save carry one token). But not into a book or deck that is deleted too: then nothing is
      // saved, and the editor stays open, so the text is not lost.
      var col = cache && typeof cache.collection === "function" ? tryCall(function () { return cache.collection(p.collectionId); }, null) : null;
      if (!col || !live(col) || typeof cache.restorePrompt !== "function") {
        toast("Not saved: the book or deck of this prompt is deleted. Copy your text before you close the editor.", [], 8000);
        return false;
      }
      step = M.undo && typeof M.undo.group === "function" ? tryCall(function () { return M.undo.group(); }, true) : true;
      tryCall(function () { Promise.resolve(cache.restorePrompt(p.id, { step: step })).catch(noop); });
      p = tryCall(function () { return cache.prompt(p.id); }, null) || p;
    }
    var parsed = pr.parse(str(text));
    var rec = pr.reconcileCards(p, parsed, now());
    var old = str(p.text);
    // save a copy: the cached record changes only when the cache takes the new one (never half-edited)
    var next = Object.assign({}, p, { text: str(text), kind: parsed.kind, tags: parsed.tags.slice(), cards: rec.cards });
    savePrompt(next, step).then(function () {
      if (M.attachments && typeof M.attachments.gc === "function") {
        tryCall(function () { Promise.resolve(M.attachments.gc(old, next.text, { draftIds: [] })).catch(noop); });
      }
    }, noop);
    return true;
  }

  // ------------------------------------------------------------------ keyboard (on the list element only)

  // The keys onKeydown acts on once per press: everything it handles except ↑/↓. (M.app's REPEATABLE guard only
  // covers its document dispatcher, which never sees the keys the list stops.)
  function isSingleShot(ev, key, inText, inSearch) {
    if (key === "Escape") return true;
    if (key === "Enter") return !inText || inSearch;
    if (inText) return false;                             // typing in the search box keeps its native repeat
    if (ev.metaKey || ev.ctrlKey) return false;
    if (key === "Backspace" || key === "Delete") return true;
    return !ev.altKey && (key === "z" || key === "Z" || key === "e" || key === "E" || key === "f" || key === "F");
  }

  function onKeydown(ev) {
    if (!st) return;
    if (st.editing && st.editing.host && st.editing.host.contains(ev.target)) return;   // the editor owns its keys
    if (st.menu && st.menu.el.contains(ev.target)) return;
    var inSearch = ev.target === st.el.search;
    var inText = isTextTarget(ev.target);
    var key = ev.key;
    // FIXES-1 FIX-2: on a filter chip, Backspace, Delete, F and E act on nothing (the selected row is not where the focus
    // is). Space and Enter press the chip as a button; Esc and the arrows keep their list behaviour below.
    if (st.el.chipBar && st.el.chipBar.contains(ev.target) && !ev.metaKey && !ev.ctrlKey && CHIP_INERT_KEYS[key] === true) {
      ev.stopPropagation();
      return;
    }
    // A held key auto-repeats: without this a held Backspace deletes the row that takes focus after each delete
    // (and a held F flips the flag on every repeat). Swallow the repeat, its default and the document dispatcher.
    if (ev.repeat && isSingleShot(ev, key, inText, inSearch)) { ev.preventDefault(); ev.stopPropagation(); return; }
    if (key === "ArrowDown") {
      ev.preventDefault(); ev.stopPropagation();
      // from the search box, ↓ lands on the row already selected (renderRows pre-selects the first one)
      if (inSearch && st.rows.length) { select(st.rows.indexOf(st.selected) >= 0 ? st.selected : st.rows[0], true); return; }
      moveSelection(1); return;
    }
    if (key === "ArrowUp") {
      if (inSearch) return;
      ev.preventDefault(); ev.stopPropagation();
      // from the first row, or the empty list after the last row was deleted, ↑ goes back to the search box
      if (!st.rows.length || st.rows.indexOf(st.selected) === 0) { tryCall(function () { st.el.search.focus(); }); return; }
      moveSelection(-1); return;
    }
    if (key === "Enter") {
      if (inText && !inSearch) return;
      // a focused ⋯ / ✕ button or link keeps its native Enter: it presses that control, not the selected row
      if (!inSearch && ev.target && ev.target.closest && ev.target.closest("button, a[href], [role=menuitem]")) return;
      if (!st.selected) return;
      ev.preventDefault(); ev.stopPropagation();
      activate(st.selected); return;
    }
    if (key === "Escape") {
      ev.preventDefault(); ev.stopPropagation();
      if (st.mode === "drawer") { close(); return; }
      if (inSearch && st.el.search.value) { st.el.search.value = ""; search(""); return; }
      tryCall(function () { ev.target.blur(); });
      return;
    }
    if (inText) return;
    if ((key === "z" || key === "Z") && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
      if (st.undoId) { ev.preventDefault(); ev.stopPropagation(); undoDelete(st.undoId); }
      return;
    }
    if ((key === "e" || key === "E") && st.selected && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
      var p = promptOf(st.selected);
      if (p) { ev.preventDefault(); ev.stopPropagation(); editRow(p); }
      return;
    }
    if ((key === "Backspace" || key === "Delete") && st.selected && !ev.metaKey && !ev.ctrlKey) {
      var q = promptOf(st.selected);
      if (q) { ev.preventDefault(); ev.stopPropagation(); deletePrompt(q); }
      return;
    }
    if ((key === "f" || key === "F") && st.selected && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
      var f = promptOf(st.selected);
      if (f) { ev.preventDefault(); ev.stopPropagation(); toggleFlag(f); }
    }
  }

  // ------------------------------------------------------------------ open / close / refresh

  function onBusEvent(payload) {
    if (!st || !payload) return;
    var cid = payload.collectionId || (payload.prompt && payload.prompt.collectionId) || null;
    var pid = payload.promptId || (payload.prompt && payload.prompt.id) || null;
    if (cid !== st.collectionId && !(pid && st.rows.indexOf(pid) >= 0)) return;
    if (payload.prompt && updateRow(payload.prompt)) return;
    refresh();
  }

  // A saved prompt that keeps its place (still this list's and live, still shown by the search, still between its
  // neighbours in the order) gets a new row in place of its old one: one row's work, not every row's. Send all to
  // Obsidian saves every card of a book or deck in one go (BUILD-NOTES "Obsidian"). → false: refresh() instead.
  function updateRow(p) {
    if (st.editing || !live(p) || p.collectionId !== st.collectionId) return false;
    if (CHIPS.some(function (c) { return typeof c.prepare === "function"; })) return false;   // a chip over the whole list
    var i = st.rows.indexOf(p.id), old = i < 0 ? null : rowEl(p.id);
    if (!old) return false;
    if (st.chips[ALIKE_CHIP]) return false;                                          // grouped order, "≈" lines
    if (!st.alike.texts || !st.alike.texts.has(p.id)) return false;
    if (st.alike.texts.get(p.id) !== str(p.text)) {
      // A new text: the pairs are computed again now; when they are not the same pairs, every row may change.
      var was = pairSig(st.alike.pairs);
      ensureAlike(st.live.map(function (q) { return q.id === p.id ? p : q; }));
      if (pairSig(st.alike.pairs) !== was) return false;
    }
    var info = infoOf(p), prevInfo = st.info.get(p.id);
    st.info.set(p.id, info);
    if (!passes(p)) { if (prevInfo) st.info.set(p.id, prevInfo); return false; }
    var cache = M.cache || tryDep("cache");
    var col = cache && typeof cache.collection === "function" ? cache.collection(st.collectionId) : null;
    var kind = col ? col.kind : "book";
    var prev = i > 0 ? promptOf(st.rows[i - 1]) : null, next = i + 1 < st.rows.length ? promptOf(st.rows[i + 1]) : null;
    if (i > 0 && !(prev && compare(prev, p, kind) <= 0)) return false;
    if (i + 1 < st.rows.length && !(next && compare(p, next, kind) <= 0)) return false;
    var hadFocus = old.contains(document.activeElement);
    var row = buildRow(p, info);
    st.el.list.insertBefore(row, old);
    st.el.list.removeChild(old);
    markRow(row, false);
    for (var j = 0; j < st.live.length; j++) if (st.live[j].id === p.id) { st.live[j] = p; break; }
    renderChips();
    if (hadFocus) focusSelection();
    return true;
  }

  function open(collectionId, opts) {
    if (typeof document === "undefined") return false;
    opts = opts || {};
    var host = opts.host || document.getElementById("list");
    if (!host || !collectionId) return false;
    close();
    var mode = host.id === "list" ? "drawer" : "inline";
    var invoker = document.activeElement;
    var prevOwner = currentOwner(mode === "drawer" ? "reader" : "library");

    // (not named `search`: inside open() that would shadow the module's search(q), which the input handler calls)
    var searchInput = h("input", { type: "search", class: "list__search", placeholder: "Search prompts and #tags", "aria-label": "Search prompts", autocomplete: "off", spellcheck: "false" });
    var count = h("span", { class: "list__count" });
    var closeBtn = mode === "drawer" ? h("button", { type: "button", class: "btn btn--ghost list__close", "aria-label": "Close prompt list", text: "✕" }) : null;
    var chipEls = {};
    var chipBar = h("div", { class: "list__chips is-hidden", role: "group", "aria-label": "Filters" }, CHIPS.map(function (c) {
      var n = h("span", { class: "list__chip-count", text: "0" });
      var b = h("button", { type: "button", class: "chip list__chip is-hidden", "data-chip": c.id, "aria-pressed": "false" },
        [h("span", { class: "list__chip-label", text: c.label }), " ", n]);
      b.addEventListener("click", function (ev) { ev.stopPropagation(); toggleChip(c.id); });
      chipEls[c.id] = { btn: b, count: n };
      return b;
    }));
    var head = h("div", { class: "list__head" }, [
      h("div", { class: "list__title-row" }, [h("h2", { class: "list__title", text: "Prompts" }), count, closeBtn]),
      searchInput,
      chipBar
    ]);
    var listEl = h("div", { class: "list__rows", role: "listbox", "aria-label": "Prompts" });
    listEl.addEventListener("blur", function () { listEl.removeAttribute("tabindex"); });   // see focusRows()
    var rootEl = h("div", { class: "list list--" + mode }, [head, listEl]);

    while (host.firstChild) host.removeChild(host.firstChild);
    host.appendChild(rootEl);
    host.classList.add("list-host", "list-host--" + mode);
    host.classList.remove("is-hidden");

    st = {
      collectionId: collectionId, host: host, mode: mode, query: "", selected: null, rows: [],
      editing: null, menu: null, dirty: false, undoId: null, undoTimer: null, undoToast: null, subs: [],
      chips: {}, live: [], info: new Map(), chipData: {},   // the active chips by id; the live prompts and their rowInfo
      alike: { texts: null, pairs: [], partners: null, ignored: null, ignoredSig: "", stale: true }, keepNeighbour: false,
      invoker: invoker, prevOwner: prevOwner, el: { root: rootEl, search: searchInput, list: listEl, count: count, chipBar: chipBar, chips: chipEls }
    };

    var debounced = null;
    var u = tryDep("util");
    // only for this list: a keystroke just before close() must not filter the next list opened within the debounce
    var apply = function () { if (st && st.el.search === searchInput) search(searchInput.value); };
    debounced = u && typeof u.debounce === "function" ? u.debounce(apply, SEARCH_DEBOUNCE_MS) : apply;
    searchInput.addEventListener("input", function () { debounced(); });
    if (closeBtn) closeBtn.addEventListener("click", function () { close(); });
    rootEl.addEventListener("keydown", onKeydown);

    // focus inside the in-place editor → "editor"; elsewhere in the list → "list"; leaving an inline list → the page's owner
    rootEl.addEventListener("focusin", function (ev) {
      var inEditor = !!(st && st.editing && st.editing.host && st.editing.host.contains(ev.target));
      setOwner(inEditor ? "editor" : "list");
    });
    if (mode === "drawer") {
      setOwner("list");
    } else {
      rootEl.addEventListener("focusout", function (ev) {
        var to = ev.relatedTarget;
        if (!to || !rootEl.contains(to)) setOwner(prevOwner === "list" || prevOwner === "editor" ? "library" : prevOwner);
      });
    }

    var bus = M.bus || tryDep("bus");
    if (bus && typeof bus.on === "function") {
      EVENTS.forEach(function (t) { st.subs.push(bus.on(t, onBusEvent)); });
      // the deleted prompt is back (the notice's Undo, Z, or Cmd+Z, DECISIONS D33): the offer and its notice go
      st.subs.push(bus.on("prompt:restored", function (e) {
        var u = st ? st.undoToast : null;
        if (!u || !e || e.promptId !== u.id) return;
        st.undoToast = null;
        if (st.undoId === u.id) st.undoId = null;
        if (u.handle && typeof u.handle.close === "function") tryCall(function () { u.handle.close(); });
      }));
      st.subs.push(bus.on("doc:closed", function () { if (st && st.mode === "drawer") close(); }));
      st.subs.push(bus.on("settings:changed", onSettingsChanged));
    }

    renderRows();
    if (mode === "drawer") tryCall(function () { searchInput.focus(); });
    return true;
  }

  function close() {
    if (!st) return;
    var s = st;
    closeMenu();
    closeEditorQuiet();
    s.subs.forEach(function (off) { tryCall(off); });
    if (s.undoTimer) clearTimeout(s.undoTimer);
    st = null;
    var host = s.host;
    while (host.firstChild) host.removeChild(host.firstChild);
    host.classList.remove("list-host", "list-host--drawer", "list-host--inline");
    if (s.mode === "drawer") host.classList.add("is-hidden");
    if (s.mode === "drawer") {
      setOwner(s.prevOwner === "list" ? "reader" : s.prevOwner);
      var back = s.invoker && document.contains(s.invoker) && s.invoker !== document.body ? s.invoker : document.getElementById("reader");
      if (back && typeof back.focus === "function") tryCall(function () { back.focus({ preventScroll: true }); });
    }
  }

  // destroy the in-place editor without re-rendering (used by close())
  function closeEditorQuiet() {
    if (!st || !st.editing) return;
    var ed = st.editing;
    st.editing = null;
    if (ed.editor && typeof ed.editor.destroy === "function") tryCall(function () { ed.editor.destroy(); });
  }

  function search(q) {
    if (!st) return;
    st.query = str(q);
    if (st.el.search.value !== st.query) st.el.search.value = st.query;
    if (st.editing) { st.dirty = true; return; }
    renderRows();
  }

  function refresh() {
    if (!st) return;
    if (st.editing) { st.dirty = true; return; }
    // focus on a row, its ⋯ or the rows container comes back after the re-render; the search box, the ✕ and an
    // open menu keep theirs
    var hadFocus = st.el.list.contains(document.activeElement);
    renderRows();
    if (hadFocus) focusSelection();
  }

  function isOpen() { return !!st; }

  function activeEditor() { return st && st.editing ? st.editing.editor : null; }

  function collectionId() { return st ? st.collectionId : null; }

  var api = {
    open: open,
    close: close,
    search: search,
    refresh: refresh,
    isOpen: isOpen,
    // extensions (documented in the engineer's report)
    activeEditor: activeEditor,
    collectionId: collectionId,
    // Z routed by M.app while "Prompt deleted · Undo (Z)" from the list shows: true when it restored one
    undoLast: function () { if (st && st.undoId) { undoDelete(st.undoId); return true; } return false; },
    // DECISIONS D33: the prompt whose row holds the open editor (for the second half of a Split: the first half), or null
    editingId: function () { return st && st.editing && typeof st.editing.id === "string" ? st.editing.id : null; },
    // the active filter chips' ids, in CHIPS order (FEATURES P1.3 e)
    activeChips: function () { return st ? CHIPS.filter(function (c) { return !!st.chips[c.id]; }).map(function (c) { return c.id; }) : []; },
    CHIPS: CHIPS,
    // the look-alike pairs of the open list as last computed (FEATURES P2.4): [{a, b, score}]
    alikePairs: function () { return st && st.alike.pairs ? st.alike.pairs.slice() : []; },
    _pure: { sortPrompts: sortPrompts, matches: matches, dueText: dueText, sectionText: sectionText, sides: sides, rowInfo: rowInfo }
  };
  M.list = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

/* SELF-CHECK (SPEC §17.2 M.list + BUILD-NOTES): open(collectionId, {host}) — renders into #list (drawer)
 * or the deck page host (inline), sets focus owner "list" (drawer) and restores it on close();
 * close(); search(q); refresh() (also on prompt:saved|deleted|restored and prompts:recontexted; a prompt:saved whose
 * prompt keeps its place in the shown rows replaces only that row, so N saves in a row cost N rows, not N·N);
 * isOpen() → boolean. Extensions: activeEditor() → Editor|null (the in-place row editor),
 * collectionId(), _pure helpers for tests. The row menu's "Send to Obsidian" / "Update in Obsidian" (once
 * prompt.obsidianSentAt is set) calls M.obsidian.send(id, {fromGesture: true}) (BUILD-NOTES "Obsidian"); the menu has
 * that item only while the Obsidian connection is on (M.obsidian.enabled(), DECISIONS D32).
 * BUILD-NOTES "Prompt craft" (FEATURES P1.3 e, P1.4 d): the head's .list__chips holds one toggle button per CHIPS entry
 * (button.chip.list__chip[data-chip][aria-pressed], "<label> <n>"): "Flagged n" and "Struggling n"; shown while n > 0
 * or active; active chips AND with each other and the search; counts follow every re-render and updateRow. A struggling
 * row (M.scheduler.promptMissDays(p) >= STRUGGLE_DAYS) carries .list__struggle "struggling" titled "Forgotten on N days".
 * Extensions: activeChips() → [id], CHIPS (the chip table), _pure.rowInfo(p) → {flagged, missDays, struggling}.
 * FIXES-1 FIX-1: the second editor keeps its text as the draft "split:<id>" (M.editor keepDraft) until its Save or Cancel;
 * a stale one is dropped before it opens; while it exists the row menu shows "Finish split" in the place of "Split".
 * FEATURES P2.2: the row menu's "Split" (right after Edit; Q./A. and cloze rows) edits the row in place; its save opens a
 * second editor for a new prompt in a row of its own (.list__row--split) right after the first row, filled with the text
 * from before the edit (note "Second half of the split — …", draft key "split:<id>"); its save makes a new prompt in the
 * same collection with a copy of the anchor and context (a deck: the same section), a fresh schedule, not flagged; a
 * blank save or Cancel stores nothing.
 * FEATURES P2.4: a third chip "Look-alikes n" (id "alike"; n = the live prompts of this list in at least one pair of
 * M.similar.pairs(live prompts, settings.notAlike)). The pairs are computed at open() and again only when a prompt's
 * text, the set of live prompts or settings.notAlike (settings:changed) changed — never on a search key stroke. While the
 * chip is on the rows are grouped by pair (connected groups together, breadth first from the earliest member), each
 * with .list__alike "≈ <the most alike partner's question on one line>" (+ "(+N more)"), and the row menu gains
 * "Not alike" (right after Split), which appends the row's pair keys to settings.notAlike. A save that changes a prompt's
 * text computes the pairs again; it re-renders the whole list when the pairs changed, and so does any save while the
 * chip is on. Extension: alikePairs() → [{a, b, score}].
 * FIXES-1 FIX-2: while the focus is in .list__chips, Backspace, Delete, F and E do nothing (stopped, the selected row is
 * untouched); Space and Enter press the chip; Esc and the arrows keep the list's behaviour. */
