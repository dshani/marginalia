/*
 * js/snip.js — M.snip
 * Snip mode: drag a rectangle over a page, capture it at 3× device pixels (M.pdfview.capture) and put
 * a PNG or, via M.vision, its LaTeX on the clipboard INSIDE the pointerup gesture.  SPEC §15
 * "Interaction" and "Clipboard inside the gesture", §17.2; BUILD-NOTES key routing (run: snip,
 * snipMode, escape while armed).  Snips never create prompts, anchors or history (D6, D21).
 * Bus: emits "snip:state" {armed, mode, latexAvailable} for the toolbar; listens to settings:changed
 * (snipMode), editor:opened/closed (toast buttons) and doc:closed (leaves snip mode).
 */
(function (root) {
  "use strict";
  var M = root.Marginalia = root.Marginalia || {};
  function dep(name) { return M[name] || (typeof require === "function" ? require("./" + name + ".js") : undefined); }
  function mod(name) { try { return dep(name); } catch (e) { return undefined; } }

  var MIN_SIZE = 8;                 // CSS px: smaller drags are clicks and just leave snip mode
  var DRAG_SLOP = 2;
  var TOAST_TTL = 8000, PENDING_TTL = 45000;
  var HINT_NO_BACKEND = "Add an API key in Settings to transcribe LaTeX";
  var ERROR_TEXT = {
    no_math: "No equation found",
    refusal: "The model declined this image",
    cutoff: "Transcription was cut off — try a smaller region",
    no_backend: HINT_NO_BACKEND,
    not_granted: "LaTeX transcription is not available here",
    images_unavailable: "LaTeX transcription is not available here",
    auth: "API key rejected — check Settings",
    rate_limit: "Rate limited — try again shortly",
    server: "Claude is overloaded — try again",
    network: "The browser blocked the request or you are offline"
  };

  var state = {
    inited: false, armed: false, seq: 0, controller: null, drag: null, rectEl: null,
    listeners: [], offs: [], result: null, toast: null, backend: undefined, localMode: "image", urls: []
  };

  // ---- utilities -----------------------------------------------------------------------------------
  function noop() {}
  function err(code, message) { var e = new Error(message || code); e.code = code; return e; }
  function emit(type, payload) {
    var bus = M.bus;
    if (bus && typeof bus.emit === "function") { try { bus.emit(type, payload); } catch (e) {} }
  }
  function onBus(type, fn) {
    var bus = M.bus;
    if (bus && typeof bus.on === "function") {
      try { var off = bus.on(type, fn); return typeof off === "function" ? off : function () { try { bus.off(type, fn); } catch (e) {} }; } catch (e) {}
    }
    return noop;
  }
  function esc(s) {
    s = String(s == null ? "" : s);
    var u = M.util;
    if (u && typeof u.escapeHtml === "function") { try { return u.escapeHtml(s); } catch (e) {} }
    return s.replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]; });
  }
  function isMac() {
    try { var n = root.navigator || {}; return /Mac|iPhone|iPad|iPod/.test(n.platform || "") || /Macintosh/.test(n.userAgent || ""); }
    catch (e) { return true; }
  }
  function pasteKey() { return isMac() ? "Cmd+V" : "Ctrl+V"; }
  function byId(id) { return typeof document === "undefined" ? null : document.getElementById(id); }
  function overlayEl() { return byId("snipOverlay"); }
  function scrollerEl() { return byId("scroller"); }
  function pagesEl() { return byId("pages"); }
  function toastApi() { var a = M.app; return a && typeof a.toast === "function" ? a : null; }
  function activeEditor() {
    try { var m = M.margin; if (m && typeof m.activeEditor === "function") { var e1 = m.activeEditor(); if (e1) return e1; } } catch (x1) {}
    try { var l = M.library; if (l && typeof l.activeEditor === "function") { var e2 = l.activeEditor(); if (e2) return e2; } } catch (x2) {}
    return null;
  }
  function listen(target, type, fn, opts) {
    if (!target) return;
    target.addEventListener(type, fn, opts || false);
    state.listeners.push([target, type, fn, opts || false]);
  }
  function unlistenAll() {
    state.listeners.forEach(function (l) { try { l[0].removeEventListener(l[1], l[2], l[3]); } catch (e) {} });
    state.listeners = [];
  }
  function prevent(ev) { ev.preventDefault(); }
  function objectUrl(blob) {
    try { if (root.URL && typeof root.URL.createObjectURL === "function") { var u = root.URL.createObjectURL(blob); state.urls.push(u); return u; } } catch (e) {}
    return null;
  }
  function revokeUrls() {
    var urls = state.urls; state.urls = [];
    urls.forEach(function (u) { try { root.URL.revokeObjectURL(u); } catch (e) {} });
  }

  // ---- pure helpers (api.helpers, exercised by the node tests) -------------------------------------
  function rectFromPoints(x0, y0, x1, y1) {
    var x = Math.min(x0, x1), y = Math.min(y0, y1);
    return { x: x, y: y, w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
  }
  function clampRect(r, b) {
    var x1 = Math.max(r.x, b.left), y1 = Math.max(r.y, b.top);
    var x2 = Math.min(r.x + r.w, b.right), y2 = Math.min(r.y + r.h, b.bottom);
    return { x: x1, y: y1, w: Math.max(0, x2 - x1), h: Math.max(0, y2 - y1) };
  }
  // Toast contents for a snip result: {text, hint, latex, display, thumb, pending, error, actions:[{id,label}]}
  function describe(res, ctx) {
    ctx = ctx || {};
    var paste = ctx.paste || "Cmd+V";
    var other = res.mode === "image" ? "latex" : "image";
    var sw = { id: "switch", label: other === "latex" ? "Switch to LaTeX" : "Switch to Image" };
    var d = { text: "", hint: res.hint || "", latex: null, display: false, thumb: !!res.blob, actions: [], pending: false, error: null };
    var insertLabel = res.copied === false ? "Insert at cursor" : "Add to prompt";
    if (res.captureError) {
      d.text = "Could not capture the region — try again";
      d.error = res.captureError.code || "capture";
      d.actions = [sw];
      return d;
    }
    if (res.mode === "image") {
      if (!res.blob) { d.text = "Capturing…"; d.pending = true; d.actions = [sw]; return d; }
      if (res.copied === true) d.text = "Image copied — press " + paste + " where you want it";
      else if (res.copied === false) { d.text = "Image captured — the clipboard was unavailable"; d.actions.push({ id: "copy", label: "Copy" }); }
      else { d.text = "Copying image…"; d.pending = true; }
      if (ctx.editor) d.actions.push({ id: "insert", label: insertLabel });
      d.actions.push(sw);
      return d;
    }
    if (res.error) {
      var code = res.error.code || "network", msg = res.error.message || "";
      var fixed = code === "no_math" || code === "refusal" || code === "cutoff" || code === "no_backend";
      d.text = fixed ? ERROR_TEXT[code] : (msg || ERROR_TEXT[code] || "Transcription failed");
      d.error = code;
      if (code === "no_backend" || code === "not_granted" || code === "images_unavailable") d.hint = d.hint || HINT_NO_BACKEND;
      if (res.blob) d.actions.push({ id: "copyImage", label: "Copy image" });
      d.actions.push(sw);
      return d;
    }
    if (!res.latex) { d.text = "Transcribing… (the clipboard updates when done)"; d.pending = true; d.actions = [sw]; return d; }
    d.latex = String(res.latex.latex || "");
    d.display = !!res.latex.display;
    if (res.copied === true) d.text = "LaTeX copied — press " + paste + " where you want it";
    else if (res.copied === false) { d.text = "LaTeX ready — the clipboard was unavailable"; d.actions.push({ id: "copy", label: "Copy" }); }
    else { d.text = "LaTeX ready — copying…"; d.pending = true; }
    var hints = [];
    if (d.hint) hints.push(d.hint);
    if (res.latex.cutOff) hints.push(ERROR_TEXT.cutoff);
    if (res.katexError) hints.push("May not render: " + res.katexError);
    d.hint = hints.join(" · ");
    if (ctx.editor) d.actions.push({ id: "insert", label: insertLabel });
    d.actions.push(sw);
    return d;
  }

  // ---- mode ----------------------------------------------------------------------------------------
  function mode() {
    var s = M.settings, m;
    if (s && typeof s.get === "function") { try { m = s.get("snipMode"); } catch (e) {} }
    else m = state.localMode;
    return m === "latex" ? "latex" : "image";
  }
  function setMode(m) {
    m = m === "latex" ? "latex" : "image";
    var s = M.settings, done = false;
    if (s && typeof s.set === "function") { try { s.set("snipMode", m); done = true; } catch (e) {} }
    if (!done) state.localMode = m;
    emitState();
    return m;
  }
  function toggleMode() {
    ensureInit();
    var next = mode() === "image" ? "latex" : "image";
    if (next === "latex" && state.backend === null) { noBackendHint(); refreshBackend(); return mode(); }
    return setMode(next);
  }
  function latexAvailable() { return state.backend !== null; }     // unknown (not detected yet) counts as available
  function emitState() { emit("snip:state", { armed: state.armed, mode: mode(), latexAvailable: latexAvailable() }); }
  function refreshBackend() {
    var v = M.vision;
    if (!v || typeof v.detect !== "function") { state.backend = null; return Promise.resolve(null); }
    var p;
    try { p = Promise.resolve(v.detect()); } catch (e) { p = Promise.resolve(null); }
    return p.then(function (b) {
      var was = state.backend;
      state.backend = b || null;
      if (was !== state.backend) emitState();
      return state.backend;
    }, function () { state.backend = null; emitState(); return null; });
  }
  function noBackendHint() {
    var app = toastApi();
    if (app) { try { app.toast({ id: "snip-hint", text: HINT_NO_BACKEND, ttl: 4000 }); } catch (e) {} }
  }

  // ---- lifecycle -----------------------------------------------------------------------------------
  function ensureInit() {
    if (state.inited) return;
    state.inited = true;
    state.offs.push(onBus("settings:changed", function (p) {
      if (!p) return;
      if (p.key === "snipMode") emitState();
      else if (p.key === "visionModel" || p.key === "apiKey") refreshBackend();
    }));
    state.offs.push(onBus("editor:opened", rerender));
    state.offs.push(onBus("editor:closed", rerender));
    state.offs.push(onBus("doc:closed", function () { exit(); }));
    // A zoom (a pinch over the overlay itself, ⌘= / ⌘−, a refit) or a breakpoint moves and resizes the page column
    // without scrolling: the armed overlay follows it (positionOverlay does nothing while disarmed).
    state.offs.push(onBus("scale:changed", function () { positionOverlay(); }));
    state.offs.push(onBus("reader:mode", function () { positionOverlay(); }));
    if (typeof document !== "undefined") document.addEventListener("paste", function () { if (state.armed) exit(); }, true);
    refreshBackend();
  }
  if (typeof window !== "undefined") setTimeout(function () { ensureInit(); }, 0);

  // ---- snip mode: overlay and drag -----------------------------------------------------------------
  function enter() {
    ensureInit();
    if (typeof document === "undefined") return false;
    var ov = overlayEl();
    if (!ov) return false;
    if (state.armed) { positionOverlay(); return true; }
    state.armed = true;
    state.drag = null;
    ov.innerHTML = "";
    var r = document.createElement("div");
    r.className = "snip-rect";
    r.style.display = "none";
    ov.appendChild(r);
    state.rectEl = r;
    ov.classList.remove("is-hidden");
    ov.setAttribute("aria-hidden", "false");
    positionOverlay();
    listen(ov, "pointerdown", onDown);
    listen(ov, "pointermove", onMove);
    listen(ov, "pointerup", onUp);
    listen(ov, "pointercancel", onCancel);
    listen(ov, "contextmenu", prevent);
    listen(ov, "dragstart", prevent);
    listen(root, "resize", positionOverlay);
    var sc = scrollerEl();
    if (sc) listen(sc, "scroll", positionOverlay, { passive: true });
    refreshBackend();
    emitState();
    return true;
  }
  function exit() {
    if (!state.armed) return false;
    state.armed = false;
    state.drag = null;
    unlistenAll();
    var ov = overlayEl();
    if (ov) { ov.classList.add("is-hidden"); ov.setAttribute("aria-hidden", "true"); ov.innerHTML = ""; }
    state.rectEl = null;
    emitState();
    return true;
  }
  function isArmed() { return state.armed; }
  // Key routing (BUILD-NOTES): snip toggles the mode on/off, snipMode flips Image/LaTeX, escape leaves.
  function run(id) {
    if (id === "snip") { if (state.armed) exit(); else enter(); return true; }
    if (id === "snipMode") { toggleMode(); return true; }
    if (id === "escape") { if (state.armed) { exit(); return true; } return false; }
    return false;
  }
  // The overlay is fixed over the visible part of the page column (#pages ∩ #scroller), minus the margin when
  // the sticky #margin sits over a zoomed page (BUILD-NOTES "Post-review decisions"): the cards stay usable and
  // a snip never takes page content the margin hides.
  function positionOverlay() {
    var ov = overlayEl(), sc = scrollerEl();
    if (!ov || !sc || !state.armed) return;
    var sr = sc.getBoundingClientRect(), pg = pagesEl(), pr = pg ? pg.getBoundingClientRect() : sr;
    var left = Math.max(sr.left, pr.left), right = Math.min(sr.right, pr.right);
    var mg = byId("margin"), mr = mg && mg.offsetWidth ? mg.getBoundingClientRect() : null;
    if (mr && mr.width > 0 && mr.left > left && mr.left < right) right = mr.left;
    if (!(right - left > 0)) { left = sr.left; right = sr.right; }
    ov.style.position = "fixed";
    ov.style.left = left + "px";
    ov.style.top = sr.top + "px";
    ov.style.width = (right - left) + "px";
    ov.style.height = sr.height + "px";
  }
  // The div.page under a client point: elementsFromPoint sees through the overlay; geometry from
  // M.pdfview.pageView(i).el is the fallback.
  function pageAtPoint(x, y) {
    if (typeof document === "undefined") return null;
    var els = typeof document.elementsFromPoint === "function" ? document.elementsFromPoint(x, y) : [];
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.classList && el.classList.contains("page") && el.hasAttribute("data-page-index")) {
        return { pageIndex: +el.getAttribute("data-page-index"), rect: el.getBoundingClientRect() };
      }
    }
    var pv = M.pdfview;
    if (pv && typeof pv.renderedPages === "function" && typeof pv.pageView === "function") {
      var idxs = pv.renderedPages();
      for (var k = 0; k < idxs.length; k++) {
        var v = pv.pageView(idxs[k]);
        if (!v || !v.el) continue;
        var rc = v.el.getBoundingClientRect();
        if (x >= rc.left && x <= rc.right && y >= rc.top && y <= rc.bottom) return { pageIndex: idxs[k], rect: rc };
      }
    }
    return null;
  }
  function onDown(ev) {
    if (ev.button !== 0 && ev.pointerType === "mouse") return;
    ev.preventDefault();
    var hit = pageAtPoint(ev.clientX, ev.clientY), ov = overlayEl();
    state.drag = {
      pointerId: ev.pointerId, x0: ev.clientX, y0: ev.clientY, x1: ev.clientX, y1: ev.clientY, moved: false,
      pageIndex: hit ? hit.pageIndex : -1,
      page: hit ? { left: hit.rect.left, top: hit.rect.top, right: hit.rect.right, bottom: hit.rect.bottom } : null
    };
    if (ov && typeof ov.setPointerCapture === "function") { try { ov.setPointerCapture(ev.pointerId); } catch (e) {} }
    drawRect();
  }
  function onMove(ev) {
    var d = state.drag;
    if (!d || (d.pointerId != null && ev.pointerId != null && ev.pointerId !== d.pointerId)) return;
    d.x1 = ev.clientX; d.y1 = ev.clientY;
    if (Math.abs(d.x1 - d.x0) > DRAG_SLOP || Math.abs(d.y1 - d.y0) > DRAG_SLOP) d.moved = true;
    drawRect();
  }
  function onUp(ev) {
    var d = state.drag;
    if (!d) return;
    state.drag = null;
    d.x1 = ev.clientX; d.y1 = ev.clientY;
    var ov = overlayEl();
    if (ov && typeof ov.releasePointerCapture === "function") { try { ov.releasePointerCapture(d.pointerId); } catch (e) {} }
    var r = dragRect(d);
    if (r && r.w >= MIN_SIZE && r.h >= MIN_SIZE && d.pageIndex >= 0) {
      // synchronous inside the gesture: the clipboard write must start here
      handleRegion(d.pageIndex, { x: r.x - d.page.left, y: r.y - d.page.top, w: r.w, h: r.h });
    }
    exit();   // one-shot: a capture and a click without drag both leave snip mode
  }
  function onCancel() { state.drag = null; drawRect(); }
  function dragRect(d) {
    if (!d || !d.page) return null;
    return clampRect(rectFromPoints(d.x0, d.y0, d.x1, d.y1), d.page);
  }
  function drawRect() {
    var r = state.rectEl, ov = overlayEl();
    if (!r || !ov) return;
    var cr = dragRect(state.drag);
    if (!cr || !(cr.w > 0) || !(cr.h > 0)) { r.style.display = "none"; return; }
    var or = ov.getBoundingClientRect();
    r.style.display = "block";
    r.style.left = (cr.x - or.left) + "px";
    r.style.top = (cr.y - or.top) + "px";
    r.style.width = cr.w + "px";
    r.style.height = cr.h + "px";
  }

  // ---- clipboard inside the gesture (SPEC §15) ---------------------------------------------------------
  function abortCurrent() {
    var c = state.controller;
    state.controller = null;
    if (c) { try { c.abort(); } catch (e) {} }
    revokeUrls();
  }
  function handleRegion(pageIndex, rectCss) {
    ensureInit();
    var pv = M.pdfview;
    if (!pv || typeof pv.capture !== "function") return false;
    var rect = { x: Number(rectCss.x) || 0, y: Number(rectCss.y) || 0, w: Number(rectCss.w) || 0, h: Number(rectCss.h) || 0 };
    if (!(rect.w > 0 && rect.h > 0)) return false;
    abortCurrent();
    var seq = ++state.seq, m = mode(), hint = null;
    if (m === "latex" && state.backend === null) { m = "image"; hint = HINT_NO_BACKEND; }
    var controller = typeof AbortController === "function" ? new AbortController() : null;
    state.controller = controller;
    var png = pv.capture(pageIndex, rect, { k: 3 });                      // Promise<Blob>
    var res = { seq: seq, mode: m, pageIndex: pageIndex, rect: rect, png: png, text: null, blob: null, latex: null,
      error: null, captureError: null, copied: null, writeError: null, hint: hint, thumbUrl: null, katexError: null, shown: false };
    state.result = res;
    var item;
    if (m === "image") item = { "image/png": png };
    else {
      var text = png.then(function (b) {
        var v = M.vision;
        if (!v || typeof v.transcribe !== "function") throw err("no_backend", HINT_NO_BACKEND);
        return v.transcribe(b, { signal: controller ? controller.signal : undefined });
      });
      res.text = text;
      var textBlob = text.then(function (r) { return new Blob([r.wrapped], { type: "text/plain" }); });
      textBlob.catch(noop);                                              // consumed by ClipboardItem when supported
      item = { "text/plain": textBlob };
    }
    var written;
    try {
      if (typeof ClipboardItem === "undefined" || !root.navigator || !root.navigator.clipboard || typeof root.navigator.clipboard.write !== "function") {
        written = Promise.reject(err("unsupported", "Clipboard images are not supported here"));
      } else written = root.navigator.clipboard.write([new ClipboardItem(item)]);
    } catch (e) { written = Promise.reject(e); }
    written.then(function () { if (res.seq !== state.seq) return; res.copied = true; render(res); },
                 function (e) { if (res.seq !== state.seq) return; res.copied = false; res.writeError = e; render(res); });   // stale failures ignored
    png.then(function (b) { if (res.seq !== state.seq) return; res.blob = b; res.thumbUrl = objectUrl(b); render(res); },
             function (e) { if (res.seq !== state.seq) return; res.captureError = e || err("capture"); render(res); });   // a cancel by a newer snip is stale
    if (res.text) {
      res.text.then(function (r) {
        if (res.seq !== state.seq) return;
        res.latex = r || { latex: "", display: false, wrapped: "", cutOff: false };
        res.katexError = r && r.warning ? String(r.warning).replace(/^May not render:\s*/i, "") : katexCheck(res.latex.latex, res.latex.display);
        render(res);
      }, function (e) {
        if (res.seq !== state.seq || (e && e.code === "superseded")) return;
        res.error = e || err("network");
        render(res);
      });
    }
    render(res);
    return true;
  }
  function katexCheck(latex, display) {
    var k = root.katex;
    if (!k || typeof k.renderToString !== "function" || !latex) return null;
    try { k.renderToString(latex, { throwOnError: true, displayMode: !!display, strict: "ignore" }); return null; }
    catch (e) { return (e && e.message) || "invalid LaTeX"; }
  }
  function copyText(text) {
    text = String(text == null ? "" : text);
    var p;
    try {
      var c = root.navigator && root.navigator.clipboard;
      p = c && typeof c.writeText === "function" ? c.writeText(text) : Promise.reject(err("unsupported"));
    } catch (e) { p = Promise.reject(e); }
    return p.then(function () { return true; }, function () { return execCopy(text); });
  }
  function execCopy(text) {
    if (typeof document === "undefined" || !document.body) return false;
    try {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      var ok = !!(document.execCommand && document.execCommand("copy"));
      document.body.removeChild(ta);
      return ok;
    } catch (e) { return false; }
  }
  function copyBlob(blob) {
    if (!blob) return Promise.resolve(false);
    try {
      var c = root.navigator && root.navigator.clipboard;
      if (typeof ClipboardItem === "undefined" || !c || typeof c.write !== "function") return Promise.resolve(false);
      var item = {};
      item[blob.type || "image/png"] = blob;
      return c.write([new ClipboardItem(item)]).then(function () { return true; }, function () { return false; });
    } catch (e) { return Promise.resolve(false); }
  }

  // ---- toasts ----------------------------------------------------------------------------------------
  function closeToast() {
    var t = state.toast;
    state.toast = null;
    if (t && typeof t.close === "function") { try { t.close(); } catch (e) {} }
  }
  function flash(text, ttl) {
    var app = toastApi();
    if (!app) return;
    closeToast();
    try { state.toast = app.toast({ id: "snip", text: text, ttl: ttl || 4000 }) || null; } catch (e) { state.toast = null; }
  }
  function rerender() {
    var res = state.result;
    if (res && res.seq === state.seq && res.shown) render(res);
  }
  // M.app.toast actions: {label, run(handle), keep} — keep: true leaves the toast open after the click
  // (the copy and switch actions re-render it themselves).
  function act(label, fn, id) {
    return { id: id, label: label, keep: id === "copy" || id === "switch", run: function (handle) { try { fn(handle); } catch (e) {} } };
  }
  function previewHtml(latex, display, wrapped) {
    var mk = M.markup;
    if (mk && typeof mk.render === "function") {
      try { return mk.render(wrapped || latex, { mask: null, mode: "preview", imageUrl: function () { return null; } }); } catch (e) {}
    }
    var k = root.katex;
    if (k && typeof k.renderToString === "function") {
      try { return k.renderToString(latex, { throwOnError: false, displayMode: !!display, output: "html", strict: "ignore" }); } catch (e2) {}
    }
    return '<code class="tex">' + esc(latex) + "</code>";
  }
  // The toast's extra node: thumbnail, mono LaTeX line and KaTeX preview (the text and hint are the
  // toast's own text / detail lines).  Everything is escaped or produced by M.markup.render.
  function buildHtml(res, d) {
    if (!(d.thumb && res.thumbUrl) && !d.latex) return "";
    var h = '<div class="snip-toast">';
    if (d.thumb && res.thumbUrl) h += '<img class="snip-thumb" alt="" src="' + esc(res.thumbUrl) + '">';
    if (d.latex) h += '<div class="snip-toast__main"><div class="snip-tex" title="' + esc(d.latex) + '">' + esc(d.latex) + "</div>" +
      '<div class="snip-preview">' + previewHtml(d.latex, d.display, res.latex && res.latex.wrapped) + "</div></div>";
    return h + "</div>";
  }
  function buildBody(res, d) {
    if (typeof document === "undefined") return null;
    var html = buildHtml(res, d);
    if (!html) return null;
    var el = document.createElement("div");
    el.innerHTML = html;
    return el.firstChild;
  }
  function render(res) {
    if (res.seq !== state.seq) return;
    var app = toastApi();
    if (!app) return;
    var d = describe(res, { editor: !!activeEditor(), paste: pasteKey() });
    res.shown = true;
    var body = buildBody(res, d);
    var actions = d.actions.map(function (a) { return act(a.label, function () { onAction(res, a.id); }, a.id); });
    closeToast();
    var t = null;
    try {
      t = app.toast({ id: "snip", text: d.text, detail: d.hint || undefined, node: body, actions: actions,
        ttl: d.pending ? PENDING_TTL : TOAST_TTL, className: "toast--snip" });
    } catch (e) { t = null; }
    state.toast = t || null;
  }
  function onAction(res, id) {
    if (res.seq !== state.seq) return;
    if (id === "switch") {
      var other = res.mode === "image" ? "latex" : "image";
      if (other === "latex" && state.backend === null) { noBackendHint(); return; }
      setMode(other);
      handleRegion(res.pageIndex, res.rect);              // the click is a fresh gesture: re-snip in the new mode
      return;
    }
    if (id === "copy") {
      var p = res.mode === "image" ? copyBlob(res.blob) : copyText(res.latex ? res.latex.wrapped : "");
      p.then(function (ok) { if (res.seq !== state.seq) return; res.copied = !!ok; render(res); });
      return;
    }
    if (id === "copyImage") {
      copyBlob(res.blob).then(function (ok) {
        if (res.seq !== state.seq) return;
        flash(ok ? "Image copied — press " + pasteKey() + " where you want it" : "Could not copy the image");
      });
      return;
    }
    if (id === "insert") {
      var ed = activeEditor();
      if (!ed) return;
      try {
        if (res.mode === "latex" && res.latex) { if (typeof ed.insertAtCaret === "function") ed.insertAtCaret(res.latex.wrapped); }
        else if (res.blob && typeof ed.insertAttachment === "function") Promise.resolve(ed.insertAttachment(res.blob)).catch(noop);
      } catch (e) {}
      closeToast();
      try { if (typeof ed.focus === "function") ed.focus(); } catch (e2) {}
    }
  }

  var api = {
    enter: enter, exit: exit, isArmed: isArmed, mode: mode, setMode: setMode, toggleMode: toggleMode, run: run,
    handleRegion: handleRegion, copyText: copyText, copyBlob: copyBlob,
    // extensions (not in §17): refreshBackend, latexAvailable, helpers (pure, for the node tests)
    refreshBackend: refreshBackend, latexAvailable: latexAvailable, MIN_SIZE: MIN_SIZE,
    helpers: { rectFromPoints: rectFromPoints, clampRect: clampRect, describe: describe, pasteKey: pasteKey, ERROR_TEXT: ERROR_TEXT }
  };
  M.snip = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

/* SELF-CHECK — M.snip implements (SPEC §17.2 + BUILD-NOTES key routing): enter(); exit(); isArmed();
 * mode(); setMode(m); toggleMode(); run(id) → boolean (snip, snipMode, escape while armed);
 * handleRegion(pageIndex, rectCss) (synchronous clipboard write inside the gesture, seq counter,
 * AbortController, stale failures ignored); copyText(text); copyBlob(blob).  Emits "snip:state"
 * {armed, mode, latexAvailable}; listens to settings:changed, editor:opened/closed, doc:closed, and scale:changed /
 * reader:mode (the armed overlay follows the page column and the margin's left edge). */
