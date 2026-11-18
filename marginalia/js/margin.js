/* Marginalia — js/margin.js
 * M.margin (SPEC §2 rail/stack, §3 navigation/delete/focus, §6 cards & layout driver, §17.2;
 * BUILD-NOTES "Key routing" extras): the margin cards, the rail markers with popovers, the bottom
 * sheet, the card menu and the one layout driver that calls M.layout.compute in a single rAF.
 *
 * Public: mount(scrollEl, marginEl); setItems(prompts); layout({activeId}); focus(id); next(); prev();
 *   setMode("cards"|"markers"); openEditor({promptId|null, anchor, initialText}); closeEditor({save});
 *   activeEditor() → Editor|null; editing() → the options that open the open editor again ({promptId, anchor,
 *   initialText?, obsidian?, splitText?, note?, draftKey?, keepDraft?}; null without one; D30, js/tabs.js);
 *   setAnswersHidden(b); run(id) → boolean (next, prev, edit, toggleAnswer,
 *   goToPassage, flag, delete, undoDelete, escape); escape(); closePopover(); focusedId(); setHot(id|null).
 *
 * How it works
 * - One card element per live prompt of the open collection (`doc:opened` → M.cache.promptsOf, re-queried
 *   on prompt:saved / deleted / restored). anchorY comes from M.anchors.anchorY(anchor, pageTops, viewportFn)
 *   (viewportFn(i) → M.pdfview.viewport(i)); a lost or missing anchor sits at its page top.
 * - A saved record re-renders its card when it differs from what the card shows (a snapshot taken by
 *   renderCard), so an edit saved on the cache's live object itself (prompt list ⋯ → Edit) is not missed.
 * - Wide mode: cards are position: absolute in #margin; heights come from one ResizeObserver (estimate
 *   ceil(chars/38)·18 + 20 until measured, +120 with an image token; a card that leaves the placeholder
 *   state is also measured synchronously so the first paint never overlaps); cards further than one
 *   viewport away are empty placeholders;
 *   M.layout.compute runs in one rAF after pages:measured, scale:changed, prompt:*, resize, focus/hover
 *   change; the active (editing > hovered > focused) card is pinned; a hairline SVG connector is drawn for
 *   the hot card when top ≠ anchorY; markers mode (M) collapses every card but the active one.
 * - Rail mode: anchors within 60 px merge into one 24-px marker (count badge); click / Enter opens the
 *   bucket's cards in a .popover (Esc closes, ↑↓ move between markers); editing happens in the popover.
 * - Stack mode: focus(id) / openEditor open #sheet with the card or editor.
 * - Enter → run("toggleAnswer") toggles the focused card's answer, but returns false while a control has
 *   the DOM focus (toolbar / find-bar / sheet button, card-menu item, .hl-badge, link, field), so the
 *   keydown keeps its native activation.
 * - Delete → M.cache.removePrompt + toast "Prompt deleted · Undo (Z)" (8 s); Z → M.cache.restorePrompt.
 * - Save of a new prompt: M.cache.savePrompt with kind from M.prompts.parse, the anchor, context from
 *   M.context.contextFor(collection, prompt, M.pdfview.pageLabel(pageIndex)) and cards from
 *   M.prompts.reconcileCards; editor:opened / editor:closed are emitted and the focus owner is set through
 *   M.app.setFocusOwner("editor") and back.
 * - Hover / focus on a card emit margin:hot {promptId|null} and margin:focused {promptId|null} so the reader
 *   can light the highlight (.hl--active); the reader calls setHot(id) / focus(id) the other way.
 * - Card width (BUILD-NOTES "Post-review decisions"): 256 px, 192 px under #reader.reader--compact (the CSS
 *   variable --card-w). Estimates use 38 · cardWidth / 256 characters per line; on reader:mode {mode, compact}
 *   a new width re-estimates every card, re-measures the rendered ones and re-runs the cascade at once.
 * - Obsidian (BUILD-NOTES "Obsidian"): openEditor({…, obsidian: true}) is the O editor ("Save + Obsidian"); its save
 *   stores the record as any other and then calls M.obsidian.send(id, {fromGesture: true}). The card ⋯ menu offers
 *   "Send to Obsidian" ("Update in Obsidian" once prompt.obsidianSentAt is set) for every kind. Both only while the
 *   Obsidian connection is on (M.obsidian.enabled(), DECISIONS D32): off, the menu has no such item and
 *   openEditor({obsidian: true}) opens the plain editor.
 * - A new free note (no passage) saved with nothing in it is neither stored nor sent: the editor stays open and its
 *   lint line says "Type a note first" (Editor.hint).
 * - Split (FEATURES P2.2; card menu "Split" right after Edit, Q./A. and cloze only): openEditor({promptId, split: true})
 *   is the normal editor on the prompt and remembers its text; its save (reconcileCards as any edit) opens at once a
 *   new-prompt editor at the same passage (a copy of the anchor) holding that old text, with the quiet line SPLIT_NOTE
 *   and the draft key "split:<id>". Cancel in the first: nothing; cancel in the second: the first edit stays, no copy.
 *   FIXES-1 FIX-1: a stale "split:<id>" draft is dropped before the second editor opens; that editor keeps its text as the
 *   draft (M.editor keepDraft) until its Save or Cancel, whatever else closes it; while the draft exists the card menu
 *   shows "Finish split" (act "finishSplit") in the place of "Split", which opens the second editor again with it.
 * - Another angle (FEATURES P2.3; card menu "Another angle…", every kind): openEditor({promptId: null, anchor, initialText:
 *   "Q. ", angles: true}) opens the new-prompt editor at the same passage with M.editor's angle picker open.
 * - #margin is sticky at the scroller's right edge (styles.css). While a zoomed page is wider than the room
 *   beside it the margin sits over the page: .margin--pinned (opaque, 1-px rule on its left) is kept in step on
 *   scroll, scroller resize and every layout, and the connector is redrawn on horizontal scroll. J / K scroll the
 *   passage sideways too when it would sit under the margin (M.reader.scrollLeftFor).
 *
 * Loads in node with no DOM: nothing touches window/document at load time; mount() is a no-op there.
 */
(function (root) {
  "use strict";
  var M = root.Marginalia = root.Marginalia || {};
  function dep(name) { return M[name] || (typeof require === "function" ? require("./" + name + ".js") : undefined); }

  var GAP = 8, MAX_DRIFT = 320, COLLAPSED_H = 24, BUCKET_PX = 60, CARD_LEFT = 16, UNDO_TTL = 8000;
  var ESTIMATE_CHARS_PER_LINE = 38, ESTIMATE_LINE_H = 18, ESTIMATE_PAD = 20, ESTIMATE_IMAGE = 120, ESTIMATE_ROW = 20, ESTIMATE_BUTTON = 36, PILL_CHARS = 40;
  var CARD_W = 256;                          // SPEC §6 card width: the estimate's 38 characters per line are for this width
  var IMAGE_GRACE_MS = 4000;                 // an "Image missing" chip holds the image estimate this long (the bytes may still be loading)
  var GLYPHS = { qa: "✦", cloze: "{}", note: "▭", highlight: "·" };   // text fallback only: cards and markers draw M.util.kindIcon
  var TEMP_PREFIX = "new:";
  var EMPTY_FREE_NOTE = "Type a note first";  // the lint a blank free note's save shows instead of storing it
  // FEATURES P2.2: the quiet line of the second editor of a split, and its draft key prefix (a draft of another new
  // prompt at the same passage never takes the old text's place).
  var SPLIT_NOTE = "Second half of the split — keep what the first prompt no longer asks";
  var SPLIT_DRAFT_PREFIX = "split:";
  var SPLITTABLE = { qa: true, cloze: true };

  // ---------------------------------------------------------------- helpers
  function str(v) { return v == null ? "" : String(v); }
  function hasDom() { return typeof document !== "undefined" && document && typeof document.createElement === "function"; }
  function isNum(v) { return typeof v === "number" && isFinite(v); }
  function escapeHtml(s) {
    var util = M.util || dep("util");
    if (util && typeof util.escapeHtml === "function") return util.escapeHtml(s);
    return str(s).replace(/[&<>"']/g, function (ch) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[ch]; });
  }
  // The kind's line icon (constant SVG from M.util.kindIcon: pencil, question mark, brackets, marker pen), or the old
  // text glyph when util is missing.
  function kindIconHtml(kind) {
    var util = M.util || dep("util");
    if (util && typeof util.kindIcon === "function") return util.kindIcon(kind);
    return escapeHtml(GLYPHS[kind] || GLYPHS.note);
  }
  function parse(text) {
    var P = M.prompts || dep("prompts");
    if (P && typeof P.parse === "function") { try { return P.parse(text); } catch (e) { /* fall through */ } }
    return { kind: str(text).trim() ? "note" : "highlight", question: str(text), answer: "", body: str(text), deletions: [], tags: [], display: str(text), lints: [] };
  }
  function imageUrl(id) {
    var A = M.attachments;
    if (A && typeof A.url === "function") { try { return A.url(id); } catch (e) { return null; } }
    return null;
  }
  // cloze: true renders the deletions as <mark class="cloze-mark"> without their braces, false keeps the
  // braces as typed (Q/A and notes, where braces are literal text); undefined leaves M.markup's default.
  function renderHtml(text, mask, cloze) {
    var mk = M.markup;
    if (mk && typeof mk.render === "function") {
      try { return str(mk.render(text, { mode: "card", imageUrl: imageUrl, mask: mask || null, cloze: cloze })); } catch (e) { /* fall through */ }
    }
    return escapeHtml(text).replace(/\n/g, "<br>");
  }
  function plainText(text) {
    var mk = M.markup;
    if (mk && typeof mk.plain === "function") { try { return str(mk.plain(text)); } catch (e) { /* fall through */ } }
    return str(text).replace(/!\[[^\]]*\]\(att:[^)]*\)/g, "[image]").replace(/\s+/g, " ").trim();
  }
  function excerpt(text, n) {
    var P = M.prompts || dep("prompts");
    var t = text;
    if (P && typeof P.stripTags === "function") { try { t = P.stripTags(text); } catch (e) { t = text; } }
    var s = plainText(t).replace(/^\s*Q\.\s*/, "");
    var a = Array.from(s);
    return a.length > n ? a.slice(0, n).join("").replace(/\s+$/, "") + "…" : s;
  }
  // SPEC §6 estimate until the ResizeObserver reports: ceil(chars/38)·18 + 20 with chars = the rendered
  // question + answer (cloze / note: the body; highlight: its quote excerpt), +120 when the text carries an
  // image token, plus the rows the card will add (tag chips, a lint / lost chip, the "Write prompt" button).
  // Generous rather than tight: an estimate that is too small makes the cascade overlap until measured.
  // cardWidth (default 256): the characters per line scale with it, 38 · cardWidth / 256 (192 → 28.5).
  function charsPerLine(cardWidth) {
    var w = isNum(cardWidth) && cardWidth > 0 ? cardWidth : CARD_W;
    return Math.max(8, ESTIMATE_CHARS_PER_LINE * w / CARD_W);
  }
  function estimateHeight(text, prompt, cardWidth) {
    var parsed = parse(text), chars, h;
    if (parsed.kind === "qa") chars = plainText(parsed.question).length + plainText(parsed.answer).length;
    else if (parsed.kind === "highlight") chars = Math.min(80, plainText(prompt && prompt.anchor && prompt.anchor.quote || "").length);
    else chars = plainText(parsed.display).length;
    h = Math.ceil(Math.max(1, chars) / charsPerLine(cardWidth)) * ESTIMATE_LINE_H + ESTIMATE_PAD;
    if (hasImageToken(text)) h += ESTIMATE_IMAGE;
    if (parsed.tags && parsed.tags.length) h += ESTIMATE_ROW;
    if ((parsed.lints && parsed.lints.length) || (prompt && prompt.anchor && (prompt.anchor.lost === true || prompt.anchor.truncated === true))) h += ESTIMATE_ROW;
    if (parsed.kind === "highlight" && prompt) h += ESTIMATE_BUTTON;
    return h;
  }
  function hasImageToken(text) {
    var P = M.prompts || dep("prompts");
    if (P && typeof P.imageIds === "function") { try { return P.imageIds(text).length > 0; } catch (e) { /* fall back */ } }
    return /!\[[^\]\n]*\]\(att:[A-Za-z0-9_\-]+\)/.test(str(text));
  }
  function hasRects(anchor) {
    if (!anchor || !Array.isArray(anchor.pages)) return false;
    for (var i = 0; i < anchor.pages.length; i++) if (anchor.pages[i] && Array.isArray(anchor.pages[i].rects) && anchor.pages[i].rects.length) return true;
    return false;
  }
  function promptPageIndex(p) {
    if (p && p.anchor && isNum(p.anchor.pageIndex)) return p.anchor.pageIndex;
    if (p && p.context && isNum(p.context.pageIndex)) return p.context.pageIndex;
    return 0;
  }
  function isTemp(id) { return typeof id === "string" && id.indexOf(TEMP_PREFIX) === 0; }
  function app() { return M.app || null; }
  function setOwner(owner) {
    var a = app();
    if (a && typeof a.setFocusOwner === "function") { try { a.setFocusOwner(owner); } catch (e) { /* ignore */ } }
  }
  function emit(type, payload) {
    var bus = M.bus || dep("bus");
    if (bus && typeof bus.emit === "function") { try { bus.emit(type, payload); } catch (e) { /* ignore */ } }
  }
  function toast(opts) {
    var a = app();
    if (a && typeof a.toast === "function") { try { return a.toast(typeof opts === "string" ? { text: opts } : opts); } catch (e) { return null; } }
    return null;
  }
  function confirm(opts) {
    var a = app();
    if (a && typeof a.confirm === "function") { try { return Promise.resolve(a.confirm(opts)); } catch (e) { return Promise.resolve(true); } }
    return Promise.resolve(true);
  }
  function raf(fn) {
    if (typeof requestAnimationFrame === "function") return requestAnimationFrame(fn);
    return setTimeout(fn, 16);
  }
  function viewportFn(i) {
    var V = M.pdfview;
    if (V && typeof V.viewport === "function") { try { return V.viewport(i); } catch (e) { return null; } }
    return null;
  }
  function pageLabelFor(pageIndex) {
    var V = M.pdfview;
    if (!isNum(pageIndex) || !V) return null;
    if (typeof V.pageLabel === "function") { try { var l = V.pageLabel(pageIndex); return l == null ? null : String(l); } catch (e) { return null; } }
    return null;
  }

  // ---- pure (exported, tested)
  // entries: [{id, y}] → buckets [{y, ids}]; anchors within `px` of the bucket's first anchor merge.
  function bucket(entries, px) {
    var list = (Array.isArray(entries) ? entries : []).filter(function (e) { return e && isNum(e.y); })
      .slice().sort(function (a, b) { return a.y - b.y; });
    var out = [], cur = null, span = isNum(px) ? px : BUCKET_PX;
    for (var i = 0; i < list.length; i++) {
      if (cur && list[i].y - cur.y <= span) cur.ids.push(list[i].id);
      else { cur = { y: list[i].y, ids: [list[i].id] }; out.push(cur); }
    }
    return out;
  }
  // Document order of prompts: (anchorY, createdAt).
  function sortIds(entries) {
    return (Array.isArray(entries) ? entries : []).slice().sort(function (a, b) {
      return (a.anchorY - b.anchorY) || ((a.createdAt || 0) - (b.createdAt || 0)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    }).map(function (e) { return e.id; });
  }
  function qaText(p) {
    var parsed = parse(p.text);
    if (parsed.kind === "qa") return "Q. " + parsed.question + "\nA. " + parsed.answer;
    return str(p.text);
  }

  // ---------------------------------------------------------------- state
  var st = {
    mounted: false, scrollEl: null, marginEl: null, sheetEl: null, railEl: null, connectorEl: null,
    collectionId: null, items: new Map(), cards: new Map(), order: [],
    focused: null, hot: null, forcedActive: null, editing: null,
    mode: "cards", answersHidden: false, readerMode: "wide",
    pageTops: [], pageHeights: [], layoutQueued: false, placeholdersQueued: false,
    popover: null, sheetOpen: false, pendingUndo: null, deleting: null, menu: null, menuOutside: null,
    ro: null, offs: [], buckets: [], focusedMarker: 0,
    cardW: CARD_W, pinned: false, scrollLeft: 0
  };

  function liveCard(id) { var c = st.cards.get(id); return c && !c.temp ? c : null; }
  function currentActiveId() {
    if (st.editing) return st.editing.id;
    if (st.forcedActive && st.cards.has(st.forcedActive)) return st.forcedActive;
    if (st.hot && st.cards.has(st.hot)) return st.hot;
    if (st.focused && st.cards.has(st.focused)) return st.focused;
    return null;
  }

  // ---------------------------------------------------------------- geometry
  function refreshGeometry() {
    var V = M.pdfview;
    if (V && typeof V.pageTops === "function") {
      try { var t = V.pageTops(); if (Array.isArray(t) && t.length) st.pageTops = t; } catch (e) { /* keep */ }
    }
    if (V && typeof V.pageHeights === "function") {
      try { var h = V.pageHeights(); if (Array.isArray(h) && h.length) st.pageHeights = h; } catch (e) { /* keep */ }
    }
    setMarginHeight();
  }
  function totalHeight() {
    var n = st.pageTops.length;
    if (!n) return 0;
    var last = st.pageTops[n - 1], h = st.pageHeights[n - 1];
    return last + (isNum(h) ? h : 0);
  }
  function setMarginHeight() {
    if (!st.marginEl) return;
    var total = totalHeight();
    st.marginEl.style.height = st.readerMode === "stack" ? "" : (total > 0 ? Math.ceil(total) + "px" : "");
  }
  // The real card width: the --card-w the margin inherits from #reader (192 under .reader--compact).
  function readCardWidth() {
    var el = st.marginEl;
    if (!el || typeof root.getComputedStyle !== "function") return CARD_W;
    try { var w = parseFloat(root.getComputedStyle(el).getPropertyValue("--card-w")); return w > 0 ? w : CARD_W; } catch (e) { return CARD_W; }
  }
  // A new card width: every estimate is redone for it and the rendered cards are measured again (the class
  // on #reader is already set, so offsetHeight reads the new width). The card with the open editor (a new card's
  // too) is measured as it is: its saved text says nothing about the editor's height, and an estimate would let the
  // cards below overlap the editor for a frame. → true when the width changed.
  function syncCardWidth() {
    var w = readCardWidth();
    if (w === st.cardW) return false;
    st.cardW = w;
    var measure = [], editing = st.editing ? st.editing.card : null;
    st.cards.forEach(function (c) {
      if (c === editing) { c.collapsed = false; measure.push(c); return; }
      if (c.temp) return;
      c.measured = false;
      if (c.placeholder || c.collapsed || !c.rendered) {
        c.height = estimateHeight(c.prompt.text, c.prompt, w);
        if (c.placeholder && st.readerMode === "wide") c.el.style.minHeight = c.height + "px";
      } else measure.push(c);
    });
    if (st.readerMode === "wide" && measure.length) measureNow(measure);
    return true;
  }
  // #margin is sticky (right: 0) in its scroller: when the row is wider than the scroller and not scrolled to
  // its end, the margin is held at the right edge over the page. That is exactly "scrollLeft < the overflow".
  function updatePinned() {
    var sc = st.scrollEl, el = st.marginEl;
    if (!sc || !el) return;
    var over = (Number(sc.scrollWidth) || 0) - (Number(sc.clientWidth) || 0), left = Number(sc.scrollLeft) || 0;
    var pinned = st.readerMode !== "stack" && over > 1 && left < over - 1;
    if (pinned === st.pinned && el.classList.contains("margin--pinned") === pinned) return;
    st.pinned = pinned;
    el.classList.toggle("margin--pinned", pinned);
  }
  // Scroller scroll: placeholders (vertical) and, when the scroll moved sideways, the pinned state and the
  // connector (the page slides under a pinned margin, so the highlight's right edge moves relative to it).
  function onScrollerScroll() {
    schedulePlaceholders();
    var left = st.scrollEl ? Number(st.scrollEl.scrollLeft) || 0 : 0;
    if (left === st.scrollLeft) return;
    st.scrollLeft = left;
    updatePinned();
    if (st.readerMode === "wide" && st.connectorEl && !st.connectorEl.classList.contains("is-hidden")) updateConnector(currentActiveId());
  }
  function pageIndexAtY(y) {
    var tops = st.pageTops, i;
    if (!tops.length) return 0;
    for (i = tops.length - 1; i >= 0; i--) if (tops[i] <= y) return i;
    return 0;
  }
  function isLost(p) {
    var a = p.anchor;
    if (!a) return true;
    if (a.lost === true) return true;
    if (st.pageTops.length && isNum(a.pageIndex) && a.pageIndex >= st.pageTops.length) return true;
    return false;
  }
  function computeAnchorY(p) {
    var pi = promptPageIndex(p), tops = st.pageTops;
    var top = isNum(tops[pi]) ? tops[pi] : (tops.length ? tops[tops.length - 1] : 0);
    var a = p.anchor;
    if (!a || isLost(p)) return top;
    var An = M.anchors;
    if (An && typeof An.anchorY === "function") {
      try { var y = An.anchorY(a, tops, viewportFn); if (isNum(y)) return y; } catch (e) { /* fall back */ }
    }
    var vp = viewportFn(pi);
    if (vp && typeof vp.convertToViewportPoint === "function" && isNum(a.y)) {
      try { var pt = vp.convertToViewportPoint(0, a.y); if (pt && isNum(pt[1])) return top + pt[1]; } catch (e2) { /* fall back */ }
    }
    return top;
  }
  function refreshAnchors() {
    st.cards.forEach(function (c) { c.anchorY = computeAnchorY(c.prompt); c.pageIndex = promptPageIndex(c.prompt); c.lost = !c.temp && isLost(c.prompt); });
    st.order = sortIds(Array.from(st.cards.values()).map(function (c) { return { id: c.id, anchorY: c.anchorY, createdAt: c.prompt.createdAt }; }));
  }
  // The highlight's right edge (x, relative to the margin's left edge) for the connector; null when unknown.
  function highlightRightX(c) {
    var p = c.prompt, a = p.anchor, An = M.anchors, V = M.pdfview;
    if (!a || !hasRects(a) || !An || typeof An.viewportRects !== "function" || !V || typeof V.pageView !== "function") return null;
    try {
      var pv = V.pageView(c.pageIndex);
      if (!pv || !pv.el || !pv.viewport) return null;
      var rects = An.viewportRects(a, c.pageIndex, pv.viewport);
      if (!Array.isArray(rects) || !rects.length) return null;
      var right = -Infinity;
      for (var i = 0; i < rects.length; i++) right = Math.max(right, Math.max(rects[i][0], rects[i][2]));
      if (!isFinite(right)) return null;
      var pr = pv.el.getBoundingClientRect(), mr = st.marginEl.getBoundingClientRect();
      return pr.left + right - mr.left;
    } catch (e) { return null; }
  }

  // ---------------------------------------------------------------- cards
  function buildCard(p, temp) {
    var el = document.createElement("div");
    el.className = "card card--unplaced";      // invisible, no transition, until the cascade places it (P4)
    el.setAttribute("data-id", p.id);
    el.setAttribute("role", "article");
    el.tabIndex = -1;
    el.innerHTML =
      '<span class="card__glyph" aria-hidden="true"></span>' +
      '<div class="card__pill"></div>' +
      '<div class="card__body"></div>' +
      '<div class="card__editor"></div>' +
      '<button type="button" class="card__menu" aria-label="Prompt menu" tabindex="-1" aria-haspopup="menu">⋯</button>';
    var card = {
      id: p.id, prompt: p, el: el, body: el.querySelector(".card__body"), editorEl: el.querySelector(".card__editor"),
      glyphEl: el.querySelector(".card__glyph"), pillEl: el.querySelector(".card__pill"), menuBtn: el.querySelector(".card__menu"),
      height: estimateHeight(p.text, p, st.cardW), measured: false, placeholder: true, rendered: false, anchorY: 0, top: 0, positioned: false,
      pageIndex: promptPageIndex(p), lost: false, collapsed: false, answerOpen: null, temp: !!temp, hasImages: false
    };
    el.addEventListener("click", function (ev) {
      var t = ev.target;
      if (t && t.closest && t.closest(".card__menu")) { ev.stopPropagation(); openMenu(card); return; }
      if (t && t.closest && t.closest(".card__write")) { ev.stopPropagation(); openEditor({ promptId: card.id }); return; }
      if (t && t.closest && (t.closest("button, a, textarea, input, .menu, .editor"))) return;
      if (!card.temp) focus(card.id, { scroll: false });
    });
    el.addEventListener("mouseenter", function () { if (!card.temp) hoverCard(card.id); });
    el.addEventListener("mouseleave", function () { if (st.hot === card.id) hoverCard(null); });
    el.addEventListener("focus", function () { if (!card.temp && st.focused !== card.id) focus(card.id, { scroll: false, dom: false }); });
    return card;
  }
  function kindOf(p) { return parse(p.text).kind; }
  function applyCardClasses(card) {
    var p = card.prompt, parsed = card.temp ? null : parse(p.text), kind = parsed ? parsed.kind : "note";
    var cl = card.el.classList;
    ["card--qa", "card--cloze", "card--note", "card--highlight"].forEach(function (k) { cl.remove(k); });
    cl.add("card--" + kind);
    cl.toggle("card--flagged", !!p.flagged);
    cl.toggle("card--lost", !!card.lost);
    cl.toggle("card--temp", !!card.temp);
    cl.toggle("card--focused", st.focused === card.id);
    cl.toggle("card--hot", st.hot === card.id);
    cl.toggle("card--open", card.answerOpen === true);
    cl.toggle("card--closed", card.answerOpen === false);
    if (st.focused === card.id) card.el.setAttribute("aria-current", "true"); else card.el.removeAttribute("aria-current");
    card.el.tabIndex = st.focused === card.id ? 0 : -1;
    var glyphKind = GLYPHS[kind] ? kind : "note";
    if (card.glyphEl.getAttribute("data-kind") !== glyphKind) {     // redraw the icon only when the kind changes
      card.glyphEl.innerHTML = kindIconHtml(glyphKind);
      card.glyphEl.setAttribute("data-kind", glyphKind);
    }
    return parsed;
  }
  // What a rendered card shows of its record: the text (kind, question / answer, pill, tags, lint chip,
  // images) and the anchor's quote, `truncated` flag and lost state (highlight excerpt, chips). renderCard
  // records it; upsertCard diffs an incoming record against it, never against card.prompt, because
  // M.cache hands out and re-emits its live records, so a writer that edits one in place before saving it
  // (the prompt list's Edit does) sends prompt:saved with the very object the card already holds.
  function shownOf(p, lost) {
    var a = p && p.anchor;
    return { text: str(p && p.text), quote: str(a && a.quote), truncated: !!(a && a.truncated === true), lost: !!lost };
  }
  function showsRecord(card, p) {
    var s = card.shown, t = shownOf(p, card.lost);
    return !!s && s.text === t.text && s.quote === t.quote && s.truncated === t.truncated && s.lost === t.lost;
  }
  // Fill the body (markup) of a card; skipped while that card hosts the editor.
  function renderCard(card) {
    if (st.editing && st.editing.id === card.id) { applyCardClasses(card); return; }
    var p = card.prompt, parsed = applyCardClasses(card);
    if (card.temp) return;
    var html = "", kind = parsed.kind, P = M.prompts || dep("prompts");
    card.pillEl.textContent = kind === "highlight" ? excerpt(p.anchor && p.anchor.quote || "", PILL_CHARS) : excerpt(p.text, PILL_CHARS);
    if (kind === "qa") {
      html += '<div class="card__q">' + renderHtml(parsed.question, null, false) + "</div>";
      html += '<div class="card__a">' + renderHtml(parsed.answer, null, false) + "</div>";
    } else if (kind === "cloze") {
      html += '<div class="card__q card__q--cloze">' + renderHtml(parsed.display, null, true) + "</div>";   // deletions as .cloze-mark, no braces
    } else if (kind === "note") {
      html += '<div class="card__q card__q--note">' + renderHtml(parsed.display, null, false) + "</div>";
    } else {
      var quote = p.anchor && p.anchor.quote ? excerpt(p.anchor.quote, 80) : "";
      html += '<div class="card__q card__q--hl">' + escapeHtml(quote) + "</div>";
      html += '<button type="button" class="card__write btn btn--ghost" tabindex="-1">Write prompt</button>';
    }
    if (parsed.tags && parsed.tags.length) {
      html += '<div class="card__tags">' + parsed.tags.map(function (t) { return '<span class="chip">#' + escapeHtml(t) + "</span>"; }).join("") + "</div>";
    }
    var chips = [];
    if (card.lost) chips.push("Passage not found");
    if (p.anchor && p.anchor.truncated === true) chips.push("Selection shortened");
    var lints = parsed.lints && parsed.lints.length ? parsed.lints : null;
    if (!lints && P && typeof P.lint === "function") { try { lints = P.lint(parsed); } catch (e) { lints = null; } }
    if (lints && lints.length && lints[0].msg) chips.push(lints[0].msg);
    if (chips.length) html += '<div class="card__chips">' + chips.map(function (c) { return '<span class="card__chip">' + escapeHtml(c) + "</span>"; }).join("") + "</div>";
    card.body.innerHTML = html;
    card.shown = shownOf(p, card.lost);
    card.hasImages = !!(P && typeof P.imageIds === "function" && P.imageIds(p.text).length);
    card.rendered = true;
    card.renderedAt = Date.now();
    // An image that fails to decode changes no size (no ResizeObserver call), so its reservation is dropped here.
    var imgs = card.hasImages ? card.body.querySelectorAll("img.att") : [];
    for (var i = 0; i < imgs.length; i++) {
      if (imgs[i].complete || typeof imgs[i].addEventListener !== "function") continue;
      imgs[i].addEventListener("error", function () { if (st.cards.get(card.id) === card && !card.placeholder && measureNow([card])) scheduleLayout(); }, { once: true });
    }
  }
  // The height the cascade should use for a card that was just measured at `h`: while its images are still
  // arriving (an <img> not decoded yet, or the "Image missing" chips during the grace period after a render,
  // since the bytes load from IndexedDB and attachment:ready re-renders), 120 px — the most an image can
  // take (.att max-height) — is reserved per pending image on top of the measured text, so the cards below
  // never close up and then slide down over the image; they settle upwards, if at all, once it is decoded.
  function measuredHeight(c, h) {
    if (!c.hasImages) return h;
    var imgs = c.body.querySelectorAll("img.att"), pending = 0;
    for (var i = 0; i < imgs.length; i++) if (!imgs[i].complete) pending++;
    var chips = c.body.querySelectorAll(".att--missing").length;
    if (chips && Date.now() - (c.renderedAt || 0) < IMAGE_GRACE_MS) {
      pending += chips;
      if (!c.graceTimer) {
        c.graceTimer = setTimeout(function () {
          c.graceTimer = null;
          if (st.cards.get(c.id) !== c || c.placeholder || c.collapsed) return;
          var real = measuredHeight(c, Math.round(c.el.offsetHeight));
          if (real > 0 && real !== c.height) { c.height = real; scheduleLayout(); }
        }, IMAGE_GRACE_MS + 20);
      }
    }
    return pending ? h + ESTIMATE_IMAGE * pending : h;
  }
  function ensureRendered(card, deferMeasure) {
    var fresh = card.placeholder;
    if (card.placeholder) {
      card.placeholder = false;
      card.el.classList.remove("card--placeholder");
      card.el.style.minHeight = "";
      if (st.ro) { try { st.ro.observe(card.el); } catch (e) { /* ignore */ } }
    }
    if (!card.rendered) renderCard(card);
    if (fresh && !deferMeasure && st.readerMode === "wide" && measureNow([card])) scheduleLayout();
  }
  // Synchronous measurement of freshly rendered cards (the ResizeObserver confirms it a frame later);
  // → true when a height differs from the estimate the cascade used.
  function measureNow(cards) {
    var changed = false;
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i];
      if (c.placeholder || c.collapsed || !c.el.parentNode) continue;
      var h = c.el.offsetHeight;
      if (!(h > 0)) continue;
      h = measuredHeight(c, Math.round(h));
      if (h !== c.height) { c.height = h; changed = true; }
      c.measured = true;
    }
    return changed;
  }
  function makePlaceholder(card) {
    if (!card.placeholder && !card.temp && st.editing && st.editing.id === card.id) return;
    if (card.placeholder) return;
    card.placeholder = true;
    card.rendered = false;
    card.el.classList.add("card--placeholder");
    card.body.innerHTML = "";
    card.el.style.minHeight = (card.measured ? card.height : estimateHeight(card.prompt.text, card.prompt, st.cardW)) + "px";
    if (st.ro) { try { st.ro.unobserve(card.el); } catch (e) { /* ignore */ } }
  }
  // Off-screen cards are placeholders until within 100 % of the viewport (wide mode only). Cards that
  // become real here are measured in one batch (a single reflow); → true when a measured height differs
  // from the estimate the cascade used, so the caller re-runs the layout before the frame paints.
  function updatePlaceholders() {
    st.placeholdersQueued = false;
    if (!st.mounted || st.readerMode !== "wide" || !st.scrollEl) return false;
    var top = st.scrollEl.scrollTop, h = st.scrollEl.clientHeight || 800;
    var lo = top - h, hi = top + 2 * h, fresh = [];
    st.cards.forEach(function (c) {
      if (c.temp || (st.editing && st.editing.id === c.id)) return;
      var y = Math.min(c.top, c.anchorY), bottom = Math.max(c.top, c.anchorY) + c.height;
      var near = bottom >= lo && y <= hi;
      if (near) { if (c.placeholder) fresh.push(c); ensureRendered(c, true); } else makePlaceholder(c);
    });
    return fresh.length ? measureNow(fresh) : false;
  }
  function onPlaceholdersFrame() { if (updatePlaceholders()) runLayout(); }
  function schedulePlaceholders() {
    if (st.placeholdersQueued) return;
    st.placeholdersQueued = true;
    raf(onPlaceholdersFrame);
  }
  function onResize(entries) {
    var changed = false;
    for (var i = 0; i < entries.length; i++) {
      var el = entries[i].target;
      if (el === st.scrollEl) { updatePinned(); continue; }   // the scroller: its overflow may have changed
      var id = el.getAttribute("data-id"), c = st.cards.get(id);
      if (!c || c.placeholder) continue;
      var h = el.offsetHeight;
      if (!(h > 0)) continue;
      if (c.collapsed && !c.temp && h <= COLLAPSED_H + 1) continue;      // a pill's height is not the card's
      h = c.temp ? Math.round(h) : measuredHeight(c, Math.round(h));
      if (h !== c.height) { c.height = h; c.measured = true; changed = true; }
    }
    if (changed) scheduleLayout();
  }
  function removeCard(id) {
    var c = st.cards.get(id);
    if (!c) return;
    if (st.editing && st.editing.id === id) closeEditorDom({ saved: false, keepDraft: true });
    if (st.ro) { try { st.ro.unobserve(c.el); } catch (e) { /* ignore */ } }
    if (c.el.parentNode) c.el.parentNode.removeChild(c.el);
    st.cards.delete(id);
    st.items.delete(id);
    if (st.hot === id) st.hot = null;
    if (st.focused === id) st.focused = null;
    scheduleLayout();
  }
  function upsertCard(p) {
    var c = st.cards.get(p.id);
    if (c) {
      c.prompt = p;
      c.lost = isLost(p);
      if (c.placeholder) {
        // Nothing shown to refresh; until it is measured the estimate follows the record (ensureRendered
        // renders the current record when the card comes near the viewport).
        if (!c.measured) {
          c.height = estimateHeight(p.text, p, st.cardW);
          if (st.readerMode === "wide") c.el.style.minHeight = c.height + "px";
        }
        applyCardClasses(c);
      } else if (!c.rendered || !showsRecord(c, p)) renderCard(c);   // diffed against what is on screen (see shownOf)
      else applyCardClasses(c);                                        // flag / focus / hot / lost classes only
    } else {
      c = buildCard(p, false);
      st.cards.set(p.id, c);
      applyCardClasses(c);
      if (st.readerMode === "wide") { c.el.classList.add("card--placeholder"); c.el.style.minHeight = c.height + "px"; st.marginEl.appendChild(c.el); }
      if (st.focused === p.id) focus(p.id, { scroll: false });
    }
    st.items.set(p.id, p);
    scheduleLayout();
    return c;
  }

  // ---------------------------------------------------------------- layout driver
  function scheduleLayout() {
    if (!st.mounted || st.layoutQueued) return;
    st.layoutQueued = true;
    raf(runLayout);
  }
  function runLayout() {
    st.layoutQueued = false;
    if (!st.mounted) return;
    updatePinned();
    if (!st.pageTops.length) return;           // no page geometry yet: anchors would all sit at 0 (pages:measured re-schedules)
    refreshAnchors();
    if (st.readerMode === "rail") { renderRail(); return; }
    if (st.readerMode !== "wide") return;
    var activeId = currentActiveId();
    st.forcedActive = null;
    // Two passes at most: cards that leave the placeholder state in updatePlaceholders() are measured at
    // once, and when a measurement differs from its estimate the cascade is applied again before the frame
    // paints (SPEC §6: the estimate holds until measured, then the layout follows the measurement).
    for (var pass = 0; pass < 2; pass++) {
      applyCascade(activeId);
      updateConnector(activeId);
      if (!updatePlaceholders()) break;
    }
    revealPlaced();
  }
  // A card's first position is committed while .card--unplaced still disables its transition (one reflow
  // for the batch, after the last pass), so a new card appears in place instead of sliding from top: 0 or
  // from an estimate-based position over its neighbours; later moves animate as usual.
  function revealPlaced() {
    var fresh = [];
    st.cards.forEach(function (c) { if (!c.positioned && c.el.parentNode === st.marginEl) fresh.push(c); });
    if (!fresh.length) return;
    void st.marginEl.offsetHeight;
    for (var f = 0; f < fresh.length; f++) { fresh[f].positioned = true; fresh[f].el.classList.remove("card--unplaced"); }
  }
  function applyCascade(activeId) {
    var L = M.layout || dep("layout");
    var input = st.order.map(function (id) {
      var c = st.cards.get(id);
      return { id: id, anchorY: c.anchorY, height: c.height, collapsed: st.mode === "markers" && id !== activeId && !c.temp };
    });
    var out = [];
    if (L && typeof L.compute === "function") { try { out = L.compute(input, { activeId: activeId, gap: GAP, maxDrift: MAX_DRIFT, collapsedH: COLLAPSED_H }); } catch (e) { out = []; } }
    if (!out.length) { var prev = -Infinity; out = input.map(function (c) { var top = Math.max(c.anchorY, prev + GAP); prev = top + c.height; return { id: c.id, top: top, collapsed: false }; }); }
    for (var i = 0; i < out.length; i++) {
      var r = out[i], c = st.cards.get(r.id);
      if (!c) continue;
      c.top = r.top;
      var collapsed = !!r.collapsed && r.id !== activeId;
      c.collapsed = collapsed;
      c.el.style.top = Math.round(r.top) + "px";
      c.el.classList.toggle("card--collapsed", collapsed);
      c.el.setAttribute("aria-expanded", collapsed ? "false" : "true");
    }
  }
  function updateConnector(activeId) {
    var svg = st.connectorEl;
    if (!svg) return;
    var c = activeId ? st.cards.get(activeId) : null;
    if (!c || c.lost || c.placeholder || Math.abs(c.top - c.anchorY) < 1 || !hasRects(c.prompt.anchor)) { svg.classList.add("is-hidden"); return; }
    var x0 = highlightRightX(c), y0 = c.anchorY, x1 = CARD_LEFT, y1 = c.top + 1;
    if (x0 == null) x0 = -8;
    var top = Math.min(y0, y1), h = Math.abs(y1 - y0) + 1;
    svg.style.top = Math.round(top) + "px";
    svg.style.height = Math.ceil(h) + "px";
    svg.setAttribute("viewBox", "0 0 1 " + Math.ceil(h));
    var path = svg.firstChild;
    path.setAttribute("d", "M " + x0.toFixed(1) + " " + (y0 - top).toFixed(1) + " L " + x1 + " " + (y1 - top).toFixed(1));
    svg.classList.remove("is-hidden");
  }

  // ---------------------------------------------------------------- rail & stack
  function renderRail() {
    var rail = st.railEl;
    if (!rail) return;
    var entries = st.order.filter(function (id) { return !isTemp(id); }).map(function (id) { return { id: id, y: st.cards.get(id).anchorY }; });
    st.buckets = bucket(entries, BUCKET_PX);
    var frag = document.createDocumentFragment();
    for (var i = 0; i < st.buckets.length; i++) {
      var b = st.buckets[i], first = st.cards.get(b.ids[0]), kind = first ? kindOf(first.prompt) : "note";
      var m = document.createElement("button");
      m.type = "button";
      m.className = "marker marker--" + kind + (b.ids.indexOf(st.focused) >= 0 ? " marker--focused" : "");
      m.setAttribute("data-bucket", String(i));
      m.setAttribute("aria-label", b.ids.length === 1 ? "Prompt" : b.ids.length + " prompts");
      m.style.top = Math.round(b.y - COLLAPSED_H / 2) + "px";
      m.tabIndex = i === st.focusedMarker ? 0 : -1;
      m.innerHTML = '<span class="marker__glyph" aria-hidden="true">' + kindIconHtml(kind) + "</span>" +
        (b.ids.length > 1 ? '<span class="marker__count">' + b.ids.length + "</span>" : "");
      frag.appendChild(m);
    }
    rail.innerHTML = "";
    rail.appendChild(frag);
    if (st.popover && st.popover.el.parentNode !== st.marginEl) st.marginEl.appendChild(st.popover.el);
  }
  function bucketOf(id) {
    for (var i = 0; i < st.buckets.length; i++) if (st.buckets[i].ids.indexOf(id) >= 0) return i;
    return -1;
  }
  function markerEl(i) { return st.railEl ? st.railEl.querySelector('.marker[data-bucket="' + i + '"]') : null; }
  function focusMarker(i) {
    if (!st.buckets.length) return false;
    i = Math.max(0, Math.min(st.buckets.length - 1, i));
    st.focusedMarker = i;
    var all = st.railEl ? st.railEl.querySelectorAll(".marker") : [];
    for (var k = 0; k < all.length; k++) all[k].tabIndex = k === i ? 0 : -1;
    var m = markerEl(i);
    if (m) { try { m.focus({ preventScroll: true }); } catch (e) { m.focus(); } }
    return true;
  }
  function trapTab(container, ev) {
    if (ev.key !== "Tab") return;
    var sel = 'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
    var list = Array.prototype.filter.call(container.querySelectorAll(sel), function (el) { return el.offsetParent !== null || el === document.activeElement; });
    if (!list.length) { ev.preventDefault(); container.focus(); return; }
    var first = list[0], last = list[list.length - 1], active = document.activeElement;
    if (ev.shiftKey && (active === first || active === container)) { ev.preventDefault(); last.focus(); }
    else if (!ev.shiftKey && active === last) { ev.preventDefault(); first.focus(); }
  }
  function inTextField(ev) {
    var K = M.keys || dep("keys");
    if (K && typeof K.isTextTarget === "function") return K.isTextTarget(ev.target);
    var tag = ev.target && ev.target.tagName;
    return tag === "TEXTAREA" || tag === "INPUT";
  }
  // Rail mode: the bucket's cards in a .popover beside its marker. `temp` places a new editing card.
  function openPopover(bucketIndex, focusId, tempCard) {
    if (!st.marginEl) return null;
    var ids, y, invoker = null;
    if (tempCard) { ids = [tempCard.id]; y = tempCard.anchorY; }
    else {
      var b = st.buckets[bucketIndex];
      if (!b) return null;
      ids = b.ids; y = b.y; invoker = markerEl(bucketIndex);
    }
    if (st.popover && !tempCard && st.popover.bucket === bucketIndex) { if (focusId) focusCardEl(st.cards.get(focusId)); return st.popover; }
    closePopover({ keepEditor: !!tempCard });
    var pop = document.createElement("div");
    pop.className = "popover";
    pop.setAttribute("role", "dialog");
    pop.tabIndex = -1;
    pop.style.top = Math.round(Math.max(0, y - 8)) + "px";
    var inner = document.createElement("div");
    inner.className = "popover__cards";
    for (var i = 0; i < ids.length; i++) {
      var c = st.cards.get(ids[i]);
      if (!c) continue;
      c.el.style.top = "";
      c.el.classList.remove("card--collapsed", "card--placeholder", "card--unplaced");
      c.el.style.minHeight = "";
      c.placeholder = false;
      c.positioned = true;
      if (!c.rendered) renderCard(c);
      inner.appendChild(c.el);
    }
    pop.appendChild(inner);
    pop.addEventListener("keydown", function (ev) {
      trapTab(pop, ev);
      if (ev.key === "Escape" && !inTextField(ev) && !st.menu) { ev.preventDefault(); ev.stopPropagation(); closePopover(); }
    });
    st.marginEl.appendChild(pop);
    st.popover = { el: pop, bucket: tempCard ? -1 : bucketIndex, invoker: invoker, ids: ids.slice() };
    var m = invoker; if (m) m.classList.add("marker--open");
    if (focusId && st.cards.get(focusId)) focusCardEl(st.cards.get(focusId));
    return st.popover;
  }
  function closePopover(opts) {
    var pop = st.popover;
    if (!pop) return false;
    var keep = opts && opts.keepEditor;
    if (st.editing && !keep && pop.el.contains(st.editing.card.el)) closeEditorDom({ saved: false, keepDraft: true });
    st.popover = null;
    if (pop.el.parentNode) pop.el.parentNode.removeChild(pop.el);
    if (pop.invoker) { pop.invoker.classList.remove("marker--open"); if (!(opts && opts.noFocus)) { try { pop.invoker.focus({ preventScroll: true }); } catch (e) { /* ignore */ } } }
    else if (!(opts && opts.noFocus)) focusReader();
    return true;
  }
  function sheetParts() {
    var sheet = st.sheetEl;
    if (!sheet) return null;
    if (!sheet.querySelector(".sheet__body")) {
      sheet.innerHTML = '<div class="sheet__bar"><span class="sheet__title"></span><button type="button" class="btn btn--ghost sheet__close" aria-label="Close">✕</button></div><div class="sheet__body"></div>';
      sheet.setAttribute("role", "dialog");
      sheet.tabIndex = -1;
      sheet.querySelector(".sheet__close").addEventListener("click", function () { closeSheet(); });
      sheet.addEventListener("keydown", function (ev) {
        trapTab(sheet, ev);
        if (ev.key === "Escape" && !inTextField(ev) && !st.menu) { ev.preventDefault(); ev.stopPropagation(); closeSheet(); }
      });
    }
    return { sheet: sheet, title: sheet.querySelector(".sheet__title"), body: sheet.querySelector(".sheet__body") };
  }
  function openSheet(card, title) {
    var parts = sheetParts();
    if (!parts) return false;
    if (st.sheetOpen && st.editing && parts.body.contains(st.editing.card.el) && st.editing.card !== card) closeEditorDom({ saved: false, keepDraft: true });
    parts.title.textContent = title || "Prompt";
    while (parts.body.firstChild) parts.body.removeChild(parts.body.firstChild);
    card.el.style.top = "";
    card.el.classList.remove("card--collapsed", "card--placeholder", "card--unplaced");
    card.el.style.minHeight = "";
    card.placeholder = false;
    card.positioned = true;
    if (!card.rendered && !card.temp) renderCard(card);
    parts.body.appendChild(card.el);
    parts.sheet.classList.remove("is-hidden");
    st.sheetOpen = true;
    return true;
  }
  function closeSheet() {
    var parts = sheetParts();
    if (!parts || !st.sheetOpen) return false;
    if (st.editing && parts.body.contains(st.editing.card.el)) closeEditorDom({ saved: false, keepDraft: true });
    while (parts.body.firstChild) parts.body.removeChild(parts.body.firstChild);
    parts.sheet.classList.add("is-hidden");
    st.sheetOpen = false;
    focusReader();
    return true;
  }
  function applyReaderMode(mode) {
    if (mode !== "wide" && mode !== "rail" && mode !== "stack") return;
    if (mode === st.readerMode && st.marginEl.classList.contains("margin--" + mode)) return;
    closeMenu();
    if (st.editing) closeEditorDom({ saved: false, keepDraft: true });
    closePopover({ noFocus: true });
    if (st.sheetOpen) closeSheet();
    st.readerMode = mode;
    var el = st.marginEl;
    el.classList.remove("margin--wide", "margin--rail", "margin--stack");
    el.classList.add("margin--" + mode);
    while (el.firstChild) el.removeChild(el.firstChild);
    st.railEl = null;
    if (mode === "wide") {
      el.appendChild(st.connectorEl);
      st.cards.forEach(function (c) {
        c.el.style.top = Math.round(c.top) + "px";
        c.positioned = false;
        c.el.classList.add("card--unplaced");
        if (!c.rendered) { c.placeholder = false; makePlaceholder(c); }
        else if (st.ro) { try { st.ro.observe(c.el); } catch (e) { /* ignore */ } }
        el.appendChild(c.el);
      });
    } else {
      st.cards.forEach(function (c) { if (st.ro) { try { st.ro.unobserve(c.el); } catch (e) { /* ignore */ } } c.el.classList.remove("card--collapsed"); });
      if (mode === "rail") { st.railEl = document.createElement("div"); st.railEl.className = "rail"; el.appendChild(st.railEl); }
    }
    setMarginHeight();
    scheduleLayout();
  }
  // ---------------------------------------------------------------- focus & navigation
  function focusReader() {
    var r = document.getElementById("reader");
    if (r) { try { r.focus({ preventScroll: true }); } catch (e) { try { r.focus(); } catch (e2) { /* ignore */ } } }
    setOwner("reader");
  }
  function focusCardEl(card) {
    if (!card) return;
    try { card.el.focus({ preventScroll: true }); } catch (e) { try { card.el.focus(); } catch (e2) { /* ignore */ } }
  }
  // J / K and focus: the passage comes into view, vertically and, while a zoomed page scrolls under the pinned margin,
  // sideways (M.reader.scrollLeftFor: the anchor's first rect inside the page band beside the margin), in one scroll.
  function ensureAnchorVisible(card) {
    var s = st.scrollEl;
    if (!s) return;
    var h = s.clientHeight || 0, top = s.scrollTop, y = card.anchorY, to = null, left = null;
    if (y < top + 24 || y > top + h - 24) to = { top: Math.max(0, y - h / 3) };
    var R = M.reader, a = card.prompt ? card.prompt.anchor : null;
    if (a && !card.lost && R && typeof R.scrollLeftFor === "function") { try { left = R.scrollLeftFor(a); } catch (e) { left = null; } }
    if (isNum(left)) { to = to || {}; to.left = left; }
    if (!to) return;
    to.behavior = "smooth";
    try { s.scrollTo(to); } catch (e) { if (isNum(to.top)) s.scrollTop = to.top; if (isNum(to.left)) s.scrollLeft = to.left; }
  }
  function clearSelection() {
    try { var s = root.getSelection && root.getSelection(); if (s && s.removeAllRanges) s.removeAllRanges(); } catch (e) { /* ignore */ }
  }
  // The one focused card (SPEC §3 roving tabindex): st.focused is the single source of truth, and every
  // other card loses .card--focused, aria-current and its tab stop here, whatever path moved the focus
  // (focus(), J/K, openEditor / closeEditor, delete, a setItems re-render).
  function setFocused(id) {
    st.focused = id == null ? null : id;
    st.cards.forEach(function (c) {
      if (c.id === st.focused) return;
      if (c.el.classList.contains("card--focused")) c.el.classList.remove("card--focused");
      if (c.el.hasAttribute("aria-current")) c.el.removeAttribute("aria-current");
      if (c.el.tabIndex !== -1) c.el.tabIndex = -1;
    });
  }
  function focus(id, opts) {
    var card = liveCard(id);
    if (!card) return false;
    opts = opts || {};
    setFocused(id);
    if (st.readerMode === "wide") {
      ensureRendered(card);
      if (!card.positioned) runLayout();       // an unplaced card is invisible and cannot take the DOM focus
      applyCardClasses(card);
      if (opts.dom !== false) focusCardEl(card);
      if (opts.scroll !== false) ensureAnchorVisible(card);
    } else if (st.readerMode === "rail") {
      refreshAnchors();
      if (!st.buckets.length) renderRail();
      var bi = bucketOf(id);
      if (bi >= 0) st.focusedMarker = bi;
      applyCardClasses(card);
      if (bi >= 0) openPopover(bi, id); else focusCardEl(card);
      if (opts.scroll !== false) ensureAnchorVisible(card);
    } else {
      applyCardClasses(card);
      openSheet(card, "Prompt");
      if (opts.dom !== false) focusCardEl(card);
    }
    setOwner("card");
    emit("margin:focused", { promptId: id });
    scheduleLayout();
    return true;
  }
  function liveOrder() { return st.order.filter(function (id) { return !isTemp(id); }); }
  function visibleStartIndex(order, backwards) {
    var s = st.scrollEl, top = s ? s.scrollTop : 0, h = s ? (s.clientHeight || 0) : 0, i;
    if (backwards) { for (i = order.length - 1; i >= 0; i--) if (st.cards.get(order[i]).anchorY <= top + h) return i; return order.length - 1; }
    for (i = 0; i < order.length; i++) if (st.cards.get(order[i]).anchorY >= top) return i;
    return 0;
  }
  function step(delta) {
    refreshAnchors();
    var order = liveOrder();
    if (!order.length) return false;
    var i = st.focused ? order.indexOf(st.focused) : -1, target;
    if (i < 0) target = visibleStartIndex(order, delta < 0);
    else target = Math.max(0, Math.min(order.length - 1, i + delta));
    return focus(order[target], { scroll: true });
  }
  function next() { return step(1); }
  function prev() { return step(-1); }
  function setHotInternal(id) {
    if (id && !liveCard(id)) id = null;
    if (st.hot === id) return;
    var prev = st.hot;
    st.hot = id;
    if (prev) { var pc = st.cards.get(prev); if (pc) pc.el.classList.remove("card--hot"); }
    if (id) st.cards.get(id).el.classList.add("card--hot");
    scheduleLayout();
  }
  function hoverCard(id) { setHotInternal(id); emit("margin:hot", { promptId: id }); }
  function setHot(id) { setHotInternal(id == null ? null : id); }

  // ---------------------------------------------------------------- editor
  function openEditor(opts) {
    if (!st.mounted || !hasDom()) return null;
    opts = opts && typeof opts === "object" ? opts : {};
    var E = M.editor || dep("editor");
    if (!E || typeof E.create !== "function") return null;
    var promptId = opts.promptId == null ? null : opts.promptId;
    var p = promptId ? st.items.get(promptId) : null;
    if (promptId && !p) return null;
    // the O editor: "Save + Obsidian", the saved record is sent (BUILD-NOTES "Obsidian"); a plain editor while the
    // Obsidian connection is off (D32: a tab that brings an O editor back after the switch went off)
    var toObsidian = opts.obsidian === true && obsidianOn();
    // Split (FEATURES P2.2): the first editor remembers the text before this edit; its save opens the second editor.
    var splitText = !p ? null : (typeof opts.splitText === "string" ? opts.splitText : (opts.split === true ? str(p.text) : null));
    if (st.editing) closeEditorDom({ saved: false, keepDraft: true });
    closeMenu();
    var anchor = p ? (p.anchor || null) : (opts.anchor && typeof opts.anchor === "object" ? opts.anchor : null);
    var card, id;
    if (p) { card = st.cards.get(p.id); id = p.id; }
    else {
      id = TEMP_PREFIX + (typeof E.anchorHash === "function" ? E.anchorHash(anchor) : String(Date.now()));
      var temp = { id: id, text: "", anchor: anchor, createdAt: Date.now(), flagged: false,
        context: { pageIndex: anchor && isNum(anchor.pageIndex) ? anchor.pageIndex : pageIndexAtY(st.scrollEl ? st.scrollEl.scrollTop : 0) } };
      card = buildCard(temp, true);
      card.anchorY = computeAnchorY(temp);
      card.pageIndex = promptPageIndex(temp);
      st.cards.set(id, card);
      if (st.readerMode === "wide") { card.el.style.top = Math.round(card.anchorY) + "px"; st.marginEl.appendChild(card.el); }
    }
    if (st.readerMode === "wide") { ensureRendered(card); if (st.ro) { try { st.ro.observe(card.el); } catch (e) { /* ignore */ } } }
    card.positioned = true;                    // shown at once: its top is set before insertion, so nothing slides
    card.el.classList.remove("card--unplaced");
    card.el.classList.add("card--editing");
    card.el.classList.remove("card--collapsed");
    card.collapsed = false;                    // the active card never collapses (SPEC §6 pass B)
    card.body.innerHTML = "";                  // the static body stays hidden (.card--editing) and is
    card.rendered = false;                     // re-rendered from the saved text when the editor closes
    setFocused(p ? p.id : null);               // the edited card is the only focused one (none for a new card)
    applyCardClasses(card);
    st.marginEl.classList.add("margin--editing");
    var editor;
    try {
      editor = E.create({
        host: card.editorEl, prompt: p, anchor: anchor, batch: false, collectionId: st.collectionId || undefined,
        initialText: opts.initialText != null ? String(opts.initialText) : (p ? str(p.text) : ""),
        saveLabel: toObsidian ? "Save + Obsidian" : undefined,
        note: typeof opts.note === "string" ? opts.note : undefined,
        draftKey: typeof opts.draftKey === "string" ? opts.draftKey : undefined,
        keepDraft: opts.keepDraft === true,
        onSave: function (text, o) { return onEditorSave(text, o); },
        onCancel: function () { onEditorCancel(); }
      });
    } catch (e) {
      card.el.classList.remove("card--editing");
      st.marginEl.classList.remove("margin--editing");
      if (card.temp) removeCard(id); else renderCard(card);
      try { console.error("[margin] editor failed to open:", e); } catch (e2) { /* no console */ }
      return null;
    }
    st.editing = { id: id, promptId: p ? p.id : null, editor: editor, card: card, anchor: anchor, temp: !p, obsidian: toObsidian,
      splitText: splitText, note: typeof opts.note === "string" ? opts.note : null, draftKey: typeof opts.draftKey === "string" ? opts.draftKey : null,
      keepDraft: opts.keepDraft === true, initialText: opts.initialText != null ? String(opts.initialText) : null };
    card.el.classList.toggle("card--obsidian", toObsidian);   // marks the card while its editor is the O editor (a hook, no style)
    if (st.readerMode === "rail") {
      refreshAnchors();
      var bi = p ? bucketOf(p.id) : -1;
      if (bi >= 0) openPopover(bi, null); else openPopover(-1, null, card);
    } else if (st.readerMode === "stack") {
      openSheet(card, p ? "Edit prompt" : "New prompt");
    }
    setOwner("editor");
    emit("editor:opened", { promptId: p ? p.id : null, saved: false });
    scheduleLayout();
    editor.focus();
    if (opts.angles === true && typeof editor.openAngles === "function") { try { editor.openAngles(); } catch (e) { /* the editor keeps the focus */ } }
    return editor;
  }
  function closeEditorDom(opts) {
    var ed = st.editing;
    if (!ed) return;
    st.editing = null;
    var promptId = ed.promptId;
    try { ed.editor.destroy(); } catch (e) { /* ignore */ }
    ed.card.el.classList.remove("card--editing", "card--obsidian");
    st.marginEl.classList.remove("margin--editing");
    if (ed.temp) {
      if (st.ro) { try { st.ro.unobserve(ed.card.el); } catch (e) { /* ignore */ } }
      if (ed.card.el.parentNode) ed.card.el.parentNode.removeChild(ed.card.el);
      st.cards.delete(ed.id);
      if (st.popover && st.popover.bucket === -1) closePopover({ keepEditor: true, noFocus: true });
      if (st.sheetOpen && st.sheetEl && !st.sheetEl.querySelector(".card")) { var parts = sheetParts(); if (parts) { parts.sheet.classList.add("is-hidden"); st.sheetOpen = false; } }
    } else {
      ed.card.rendered = false;
      if (st.items.has(ed.id)) renderCard(ed.card);
    }
    emit("editor:closed", { promptId: promptId, saved: !!(opts && opts.saved) });
    scheduleLayout();
  }
  function afterEditorClose(id, isNew) {
    var c = id ? liveCard(id) : null;
    setFocused(c ? id : null);
    if (c) applyCardClasses(c);
    if (c && !isNew && st.readerMode === "wide") { focus(id, { scroll: false }); return; }
    if (c && st.readerMode === "rail" && st.popover && st.popover.el.contains(c.el)) { focusCardEl(c); setOwner("card"); return; }
    if (st.readerMode === "stack" && st.sheetOpen) { closeSheet(); return; }
    focusReader();
  }
  function buildRecord(p, text, anchor, now) {
    var parsed = parse(text), P = M.prompts || dep("prompts"), C = M.context || dep("context"), util = M.util || dep("util");
    var col = M.cache && typeof M.cache.collection === "function" ? M.cache.collection(st.collectionId) : null;
    var pi = anchor && isNum(anchor.pageIndex) ? anchor.pageIndex : (p && p.context && isNum(p.context.pageIndex) ? p.context.pageIndex : null);
    var label = pageLabelFor(pi), cards = [];
    if (P && typeof P.reconcileCards === "function") { try { cards = P.reconcileCards(p, parsed, now).cards; } catch (e) { cards = p && Array.isArray(p.cards) ? p.cards : []; } }
    var base = p ? p : {
      id: util && typeof util.uuid === "function" ? util.uuid("p_") : "p_" + now.toString(36) + Math.random().toString(36).slice(2, 8),
      collectionId: st.collectionId, flagged: false, anchor: anchor, createdAt: now, contentUpdatedAt: now, updatedAt: now, deletedAt: null, v: 1
    };
    var rec = Object.assign({}, base, { text: text, kind: parsed.kind, tags: parsed.tags || [], cards: cards });
    var fallbackCtx = p && p.context ? p.context : { docName: col && col.name ? col.name : "", sectionLabel: null, pageIndex: pi, pageLabel: label };
    if (C && typeof C.contextFor === "function") {
      try { rec.context = C.contextFor(col || { id: st.collectionId, kind: "book" }, rec, label); } catch (e) { rec.context = fallbackCtx; }
    } else rec.context = fallbackCtx;
    return rec;
  }
  // A passage to hang a highlight on: rects or a quote (a free note has neither, only a y).
  function hasPassage(anchor) {
    return !!(anchor && ((Array.isArray(anchor.pages) && anchor.pages.length) || str(anchor.quote).trim()));
  }
  function onEditorSave(text, o) {
    var ed = st.editing;
    if (!ed) return Promise.resolve(null);
    var another = !!(o && o.another), p = ed.promptId ? st.items.get(ed.promptId) : null, toObsidian = !!ed.obsidian;
    var splitText = p && typeof ed.splitText === "string" ? ed.splitText : null, edNote = ed.note, edDraftKey = ed.draftKey, edKeep = ed.keepDraft;
    var anchor = p ? (p.anchor || null) : ed.anchor, oldText = p ? str(p.text) : "";
    // A new free note with nothing in it would be stored as a highlight of no passage (and the O editor would then
    // fail to send it): nothing is saved or sent, the editor stays open and says why.
    if (!p && !hasPassage(anchor) && parse(text).kind === "highlight") {
      try {
        if (typeof ed.editor.hint === "function") ed.editor.hint(EMPTY_FREE_NOTE);
        ed.editor.focus();
      } catch (e) { /* the editor is gone */ }
      return Promise.resolve(null);
    }
    var rec = buildRecord(p, text, anchor, Date.now());
    if (p) ed.card.prompt = rec;               // the body re-renders from the saved text, not the old record
    closeEditorDom({ saved: true });
    var saved;
    try { saved = Promise.resolve(M.cache.savePrompt(rec, { content: true, step: true })); } catch (e) { saved = Promise.reject(e); }   // a step (M.undo, D33)
    return saved.then(function (sp) {
      var A = M.attachments;
      if (A && typeof A.gc === "function") { try { Promise.resolve(A.gc(oldText, text, { draftIds: [] })).then(null, function () {}); } catch (e) { /* ignore */ } }
      clearSelection();
      var id = sp && sp.id ? sp.id : rec.id;
      if (!st.cards.has(id) && sp && sp.collectionId === st.collectionId && !sp.deletedAt) upsertCard(sp);
      if (toObsidian) sendToObsidian(id);      // stored like any note first; Obsidian gets a copy (still the save's gesture)
      // Split, second half: a new prompt at the same passage holding the text from before the first edit. Nothing is
      // stored until it is saved; its Cancel drops it and leaves the first edit as it is.
      // FIXES-1 FIX-1: a stale "split:<id>" draft is dropped first (the editor shows the text from before THIS edit), and the
      // second editor keeps its text as that draft until its own Save or Cancel ("Finish split" brings it back).
      if (splitText !== null) {
        var E2 = M.editor || dep("editor");
        if (E2 && typeof E2.dropDraft === "function") E2.dropDraft(SPLIT_DRAFT_PREFIX + id);
        openEditor({ promptId: null, anchor: cloneAnchor(anchor), initialText: splitText, note: SPLIT_NOTE, draftKey: SPLIT_DRAFT_PREFIX + id, keepDraft: true });
        return sp;
      }
      if (another) { openEditor({ promptId: null, anchor: anchor, initialText: "Q. " }); return sp; }
      afterEditorClose(id, !p);
      return sp;
    }, function (err) {
      try { console.error("[margin] save failed:", err); } catch (e) { /* no console */ }
      if (p && st.cards.has(p.id)) st.cards.get(p.id).prompt = p;                     // back to the stored record
      openEditor({ promptId: p ? p.id : null, anchor: anchor, initialText: text, obsidian: toObsidian,   // keep the user's text
        splitText: splitText === null ? undefined : splitText, note: edNote || undefined, draftKey: edDraftKey || undefined, keepDraft: edKeep === true });
      throw err;
    });
  }
  // FIXES-1 FIX-1 c: the text of an unfinished split's second half ("split:<id>" draft), or null.
  function splitDraft(p) {
    var E = M.editor || dep("editor");
    if (!p || !SPLITTABLE[kindOf(p)] || !E || typeof E.draftText !== "function") return null;
    return E.draftText(SPLIT_DRAFT_PREFIX + p.id);
  }
  // "Finish split": the second editor again (a new prompt at the passage, the note line, the draft's text); the first
  // prompt is not edited again. An open editor closes first, so its latest text is the draft that is read.
  function finishSplit(p) {
    if (!p) return null;
    if (st.editing) closeEditorDom({ saved: false, keepDraft: true });
    var text = splitDraft(p);
    if (text === null) return null;
    return openEditor({ promptId: null, anchor: cloneAnchor(p.anchor || null), initialText: text, note: SPLIT_NOTE,
      draftKey: SPLIT_DRAFT_PREFIX + p.id, keepDraft: true });
  }
  // A copy of an anchor for a second record (a record's anchor may be changed in place, e.g. marked lost).
  function cloneAnchor(anchor) {
    if (!anchor || typeof anchor !== "object") return anchor || null;
    try { return JSON.parse(JSON.stringify(anchor)); } catch (e) { return Object.assign({}, anchor); }
  }
  // DECISIONS D32: Settings › Obsidian › "Connect Marginalia to Obsidian" (M.obsidian.enabled()). While it is off,
  // a card menu has no "Send to Obsidian" and the O editor is a plain editor. An M.obsidian without that switch counts as on.
  function obsidianOn() {
    var O = M.obsidian;
    if (!O) return false;
    if (typeof O.enabled !== "function") return true;
    try { return O.enabled() === true; } catch (e) { return false; }
  }
  // BUILD-NOTES "Obsidian": M.obsidian writes (or links) the copy and toasts the result itself.
  function sendToObsidian(id) {
    var O = M.obsidian;
    if (!O || typeof O.send !== "function") { toast("Obsidian is not available here"); return false; }
    try { Promise.resolve(O.send(id, { fromGesture: true })).then(null, function () {}); } catch (e) { return false; }
    return true;
  }
  function onEditorCancel() {
    var ed = st.editing;
    if (!ed) return;
    var id = ed.promptId;
    closeEditorDom({ saved: false });
    afterEditorClose(id, !id);
  }
  function closeEditor(opts) {
    var ed = st.editing;
    if (!ed) return false;
    return opts && opts.save ? ed.editor.run("save") : ed.editor.run("cancel");
  }
  function activeEditor() { return st.editing ? st.editing.editor : null; }

  // What openEditor() needs to open the editor that is open now once more (D30: a tab that leaves the screen and
  // comes back gets its editor back). null when no editor is open. The text is not in it: what the user typed is
  // the editor's draft (js/editor.js), and a draft wins when the editor opens again.
  function editing() {
    var ed = st.editing;
    if (!ed) return null;
    var o = { promptId: ed.promptId, anchor: ed.anchor || null };
    if (ed.initialText !== null) o.initialText = ed.initialText;
    if (ed.obsidian) o.obsidian = true;
    if (typeof ed.splitText === "string") o.splitText = ed.splitText;
    if (ed.note !== null) o.note = ed.note;
    if (ed.draftKey !== null) o.draftKey = ed.draftKey;
    if (ed.keepDraft) o.keepDraft = true;
    return o;
  }

  // ---------------------------------------------------------------- card menu
  function decks() {
    var C = M.cache;
    if (!C || typeof C.collections !== "function") return [];
    try { return C.collections().filter(function (c) { return c && c.kind === "deck" && !c.deletedAt; }); } catch (e) { return []; }
  }
  function keyCap(binding) {
    var K = M.keys || dep("keys");
    try { return K && typeof K.label === "function" ? (K.label(binding) || binding) : binding; } catch (e) { return binding; }
  }
  function closeMenu() {
    var m = st.menu;
    if (!m) return false;
    st.menu = null;
    if (st.menuOutside) { document.removeEventListener("mousedown", st.menuOutside, true); st.menuOutside = null; }
    if (m.el.parentNode) m.el.parentNode.removeChild(m.el);
    m.card.el.classList.remove("card--menu-open");
    if (m.restoreFocus !== false) focusCardEl(m.card);
    return true;
  }
  function menuItems(p, card) {
    var kind = kindOf(p), items = [];
    items.push({ act: "edit", label: kind === "highlight" ? "Write prompt" : "Edit", key: "e" });
    if (SPLITTABLE[kind]) items.push(splitDraft(p) !== null ? { act: "finishSplit", label: "Finish split" }   // FIXES-1 FIX-1 c
      : { act: "split", label: "Split" });                                          // FEATURES P2.2
    items.push({ act: "angle", label: "Another angle…" });                          // FEATURES P2.3, every kind
    items.push({ act: "delete", label: "Delete", key: "Backspace", danger: true });
    items.push({ act: "flag", label: p.flagged ? "Unflag" : "Flag", key: "f" });
    if (kind !== "highlight") {
      items.push({ act: "copyQ", label: "Copy question" });
      if (kind === "qa") items.push({ act: "copyA", label: "Copy answer" });
      items.push({ act: "copyQA", label: "Copy as Q./A. text" });
    }
    if (obsidianOn()) items.push({ act: "obsidian", label: p.obsidianSentAt ? "Update in Obsidian" : "Send to Obsidian" });   // every kind (D32)
    if (decks().length) items.push({ act: "move", label: "Move to…" });
    if (card.lost) items.push({ act: "reanchor", label: "Anchor to selection" });
    else items.push({ act: "goto", label: "Go to passage", key: "g" });
    return items;
  }
  function renderMenuList(menu, list, onPick) {
    menu.el.innerHTML = list.map(function (it, i) {
      return '<button type="button" class="menu__item' + (it.danger ? " menu__item--danger" : "") + '" role="menuitem" data-i="' + i + '" tabindex="-1">' +
        '<span>' + escapeHtml(it.label) + "</span>" + (it.key ? '<kbd class="kbd">' + escapeHtml(keyCap(it.key)) + "</kbd>" : "") + "</button>";
    }).join("");
    menu.list = list;
    menu.onPick = onPick;
    var first = menu.el.querySelector(".menu__item");
    if (first) first.focus();
  }
  function openMenu(card) {
    closeMenu();
    var p = st.items.get(card.id);
    if (!p) return;
    ensureRendered(card);
    var el = document.createElement("div");
    el.className = "menu";
    el.setAttribute("role", "menu");
    var menu = { el: el, card: card, list: [], onPick: null, restoreFocus: true };
    el.addEventListener("click", function (ev) {
      var b = ev.target && ev.target.closest ? ev.target.closest(".menu__item") : null;
      if (!b) return;
      ev.stopPropagation();
      var it = menu.list[+b.getAttribute("data-i")];
      if (it && menu.onPick) menu.onPick(it);
    });
    el.addEventListener("keydown", function (ev) {
      var items = el.querySelectorAll(".menu__item"), i = Array.prototype.indexOf.call(items, document.activeElement);
      if (!items.length) return;
      if (ev.key === "ArrowDown") { ev.preventDefault(); items[(i + 1) % items.length].focus(); }
      else if (ev.key === "ArrowUp") { ev.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
      else if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); closeMenu(); }
      else if (ev.key === "Tab") { ev.preventDefault(); closeMenu(); }
    });
    card.el.appendChild(el);
    card.el.classList.add("card--menu-open");
    st.menu = menu;
    st.menuOutside = function (ev) { if (!el.contains(ev.target)) { menu.restoreFocus = false; closeMenu(); } };
    document.addEventListener("mousedown", st.menuOutside, true);
    renderMenuList(menu, menuItems(p, card), function (it) { pickMenu(it, card, p); });
  }
  function pickMenu(it, card, p) {
    var menu = st.menu;
    if (it.act === "move" && menu) {
      var list = decks().map(function (d) { return { act: "moveTo", label: d.name || "Deck", deck: d }; });
      list.unshift({ act: "back", label: "← Back" });
      renderMenuList(menu, list, function (it2) {
        if (it2.act === "back") renderMenuList(menu, menuItems(p, card), function (it3) { pickMenu(it3, card, p); });
        else { closeMenu(); moveTo(p, it2.deck); }
      });
      return;
    }
    closeMenu();
    switch (it.act) {
      case "edit": openEditor({ promptId: p.id }); break;
      case "split": openEditor({ promptId: p.id, split: true }); break;
      case "finishSplit": finishSplit(p); break;
      case "angle": openEditor({ promptId: null, anchor: cloneAnchor(p.anchor || null), initialText: "Q. ", angles: true }); break;
      case "delete": deleteCard(p.id); break;
      case "flag": flag(p.id); break;
      case "copyQ": copyText(parse(p.text).question || plainText(p.text), card); break;
      case "copyA": copyText(parse(p.text).answer, card); break;
      case "copyQA": copyText(qaText(p), card); break;
      case "obsidian": sendToObsidian(p.id); break;
      case "goto": goToPassage(p.id); break;
      case "reanchor": anchorToSelection(p); break;
      default: break;
    }
  }

  // ---------------------------------------------------------------- actions
  function savePrompt(rec) {
    var C = M.cache;
    if (!C || typeof C.savePrompt !== "function") { var e = new Error("M.cache is not loaded"); e.code = "no_cache"; return Promise.reject(e); }
    try { return Promise.resolve(C.savePrompt(rec, { content: true, step: true })); } catch (err) { return Promise.reject(err); }   // flag, move, anchor: steps (D33)
  }
  function flag(id) {
    var p = st.items.get(id);
    if (!p) return false;
    savePrompt(Object.assign({}, p, { flagged: !p.flagged })).then(null, function () {});
    return true;
  }
  function toggleAnswer(id) {
    var c = liveCard(id);
    if (!c) return false;
    var visible = c.answerOpen === true || (c.answerOpen == null && !st.answersHidden);
    c.answerOpen = !visible;
    applyCardClasses(c);
    scheduleLayout();
    return true;
  }
  function goToPassage(id) {
    var p = st.items.get(id);
    if (!p) return false;
    var R = M.reader, V = M.pdfview;
    if (p.anchor && !isLost(p) && R && typeof R.goToAnchor === "function") { try { R.goToAnchor(p.anchor, { flash: true }); return true; } catch (e) { /* fall through */ } }
    if (V && typeof V.scrollTo === "function") { try { V.scrollTo({ pageIndex: promptPageIndex(p), fraction: 0 }); return true; } catch (e) { /* fall through */ } }
    var c = liveCard(id);
    if (c && st.scrollEl) { st.scrollEl.scrollTop = Math.max(0, c.anchorY - (st.scrollEl.clientHeight || 0) / 3); return true; }
    return false;
  }
  function deleteCard(id) {
    var p = st.items.get(id), C = M.cache;
    if (!p || !C || typeof C.removePrompt !== "function") return false;
    var order = liveOrder(), i = order.indexOf(id);
    var nextId = i >= 0 && i + 1 < order.length ? order[i + 1] : (i > 0 ? order[i - 1] : null);
    closeMenu();
    if (st.editing && st.editing.id === id) closeEditorDom({ saved: false, keepDraft: true });
    var done;
    st.deleting = id;                                      // prompt:deleted comes at once: this function moves the focus
    try { done = Promise.resolve(C.removePrompt(id, { step: true })); } catch (e) { done = Promise.reject(e); }
    st.deleting = null;
    done.then(null, function (err) { try { console.error("[margin] delete failed:", err); } catch (e) { /* no console */ } });
    removeCard(id);
    if (st.pendingUndo && st.pendingUndo.toast && typeof st.pendingUndo.toast.close === "function") { try { st.pendingUndo.toast.close(); } catch (e) { /* ignore */ } }
    var undo = function () { undoDelete(); };
    var t = toast({ id: "undo-delete", text: "Prompt deleted · Undo (Z)", ttl: UNDO_TTL, actions: [{ label: "Undo", run: undo, onClick: undo }] });
    st.pendingUndo = { id: id, until: Date.now() + UNDO_TTL, toast: t };
    if (nextId && liveCard(nextId)) focus(nextId, { scroll: false });
    else { setFocused(null); if (st.sheetOpen) closeSheet(); else if (st.popover && !st.popover.ids.some(function (x) { return st.cards.has(x); })) closePopover(); else focusReader(); }
    return true;
  }
  function undoDelete() {
    var u = st.pendingUndo;
    if (!u || Date.now() > u.until) { st.pendingUndo = null; return false; }
    st.pendingUndo = null;
    if (u.toast && typeof u.toast.close === "function") { try { u.toast.close(); } catch (e) { /* ignore */ } }
    var C = M.cache;
    if (!C || typeof C.restorePrompt !== "function") return false;
    var id = u.id, done;
    try { done = Promise.resolve(C.restorePrompt(id, { step: true })); } catch (e) { done = Promise.reject(e); }   // Z right after the delete: M.undo counts it as that step's undo
    done.then(function () {
      var p = typeof C.prompt === "function" ? C.prompt(id) : null;
      if (p && p.collectionId === st.collectionId && !p.deletedAt) { upsertCard(p); focus(id, { scroll: false }); }
    }, function (err) { try { console.error("[margin] undo failed:", err); } catch (e) { /* no console */ } });
    return true;
  }
  function moveTo(p, deck) {
    if (!deck) return;
    var pl = p.context && p.context.pageLabel ? p.context.pageLabel : String(promptPageIndex(p) + 1);
    var body = p.anchor && hasRects(p.anchor) ? "The highlight on p. " + pl + " is removed." : "The note leaves this book; its schedule is kept.";
    confirm({ title: "Move to “" + (deck.name || "deck") + "”?", body: body, ok: "Move", cancel: "Cancel", danger: false }).then(function (ok) {
      if (!ok) return;
      var C = M.context || dep("context"), rec = Object.assign({}, p, { collectionId: deck.id, anchor: null });
      var fallback = { docName: deck.name || "", sectionLabel: null, pageIndex: null, pageLabel: null };
      if (C && typeof C.contextFor === "function") { try { rec.context = C.contextFor(deck, rec, null); } catch (e) { rec.context = fallback; } }
      else rec.context = fallback;
      savePrompt(rec).then(function () { removeCard(p.id); toast("Moved to " + (deck.name || "deck")); focusReader(); }, function () {});
    });
  }
  function anchorToSelection(p) {
    var R = M.reader, a = R ? R.selection : null;
    if (!a || typeof a !== "object") { toast("Select the passage first, then choose “Anchor to selection”"); return false; }
    var C = M.context || dep("context"), col = M.cache && typeof M.cache.collection === "function" ? M.cache.collection(st.collectionId) : null;
    var rec = Object.assign({}, p, { anchor: Object.assign({}, a, { lost: false }) });
    if (C && typeof C.contextFor === "function") { try { rec.context = C.contextFor(col || { kind: "book" }, rec, pageLabelFor(a.pageIndex)); } catch (e) { /* keep */ } }
    savePrompt(rec).then(null, function () {});
    return true;
  }
  function copyText(text, card) {
    text = str(text);
    var ok = function () { toast("Copied"); };
    var fail = function () { fallbackCopy(text, card); };
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") navigator.clipboard.writeText(text).then(ok, fail);
      else fail();
    } catch (e) { fail(); }
  }
  function fallbackCopy(text, card) {
    var ta = document.createElement("textarea");
    ta.className = "margin__copybox";
    ta.readOnly = true;
    ta.value = text;
    ta.setAttribute("aria-label", "Text to copy");
    (card && card.el ? card.el : st.marginEl).appendChild(ta);
    ta.focus();
    ta.select();
    var copied = false;
    try { copied = !!(document.execCommand && document.execCommand("copy")); } catch (e) { copied = false; }
    if (copied) { if (ta.parentNode) ta.parentNode.removeChild(ta); toast("Copied"); focusCardEl(card); return; }
    toast("Press " + keyCap("Mod+c") + " to copy the selected text");
    ta.addEventListener("blur", function () { if (ta.parentNode) ta.parentNode.removeChild(ta); });
  }

  // ---------------------------------------------------------------- key actions
  function focusedLive() { return st.focused && liveCard(st.focused) ? st.focused : null; }
  // The DOM-focused element (the keydown target) when it is a control with an Enter activation of its own:
  // a toolbar / find-bar / sheet button, a card-menu item, an .hl-badge, a link, a form field or an ARIA
  // widget. A card (and anything outside a control, such as #reader) gives null.
  var CONTROL_TAGS = { BUTTON: true, INPUT: true, SELECT: true, TEXTAREA: true, SUMMARY: true, OPTION: true };
  var CONTROL_ROLES = { button: true, link: true, menuitem: true, menuitemcheckbox: true, menuitemradio: true, option: true,
    tab: true, checkbox: true, radio: true, "switch": true, treeitem: true, gridcell: true, combobox: true, textbox: true,
    searchbox: true, slider: true, spinbutton: true };
  function activeControl() {
    if (!hasDom()) return null;
    var n = document.activeElement;
    for (var depth = 0; n && n.nodeType === 1 && depth < 64; depth++, n = n.parentNode) {
      if (n.classList && typeof n.classList.contains === "function" && n.classList.contains("card")) return null;
      var tag = String(n.tagName || "").toUpperCase();
      if (CONTROL_TAGS[tag]) return n;
      if (tag === "A" && typeof n.hasAttribute === "function" && n.hasAttribute("href")) return n;
      var role = typeof n.getAttribute === "function" ? n.getAttribute("role") : null;
      if (role && CONTROL_ROLES[String(role).trim().toLowerCase()]) return n;
      if (n.isContentEditable === true) return n;
    }
    return null;
  }
  function escape() {
    if (!st.mounted) return false;
    if (closeMenu()) return true;
    if (st.popover) { closePopover(); return true; }
    if (st.sheetOpen) { closeSheet(); return true; }
    var active = document.activeElement;
    if (active && active.classList && active.classList.contains("card") && st.marginEl.contains(active)) { focusReader(); return true; }
    return false;
  }
  function run(id) {
    if (!st.mounted) return false;
    var f;
    switch (id) {
      case "next": return next();
      case "prev": return prev();
      case "edit": f = focusedLive(); return f ? !!openEditor({ promptId: f }) : false;
      // Enter (SPEC §3: "toggles the focused card's answer") is declined while a control has the DOM focus:
      // the card stays focused across Esc, a closed sheet or the menu, and returning true here would make
      // app.js preventDefault() the keydown and cancel that control's native click.
      case "toggleAnswer": f = focusedLive(); return f && !activeControl() ? toggleAnswer(f) : false;
      case "goToPassage": f = focusedLive(); return f ? goToPassage(f) : false;
      case "flag": f = focusedLive(); return f ? flag(f) : false;
      case "delete": f = focusedLive(); return f ? deleteCard(f) : false;
      case "undoDelete": return undoDelete();
      case "escape": return escape();
      default: return false;
    }
  }

  // ---------------------------------------------------------------- items, events, mount
  // A card goes because of a bus event (its prompt was deleted, or moved out of this book): by Cmd+Z or Shift+Cmd+Z
  // (DECISIONS D33), by the prompt list, by another window. If it holds the focus, the focus must not be left on
  // nothing: the reader takes it. The margin's own delete (deleteCard) moves the focus itself, to the next card.
  function dropCard(id) {
    var c = st.cards.get(id), held = false;
    if (st.deleting !== id) {
      try { held = !!(c && c.el && document.activeElement && (c.el === document.activeElement || c.el.contains(document.activeElement))); }
      catch (e) { held = false; }
    }
    removeCard(id);
    if (held) focusReader();
  }
  function onPromptSaved(payload) {
    var p = payload && payload.prompt;
    if (!p || !p.id) return;
    if (p.collectionId !== st.collectionId || p.deletedAt) { if (st.cards.has(p.id)) dropCard(p.id); return; }
    if (st.editing && st.editing.id === p.id) { st.items.set(p.id, p); st.cards.get(p.id).prompt = p; return; }
    upsertCard(p);
  }
  function requery() {
    var C = M.cache;
    if (st.collectionId == null || !C || typeof C.promptsOf !== "function") return;
    try { setItems(C.promptsOf(st.collectionId)); } catch (e) { /* ignore */ }
  }
  function setItems(prompts) {
    if (!st.mounted) return;
    var list = Array.isArray(prompts) ? prompts : [], keep = {};
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (!p || !p.id || p.deletedAt) continue;
      keep[p.id] = true;
      upsertCard(p);
    }
    Array.from(st.cards.keys()).forEach(function (id) { if (!keep[id] && !isTemp(id)) removeCard(id); });
    scheduleLayout();
  }
  function reset() {
    closeMenu();
    if (st.editing) closeEditorDom({ saved: false, keepDraft: true });
    closePopover({ noFocus: true });
    if (st.sheetOpen) closeSheet();
    Array.from(st.cards.keys()).forEach(removeCard);
    st.items = new Map();
    st.focused = null; st.hot = null; st.pendingUndo = null; st.buckets = [];
    st.pageTops = []; st.pageHeights = [];
    setMarginHeight();
    if (st.marginEl) st.marginEl.classList.remove("margin--pinned");
    st.pinned = false; st.scrollLeft = 0;
  }
  // A margin double-click creates a free note at that height. reader.js owns this gesture when it
  // provides createFreeNote (it listens on #margin itself); this is the fallback when it does not.
  function onDblclick(ev) {
    if (st.readerMode !== "wide") return;
    var R = M.reader;
    if (R && typeof R.createFreeNote === "function") return;
    var t = ev.target;
    if (t && t.closest && t.closest(".card, .menu, .popover")) return;
    var rect = st.marginEl.getBoundingClientRect(), y = ev.clientY - rect.top;
    var pi = pageIndexAtY(y), vp = viewportFn(pi), yPdf = 0;
    if (vp && typeof vp.convertToPdfPoint === "function") { try { yPdf = vp.convertToPdfPoint(0, y - (st.pageTops[pi] || 0))[1]; } catch (e) { yPdf = 0; } }
    var An = M.anchors, anchor = null;
    if (An && typeof An.fromMarginY === "function") { try { anchor = An.fromMarginY(pi, yPdf); } catch (e) { anchor = null; } }
    if (!anchor) anchor = { pageIndex: pi, pages: [], quote: "", prefix: "", suffix: "", items: null, y: yPdf, lost: false };
    openEditor({ promptId: null, anchor: anchor, initialText: "" });
  }
  function onMarginKeydown(ev) {
    if (st.readerMode !== "rail" || !st.railEl) return;
    var t = ev.target;
    if (!t || !t.classList || !t.classList.contains("marker")) return;
    var i = +t.getAttribute("data-bucket");
    if (ev.key === "ArrowDown") { ev.preventDefault(); ev.stopPropagation(); focusMarker(i + 1); }
    else if (ev.key === "ArrowUp") { ev.preventDefault(); ev.stopPropagation(); focusMarker(i - 1); }
    else if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); ev.stopPropagation(); var b = st.buckets[i]; if (b) openPopover(i, b.ids[0]); }
  }
  function onMarginClick(ev) {
    if (st.readerMode !== "rail") return;
    var m = ev.target && ev.target.closest ? ev.target.closest(".marker") : null;
    if (!m) return;
    var i = +m.getAttribute("data-bucket"), b = st.buckets[i];
    if (!b) return;
    st.focusedMarker = i;
    openPopover(i, b.ids[0]);
  }
  function subscribe() {
    var bus = M.bus || dep("bus");
    if (!bus || typeof bus.on !== "function") return;
    function on(type, fn) { st.offs.push(bus.on(type, fn)); }
    on("doc:opened", function (pl) { if (pl && pl.collectionId != null) st.collectionId = pl.collectionId; refreshGeometry(); requery(); });
    on("doc:closed", function () { reset(); st.collectionId = null; });
    on("pages:measured", function (pl) {
      if (pl && Array.isArray(pl.pageTops)) st.pageTops = pl.pageTops;
      if (pl && Array.isArray(pl.pageHeights)) st.pageHeights = pl.pageHeights;
      setMarginHeight();
      scheduleLayout();
    });
    // At once, not in the next frame: a scale change made inside a rAF (pinch zoom) or a ResizeObserver
    // callback (a breakpoint refit) would otherwise paint one frame of pages without their cards in step.
    on("scale:changed", function () { refreshGeometry(); runLayout(); });
    on("page:rendered", schedulePlaceholders);
    on("page:evicted", schedulePlaceholders);
    on("prompt:saved", onPromptSaved);
    on("prompt:deleted", function (pl) { if (pl && st.cards.has(pl.promptId)) dropCard(pl.promptId); });
    on("prompt:restored", function (pl) {
      // the deleted prompt is back by another way than this notice's Undo or Z (Cmd+Z, DECISIONS D33): the offer and
      // its "Prompt deleted · Undo (Z)" notice go
      var u = st.pendingUndo;
      if (u && pl && u.id === pl.promptId) {
        st.pendingUndo = null;
        if (u.toast && typeof u.toast.close === "function") { try { u.toast.close(); } catch (e) { /* ignore */ } }
      }
      var C = M.cache, p = pl && C && typeof C.prompt === "function" ? C.prompt(pl.promptId) : null;
      if (p && p.collectionId === st.collectionId && !p.deletedAt) upsertCard(p);
    });
    on("attachment:ready", function () { st.cards.forEach(function (c) { if (c.hasImages && c.rendered) renderCard(c); }); scheduleLayout(); });
    on("settings:changed", function (pl) {
      if (!pl) return;
      if (pl.key === "marginAnswers") setAnswersHidden(pl.value === false);
      else if (pl.key === "marginMode") setMode(pl.value);
    });
    // {mode, compact}: a mode change rebuilds the margin; a card-width change (compact on / off) re-measures
    // and re-runs the cascade before the frame paints (the reader emits this from its ResizeObserver callback)
    on("reader:mode", function (pl) {
      applyReaderMode(typeof pl === "string" ? pl : (pl && pl.mode));
      if (syncCardWidth() && st.readerMode === "wide") runLayout();
      updatePinned();
    });
  }
  function mount(scrollEl, marginEl) {
    if (!hasDom()) return;
    st.scrollEl = scrollEl || document.getElementById("scroller");
    st.marginEl = marginEl || document.getElementById("margin");
    st.sheetEl = document.getElementById("sheet");
    if (!st.marginEl) return;
    if (st.mounted) { setMarginHeight(); scheduleLayout(); return; }
    st.mounted = true;
    st.marginEl.classList.add("margin");
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "connector is-hidden");
    svg.setAttribute("aria-hidden", "true");
    svg.appendChild(document.createElementNS("http://www.w3.org/2000/svg", "path"));
    st.connectorEl = svg;
    var S = M.settings || dep("settings");
    try {
      if (S && typeof S.get === "function") { st.answersHidden = S.get("marginAnswers") === false; st.mode = S.get("marginMode") === "markers" ? "markers" : "cards"; }
    } catch (e) { /* defaults */ }
    st.marginEl.classList.toggle("margin--no-answers", st.answersHidden);
    st.marginEl.classList.toggle("margin--markers", st.mode === "markers");
    if (typeof ResizeObserver === "function") { try { st.ro = new ResizeObserver(onResize); } catch (e) { st.ro = null; } }
    if (st.ro && st.scrollEl) { try { st.ro.observe(st.scrollEl); } catch (e) { /* ignore */ } }   // → updatePinned
    st.marginEl.addEventListener("dblclick", onDblclick);
    st.marginEl.addEventListener("keydown", onMarginKeydown);
    st.marginEl.addEventListener("click", onMarginClick);
    if (st.scrollEl) st.scrollEl.addEventListener("scroll", onScrollerScroll, { passive: true });
    subscribe();
    var mode = "wide";
    try { if (M.reader && typeof M.reader.mode === "function") mode = M.reader.mode() || "wide"; } catch (e) { mode = "wide"; }
    st.readerMode = null;
    st.cardW = readCardWidth();
    applyReaderMode(mode === "rail" || mode === "stack" ? mode : "wide");
    refreshGeometry();
  }
  function setMode(mode) {
    st.mode = mode === "markers" ? "markers" : "cards";
    if (st.marginEl) st.marginEl.classList.toggle("margin--markers", st.mode === "markers");
    scheduleLayout();
  }
  function setAnswersHidden(b) {
    st.answersHidden = !!b;
    if (st.marginEl) st.marginEl.classList.toggle("margin--no-answers", st.answersHidden);
    scheduleLayout();
  }
  function layout(opts) {
    st.forcedActive = opts && opts.activeId != null ? opts.activeId : null;
    scheduleLayout();
  }

  var api = {
    mount: mount, setItems: setItems, layout: layout, focus: focus, next: next, prev: prev, setMode: setMode,
    openEditor: openEditor, closeEditor: closeEditor, activeEditor: activeEditor, editing: editing, setAnswersHidden: setAnswersHidden,
    run: run, escape: escape, closePopover: function () { return closePopover(); }, focusedId: focusedLive, setHot: setHot,
    // extensions
    mode: function () { return st.mode; }, readerMode: function () { return st.readerMode; },
    isMounted: function () { return st.mounted; }, bucket: bucket, sortIds: sortIds, estimateHeight: estimateHeight,
    cardWidth: function () { return st.cardW; }, isPinned: function () { return st.pinned; },
    BUCKET_PX: BUCKET_PX, GAP: GAP, MAX_DRIFT: MAX_DRIFT, COLLAPSED_H: COLLAPSED_H, CARD_W: CARD_W
  };
  M.margin = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

/* SELF-CHECK (SPEC §17.2 M.margin + BUILD-NOTES "Key routing" extras):
 *   mount(scrollEl, marginEl); setItems(prompts); layout({activeId}); focus(id); next(); prev();
 *   setMode("cards"|"markers"); openEditor({promptId|null, anchor, initialText}) → Editor|null; closeEditor({save});
 *   activeEditor() → Editor|null; editing() → the options that open the open editor again ({promptId, anchor,
 *   initialText?, obsidian?, splitText?, note?, draftKey?, keepDraft?}; null without one; D30, js/tabs.js);
 *   setAnswersHidden(b); run(id) → boolean (next, prev, edit, toggleAnswer,
 *   goToPassage, flag, delete, undoDelete, escape); escape() → boolean; closePopover() → boolean;
 *   focusedId() → id|null; setHot(id|null).
 *   Extensions: mode(), readerMode(), isMounted(), bucket(entries, px), sortIds(entries),
 *   estimateHeight(text, prompt?, cardWidth? = 256) (38 · cardWidth / 256 characters per line), cardWidth(), isPinned(),
 *   BUCKET_PX, GAP, MAX_DRIFT, COLLAPSED_H, CARD_W. Emits margin:hot {promptId|null} and margin:focused {promptId}
 *   (new events) besides editor:opened / editor:closed; listens to reader:mode {mode, compact} (card width from
 *   --card-w, re-measure of the rendered cards and of the open editor's card + cascade at once), scale:changed
 *   (cascade at once) and attachment:ready. Toggles .margin--pinned on #margin while the sticky margin overlaps a
 *   page wider than the room beside it; J / K bring the passage into the band beside it (M.reader.scrollLeftFor).
 *   BUILD-NOTES "Obsidian": openEditor also takes obsidian: true (Save + Obsidian, then M.obsidian.send); the card menu
 *   has "Send to Obsidian" / "Update in Obsidian" (act "obsidian") after the copy items. A blank new free note's save
 *   stores nothing and keeps the editor open with Editor.hint("Type a note first").
 *   FEATURES P2.2 / P2.3: the card menu has "Split" (act "split", Q./A. and cloze) and "Another angle…" (act "angle",
 *   every kind) right after Edit. openEditor also takes split: true (the second editor of a split opens after its
 *   save), angles: true (Editor.openAngles() once open), note, draftKey and keepDraft (passed to M.editor.create).
 *   FIXES-1 FIX-1: "Finish split" (act "finishSplit") replaces "Split" while M.editor.draftText("split:<id>") is not null.
 *   FEATURES P2.4: every editor it opens gets collectionId (the open book), so the editor's look-alike line searches it.
 */
