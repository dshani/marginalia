/* js/anchors.js — Marginalia anchors (SPEC §5, §17; BUILD-NOTES "pdfview text index").
 *
 * Stored anchors live in PDF user space (points, y up). Everything here is pure except
 * fromSelection, which only reads the Range / element objects it is handed (no globals),
 * so the whole file loads and runs in node. */
(function (root) {
  "use strict";
  var M = root.Marginalia = root.Marginalia || {};
  function dep(name) { return M[name] || (typeof require === "function" ? require("./" + name + ".js") : undefined); }
  // The one dependency, read when sentenceAround runs: M.prompts.escapeCues (FEATURES P1.1 e).

  var ASCENT = 0.8;        // item box: y2 = y + ASCENT·height
  var DESCENT = -0.2;      // item box: y1 = y + DESCENT·height
  var HEAD = 40;           // refind strategies 3 and 4 use quote.slice(0, 40)
  var CONTEXT = 32;        // prefix / suffix length
  var MAX_QUOTE = 500;     // characters (code points), so a cut never splits a surrogate pair
  var MAX_PAGES = 2;       // selections over more pages are truncated
  var MIN_OVERLAP = 0.5;   // line merge: vertical overlap > 50 % of the shorter box

  // ------------------------------------------------------------------ numbers & rects

  function num(v, d) { v = Number(v); return isFinite(v) ? v : d; }
  function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }
  function round2(v) { return Math.round(v * 100) / 100; }
  function roundRect(r) { return [round2(r[0]), round2(r[1]), round2(r[2]), round2(r[3])]; }
  function normalizeRect(r) {
    return [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
  }
  function isRect(r) {
    return Array.isArray(r) && r.length >= 4 && isFinite(r[0]) && isFinite(r[1]) && isFinite(r[2]) && isFinite(r[3]);
  }

  // Merge boxes that sit on one line: vertical overlap > 50 % of the shorter box.
  // Order of first appearance is kept (reading order in, reading order out).
  function mergeLines(rects) {
    var lines = [];
    for (var i = 0; i < rects.length; i++) {
      var r = rects[i], placed = false;
      for (var j = 0; j < lines.length; j++) {
        var L = lines[j];
        var overlap = Math.min(r[3], L[3]) - Math.max(r[1], L[1]);
        var shorter = Math.min(r[3] - r[1], L[3] - L[1]);
        if (shorter > 0 && overlap > MIN_OVERLAP * shorter) {
          L[0] = Math.min(L[0], r[0]); L[1] = Math.min(L[1], r[1]);
          L[2] = Math.max(L[2], r[2]); L[3] = Math.max(L[3], r[3]);
          placed = true;
          break;
        }
      }
      if (!placed) lines.push(r.slice(0, 4));
    }
    return lines;
  }

  function toArray(list) {
    if (!list) return [];
    if (Array.isArray(list)) return list;
    var out = [];
    if (typeof list.length === "number") { for (var i = 0; i < list.length; i++) out.push(list[i]); return out; }
    if (typeof list.forEach === "function") { list.forEach(function (v) { out.push(v); }); }
    return out;
  }

  // ------------------------------------------------------------------ text helpers

  function collapseWs(s) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim(); }
  function squashWs(s) { return String(s == null ? "" : s).replace(/\s+/g, " "); }

  function normalizeUnicode(s) {
    s = String(s == null ? "" : s);
    var pdfjs = root.pdfjsLib;
    if (pdfjs && typeof pdfjs.normalizeUnicode === "function") {
      try { var r = pdfjs.normalizeUnicode(s); if (typeof r === "string") return r; } catch (e) { /* fall through */ }
    }
    try { return s.normalize("NFKC"); } catch (e2) { return s; }
  }

  var LIGATURES = { "ﬀ": "ff", "ﬁ": "fi", "ﬂ": "fl", "ﬃ": "ffi", "ﬄ": "ffl", "ﬅ": "st", "ﬆ": "st" };
  var PUNCT = {
    "‘": "'", "’": "'", "‚": "'", "‛": "'", "′": "'",
    "“": "\"", "”": "\"", "„": "\"", "″": "\"",
    "‐": "-", "‑": "-", "‒": "-", "–": "-", "—": "-", "−": "-",
    " ": " "
  };
  var WS_RE = /\s/;

  function normChar(c) {
    if (c === "­" || c === "​" || c === "﻿" || c === "‌" || c === "‍") return "";
    if (LIGATURES[c]) return LIGATURES[c];
    if (PUNCT[c]) return PUNCT[c];
    if (WS_RE.test(c)) return " ";
    try { return c.normalize("NFKC"); } catch (e) { return c; }
  }

  // Whitespace-collapsed, ligature-expanded copy of `text` plus map[normIndex] → original index
  // (map[norm.length] === text.length). Leading whitespace is dropped.
  function normalizeWithMap(text) {
    text = String(text == null ? "" : text);
    var out = "", map = [], prevSpace = true;
    for (var i = 0; i < text.length; i++) {
      var n = normChar(text[i]);
      if (n === "") continue;
      if (n === " ") {
        if (prevSpace) continue;
        prevSpace = true; out += " "; map.push(i);
        continue;
      }
      prevSpace = false;
      for (var j = 0; j < n.length; j++) { out += n[j]; map.push(i); }
    }
    map.push(text.length);
    return { text: out, map: map };
  }
  function normalizeStr(s) { return normalizeWithMap(s).text.replace(/\s+$/, ""); }

  function findAll(hay, needle, limit) {
    var out = [], pos = 0, max = limit || 64;
    if (!needle) return out;
    while (out.length < max) {
      var at = hay.indexOf(needle, pos);
      if (at < 0) break;
      out.push(at); pos = at + 1;
    }
    return out;
  }

  // ------------------------------------------------------------------ text index helpers

  function itemsOf(idx) { return idx && Array.isArray(idx.items) ? idx.items : []; }

  // starts[k] = offset of items[k].str inside idx.text (BUILD-NOTES shape; `map` and a
  // sequential scan are fallbacks).
  function startsOf(idx) {
    if (!idx) return [];
    if (Array.isArray(idx.starts)) return idx.starts;
    if (Array.isArray(idx.map)) return idx.map;
    var text = String(idx.text || ""), items = itemsOf(idx), out = [], pos = 0;
    for (var k = 0; k < items.length; k++) {
      var str = String((items[k] && items[k].str) || "");
      var at = str ? text.indexOf(str, pos) : pos;
      if (at < 0) at = pos;
      out.push(at); pos = at + str.length;
    }
    return out;
  }

  // last k with starts[k] <= pos
  function itemAt(starts, pos) {
    var lo = 0, hi = starts.length - 1, best = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (starts[mid] <= pos) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return best;
  }

  function spanTopY(idx, starts, pos) {
    var k = itemAt(starts, pos);
    if (k < 0) return null;
    var it = itemsOf(idx)[k] || {};
    return num(it.y, 0) + ASCENT * num(it.height, 0);
  }

  function pickNearest(spans, anchor, idx, starts) {
    if (!spans.length) return null;
    if (spans.length === 1) return spans[0];
    var ay = anchor && anchor.y != null ? Number(anchor.y) : NaN;
    if (!isFinite(ay)) return spans[0];
    var best = spans[0], bestD = Infinity;
    for (var i = 0; i < spans.length; i++) {
      var y = spanTopY(idx, starts, spans[i].start);
      var d = y == null ? Infinity : Math.abs(y - ay);
      if (d < bestD) { bestD = d; best = spans[i]; }
    }
    return best;
  }

  function uniq(list) {
    var seen = {}, out = [];
    for (var i = 0; i < list.length; i++) if (list[i] && !seen[list[i]]) { seen[list[i]] = true; out.push(list[i]); }
    return out;
  }

  // The four strategies of §5, in order; returns {start, end, strategy} in original text offsets.
  function locate(anchor, idx, starts) {
    var text = String((idx && idx.text) || "");
    var quote = String((anchor && anchor.quote) || "");
    if (!text || !quote.trim()) return null;
    var hits, picked, i;

    // 1 — exact quote
    hits = findAll(text, quote);
    if (hits.length) {
      var exact = [];
      for (i = 0; i < hits.length; i++) exact.push({ start: hits[i], end: hits[i] + quote.length });
      picked = pickNearest(exact, anchor, idx, starts);
      return { start: picked.start, end: picked.end, strategy: "exact" };
    }

    var nm = normalizeWithMap(text), ntext = nm.text, map = nm.map;
    var nquote = normalizeStr(quote);
    if (!nquote) return null;
    function mapped(list, strategy) {
      var spans = [];
      for (var j = 0; j < list.length; j++) {
        var s = clamp(list[j].start, 0, ntext.length), e = clamp(list[j].end, 0, ntext.length);
        if (e <= s) continue;
        spans.push({ start: map[s], end: map[e] });
      }
      var p = pickNearest(spans, anchor, idx, starts);
      return p ? { start: p.start, end: p.end, strategy: strategy } : null;
    }

    // 2 — whitespace / ligature-normalised quote
    hits = findAll(ntext, nquote);
    if (hits.length) {
      var normal = [];
      for (i = 0; i < hits.length; i++) normal.push({ start: hits[i], end: hits[i] + nquote.length });
      picked = mapped(normal, "normalized");
      if (picked) return picked;
    }

    // 3 — prefix + quote.slice(0, 40)
    var head = nquote.slice(0, HEAD);
    var pfx = normalizeWithMap(anchor.prefix || "").text;
    var pfxT = pfx.replace(/\s+$/, "");
    if (head && pfxT) {
      var combos = uniq([pfx + head, pfxT + head, pfxT + " " + head]);
      for (var c = 0; c < combos.length; c++) {
        hits = findAll(ntext, combos[c]);
        if (!hits.length) continue;
        var byPrefix = [], lead = combos[c].length - head.length;
        for (i = 0; i < hits.length; i++) {
          var st = hits[i] + lead;
          byPrefix.push({ start: st, end: Math.min(st + nquote.length, ntext.length) });
        }
        picked = mapped(byPrefix, "prefix");
        if (picked) return picked;
      }
    }

    // 4 — quote.slice(0, 40)
    if (head && head.length < nquote.length) {
      hits = findAll(ntext, head);
      if (hits.length) {
        var byHead = [];
        for (i = 0; i < hits.length; i++) byHead.push({ start: hits[i], end: Math.min(hits[i] + nquote.length, ntext.length) });
        picked = mapped(byHead, "head");
        if (picked) return picked;
      }
    }
    return null;
  }

  // Items and rects for the text span [start, end) of one page's index.
  function buildAnchor(anchor, idx, starts, pageIndex, start, end) {
    var items = itemsOf(idx), rects = [], first = null, last = null;
    for (var k = 0; k < items.length; k++) {
      var it = items[k] || {};
      var str = String(it.str == null ? "" : it.str), len = str.length;
      if (!len) continue;
      var s = num(starts[k], 0), e = s + len;
      var a = Math.max(start, s), b = Math.min(end, e);
      if (b <= a) continue;
      var o1 = a - s, o2 = b - s;
      var di = typeof it.divIndex === "number" ? it.divIndex : k;
      if (!first) first = { item: di, offset: o1 };
      last = { item: di, offset: o2 };
      var x = num(it.x, 0), y = num(it.y, 0), w = num(it.width, 0), h = num(it.height, 0);
      if (w <= 0 || h <= 0) continue;
      var r = normalizeRect([x + w * o1 / len, y + DESCENT * h, x + w * o2 / len, y + ASCENT * h]);
      if (r[2] - r[0] <= 0 || r[3] - r[1] <= 0) continue;
      rects.push(r);
    }
    if (!rects.length) return null;
    var merged = mergeLines(rects).map(roundRect);
    return {
      pageIndex: pageIndex,
      pages: [{ pageIndex: pageIndex, rects: merged }],
      quote: String(anchor.quote || ""),
      prefix: String(anchor.prefix || ""),
      suffix: String(anchor.suffix || ""),
      items: { start: first, end: last },
      y: merged[0][3],
      lost: false
    };
  }

  // ------------------------------------------------------------------ viewport helpers

  function getViewport(viewports, i) {
    if (!viewports) return null;
    if (typeof viewports === "function") return viewports(i) || null;
    if (typeof viewports.get === "function") return viewports.get(i) || viewports.get(String(i)) || null;
    if (typeof viewports === "object") return viewports[i] || null;
    return null;
  }

  function viewGetter(pageViews) {
    if (typeof pageViews === "function") return function (i) { return pageViews(i) || null; };
    if (pageViews && typeof pageViews.get === "function") {
      return function (i) { return pageViews.get(i) || pageViews.get(String(i)) || null; };
    }
    if (pageViews && typeof pageViews === "object") return function (i) { return pageViews[i] || null; };
    return function () { return null; };
  }

  // ------------------------------------------------------------------ DOM-facing helpers (duck-typed)

  function elementOf(node) {
    if (!node) return null;
    return node.nodeType === 3 ? (node.parentElement || node.parentNode || null) : node;
  }
  function closestPage(node) {
    var el = elementOf(node);
    return el && typeof el.closest === "function" ? (el.closest(".page") || null) : null;
  }
  function pageIndexOf(pageEl, pageViews) {
    if (!pageEl) return null;
    var ds = pageEl.dataset || {};
    var cands = [ds.pageIndex, ds.page, ds.index];
    if (typeof pageEl.getAttribute === "function") cands.push(pageEl.getAttribute("data-page-index"));
    for (var i = 0; i < cands.length; i++) {
      if (cands[i] != null && cands[i] !== "" && isFinite(Number(cands[i]))) return Number(cands[i]);
    }
    if (ds.pageNumber != null && ds.pageNumber !== "" && isFinite(Number(ds.pageNumber))) return Number(ds.pageNumber) - 1;
    var found = null;
    if (pageViews && typeof pageViews !== "function" && typeof pageViews.forEach === "function") {
      pageViews.forEach(function (v, k) { if (found === null && v && v.el === pageEl) found = Number(k); });
    } else if (pageViews && typeof pageViews === "object") {
      for (var key in pageViews) {
        if (Object.prototype.hasOwnProperty.call(pageViews, key) && pageViews[key] && pageViews[key].el === pageEl) { found = Number(key); break; }
      }
    }
    return found !== null && isFinite(found) ? found : null;
  }
  function intersects(range, node) {
    if (!node) return false;
    if (typeof range.intersectsNode === "function") {
      try { return !!range.intersectsNode(node); } catch (e) { return false; }
    }
    try {
      var r = range.cloneRange(); r.selectNodeContents(node);
      return range.compareBoundaryPoints(3, r) < 0 && range.compareBoundaryPoints(1, r) > 0; // END_TO_START, START_TO_END
    } catch (e2) { return false; }
  }
  function textNodeOf(span) {
    var kids = span.childNodes;
    if (kids && typeof kids.length === "number") {
      for (var i = 0; i < kids.length; i++) if (kids[i] && kids[i].nodeType === 3) return kids[i];
    }
    return span.firstChild && span.firstChild.nodeType === 3 ? span.firstChild : null;
  }
  function divText(d) { return d && d.nodeType === 1 ? String(d.textContent == null ? "" : d.textContent) : ""; }
  // Offset into span text of a range boundary that lies in this span, else null.
  function boundaryOffset(container, offset, span, textNode, len) {
    if (textNode && container === textNode) return clamp(num(offset, 0), 0, len);
    if (container === span) return num(offset, 0) <= 0 ? 0 : len;
    return null;
  }

  // ------------------------------------------------------------------ public API

  // Client rects (DOMRectList or array) → merged PDF-space rects for one page.
  function rectsFromClientRects(rects, pageBox, viewport) {
    if (!viewport || typeof viewport.convertToPdfPoint !== "function") return [];
    var list = toArray(rects), box = pageBox || {};
    var bl = num(box.left, num(box.x, 0)), bt = num(box.top, num(box.y, 0));
    var bw = num(box.width, 0), bh = num(box.height, 0);
    var vw = num(viewport.width, 0), vh = num(viewport.height, 0);
    var kx = bw > 0 && vw > 0 ? vw / bw : 1, ky = bh > 0 && vh > 0 ? vh / bh : 1;
    var W = vw > 0 ? vw : bw * kx, H = vh > 0 ? vh : bh * ky;
    var local = [];
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      if (!r) continue;
      var left = num(r.left, num(r.x, NaN)), top = num(r.top, num(r.y, NaN));
      var w = num(r.width, num(r.right, NaN) - left), h = num(r.height, num(r.bottom, NaN) - top);
      if (!isFinite(left) || !isFinite(top) || !(w >= 1 && h >= 1)) continue; // drop rects under 1×1
      var x1 = (left - bl) * kx, y1 = (top - bt) * ky, x2 = x1 + w * kx, y2 = y1 + h * ky;
      if (W > 0) { x1 = Math.max(x1, 0); x2 = Math.min(x2, W); }
      if (H > 0) { y1 = Math.max(y1, 0); y2 = Math.min(y2, H); }
      if (x2 - x1 <= 0 || y2 - y1 <= 0) continue;
      local.push([x1, y1, x2, y2]);
    }
    local.sort(function (a, b) { return a[1] - b[1] || a[0] - b[0]; });
    var merged = mergeLines(local), out = [];
    for (var j = 0; j < merged.length; j++) {
      var m = merged[j];
      var p1 = viewport.convertToPdfPoint(m[0], m[1]), p2 = viewport.convertToPdfPoint(m[2], m[3]);
      out.push(roundRect(normalizeRect([p1[0], p1[1], p2[0], p2[1]])));
    }
    return out;
  }

  // DOM Range (or Selection) + pageViews (function pageIndex → {el, viewport, textDivs} or Map) → Anchor | null.
  function fromSelection(range, pageViews) {
    if (!range) return null;
    if (typeof range.getRangeAt === "function") {
      if (!(range.rangeCount > 0)) return null;
      range = range.getRangeAt(0);
    }
    if (range.collapsed || typeof range.cloneRange !== "function") return null;
    var getView = viewGetter(pageViews);
    var startPage = pageIndexOf(closestPage(range.startContainer), pageViews);
    var endPage = pageIndexOf(closestPage(range.endContainer), pageViews);
    if (startPage == null && endPage == null) return null;
    if (startPage == null) startPage = endPage;
    if (endPage == null) endPage = startPage;
    var first = Math.min(startPage, endPage), last = Math.max(startPage, endPage), truncated = false;
    if (last - first + 1 > MAX_PAGES) { last = first + MAX_PAGES - 1; truncated = true; }

    var pages = [], quotes = [], items = null, prefix = "", suffix = "";
    for (var p = first; p <= last; p++) {
      var view = getView(p);
      if (!view || !view.el || typeof view.el.getBoundingClientRect !== "function") continue;
      var pageBox = view.el.getBoundingClientRect();
      var divs = toArray(view.textDivs);
      var clientRects = [], parts = [], cum = 0, posStart = -1, posEnd = -1, pageStartItem = null, pageEndItem = null;
      for (var d = 0; d < divs.length; d++) {
        var span = divs[d], str = divText(span), len = str.length, start = cum;
        cum += len + 1;
        if (!span || span.nodeType !== 1 || !len || !intersects(range, span)) continue;
        var tn = textNodeOf(span);
        var s = 0, e = len;
        var so = boundaryOffset(range.startContainer, range.startOffset, span, tn, len);
        var eo = boundaryOffset(range.endContainer, range.endOffset, span, tn, len);
        if (so !== null) s = so;
        if (eo !== null) e = eo;
        if (e <= s) continue;
        var rs = [];
        try {
          var sub = range.cloneRange();
          if (tn && (s > 0 || e < len)) { sub.setStart(tn, s); sub.setEnd(tn, e); } else sub.selectNodeContents(span);
          rs = toArray(sub.getClientRects());
        } catch (err) {
          rs = typeof span.getClientRects === "function" ? toArray(span.getClientRects()) : [];
        }
        for (var q = 0; q < rs.length; q++) clientRects.push(rs[q]);
        parts.push(str.slice(s, e));
        if (posStart < 0) { posStart = start + s; pageStartItem = { item: d, offset: s }; }
        posEnd = start + e; pageEndItem = { item: d, offset: e };
      }
      if (posStart < 0) continue;
      var pdfRects = rectsFromClientRects(clientRects, pageBox, view.viewport);
      if (pdfRects.length) pages.push({ pageIndex: p, rects: pdfRects });
      quotes.push(collapseWs(parts.join(" ")));
      if (!items) items = { start: pageStartItem, end: pageEndItem };
      else items.end = pageEndItem;
      var pageText = divs.map(divText).join(" ");
      if (p === first) prefix = squashWs(pageText.slice(Math.max(0, posStart - CONTEXT * 3), posStart)).slice(-CONTEXT);
      if (p === last) suffix = squashWs(pageText.slice(posEnd, posEnd + CONTEXT * 3)).slice(0, CONTEXT);
    }
    if (!pages.length) return null;
    // cut on characters, not UTF-16 units: a cut inside an astral letter (𝑥, U+1D465, kept by pdf.js's normalisation)
    // would leave a lone surrogate, which cannot be percent-encoded or written as UTF-8 (Obsidian copies)
    var quote = Array.from(normalizeUnicode(quotes.join("\n"))).slice(0, MAX_QUOTE).join("");
    var anchor = {
      pageIndex: pages[0].pageIndex,
      pages: pages,
      quote: quote,
      prefix: prefix,
      suffix: suffix,
      items: items,
      y: pages[0].rects[0][3],
      lost: false
    };
    if (truncated) anchor.truncated = true;
    return anchor;
  }

  // Free note: no highlight, only a y.
  function fromMarginY(pageIndex, yPdf) {
    return { pageIndex: num(pageIndex, 0), pages: [], quote: "", prefix: "", suffix: "", items: null, y: num(yPdf, 0), lost: false };
  }

  // Document-space pixel y of an anchor: pageTop + viewport y of anchor.y (lost → page top).
  function anchorY(anchor, pageTops, viewports) {
    var tops = typeof pageTops === "function" ? pageTops() : pageTops;
    tops = Array.isArray(tops) ? tops : [];
    if (!anchor) return tops.length ? num(tops[0], 0) : 0;
    var pi = Math.floor(num(anchor.pageIndex, 0));
    if (tops.length) pi = clamp(pi, 0, tops.length - 1);
    var top = num(tops[pi], 0);
    var y = anchor.y == null ? NaN : Number(anchor.y);
    if (anchor.lost || !isFinite(y)) return top;
    var vp = getViewport(viewports, pi);
    if (!vp || typeof vp.convertToViewportPoint !== "function") return top;
    var pt = vp.convertToViewportPoint(0, y);
    return top + num(pt && pt[1], 0);
  }

  // Rects of one page of the anchor in viewport pixels (y down), normalised; [] when lost.
  function viewportRects(anchor, pageIndex, viewport) {
    if (!anchor || anchor.lost || !Array.isArray(anchor.pages)) return [];
    if (!viewport || typeof viewport.convertToViewportRectangle !== "function") return [];
    var out = [];
    for (var i = 0; i < anchor.pages.length; i++) {
      var page = anchor.pages[i];
      if (!page || num(page.pageIndex, -1) !== num(pageIndex, -2) || !Array.isArray(page.rects)) continue;
      for (var j = 0; j < page.rects.length; j++) {
        if (!isRect(page.rects[j])) continue;
        var v = viewport.convertToViewportRectangle(page.rects[j]);
        if (isRect(v)) out.push(normalizeRect(v));
      }
    }
    return out;
  }

  // rectsByPrompt: [{id, rects: [[x1,y1,x2,y2], …]}] (also Map / object id → rects), point in PDF space.
  // The smallest rect containing the point wins (ties: first in order).
  function hitTest(rectsByPrompt, x, y) {
    var entries = [];
    if (Array.isArray(rectsByPrompt)) entries = rectsByPrompt;
    else if (rectsByPrompt && typeof rectsByPrompt.forEach === "function") {
      rectsByPrompt.forEach(function (rects, id) { entries.push({ id: id, rects: rects }); });
    } else if (rectsByPrompt && typeof rectsByPrompt === "object") {
      for (var k in rectsByPrompt) if (Object.prototype.hasOwnProperty.call(rectsByPrompt, k)) entries.push({ id: k, rects: rectsByPrompt[k] });
    }
    x = Number(x); y = Number(y);
    if (!isFinite(x) || !isFinite(y)) return null;
    var best = null, bestArea = Infinity;
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (!e || e.id == null || !Array.isArray(e.rects)) continue;
      for (var j = 0; j < e.rects.length; j++) {
        var r = e.rects[j];
        if (!isRect(r)) continue;
        var n = normalizeRect(r);
        if (x < n[0] || x > n[2] || y < n[1] || y > n[3]) continue;
        var area = (n[2] - n[0]) * (n[3] - n[1]);
        if (area < bestArea) { bestArea = area; best = e.id; }
      }
    }
    return best;
  }

  // Re-find a quote in one page's text index → fresh Anchor (lost cleared) or null on a miss.
  // The page is textIndex.pageIndex, else the optional third argument, else anchor.pageIndex.
  function refind(anchor, textIndex, pageIndex) {
    if (!anchor || !textIndex || !Array.isArray(textIndex.items)) return null;
    if (!String(anchor.quote || "").trim()) return null;
    var pi = typeof pageIndex === "number" ? pageIndex
      : typeof textIndex.pageIndex === "number" ? textIndex.pageIndex
      : num(anchor.pageIndex, 0);
    var starts = startsOf(textIndex);
    var hit = locate(anchor, textIndex, starts);
    if (!hit) return null;
    return buildAnchor(anchor, textIndex, starts, pi, hit.start, hit.end);
  }

  // before + "{" + quote + "}" + after with whitespace collapsed (as collapseWs does for the whole), and every
  // "::" of the wrapped quote written `\::` so that selected text never makes an accidental cue (FEATURES P1.1 e;
  // M.prompts.escapeCues: text runs only, a "::" that is already escaped stays as it is). Without M.prompts the
  // braces are added as before.
  function braced(before, quote, after) {
    var head = squashWs(before + "{").replace(/^ /, ""), mid = squashWs(quote), tail = squashWs("}" + after).replace(/ $/, "");
    var out = head + mid + tail, P = null;
    try { P = dep("prompts"); } catch (e) { P = null; }
    if (P && typeof P.escapeCues === "function") {
      try { var esc = P.escapeCues(out, head.length, head.length + mid.length); if (typeof esc === "string") out = esc; } catch (e2) { /* keep */ }
    }
    return out;
  }

  // Sentence containing the quote, with the quote wrapped in {}. Sentences end at . ! ? followed
  // by whitespace (so 1.12 stays intact); an optional closing quote/bracket may sit between.
  var TERM_RE = /[.!?]/, CLOSER_RE = /["')\]’”]/;
  function sentenceAround(anchor, textIndex) {
    var quote = String((anchor && anchor.quote) || "");
    if (!quote.trim()) return "";
    var text = String((textIndex && textIndex.text) || "");
    var starts = startsOf(textIndex);
    var hit = text ? locate(anchor, textIndex, starts) : null;
    if (!hit) return braced("", collapseWs(quote), "");
    var start = hit.start, end = hit.end;
    var sStart = 0, i, j;
    for (i = start - 1; i > 0; i--) {
      if (!WS_RE.test(text[i])) continue;
      j = i - 1;
      if (j >= 0 && CLOSER_RE.test(text[j])) j--;
      if (j >= 0 && TERM_RE.test(text[j])) { sStart = i + 1; break; }
    }
    while (sStart < start && WS_RE.test(text[sStart])) sStart++;
    var sEnd = text.length;
    for (i = Math.max(end - 1, start); i < text.length; i++) {
      if (!TERM_RE.test(text[i])) continue;
      j = i + 1;
      if (j < text.length && CLOSER_RE.test(text[j])) j++;
      if (j >= text.length || WS_RE.test(text[j])) { sEnd = j; break; }
    }
    return braced(text.slice(sStart, start), text.slice(start, end), text.slice(end, sEnd));
  }

  var api = {
    rectsFromClientRects: rectsFromClientRects,
    fromSelection: fromSelection,
    fromMarginY: fromMarginY,
    anchorY: anchorY,
    viewportRects: viewportRects,
    hitTest: hitTest,
    refind: refind,
    sentenceAround: sentenceAround,
    ASCENT: ASCENT,
    DESCENT: DESCENT
  };
  M.anchors = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

/* SELF-CHECK (SPEC §17.2 M.anchors): rectsFromClientRects(rects, pageBox, viewport) → pdfRects;
 * fromSelection(range, pageViews) → Anchor|null; fromMarginY(pageIndex, yPdf) → Anchor;
 * anchorY(anchor, pageTops, viewports) → px; viewportRects(anchor, pageIndex, viewport);
 * hitTest(rectsByPrompt, x, y) → promptId|null; refind(anchor, textIndex) → Anchor|null;
 * sentenceAround(anchor, textIndex) → string. Extras: ASCENT, DESCENT constants. fromSelection cuts the quote at
 * MAX_QUOTE (500) characters, never inside a surrogate pair (BUILD-NOTES "Obsidian": well-formed text).
 * sentenceAround writes every "::" of the quote it wraps as `\::` (M.prompts.escapeCues, FEATURES P1.1 e). */
