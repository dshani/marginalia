/*
 * js/pdfview.js — M.pdfview
 * PDF.js 3.11.174 (UMD, global `pdfjsLib`; index.html sets GlobalWorkerOptions.workerSrc) driver for
 * Marginalia: open/close, lazy page rendering with eviction, text layers, the per-page text index,
 * find, scroll bookkeeping and high-resolution capture.  SPEC §11, §15 "Capture", §17.2;
 * BUILD-NOTES "pdfview text index".  The DOM is touched only inside functions that run after boot.
 *
 * Password PDFs: PDF.js calls onPassword → pdfview emits "doc:password" {reason: "need"|"wrong",
 * setPassword} and renders an in-page field (inside the container when one was given, otherwise a
 * fixed panel on document.body).  M.pdfview.setPassword(pw) submits a password; setPassword(null)
 * cancels, which rejects open() with code "password".
 *
 * Loader hardening: every getDocument() call gets isEvalSupported:false (CVE-2024-4367; the 3.11.174
 * pin predates the 4.2.67 fix).  See loaderParams(); never remove it.
 */
(function (root) {
  "use strict";
  var M = root.Marginalia = root.Marginalia || {};
  function dep(name) { return M[name] || (typeof require === "function" ? require("./" + name + ".js") : undefined); }
  function mod(name) { try { return dep(name); } catch (e) { return undefined; } }

  // ---- constants ---------------------------------------------------------------------------------
  var PDFJS_VERSION = "3.11.174";
  var CMAP_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/" + PDFJS_VERSION + "/cmaps/";
  var MAX_PIXELS = 16777216;      // width · height · dpr² cap (page canvases and captures)
  var MAX_EDGE = 8000;            // longest capture edge in device px
  var GAP = 16;                   // CSS px above the first page and between pages
  var FIT_CAP = 1.6667;           // "fit width" never exceeds this scale
  var MIN_SCALE = 0.2, MAX_SCALE = 8;
  var GESTURE_IDLE_MS = 150;      // setScale(…, {gesture: true}): pages re-render once the gesture has been idle this long
  var SETTLE_MS_ANIM = 150;       // a zoom hold eases back into the layout this long once the gesture is idle
  var MEASURE_BATCH = 25;         // getViewport calls per idle batch
  var MAX_IN_FLIGHT = 2;          // concurrent page renders
  var SETTLE_MS = 1000;           // scroll:settled delay
  var RENDER_MARGIN = "100% 0px", EVICT_MARGIN = "300% 0px";
  var FIND_LANES = 3;             // pages indexed concurrently by find()

  // ---- small utilities ---------------------------------------------------------------------------
  function noop() {}
  function err(code, message) { var e = new Error(message || code); e.code = code; return e; }
  function isCancel(e) { return !!e && (e.name === "RenderingCancelledException" || e.code === "cancelled"); }
  function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }
  function lib() { if (typeof pdfjsLib !== "undefined") return pdfjsLib; return root.pdfjsLib || null; }
  function emit(type, payload) {
    var bus = M.bus;
    if (bus && typeof bus.emit === "function") { try { bus.emit(type, payload); } catch (e) {} }
  }
  function onBus(type, fn) {
    var bus = M.bus;
    if (bus && typeof bus.on === "function") { try { var off = bus.on(type, fn); return typeof off === "function" ? off : function () { try { bus.off(type, fn); } catch (e) {} }; } catch (e) {} }
    return noop;
  }
  function settingsGet(key) {
    var s = M.settings;
    if (s && typeof s.get === "function") { try { return s.get(key); } catch (e) {} }
    return undefined;
  }
  function idle(fn, timeout) {
    if (typeof root.requestIdleCallback === "function") return { kind: "idle", id: root.requestIdleCallback(fn, { timeout: timeout || 500 }) };
    return { kind: "timeout", id: setTimeout(fn, 32) };
  }
  function cancelIdle(h) {
    if (!h) return;
    if (h.kind === "idle" && typeof root.cancelIdleCallback === "function") root.cancelIdleCallback(h.id);
    else clearTimeout(h.id);
  }
  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
  function now() { return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now(); }
  function raf(fn) { return typeof root.requestAnimationFrame === "function" ? root.requestAnimationFrame(fn) : setTimeout(fn, 16); }
  function caf(id) { if (typeof root.cancelAnimationFrame === "function") root.cancelAnimationFrame(id); else clearTimeout(id); }
  function reducedMotion() {
    try { return !!(root.matchMedia && root.matchMedia("(prefers-reduced-motion: reduce)").matches); } catch (e) { return false; }
  }

  // ---- pure helpers (exported as api.helpers for the node tests) ------------------------------------
  // "fit width": pageColumnWidth / pageWidthPt, capped at 1.6667.
  function fitScale(columnWidth, pageWidthPt) {
    if (!(pageWidthPt > 0) || !(columnWidth > 0)) return 1;
    return Math.min(FIT_CAP, columnWidth / pageWidthPt);
  }
  // DPR capped so that width · height · dpr² ≤ 16 777 216.
  function cappedDpr(wCss, hCss, dpr) {
    dpr = dpr > 0 ? dpr : 1;
    var px = wCss * hCss;
    if (!(px > 0)) return dpr;
    return Math.min(dpr, Math.sqrt(MAX_PIXELS / px));
  }
  // §15 capture maths: s = z·dpr·k, scaled down by sqrt of the pixel excess and again for an 8000-px edge.
  function captureScale(rect, z, dpr, k) {
    z = z > 0 ? z : 1; dpr = dpr > 0 ? dpr : 1; k = k > 0 ? k : 3;
    var s = z * dpr * k;
    var px = rect.w * rect.h * (dpr * k) * (dpr * k);
    if (px > MAX_PIXELS) s = s / Math.sqrt(px / MAX_PIXELS);
    var f = s / z;
    var edge = Math.max(rect.w, rect.h) * f;
    if (edge > MAX_EDGE) { s = s * (MAX_EDGE / edge); f = s / z; }
    return { s: s, f: f, width: Math.max(1, Math.round(rect.w * f)), height: Math.max(1, Math.round(rect.h * f)) };
  }
  // Page tops from heights: GAP above the first page and between pages.
  function layoutTops(heights, gap) {
    gap = typeof gap === "number" ? gap : GAP;
    var tops = new Array(heights.length), y = gap;
    for (var i = 0; i < heights.length; i++) { tops[i] = y; y += heights[i] + gap; }
    return tops;
  }
  // The page under a y offset (relative to the top of #pages) and the fraction of it scrolled past.
  function pageAt(y, tops, heights) {
    var n = tops.length;
    if (!n || !(y > tops[0])) return { pageIndex: 0, fraction: 0 };
    var lo = 0, hi = n - 1;
    while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (tops[mid] <= y) lo = mid; else hi = mid - 1; }
    var h = heights[lo] > 0 ? heights[lo] : 1, off = y - tops[lo];
    if (off >= h) return lo + 1 < n ? { pageIndex: lo + 1, fraction: 0 } : { pageIndex: lo, fraction: 1 };
    return { pageIndex: lo, fraction: clamp(off / h, 0, 1) };
  }
  // BUILD-NOTES text index: items[k] = {str, x, y, width, height, hasEOL, divIndex}; text = strs joined
  // with " " ("\n" after an item with hasEOL); starts[k] = offset of item k in text (map = alias).
  function indexFromContent(textContent) {
    var src = (textContent && textContent.items) || [], items = [], starts = [], text = "", hasText = false, k = 0;
    for (var i = 0; i < src.length; i++) {
      var it = src[i];
      if (!it || typeof it.str !== "string") continue;      // marked-content entries own no div
      var t = it.transform || [1, 0, 0, 1, 0, 0];
      var h = Math.hypot(t[2], t[3]) || it.height || 0;
      if (k > 0) text += items[k - 1].hasEOL ? "\n" : " ";
      starts.push(text.length);
      items.push({ str: it.str, x: t[4], y: t[5], width: it.width || 0, height: h, hasEOL: !!it.hasEOL, divIndex: k });
      text += it.str;
      if (!hasText && /\S/.test(it.str)) hasText = true;
      k++;
    }
    return { text: text, starts: starts, map: starts, items: items, hasText: hasText };
  }
  // Case-insensitive search; whitespace in the query matches any whitespace run (line breaks).
  function findInIndex(index, query) {
    var out = [];
    if (!index || !index.text) return out;
    var q = String(query == null ? "" : query).trim();
    if (!q) return out;
    var re = new RegExp(q.split(/\s+/).map(escapeRe).join("\\s+"), "gi"), m;
    while ((m = re.exec(index.text))) {
      if (!m[0].length) { re.lastIndex++; continue; }
      out.push({ start: m.index, end: m.index + m[0].length });
    }
    return out;
  }
  function normRect(r) {
    r = r || {};
    var x = Number(r.x != null ? r.x : r.left) || 0, y = Number(r.y != null ? r.y : r.top) || 0;
    var w = Number(r.w != null ? r.w : r.width) || 0, h = Number(r.h != null ? r.h : r.height) || 0;
    return { x: x, y: y, w: w, h: h };
  }
  // Anchored zoom (pinch, setScale(…, {anchor})): the scroll offsets that put a document point under the pointer.
  // o = {px, py, box: {left, top}, dx, dy}: (px, py) is the pointer relative to the scroller's top-left, `box` the
  // top-left (scroll-content coordinates) of the page holding the point, (dx, dy) the point's offset inside that page
  // at the current scale. → {left, top}, unclamped: below 0 or past the end of the row means the layout alone
  // cannot hold the point by scrolling (zoomHold).
  function anchorOffsets(o) {
    return { left: o.box.left + o.dx - o.px, top: o.box.top + o.dy - o.py };
  }
  // The same for a scale change by `ratio`, from the positions before and after it. o = {scrollLeft, scrollTop, px,
  // py, before: {left, top}, after: {left, top}, ratio}: `before` / `after` are the top-left of the page under the
  // pointer before and after the change. → {scrollLeft, scrollTop}, never negative (the browser clamps the far end).
  function anchorScroll(o) {
    var r = o.ratio > 0 ? o.ratio : 1;
    var n = anchorOffsets({ px: o.px, py: o.py, box: o.after,
      dx: (o.scrollLeft + o.px - o.before.left) * r, dy: (o.scrollTop + o.py - o.before.top) * r });
    return { scrollLeft: Math.max(0, n.left), scrollTop: Math.max(0, n.top) };
  }
  // An anchored gesture step that scrolling alone cannot hold: the margins the page column (#pages, pdfview's own
  // host) takes for the length of the gesture. o = {need, maxScroll, left}: `need` is the scrollLeft that keeps the
  // point (anchorOffsets().left), `maxScroll` the row's overflow and `left` the page's left edge (scroll-content x),
  // both in the layout without a hold. While the page still fits, the flex gutter shrinks and the page grows
  // leftwards, so `need` falls below 0: a left margin as wide as the page's target screen x (left − need) makes the
  // row overflow and lets the page grow to the right under the sticky margin instead. A zoom out that leaves the row
  // shorter than the scroll the point needs gets a right margin of the missing room (need − maxScroll).
  // → {left, right} in px (0 / 0 when the layout can hold the point). The caller measures the page again after
  // applying them and scrolls by the difference.
  function zoomHold(o) {
    var need = Number(o.need) || 0, max = Math.max(0, Number(o.maxScroll) || 0);
    if (need < -0.5) return { left: Math.max(0, (Number(o.left) || 0) - need), right: 0 };
    if (need > max + 0.5) return { left: 0, right: need - max };
    return { left: 0, right: 0 };
  }

  // ---- document state ----------------------------------------------------------------------------
  var S = null;          // the open document, or null
  var openSeq = 0;

  function newState() {
    return {
      id: ++openSeq, task: null, pdf: null, doc: null, numPages: 0, pageLabels: null,
      container: null, scroller: null, pages: [], bases: [], proxies: {}, proxyPromises: {},
      indexCache: {}, scale: 1, scaleMode: "fit", fitBase: null, estimateViewport: null,
      widths: [], heights: [], tops: [], queue: [], inFlight: 0,
      renderObs: null, evictObs: null, resizeObs: null, measureCursor: 0, measureHandle: null, measuring: false,
      settleTimer: null, programmaticAt: 0, pendingScroll: null, scrollSeq: 0,
      listeners: [], offs: [], captureTask: null, captureSeq: 0, findSeq: 0,
      password: null, passwordEl: null, closed: false, hold: false, holdTimer: null,
      zoomHold: null, zoomAnchor: null, settle: null
    };
  }
  function pageState(i, el) {
    return { index: i, el: el, state: "empty", stale: false, near: false, token: 0, canvas: null, hlLayer: null,
      textLayer: null, dimLayer: null, textDivs: null, textContent: null, textReady: false,
      renderTask: null, textTask: null, viewport: null, failed: false };
  }
  function mapError(e, st) {
    // PDF.js's PasswordException has a numeric code (1 need, 2 incorrect): only our own string codes pass through
    if (e && typeof e === "object" && e.name !== "PasswordException" && typeof e.code === "string" && e.code && e instanceof Error) return e;
    var msg = (e && e.message) || String(e);
    var code = "invalid";
    if (e && e.name === "PasswordException") code = "password";
    else if (st && st.passwordCancelled) code = "password";
    var out = err(code, msg);
    out.cause = e;
    return out;
  }
  function listen(st, target, type, fn, opts) {
    if (!target) return;
    target.addEventListener(type, fn, opts || false);
    st.listeners.push([target, type, fn, opts || false]);
  }

  // ---- open / close --------------------------------------------------------------------------------
  // getDocument() options, built fresh for every open(); no caller option is forwarded to PDF.js.
  // isEvalSupported MUST stay false (CVE-2024-4367, PDF.js < 4.2.67): with eval allowed,
  // FontFaceObject.getPathGenerator compiles glyph outlines with `new Function` on the main thread and
  // splices the font's unvalidated /FontMatrix into that source, so a crafted PDF (Add PDF, drop, ?pdf=)
  // would run script in this origin with access to the API key and every IndexedDB store.  false keeps
  // PDF.js on its interpreted glyph path (same output, marginally slower for text drawn as outlines) and
  // also turns off the worker's PostScript-function compiler.  Pinned by test/pdfview-loader.test.js.
  function loaderParams(u8) {
    return { data: u8, cMapUrl: CMAP_URL, cMapPacked: true, isEvalSupported: false };
  }
  function open(u8, opts) {
    opts = opts || {};
    var L = lib();
    if (!L || typeof L.getDocument !== "function") return Promise.reject(err("no_pdfjs", "PDF engine not loaded"));
    if (!u8) return Promise.reject(err("invalid", "No PDF bytes"));
    return close().then(function () {
      var st = newState();
      S = st;
      st.container = opts.container || null;
      st.memoKey = memoKey(u8);                          // before getDocument, which may detach the buffer
      var task;
      try { task = L.getDocument(loaderParams(u8)); }
      catch (e) { S = null; throw mapError(e, st); }
      st.task = task;
      task.onProgress = function (p) { if (S === st) emit("doc:progress", { loaded: p && p.loaded, total: p && p.total }); };
      task.onPassword = function (update, reason) { if (S === st) askPassword(st, update, reason); else { try { update(new Error("closed")); } catch (e) {} } };
      return task.promise.then(function (pdf) {
        if (S !== st) throw err("closed", "Document was closed");
        st.pdf = pdf; st.numPages = pdf.numPages;
        var pwUsed = st.typedPassword != null ? st.typedPassword : st.memoPassword;
        if (st.memoKey && pwUsed != null) PASSWORD_MEMO.set(st.memoKey, pwUsed);
        return Promise.all([
          pdf.getMetadata().catch(function () { return null; }),
          pdf.getPageLabels().catch(function () { return null; }),
          getProxy(st, 0)
        ]);
      }).then(function (r) {
        if (S !== st) throw err("closed", "Document was closed");
        var meta = r[0], labels = r[1], page1 = r[2];
        st.pageLabels = Array.isArray(labels) ? labels : null;
        var b = baseOf(page1);
        st.bases[0] = b;
        st.fitBase = { width: b.width, height: b.height };
        st.estimateViewport = page1.getViewport({ scale: 1, rotation: page1.rotate });
        st.doc = {
          numPages: st.numPages,
          fingerprint: (st.pdf.fingerprints && st.pdf.fingerprints[0]) || null,
          info: (meta && meta.info) || {},
          pageLabels: st.pageLabels
        };
        if (st.container) mountPages(st);
        return st.doc;
      }).catch(function (e) {
        var mapped = mapError(e, st);
        if (S === st) { S = null; teardown(st); }
        throw mapped;
      });
    });
  }
  function close() {
    var st = S;
    if (!st) return Promise.resolve();
    S = null;
    var task = st.task;
    teardown(st);
    if (!task) return Promise.resolve();
    return Promise.resolve().then(function () { return task.destroy(); }).catch(noop);
  }
  function teardown(st) {
    st.closed = true;
    st.password = null;
    removePasswordField(st);
    for (var i = 0; i < st.pages.length; i++) {
      var p = st.pages[i];
      p.token++;
      cancelTasks(p);
    }
    if (st.captureTask) { try { st.captureTask.cancel(); } catch (e) {} st.captureTask = null; }
    st.captureSeq++; st.findSeq++;
    if (st.renderObs) { try { st.renderObs.disconnect(); } catch (e) {} }
    if (st.evictObs) { try { st.evictObs.disconnect(); } catch (e) {} }
    if (st.resizeObs) { try { st.resizeObs.disconnect(); } catch (e) {} }
    st.renderObs = st.evictObs = st.resizeObs = null;
    cancelIdle(st.measureHandle); st.measureHandle = null;
    clearTimeout(st.settleTimer); st.settleTimer = null;
    clearTimeout(st.holdTimer); st.holdTimer = null; st.hold = false; stopSettle(st); st.zoomHold = null; st.zoomAnchor = null;
    st.listeners.forEach(function (l) { try { l[0].removeEventListener(l[1], l[2], l[3]); } catch (e) {} });
    st.listeners = [];
    st.offs.forEach(function (off) { try { off(); } catch (e) {} });
    st.offs = [];
    if (st.container) {
      try {
        st.container.innerHTML = ""; st.container.style.width = ""; st.container.style.paddingTop = "";
        st.container.style.marginLeft = ""; st.container.style.marginRight = "";
      } catch (e) {}
    }
    st.queue = []; st.inFlight = 0; st.pages = []; st.pdf = null; st.task = null;
  }
  function cancelTasks(p) {
    var rt = p.renderTask, tt = p.textTask;
    p.renderTask = p.textTask = null;
    if (rt) { try { rt.cancel(); } catch (e) {} }
    if (tt) { try { tt.cancel(); } catch (e) {} }
    return rt ? rt.promise.catch(noop) : Promise.resolve();
  }
  function baseOf(page) {
    var vp = page.getViewport({ scale: 1, rotation: page.rotate });
    return { width: vp.width, height: vp.height, rotate: page.rotate };
  }
  function getProxy(st, i) {
    if (st.proxies[i]) return Promise.resolve(st.proxies[i]);
    if (!st.proxyPromises[i]) {
      st.proxyPromises[i] = st.pdf.getPage(i + 1).then(function (page) {
        st.proxies[i] = page;
        return page;
      }, function (e) { delete st.proxyPromises[i]; throw e; });
    }
    return st.proxyPromises[i];
  }

  // ---- password field ------------------------------------------------------------------------------
  // Passwords that opened a document, kept in memory for this page only (never stored): the reader re-opens the
  // bytes the library just added, so the reader tries the remembered password once before asking again.
  var PASSWORD_MEMO = new Map();
  function memoKey(u8) {
    try {
      var n = u8.length, h = 0x811c9dc5, i, lim = Math.min(n, 65536);
      for (i = 0; i < lim; i++) { h ^= u8[i]; h = Math.imul(h, 16777619) >>> 0; }
      for (i = Math.max(lim, n - 65536); i < n; i++) { h ^= u8[i]; h = Math.imul(h, 16777619) >>> 0; }
      return n + ":" + h.toString(16);
    } catch (e) { return null; }
  }
  function askPassword(st, update, reason) {
    var L = lib();
    var wrong = L && L.PasswordResponses ? reason === L.PasswordResponses.INCORRECT_PASSWORD : reason === 2;
    if (!st.memoTried && st.memoKey && PASSWORD_MEMO.has(st.memoKey)) {
      st.memoTried = true;
      st.memoPassword = PASSWORD_MEMO.get(st.memoKey);
      try { update(st.memoPassword); } catch (e) { /* fall through to asking on the next callback */ }
      return;
    }
    if (wrong && st.memoPassword != null && st.typedPassword == null) {
      PASSWORD_MEMO.delete(st.memoKey);               // the remembered one no longer works: ask without "wrong"
      st.memoPassword = null;
      wrong = false;
    }
    st.password = { update: update, wrong: wrong };
    emit("doc:password", { reason: wrong ? "wrong" : "need", setPassword: setPassword });
    renderPasswordField(st, wrong);
  }
  function setPassword(pw) {
    var st = S;
    if (!st || !st.password) return false;
    var p = st.password;
    st.password = null;
    removePasswordField(st);
    if (pw == null || pw === "") {
      st.passwordCancelled = true;
      try { p.update(new Error("Password entry cancelled")); } catch (e) {}
      return true;
    }
    st.typedPassword = String(pw);
    try { p.update(String(pw)); } catch (e) {}
    return true;
  }
  function renderPasswordField(st, wrong) {
    if (typeof document === "undefined") return;
    removePasswordField(st);
    var host = st.container || null;
    var form = document.createElement("form");
    form.className = "pdf-password";
    form.setAttribute("style", (host
      ? "margin:48px auto;max-width:360px;"
      : "position:fixed;left:50%;top:40%;transform:translate(-50%,-50%);z-index:60;width:min(360px,calc(100vw - 32px));box-shadow:0 4px 24px rgba(0,0,0,.25);") +
      "padding:16px;background:var(--surface,#fff);border:1px solid var(--line,#ddd);border-radius:8px;font:14px/1.45 var(--font-ui,system-ui);color:var(--ink,#1f1d1a)");
    form.innerHTML =
      '<div style="margin-bottom:8px">' + (wrong ? "Wrong password — try again" : "This PDF is password-protected") + "</div>" +
      '<input type="password" class="pdf-password__input" autocomplete="off" aria-label="PDF password" style="width:100%;box-sizing:border-box;margin-bottom:8px">' +
      '<div style="display:flex;gap:8px;justify-content:flex-end">' +
      '<button type="button" class="btn pdf-password__cancel">Cancel</button>' +
      '<button type="submit" class="btn btn--primary">Open</button></div>';
    var input = form.querySelector("input");
    form.addEventListener("submit", function (ev) { ev.preventDefault(); setPassword(input.value); });
    form.querySelector(".pdf-password__cancel").addEventListener("click", function () { setPassword(null); });
    (host || document.body).appendChild(form);
    st.passwordEl = form;
    try { input.focus(); } catch (e) {}
  }
  function removePasswordField(st) {
    var el = st.passwordEl;
    st.passwordEl = null;
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  // ---- page column: placeholders, sizing, measuring ------------------------------------------------
  function mountPages(st) {
    if (typeof document === "undefined") return;
    var c = st.container;
    c.innerHTML = "";
    c.style.paddingTop = GAP + "px";
    c.style.marginLeft = ""; c.style.marginRight = "";
    st.scroller = c.parentElement || c;
    for (var i = 0; i < st.numPages; i++) {
      var el = document.createElement("div");
      el.className = "page";
      el.setAttribute("data-page-index", String(i));
      el.style.position = "relative";
      el.style.background = "var(--page-bg, #fff)";
      el.style.boxShadow = "var(--page-shadow, 0 1px 4px rgba(0,0,0,.25))";
      el.style.margin = "0 auto " + GAP + "px";
      el.style.overflow = "hidden";
      el.style.boxSizing = "content-box";
      st.pages.push(pageState(i, el));
      c.appendChild(el);
    }
    st.scale = st.scaleMode === "fit" ? fitScale(columnWidth(st), st.fitBase.width) : st.scale;
    layoutSizes(st);
    emitMeasured(st);
    installObservers(st);
    listen(st, st.scroller, "scroll", function () { onScroll(st); }, { passive: true });
    installSelectionHelpers(st);
    st.offs.push(onBus("settings:changed", function (p) { if (p && p.key === "dimPages") applyDim(st, !!p.value); }));
    if (typeof ResizeObserver === "function") {
      var pending = null;
      st.resizeObs = new ResizeObserver(function () {
        if (pending) return;
        pending = requestAnimationFrame(function () { pending = null; if (S === st) onResize(st); });
      });
      st.resizeObs.observe(st.scroller);
    } else {
      listen(st, root, "resize", function () { onResize(st); });
    }
    scheduleMeasure(st);
    if (typeof IntersectionObserver !== "function") scanVisibility(st);
  }
  // Page column width per SPEC §2: W − margin − 48 (wide) or − 32 (rail / stack).
  function columnWidth(st) {
    var sc = st.scroller, W = sc ? sc.clientWidth : 0;
    if (!(W > 0)) W = (root.innerWidth || 1024);
    var marginEl = sc ? sc.querySelector("#margin") : null;
    var mw = marginEl ? marginEl.offsetWidth : 0;
    var reader = typeof document !== "undefined" ? document.getElementById("reader") : null;
    var pad = reader && reader.classList && reader.classList.contains("reader--wide") ? 48 : 32;
    if (!reader || !reader.classList || !(reader.classList.contains("reader--rail") || reader.classList.contains("reader--stack"))) pad = Math.max(pad, 48);
    return Math.max(120, W - mw - pad);
  }
  function viewportOf(st, i) {
    var page = st.proxies[i];
    if (!page) return null;
    return page.getViewport({ scale: st.scale, rotation: page.rotate });
  }
  // Sizes every placeholder from its measured base (page 1's size until measured) at the current scale.
  function layoutSizes(st) {
    var maxW = 0;
    for (var i = 0; i < st.pages.length; i++) {
      var p = st.pages[i], b = st.bases[i] || st.fitBase;
      var w = b.width * st.scale, h = b.height * st.scale;
      st.widths[i] = w; st.heights[i] = h;
      if (w > maxW) maxW = w;
      p.el.style.width = w + "px";
      p.el.style.height = h + "px";
      p.viewport = st.proxies[i] ? viewportOf(st, i) : null;
      if (p.canvas && p.state === "stale") { p.canvas.style.width = w + "px"; p.canvas.style.height = h + "px"; }
    }
    st.tops = layoutTops(st.heights, GAP);
    if (st.container) st.container.style.width = maxW + "px";
  }
  function emitMeasured(st) {
    emit("pages:measured", { pageTops: st.tops.slice(), pageHeights: st.heights.slice() });
  }
  function scheduleMeasure(st) {
    if (st.measureHandle || st.measureCursor >= st.numPages) return;
    st.measureHandle = idle(function () { st.measureHandle = null; measureBatch(st); }, 500);
  }
  function measureBatch(st) {
    if (S !== st) return;
    var picks = [];
    if (st.pendingScroll && !st.bases[st.pendingScroll.pageIndex]) picks.push(st.pendingScroll.pageIndex);
    while (picks.length < MEASURE_BATCH && st.measureCursor < st.numPages) {
      var i = st.measureCursor++;
      if (!st.bases[i] && picks.indexOf(i) < 0) picks.push(i);
    }
    if (!picks.length) { if (st.measureCursor < st.numPages) scheduleMeasure(st); return; }
    Promise.all(picks.map(function (i) {
      return getProxy(st, i).then(function (page) { st.bases[i] = baseOf(page); }, function () { st.bases[i] = { width: st.fitBase.width, height: st.fitBase.height, rotate: 0 }; });
    })).then(function () {
      if (S !== st) return;
      applyMeasured(st);
      scheduleMeasure(st);
    });
  }
  // Re-lays out after sizes changed, keeping the viewport on the same page fraction.
  function applyMeasured(st) {
    var cur = currentPage(), before = scrollYFor(st, cur);
    layoutSizes(st);
    var after = scrollYFor(st, cur);
    if (Math.abs(after - before) > 0.5 && st.scroller) programmaticScroll(st, st.scroller.scrollTop + (after - before));
    emitMeasured(st);
    if (st.pendingScroll && st.bases[st.pendingScroll.pageIndex]) {
      var ps = st.pendingScroll; st.pendingScroll = null;
      scrollTo({ pageIndex: ps.pageIndex, yPdf: ps.yPdf, align: ps.align });
    }
    if (typeof IntersectionObserver !== "function") scanVisibility(st);
    pump(st);
  }
  function ensureMeasured(st, i, page) {
    var b = baseOf(page), old = st.bases[i];
    if (old && Math.abs(old.width - b.width) < 0.01 && Math.abs(old.height - b.height) < 0.01) return;
    st.bases[i] = b;
    applyMeasured(st);
  }

  // ---- scrolling bookkeeping ---------------------------------------------------------------------
  function baseTop(st) {
    var sc = st.scroller, c = st.container;
    if (!sc || !c) return 0;
    try {
      var sr = sc.getBoundingClientRect(), cr = c.getBoundingClientRect();
      return cr.top - (sr.top + (sc.clientTop || 0)) + sc.scrollTop;
    } catch (e) { return 0; }
  }
  function scrollYFor(st, pos) {
    var i = clamp(pos.pageIndex | 0, 0, Math.max(0, st.numPages - 1));
    return baseTop(st) + (st.tops[i] || 0) + (pos.fraction || 0) * (st.heights[i] || 0);
  }
  function programmaticScroll(st, top) {
    if (!st.scroller) return;
    st.programmaticAt = Date.now();
    st.scroller.scrollTop = Math.max(0, top);
  }
  function viewportCenterY(st) {
    var sc = st.scroller;
    if (!sc) return 0;
    return sc.scrollTop - baseTop(st) + sc.clientHeight / 2;
  }
  function onScroll(st) {
    if (S !== st) return;
    if (Date.now() - st.programmaticAt > 150) st.pendingScroll = null;
    clearTimeout(st.settleTimer);
    st.settleTimer = setTimeout(function () {
      st.settleTimer = null;
      if (S === st) emit("scroll:settled", currentPage());
    }, SETTLE_MS);
    if (typeof IntersectionObserver !== "function") scanVisibility(st);
    pump(st);
  }
  function onResize(st) {
    if (S !== st || !st.fitBase) return;
    if (st.scaleMode === "fit") {
      var target = fitScale(columnWidth(st), st.fitBase.width);
      if (Math.abs(target - st.scale) > 0.004) setScale("fit");
    }
  }

  // ---- observers: render within 100 %, evict beyond 300 % ----------------------------------------
  function installObservers(st) {
    if (typeof IntersectionObserver !== "function") return;
    st.renderObs = new IntersectionObserver(function (entries) {
      if (S !== st) return;
      for (var k = 0; k < entries.length; k++) {
        var en = entries[k], p = st.pages[+en.target.getAttribute("data-page-index")];
        if (!p) continue;
        p.near = en.isIntersecting;
        if (p.near) { if (p.state === "empty" || p.state === "stale") enqueue(st, p); }
        else if (p.state === "queued") { dequeue(st, p); p.state = p.stale ? "stale" : "empty"; }
      }
      pump(st);
    }, { root: st.scroller, rootMargin: RENDER_MARGIN, threshold: 0 });
    st.evictObs = new IntersectionObserver(function (entries) {
      if (S !== st) return;
      for (var k = 0; k < entries.length; k++) {
        var en = entries[k], p = st.pages[+en.target.getAttribute("data-page-index")];
        if (!p || en.isIntersecting) continue;
        evict(st, p);
      }
    }, { root: st.scroller, rootMargin: EVICT_MARGIN, threshold: 0 });
    for (var i = 0; i < st.pages.length; i++) { st.renderObs.observe(st.pages[i].el); st.evictObs.observe(st.pages[i].el); }
  }
  // Geometry fallback for browsers without IntersectionObserver.
  function scanVisibility(st) {
    var sc = st.scroller;
    if (!sc) return;
    var top = sc.scrollTop - baseTop(st), H = sc.clientHeight || 1;
    var nearLo = top - H, nearHi = top + 2 * H, farLo = top - 3 * H, farHi = top + 4 * H;
    for (var i = 0; i < st.pages.length; i++) {
      var p = st.pages[i], a = st.tops[i], b = a + st.heights[i];
      p.near = b >= nearLo && a <= nearHi;
      if (p.near) { if (p.state === "empty" || p.state === "stale") enqueue(st, p); }
      else if (b < farLo || a > farHi) evict(st, p);
      else if (p.state === "queued") { dequeue(st, p); p.state = p.stale ? "stale" : "empty"; }
    }
    pump(st);
  }

  // ---- render queue: nearest to the viewport first, at most 2 in flight ----------------------------
  // While a zoom gesture holds the renders (st.hold), pages keep their stretched canvases and pump() starts
  // nothing; releaseRenders() queues the near pages once the gesture has been idle GESTURE_IDLE_MS.
  function enqueue(st, p) {
    if (p.state === "rendering" || p.state === "rendered" || p.state === "queued") return;
    p.state = "queued";
    if (st.queue.indexOf(p.index) < 0) st.queue.push(p.index);
  }
  function dequeue(st, p) {
    var k = st.queue.indexOf(p.index);
    if (k >= 0) st.queue.splice(k, 1);
  }
  function pump(st) {
    if (S !== st || st.hold) return;
    while (st.inFlight < MAX_IN_FLIGHT && st.queue.length) {
      var center = viewportCenterY(st), best = 0, bestD = Infinity;
      for (var k = 0; k < st.queue.length; k++) {
        var i = st.queue[k], d = Math.abs(st.tops[i] + st.heights[i] / 2 - center);
        if (d < bestD) { bestD = d; best = k; }
      }
      var idx = st.queue.splice(best, 1)[0];
      startRender(st, st.pages[idx]);
    }
  }
  function startRender(st, p) {
    p.state = "rendering";
    st.inFlight++;
    var token = ++p.token, released = false;
    function release() { if (released) return; released = true; st.inFlight = Math.max(0, st.inFlight - 1); pump(st); }
    function cancelled() { return S !== st || p.token !== token; }
    getProxy(st, p.index).then(function (page) {
      if (cancelled()) throw err("cancelled");
      ensureMeasured(st, p.index, page);
      if (cancelled()) throw err("cancelled");
      var vp = p.viewport = page.getViewport({ scale: st.scale, rotation: page.rotate });
      var dpr = cappedDpr(vp.width, vp.height, root.devicePixelRatio || 1);
      var canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(vp.width * dpr));
      canvas.height = Math.max(1, Math.round(vp.height * dpr));
      canvas.style.cssText = "position:absolute;left:0;top:0;display:block;width:" + vp.width + "px;height:" + vp.height + "px";
      var ctx = canvas.getContext("2d", { alpha: false });
      var task = page.render({ canvasContext: ctx, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null });
      p.renderTask = task;
      var textP = page.getTextContent();
      return task.promise.then(function () {
        if (p.renderTask === task) p.renderTask = null;
        if (cancelled()) { canvas.width = canvas.height = 0; throw err("cancelled"); }
        installCanvas(st, p, canvas, vp);
        p.state = "rendered"; p.stale = false; p.failed = false;
        emit("page:rendered", { pageIndex: p.index });
        release();
        return textP.then(function (tc) {
          if (cancelled()) return;
          return buildTextLayer(st, p, tc, vp);
        }, noop);
      });
    }).catch(function (e) {
      if (S === st && p.token === token) {
        p.state = p.stale ? "stale" : "empty";
        if (!isCancel(e)) { p.failed = true; try { console.warn("[pdfview] page " + (p.index + 1) + " failed to render", e); } catch (e2) {} }
      }
      release();
    });
  }
  function installCanvas(st, p, canvas, vp) {
    var el = p.el;
    clearPageContent(p);
    el.appendChild(canvas);
    p.canvas = canvas;
    var hl = document.createElement("div");
    hl.className = "hlLayer";
    hl.style.cssText = "position:absolute;inset:0;pointer-events:none";
    el.appendChild(hl);
    p.hlLayer = hl;
    var tl = document.createElement("div");
    tl.className = "textLayer";
    tl.style.cssText = "position:absolute;inset:0;overflow:hidden";
    el.appendChild(tl);
    p.textLayer = tl;
    p.textDivs = [];
    p.textContent = null;
    p.textReady = false;
    el.style.setProperty("--scale-factor", String(vp.scale));
    if (settingsGet("dimPages")) addDim(p);
  }
  function addDim(p) {
    if (p.dimLayer || !p.el) return;
    var dim = document.createElement("div");
    dim.className = "dimLayer";
    dim.style.cssText = "position:absolute;inset:0;pointer-events:none";
    p.el.appendChild(dim);
    p.dimLayer = dim;
  }
  function applyDim(st, on) {
    for (var i = 0; i < st.pages.length; i++) {
      var p = st.pages[i];
      if (p.state !== "rendered" && p.state !== "stale") continue;
      if (on) addDim(p);
      else if (p.dimLayer) { if (p.dimLayer.parentNode) p.dimLayer.parentNode.removeChild(p.dimLayer); p.dimLayer = null; }
    }
  }
  function clearPageContent(p) {
    if (p.canvas) { try { p.canvas.width = 0; p.canvas.height = 0; } catch (e) {} }
    var el = p.el;
    while (el && el.firstChild) el.removeChild(el.firstChild);
    p.canvas = p.hlLayer = p.textLayer = p.dimLayer = null;
  }
  function buildTextLayer(st, p, tc, vp) {
    var L = lib(), tl = p.textLayer;
    if (!tl || !tc || !L) return;
    p.textContent = tc;
    var idx = getIndex(st, p.index, tc);
    if (idx.hasText) p.el.removeAttribute("data-notext"); else p.el.setAttribute("data-notext", "");
    var divs = p.textDivs = [], task = null;
    try { task = L.renderTextLayer({ textContentSource: tc, container: tl, viewport: vp, textDivs: divs }); }
    catch (e) { task = null; }
    applyLayerRotation(tl);
    p.textTask = task;
    var pr = task && task.promise ? task.promise : Promise.resolve();
    return pr.then(function () {
      if (p.textTask === task) p.textTask = null;
      if (p.textLayer !== tl || S !== st) return;
      var end = document.createElement("div");
      end.className = "endOfContent";
      tl.appendChild(end);
      p.textReady = true;
      emit("page:textready", { pageIndex: p.index });
    }, function () { if (p.textTask === task) p.textTask = null; });
  }
  // PDF.js 3.x lays the text layer out in unrotated page units and tags the container with
  // data-main-rotation, expecting pdf_viewer.css to rotate it; that stylesheet is not loaded, so the
  // equivalent transform is applied inline (only when PDF.js set the attribute).
  var ROTATION_TRANSFORMS = { 90: "rotate(90deg) translateY(-100%)", 180: "rotate(180deg) translate(-100%, -100%)", 270: "rotate(270deg) translateX(-100%)" };
  function applyLayerRotation(tl) {
    var rot = tl.getAttribute("data-main-rotation");
    var t = rot ? ROTATION_TRANSFORMS[((parseInt(rot, 10) % 360) + 360) % 360] : null;
    if (t) { tl.style.transformOrigin = "0 0"; tl.style.transform = t; }
    else { tl.style.transformOrigin = ""; tl.style.transform = ""; }
  }
  // Eviction: cancel tasks, canvas 0×0, drop layers, page.cleanup() after the cancelled promise settles.
  function evict(st, p) {
    if (p.state === "queued") { dequeue(st, p); p.state = "empty"; p.stale = false; return; }
    if (p.state === "empty" && !p.canvas) return;
    var wasRendered = p.state === "rendered" || p.state === "stale";
    p.token++;
    var settled = cancelTasks(p);
    clearPageContent(p);
    p.state = "empty"; p.stale = false; p.textDivs = null; p.textContent = null; p.textReady = false;
    p.el.removeAttribute("data-notext");
    settled.then(function () {
      var page = st.proxies[p.index];
      if (page && p.state === "empty") { try { page.cleanup(); } catch (e) {} }
    });
    if (wasRendered) emit("page:evicted", { pageIndex: p.index });
  }
  // Scale change: keep the old canvas stretched to the new size until the page re-renders. The text layer goes (its
  // spans are laid out for the old scale); .hlLayer and .dimLayer stay: both are inset: 0 and scale-free, so a dimmed
  // page stays dimmed through a whole pinch (installCanvas / clearPageContent replace them on the re-render).
  function markStale(st, p) {
    if (p.state === "queued") { dequeue(st, p); p.state = p.stale ? "stale" : "empty"; return; }
    if (p.state !== "rendered" && p.state !== "rendering") return;
    p.token++;
    cancelTasks(p);
    if (p.textLayer && p.textLayer.parentNode) p.textLayer.parentNode.removeChild(p.textLayer);
    p.textLayer = null; p.textDivs = null; p.textContent = null; p.textReady = false;
    p.state = p.canvas ? "stale" : "empty"; p.stale = !!p.canvas;
  }
  // The official viewer's selection helper: while the mouse is down in a text layer every layer gets
  // "selecting" so .endOfContent stretches over the page and cross-page drags select cleanly.
  function installSelectionHelpers(st) {
    function layers() { return st.container ? st.container.querySelectorAll(".textLayer") : []; }
    function start(ev) {
      var t = ev.target;
      if (!t || !t.closest || !t.closest(".textLayer")) return;
      var ls = layers();
      for (var i = 0; i < ls.length; i++) ls[i].classList.add("selecting");
    }
    function stop() {
      var ls = layers();
      for (var i = 0; i < ls.length; i++) ls[i].classList.remove("selecting");
    }
    listen(st, st.container, "pointerdown", start);
    listen(st, document, "pointerup", stop);
    listen(st, document, "pointercancel", stop);
  }

  // ---- public: scale ---------------------------------------------------------------------------------
  // setScale(scale|"fit", opts) — §17 extension (BUILD-NOTES "Post-review decisions"), opts optional:
  //   anchor:  {clientX, clientY} keeps the document point under that client point fixed (pinch zoom);
  //            without it the page under the top edge keeps its fraction and the horizontal scroll its ratio.
  //   gesture: true for one step of a continuous gesture: placeholders resize and the current canvases are
  //            stretched at once, but no page re-renders until no gesture step has come for GESTURE_IDLE_MS,
  //            so a burst of steps never queues a render per step. A call without it re-renders at once.
  // An anchored gesture step holds the point even where scrolling alone cannot (the page still fits and the flex
  // gutter shrinks as it grows, or a zoom out leaves too little row to scroll): the page column takes margins for the
  // length of the gesture (zoomHold). Once the gesture has been idle GESTURE_IDLE_MS the page eases back into the
  // layout's own place (releaseHold); the next call that is not an anchored gesture step ends a hold at once.
  function setScale(s, opts) {
    var st = S;
    if (!st || !st.fitBase) return;
    opts = opts || {};
    stopSettle(st);
    var released = opts.gesture && opts.anchor ? false : releaseHold(st, false);
    var mode, target;
    if (s === "fit" || s == null) { mode = "fit"; target = fitScale(columnWidth(st), st.fitBase.width); }
    else {
      target = Number(s);
      if (!(target > 0)) { if (released) emit("scale:changed", { scale: st.scale }); return; }
      mode = "manual";
      target = clamp(target, MIN_SCALE, MAX_SCALE);
    }
    st.scaleMode = mode;
    if (Math.abs(target - st.scale) < 1e-6) {
      if (!opts.gesture && st.hold) releaseRenders(st);
      if (released) emit("scale:changed", { scale: st.scale });   // the page column moved back into the layout
      return;
    }
    var sc = st.scroller, cur = currentPage(), leftFrac = 0;
    var anchor = sc && opts.anchor ? anchorBefore(st, opts.anchor, !!opts.gesture) : null;
    if (sc && sc.scrollWidth > sc.clientWidth) leftFrac = sc.scrollLeft / (sc.scrollWidth - sc.clientWidth);
    st.scale = target;
    for (var i = 0; i < st.pages.length; i++) markStale(st, st.pages[i]);
    if (st.captureTask) { try { st.captureTask.cancel(); } catch (e) {} st.captureTask = null; }
    layoutSizes(st);
    if (sc && anchor) anchorAfter(st, anchor, !!opts.gesture);
    else {
      st.zoomAnchor = null;
      if (sc) {
        programmaticScroll(st, scrollYFor(st, cur));
        if (!canScrollX(st)) sc.scrollLeft = 0;
        else if (sc.scrollWidth > sc.clientWidth) sc.scrollLeft = leftFrac * (sc.scrollWidth - sc.clientWidth);
      }
    }
    emitMeasured(st);
    emit("scale:changed", { scale: st.scale });
    if (opts.gesture) { holdRenders(st); return; }
    releaseRenders(st);
  }
  function holdRenders(st) {
    st.hold = true;
    clearTimeout(st.holdTimer);
    st.holdTimer = setTimeout(function () { st.holdTimer = null; if (S === st) releaseRenders(st); }, GESTURE_IDLE_MS);
  }
  function releaseRenders(st) {
    clearTimeout(st.holdTimer); st.holdTimer = null;
    st.hold = false;
    if (releaseHold(st, true)) emit("scale:changed", { scale: st.scale });   // the page column moved back into the layout
    for (var k = 0; k < st.pages.length; k++) {
      var p = st.pages[k];
      if (p.near && (p.state === "empty" || p.state === "stale")) enqueue(st, p);
    }
    if (typeof IntersectionObserver !== "function") scanVisibility(st); else pump(st);
  }
  // A scroller whose overflow-x is hidden (stack mode) is never scrolled sideways: its reader could not scroll back.
  function canScrollX(st) {
    var sc = st.scroller;
    if (!sc || typeof root.getComputedStyle !== "function") return true;
    try { return root.getComputedStyle(sc).overflowX !== "hidden"; } catch (e) { return true; }
  }
  // The page column's hold margins (zoomHold): {left, right} in px, or null for none.
  function setHold(st, h) {
    var c = st.container, l = h && h.left > 0.05 ? h.left : 0, r = h && h.right > 0.05 ? h.right : 0;
    st.zoomHold = l || r ? { left: l, right: r } : null;
    if (!c || !c.style) return;
    c.style.marginLeft = l ? l + "px" : "";
    c.style.marginRight = r ? r + "px" : "";
  }
  function stopSettle(st) { if (st.settle) { caf(st.settle.id); st.settle = null; } }
  // Ends a hold: the margins go and the page keeps its place on screen as far as scrolling allows (where the page
  // fits, it returns to its own place beside the margin). With `animate` (the gesture is idle) the page eases there
  // over SETTLE_MS_ANIM, unless the reader prefers reduced motion; a scale change stops the easing where it is (the
  // margins left are then the hold it starts from), a scroll by the reader ends it at once. → true when the column
  // moved now (the caller tells the listeners; an easing emits scale:changed itself when it ends).
  function releaseHold(st, animate) {
    st.zoomAnchor = null;
    stopSettle(st);
    var h = st.zoomHold, sc = st.scroller, el = st.pages[0] && st.pages[0].el;
    if (!h) return false;
    if (!sc || !el || !canScrollX(st)) { setHold(st, null); return true; }
    var x0 = contentBox(st, el).left - sc.scrollLeft;   // the page's x on screen now
    setHold(st, null);
    var end = contentBox(st, el).left, sEnd = clamp(end - x0, 0, Math.max(0, sc.scrollWidth - sc.clientWidth)), xEnd = end - sEnd;
    if (!animate || Math.abs(xEnd - x0) < 1 || reducedMotion()) { sc.scrollLeft = sEnd; return true; }
    setHold(st, h);                                      // from where it is now, eased (cubic out) to the layout's place
    var t0 = now(), settle = st.settle = { id: 0, left: null };
    (function frame() {
      if (S !== st || st.settle !== settle) return;
      if (settle.left != null && Math.abs(sc.scrollLeft - settle.left) > 1) {   // the reader scrolled: stop easing
        st.settle = null; setHold(st, null); emit("scale:changed", { scale: st.scale }); return;
      }
      var k = Math.min(1, (now() - t0) / SETTLE_MS_ANIM), e = 1 - Math.pow(1 - k, 3);
      if (k >= 1) { st.settle = null; setHold(st, null); sc.scrollLeft = sEnd; emit("scale:changed", { scale: st.scale }); return; }
      setHold(st, { left: h.left * (1 - e), right: h.right * (1 - e) });
      sc.scrollLeft = clamp(contentBox(st, el).left - (x0 + (xEnd - x0) * e), 0, Math.max(0, sc.scrollWidth - sc.clientWidth));
      settle.left = sc.scrollLeft;
      settle.id = raf(frame);
    })();
    return false;
  }
  // A page's top-left in scroll-content coordinates (what anchorScroll calls before / after).
  function contentBox(st, el) {
    var sc = st.scroller, sr = sc.getBoundingClientRect(), r = el.getBoundingClientRect();
    return { left: r.left - sr.left - (sc.clientLeft || 0) + sc.scrollLeft, top: r.top - sr.top - (sc.clientTop || 0) + sc.scrollTop };
  }
  function near(a, b) { return Math.abs(a - b) < 0.75; }
  // Before a scale change: the pointer relative to the scroller and the document point under it, as page i (the next
  // page when the pointer is in a gap) and the offset inside it in unscaled units. Through a gesture the point found
  // at its first step is kept while the pointer and the scroll offsets stay where the last step left them, so the
  // whole-pixel rounding of each step's scroll never adds up. Null when the point is unusable.
  function anchorBefore(st, a, gesture) {
    var sc = st.scroller, x = Number(a.clientX), y = Number(a.clientY);
    if (!isFinite(x) || !isFinite(y) || !st.pages.length) return null;
    var sr = sc.getBoundingClientRect();
    var px = x - sr.left - (sc.clientLeft || 0), py = y - sr.top - (sc.clientTop || 0);
    var g = gesture ? st.zoomAnchor : null;
    if (g && st.pages[g.i] && near(g.clientX, x) && near(g.clientY, y) && near(g.scrollLeft, sc.scrollLeft) && near(g.scrollTop, sc.scrollTop)) {
      return { clientX: x, clientY: y, px: px, py: py, i: g.i, ux: g.ux, uy: g.uy };
    }
    var i = pageAt(sc.scrollTop + py - baseTop(st), st.tops, st.heights).pageIndex, p = st.pages[i];
    if (!p || !p.el) return null;
    var box = contentBox(st, p.el), z = st.scale > 0 ? st.scale : 1;
    return { clientX: x, clientY: y, px: px, py: py, i: i, ux: (sc.scrollLeft + px - box.left) / z, uy: (sc.scrollTop + py - box.top) / z };
  }
  // After layoutSizes(): scroll so that point is under the pointer again. A gesture step the layout cannot hold by
  // scrolling (zoomHold) gives the page column margins first and scrolls by what is left; a scroller that cannot
  // scroll sideways (stack) stays at scrollLeft 0.
  function anchorAfter(st, a, gesture) {
    var sc = st.scroller, el = st.pages[a.i].el;
    setHold(st, null);                                   // where the layout itself puts the page
    var box = contentBox(st, el);
    var n = anchorOffsets({ px: a.px, py: a.py, box: box, dx: a.ux * st.scale, dy: a.uy * st.scale });
    var left = 0;
    if (canScrollX(st)) {
      left = n.left;
      var h = gesture ? zoomHold({ need: n.left, maxScroll: sc.scrollWidth - sc.clientWidth, left: box.left }) : null;
      if (h && (h.left > 0 || h.right > 0)) {
        setHold(st, h);
        left = contentBox(st, el).left - (box.left - n.left);   // box.left − n.left: the page's x on screen
      }
    }
    programmaticScroll(st, n.top);
    sc.scrollLeft = Math.max(0, left);
    st.zoomAnchor = gesture ? { clientX: a.clientX, clientY: a.clientY, i: a.i, ux: a.ux, uy: a.uy,
      scrollLeft: sc.scrollLeft, scrollTop: sc.scrollTop } : null;
  }
  function getScale() { return S ? S.scale : 1; }
  function scaleMode() { return S ? S.scaleMode : "fit"; }
  // Extension: the fit-width scale for the column as it is now (what setScale("fit") would apply), computed on
  // demand; null while no document is open. The reader clamps stack mode with it (SPEC §2: zoom clamped to fit).
  function currentFitScale() { var st = S; return st && st.fitBase ? fitScale(columnWidth(st), st.fitBase.width) : null; }

  // ---- public: position ------------------------------------------------------------------------------
  // {pageIndex, fraction}: the page under the top edge of the scroller and how much of it is scrolled past.
  function currentPage() {
    var st = S;
    if (!st || !st.scroller || !st.pages.length) return { pageIndex: 0, fraction: 0 };
    return pageAt(st.scroller.scrollTop - baseTop(st), st.tops, st.heights);
  }
  // scrollTo({pageIndex, fraction}) restores a currentPage() value exactly; scrollTo({pageIndex, yPdf})
  // puts that PDF-space y one third down the viewport (align: "top" | "third" | "center" overrides).
  function scrollTo(o) {
    var st = S;
    if (!st || !st.scroller || !o || !st.pages.length) return;
    var i = clamp(Number(o.pageIndex) | 0, 0, st.numPages - 1), y = 0, align = o.align;
    if (typeof o.fraction === "number") {
      y = clamp(o.fraction, 0, 1) * st.heights[i];
      align = align || "top";
    } else if (typeof o.yPdf === "number") {
      align = align || "third";
      var vp = st.proxies[i] ? (st.pages[i].viewport || viewportOf(st, i)) : null;
      if (vp) y = vp.convertToViewportPoint(0, o.yPdf)[1];
      else {
        var b = st.bases[i] || st.fitBase;
        y = clamp((b.height - o.yPdf) * st.scale, 0, st.heights[i]);
        st.pendingScroll = { pageIndex: i, yPdf: o.yPdf, align: align };
        getProxy(st, i).then(function (page) {
          if (S !== st || !st.pendingScroll || st.pendingScroll.pageIndex !== i) return;
          ensureMeasured(st, i, page);
          if (st.pendingScroll && st.pendingScroll.pageIndex === i) { st.pendingScroll = null; scrollTo({ pageIndex: i, yPdf: o.yPdf, align: align }); }
        }, noop);
      }
    } else align = align || "top";
    var top = baseTop(st) + st.tops[i] + y;
    if (align === "third") top -= st.scroller.clientHeight / 3;
    else if (align === "center") top -= st.scroller.clientHeight / 2;
    programmaticScroll(st, top);
    pump(st);
  }
  function pageTops() { return S ? S.tops.slice() : []; }
  function pageHeights() { return S ? S.heights.slice() : []; }
  function pageLabel(i) {
    var st = S;
    if (st && st.pageLabels && typeof st.pageLabels[i] === "string" && st.pageLabels[i] !== "") return st.pageLabels[i];
    return String((Number(i) | 0) + 1);
  }
  // Never null while a document is open: unmeasured pages get page 1's viewport as an estimate
  // (corrected by pages:measured) so callers can convert points before the idle measuring reaches them.
  function viewport(i) {
    var st = S;
    if (!st || !st.fitBase) return null;
    i = Number(i) | 0;
    if (i < 0 || i >= st.numPages) return null;
    var p = st.pages[i];
    if (p && p.viewport) return p.viewport;
    if (st.proxies[i]) { var vp = viewportOf(st, i); if (p) p.viewport = vp; return vp; }
    return st.proxies[0] ? st.proxies[0].getViewport({ scale: st.scale, rotation: st.proxies[0].rotate }) : null;
  }
  function pageView(i) {
    var st = S;
    if (!st) return null;
    var p = st.pages[Number(i) | 0];
    if (!p || p.state !== "rendered") return null;
    return { el: p.el, viewport: p.viewport, textDivs: p.textDivs || [], textContent: p.textContent };
  }
  function renderedPages() {
    var out = [], st = S;
    if (!st) return out;
    for (var i = 0; i < st.pages.length; i++) if (st.pages[i].state === "rendered") out.push(i);
    return out;
  }

  // ---- public: text index and find ------------------------------------------------------------------
  function getIndex(st, i, tc) {
    if (!st.indexCache[i]) st.indexCache[i] = indexFromContent(tc);
    return st.indexCache[i];
  }
  function textIndex(i) {
    var st = S;
    i = Number(i) | 0;
    if (!st || !st.pdf) return Promise.reject(err("no_doc", "No document open"));
    if (i < 0 || i >= st.numPages) return Promise.reject(err("bad_page", "No page " + i));
    if (st.indexCache[i]) return Promise.resolve(st.indexCache[i]);
    return getProxy(st, i).then(function (page) { return page.getTextContent(); }).then(function (tc) {
      if (S !== st) throw err("closed", "Document was closed");
      return getIndex(st, i, tc);
    });
  }
  function find(query) {
    var st = S;
    if (!st || !st.pdf) return Promise.resolve([]);
    var q = String(query == null ? "" : query).trim();
    if (!q) return Promise.resolve([]);
    var seq = ++st.findSeq, results = [], next = 0, n = st.numPages;
    function lane() {
      if (S !== st || seq !== st.findSeq || next >= n) return Promise.resolve();
      var i = next++;
      return textIndex(i).then(function (index) {
        if (index && index.hasText) {
          var hits = findInIndex(index, q);
          for (var k = 0; k < hits.length; k++) results.push({ pageIndex: i, start: hits[k].start, end: hits[k].end });
        }
      }, noop).then(lane);
    }
    var lanes = [];
    for (var k = 0; k < FIND_LANES; k++) lanes.push(lane());
    return Promise.all(lanes).then(function () {
      results.sort(function (a, b) { return a.pageIndex - b.pageIndex || a.start - b.start; });
      return results;
    });
  }

  // ---- public: capture (§15) -------------------------------------------------------------------------
  function capture(i, rectCss, opts) {
    var st = S;
    if (!st || !st.pdf) return Promise.reject(err("no_doc", "No document open"));
    if (typeof document === "undefined") return Promise.reject(err("capture", "No DOM"));
    i = Number(i) | 0;
    if (i < 0 || i >= st.numPages) return Promise.reject(err("bad_page", "No page " + i));
    var rect = normRect(rectCss);
    if (!(rect.w > 0 && rect.h > 0)) return Promise.reject(err("bad_rect", "Empty region"));
    var k = (opts && opts.k > 0) ? opts.k : 3, z = st.scale, dpr = root.devicePixelRatio || 1;
    if (st.captureTask) { try { st.captureTask.cancel(); } catch (e) {} st.captureTask = null; }
    var seq = ++st.captureSeq;
    return getProxy(st, i).then(function (page) {
      if (S !== st || seq !== st.captureSeq) throw err("cancelled", "Capture superseded");
      var cs = captureScale(rect, z, dpr, k);
      var vp = page.getViewport({ scale: cs.s, rotation: page.rotate, offsetX: -rect.x * cs.f, offsetY: -rect.y * cs.f });
      var canvas = document.createElement("canvas");
      canvas.width = cs.width; canvas.height = cs.height;
      var ctx = canvas.getContext("2d", { alpha: false });
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      var task = page.render({ canvasContext: ctx, viewport: vp });
      st.captureTask = task;
      function free() { try { canvas.width = canvas.height = 0; } catch (e) {} }
      return task.promise.then(function () {
        if (st.captureTask === task) st.captureTask = null;
        if (seq !== st.captureSeq) { free(); throw err("cancelled", "Capture superseded"); }
        return new Promise(function (resolve, reject) {
          canvas.toBlob(function (blob) {
            free();
            if (blob) resolve(blob); else reject(err("capture", "Could not encode the image"));
          }, "image/png");
        });
      }, function (e) {
        if (st.captureTask === task) st.captureTask = null;
        free();
        throw isCancel(e) ? err("cancelled", "Capture cancelled") : err("capture", (e && e.message) || "Render failed");
      });
    });
  }

  // ---- public: outline -------------------------------------------------------------------------------
  function outline() {
    var st = S;
    if (!st || !st.pdf) return Promise.resolve(null);
    return st.pdf.getOutline().then(function (o) { return Array.isArray(o) && o.length ? o : null; }, function () { return null; });
  }
  function resolvePageIndex(dest) {
    var st = S;
    if (!st || !st.pdf || dest == null) return Promise.resolve(null);
    var pdf = st.pdf;
    return Promise.resolve(dest).then(function (d) {
      return typeof d === "string" ? pdf.getDestination(d) : d;
    }).then(function (arr) {
      if (!Array.isArray(arr) || !arr.length) return null;
      var ref = arr[0];
      if (typeof ref === "number") return ref;
      if (ref && typeof ref === "object") return pdf.getPageIndex(ref);
      return null;
    }).then(function (i) {
      return typeof i === "number" && i >= 0 && i < st.numPages ? i : null;
    }).catch(function () { return null; });
  }
  function isOpen() { return !!(S && S.pdf); }
  function numPages() { return S ? S.numPages : 0; }

  var api = {
    open: open, close: close, outline: outline, resolvePageIndex: resolvePageIndex,
    pageTops: pageTops, pageHeights: pageHeights, viewport: viewport, pageView: pageView, renderedPages: renderedPages,
    setScale: setScale, getScale: getScale, scrollTo: scrollTo, textIndex: textIndex, find: find, capture: capture,
    currentPage: currentPage, pageLabel: pageLabel, setPassword: setPassword,
    // extensions (not in §17): scaleMode, fitScale, isOpen, numPages, helpers (pure, for the node tests)
    scaleMode: scaleMode, fitScale: currentFitScale, isOpen: isOpen, numPages: numPages,
    GAP: GAP, FIT_CAP: FIT_CAP, MAX_PIXELS: MAX_PIXELS, MIN_SCALE: MIN_SCALE, MAX_SCALE: MAX_SCALE, GESTURE_IDLE_MS: GESTURE_IDLE_MS,
    helpers: { fitScale: fitScale, cappedDpr: cappedDpr, captureScale: captureScale, layoutTops: layoutTops, pageAt: pageAt,
      indexFromContent: indexFromContent, findInIndex: findInIndex, normRect: normRect, anchorScroll: anchorScroll,
      anchorOffsets: anchorOffsets, zoomHold: zoomHold }
  };
  M.pdfview = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

/* SELF-CHECK — M.pdfview implements (SPEC §17.2 + task): open(u8, {container}) → Promise<Doc> (codes
 * no_pdfjs|invalid|password); outline(); resolvePageIndex(dest); pageTops(); pageHeights(); viewport(i);
 * pageView(i); renderedPages(); setScale(scale|"fit", {anchor, gesture}) (§17 extension, BUILD-NOTES
 * "Post-review decisions": anchor {clientX, clientY} keeps that document point fixed, through a whole gesture and
 * also while the page still fits (a gesture step may hold #pages with margins until the gesture idles); gesture
 * defers the re-render until GESTURE_IDLE_MS = 150 ms after the last step); getScale(); scrollTo({pageIndex,
 * yPdf|fraction}); textIndex(i) → {text, starts, map, items}; find(query); capture(i, rectCss, {k}); close();
 * currentPage(); pageLabel(i); setPassword(pw).  Extensions: scaleMode(), fitScale() (the fit scale now, or null),
 * isOpen(), numPages(), MIN_SCALE, MAX_SCALE, GESTURE_IDLE_MS, helpers.anchorScroll / anchorOffsets / zoomHold.
 * Stale pages keep .hlLayer and .dimLayer during a zoom; overflow-x: hidden (stack) is never scrolled sideways.
 * Events: pages:measured, scale:changed (also when a zoom hold ends and the column moves), page:rendered,
 * page:evicted, page:textready, scroll:settled, doc:password, doc:progress.  Loader: getDocument always
 * receives isEvalSupported:false (CVE-2024-4367). */
