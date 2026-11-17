"use strict";
// SPEC §12 markup.test.js: katex stubbed on globalThis; four delimiter pairs, \$, no newline
// inside $…$, image tokens, masking before rendering, thrown-error fallback, toAnki / toMarkdown.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const JS = path.join(__dirname, "..", "js");

// Tokenizer: the real M.prompts.tokenize when js/prompts.js loads, else a reference
// implementation of SPEC §16 step 1 so this file stays runnable on its own.
function referenceTokenize(text) {
  const out = [];
  let i = 0, textStart = 0;
  const n = text.length;
  const flush = (end) => { if (end > textStart) out.push({ type: "text", value: text.slice(textStart, end), start: textStart, end }); };
  while (i < n) {
    const c = text[i], two = text.substr(i, 2);
    let m = null;
    if (two === "\\$") { i += 2; continue; }
    if (two === "$$") {
      const j = text.indexOf("$$", i + 2);
      if (j >= 0) m = { end: j + 2, src: text.slice(i + 2, j), display: true };
    } else if (two === "\\[") {
      const j = text.indexOf("\\]", i + 2);
      if (j >= 0) m = { end: j + 2, src: text.slice(i + 2, j), display: true };
    } else if (two === "\\(") {
      const j = text.indexOf("\\)", i + 2), nl = text.indexOf("\n", i + 2);
      if (j >= 0 && (nl < 0 || nl > j)) m = { end: j + 2, src: text.slice(i + 2, j), display: false };
    } else if (c === "$") {
      if (i + 1 < n && !/\s/.test(text[i + 1])) {
        let k = i + 1;
        while (k < n && text[k] !== "\n") {
          if (text[k] === "\\") { k += 2; continue; }
          if (text[k] === "$" && !/\s/.test(text[k - 1])) break;
          k++;
        }
        if (k < n && text[k] === "$") m = { end: k + 1, src: text.slice(i + 1, k), display: false };
      }
    } else if (two === "![") {
      const im = /^!\[[^\]\n]*\]\(att:([\w-]+)\)/.exec(text.slice(i));
      if (im) {
        flush(i);
        out.push({ type: "image", value: im[0], id: im[1], start: i, end: i + im[0].length });
        i += im[0].length; textStart = i;
        continue;
      }
    }
    if (m) {
      flush(i);
      out.push({ type: "math", value: m.src, display: m.display, start: i, end: m.end });
      i = m.end; textStart = i;
      continue;
    }
    i++;
  }
  flush(n);
  return out;
}

let prompts = null;
try { prompts = require(path.join(JS, "prompts.js")); } catch (e) { prompts = null; }
const usingRealTokenizer = !!(prompts && typeof prompts.tokenize === "function");
if (!usingRealTokenizer) prompts = { tokenize: referenceTokenize };
globalThis.Marginalia = globalThis.Marginalia || {};
globalThis.Marginalia.prompts = prompts;

const markup = require(path.join(JS, "markup.js"));

// ---------------------------------------------------------------- katex stub
let calls = [];
function stubKatex(impl) {
  globalThis.katex = {
    renderToString(src, opts) {
      calls.push({ src, opts });
      if (impl) return impl(src, opts);
      return `<span class="katex" data-display="${!!(opts && opts.displayMode)}">${src}</span>`;
    }
  };
}
const inline = (src) => `<span class="katex" data-display="false">${src}</span>`;
const display = (src) => `<div class="math-display"><span class="katex" data-display="true">${src}</span></div>`;
const BLANK_RE = /<span class="cloze-blank" style="display:inline-block;width:[0-9.]+em" data-len="\d+"><\/span>/;

test.beforeEach(() => { calls = []; stubKatex(); });

test("tokenizer in use", () => {
  assert.ok(typeof prompts.tokenize === "function");
  // The reference tokenizer must agree with the spec on the basics even when the real one is used.
  const t = referenceTokenize("a $x$ b");
  assert.deepEqual(t.map((r) => r.type), ["text", "math", "text"]);
});

// ---------------------------------------------------------------- delimiters
test("four delimiter pairs render through katex with the §16 options", () => {
  assert.equal(markup.render("a $x$ b"), "a " + inline("x") + " b");
  assert.equal(markup.render("$$E=mc^2$$"), display("E=mc^2"));
  assert.equal(markup.render("p \\(y\\) q"), "p " + inline("y") + " q");
  assert.equal(markup.render("\\[z\\]"), display("z"));
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.map((c) => c.src), ["x", "E=mc^2", "y", "z"]);
  assert.deepEqual(calls.map((c) => !!c.opts.displayMode), [false, true, false, true]);
  for (const c of calls) {
    assert.equal(c.opts.throwOnError, false);
    assert.equal(c.opts.output, "html");
    assert.equal(c.opts.strict, "ignore");
  }
});

test("display math may span lines; it is wrapped in .math-display", () => {
  const html = markup.render("before\n$$\na = b\n$$\nafter");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].src, "\na = b\n");
  assert.equal(calls[0].opts.displayMode, true);
  assert.ok(html.startsWith("before<br>"));
  assert.ok(html.includes('<div class="math-display">'));
  assert.ok(html.endsWith("<br>after"));
});

test("\\$ is a literal dollar and prose dollars are never delimiters", () => {
  assert.equal(markup.render("costs \\$5 and \\$6"), "costs $5 and $6");
  assert.equal(calls.length, 0);
  assert.equal(markup.render("costs $5 and $6"), "costs $5 and $6");
  assert.equal(markup.render("\\$x\\$"), "$x$");
  assert.equal(calls.length, 0);
});

test("no newline inside $…$ (inline math stays on one line)", () => {
  assert.equal(markup.render("$a\nb$"), "$a<br>b$");
  assert.equal(calls.length, 0);
  assert.equal(markup.render("$a$\n$b$"), inline("a") + "<br>" + inline("b"));
  assert.equal(calls.length, 2);
});

test("inline $ needs no whitespace after the opener and none before the closer", () => {
  assert.equal(markup.render("$ x$"), "$ x$");
  assert.equal(markup.render("$x $"), "$x $");
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------- text
test("text is HTML-escaped and newlines become <br>", () => {
  assert.equal(markup.render("<b>&\"'\nx"), "&lt;b&gt;&amp;&quot;&#39;<br>x");
});

test("list mode keeps the row on one line", () => {
  assert.equal(markup.render("a\nb", { mode: "list" }), "a b");
  assert.equal(markup.render("a\nb", { mode: "card" }), "a<br>b");
});

test("a trailing #tags line is stripped from the rendered body, '# Section' is not", () => {
  assert.equal(markup.render("The wave.\n#qm #cs-2"), "The wave.");
  assert.equal(markup.render("# Section\nbody"), "# Section<br>body");
  assert.equal(markup.render("#qm"), "");
  assert.equal(markup.render("see #qm here"), "see #qm here");
});

// ---------------------------------------------------------------- images
test("image tokens become <img class=\"att\"> or the missing chip", () => {
  const urls = (id) => (id === "a_1" ? "blob:abc" : null);
  assert.equal(markup.render("see ![snip](att:a_1) here", { imageUrl: urls }),
    'see <img class="att" src="blob:abc" alt="snip"> here');
  assert.equal(markup.render("![snip](att:a_2)", { imageUrl: urls }),
    '<span class="att att--missing" data-id="a_2">Image missing</span>');
  assert.equal(markup.render("![snip](att:a_1)"), '<span class="att att--missing" data-id="a_1">Image missing</span>');
  assert.equal(markup.render("![snip](att:a_1)", { imageUrl: new Map([["a_1", "blob:m"]]) }), '<img class="att" src="blob:m" alt="snip">');
  assert.equal(markup.render("![snip](att:a_1)", { imageUrl: { a_1: "blob:o" } }), '<img class="att" src="blob:o" alt="snip">');
  assert.equal(markup.render("![snip](att:a_1)", { imageUrl: () => '"><script>' }), '<img class="att" src="&quot;&gt;&lt;script&gt;" alt="snip">');
});

// ---------------------------------------------------------------- cloze masking
const CLOZE = "The {wave function} $\\Psi$ solves {the $E$ equation}.";

test("mask null in review mode (or with cloze: false) leaves braces as typed", () => {
  assert.equal(markup.render(CLOZE, { mask: null, mode: "review" }), "The {wave function} " + inline("\\Psi") + " solves {the " + inline("E") + " equation}.");
  assert.equal(markup.render(CLOZE, { mask: null, cloze: false }), "The {wave function} " + inline("\\Psi") + " solves {the " + inline("E") + " equation}.");
  assert.equal(markup.render("a \\{b\\} {c}", { mode: "review" }), "a \\{b\\} {c}");
});

// ---------------------------------------------------------------- cloze marks (no mask, reading surfaces)
test("without a mask, card / list / preview render each deletion as <mark class=\"cloze-mark\"> without braces", () => {
  const want = 'Der Hund <mark class="cloze-mark">bellt</mark> laut.';
  assert.equal(markup.render("Der Hund {bellt} laut."), want);                                   // card is the default mode
  assert.equal(markup.render("Der Hund {bellt} laut.", { mode: "card", mask: null }), want);
  assert.equal(markup.render("Der Hund {bellt} laut.", { mode: "list" }), want);
  assert.equal(markup.render("Der Hund {bellt} laut.", { mode: "preview" }), want);
  assert.equal(markup.render("Der Hund {bellt} laut.", { mode: "review" }), "Der Hund {bellt} laut.");
  assert.equal(markup.render("{a} und {b}", { mode: "list" }), '<mark class="cloze-mark">a</mark> und <mark class="cloze-mark">b</mark>');
});

test("cloze marks: math and images inside a deletion still render, \\{ is literal, nested → outer span, {} is no card", () => {
  assert.equal(markup.render(CLOZE), 'The <mark class="cloze-mark">wave function</mark> ' + inline("\\Psi") +
    ' solves <mark class="cloze-mark">the ' + inline("E") + " equation</mark>.");
  assert.deepEqual(calls.map((c) => c.src), ["\\Psi", "E"]);
  assert.equal(markup.render("a \\{b\\} {c}"), 'a {b} <mark class="cloze-mark">c</mark>');
  assert.equal(markup.render("{a {b} c} d"), '<mark class="cloze-mark">a {b} c</mark> d');
  assert.equal(markup.render("{} {x}"), '{} <mark class="cloze-mark">x</mark>');
  assert.equal(markup.render("$\\frac{a}{b}$ is {x}"), inline("\\frac{a}{b}") + ' is <mark class="cloze-mark">x</mark>');
  assert.equal(markup.render("see ![snip](att:a_1) {here}", { imageUrl: { a_1: "blob:o" } }),
    'see <img class="att" src="blob:o" alt="snip"> <mark class="cloze-mark">here</mark>');
  assert.equal(markup.render("no braces at all"), "no braces at all");
  assert.equal(markup.render("<b>{x}</b>"), '&lt;b&gt;<mark class="cloze-mark">x</mark>&lt;/b&gt;');
});

test("list-mode marks stay on one line; the cloze option overrides the mode default", () => {
  assert.equal(markup.render("a\n{b}", { mode: "list" }), 'a <mark class="cloze-mark">b</mark>');
  assert.equal(markup.render("x {y}", { mode: "card", cloze: false }), "x {y}");
  assert.equal(markup.render("x {y}", { mode: "list", cloze: false }), "x {y}");
  assert.equal(markup.render("x {y}", { mode: "review", cloze: true }), 'x <mark class="cloze-mark">y</mark>');
});

test("a mask wins over the marks: the masked deletion is a blank / reveal, the others plain", () => {
  const html = markup.render("{x} and {y}", { mode: "card", mask: { index: 0, reveal: false } });
  assert.ok(BLANK_RE.test(html), html);
  assert.ok(!/cloze-mark/.test(html), html);
  assert.ok(/ and y$/.test(html), html);
  assert.equal(markup.render("{x} and {y}", { mode: "preview", mask: { index: 1, reveal: true } }), 'x and <mark class="cloze-reveal">y</mark>');
  assert.equal(markup.render("{x} and {y}", { mode: "review", mask: { index: 1, reveal: true } }), 'x and <mark class="cloze-reveal">y</mark>');
});

test("plain() and the exports keep the braces", () => {
  assert.equal(markup.plain("Der Hund {bellt} laut."), "Der Hund {bellt} laut.");
  assert.equal(markup.toAnki("Der Hund {bellt} laut.", null), "Der Hund {bellt} laut.");
  assert.equal(markup.toMarkdown("Der Hund {bellt} laut.", null), "Der Hund {bellt} laut.");
});

test("deletion 0 masked: blank with approximate width, other deletions plain without braces", () => {
  const html = markup.render(CLOZE, { mask: { index: 0, reveal: false } });
  const m = BLANK_RE.exec(html);
  assert.ok(m, html);
  assert.equal(html, "The " + m[0] + " " + inline("\\Psi") + " solves the " + inline("E") + " equation.");
  assert.ok(/data-len="13"/.test(m[0]));
  assert.ok(/width:7\.2em/.test(m[0]));
});

test("masking happens before rendering: math inside the masked deletion is never rendered (R4)", () => {
  const html = markup.render(CLOZE, { mask: { index: 1, reveal: false } });
  assert.equal(calls.map((c) => c.src).join(","), "\\Psi");
  const m = BLANK_RE.exec(html);
  assert.ok(m, html);
  assert.equal(html, "The wave function " + inline("\\Psi") + " solves " + m[0] + ".");
});

test("reveal wraps the rendered deletion in <mark class=\"cloze-reveal\">", () => {
  const html = markup.render(CLOZE, { mask: { index: 1, reveal: true } });
  assert.equal(html, "The wave function " + inline("\\Psi") + " solves " +
    '<mark class="cloze-reveal">the ' + inline("E") + " equation</mark>.");
});

test("blank has a minimum width of 4em", () => {
  const html = markup.render("x {ab} y", { mask: { index: 0, reveal: false } });
  assert.ok(/width:4em/.test(html), html);
  assert.ok(/data-len="2"/.test(html));
});

test("braces inside math never cloze and \\{ is a literal brace", () => {
  const html = markup.render("$\\frac{a}{b}$ is {x}", { mask: { index: 0, reveal: false } });
  assert.deepEqual(calls.map((c) => c.src), ["\\frac{a}{b}"]);
  assert.ok(html.startsWith(inline("\\frac{a}{b}") + " is "), html);
  assert.ok(BLANK_RE.test(html));
  assert.equal(markup.render("a \\{b\\} {c}", { mask: { index: 0, reveal: true } }), 'a {b} <mark class="cloze-reveal">c</mark>');
});

test("nested braces: the outer span is the deletion", () => {
  assert.equal(markup.render("{a {b} c} d", { mask: { index: 0, reveal: true } }), '<mark class="cloze-reveal">a {b} c</mark> d');
  const html = markup.render("{a {b} c} {d}", { mask: { index: 1, reveal: false } });
  assert.ok(html.startsWith("a {b} c "), html);
  assert.ok(BLANK_RE.test(html));
});

test("empty braces are not a card, an index beyond the deletions masks nothing, 'all' masks every deletion", () => {
  assert.equal(markup.render("{} {x}", { mask: { index: 0, reveal: true } }), '{} <mark class="cloze-reveal">x</mark>');
  assert.equal(markup.render("{x} {y}", { mask: { index: 5, reveal: false } }), "x y");
  const html = markup.render("{x} {y}", { mask: { index: "all", reveal: false } });
  assert.equal((html.match(/cloze-blank/g) || []).length, 2);
});

// ---------------------------------------------------------------- katex failures
test("a thrown katex error becomes the mono fallback with the message in title", () => {
  stubKatex(() => { throw new Error("KaTeX parse error: Expected 'EOF' <\"x\">"); });
  assert.equal(markup.render("$x^$"), '<code class="tex tex--error" title="KaTeX parse error: Expected &#39;EOF&#39; &lt;&quot;x&quot;&gt;">x^</code>');
  assert.equal(markup.render("$$x^$$"), '<div class="math-display"><code class="tex tex--error" title="KaTeX parse error: Expected &#39;EOF&#39; &lt;&quot;x&quot;&gt;">x^</code></div>');
});

test("a .katex-error result (throwOnError: false) is treated like a thrown error", () => {
  stubKatex((src) => `<span class="katex-error" title="ParseError: bad &quot;x&quot;" style="color:#cc0000">${src}</span>`);
  assert.equal(markup.render("$<x>$"), '<code class="tex tex--error" title="ParseError: bad &quot;x&quot;">&lt;x&gt;</code>');
});

test("without katex, math renders as <code class=\"tex\"> source", () => {
  delete globalThis.katex;
  assert.equal(markup.render("$a<b$"), '<code class="tex">a&lt;b</code>');
  assert.equal(markup.render("$$E$$"), '<div class="math-display"><code class="tex">E</code></div>');
  globalThis.katex = null;
  assert.equal(markup.render("$E$"), '<code class="tex">E</code>');
});

// ---------------------------------------------------------------- plain / exports
test("plain keeps math source and replaces images with [image]", () => {
  assert.equal(markup.plain("a $x$ ![snip](att:a_1) b\n#t"), "a $x$ [image] b\n#t");
  assert.equal(markup.plain(""), "");
  assert.equal(markup.plain(null), "");
});

test("toAnki converts delimiters on math tokens only and keeps \\( \\[ alone", () => {
  const images = { a_1: "data:image/png;base64,AAA=" };
  const html = markup.toAnki("E: $$E=mc^2$$ and $x<y$, \\(y\\), \\[z\\]\nnext\tline ![snip](att:a_1) \\$5 $7 and $8", images);
  assert.equal(html, "E: \\[E=mc^2\\] and \\(x&lt;y\\), \\(y\\), \\[z\\]<br>nextline " +
    '<img src="data:image/png;base64,AAA="> \\$5 $7 and $8');
});

test("toAnki escapes HTML, removes tabs, drops the tags line and marks missing images", () => {
  assert.equal(markup.toAnki("<b>\t&\n#tag", {}), "&lt;b&gt;&amp;");
  assert.equal(markup.toAnki("![snip](att:nope)", (id) => null), "[image]");
  assert.equal(markup.toAnki("$$a\nb$$", null), "\\[a b\\]");
  assert.equal(markup.toAnki("{x} and {{c1::y}}", null), "{x} and {{c1::y}}");
  assert.ok(!/\n/.test(markup.toAnki("a\n$$b\nc$$\nd", null)));
});

test("toMarkdown keeps $ delimiters and the tags line and inlines images as data URIs", () => {
  const text = "Q. $x$ and $$y$$ ![snip](att:a_1)\nA. \\(z\\)\n#t";
  assert.equal(markup.toMarkdown(text, (id) => (id === "a_1" ? "data:image/png;base64,QQ==" : null)),
    "Q. $x$ and $$y$$ ![snip](data:image/png;base64,QQ==)\nA. \\(z\\)\n#t");
  assert.equal(markup.toMarkdown("see ![snip](att:gone)", {}), "see ![snip](att:gone)");
  assert.equal(markup.toMarkdown("plain", null), "plain");
});

test("render on the real tokenizer output shape (start/end offsets, inner math value)", { skip: !usingRealTokenizer }, () => {
  const toks = prompts.tokenize("a $x$ ![snip](att:a_1)");
  assert.equal(toks[1].type, "math");
  assert.equal(typeof toks[1].start, "number");
  assert.equal(markup.render("a $x$ ![snip](att:a_1)", { imageUrl: () => "blob:1" }), "a " + inline("x") + ' <img class="att" src="blob:1" alt="snip">');
});
