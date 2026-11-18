/* js/reader.js — M.reader: the reader screen.
 * SPEC §2 (layout, toolbar, zoom, breakpoints), §3 (select → create, adder, focus, Escape chain),
 * §5 (highlight drawing, re-finding, hit-testing), §11 (scanned chip, engine messages),
 * §14 (Shift+C chapter marks), §15 (document-level Cmd+V free notes), §17.2 + BUILD-NOTES extras
 * (run(id), escape(), reader:mode). Nothing is bound to keys here: M.app dispatches and calls run(id).
 * BUILD-NOTES "Post-review decisions" (binding over SPEC §2): wide ≥ 680 (compact margin below 1000, class
 * .reader--compact), rail 600–679, stack < 600; the toolbar hides items in a fixed order when it is short of
 * room (fitToolbar); trackpad pinch zooms the PDF (ctrl+wheel in Chrome / Brave, gesture events in Safari);
 * Cmd/Ctrl+0 while already at fit width is left to the browser (it resets the browser zoom); find, G and Go to
 * source land beside the pinned margin, never under it (revealLeft); stack clamps to the fit computed now.
 * BUILD-NOTES "Obsidian": while the Obsidian connection is on (M.obsidian.enabled(), DECISIONS D32; off: no such button,
 * and O does nothing), the adder's fourth action "Note → Obsidian" and run("obsidianNote") (O) open the margin
 * editor on the selection with empty text in its "Save + Obsidian" form (M.margin.openEditor({obsidian: true}));
 * without a selection O makes a free note at the middle of the visible page, like N. open(id, {promptId}) for a
 * prompt that is deleted, unknown or in another collection (a stale "Open in Marginalia" link) toasts "That note is
 * no longer in this book" and keeps the reader where it is; only a fresh open falls back to the last position.
 */
(function (root) {
  "use strict";
  var M = root.Marginalia = root.Marginalia || {};
  function dep(name) { return M[name] || (typeof require === "function" ? require("./" + name + ".js") : undefined); }

  var ZOOM_LADDER = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 1.6667, 2, 3, 4];
  var PDFJS_CSS_UNITS = 1.3333;          // PDF.js: Letter is 816 px at "100%"
  var MODE_WIDE = 680, MODE_RAIL = 600;  // container widths measured on #reader (BUILD-NOTES "Post-review decisions")
  var COMPACT_BELOW = 1000;              // wide below this width: .reader--compact (224-px margin, 192-px cards)
  var TB_FIT_LEVELS = 3;                 // toolbar fit levels (fitToolbar, css/reader.css .tb--fit-N)
  var PINCH_K = 0.01;                    // ctrl+wheel pinch: scale factor exp(−deltaY · 0.01)
  var PINCH_MAX_DELTA = 50;              // |deltaY| cap per event: a ctrl+mouse-wheel notch (±100) zooms 1.65×, not 2.7×
  var REVEAL_PAD = 24;                   // navigation targets stay this far inside the page band beside the margin
  var PULSE_MS = 1200;
  var CHIP_MS = 10000;
  var SELECTION_DEBOUNCE_MS = 50;
  var FIND_DEBOUNCE_MS = 150;
  var ASCENT = 0.8, DESCENT = -0.2;      // item box defaults of SPEC §5

  var st = null;         // per-document state (null while no book is open)
  var dom = null;        // the reader's own DOM, built once
  var busOffs = [];      // bus unsubscribers of the open document
  var openSeq = 0;       // guards awaits in open() against a close() in between
  var lastRemaining = null; // last review:suspended payload.remaining

  // ---------- small helpers ----------
  function noop() {}
  function util() { return M.util || dep("util") || {}; }
  function esc(s) {
    var u = util();
    s = s == null ? "" : String(s);
    if (typeof u.escapeHtml === "function") return u.escapeHtml(s);
    return s.replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[ch];
    });
  }
  function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }
  function mkErr(code, msg) { var e = new Error(msg || code); e.code = code; return e; }
  function tryCall(fn, dflt) { try { return fn(); } catch (e) { return dflt; } }
  function emit(type, payload) { if (M.bus && M.bus.emit) { try { M.bus.emit(type, payload); } catch (e) {} } }
  function sub(type, fn) {
    if (!M.bus || !M.bus.on) return;
    var off = M.bus.on(type, fn);
    busOffs.push(typeof off === "function" ? off : function () { M.bus.off(type, fn); });
  }
  function unsubAll() { var list = busOffs.splice(0); for (var i = 0; i < list.length; i++) tryCall(list[i]); }
  function listen(target, type, fn, opts) {
    target.addEventListener(type, fn, opts || false);
    var rec = { target: target, type: type, fn: fn, opts: opts || false };
    if (st) st.listeners.push(rec);
    return rec;
  }
  function unlisten(rec) { tryCall(function () { rec.target.removeEventListener(rec.type, rec.fn, rec.opts); }); }
  function toast(text, actions, ttl) {
    if (M.app && typeof M.app.toast === "function") {
      try { return M.app.toast({ text: text, actions: actions || [], ttl: ttl || 6000 }); } catch (e) {}
    }
    return { close: noop };
  }
  function setting(key, dflt) {
    var v;
    try { v = M.settings && M.settings.get ? M.settings.get(key) : undefined; } catch (e) { v = undefined; }
    return v === undefined ? dflt : v;
  }
  function setSetting(key, value) { try { if (M.settings && M.settings.set) M.settings.set(key, value); } catch (e) {} }
  function cssEscape(s) {
    s = String(s);
    if (typeof CSS !== "undefined" && CSS && typeof CSS.escape === "function") return CSS.escape(s);
    return s.replace(/["\\\]\[]/g, "\\$&");
  }
  function isTextField(node) {
    if (!node || node.nodeType !== 1) return false;
    var tag = node.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || node.isContentEditable === true;
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function button(cls, text, title, onClick) {
    var b = el("button", cls, text);
    b.type = "button";
    if (title) { b.title = title; b.setAttribute("aria-label", title); }
    if (onClick) b.addEventListener("click", onClick);
    return b;
  }
  function kbd(text) { var k = el("kbd", "kbd adder__key", text); return k; }
  function raf(fn) { return (typeof requestAnimationFrame === "function") ? requestAnimationFrame(fn) : setTimeout(fn, 16); }
  function caf(id) { if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(id); else clearTimeout(id); }

  function numPages() { return st && st.doc && st.doc.numPages ? st.doc.numPages : 0; }
  function pageLabelOf(i) {
    var labels = st && st.doc ? st.doc.pageLabels : null;
    return (Array.isArray(labels) && labels[i] != null && labels[i] !== "") ? String(labels[i]) : String(i + 1);
  }
  function collection() { return st ? (tryCall(function () { return M.cache.collection(st.id); }) || st.c) : null; }
  function livePrompts() {
    if (!st) return [];
    var list = tryCall(function () { return M.cache.promptsOf(st.id); }) || [];
    var out = [];
    for (var i = 0; i < list.length; i++) if (list[i] && !list[i].deletedAt) out.push(list[i]);
    return out;
  }
  function pageViewFn(i) { return M.pdfview.pageView(i); }
  function viewportOf(i) {
    var v = tryCall(function () { return M.pdfview.pageView(i); });
    if (v && v.viewport) return v.viewport;
    return tryCall(function () { return M.pdfview.viewport(i); }) || null;
  }
  function renderedPages() { return tryCall(function () { return M.pdfview.renderedPages(); }) || []; }

  // ---------- page geometry (scroller content space) ----------
  // pageTops() is taken relative to the scroll content; a rendered page calibrates any constant offset.
  function pageTopsCal() {
    var tops = tryCall(function () { return M.pdfview.pageTops(); }) || [];
    var heights = tryCall(function () { return M.pdfview.pageHeights(); }) || [];
    var delta = 0, rp = renderedPages();
    for (var k = 0; k < rp.length; k++) {
      var v = tryCall(function () { return M.pdfview.pageView(rp[k]); });
      if (v && v.el && typeof tops[rp[k]] === "number") {
        var domTop = v.el.getBoundingClientRect().top - dom.scroller.getBoundingClientRect().top + dom.scroller.scrollTop;
        delta = domTop - tops[rp[k]];
        break;
      }
    }
    return { tops: tops, heights: heights, delta: delta };
  }
  function pageTopDoc(i) { var c = pageTopsCal(); return (typeof c.tops[i] === "number" ? c.tops[i] : 0) + c.delta; }
  function pageAtDocY(y) {
    var c = pageTopsCal(), n = numPages();
    if (!c.tops.length || !n) return 0;
    var lo = 0, hi = Math.min(n, c.tops.length) - 1;
    while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (c.tops[mid] + c.delta <= y) lo = mid; else hi = mid - 1; }
    return clamp(lo, 0, n - 1);
  }
  function currentPage() {
    if (!st) return 0;
    var sc = dom.scroller;
    return pageAtDocY(sc.scrollTop + Math.min(sc.clientHeight / 3, 200));
  }
  function visibleMiddle() {
    var sc = dom.scroller, yDoc = sc.scrollTop + sc.clientHeight / 2;
    var i = pageAtDocY(yDoc), vp = viewportOf(i), yPdf = 0;
    if (vp) {
      var yLocal = clamp(yDoc - pageTopDoc(i), 0, vp.height || 0);
      yPdf = tryCall(function () { return vp.convertToPdfPoint(0, yLocal)[1]; }, 0);
    }
    return { pageIndex: i, yPdf: yPdf };
  }
  // scrolls so the PDF-space y of page i sits at `fraction` of the viewport height (default one third) and, given a
  // PDF-space rect [x1, y1, x2, y2] (a highlight's or a find match's first rect), sideways so that rect lies inside
  // the page band beside the margin (rectScrollLeft): a zoomed page scrolls under the sticky margin.
  function scrollToPdfY(i, yPdf, fraction, rect) {
    var sc = dom.scroller, vp = viewportOf(i);
    if (!vp) { tryCall(function () { M.pdfview.scrollTo({ pageIndex: i, fraction: 0 }); }); return false; }
    var yPx = 0, xPdf = rect ? rect[0] : 0;
    if (typeof yPdf === "number" && isFinite(yPdf)) {
      var pt = tryCall(function () { return vp.convertToViewportPoint(xPdf, yPdf); });
      if (pt) yPx = pt[1];
    }
    var target = pageTopDoc(i) + yPx - sc.clientHeight * (typeof fraction === "number" ? fraction : 1 / 3);
    sc.scrollTop = Math.max(0, Math.round(target));
    var left = rectScrollLeft(i, rect, vp);
    if (left != null) sc.scrollLeft = left;
    return true;
  }
  // ---------- the page band beside the margin (BUILD-NOTES "Post-review decisions": the pinned margin) ----------
  // #margin is sticky at the scroller's right edge, so in wide and rail mode it covers the right margin-width px of
  // the scroller whether the page fits or scrolls under it. What a reader sees of the page is the band
  // [scrollLeft + pad, scrollLeft + clientWidth − cover − pad] (scroll-content x). o = {scrollLeft, clientWidth,
  // scrollWidth, cover, x1, x2, pad} → the scrollLeft that puts [x1, x2] about a third into the band (its start,
  // when it is wider than the band), clamped to [0, scrollWidth − clientWidth]; null when [x1, x2] is inside the
  // band already or the row does not scroll sideways.
  function revealLeft(o) {
    var cw = Number(o.clientWidth) || 0, sl = Number(o.scrollLeft) || 0;
    var max = Math.max(0, (Number(o.scrollWidth) || 0) - cw);
    var x1 = Math.min(Number(o.x1), Number(o.x2)), x2 = Math.max(Number(o.x1), Number(o.x2));
    if (!(max > 0.5) || !isFinite(x1) || !isFinite(x2)) return null;
    var pad = o.pad == null ? REVEAL_PAD : Math.max(0, Number(o.pad) || 0), cover = Math.max(0, Number(o.cover) || 0);
    var lo = pad, hi = cw - cover - pad;
    if (hi - lo < 2 * pad) { lo = 0; hi = Math.max(1, cw - cover); }   // only a sliver left beside the margin: use it all
    if (x1 >= sl + lo && x2 <= sl + hi) return null;
    var band = hi - lo;
    var t = x2 - x1 <= band ? Math.max(x1 - lo - band / 3, x2 - hi) : x1 - lo;
    t = clamp(Math.round(t), 0, max);
    return Math.abs(t - sl) < 1 ? null : t;
  }
  // Page i's left edge in scroll-content x: its element when rendered, else its place in the centred column.
  function pageLeftX(i, vp) {
    var sc = dom.scroller, base = sc.scrollLeft - sc.getBoundingClientRect().left - (sc.clientLeft || 0);
    var v = tryCall(function () { return M.pdfview.pageView(i); });
    if (v && v.el) return v.el.getBoundingClientRect().left + base;
    var pr = dom.pages.getBoundingClientRect(), w = vp && vp.width > 0 ? vp.width : pr.width;
    return pr.left + Math.max(0, (pr.width - w) / 2) + base;
  }
  // The scrollLeft that brings a PDF-space rect of page i into the page band (revealLeft), or null. Stack mode never
  // scrolls sideways (overflow-x: hidden there, so a reader could not scroll back).
  function rectScrollLeft(i, rect, vp) {
    if (!st || !dom || !rect || st.mode === "stack") return null;
    var sc = dom.scroller;
    if (!(sc.scrollWidth > sc.clientWidth + 0.5)) return null;
    vp = vp || viewportOf(i);
    var vr = vp ? tryCall(function () { return vp.convertToViewportRectangle(rect); }) : null;
    if (!vr) return null;
    var left = pageLeftX(i, vp), cover = dom.margin ? (dom.margin.offsetWidth || 0) : 0;
    return revealLeft({ scrollLeft: sc.scrollLeft, clientWidth: sc.clientWidth, scrollWidth: sc.scrollWidth, cover: cover,
      x1: left + Math.min(vr[0], vr[2]), x2: left + Math.max(vr[0], vr[2]), pad: REVEAL_PAD });
  }
  // An anchor's first highlight rect on its own page (normalised), or null (a free note has none).
  function firstRect(anchor, i) {
    var pages = anchor && Array.isArray(anchor.pages) ? anchor.pages : [];
    for (var k = 0; k < pages.length; k++) {
      if (!pages[k] || pages[k].pageIndex !== i) continue;
      var rects = Array.isArray(pages[k].rects) ? pages[k].rects.map(normRect).filter(Boolean) : [];
      return rects.length ? rects[0] : null;
    }
    return null;
  }
  // Extension (BUILD-NOTES): the scrollLeft that brings an anchor's first rect into the page band beside the margin,
  // or null (in view already, nothing scrolls sideways, no rects, stack mode). margin.js scrolls J / K with it.
  function scrollLeftFor(anchor) {
    if (!st || !dom || !anchor) return null;
    var i = anchor.pageIndex;
    if (typeof i !== "number" || i < 0 || i >= numPages()) return null;
    var rect = firstRect(anchor, i);
    return rect ? rectScrollLeft(i, rect) : null;
  }
  function pageElFromTarget(node) {
    while (node && node !== dom.pages) {
      if (node.parentNode === dom.pages) return node.nodeType === 1 ? node : null;
      node = node.parentNode;
    }
    return null;
  }
  function pageIndexOfEl(pageEl) {
    if (!pageEl) return -1;
    var ds = pageEl.dataset || {};
    var guess = parseInt(ds.pageIndex != null ? ds.pageIndex : ds.page != null ? ds.page : ds.index, 10);
    if (!isNaN(guess)) {
      var v = tryCall(function () { return M.pdfview.pageView(guess); });
      if (v && v.el === pageEl) return guess;
    }
    var rp = renderedPages();
    for (var k = 0; k < rp.length; k++) {
      var pv = tryCall(function () { return M.pdfview.pageView(rp[k]); });
      if (pv && pv.el === pageEl) return rp[k];
    }
    return -1;
  }
  function pointerToPdf(ev, i, pageEl) {
    var r = pageEl.getBoundingClientRect(), vp = viewportOf(i);
    if (!vp || !r.width || !r.height) return null;
    var x = (ev.clientX - r.left) * ((vp.width || r.width) / r.width);
    var y = (ev.clientY - r.top) * ((vp.height || r.height) / r.height);
    return tryCall(function () { return vp.convertToPdfPoint(x, y); }) || null;
  }

  // ---------- the reader's own DOM (built once, on the first open) ----------
  function mount() {
    if (dom) return true;
    if (typeof document === "undefined") return false;
    var reader = document.getElementById("reader");
    if (!reader) return false;
    dom = {
      reader: reader,
      toolbar: document.getElementById("toolbar"),
      scroller: document.getElementById("scroller"),
      pages: document.getElementById("pages"),
      margin: document.getElementById("margin"),
      adder: document.getElementById("adder"),
      find: document.getElementById("find"),
      list: document.getElementById("list")
    };
    if (!dom.toolbar || !dom.scroller || !dom.pages) { dom = null; return false; }
    wirePersistentBus();
    buildToolbar();
    buildAdder();
    buildFind();
    buildFloating();
    // persistent document-level listeners (they check `st` and do nothing while no book is open)
    document.addEventListener("selectionchange", debouncedSelection());
    document.addEventListener("paste", onDocumentPaste);
    document.addEventListener("mousedown", onDocumentMouseDown, true);
    document.addEventListener("visibilitychange", function () { if (document.visibilityState === "hidden") savePosition(); });
    window.addEventListener("resize", function () { if (st) { positionFloating(); } });
    // the toolbar's text widths change once the web font arrives: fit it again then
    try { if (document.fonts && document.fonts.ready && typeof document.fonts.ready.then === "function") document.fonts.ready.then(function () { fitToolbar(); }, noop); } catch (e) { /* no FontFaceSet */ }
    dom.pages.addEventListener("click", onPagesClick);
    dom.pages.addEventListener("mousemove", onPagesMouseMove);
    dom.pages.addEventListener("mouseleave", function () { setHot(null); });
    if (dom.margin) dom.margin.addEventListener("dblclick", onMarginDblClick);
    return true;
  }

  function buildToolbar() {
    var tb = dom.toolbar;
    tb.innerHTML = "";
    tb.setAttribute("role", "toolbar");
    tb.setAttribute("aria-label", "Reader");

    var back = button("tb-btn tb-back", "", "Back to the library", function () { routeTo("library"); });
    back.appendChild(el("span", "tb-back__chev", "‹"));
    back.appendChild(el("span", "tb-back__label", "Library"));
    tb.appendChild(back);

    var name = button("tb-btn tb-name", "", "Rename this book", startRename);
    name.appendChild(el("span", "tb-name__text", ""));
    name.appendChild(el("span", "tb-name__pen", "✎"));
    tb.appendChild(name);
    var rename = el("input", "tb-rename is-hidden");
    rename.type = "text"; rename.maxLength = 80; rename.setAttribute("aria-label", "Book nickname");
    rename.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter") { ev.preventDefault(); ev.stopPropagation(); commitRename(); }
      else if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); cancelRename(); }
    });
    rename.addEventListener("blur", function () { if (st && st.renaming) commitRename(true); });
    tb.appendChild(rename);

    var pagebox = el("span", "tb-pagebox");
    var pageInput = el("input", "tb-page");
    pageInput.type = "text"; pageInput.inputMode = "numeric"; pageInput.setAttribute("aria-label", "Page");
    pageInput.autocomplete = "off";
    pageInput.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter") { ev.preventDefault(); ev.stopPropagation(); goToTypedPage(); }
      else if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); updatePageBox(); focusReader(); }
    });
    pageInput.addEventListener("focus", function () { tryCall(function () { pageInput.select(); }); });
    pageInput.addEventListener("blur", function () { updatePageBox(); });
    pagebox.appendChild(pageInput);
    pagebox.appendChild(el("span", "tb-pages", "/ 0"));
    tb.appendChild(pagebox);

    var zoom = el("span", "tb-group tb-zoom-group");
    zoom.appendChild(button("tb-btn tb-zoom-out", "−", "Zoom out (⌘−)", function () { zoomStep(-1); focusReader(); }));
    var readout = button("tb-btn tb-zoom", "100%", "Fit width (⌘0)", function () { zoomFit(); focusReader(); });
    zoom.appendChild(readout);
    zoom.appendChild(button("tb-btn tb-zoom-in", "+", "Zoom in (⌘=)", function () { zoomStep(1); focusReader(); }));
    var fit = button("tb-btn tb-zoom-fit", "⊡", "Fit width (⌘0)", function () { zoomFit(); focusReader(); });
    zoom.appendChild(fit);
    tb.appendChild(zoom);

    var snipGroup = el("span", "tb-group tb-snip-group");
    var snip = button("tb-btn tb-snip", "", "Snip a region to the clipboard (S)", toggleSnip);
    snip.appendChild(el("span", "tb-snip__icon", "✂"));
    snip.appendChild(el("span", "tb-snip__label", "Snip"));
    snip.setAttribute("aria-pressed", "false");
    snipGroup.appendChild(snip);
    var seg = el("span", "tb-seg");
    seg.setAttribute("role", "group"); seg.setAttribute("aria-label", "Snip copies");
    var segImage = button("tb-seg__btn", "Image", "Snip copies an image (Shift+S toggles)", function () { setSnipMode("image"); });
    var segLatex = button("tb-seg__btn", "LaTeX", "Snip copies LaTeX (Shift+S toggles)", function () { setSnipMode("latex"); });
    segImage.dataset.mode = "image"; segLatex.dataset.mode = "latex";
    seg.appendChild(segImage); seg.appendChild(segLatex);
    snipGroup.appendChild(seg);
    tb.appendChild(snipGroup);
    tb.appendChild(el("span", "tb-hint", ""));

    tb.appendChild(el("span", "tb-spacer"));

    var pill = button("tb-btn tb-resume is-hidden", "Resume review", "Resume the suspended review", resumeReview);
    tb.appendChild(pill);
    var review = button("tb-btn tb-review", "Review ▾", "Review (R this book · Shift+R all · T today)", function (ev) { openMenu(ev.currentTarget, reviewMenuItems()); });
    review.setAttribute("aria-haspopup", "menu");
    tb.appendChild(review);
    tb.appendChild(button("tb-btn tb-help", "?", "Keyboard shortcuts (?)", function () { tryCall(function () { M.app.openShortcuts(); }); }));
    var more = button("tb-btn tb-more", "⋯", "More", function (ev) { openMenu(ev.currentTarget, moreMenuItems()); });
    more.setAttribute("aria-haspopup", "menu");
    tb.appendChild(more);

    dom.back = back; dom.name = name; dom.nameText = name.firstChild; dom.rename = rename;
    dom.pageInput = pageInput; dom.pagesCount = pagebox.lastChild;
    dom.zoomReadout = readout; dom.zoomFitBtn = fit; dom.snipBtn = snip; dom.seg = seg; dom.segImage = segImage; dom.segLatex = segLatex;
    dom.hint = tb.querySelector(".tb-hint"); dom.pill = pill; dom.reviewBtn = review; dom.moreBtn = more;
  }

  // DECISIONS D32: Settings › Obsidian › "Connect Marginalia to Obsidian" (M.obsidian.enabled()). While it is off,
  // the adder has no "Note → Obsidian" button and O does nothing. An M.obsidian without that switch counts as on.
  function obsidianOn() {
    var O = M.obsidian;
    if (!O) return false;
    if (typeof O.enabled !== "function") return true;
    try { return O.enabled() === true; } catch (e) { return false; }
  }
  var adderObsidian = null;   // the adder's O button (buildAdder), shown only while obsidianOn()
  // Called when the adder is built, each time it shows, and when the setting "obsidian" changes.
  function syncAdder() { if (adderObsidian) adderObsidian.classList.toggle("is-hidden", !obsidianOn()); }
  function buildAdder() {
    var a = dom.adder;
    if (!a) return;
    a.innerHTML = "";
    a.setAttribute("role", "toolbar");
    a.setAttribute("aria-label", "Create from selection");
    a.classList.add("is-hidden");
    // [kind, key, label, label prefix hidden in stack mode (css/reader.css)]
    var defs = [["qa", "N", "Prompt"], ["cloze", "C", "Cloze"], ["highlight", "H", "Highlight"], ["obsidian", "O", "Obsidian", "Note → "]];
    defs.forEach(function (d) {
      var full = (d[3] || "") + d[2];
      var b = button("adder__btn adder__btn--" + d[0], "", full + " (" + d[1] + ")", function (ev) { ev.preventDefault(); createFromSelection(d[0]); });
      b.appendChild(kbd(d[1]));
      var label = el("span", "adder__label", d[3] ? null : d[2]);
      if (d[3]) { label.appendChild(el("span", "adder__label-pre", d[3])); label.appendChild(el("span", "adder__label-main", d[2])); }
      b.appendChild(label);
      b.dataset.kind = d[0];
      if (d[0] === "obsidian") adderObsidian = b;
      a.appendChild(b);
    });
    // a mousedown on the adder must not collapse the page selection
    a.addEventListener("mousedown", function (ev) { ev.preventDefault(); });
    syncAdder();
  }

  function buildFind() {
    var f = dom.find;
    if (!f) return;
    f.innerHTML = "";
    f.setAttribute("role", "search");
    f.classList.add("is-hidden");
    var input = el("input", "find__input");
    input.type = "search"; input.placeholder = "Find in document"; input.setAttribute("aria-label", "Find in document");
    input.autocomplete = "off"; input.spellcheck = false;
    var pending = 0;
    input.addEventListener("input", function () {
      clearTimeout(pending);
      pending = setTimeout(function () { if (st) setFind(input.value); }, FIND_DEBOUNCE_MS);
    });
    input.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter") {
        ev.preventDefault(); ev.stopPropagation();
        clearTimeout(pending);
        if (st && st.find.query !== input.value) setFind(input.value);
        else findStep(ev.shiftKey ? -1 : 1);
      } else if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); closeFind(true); }
    });
    f.appendChild(input);
    f.appendChild(el("span", "find__count", ""));
    f.appendChild(button("tb-btn find__prev", "‹", "Previous match (Shift+Enter)", function () { findStep(-1); input.focus(); }));
    f.appendChild(button("tb-btn find__next", "›", "Next match (Enter)", function () { findStep(1); input.focus(); }));
    f.appendChild(button("tb-btn find__close", "✕", "Close (Esc)", function () { closeFind(true); }));
    dom.findInput = input; dom.findCount = f.querySelector(".find__count");
  }

  function buildFloating() {
    var prep = el("div", "reader__prep is-hidden");
    prep.setAttribute("role", "status"); prep.setAttribute("aria-live", "polite");
    prep.appendChild(el("span", "reader__prep-text", ""));
    prep.appendChild(el("span", "reader__prep-bar", ""));
    var prepBack = button("btn reader__prep-back is-hidden", "‹ Library", "Back to the library", function () { routeTo("library"); });
    prep.appendChild(prepBack);
    dom.reader.appendChild(prep);

    var chip = el("div", "reader__chip is-hidden");
    chip.setAttribute("role", "status");
    chip.appendChild(el("span", "reader__chip-text", ""));
    chip.appendChild(button("reader__chip-close", "✕", "Dismiss", function () { hideChip(); }));
    dom.reader.appendChild(chip);

    var ch = el("div", "chapterMark is-hidden");
    ch.setAttribute("role", "dialog"); ch.setAttribute("aria-label", "Mark chapter start");
    ch.appendChild(el("label", "chapterMark__label", "Chapter start"));
    var chInput = el("input", "chapterMark__input");
    chInput.type = "text"; chInput.maxLength = 120; chInput.setAttribute("aria-label", "Chapter title");
    chInput.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter") { ev.preventDefault(); ev.stopPropagation(); commitChapter(); }
      else if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); closeChapterField(true); }
    });
    ch.appendChild(chInput);
    ch.appendChild(el("span", "chapterMark__hint", "Enter saves · Esc cancels"));
    dom.reader.appendChild(ch);

    dom.prep = prep; dom.prepText = prep.firstChild; dom.prepBack = prepBack;
    dom.chip = chip; dom.chipText = chip.firstChild;
    dom.chapter = ch; dom.chapterLabel = ch.firstChild; dom.chapterInput = chInput;
  }

  function toolbarBottom() {
    var r = dom.toolbar.getBoundingClientRect();
    return r.bottom > 0 ? r.bottom : 44;
  }
  function positionFloating() {
    if (!dom) return;
    var top = toolbarBottom() + 8;
    dom.find.style.top = top + "px";
    dom.prep.style.top = top + "px";
    dom.chip.style.top = top + "px";
    if (st && st.chapter) positionChapterField();
    if (st && st.adderVisible) positionAdderFromSelection();
  }

  // ---------- toolbar state ----------
  function updateToolbar() {
    var c = collection();
    dom.nameText.textContent = c && c.name ? c.name : (c && c.title ? c.title : "Untitled");
    dom.name.title = "Rename “" + (c && c.name ? c.name : "") + "”";
    dom.pagesCount.textContent = "/ " + numPages();
    updatePageBox();
    updateZoomReadout();
    updateSnipUi(null);
    fitToolbar();
  }
  // When the bar is short of room it sheds, in this order (css/reader.css .tb--fit-N, cumulative): 1 the
  // Image|LaTeX control (the ⋯ menu shows and carries it), 2 the text labels (Library, Snip, ✎), 3 Review ▾
  // and ? (both in ⋯ too). The zoom group stays in wide and rail. While measuring, the title keeps up to
  // 160 px (.tb--measure) so it is not squeezed to "…" before anything else goes; the snip hint shrinks.
  function fitToolbar() {
    if (!dom || !dom.toolbar) return;
    var tb = dom.toolbar, k;
    for (k = 1; k <= TB_FIT_LEVELS; k++) tb.classList.remove("tb--fit-" + k);
    if (!st || st.mode === "stack") return;               // stack has its own fixed collapse
    tb.classList.add("tb--measure");
    for (k = 1; k <= TB_FIT_LEVELS && toolbarOverflows(tb); k++) tb.classList.add("tb--fit-" + k);
    tb.classList.remove("tb--measure");
  }
  // Sub-pixel exact: the last item shown ends past the bar's content edge (even 0.3 px there would squeeze the
  // title into "…"). scrollWidth (whole pixels) is the fallback without layout boxes.
  function toolbarOverflows(tb) {
    var kids = tb.children, last = null;
    for (var i = kids.length - 1; i >= 0 && !last; i--) { var r = kids[i].getBoundingClientRect(); if (r.width > 0) last = r; }
    if (!last) return tb.scrollWidth > tb.clientWidth;
    var pad = 0;
    try { pad = parseFloat(root.getComputedStyle(tb).paddingRight) || 0; } catch (e) { pad = 0; }
    return last.right > tb.getBoundingClientRect().right - pad + 0.05;
  }
  function updatePageBox(i) {
    if (!st) return;
    if (document.activeElement === dom.pageInput) return;
    if (typeof i !== "number") i = currentPage();
    st.page = i;
    dom.pageInput.value = String(i + 1);
  }
  function goToTypedPage() {
    var raw = dom.pageInput.value.trim(), n = numPages(), target = -1;
    if (!raw) { updatePageBox(); focusReader(); return; }
    var labels = st.doc && Array.isArray(st.doc.pageLabels) ? st.doc.pageLabels : null;
    if (labels) { var k = labels.indexOf(raw); if (k >= 0) target = k; }
    if (target < 0 && /^\d+$/.test(raw)) target = parseInt(raw, 10) - 1;
    if (target < 0 || target >= n || isNaN(target)) { updatePageBox(); toast("No page “" + raw + "”"); focusReader(); return; }
    tryCall(function () { M.pdfview.scrollTo({ pageIndex: target, fraction: 0 }); });
    updatePageBox(target);
    focusReader();
  }
  function focusPageBox() {
    dom.pageInput.focus();
    tryCall(function () { dom.pageInput.select(); });
  }
  function updateZoomReadout() {
    if (!st) return;
    var s = currentScale(), manual = st.zoom !== "fit";
    dom.zoomReadout.textContent = Math.round(s / PDFJS_CSS_UNITS * 100) + "%";
    dom.zoomReadout.title = manual ? "Fit width (⌘0)" : "Fit width";
    // a manual zoom lights the fit control so it reads as "back to fit"
    dom.zoomFitBtn.classList.toggle("is-manual", manual);
    var fitLabel = manual ? "Back to fit width (⌘0)" : "Fit width (⌘0)";
    dom.zoomFitBtn.title = fitLabel;
    dom.zoomFitBtn.setAttribute("aria-label", fitLabel);
  }
  function updateSnipUi(state) {
    if (!dom) return;
    var armed = state && typeof state.armed === "boolean" ? state.armed : !!tryCall(function () { return M.snip.isArmed(); }, false);
    var mode = state && state.mode ? state.mode : (tryCall(function () { return M.snip.mode(); }) || setting("snipMode", "image"));
    dom.snipBtn.setAttribute("aria-pressed", armed ? "true" : "false");
    dom.snipBtn.classList.toggle("is-on", armed);
    dom.hint.textContent = armed ? "Drag over an equation · Esc to cancel" : "";
    dom.segImage.classList.toggle("is-on", mode !== "latex");
    dom.segImage.setAttribute("aria-pressed", mode !== "latex" ? "true" : "false");
    dom.segLatex.classList.toggle("is-on", mode === "latex");
    dom.segLatex.setAttribute("aria-pressed", mode === "latex" ? "true" : "false");
  }
  function refreshLatexAvailability() {
    if (!M.vision || typeof M.vision.detect !== "function") return;
    var p = tryCall(function () { return M.vision.detect(); });
    if (!p || !p.then) return;
    p.then(function (backend) {
      if (!dom) return;
      dom.segLatex.disabled = !backend;
      dom.segLatex.title = backend ? "Snip copies LaTeX (Shift+S toggles)" : "Add an API key in Settings";
    }, noop);
  }
  function toggleSnip() {
    if (!st) return;
    var armed = !!tryCall(function () { return M.snip.isArmed(); }, false);
    tryCall(function () { if (armed) M.snip.exit(); else M.snip.enter(); });
    updateSnipUi(null);
  }
  function setSnipMode(mode) {
    tryCall(function () { M.snip.setMode(mode); });
    updateSnipUi({ mode: mode, armed: !!tryCall(function () { return M.snip.isArmed(); }, false) });
  }
  function routeTo(screen, params) { tryCall(function () { M.app.route(screen, params || {}); }); }
  function resumeReview() {
    hidePill();
    tryCall(function () { M.review.resume(); });
  }
  function showPill(remaining) {
    if (!dom) return;
    var n = typeof remaining === "number" ? remaining : null;
    dom.pill.textContent = n == null ? "Resume review" : "Resume review · " + n + " left";
    dom.pill.classList.remove("is-hidden");
    fitToolbar();
  }
  function hidePill() {
    if (!dom) return;
    var shown = !dom.pill.classList.contains("is-hidden");
    dom.pill.classList.add("is-hidden");
    if (shown) fitToolbar();
  }

  // ---------- menus (Review ▾ and the narrow-mode ⋯) ----------
  function reviewMenuItems() {
    return [
      { label: "Review this book", kbd: "R", act: "reviewBook" },
      { label: "Review all due", kbd: "⇧R", act: "reviewAll" },
      { label: "Review today’s prompts", kbd: "T", act: "reviewToday" }
    ];
  }
  function moreMenuItems() {
    var mode = tryCall(function () { return M.snip.mode(); }) || setting("snipMode", "image");
    var items = [
      { label: "Zoom in", kbd: "⌘=", act: "zoomIn" },
      { label: "Zoom out", kbd: "⌘−", act: "zoomOut" },
      { label: "Fit width", kbd: "⌘0", act: "zoomFit" },
      { label: "Snip copies: " + (mode === "latex" ? "LaTeX" : "Image") + " → " + (mode === "latex" ? "Image" : "LaTeX"), kbd: "⇧S", act: "snipMode" },
      { label: "Find", kbd: "⌘F", act: "find" },
      { label: "Go to page", kbd: "P", act: "pageBox" },
      { label: "Prompt list", kbd: "L", act: "list" },
      { label: "Mark chapter start here", kbd: "⇧C", act: "markChapter" }
    ];
    return items.concat(reviewMenuItems(), [{ label: "Keyboard shortcuts", kbd: "?", act: "shortcuts" }]);
  }
  function openMenu(anchorBtn, items) {
    if (!st) return;
    if (st.menu && st.menu.owner === anchorBtn) { closeMenu(); return; }
    closeMenu();
    var m = el("div", "tb-menu");
    m.setAttribute("role", "menu");
    items.forEach(function (it) {
      var b = button("tb-menu__item", "", null, function () { var act = it.act; closeMenu(); menuAction(act); });
      b.setAttribute("role", "menuitem");
      b.appendChild(el("span", "tb-menu__label", it.label));
      if (it.kbd) b.appendChild(el("kbd", "kbd tb-menu__kbd", it.kbd));
      m.appendChild(b);
    });
    m.addEventListener("keydown", function (ev) {
      if (ev.key !== "ArrowDown" && ev.key !== "ArrowUp") return;
      ev.preventDefault(); ev.stopPropagation();
      var bs = m.querySelectorAll("button"), n = bs.length;
      if (!n) return;
      var idx = Array.prototype.indexOf.call(bs, document.activeElement);
      bs[ev.key === "ArrowDown" ? (idx + 1) % n : (idx - 1 + n) % n].focus();
    });
    dom.reader.appendChild(m);
    var r = anchorBtn.getBoundingClientRect();
    m.style.top = (r.bottom + 4) + "px";
    var w = m.offsetWidth || 200;
    var left = r.right - w;
    if (left < 8) left = Math.max(8, r.left);
    if (left + w > window.innerWidth - 8) left = Math.max(8, window.innerWidth - 8 - w);
    m.style.left = left + "px";
    anchorBtn.setAttribute("aria-expanded", "true");
    st.menu = { el: m, owner: anchorBtn };
    var first = m.querySelector("button");
    if (first) first.focus();
  }
  function closeMenu() {
    if (!st || !st.menu) return false;
    var m = st.menu; st.menu = null;
    m.owner.setAttribute("aria-expanded", "false");
    if (m.el.parentNode) m.el.parentNode.removeChild(m.el);
    return true;
  }
  function menuAction(act) {
    switch (act) {
      case "reviewBook": tryCall(function () { M.app.startReview("book", st.id); }); return;
      case "reviewAll": tryCall(function () { M.app.startReview("all", null); }); return;
      case "reviewToday": tryCall(function () { M.app.startReview("today", st.id); }); return;
      case "shortcuts": tryCall(function () { M.app.openShortcuts(); }); return;
      case "snipMode": tryCall(function () { M.snip.toggleMode(); }); updateSnipUi(null); focusReader(); return;
      default: run(act); focusReader();
    }
  }
  function onDocumentMouseDown(ev) {
    if (!st) return;
    if (st.menu && !st.menu.el.contains(ev.target) && ev.target !== st.menu.owner && !st.menu.owner.contains(ev.target)) closeMenu();
    if (st.chapter && !dom.chapter.contains(ev.target)) closeChapterField(true);
  }

  // ---------- nickname rename (inline) ----------
  function startRename() {
    if (!st || st.renaming) return;
    var c = collection();
    st.renaming = true;
    dom.rename.value = c && c.name ? c.name : "";
    dom.name.classList.add("is-hidden");
    dom.rename.classList.remove("is-hidden");
    dom.rename.focus();
    tryCall(function () { dom.rename.select(); });
  }
  function endRename() {
    if (!st) return;
    st.renaming = false;
    dom.rename.classList.add("is-hidden");
    dom.name.classList.remove("is-hidden");
  }
  function cancelRename() { endRename(); focusReader(); }
  function commitRename(fromBlur) {
    if (!st || !st.renaming) return;
    var c = collection(), value = dom.rename.value.replace(/\s+/g, " ").trim().slice(0, 80);
    endRename();
    if (c && value && value !== c.name) {
      c.name = value;
      var r = tryCall(function () { return M.cache.saveCollection(c); });
      Promise.resolve(r).then(function () { return M.cache.recontext(c.id); }).catch(noop);
      updateToolbar();
    }
    if (!fromBlur) focusReader();
  }

  // ---------- "Preparing document…" bar, scanned chip, chapter field ----------
  function setPrep(text, error) {
    if (!dom) return;
    if (!text) { dom.prep.classList.add("is-hidden"); return; }
    dom.prepText.textContent = text;
    dom.prep.classList.toggle("reader__prep--error", !!error);
    dom.prepBack.classList.toggle("is-hidden", !error);
    dom.prep.classList.remove("is-hidden");
    positionFloating();
  }
  function showChip(text) {
    if (!dom) return;
    dom.chipText.textContent = text;
    dom.chip.classList.remove("is-hidden");
    positionFloating();
    clearTimeout(st && st.chipTimer);
    if (st) st.chipTimer = setTimeout(hideChip, CHIP_MS);
  }
  function hideChip() { if (dom) dom.chip.classList.add("is-hidden"); }

  function openChapterField() {
    if (!st) return false;
    closeMenu();
    var i = currentPage(), c = collection();
    var n = 1, sections = c && Array.isArray(c.sections) ? c.sections : [];
    for (var k = 0; k < sections.length; k++) if (sections[k] && sections[k].level === 1 && sections[k].pageIndex < i) n++;
    st.chapter = { page: i };
    dom.chapterLabel.textContent = "Chapter start at p. " + pageLabelOf(i);
    dom.chapterInput.value = "Ch. " + n + " · ";
    dom.chapter.classList.remove("is-hidden");
    positionChapterField();
    dom.chapterInput.focus();
    tryCall(function () { var L = dom.chapterInput.value.length; dom.chapterInput.setSelectionRange(L, L); });
    return true;
  }
  function positionChapterField() {
    if (!st || !st.chapter) return;
    var v = tryCall(function () { return M.pdfview.pageView(st.chapter.page); });
    var top = toolbarBottom() + 8, left = null;
    if (v && v.el) {
      var r = v.el.getBoundingClientRect();
      top = clamp(r.top + 8, toolbarBottom() + 8, window.innerHeight - 60);
      left = r.left + 8;
    }
    dom.chapter.style.top = top + "px";
    if (left != null) { dom.chapter.style.left = Math.max(8, Math.min(left, window.innerWidth - dom.chapter.offsetWidth - 8)) + "px"; dom.chapter.style.transform = "none"; }
    else { dom.chapter.style.left = "50%"; dom.chapter.style.transform = "translateX(-50%)"; }
  }
  function closeChapterField(refocus) {
    if (!st || !st.chapter) return false;
    st.chapter = null;
    dom.chapter.classList.add("is-hidden");
    if (refocus) focusReader();
    return true;
  }
  function commitChapter() {
    if (!st || !st.chapter) return;
    var page = st.chapter.page, title = dom.chapterInput.value.replace(/\s+/g, " ").trim();
    closeChapterField(true);
    if (!title) return;
    var c = collection();
    if (!c) return;
    var sections = (Array.isArray(c.sections) ? c.sections : []).filter(function (s) {
      return !(s && s.source === "manual" && s.pageIndex === page);
    });
    sections.push({ title: title, label: title, pageIndex: page, level: 1, source: "manual" });
    sections = sections.map(function (s, k) { return { s: s, k: k }; })
      .sort(function (a, b) { return (a.s.pageIndex - b.s.pageIndex) || (a.k - b.k); })
      .map(function (x) { return x.s; });
    c.sections = sections;
    var r = tryCall(function () { return M.cache.saveCollection(c); });
    Promise.resolve(r).then(function () { return M.cache.recontext(c.id); }).then(function () {
      toast("Chapter marked · " + title);
    }, function () { toast("Could not save the chapter mark"); });
  }

  // ---------- selection → snapshot + adder (SPEC §3) ----------
  function debouncedSelection() {
    var u = util();
    if (typeof u.debounce === "function") return u.debounce(onSelectionChange, SELECTION_DEBOUNCE_MS);
    var t = 0;
    return function () { clearTimeout(t); t = setTimeout(onSelectionChange, SELECTION_DEBOUNCE_MS); };
  }
  function onSelectionChange() {
    if (!st || !dom) return;
    var ae = document.activeElement;
    if (ae && isTextField(ae)) return;                 // typing somewhere: the snapshot survives (editor, find, page box)
    var sel = null;
    try { sel = document.getSelection(); } catch (e) { sel = null; }
    var range = (sel && sel.rangeCount && !sel.isCollapsed) ? sel.getRangeAt(0) : null;
    if (!range || !dom.pages.contains(range.commonAncestorContainer)) { clearSelection(false); return; }
    var anchor = null;
    try { anchor = M.anchors.fromSelection(range, pageViewFn); } catch (e) { anchor = null; }
    if (!anchor) { clearSelection(false); return; }
    api.selection = anchor;
    st.selectionRange = range;
    if (tryCall(function () { return M.snip.isArmed(); }, false)) hideAdder();
    else showAdder(range);
    emit("selection:changed", { anchor: anchor });
  }
  function activeEditor() { return tryCall(function () { return M.margin.activeEditor(); }) || null; }
  function clearSelection(clearDom) {
    if (clearDom) { try { var s = document.getSelection(); if (s && s.rangeCount) s.removeAllRanges(); } catch (e) {} }
    hideAdder();
    if (st) st.selectionRange = null;
    if (api.selection) { api.selection = null; emit("selection:changed", { anchor: null }); }
  }
  function showAdder(range) {
    if (!dom.adder || !st) return;
    st.adderVisible = true;
    syncAdder();                                    // D32: "Note → Obsidian" only while the connection is on
    dom.adder.classList.remove("is-hidden");
    positionAdder(range);
  }
  function hideAdder() {
    if (!dom || !dom.adder) return;
    if (st) st.adderVisible = false;
    dom.adder.classList.add("is-hidden");
  }
  function positionAdderFromSelection() {
    var sel = tryCall(function () { return document.getSelection(); });
    if (!sel || !sel.rangeCount || sel.isCollapsed) { hideAdder(); return; }
    var range = sel.getRangeAt(0);
    if (!dom.pages.contains(range.commonAncestorContainer)) { hideAdder(); return; }
    positionAdder(range);
  }
  function positionAdder(range) {
    var rects = range.getClientRects(), r = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
    var a = dom.adder, w = a.offsetWidth || 240, h = a.offsetHeight || 36;
    var sc = dom.scroller.getBoundingClientRect();
    if (r.bottom < sc.top || r.top > sc.bottom) { a.style.visibility = "hidden"; return; }
    a.style.visibility = "";
    var left = clamp(r.right - w / 2, 8, Math.max(8, window.innerWidth - w - 8));
    var top = r.bottom + 6;
    if (top + h > window.innerHeight - 8) top = Math.max(toolbarBottom() + 4, r.top - h - 6);
    a.style.left = Math.round(left) + "px";
    a.style.top = Math.round(top) + "px";
  }

  // ---------- creating prompts (SPEC §3, §15) ----------
  // kind "obsidian" (O, BUILD-NOTES "Obsidian"): the margin editor on the selection with empty text and the
  // "Save + Obsidian" save; without a selection a free note at the middle of the visible page, like N.
  function createFromSelection(kind) {
    if (!st) return false;
    if (kind === "obsidian" && !obsidianOn()) return false;   // D32: the Obsidian connection is off
    var anchor = api.selection;
    if (!anchor) {
      var pos;
      if (kind === "qa") { pos = visibleMiddle(); return createFreeNote(pos.pageIndex, pos.yPdf, "Q. "); }
      if (kind === "obsidian") { pos = visibleMiddle(); return createFreeNote(pos.pageIndex, pos.yPdf, "", { obsidian: true }); }
      return false;
    }
    if (kind === "highlight") { saveHighlight(anchor); clearSelection(true); focusReader(); return true; }
    hideAdder();
    if (kind === "obsidian") { openEditorFor(anchor, "", { obsidian: true }); return true; }
    if (kind === "cloze") {
      var fallback = "{" + (anchor.quote || "") + "}";
      // as M.anchors.sentenceAround does: a "::" in the selection is written `\::`, never a cue (FEATURES P1.1 e)
      fallback = tryCall(function () { return M.prompts.escapeCues(fallback, 1, fallback.length - 1); }) || fallback;
      getTextIndex(anchor.pageIndex).then(function (ti) {
        if (!st) return;
        var text = null;
        if (ti) { try { text = M.anchors.sentenceAround(anchor, ti); } catch (e) { text = null; } }
        openEditorFor(anchor, (typeof text === "string" && text.trim()) ? text : fallback);
      }, function () { if (st) openEditorFor(anchor, fallback); });
      return true;
    }
    openEditorFor(anchor, "Q. ");
    return true;
  }
  function openEditorFor(anchor, text, opts) {
    if (!st) return;
    var o = { promptId: null, anchor: anchor, initialText: text };
    if (opts && opts.obsidian) o.obsidian = true;
    try { M.margin.openEditor(o); }
    catch (e) { toast("Could not open the editor"); }
  }
  // opts.obsidian (extension): the O free note — empty text and the margin's "Save + Obsidian" editor
  function createFreeNote(pageIndex, yPdf, text, opts) {
    if (!st) return false;
    var n = numPages();
    if (!n) return false;
    pageIndex = clamp(Math.floor(Number(pageIndex) || 0), 0, n - 1);
    var anchor = null;
    try { anchor = M.anchors.fromMarginY(pageIndex, Number(yPdf) || 0); } catch (e) { anchor = null; }
    if (!anchor) return false;
    hideAdder();
    var obsidian = !!(opts && opts.obsidian);
    openEditorFor(anchor, obsidian ? (text == null ? "" : String(text)) : ((text == null || text === "") ? "Q. " : String(text)), { obsidian: obsidian });
    return true;
  }
  function contextFor(pageIndex) {
    var c = collection() || {}, label = null;
    try { label = M.context.labelFor(Array.isArray(c.sections) ? c.sections : [], pageIndex); } catch (e) { label = null; }
    return { docName: c.name || "", sectionLabel: label || null, pageIndex: pageIndex, pageLabel: pageLabelOf(pageIndex) };
  }
  function saveHighlight(anchor) {
    var now = Date.now();
    var rec = {
      id: util().uuid ? util().uuid("p_") : "p_" + now.toString(36) + Math.random().toString(36).slice(2, 10),
      collectionId: st.id, kind: "highlight", text: "", tags: [], flagged: false,
      anchor: anchor, context: contextFor(anchor.pageIndex), cards: [],
      createdAt: now, contentUpdatedAt: now, updatedAt: now, deletedAt: null, v: 1
    };
    var r = tryCall(function () { return M.cache.savePrompt(rec, { content: true, step: true }); });   // a step (M.undo, D33)
    Promise.resolve(r).catch(noop);
    return rec;
  }
  function focusCard(id) {
    if (!st || !id) return false;
    tryCall(function () { M.margin.focus(id); });
    return true;
  }
  function onMarginDblClick(ev) {
    if (!st) return;
    var t = ev.target;
    if (t && t.closest && t.closest(".card, .marker, .popover, .editor, .rail, button, input, textarea, a")) return;
    var sc = dom.scroller, yDoc = ev.clientY - sc.getBoundingClientRect().top + sc.scrollTop;
    var i = pageAtDocY(yDoc), vp = viewportOf(i);
    if (!vp) return;
    var yLocal = clamp(yDoc - pageTopDoc(i), 0, vp.height || 0);
    var yPdf = tryCall(function () { return vp.convertToPdfPoint(0, yLocal)[1]; }, 0);
    ev.preventDefault();
    clearSelection(true);
    createFreeNote(i, yPdf, "");
  }
  // document-level paste: free note at the middle of the visible page (SPEC §15, D20)
  function onDocumentPaste(ev) {
    if (!st || activeEditor()) return;
    if (isTextField(ev.target)) return;
    var owner = tryCall(function () { return M.app.focusOwner(); }, "reader");
    if (owner && owner !== "reader" && owner !== "card") return;
    var cd = ev.clipboardData;
    if (!cd) return;
    var file = null, items = cd.items || [];
    for (var k = 0; k < items.length; k++) {
      var it = items[k];
      if (it && it.kind === "file" && /^image\//.test(it.type || "")) { file = it.getAsFile(); if (file) break; }
    }
    var pos = visibleMiddle();
    if (file) {
      ev.preventDefault();
      leaveSnip();
      var p = tryCall(function () { return M.attachments.fromBlob(file); });
      Promise.resolve(p).then(function (att) {
        if (!st || !att || !att.id) return;
        createFreeNote(pos.pageIndex, pos.yPdf, "Q. ![snip](att:" + att.id + ")\nA. ");
      }, function (err) {
        toast(err && err.code === "too_large" ? "Image too large to attach" : "Could not read the pasted image");
      });
      return;
    }
    var text = "";
    try { text = cd.getData("text/plain") || ""; } catch (e) { text = ""; }
    text = text.replace(/\r\n?/g, "\n").trim();
    if (!text) return;
    ev.preventDefault();
    leaveSnip();
    createFreeNote(pos.pageIndex, pos.yPdf, "Q. " + text + "\nA. ");
  }
  function leaveSnip() { if (tryCall(function () { return M.snip.isArmed(); }, false)) tryCall(function () { M.snip.exit(); }); }

  // ---------- hit-testing without DOM (SPEC §5) ----------
  function rebuildRects() {
    if (!st) return;
    var byPage = new Map(), known = new Set(), list = livePrompts();
    for (var i = 0; i < list.length; i++) {
      var p = list[i], a = p.anchor;
      known.add(p.id);          // every live prompt of the book, rects or not (free notes draw a .hl-note)
      if (!a || a.lost || !Array.isArray(a.pages)) continue;
      for (var k = 0; k < a.pages.length; k++) {
        var pg = a.pages[k];
        if (!pg || !Array.isArray(pg.rects) || !pg.rects.length) continue;
        var arr = byPage.get(pg.pageIndex);
        if (!arr) { arr = []; byPage.set(pg.pageIndex, arr); }
        arr.push({ id: p.id, rects: pg.rects });
      }
    }
    st.rectsByPage = byPage;
    st.knownIds = known;
  }
  function hitAt(ev) {
    var pageEl = pageElFromTarget(ev.target);
    if (!pageEl) return null;
    var i = pageIndexOfEl(pageEl);
    if (i < 0) return null;
    var list = st.rectsByPage.get(i);
    if (!list || !list.length) return null;
    var pt = pointerToPdf(ev, i, pageEl);
    if (!pt) return null;
    return tryCall(function () { return M.anchors.hitTest(list, pt[0], pt[1]); }) || null;
  }
  function onPagesClick(ev) {
    if (!st || ev.button !== 0) return;
    if (tryCall(function () { return M.snip.isArmed(); }, false)) return;
    var sel = tryCall(function () { return document.getSelection(); });
    if (sel && !sel.isCollapsed) return;        // a drag-select ends with a click too
    var id = hitAt(ev);
    if (id) { ev.preventDefault(); focusCard(id); }
  }
  function onPagesMouseMove(ev) {
    if (!st) return;
    st.lastMove = ev;
    if (st.moveRaf) return;
    st.moveRaf = raf(function () {
      if (!st) return;
      st.moveRaf = 0;
      var e = st.lastMove;
      setHot(e ? hitAt(e) : null);
    });
  }
  function toggleHlClass(id, cls, on) {
    if (!id || !dom) return;
    var nodes = dom.pages.querySelectorAll(".hl[data-id=\"" + cssEscape(id) + "\"]");
    for (var k = 0; k < nodes.length; k++) nodes[k].classList.toggle(cls, on);
  }
  function setHot(id) {
    if (!st) return;
    id = id || null;
    if (id === st.hot) return;
    toggleHlClass(st.hot, "hl--active", false);
    st.hot = id;
    toggleHlClass(id, "hl--active", true);
    if (M.margin && typeof M.margin.setHot === "function") { tryCall(function () { M.margin.setHot(id); }); return; }
    if (dom.margin) {   // fallback when margin has no setHot: toggle the shared class on the card
      var hot = dom.margin.querySelectorAll(".card--hot");
      for (var k = 0; k < hot.length; k++) hot[k].classList.remove("card--hot");
      if (id) { var card = dom.margin.querySelector(".card[data-id=\"" + cssEscape(id) + "\"]"); if (card) card.classList.add("card--hot"); }
    }
  }

  // ---------- highlight layers (SPEC §5 "Drawing") ----------
  function normRect(r) {
    if (!r) return null;
    if (Array.isArray(r) && r.length >= 4) {
      var x1 = Math.min(r[0], r[2]), x2 = Math.max(r[0], r[2]), y1 = Math.min(r[1], r[3]), y2 = Math.max(r[1], r[3]);
      return (isFinite(x1) && isFinite(y1) && isFinite(x2) && isFinite(y2)) ? [x1, y1, x2, y2] : null;
    }
    if (typeof r === "object") {
      if ("left" in r && "top" in r) return normRect([r.left, r.top, r.left + (r.width || 0), r.top + (r.height || 0)]);
      if ("x" in r && "y" in r) return normRect([r.x, r.y, r.x + (r.w != null ? r.w : r.width || 0), r.y + (r.h != null ? r.h : r.height || 0)]);
    }
    return null;
  }
  // PDF-space rects of an anchor on page i → viewport CSS-px rects [x1, y1, x2, y2] (normalized)
  function viewportRectsFor(anchor, i, vp) {
    var out = null;
    if (M.anchors && typeof M.anchors.viewportRects === "function") {
      out = tryCall(function () { return M.anchors.viewportRects(anchor, i, vp); });
      if (Array.isArray(out)) { out = out.map(normRect).filter(Boolean); if (out.length) return out; }
    }
    var pg = null;
    for (var k = 0; k < (anchor.pages || []).length; k++) if (anchor.pages[k] && anchor.pages[k].pageIndex === i) { pg = anchor.pages[k]; break; }
    if (!pg || !Array.isArray(pg.rects)) return [];
    return pdfRectsToViewport(pg.rects, vp);
  }
  function pdfRectsToViewport(rects, vp) {
    var out = [];
    for (var k = 0; k < rects.length; k++) {
      var r = rects[k];
      if (!Array.isArray(r) || r.length < 4) continue;
      var v = tryCall(function () { return vp.convertToViewportRectangle(r); });
      var n = normRect(v);
      if (n) out.push(n);
    }
    return out;
  }
  function placeRect(div, rect, vp, pad) {
    var W = vp.width || 1, H = vp.height || 1;
    var left = rect[0] / W * 100, top = rect[1] / H * 100, w = (rect[2] - rect[0]) / W * 100, h = (rect[3] - rect[1]) / H * 100;
    div.style.left = left.toFixed(3) + "%";
    div.style.width = Math.max(0, w).toFixed(3) + "%";
    if (pad) { div.style.top = "calc(" + top.toFixed(3) + "% - 1px)"; div.style.height = "calc(" + Math.max(0, h).toFixed(3) + "% + 2px)"; }
    else { div.style.top = top.toFixed(3) + "%"; div.style.height = Math.max(0, h).toFixed(3) + "%"; }
  }
  function ensureLayer(pageEl, cls) {
    var layer = null, kids = pageEl.children;
    for (var k = 0; k < kids.length; k++) if (kids[k].classList && kids[k].classList.contains(cls)) { layer = kids[k]; break; }
    if (layer) return layer;
    layer = el("div", cls);
    layer.setAttribute("aria-hidden", "true");
    var textLayer = pageEl.querySelector(".textLayer");
    if (cls === "hlLayer" && textLayer && textLayer.parentNode === pageEl) pageEl.insertBefore(layer, textLayer);
    else pageEl.appendChild(layer);
    return layer;
  }
  function anchorsOnPage(i) {
    var out = [], list = livePrompts();
    for (var k = 0; k < list.length; k++) {
      var a = list[k].anchor;
      if (!a || a.lost) continue;
      if (a.pageIndex === i && (!a.pages || !a.pages.length)) { out.push({ prompt: list[k], note: true }); continue; }
      if (!Array.isArray(a.pages)) continue;
      for (var j = 0; j < a.pages.length; j++) if (a.pages[j] && a.pages[j].pageIndex === i) { out.push({ prompt: list[k], note: false }); break; }
    }
    return out;
  }
  function lastPageOf(anchor) {
    var pages = Array.isArray(anchor.pages) ? anchor.pages : [], last = -1;
    for (var k = 0; k < pages.length; k++) if (pages[k] && typeof pages[k].pageIndex === "number" && pages[k].pageIndex > last) last = pages[k].pageIndex;
    return last < 0 ? anchor.pageIndex : last;
  }
  // SPEC §2 stack mode: a 16-px badge after the highlight's last rect that opens the card in the bottom
  // sheet (M.margin.focus → #sheet). It sits in .hlLayer with percent coordinates like the .hl divs and
  // pointer-events: auto of its own; css/margin.css (the sheet's owner) shows it only under .reader--stack,
  // so the breakpoint can change without a redraw. Enter on the focused button is a native click.
  var BADGE_GLYPHS = { qa: "✦", cloze: "{}", note: "▭", highlight: "·" };
  function badgeFor(p, rect, vp) {
    var kind = BADGE_GLYPHS[p.kind] ? p.kind : "note";
    var b = el("button", "hl-badge hl-badge--" + kind + (p.flagged ? " hl-badge--flag" : ""), BADGE_GLYPHS[kind]);
    b.type = "button";
    b.dataset.id = p.id;
    b.tabIndex = 0;
    b.setAttribute("aria-label", "Open prompt");
    b.title = "Open prompt";
    var W = vp.width || 1, H = vp.height || 1;
    var x = clamp(rect[2] / W * 100, 0, 100), y = clamp((rect[1] + rect[3]) / 2 / H * 100, 0, 100);
    b.style.left = "min(" + x.toFixed(3) + "%, calc(100% - 18px))";
    b.style.top = y.toFixed(3) + "%";
    b.addEventListener("click", function (ev) { ev.preventDefault(); ev.stopPropagation(); focusCard(p.id); });
    return b;
  }
  function drawHighlights(i) {
    if (!st || !dom) return false;
    var view = tryCall(function () { return M.pdfview.pageView(i); });
    if (!view || !view.el) return false;
    var vp = view.viewport || viewportOf(i);
    if (!vp) return false;
    var pageEl = view.el;
    var layer = ensureLayer(pageEl, "hlLayer");
    layer.textContent = "";
    var frag = document.createDocumentFragment(), badges = 0;
    var entries = anchorsOnPage(i);
    for (var k = 0; k < entries.length; k++) {
      var p = entries[k].prompt, a = p.anchor;
      if (entries[k].note) {
        if (typeof a.y !== "number") continue;
        var pt = tryCall(function () { return vp.convertToViewportPoint(0, a.y); });
        if (!pt) continue;
        var tri = el("div", "hl-note");
        tri.dataset.id = p.id;
        tri.style.top = clamp(pt[1] / (vp.height || 1) * 100, 0, 100).toFixed(3) + "%";
        frag.appendChild(tri);
        continue;
      }
      var rects = viewportRectsFor(a, i, vp);
      var cls = "hl";
      if (p.kind === "highlight") cls += " hl--plain";
      if (p.flagged) cls += " hl--flag";
      if (st.hot === p.id) cls += " hl--active";
      if (st.pendingPulse && st.pendingPulse.id === p.id) cls += " hl--pulse";
      for (var r = 0; r < rects.length; r++) {
        var div = el("div", cls);
        div.dataset.id = p.id;
        placeRect(div, rects[r], vp, true);
        frag.appendChild(div);
      }
      if (rects.length && lastPageOf(a) === i) { frag.appendChild(badgeFor(p, rects[rects.length - 1], vp)); badges++; }
    }
    if (st.find.pageRects && st.find.pageRects.page === i) {
      var fr = st.find.pageRects.items;
      for (var m = 0; m < fr.length; m++) {
        var vrects = pdfRectsToViewport(fr[m].rects, vp);
        for (var q = 0; q < vrects.length; q++) {
          var fd = el("div", "hl hl--find" + (fr[m].current ? " hl--find-current" : ""));
          placeRect(fd, vrects[q], vp, true);
          frag.appendChild(fd);
        }
      }
    }
    layer.appendChild(frag);
    if (badges) layer.removeAttribute("aria-hidden"); else layer.setAttribute("aria-hidden", "true");   // the badges are real buttons
    // No .dimLayer here: M.pdfview owns that layer (adds it on render while dimPages is on and on every
    // dimPages change, removes it when off); a second one from the reader would dim the page twice.
    if (st.textEmpty.has(i)) pageEl.setAttribute("data-notext", ""); else pageEl.removeAttribute("data-notext");
    if (st.pendingPulse && st.pendingPulse.id && layer.querySelector(".hl--pulse")) {
      schedulePulseEnd(layer.querySelectorAll(".hl--pulse"));
      st.pendingPulse = null;
    }
    if (st.pendingFlash && st.pendingFlash.pageIndex === i) { var fa = st.pendingFlash; st.pendingFlash = null; drawTransient(view, fa); }
    return true;
  }
  function redrawAll() {
    if (!st) return;
    var rp = renderedPages();
    for (var k = 0; k < rp.length; k++) drawHighlights(rp[k]);
  }
  // "Dim pages" (D): the .dimLayer of each page belongs to M.pdfview; the reader only sets .reader--dim on
  // #reader, which shows those layers (css/reader.css).
  function applyDim() {
    if (!dom) return;
    dom.reader.classList.toggle("reader--dim", !!setting("dimPages", false));
  }
  function schedulePulseEnd(nodes) {
    var list = Array.prototype.slice.call(nodes);
    setTimeout(function () { for (var k = 0; k < list.length; k++) list[k].classList.remove("hl--pulse"); }, PULSE_MS + 50);
  }
  function pulse(promptId) {
    if (!st || !promptId) return false;
    var nodes = dom.pages.querySelectorAll(".hl[data-id=\"" + cssEscape(promptId) + "\"]");
    if (nodes.length) {
      for (var k = 0; k < nodes.length; k++) { nodes[k].classList.remove("hl--pulse"); void nodes[k].offsetWidth; nodes[k].classList.add("hl--pulse"); }
      schedulePulseEnd(nodes);
      return true;
    }
    st.pendingPulse = { id: promptId, at: Date.now() };
    return true;
  }
  function drawTransient(view, anchor) {
    var vp = view.viewport || viewportOf(anchor.pageIndex);
    if (!vp) return;
    var layer = ensureLayer(view.el, "hlLayer");
    var rects = viewportRectsFor(anchor, anchor.pageIndex, vp), made = [];
    if (!rects.length && typeof anchor.y === "number") {
      var pt = tryCall(function () { return vp.convertToViewportPoint(0, anchor.y); });
      if (pt) rects = [[0, Math.max(0, pt[1] - 2), vp.width || 0, pt[1] + 2]];
    }
    for (var r = 0; r < rects.length; r++) {
      var div = el("div", "hl hl--pulse hl--transient");
      placeRect(div, rects[r], vp, true);
      layer.appendChild(div);
      made.push(div);
    }
    setTimeout(function () { for (var k = 0; k < made.length; k++) if (made[k].parentNode) made[k].parentNode.removeChild(made[k]); }, PULSE_MS + 50);
  }
  function anchorOwnerId(anchor) {
    var list = livePrompts();
    for (var k = 0; k < list.length; k++) if (list[k].anchor === anchor) return list[k].id;
    for (var j = 0; j < list.length; j++) {
      var a = list[j].anchor;
      if (a && a.pageIndex === anchor.pageIndex && a.quote === anchor.quote && a.y === anchor.y && (a.quote || a.y != null)) return list[j].id;
    }
    return null;
  }
  function goToAnchor(anchor, opts) {
    if (!st || !anchor) return false;
    var n = numPages(), i = anchor.pageIndex;
    if (typeof i !== "number" || i < 0 || i >= n) return false;
    var rect = firstRect(anchor, i);
    var yPdf = rect ? rect[3] : (typeof anchor.y === "number" ? anchor.y : null);
    var vp = viewportOf(i);
    if (!vp || yPdf == null) {
      if (yPdf == null) tryCall(function () { M.pdfview.scrollTo({ pageIndex: i, fraction: 0 }); });
      else scrollToPdfY(i, yPdf, 1 / 3, rect);
      st.pendingGoto = { anchor: anchor };       // re-run once pages are measured
    } else {
      scrollToPdfY(i, yPdf, 1 / 3, rect);        // sideways too: the passage never lands under a pinned margin
    }
    updatePageBox(i);
    if (opts && opts.flash) {
      var id = anchorOwnerId(anchor);
      if (id) pulse(id);
      else {
        var view = tryCall(function () { return M.pdfview.pageView(i); });
        if (view && view.el) drawTransient(view, anchor); else st.pendingFlash = anchor;
      }
    }
    return true;
  }

  // ---------- text index, scanned pages, re-finding (SPEC §5, §11) ----------
  function getTextIndex(i) {
    if (!st) return Promise.reject(mkErr("closed", "No document is open"));
    var cached = st.textIndexes.get(i);
    if (cached) return cached;
    var p = Promise.resolve().then(function () { return M.pdfview.textIndex(i); }).then(function (ti) {
      if (!ti || !Array.isArray(ti.items)) return null;
      return ti;
    });
    p.catch(function () { if (st) st.textIndexes.delete(i); });
    st.textIndexes.set(i, p);
    return p;
  }
  function noteTextState(i, ti) {
    if (!st) return;
    var empty = !ti || !ti.items || ti.items.length === 0;
    if (empty) {
      st.textEmpty.add(i);
      var view = tryCall(function () { return M.pdfview.pageView(i); });
      if (view && view.el) view.el.setAttribute("data-notext", "");
      if (!st.textSeen && !st.chipShown) {
        st.chipShown = true;
        showChip("No text layer — use free notes (double-click the margin) and snips");
      }
    } else {
      st.textEmpty.delete(i);
      st.textSeen = true;
      if (st.chipShown) hideChip();
    }
  }
  function needsRefind(a) {
    return !!a && typeof a.quote === "string" && a.quote.length > 0 && (a.lost === true || !Array.isArray(a.pages) || a.pages.length === 0);
  }
  function scheduleRefinds(p) {
    if (!st) return;
    var list = livePrompts();
    for (var k = 0; k < list.length; k++) {
      var a = list[k].anchor;
      if (!needsRefind(a) || typeof a.pageIndex !== "number") continue;
      if (Math.abs(a.pageIndex - p) > 2) continue;
      if (st.refindDone.has(list[k].id) || st.refindBusy.has(list[k].id)) continue;
      refindPrompt(list[k]);
    }
  }
  // tries the anchor's page, then ±1, then ±2 (SPEC §5); a hit is saved with the page it was found on
  function refindPrompt(prompt) {
    var a = prompt.anchor, q = a.pageIndex, n = numPages();
    if (q >= n || q < 0) { st.refindDone.add(prompt.id); return; }
    var order = [q, q - 1, q + 1, q - 2, q + 2].filter(function (k) { return k >= 0 && k < n; });
    var k = 0;
    st.refindBusy.add(prompt.id);
    function finish(found, page) {
      if (!st) return;
      st.refindBusy.delete(prompt.id);
      st.refindDone.add(prompt.id);
      if (!found) return;
      found.pageIndex = page;
      if (Array.isArray(found.pages)) for (var j = 0; j < found.pages.length; j++) if (found.pages[j]) found.pages[j].pageIndex = page;
      found.lost = false;
      var live = tryCall(function () { return M.cache.prompt(prompt.id); }) || prompt;
      if (live.deletedAt) return;
      live.anchor = found;
      if (live.context && typeof live.context === "object" && live.context.pageIndex !== page) {
        live.context.pageIndex = page;
        live.context.pageLabel = pageLabelOf(page);
      }
      var r = tryCall(function () { return M.cache.savePrompt(live, { content: true }); });
      Promise.resolve(r).catch(noop);
    }
    function next() {
      if (!st || k >= order.length) { finish(null); return; }
      var page = order[k++];
      getTextIndex(page).then(function (ti) {
        if (!st) return;
        if (!ti || !ti.items || !ti.items.length) { next(); return; }
        var found = null;
        try { found = M.anchors.refind(a, ti, page); } catch (e) { found = null; }
        if (found && typeof found === "object") finish(found, page); else next();
      }, function () { next(); });
    }
    next();
  }

  // ---------- find (SPEC §3: Cmd+F, Enter / Shift+Enter cycle, Esc closes) ----------
  function newFindState() { return { query: "", matches: [], index: -1, seq: 0, pageRects: null }; }
  // PDF-space rects of text offsets [start, end) from the page's text index (item boxes, SPEC §5 defaults)
  function rectsForOffsets(ti, start, end) {
    var out = [];
    if (!ti || !Array.isArray(ti.items) || !Array.isArray(ti.starts)) return out;
    for (var k = 0; k < ti.items.length; k++) {
      var it = ti.items[k], s = ti.starts[k];
      if (!it || typeof s !== "number") continue;
      var len = (it.str || "").length;
      if (!len) continue;
      var e = s + len, a = Math.max(start, s), b = Math.min(end, e);
      if (a >= b) continue;
      var x = Number(it.x) || 0, y = Number(it.y) || 0, w = Number(it.width) || 0, h = Number(it.height) || 0;
      var x1 = x + w * ((a - s) / len), x2 = x + w * ((b - s) / len);
      out.push([x1, y + DESCENT * h, x2, y + ASCENT * h]);
    }
    return out;
  }
  function updateFindCount(text) {
    if (!dom) return;
    if (typeof text === "string") { dom.findCount.textContent = text; return; }
    var f = st ? st.find : null;
    if (!f || !f.query.trim()) { dom.findCount.textContent = ""; return; }
    dom.findCount.textContent = f.matches.length ? ((f.index + 1) + "/" + f.matches.length) : "No matches";
  }
  function clearFindRects() {
    if (!st) return;
    var page = st.find.pageRects ? st.find.pageRects.page : -1;
    st.find.pageRects = null;
    if (page >= 0) drawHighlights(page);
  }
  function setFind(query) {
    if (!st) return false;
    query = query == null ? "" : String(query);
    st.find.query = query;
    var seq = ++st.find.seq;
    clearFindRects();
    st.find.matches = []; st.find.index = -1;
    if (dom.findInput && dom.findInput.value !== query) dom.findInput.value = query;
    if (!query.trim()) { updateFindCount(); return true; }
    updateFindCount("…");
    Promise.resolve().then(function () { return M.pdfview.find(query); }).then(function (matches) {
      if (!st || seq !== st.find.seq) return;
      matches = Array.isArray(matches) ? matches.filter(function (m) { return m && typeof m.pageIndex === "number"; }) : [];
      st.find.matches = matches;
      var cur = currentPage(), idx = -1;
      for (var k = 0; k < matches.length; k++) if (matches[k].pageIndex >= cur) { idx = k; break; }
      if (idx < 0 && matches.length) idx = 0;
      st.find.index = idx;
      updateFindCount();
      if (idx >= 0) goToMatch(idx);
    }, function () { if (st && seq === st.find.seq) { st.find.matches = []; updateFindCount(); } });
    return true;
  }
  function findStep(dir) {
    if (!st) return false;
    var n = st.find.matches.length;
    if (!n) { if (st.find.query.trim() && dom.findInput.value !== st.find.query) setFind(dom.findInput.value); return false; }
    var idx = ((st.find.index + dir) % n + n) % n;
    goToMatch(idx);
    return true;
  }
  function goToMatch(idx) {
    var m = st.find.matches[idx];
    if (!m) return;
    st.find.index = idx;
    updateFindCount();
    var seq = st.find.seq, page = m.pageIndex;
    getTextIndex(page).then(function (ti) {
      if (!st || seq !== st.find.seq) return;
      var prev = st.find.pageRects ? st.find.pageRects.page : -1;
      var items = [];
      for (var k = 0; k < st.find.matches.length; k++) {
        var mm = st.find.matches[k];
        if (mm.pageIndex !== page) continue;
        items.push({ rects: rectsForOffsets(ti, mm.start, mm.end), current: k === idx });
      }
      st.find.pageRects = { page: page, items: items };
      if (prev >= 0 && prev !== page) drawHighlights(prev);
      drawHighlights(page);
      var cur = null;
      for (var j = 0; j < items.length; j++) if (items[j].current && items[j].rects.length) { cur = items[j].rects[0]; break; }
      if (cur) scrollToPdfY(page, cur[3], 1 / 3, cur);       // inside the page band, not under a pinned margin
      else tryCall(function () { M.pdfview.scrollTo({ pageIndex: page, fraction: 0 }); });
      updatePageBox(page);
    }, noop);
  }
  function openFind() {
    if (!st || !dom.find) return false;
    closeMenu();
    hideAdder();
    dom.find.classList.remove("is-hidden");
    positionFloating();
    dom.findInput.value = st.find.query;
    dom.findInput.focus();
    tryCall(function () { dom.findInput.select(); });
    st.findOpen = true;
    return true;
  }
  function closeFind(refocus) {
    if (!st || !st.findOpen) return false;
    st.findOpen = false;
    dom.find.classList.add("is-hidden");
    st.find.seq++;
    clearFindRects();
    st.find.matches = []; st.find.index = -1;
    updateFindCount();
    if (refocus) focusReader();
    return true;
  }

  // ---------- zoom (SPEC §2) ----------
  function currentScale() {
    var s = Number(tryCall(function () { return M.pdfview.getScale(); }));
    return (isFinite(s) && s > 0) ? s : (typeof st.scale === "number" ? st.scale : 1);
  }
  function nextLadderStep(scale, dir) {
    var L = ZOOM_LADDER, k;
    if (dir > 0) { for (k = 0; k < L.length; k++) if (L[k] > scale + 1e-3) return L[k]; }
    else { for (k = L.length - 1; k >= 0; k--) if (L[k] < scale - 1e-3) return L[k]; }
    return null;
  }
  // The fit-width scale for the column as it is now (M.pdfview.fitScale(), computed on demand), or null.
  function fitNow() {
    var f = Number(tryCall(function () { return M.pdfview.fitScale(); }));
    return isFinite(f) && f > 0 ? f : null;
  }
  // Stack mode clamps the zoom to fit width (SPEC §2). The cap is the fit for the column now, never a value kept from
  // another width or mode (after a resize from a manual zoom, or a book reopened with a saved zoom, a stale or
  // missing cap let the page outgrow the 400-px column, whose overflow-x is hidden). null outside stack.
  function stackCap() { return st && st.mode === "stack" ? fitNow() : null; }
  // Stack mode never scrolls sideways: a leftover scrollLeft could not be scrolled back there.
  function resetScrollX() { if (st && st.mode === "stack" && dom.scroller.scrollLeft) dom.scroller.scrollLeft = 0; }
  function zoomStep(dir) {
    if (!st) return false;
    cancelPinch();
    var s = currentScale(), next = nextLadderStep(s, dir), cap = stackCap();
    if (next == null) return false;
    if (cap != null && next > cap + 1e-3) {                  // stack: clamped to fit width
      if (st.zoom === "fit" || s >= cap - 1e-3) return false;
      st.zoom = "fit";
      tryCall(function () { M.pdfview.setScale("fit"); });
    } else {
      st.zoom = next;
      tryCall(function () { M.pdfview.setScale(next); });
    }
    resetScrollX();
    updateZoomReadout();
    return true;
  }
  // → false when the page is already at fit width: Cmd/Ctrl+0 then reaches the browser, which resets its own
  // page zoom (BUILD-NOTES "Post-review decisions"); the toolbar buttons ignore the result.
  function zoomFit() {
    if (!st) return false;
    cancelPinch();
    var already = st.zoom === "fit" && tryCall(function () { return M.pdfview.scaleMode(); }, "fit") !== "manual";
    st.zoom = "fit";
    if (!already) tryCall(function () { M.pdfview.setScale("fit"); });
    updateZoomReadout();
    return !already;
  }
  // Applies st.zoom: "fit", or the manual scale (shown at fit width in stack while it is wider). opts go to
  // M.pdfview.setScale: {gesture: true} for a width change (placeholders resize now, pages re-render once idle).
  function applyZoom(opts) {
    if (!st) return;
    var z = st.zoom, cap = stackCap();
    if (z === "fit" || (cap != null && typeof z === "number" && z > cap)) tryCall(function () { M.pdfview.setScale("fit", opts); });
    else tryCall(function () { M.pdfview.setScale(z, opts); });
    resetScrollX();
    updateZoomReadout();
  }

  // ---------- pinch zoom: ctrl+wheel (Chrome / Brave trackpad pinch), gesture events (Safari) ----------
  // Without these the browser zooms the whole page (visual or page zoom) and the margin leaves the screen.
  // Steps are merged and applied at most once per animation frame, anchored at the pointer, through
  // M.pdfview.setScale(scale, {anchor, gesture: true}), which re-renders only once the gesture is idle.
  function wheelFactor(deltaY, deltaMode) {
    var dy = Number(deltaY) || 0;
    if (deltaMode === 1) dy *= 16; else if (deltaMode === 2) dy *= 400;   // lines / pages → px
    return Math.exp(-clamp(dy, -PINCH_MAX_DELTA, PINCH_MAX_DELTA) * PINCH_K);
  }
  function scaleBounds() {
    var pv = M.pdfview || {};
    return [isFinite(pv.MIN_SCALE) ? pv.MIN_SCALE : 0.2, isFinite(pv.MAX_SCALE) ? pv.MAX_SCALE : 8];
  }
  // abs: an absolute target (Safari: start scale · ev.scale), or null to multiply the current scale by factor
  function queuePinch(abs, factor, clientX, clientY) {
    var p = st.pinch || (st.pinch = { abs: null, factor: 1, x: 0, y: 0, raf: 0 });
    if (abs != null) { p.abs = abs; p.factor = 1; } else p.factor *= factor;
    p.x = clientX; p.y = clientY;
    if (!p.raf) p.raf = raf(applyPinch);
  }
  function cancelPinch() {
    if (!st || !st.pinch) return;
    if (st.pinch.raf) caf(st.pinch.raf);
    st.pinch = null;
  }
  function applyPinch() {
    if (!st || !st.pinch) return;
    var p = st.pinch;
    st.pinch = null;
    var base = currentScale(), b = scaleBounds(), cap = stackCap();
    var target = clamp((p.abs != null ? p.abs : base) * p.factor, b[0], b[1]);
    // a step that changes nothing (Safari scale 1 or a rotation, a pinch held at a bound) leaves the zoom alone: at fit
    // width the page keeps following the window
    if (Math.abs(target - base) < 1e-4) return;
    var opts = { anchor: { clientX: p.x, clientY: p.y }, gesture: true };
    if (cap != null && target >= cap - 1e-3) {             // stack: clamped to fit width (SPEC §2)
      if (st.zoom === "fit" && Math.abs(base - cap) < 1e-3) return;
      st.zoom = "fit";
      tryCall(function () { M.pdfview.setScale("fit", opts); });
    } else {
      st.zoom = target;                                   // manual, as with the − / + buttons
      tryCall(function () { M.pdfview.setScale(target, opts); });
    }
    resetScrollX();
    updateZoomReadout();
  }
  function onWheel(ev) {
    if (!st || !st.doc || !ev.ctrlKey) return;
    ev.preventDefault();                                  // never the browser's zoom, even for a step that zooms nothing
    if (st.gesture) return;                               // Safari: the gesture events carry this pinch
    if (!(Number(ev.deltaY) || 0)) return;                // a sideways ctrl+wheel (deltaY 0): nothing to zoom
    queuePinch(null, wheelFactor(ev.deltaY, ev.deltaMode), ev.clientX, ev.clientY);
  }
  function onGestureStart(ev) {
    if (!st || !st.doc) return;
    ev.preventDefault();
    st.gesture = { start: currentScale() };
  }
  function onGestureChange(ev) {
    if (!st || !st.doc) return;
    ev.preventDefault();
    if (!st.gesture) st.gesture = { start: currentScale() };
    var s = Number(ev.scale);
    if (s > 0) queuePinch(st.gesture.start * s, 1, ev.clientX, ev.clientY);
  }
  function onGestureEnd(ev) {
    if (!st) return;
    if (st.doc) ev.preventDefault();
    st.gesture = null;
  }

  // ---------- breakpoints (SPEC §2 + BUILD-NOTES): measured on #reader, never window.innerWidth ----------
  function modeFor(width) { return width >= MODE_WIDE ? "wide" : width >= MODE_RAIL ? "rail" : "stack"; }
  // {mode, compact}: compact is wide below COMPACT_BELOW (M.reader.mode() still says "wide")
  function layoutFor(width) {
    var mode = modeFor(width);
    return { mode: mode, compact: mode === "wide" && width < COMPACT_BELOW };
  }
  function applyMode(width) {
    if (!st) return;
    if (!(width > 0)) return;
    var lay = layoutFor(width), mode = lay.mode, compact = lay.compact;
    dom.reader.classList.toggle("reader--wide", mode === "wide");
    dom.reader.classList.toggle("reader--rail", mode === "rail");
    dom.reader.classList.toggle("reader--stack", mode === "stack");
    dom.reader.classList.toggle("reader--compact", compact);
    var changed = mode !== st.mode || compact !== st.compact, resized = width !== st.width;
    st.mode = mode;
    st.compact = compact;
    st.width = width;
    if (changed) emit("reader:mode", { mode: mode, compact: compact });
    // The zoom follows every width change inside this ResizeObserver callback (after layout, before paint), and
    // pdfview's fit reads #margin.offsetWidth: no frame shows a fit for the old width or margin (no margin pinned
    // over a page that should fit, no flicker of its rule through a window drag). A breakpoint re-renders at once;
    // any other width change is a gesture step (placeholders resize now, pages re-render once the drag has been idle
    // 150 ms, so a drag never queues a render per frame). A manual zoom stays as it is, except stack's clamp to fit.
    if (st.doc) {
      if (changed) applyZoom();
      else if (resized && (st.zoom === "fit" || mode === "stack")) applyZoom({ gesture: true });
    }
    fitToolbar();
    positionFloating();
  }
  function observeSize() {
    var w = dom.reader.getBoundingClientRect().width || window.innerWidth;
    applyMode(w);
    if (typeof ResizeObserver !== "function") {
      var fn = function () { if (st) applyMode(dom.reader.getBoundingClientRect().width); };
      listen(window, "resize", fn);
      return;
    }
    st.ro = new ResizeObserver(function (entries) {
      if (!st) return;
      var e = entries && entries[0];
      var width = e && e.contentRect ? e.contentRect.width : dom.reader.getBoundingClientRect().width;
      applyMode(width);
    });
    st.ro.observe(dom.reader);
  }

  // ---------- persisted toggles (SPEC §3: A / M / D) ----------
  function toggleDim() {
    var v = !setting("dimPages", false);
    setSetting("dimPages", v);
    applyDim();
    return true;
  }
  function toggleAnswers() {
    var shown = setting("marginAnswers", true) !== false;
    setSetting("marginAnswers", !shown);
    tryCall(function () { M.margin.setAnswersHidden(shown); });
    return true;
  }
  function toggleMarkers() {
    var mode = setting("marginMode", "cards") === "markers" ? "cards" : "markers";
    setSetting("marginMode", mode);
    tryCall(function () { M.margin.setMode(mode); });
    return true;
  }
  function toggleList() {
    if (!M.list) return false;
    var open = !!tryCall(function () { return M.list.isOpen(); }, false);
    tryCall(function () { if (open) M.list.close(); else M.list.open(st.id, { host: dom.list }); });
    return true;
  }

  // ---------- position persistence (SPEC §8: lastPosition) ----------
  // A place in a book as a tab keeps it (D30): {pageIndex, fraction, zoom}, or null for anything else.
  function validPosition(p) {
    if (!p || typeof p !== "object" || typeof p.pageIndex !== "number" || !isFinite(p.pageIndex) || p.pageIndex < 0) return null;
    return {
      pageIndex: Math.floor(p.pageIndex),
      fraction: typeof p.fraction === "number" && isFinite(p.fraction) ? clamp(p.fraction, 0, 1) : 0,
      zoom: typeof p.zoom === "number" && p.zoom > 0 && isFinite(p.zoom) ? p.zoom : "fit"
    };
  }
  // The open book's place now (null without an open book, or before its first page is placed). Once the document is
  // open it is read from the view itself: st.lastPos follows scroll:settled, which comes a second after the last scroll.
  function position() {
    if (!st) return null;
    var live = st.doc ? tryCall(function () { return M.pdfview.currentPage(); }) : null;
    var p = live && typeof live.pageIndex === "number" ? live : st.lastPos;
    return p ? validPosition({ pageIndex: p.pageIndex, fraction: p.fraction, zoom: st.zoom }) : null;
  }
  // D31: a window of the Mac app that is not the writer for now (M.store.locked() says "window") cannot store the
  // place. It holds it back (unsaved()) and stores it when the role comes (store:writer, below).
  function readerWindow() {
    var l = tryCall(function () { return M.store.locked(); });
    return !!l && l.reason === "window";
  }
  function unsaved() { return !!(st && st.placeHeld); }
  function savePosition() {
    if (!st || !st.lastPos) return;
    var c = collection();
    if (!c) return;
    if (readerWindow()) { st.placeHeld = true; return; }
    st.placeHeld = false;
    c.lastPosition = { pageIndex: st.lastPos.pageIndex, fraction: st.lastPos.fraction, zoom: st.zoom };
    var r = tryCall(function () { return M.cache.saveCollection(c); });
    Promise.resolve(r).catch(noop);
  }
  // A small picture of what the book shows now (the pages in view), for a tab that is dragged (js/tabs.js, D31):
  // a canvas of at most w × h CSS pixels, or null (no book open, no page drawn yet, no canvas).
  function snapshot(w, h) {
    if (!st || !st.doc || !dom || !(w > 0) || !(h > 0)) return null;
    try {
      var view = dom.scroller.getBoundingClientRect(), col = dom.pages.getBoundingClientRect();
      var left = Math.max(view.left, col.left), right = Math.min(view.right, col.right);
      if (!(right > left) || !(view.height > 0)) return null;
      var scale = w / (right - left), height = Math.min(h, Math.round(view.height * scale));
      var dpr = typeof window !== "undefined" && window.devicePixelRatio > 0 ? Math.min(3, window.devicePixelRatio) : 1;
      var out = document.createElement("canvas"), g = out && typeof out.getContext === "function" ? out.getContext("2d") : null;
      if (!g) return null;
      out.width = Math.round(w * dpr);
      out.height = Math.round(height * dpr);
      g.scale(dpr, dpr);
      var drew = false, list = dom.pages.querySelectorAll("canvas");
      for (var i = 0; i < list.length; i++) {
        var cv = list[i], r = cv.getBoundingClientRect();
        if (!cv.width || !cv.height || !(r.width > 0) || !(r.height > 0)) continue;
        var x0 = Math.max(r.left, left), x1 = Math.min(r.right, right), y0 = Math.max(r.top, view.top), y1 = Math.min(r.bottom, view.top + height / scale);
        if (!(x1 > x0) || !(y1 > y0)) continue;                       // not in view
        g.drawImage(cv, (x0 - r.left) / r.width * cv.width, (y0 - r.top) / r.height * cv.height, (x1 - x0) / r.width * cv.width, (y1 - y0) / r.height * cv.height,
          (x0 - left) * scale, (y0 - view.top) * scale, (x1 - x0) * scale, (y1 - y0) * scale);
        drew = true;
      }
      return drew ? out : null;
    } catch (e) { return null; }
  }
  function focusReader() {
    if (!dom) return;
    try { dom.reader.focus({ preventScroll: true }); } catch (e) { tryCall(function () { dom.reader.focus(); }); }
    tryCall(function () { M.app.setFocusOwner("reader"); });
  }

  // ---------- event wiring for the open document (SPEC §17.3) ----------
  function wireBus() {
    sub("page:rendered", function (e) {
      if (!st || !e || typeof e.pageIndex !== "number") return;
      drawHighlights(e.pageIndex);
      if (st.pendingPulse && Date.now() - st.pendingPulse.at > 15000) st.pendingPulse = null;
    });
    sub("page:textready", function (e) {
      if (!st || !e || typeof e.pageIndex !== "number") return;
      var i = e.pageIndex;
      getTextIndex(i).then(function (ti) {
        if (!st) return;
        noteTextState(i, ti);
        scheduleRefinds(i);
        if (st.find.pageRects && st.find.pageRects.page === i) drawHighlights(i);
      }, noop);
    });
    sub("pages:measured", function () {
      if (!st) return;
      if (st.pendingGoto) { var g = st.pendingGoto; st.pendingGoto = null; goToAnchor(g.anchor, { flash: false }); }
      positionFloating();
      updatePageBox();
    });
    sub("scale:changed", function (e) {
      if (!st) return;
      var s = e && typeof e.scale === "number" ? e.scale : currentScale();
      st.scale = s;
      updateZoomReadout();
      redrawAll();
      positionFloating();
    });
    sub("scroll:settled", function (e) {
      if (!st || !e || typeof e.pageIndex !== "number") return;
      st.lastPos = { pageIndex: e.pageIndex, fraction: typeof e.fraction === "number" ? e.fraction : 0 };
      savePosition();
      updatePageBox();
    });
    // A prompt moved out of this book ("Move to…" in a card menu or the prompt list) is saved with the
    // deck's collectionId and no anchor: it still has to leave the hit index and the page layers, so a
    // save of any prompt this book holds (st.knownIds, kept by rebuildRects) rebuilds as well.
    sub("prompt:saved", function (e) {
      if (!st || !e || !e.prompt) return;
      if (e.prompt.collectionId !== st.id && !st.knownIds.has(e.prompt.id)) return;
      rebuildRects();
      redrawAll();
      if (st.hot && !st.knownIds.has(st.hot)) st.hot = null;   // its .hl divs are gone with the redraw
    });
    sub("prompt:deleted", function (e) { if (st && e && e.collectionId === st.id) { rebuildRects(); redrawAll(); } });
    sub("prompt:restored", function (e) { if (st && e && e.collectionId === st.id) { rebuildRects(); redrawAll(); } });
    sub("collection:changed", function (e) { if (st && e && e.collectionId === st.id) updateToolbar(); });
    // D31: this window is the writer again: the place it held back is stored
    sub("store:writer", function (e) { if (st && e && e.writer === true && st.placeHeld) savePosition(); });
    sub("collection:deleted", function (e) { if (st && e && e.collectionId === st.id) routeTo("library"); });
    sub("editor:opened", function () { if (st) hideAdder(); });
    sub("editor:closed", function () {
      if (!st) return;
      clearSelection(true);
      var ae = document.activeElement;
      if (!ae || ae === document.body || !dom.reader.contains(ae)) focusReader();
    });
    sub("snip:state", function (e) { if (st) { updateSnipUi(e || null); if (e && e.armed) hideAdder(); } });
    // card → highlight direction of the hover sync (margin emits margin:hot {promptId|null} on card hover/leave;
    // setHot calls M.margin.setHot, which does not emit, so there is no echo)
    sub("margin:hot", function (e) { if (st) setHot(e && e.promptId != null ? e.promptId : null); });
    sub("settings:changed", function (e) {
      if (!st || !e) return;
      if (e.key === "dimPages") applyDim();
      else if (e.key === "snipMode") updateSnipUi(null);
      else if (e.key === "visionModel" || e.key === "apiKey") refreshLatexAvailability();
      else if (e.key === "obsidian") {               // D32: the switch in Settings › Obsidian
        syncAdder();
        if (st.adderVisible) positionAdderFromSelection();   // one button more or less: the adder takes its place again
      }
    });
  }
  function wireDom() {
    listen(dom.scroller, "scroll", function () {
      if (!st || st.scrollRaf) return;
      st.scrollRaf = raf(function () {
        if (!st) return;
        st.scrollRaf = 0;
        updatePageBox();
        if (st.adderVisible) positionAdderFromSelection();
        if (st.chapter) positionChapterField();
        if (st.menu) closeMenu();
      });
    }, { passive: true });
    // pinch zoom: on the scroller, and on the snip overlay that covers the pages while snip mode is armed
    var overlay = document.getElementById("snipOverlay");
    [dom.scroller, overlay].forEach(function (target) {
      if (!target) return;
      listen(target, "wheel", onWheel, { passive: false });
      listen(target, "gesturestart", onGestureStart, { passive: false });
      listen(target, "gesturechange", onGestureChange, { passive: false });
      listen(target, "gestureend", onGestureEnd, { passive: false });
    });
  }

  // ---------- open / close (SPEC §17.2) ----------
  function engineMessage(err) {
    var code = err && err.code;
    if (code === "no_pdfjs") return "PDF engine not loaded — reload when online";
    if (code === "password") return "This PDF needs a password that was not given";
    if (code === "invalid") return "This file could not be opened as a PDF";
    if (code === "no_bytes") return "PDF not in library — choose the file again from the library";
    if (code === "not_found") return "This book is not in the library";
    if (code === "not_book") return "Decks open on their own page, not in the reader";
    return "Could not open the document" + (err && err.message ? " — " + err.message : "");
  }
  // fresh: the document was just opened (it may fall back to the saved last position); otherwise the book was open
  // already and a navigation that finds nothing to go to keeps the reader where it is.
  function navigateTo(opts, fresh) {
    var c = collection(), n = numPages();
    if (opts && opts.promptId) {
      var p = tryCall(function () { return M.cache.prompt(opts.promptId); });
      if (!p || p.deletedAt || !st || p.collectionId !== st.id) {
        // a prompt link (#reader/<cid>/<pid>, an Obsidian note's "Open in Marginalia") to a deleted or moved note
        toast("That note is no longer in this book");
        if (!fresh) return;
      } else if (p.anchor) { goToAnchor(p.anchor, { flash: true }); focusCard(p.id); return; }
      else if (p.context && typeof p.context.pageIndex === "number") { tryCall(function () { M.pdfview.scrollTo({ pageIndex: clamp(p.context.pageIndex, 0, n - 1), fraction: 0 }); }); focusCard(p.id); return; }
      else { focusCard(p.id); if (!fresh) return; }
    }
    if (opts && typeof opts.pageIndex === "number" && n) {
      tryCall(function () { M.pdfview.scrollTo({ pageIndex: clamp(Math.floor(opts.pageIndex), 0, n - 1), fraction: 0 }); });
      return;
    }
    // a tab's own place (D30) goes before the book's last position, also when the book is open already (another tab
    // of the same book was on screen)
    var own = opts ? validPosition(opts.position) : null;
    if (!fresh && !own) return;
    // that tab's zoom too (also at the end of an open: a second tab of the book can ask while the book still loads)
    if (own && own.zoom !== st.zoom) { cancelPinch(); st.zoom = own.zoom; applyZoom(); }
    var lp = own || (c && c.lastPosition);
    if (lp && typeof lp.pageIndex === "number" && n) {
      var frac = typeof lp.fraction === "number" ? clamp(lp.fraction, 0, 1) : 0;
      tryCall(function () { M.pdfview.scrollTo({ pageIndex: clamp(lp.pageIndex, 0, n - 1), fraction: frac }); });
      st.lastPos = { pageIndex: clamp(lp.pageIndex, 0, n - 1), fraction: frac };
    }
  }
  function open(collectionId, opts) {
    opts = opts || {};
    if (typeof document === "undefined") return Promise.reject(mkErr("no_dom", "The reader needs a document"));
    if (!mount()) return Promise.reject(mkErr("no_dom", "#reader is missing from index.html"));
    if (st && st.id === collectionId) {               // already open: only navigate (review's "Go to source")
      if (!st.doc) { st.navOpts = opts; return Promise.resolve(); }   // still loading: navigate once it is open
      navigateTo(opts, false);
      focusReader();
      return Promise.resolve();
    }
    // close() bumps openSeq itself (that is how it cancels an open still in flight), so this open takes
    // its ticket only after closing the other book: taken before, the guard below would always see
    // close()'s bump and drop this open silently (A torn down, B never loaded, no error).
    var prior = st ? close() : Promise.resolve();
    var seq = ++openSeq;
    return Promise.resolve(prior).then(function () {
      if (seq !== openSeq) return;
      var c = tryCall(function () { return M.cache.collection(collectionId); });
      if (!c || c.deletedAt) throw mkErr("not_found", "Unknown collection " + collectionId);
      if (c.kind && c.kind !== "book") throw mkErr("not_book", "Not a book");
      st = {
        id: collectionId, c: c, doc: null, zoom: "fit", scale: null, mode: null, compact: null, width: 0, ro: null,
        pinch: null, gesture: null,
        listeners: [], rectsByPage: new Map(), knownIds: new Set(), hot: null, lastMove: null, moveRaf: 0, scrollRaf: 0,
        find: newFindState(), findOpen: false, textIndexes: new Map(), textEmpty: new Set(), textSeen: false, chipShown: false,
        chipTimer: 0, lastPos: null, refindBusy: new Set(), refindDone: new Set(), menu: null, chapter: null, renaming: false,
        adderVisible: false, selectionRange: null, pendingPulse: null, pendingFlash: null, pendingGoto: null, page: 0,
        navOpts: null
      };
      api.selection = null;
      var lp = validPosition(opts.position) || c.lastPosition;        // a tab's own place first (D30)
      st.zoom = (lp && typeof lp.zoom === "number" && lp.zoom > 0) ? lp.zoom : "fit";
      updateToolbar();
      hidePill();
      applyDim();
      setPrep("Preparing document…");
      observeSize();
      wireBus();
      wireDom();
      rebuildRects();
      return Promise.resolve(tryCall(function () { return M.store.docs.loadBytes(c.id); })).then(function (bytes) {
        if (seq !== openSeq) return;
        if (!bytes || !bytes.byteLength) throw mkErr("no_bytes", "No PDF bytes stored for " + c.id);
        if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes.buffer || bytes);
        return M.pdfview.open(bytes, { container: dom.pages });
      }).then(function (doc) {
        if (seq !== openSeq || !st) return;
        st.doc = doc || {};
        updateToolbar();
        applyZoom();
        tryCall(function () { M.margin.mount(dom.scroller, dom.margin); });
        tryCall(function () { M.margin.setItems(M.cache.promptsOf(collectionId)); });
        tryCall(function () { M.margin.setMode(setting("marginMode", "cards") === "markers" ? "markers" : "cards"); });
        tryCall(function () { M.margin.setAnswersHidden(setting("marginAnswers", true) === false); });
        navigateTo(st.navOpts || opts, true);
        st.navOpts = null;
        redrawAll();
        c.lastOpenedAt = Date.now();
        Promise.resolve(tryCall(function () { return M.cache.saveCollection(c); })).catch(noop);
        setPrep(null);
        if (tryCall(function () { return M.review.isSuspended(); }, false)) showPill(lastRemaining);
        refreshLatexAvailability();
        focusReader();
        emit("doc:opened", { collectionId: collectionId });
      });
    }).catch(function (err) {
      // An open that close() or a newer open replaced: the engine ends its load with an error ("Worker was
      // destroyed"). That is no failure of the book. This open ends quietly, as a replaced open that got further
      // does; else M.app would take the error for the book's and go to the library, also when the same book is on
      // its way again (a tab change away and back while the book loads, D30).
      if (seq !== openSeq) return;
      if (st && st.id === collectionId) {
        var hadDoc = !!st.doc;
        setPrep(engineMessage(err), true);
        toast(engineMessage(err));
        teardown(st, false);
        st = null;
        if (hadDoc) tryCall(function () { M.pdfview.close(); });
      }
      throw (err instanceof Error) ? err : mkErr("open_failed", String(err));
    });
  }
  function teardown(s, emitClosed) {
    unsubAll();
    for (var k = 0; k < s.listeners.length; k++) unlisten(s.listeners[k]);
    s.listeners.length = 0;
    if (s.ro) tryCall(function () { s.ro.disconnect(); });
    if (s.moveRaf) caf(s.moveRaf);
    if (s.scrollRaf) caf(s.scrollRaf);
    if (s.pinch && s.pinch.raf) caf(s.pinch.raf);
    s.pinch = null; s.gesture = null;
    clearTimeout(s.chipTimer);
    if (s.menu && s.menu.el.parentNode) s.menu.el.parentNode.removeChild(s.menu.el);
    if (dom) {
      hideAdder(); hideChip(); hidePill();
      dom.find.classList.add("is-hidden");
      dom.chapter.classList.add("is-hidden");
      dom.rename.classList.add("is-hidden");
      dom.name.classList.remove("is-hidden");
      dom.reader.classList.remove("reader--dim");
      dom.hint.textContent = "";
    }
    api.selection = null;
    if (emitClosed) emit("doc:closed", { collectionId: s.id });
  }
  function close() {
    if (!st) return Promise.resolve();
    var s = st;
    openSeq++;
    savePosition();
    setPrep(null);
    teardown(s, false);
    st = null;
    var p = tryCall(function () { return M.pdfview.close(); });
    emit("doc:closed", { collectionId: s.id });
    return Promise.resolve(p).catch(noop);
  }

  // ---------- key actions (BUILD-NOTES key routing) and the Escape chain ----------
  function escape() {
    if (!st) return false;
    if (closeMenu()) { focusReader(); return true; }
    if (closeChapterField(true)) return true;
    if (st.renaming) { cancelRename(); return true; }
    if (st.findOpen) { closeFind(true); return true; }
    if (document.activeElement === dom.pageInput) { updatePageBox(); focusReader(); return true; }
    if (st.adderVisible || api.selection) { clearSelection(true); focusReader(); return true; }
    return false;
  }
  function run(id) {
    if (!st) return false;
    switch (id) {
      case "prompt": return createFromSelection("qa");
      case "cloze": return createFromSelection("cloze");
      case "highlight": return createFromSelection("highlight");
      case "obsidianNote": return createFromSelection("obsidian");
      case "find": return openFind();
      case "pageBox": focusPageBox(); return true;
      case "zoomIn": zoomStep(1); return true;
      case "zoomOut": zoomStep(-1); return true;
      case "zoomFit": return zoomFit();                 // false at fit already: the browser resets its zoom
      case "markChapter": return openChapterField();
      case "dim": return toggleDim();
      case "hideAnswers": return toggleAnswers();
      case "markers": return toggleMarkers();
      case "list": return toggleList();
      case "escape": return escape();
      default: return false;
    }
  }
  function mode() {
    if (st && st.mode) return st.mode;
    if (dom && dom.reader) { var w = dom.reader.getBoundingClientRect().width; if (w > 0) return modeFor(w); }
    return "wide";
  }

  var persistentWired = false;
  function wirePersistentBus() {
    if (persistentWired || !M.bus || typeof M.bus.on !== "function") return;
    persistentWired = true;
    M.bus.on("review:suspended", function (e) { lastRemaining = e && typeof e.remaining === "number" ? e.remaining : null; if (st) showPill(lastRemaining); });
    M.bus.on("review:resumed", function () { lastRemaining = null; hidePill(); });
    M.bus.on("review:ended", function () { lastRemaining = null; hidePill(); });
  }
  wirePersistentBus();

  // Is the book (this one, or any when no id is given) open with its document loaded? (D30: js/tabs.js asks before
  // it brings an editor back; an open that is still loading, or one that another open replaced, is not open.)
  function isOpen(collectionId) {
    return !!(st && st.doc && (collectionId == null || st.id === collectionId));
  }

  var api = {
    open: open,
    close: close,
    position: position,
    isOpen: isOpen,
    unsaved: unsaved,
    snapshot: snapshot,
    selection: null,
    mode: mode,
    createFromSelection: createFromSelection,
    createFreeNote: createFreeNote,
    focusCard: focusCard,
    drawHighlights: drawHighlights,
    goToAnchor: goToAnchor,
    setFind: setFind,
    pulse: pulse,
    run: run,
    escape: escape,
    scrollLeftFor: scrollLeftFor,
    ZOOM_LADDER: ZOOM_LADDER.slice(),
    MODE_WIDE: MODE_WIDE, MODE_RAIL: MODE_RAIL, COMPACT_BELOW: COMPACT_BELOW, REVEAL_PAD: REVEAL_PAD,
    // pure helpers exposed for node tests only
    _pure: { nextLadderStep: nextLadderStep, modeFor: modeFor, layoutFor: layoutFor, wheelFactor: wheelFactor, revealLeft: revealLeft, rectsForOffsets: rectsForOffsets, normRect: normRect, engineMessage: engineMessage, needsRefind: needsRefind }
  };
  M.reader = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

/* SELF-CHECK — M.reader implements: open(collectionId, {promptId, pageIndex, position}) → Promise (a promptId that is not a live prompt of
 * that book toasts and keeps the position; the saved last position only on a fresh open; D30: position {pageIndex, fraction, zoom} is a
 * tab's own place: it goes before the last position, and it also moves a book that is open already); position() → {pageIndex, fraction,
 * zoom}|null (the open book's place now, D30); close(); selection (Anchor|null snapshot);
 * mode() → "wide"|"rail"|"stack" ("wide" also when compact); createFromSelection(kind); createFreeNote(pageIndex, yPdf, text); focusCard(id);
 * drawHighlights(i); goToAnchor(anchor, {flash}) (also sideways: the passage lands inside the page band beside the margin);
 * createFreeNote also takes opts {obsidian} and createFromSelection the kind "obsidian" (BUILD-NOTES "Obsidian");
 * createFromSelection("cloze") (C) opens the editor with M.anchors.sentenceAround's sentence, else the braced selection: in both a
 * "::" of the selection is written `\::` (M.prompts.escapeCues), so selected text never makes a cue (FEATURES P1.1 e);
 * setFind(query) (the current match likewise); pulse(promptId); run(id) → boolean (prompt, cloze, highlight, obsidianNote, find, pageBox, zoomIn,
 * zoomOut, zoomFit — false when already at fit width so Cmd/Ctrl+0 resets the browser zoom —, markChapter, dim, hideAnswers, markers,
 * list, escape); escape() → boolean. Breakpoints (BUILD-NOTES "Post-review decisions"): wide ≥ 680 with .reader--compact below 1000,
 * rail 600–679, stack < 600; the zoom follows every width change inside the ResizeObserver callback. Pinch zoom: ctrl+wheel and
 * gesturestart/change/end on #scroller (and the snip overlay) → M.pdfview.setScale(scale, {anchor, gesture: true}) at most once per
 * frame; a step that changes nothing is dropped; stack is clamped to M.pdfview.fitScale() (computed on demand). Extensions: MODE_WIDE,
 * MODE_RAIL, COMPACT_BELOW, REVEAL_PAD, scrollLeftFor(anchor) → number|null. Emits doc:opened, doc:closed, selection:changed,
 * reader:mode {mode, compact}. Binds no keys; M.app calls run(id). */
