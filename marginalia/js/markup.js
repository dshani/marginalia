/* js/markup.js — Marginalia markup (SPEC §16, §17): prompt text → HTML (KaTeX injected at call
 * time), plain text, Anki HTML and Markdown. Pure: tokens come from M.prompts.tokenize via dep(),
 * `katex` is read from the global object when render() runs (missing → <code class="tex">).
 * Cloze deletions: with a mask (review, the editor preview of card 0) deletion k is a blank or a
 * <mark class="cloze-reveal">; without one, the reading surfaces (modes card, list, preview) show every
 * deletion as <mark class="cloze-mark"> without its braces, while mode review keeps the braces as typed
 * (opts.cloze: true|false overrides that default). plain() and the exports always keep the braces.
 * Cues (FEATURES P1.1): `{hidden::cue}` is scanned as M.prompts.parse scans it. A hidden blank and a
 * .cloze-mark are followed by a space and <span class="cloze-cue">(cue)</span>; a revealed deletion and
 * the other deletions under a mask show the hidden part alone. `\::` is shown as `::` wherever `\{` is
 * shown as `{`. toObsidian drops the cue ({x::cue} → ==x==); plain(), toAnki and toMarkdown keep the
 * text as typed. */
(function (root) {
  "use strict";
  var M = root.Marginalia = root.Marginalia || {};
  function dep(name) { return M[name] || (typeof require === "function" ? require("./" + name + ".js") : undefined); }

  var IMAGE_RE = /^!\[[^\]\n]*\]\(att:([A-Za-z0-9_\-]+)\)$/;
  var TAGS_LINE_RE = /^#[\w-]{2,}(?:[ \t]+#[\w-]{2,})*[ \t]*$/;
  var KATEX_OPTS_DISPLAY = { displayMode: true, throwOnError: false, output: "html", strict: "ignore" };
  var KATEX_OPTS_INLINE = { displayMode: false, throwOnError: false, output: "html", strict: "ignore" };

  function str(v) { return v == null ? "" : String(v); }
  function escapeHtml(s) {
    return str(s).replace(/[&<>"']/g, function (c) {
      return c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === "\"" ? "&quot;" : "&#39;";
    });
  }
  function unescapeEntities(s) {
    return str(s).replace(/&(quot|#34|#x22|#39|#x27|apos|lt|gt|amp);/gi, function (m, e) {
      e = e.toLowerCase();
      if (e === "quot" || e === "#34" || e === "#x22") return "\"";
      if (e === "#39" || e === "#x27" || e === "apos") return "'";
      if (e === "lt") return "<";
      if (e === "gt") return ">";
      return "&";
    });
  }
  function normalizeNewlines(s) { return str(s).replace(/\r\n?/g, "\n"); }

  // A final line consisting only of #tokens is the tags line (shown as chips, not as text).
  function stripTagsLine(text) {
    var at = text.lastIndexOf("\n");
    var lastLine = at < 0 ? text : text.slice(at + 1);
    if (!TAGS_LINE_RE.test(lastLine)) return text;
    return at < 0 ? "" : text.slice(0, at);
  }

  // id → url resolver from a function, Map or plain object.
  function resolver(x) {
    if (!x) return function () { return null; };
    if (typeof x === "function") return function (id) { var u = x(id); return u == null || u === "" ? null : String(u); };
    if (typeof x.get === "function") return function (id) { var u = x.get(id); return u == null || u === "" ? null : String(u); };
    if (typeof x === "object") {
      return function (id) {
        var u = Object.prototype.hasOwnProperty.call(x, id) ? x[id] : null;
        return u == null || u === "" ? null : String(u);
      };
    }
    return function () { return null; };
  }

  // ------------------------------------------------------------------ tokens → parts
  // part = {type: "text"|"math"|"image", start, end, raw, src?, display?, open?, close?, id?}
  // Positions are offsets into `text`; gaps between tokens become text parts, so any tokenizer that
  // reports start/end is accepted whether its math `value` is the inner source or the delimited run.

  function mathPart(raw, token) {
    var src = null, display = false, open = "", close = "";
    if (raw.length >= 4 && raw.slice(0, 2) === "$$" && raw.slice(-2) === "$$") { src = raw.slice(2, -2); display = true; open = "$$"; close = "$$"; }
    else if (raw.length >= 4 && raw.slice(0, 2) === "\\[" && raw.slice(-2) === "\\]") { src = raw.slice(2, -2); display = true; open = "\\["; close = "\\]"; }
    else if (raw.length >= 4 && raw.slice(0, 2) === "\\(" && raw.slice(-2) === "\\)") { src = raw.slice(2, -2); display = false; open = "\\("; close = "\\)"; }
    else if (raw.length >= 2 && raw.charAt(0) === "$" && raw.slice(-1) === "$") { src = raw.slice(1, -1); display = false; open = "$"; close = "$"; }
    if (src === null) {
      src = token && token.value != null ? String(token.value) : raw;
      display = !!(token && token.display);
      open = display ? "$$" : "$"; close = open;
    }
    return { type: "math", src: src, display: display, open: open, close: close };
  }

  function partsOf(text) {
    var P = dep("prompts");
    if (!P || typeof P.tokenize !== "function") {
      var err = new Error("M.prompts.tokenize is not available");
      err.code = "no_prompts";
      throw err;
    }
    var tokens = P.tokenize(text) || [], list = [], pos = 0, i, t;
    for (i = 0; i < tokens.length; i++) {
      t = tokens[i];
      if (!t) continue;
      var start = typeof t.start === "number" ? t.start : pos;
      var end = typeof t.end === "number" ? t.end : null;
      if (end === null) {
        var guess = t.type === "math" ? ((t.display ? "$$" : "$") + str(t.value) + (t.display ? "$$" : "$")) : str(t.value);
        end = start + guess.length;
      }
      start = Math.max(pos, Math.min(start, text.length));
      end = Math.max(start, Math.min(end, text.length));
      if (start > pos) list.push({ type: "text", start: pos, end: start, raw: text.slice(pos, start) });
      if (end > start) {
        var raw = text.slice(start, end), part;
        if (t.type === "math") { part = mathPart(raw, t); }
        else if (t.type === "image") {
          var m = IMAGE_RE.exec(raw);
          part = { type: "image", id: t.id != null ? String(t.id) : (m ? m[1] : null) };
        } else part = { type: "text" };
        part.start = start; part.end = end; part.raw = raw;
        list.push(part);
      }
      pos = end;
    }
    if (pos < text.length) list.push({ type: "text", start: pos, end: text.length, raw: text.slice(pos) });
    return list;
  }

  // The cue separator of M.prompts ("::" when the tokenizer in use names none).
  function cueSep() {
    var P = dep("prompts");
    return P && typeof P.CUE_SEP === "string" && P.CUE_SEP ? P.CUE_SEP : "::";
  }
  // true when text[i] is preceded by an odd number of backslashes
  function escapedAt(text, i) {
    var n = 0;
    for (var j = i - 1; j >= 0 && text.charAt(j) === "\\"; j--) n++;
    return n % 2 === 1;
  }
  function isSpace(ch) { return /\s/.test(ch); }

  // Cloze deletions over text parts only: `\{` `\}` are literal, nested braces → outer span wins,
  // a `{` opened in text and closed after a math/image part swallows it (R4).
  // Cue (FEATURES P1.1 a), the rule of M.prompts.parse: the last unescaped separator at the top level of a
  // deletion (in a text part, depth 1) splits it; `\::` is a literal `::`; a blank hidden part or cue → no cue.
  // A deletion is {start, end, text} and, with a cue, {…, text: the hidden part as typed, cue: trimmed,
  // sep: the separator's offset, hiddenEnd: where the hidden part ends once the blanks before the separator
  // are dropped, cueStart, cueEnd: the trimmed cue's span}.
  function scanDeletions(parts, text) {
    var dels = [], depth = 0, open = -1, sep = -1, SEP = cueSep(), L = SEP.length;
    for (var p = 0; p < parts.length; p++) {
      var part = parts[p];
      if (part.type !== "text") continue;
      for (var i = part.start; i < part.end; i++) {
        var c = text.charAt(i);
        if (c === "\\" && (text.charAt(i + 1) === "{" || text.charAt(i + 1) === "}")) { i++; continue; }
        if (c === "{") { if (depth === 0) { open = i; sep = -1; } depth++; }
        else if (c === "}" && depth > 0) {
          depth--;
          if (depth === 0) {
            var inner = text.slice(open + 1, i);
            if (inner.trim()) dels.push(deletion(text, open, i + 1, sep, L)); // empty braces are not a card (as M.prompts.parse)
            open = -1;
          }
        }
        else if (depth === 1 && i + L <= part.end && text.startsWith(SEP, i)) {
          if (escapedAt(text, i)) i += L - 1;                       // `\::` is a literal `::`
          else sep = i;                                             // the last one wins
        }
      }
    }
    return dels;
  }
  function deletion(text, open, end, sep, L) {
    var d = { start: open, end: end, text: text.slice(open + 1, end - 1) };
    if (sep < 0) return d;
    var hidden = text.slice(open + 1, sep), a = sep + L, b = end - 1;
    while (a < b && isSpace(text.charAt(a))) a++;
    while (b > a && isSpace(text.charAt(b - 1))) b--;
    if (!hidden.trim() || a >= b) return d;
    var h = sep;
    while (h > open + 1 && isSpace(text.charAt(h - 1))) h--;
    d.text = hidden; d.cue = text.slice(a, b); d.sep = sep; d.hiddenEnd = h; d.cueStart = a; d.cueEnd = b;
    return d;
  }

  // ------------------------------------------------------------------ renderers

  function katexHtml(src, display) {
    var katex = root.katex;
    var code = "<code class=\"tex\">" + escapeHtml(src) + "</code>";
    if (!katex || typeof katex.renderToString !== "function") return code;
    var html = null, message = null;
    try {
      html = katex.renderToString(src, display ? KATEX_OPTS_DISPLAY : KATEX_OPTS_INLINE);
      if (typeof html !== "string") { html = null; message = "KaTeX returned no HTML"; }
      else if (html.indexOf("katex-error") >= 0) {
        var m = /<[^>]*class="[^"]*katex-error[^"]*"[^>]*>/.exec(html), t = m && /title="([^"]*)"/.exec(m[0]);
        message = t ? unescapeEntities(t[1]) : "Could not render this formula";
        html = null;
      }
    } catch (e) {
      html = null; message = e && e.message ? String(e.message) : String(e);
    }
    if (html !== null) return html;
    return "<code class=\"tex tex--error\" title=\"" + escapeHtml(message) + "\">" + escapeHtml(src) + "</code>";
  }

  function mathHtml(part) {
    var inner = katexHtml(part.src, part.display);
    return part.display ? "<div class=\"math-display\">" + inner + "</div>" : inner;
  }

  function imageHtml(part, imageUrl) {
    var url = part.id ? imageUrl(part.id) : null;
    if (url) return "<img class=\"att\" src=\"" + escapeHtml(url) + "\" alt=\"snip\">";
    return "<span class=\"att att--missing\" data-id=\"" + escapeHtml(part.id || "") + "\">Image missing</span>";
  }

  // `\::` → `::` where the backslash is not itself escaped (an odd run of backslashes before the separator).
  function unescapeSep(s) {
    var SEP = cueSep();
    if (s.indexOf("\\" + SEP) < 0) return s;
    var out = "", pos = 0, at;
    while ((at = s.indexOf("\\" + SEP, pos)) >= 0) {
      if (escapedAt(s, at)) { out += s.slice(pos, at + 1); pos = at + 1; }       // `\\::`: that backslash is a literal one
      else { out += s.slice(pos, at) + SEP; pos = at + 1 + SEP.length; }
    }
    return out + s.slice(pos);
  }

  function textHtml(raw, cloze, mode) {
    var s = raw.replace(/\\\$/g, "$");
    if (cloze) s = unescapeSep(s.replace(/\\([{}])/g, "$1"));
    s = escapeHtml(s);
    return mode === "list" ? s.replace(/\n/g, " ") : s.replace(/\n/g, "<br>");
  }

  function blankHtml(hidden) {
    var len = hidden.replace(/\s+/g, " ").trim().length;
    var w = Math.max(4, Math.round(len * 0.55 * 10) / 10);
    return "<span class=\"cloze-blank\" style=\"display:inline-block;width:" + w + "em\" data-len=\"" + len + "\"></span>";
  }

  // HTML for the slice [a, b) of the part list (boundaries only ever fall inside text parts).
  function renderRange(parts, text, a, b, ctx) {
    var out = "";
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (p.end <= a || p.start >= b) continue;
      if (p.type === "text") out += textHtml(text.slice(Math.max(a, p.start), Math.min(b, p.end)), ctx.cloze, ctx.mode);
      else if (p.start < a) continue;
      else if (p.type === "math") out += mathHtml(p);
      else out += imageHtml(p, ctx.imageUrl);
    }
    return out;
  }

  function isMasked(mask, k, count) {
    if (!mask) return false;
    var idx = mask.index;
    if (idx == null || idx === "all" || idx === -1) return true;
    idx = Number(idx);
    return isFinite(idx) && idx === k && k < count;
  }

  // Without a mask, the reading surfaces drop the braces and mark each deletion; review keeps them
  // as typed. opts.cloze (true|false) overrides the mode's default either way.
  var MARK_MODES = { card: true, list: true, preview: true };
  function wantsMarks(opts, mode) {
    if (opts.cloze === true) return true;
    if (opts.cloze === false) return false;
    return MARK_MODES[mode] === true;
  }

  // render(text, {mask: {index, reveal}|null, mode, imageUrl: id → url|null, cloze?: boolean}) → html
  function render(text, opts) {
    opts = opts || {};
    var src = stripTagsLine(normalizeNewlines(text));
    var parts = partsOf(src);
    var mask = opts.mask || null, mode = opts.mode || "card";
    var marks = !mask && wantsMarks(opts, mode);
    var ctx = { cloze: !!mask || marks, mode: mode, imageUrl: resolver(opts.imageUrl) };
    var dels = ctx.cloze ? scanDeletions(parts, src) : [];
    var out = "", pos = 0;
    for (var k = 0; k < dels.length; k++) {
      var d = dels[k], inner, hasCue = typeof d.cue === "string";
      var hiddenEnd = hasCue ? d.hiddenEnd : d.end - 1;            // with a cue: the hidden part only
      out += renderRange(parts, src, pos, d.start, ctx);
      if (mask && isMasked(mask, k, dels.length)) {
        out += mask.reveal
          ? "<mark class=\"cloze-reveal\">" + renderRange(parts, src, d.start + 1, hiddenEnd, ctx) + "</mark>"
          : blankHtml(d.text) + (hasCue ? cueHtml(parts, src, d, ctx) : "");
      } else {
        inner = renderRange(parts, src, d.start + 1, hiddenEnd, ctx);
        out += marks ? "<mark class=\"cloze-mark\">" + inner + "</mark>" + (hasCue ? cueHtml(parts, src, d, ctx) : "") : inner;
      }
      pos = d.end;
    }
    out += renderRange(parts, src, pos, src.length, ctx);
    return out;
  }
  // A blank's cue: a space, then the cue in brackets, rendered like any prompt text (math, images, escaping).
  function cueHtml(parts, src, d, ctx) {
    return " <span class=\"cloze-cue\">(" + renderRange(parts, src, d.cueStart, d.cueEnd, ctx) + ")</span>";
  }

  // plain(text) → text with math source kept and image tokens as "[image]"
  function plain(text) {
    var src = normalizeNewlines(text), parts = partsOf(src), out = "";
    for (var i = 0; i < parts.length; i++) out += parts[i].type === "image" ? "[image]" : parts[i].raw;
    return out;
  }

  // toAnki(text, images: id → dataUrl) → html: $$…$$ → \[…\], $…$ → \(…\) on math tokens only
  // (\(…\) and \[…\] stay), newlines → <br>, tabs removed, HTML-escaped, images → <img src="data:…">.
  function toAnki(text, images) {
    var src = stripTagsLine(normalizeNewlines(text)).replace(/\t/g, "");
    var parts = partsOf(src), get = resolver(images), out = "";
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (p.type === "text") out += escapeHtml(p.raw).replace(/\n/g, "<br>");
      else if (p.type === "math") {
        var body = escapeHtml(p.src.replace(/\n/g, " "));
        out += p.display ? "\\[" + body + "\\]" : "\\(" + body + "\\)";
      } else {
        var url = p.id ? get(p.id) : null;
        out += url ? "<img src=\"" + escapeHtml(url) + "\">" : "[image]";
      }
    }
    return out;
  }

  // toMarkdown(text, images) → text as typed ($ kept, tags line kept), images → ![snip](data:…)
  function toMarkdown(text, images) {
    var src = normalizeNewlines(text), parts = partsOf(src), get = resolver(images), out = "";
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (p.type !== "image") { out += p.raw; continue; }
      var url = p.id ? get(p.id) : null;
      out += url ? "![snip](" + url + ")" : p.raw;
    }
    return out;
  }

  // toObsidian(text, {images}) → Obsidian Markdown (BUILD-NOTES "Obsidian"). The text stays as typed (Q./A. lines,
  // the #tags line, `\$`, `\{`), except: a cloze prompt's deletions {x} → ==x== (scanned like render() does, so math
  // inside a deletion stays math and `\{` stays literal; whitespace just inside the braces moves outside the ==);
  // \(…\) → $…$ and \[…\] → $$…$$ on math tokens only ($ and $$ unchanged); image tokens → ![[marginalia-<id>.png]]
  // when opts.images is true, ![[<name>]] when it is a function id → file name (null: "[image]"), else "[image]".
  // A deletion with a cue, {x::cue} → ==x==: the separator, the cue and the blanks around the separator are
  // dropped (FEATURES P1.1 d). A text without a cue gives the same bytes as before cues existed: a cue is dropped
  // only where M.prompts.parse reports one for the very same braces, so a text in which parse finds no cue is never
  // touched (the two scans differ on a brace after an even number of backslashes, as they did before cues).
  function toObsidian(text, opts) {
    opts = opts || {};
    var src = normalizeNewlines(text), parts = partsOf(src), P = dep("prompts");
    var parsed = null;
    try { parsed = P && typeof P.parse === "function" ? P.parse(src) : null; } catch (e) { parsed = null; }
    var dels = parsed && parsed.kind === "cloze" ? scanDeletions(parts, src) : [];
    var cued = {};
    if (dels.length && Array.isArray(parsed.deletions)) {
      parsed.deletions.forEach(function (pd) { if (pd && typeof pd.cue === "string") cued[pd.start + ":" + pd.end] = true; });
    }
    function imageName(id) {
      if (!id) return null;
      if (typeof opts.images === "function") { var n = opts.images(id); return n ? String(n) : null; }
      return opts.images === true ? "marginalia-" + id + ".png" : null;
    }
    function range(a, b) {
      var out = "";
      for (var i = 0; i < parts.length; i++) {
        var p = parts[i];
        if (p.end <= a || p.start >= b) continue;
        if (p.type === "text") { out += src.slice(Math.max(a, p.start), Math.min(b, p.end)); continue; }
        if (p.start < a) continue;
        if (p.type === "math") {
          if (!p.src.trim()) out += p.raw;                               // an empty \(\) / \[\] stays as typed
          else if (p.open === "\\(") out += "$" + p.src.trim() + "$";
          else if (p.open === "\\[") out += "$$" + p.src + "$$";
          else out += p.raw;
        } else {
          var name = imageName(p.id);
          out += name ? "![[" + name + "]]" : "[image]";
        }
      }
      return out;
    }
    var out = "", pos = 0;
    for (var k = 0; k < dels.length; k++) {
      var d = dels[k], hasCue = typeof d.cue === "string" && cued[d.start + ":" + d.end] === true;
      var inner = range(d.start + 1, hasCue ? d.hiddenEnd : d.end - 1);
      var lead = /^\s*/.exec(inner)[0], core = inner.slice(lead.length), trail = /\s*$/.exec(core)[0];
      core = core.slice(0, core.length - trail.length);
      out += range(pos, d.start) + lead + (core ? "==" + core + "==" : "") + trail;
      pos = d.end;
    }
    return out + range(pos, src.length);
  }

  var api = {
    render: render,
    plain: plain,
    toAnki: toAnki,
    toMarkdown: toMarkdown,
    toObsidian: toObsidian,
    escapeHtml: escapeHtml
  };
  M.markup = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

/* SELF-CHECK (SPEC §17.2 M.markup): render(text, {mask: {index, reveal}|null, mode, imageUrl}) → html;
 * plain(text) → string; toAnki(text, images) → html; toMarkdown(text, images) → string.
 * Extension (BUILD-NOTES "Obsidian"): toObsidian(text, {images: true|false|id → name}) → Obsidian Markdown (cloze {x} →
 * ==x==, \(…\) → $…$, \[…\] → $$…$$, images → ![[marginalia-<id>.png]] or "[image]").
 * Extra: escapeHtml(s) (local helper, also exported); render() also accepts cloze: true|false
 * (deletions as <mark class="cloze-mark"> without braces — the default in modes card, list, preview;
 * braces kept as typed — the default in mode review).
 * FEATURES P1.1 (cues, {hidden::cue}; the scan agrees with M.prompts.parse): a hidden blank is
 * <span class="cloze-blank"> (width from the hidden part) + " " + <span class="cloze-cue">(cue)</span>; a revealed
 * deletion is <mark class="cloze-reveal">hidden</mark> without the cue; the other deletions under a mask show the
 * hidden part alone; without a mask, modes card / list / preview (or cloze: true) give
 * <mark class="cloze-mark">hidden</mark> + " " + <span class="cloze-cue">(cue)</span>; mode review without a mask
 * keeps the text as typed. `\::` is shown as `::` wherever `\{` is shown as `{`. toObsidian: {x::cue} → ==x==;
 * plain(), toAnki() and toMarkdown() keep the text as typed. */
