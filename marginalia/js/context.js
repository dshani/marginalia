/* Marginalia — js/context.js
 * M.context (pure, SPEC §14 / §17.2): PDF outline → sections, section labels, the context line
 * shown on review cards ("Griffiths · Ch. 1 · The Wave Function") and the
 * {docName, sectionLabel, pageIndex, pageLabel} snapshot stored on every prompt.
 * Loads in node without a DOM and has no dependencies. Everything here is synchronous except
 * sectionsFromOutline (it awaits PDF.js destination resolution through the callback it is given).
 */
(function (root) {
  "use strict";
  var M = root.Marginalia = root.Marginalia || {};
  function dep(name) { return M[name] || (typeof require === "function" ? require("./" + name + ".js") : undefined); } // eslint-disable-line no-unused-vars

  var SEP = " · ";          // " · " — the separator of every label and of the context line
  var SECTION_SIGN = "§";   // "§"
  var ELLIPSIS = "…";       // "…"
  var LABEL_MAX = 60;            // normalizeTitle: hard cut of a section label
  var LINE_MAX = 64;             // fit: overflow limit of the context line
  var MAX_BARE_ROMAN = 20;       // a bare roman numeral ("IV Spin") is accepted for I–XX only

  // ---------------------------------------------------------------- small helpers
  function str(v) { return v == null ? "" : String(v); }
  function obj(v) { return v && typeof v === "object" ? v : {}; }
  function collapse(v) { return str(v).replace(/\s+/g, " ").trim(); }
  function nonEmpty(v) { return typeof v === "string" && v.trim() !== ""; }
  function isIndex(v) { return typeof v === "number" && Number.isInteger(v) && v >= 0; }
  function cpLen(s) { return Array.from(s).length; }
  function join(parts) { return parts.filter(nonEmpty).join(SEP); }

  // Hard cut at `max` code points, ending in "…" when something was dropped.
  function cutEnd(s, max) {
    var a = Array.from(s);
    if (a.length <= max) return s;
    if (max <= 1) return ELLIPSIS;
    return a.slice(0, max - 1).join("").replace(/\s+$/, "") + ELLIPSIS;
  }

  // Keep the head and the tail, "…" in the middle; never longer than `max` code points.
  function middleEllipsis(s, max) {
    var a = Array.from(s);
    if (a.length <= max) return s;
    if (max <= 1) return ELLIPSIS;
    var keep = max - 1, head = Math.ceil(keep / 2), tail = keep - head;
    var left = a.slice(0, head).join("").replace(/\s+$/, "");
    var right = tail > 0 ? a.slice(a.length - tail).join("").replace(/^\s+/, "") : "";
    return left + ELLIPSIS + right;
  }

  // ---------------------------------------------------------------- roman numerals
  var ROMAN = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  var RE_ROMAN = /^M{0,3}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/;

  // "IV" → 4; 0 for anything that is not a canonical roman numeral.
  function romanToInt(s) {
    var u = str(s).toUpperCase();
    if (!u || !RE_ROMAN.test(u)) return 0;
    var total = 0;
    for (var i = 0; i < u.length; i++) {
      var v = ROMAN[u.charAt(i)];
      var next = i + 1 < u.length ? ROMAN[u.charAt(i + 1)] : 0;
      total += v < next ? -v : v;
    }
    return total;
  }

  // ---------------------------------------------------------------- normalizeTitle
  // "1.2 Normalization" / "1.2.3. Deep" → "§1.2 Normalization" (any level)
  var RE_SECTION = /^(\d+(?:\.\d+)+)\.?\s+(.+)$/;
  // "Chapter 3: Formalism", "Ch. IV Spin", "Ch 3 - Foo", "Chapter 3" (title optional)
  var RE_CHAPTER = /^(?:chapter|ch\.|ch(?=[\s\d]))\s*(\d+|[ivxlc]+)(?:[:.\s]+(.*))?$/i;
  // "1 The Wave Function", "12. Foo" (level 1 only)
  var RE_ARABIC = /^(\d{1,3})[.:]?\s+(.+)$/;
  // "IV Spin" (level 1 only, I–XX, uppercase)
  var RE_ROMAN_BARE = /^([IVX]+)[.:]?\s+(.+)$/;
  // the "Ch. N" marker normalizeTitle emits (used by fit() to find the level-1 part of a line)
  var RE_CH_MARK = /^Ch\.\s*\d+$/;

  // Strip separators left over in the title part ("- Foo", ": Foo", "· Foo").
  function titleRest(rest) { return collapse(str(rest).replace(/^[\s:.\-·–—]+/, "")); }
  function chapterLabel(n, rest) { return rest ? "Ch. " + n + SEP + rest : "Ch. " + n; }

  function normalizeTitle(title, level) {
    var t = collapse(title);
    if (!t) return "";
    var lvl = level == null ? 1 : Number(level);
    var m, out = t;
    if ((m = RE_SECTION.exec(t))) {
      out = SECTION_SIGN + m[1] + " " + titleRest(m[2]);
    } else if ((m = RE_CHAPTER.exec(t))) {
      var n = /^\d+$/.test(m[1]) ? parseInt(m[1], 10) : romanToInt(m[1]);
      out = n > 0 ? chapterLabel(String(n), titleRest(m[2])) : t;
    } else if (lvl === 1 && (m = RE_ARABIC.exec(t))) {
      out = chapterLabel(String(parseInt(m[1], 10)), titleRest(m[2]));
    } else if (lvl === 1 && (m = RE_ROMAN_BARE.exec(t))) {
      var r = romanToInt(m[1]);
      out = r >= 1 && r <= MAX_BARE_ROMAN ? chapterLabel(String(r), titleRest(m[2])) : t;
    }
    return cutEnd(out, LABEL_MAX);
  }

  // ---------------------------------------------------------------- sectionsFromOutline
  function stableSortByPage(list) {
    return list
      .map(function (s, i) { return { s: s, i: i }; })
      .sort(function (a, b) { return (a.s.pageIndex - b.s.pageIndex) || (a.i - b.i); })
      .map(function (e) { return e.s; });
  }

  // outline: PDF.js getOutline() nodes {title, dest, url, items}; walked depth-first to level 2.
  // resolvePageIndex(dest) → Promise<number|null> (M.pdfview.resolvePageIndex). URL-only items are
  // skipped with their children; an item whose page does not resolve is skipped (its children are
  // still walked). Resolves to Section[] stably sorted by pageIndex. Never rejects.
  function sectionsFromOutline(outline, resolvePageIndex) {
    var flat = [];
    (function walk(nodes, level) {
      if (!Array.isArray(nodes) || level > 2) return;
      for (var i = 0; i < nodes.length; i++) {
        var node = nodes[i];
        if (!node || typeof node !== "object") continue;
        var hasDest = node.dest != null && node.dest !== "";
        var urlOnly = !hasDest && node.url != null && node.url !== "";
        if (urlOnly) continue;
        flat.push({ node: node, level: level, hasDest: hasDest });
        walk(node.items, level + 1);
      }
    })(outline, 1);

    var resolve = typeof resolvePageIndex === "function" ? resolvePageIndex : null;
    var lookups = flat.map(function (e) {
      if (!e.hasDest || !resolve) return Promise.resolve(null);
      var p;
      try { p = Promise.resolve(resolve(e.node.dest)); } catch (err) { return Promise.resolve(null); }
      return p.then(function (v) { return v; }, function () { return null; });
    });

    return Promise.all(lookups).then(function (pages) {
      var out = [];
      for (var i = 0; i < flat.length; i++) {
        var pageIndex = pages[i];
        if (!isIndex(pageIndex)) continue;
        var title = collapse(flat[i].node.title);
        if (!title) continue;
        out.push({
          title: title,
          label: normalizeTitle(title, flat[i].level),
          pageIndex: pageIndex,
          level: flat[i].level,
          source: "outline"
        });
      }
      return stableSortByPage(out);
    });
  }

  // ---------------------------------------------------------------- labelFor
  // Among candidates: the greatest pageIndex; on that page a manual mark wins, then the deeper
  // level, then the later entry (outline order).
  function pick(list) {
    var best = null;
    for (var i = 0; i < list.length; i++) {
      var x = list[i];
      if (!best) { best = x; continue; }
      if (x.pageIndex !== best.pageIndex) { if (x.pageIndex > best.pageIndex) best = x; continue; }
      if (x.manual !== best.manual) { if (x.manual) best = x; continue; }
      if (x.level !== best.level) { if (x.level > best.level) best = x; continue; }
      if (x.order > best.order) best = x;
    }
    return best;
  }

  // The deepest section with pageIndex <= page; a level-2 item is composed under its nearest
  // level-1 ancestor ("Ch. 1 · The Wave Function · §1.1 The Schrödinger Equation"); a manual mark
  // wins over outline items on its page. null when no section starts at or before the page.
  function labelFor(sections, pageIndex) {
    if (!Array.isArray(sections) || typeof pageIndex !== "number" || !isFinite(pageIndex)) return null;
    var list = [];
    for (var i = 0; i < sections.length; i++) {
      var s = sections[i];
      if (!s || typeof s !== "object") continue;
      var pi = s.pageIndex;
      if (typeof pi !== "number" || !isFinite(pi) || pi > pageIndex) continue;
      var level = typeof s.level === "number" && s.level >= 2 ? 2 : 1;
      var label = nonEmpty(s.label) ? collapse(s.label) : (nonEmpty(s.title) ? normalizeTitle(s.title, level) : "");
      if (!label) continue;
      list.push({ label: label, pageIndex: pi, level: level, manual: s.source === "manual", order: i });
    }
    if (!list.length) return null;
    var cur = pick(list);
    if (cur.level === 2) {
      var parents = [];
      for (var j = 0; j < list.length; j++) {
        if (list[j].level === 1 && list[j].pageIndex <= cur.pageIndex) parents.push(list[j]);
      }
      var anc = parents.length ? pick(parents) : null;
      return anc ? anc.label + SEP + cur.label : cur.label;
    }
    return cur.label;
  }

  function sectionLabelFor(collection, pageIndex) {
    var col = obj(collection);
    return labelFor(Array.isArray(col.sections) ? col.sections : [], pageIndex);
  }

  // ---------------------------------------------------------------- fit
  // When the line exceeds `max` characters drop the level-2 part first, then middle-ellipsise.
  // The level-2 part of a plain string is recognised by the house style the labels are built in:
  // a last segment starting with "§", or every segment after "docName · Ch. N · Title" /
  // "docName · <level-1 label>". A line with no level-2 part goes straight to the ellipsis.
  function fit(line, max) {
    var s = collapse(line);
    var limit = typeof max === "number" && isFinite(max) && max >= 1 ? Math.floor(max) : LINE_MAX;
    if (cpLen(s) <= limit) return s;
    var segs = s.split(SEP);
    if (segs.length >= 3) {
      var cutAt = -1;
      if (segs[segs.length - 1].charAt(0) === SECTION_SIGN) {
        cutAt = segs.length - 1;
      } else {
        var l1 = RE_CH_MARK.test(segs[1]) ? 2 : 1;
        if (segs.length > 1 + l1) cutAt = 1 + l1;
      }
      if (cutAt > 0) {
        var shorter = segs.slice(0, cutAt).join(SEP);
        if (cpLen(shorter) <= limit) return shorter;
        s = shorter;
      }
    }
    return middleEllipsis(s, limit);
  }

  // ---------------------------------------------------------------- line
  // books: "docName · sectionLabel", else "docName · p. <pageLabel>"; decks: "name · sectionLabel",
  // else "name". Reads the prompt's context snapshot; the live collection name wins over the
  // snapshot's docName. Always fitted to 64 characters.
  function line(collection, prompt) {
    var col = obj(collection), p = obj(prompt), ctx = obj(p.context), anchor = obj(p.anchor);
    var isDeck = col.kind === "deck";
    var name = nonEmpty(col.name) ? collapse(col.name) : (nonEmpty(ctx.docName) ? collapse(ctx.docName) : "");
    var pageIndex = isIndex(ctx.pageIndex) ? ctx.pageIndex : (isIndex(anchor.pageIndex) ? anchor.pageIndex : null);
    var section = nonEmpty(ctx.sectionLabel) ? collapse(ctx.sectionLabel) : null;
    if (section == null && !isDeck && pageIndex != null && Array.isArray(col.sections) && col.sections.length) {
      section = labelFor(col.sections, pageIndex);
    }
    if (section) return fit(join([name, section]));
    if (isDeck) return fit(name);
    var pageLabel = ctx.pageLabel != null && collapse(ctx.pageLabel) !== "" ? collapse(ctx.pageLabel)
      : (pageIndex != null ? String(pageIndex + 1) : "");
    return fit(pageLabel ? join([name, "p. " + pageLabel]) : name);
  }

  // ---------------------------------------------------------------- contextFor
  // The context snapshot of §14 for a prompt in `collection`. `pageLabel` is the PDF page label
  // when the caller has the document open; otherwise it comes from collection.pageLabels, from the
  // old snapshot (same page) or defaults to pageIndex + 1. Deck prompts keep the sectionLabel of a
  // deck snapshot (set by "# Section" in batch mode); a book snapshot's chapter label (one with a
  // pageIndex) is dropped, so "Move to deck" needs no extra bookkeeping.
  function contextFor(collection, prompt, pageLabel) {
    var col = obj(collection), p = obj(prompt), ctx = obj(p.context), anchor = obj(p.anchor);
    var docName = nonEmpty(col.name) ? collapse(col.name) : (nonEmpty(ctx.docName) ? collapse(ctx.docName) : "");
    if (col.kind === "deck") {
      var keep = ctx.pageIndex == null && nonEmpty(ctx.sectionLabel);
      return { docName: docName, sectionLabel: keep ? collapse(ctx.sectionLabel) : null, pageIndex: null, pageLabel: null };
    }
    var pageIndex = isIndex(anchor.pageIndex) ? anchor.pageIndex : (isIndex(ctx.pageIndex) ? ctx.pageIndex : null);
    var sectionLabel = pageIndex == null ? null : labelFor(Array.isArray(col.sections) ? col.sections : [], pageIndex);
    var label = null;
    if (pageLabel != null && collapse(pageLabel) !== "") {
      label = collapse(pageLabel);
    } else if (pageIndex != null) {
      var fromDoc = Array.isArray(col.pageLabels) ? col.pageLabels[pageIndex] : null;
      if (fromDoc != null && collapse(fromDoc) !== "") label = collapse(fromDoc);
      else if (ctx.pageIndex === pageIndex && ctx.pageLabel != null && collapse(ctx.pageLabel) !== "") label = collapse(ctx.pageLabel);
      else label = String(pageIndex + 1);
    }
    return { docName: docName, sectionLabel: sectionLabel, pageIndex: pageIndex, pageLabel: label };
  }

  var api = {
    normalizeTitle: normalizeTitle,
    sectionsFromOutline: sectionsFromOutline,
    labelFor: labelFor,
    line: line,
    fit: fit,
    sectionLabelFor: sectionLabelFor,
    contextFor: contextFor
  };
  M.context = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

/* SELF-CHECK (SPEC §17.2 M.context + task additions)
 *   normalizeTitle(title, level) → string
 *   sectionsFromOutline(outline, resolvePageIndex) → Promise<Section[]>
 *   labelFor(sections, pageIndex) → string|null
 *   line(collection, prompt) → string
 *   fit(line, max = 64) → string
 *   sectionLabelFor(collection, pageIndex) → string|null        (task addition)
 *   contextFor(collection, prompt, pageLabel) → {docName, sectionLabel, pageIndex, pageLabel}  (task addition)
 */
