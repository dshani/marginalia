"use strict";
// test/reader-css.test.js: css/reader.css never sizes the #reader container (BUILD-NOTES "CSS ownership": the
// screen containers belong to styles.css). styles.css gives #reader `height: 100vh` and then `height: 100dvh`
// under `@supports (height: 100dvh)`, both at specificity (1,0,0), so on a phone the reader column matches the
// visible viewport while the browser toolbar is shown. css/reader.css is linked after styles.css, and every
// selector whose subject is #reader is at least (1,0,0) (`#reader:not(.is-hidden)` is (1,1,0)), so a height it
// declared there would win in every browser: the dvh rule would be dead and the end of the last page, the lowest
// margin cards and the last rows of the #list drawer would sit under the toolbar, out of reach of #scroller.
// The checker is a small CSS walker (comments, strings, @media / @supports nesting, selector lists, combinators,
// :not() / :has() arguments); its own cases below pin that it flags the old rule and nothing else.
// Run from the project root: node --test
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const READER_CSS = path.join(__dirname, "..", "css", "reader.css");
// Declarations that would replace the container's height from styles.css (`all` resets it to auto).
const SIZE_PROPS = new Set(["height", "min-height", "max-height", "block-size", "min-block-size", "max-block-size", "all"]);

// ------------------------------------------------------------------ CSS walker

/** Every style rule of `css` as {selectors, decls: [{prop, value}], at: [enclosing at-rule preludes]}. */
function styleRules(css) {
  const rules = [];
  const n = css.length;
  let i = 0;

  // Text up to (not including) the first char of `stops` met outside comments, strings, () and [].
  function readUntil(stops) {
    let out = "", depth = 0;
    while (i < n) {
      const c = css[i];
      if (c === "/" && css[i + 1] === "*") {
        const end = css.indexOf("*/", i + 2);
        if (end < 0) throw new Error("unterminated comment");
        i = end + 2; out += " "; continue;
      }
      if (c === "\"" || c === "'") {
        let j = i + 1;
        while (j < n && css[j] !== c) j += css[j] === "\\" ? 2 : 1;
        if (j >= n) throw new Error("unterminated string");
        out += css.slice(i, j + 1); i = j + 1; continue;
      }
      if (c === "(" || c === "[") depth++;
      else if (c === ")" || c === "]") depth--;
      else if (depth === 0 && stops.includes(c)) return out;
      out += c; i++;
    }
    return out;
  }
  function skipBlock() { // just after "{": consume through the matching "}"
    for (;;) {
      readUntil("{}");
      if (i >= n) throw new Error("unterminated block");
      if (css[i++] === "}") return;
      skipBlock();
    }
  }
  function ruleList(at) { // rules up to the "}" closing the enclosing at-rule (EOF at top level)
    for (;;) {
      const prelude = readUntil("{};").trim();
      if (i >= n) {
        if (at.length) throw new Error("unterminated " + at[at.length - 1]);
        if (prelude) throw new Error("trailing text: " + prelude);
        return;
      }
      const c = css[i++];
      if (c === "}") {
        if (!at.length) throw new Error("stray }");
        if (prelude) throw new Error("text before }: " + prelude);
        return;
      }
      if (c === ";") {
        if (prelude && prelude[0] !== "@") throw new Error("declaration outside a rule: " + prelude);
        continue; // @import / @charset
      }
      if (prelude[0] === "@") {
        if (/^@(media|supports|layer|container|document|scope)\b/i.test(prelude)) ruleList(at.concat(prelude.replace(/\s+/g, " ")));
        else skipBlock(); // @keyframes, @font-face, @page
        continue;
      }
      const body = readUntil("{}");
      if (i >= n) throw new Error("unterminated rule: " + prelude);
      if (css[i] === "{") throw new Error("nested rule inside " + prelude + " (this check expects flat CSS)");
      i++;
      rules.push({ selectors: splitTop(prelude, ","), decls: declarations(body), at: at });
    }
  }
  ruleList([]);
  return rules;
}

/** Split on `sep` outside strings, () and []. */
function splitTop(text, sep) {
  const out = [];
  let cur = "", depth = 0, quote = null;
  for (let k = 0; k < text.length; k++) {
    const c = text[k];
    if (quote) {
      cur += c;
      if (c === "\\") cur += text[++k] || "";
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "\"" || c === "'") quote = c;
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (depth === 0 && c === sep) { out.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function declarations(body) {
  const out = [];
  for (const part of splitTop(body, ";")) {
    const colon = part.indexOf(":");
    if (colon <= 0) continue;
    out.push({ prop: part.slice(0, colon).trim().toLowerCase(), value: part.slice(colon + 1).trim() });
  }
  return out;
}

/** The last compound selector of `selector` (the element the rule styles). */
function subjectCompound(selector) {
  const s = selector.trim();
  let depth = 0, quote = null, start = 0;
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (quote) { if (c === "\\") k++; else if (c === quote) quote = null; continue; }
    if (c === "\\") { k++; continue; }
    if (c === "\"" || c === "'") quote = c;
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (depth === 0 && /[\s>+~]/.test(c)) start = k + 1;
  }
  return s.slice(start);
}

/** Does this compound select the #reader element? (An id named inside :not() / :has() or a string does not count.) */
function selectsReader(compound) {
  const s = compound.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, "\"\"");
  let out = "", k = 0;
  while (k < s.length) {
    const m = /^:(not|has)\(/i.exec(s.slice(k));
    if (!m) { out += s[k++]; continue; }
    let depth = 0, j = k + m[0].length - 1;
    for (; j < s.length; j++) {
      if (s[j] === "(") depth++;
      else if (s[j] === ")" && --depth === 0) break;
    }
    out += ":" + m[1] + "()";
    k = j + 1;
  }
  return /#reader(?![\w-])/.test(out);
}

/** "<at-rules> <selector> { prop: value }" for every size declaration aimed at #reader itself. */
function readerSizeDecls(rules) {
  const out = [];
  for (const r of rules) {
    for (const sel of r.selectors) {
      if (!selectsReader(subjectCompound(sel))) continue;
      for (const d of r.decls) {
        if (SIZE_PROPS.has(d.prop)) out.push(r.at.concat(sel).join(" ") + " { " + d.prop + ": " + d.value + " }");
      }
    }
  }
  return out;
}

const flagged = (css) => readerSizeDecls(styleRules(css));

// ------------------------------------------------------------------ tests

test("css/reader.css declares no height on the #reader element itself (styles.css owns it: 100vh, then 100dvh)", () => {
  const rules = styleRules(fs.readFileSync(READER_CSS, "utf8"));
  // the walker really read the file: many rules, and it sees the toolbar's own 44-px height
  assert.ok(rules.length > 50, "parsed " + rules.length + " rules");
  assert.ok(rules.some((r) => r.selectors.includes("#toolbar") &&
    r.decls.some((d) => d.prop === "height" && d.value === "var(--toolbar-h)")), "the #toolbar rule");
  assert.ok(rules.some((r) => r.selectors.some((s) => selectsReader(subjectCompound(s)))), "some rule still targets #reader");
  assert.deepEqual(readerSizeDecls(rules), []);
});

test("the checker flags heights aimed at #reader, in any selector list or at-rule", () => {
  assert.deepEqual(flagged("#reader:not(.is-hidden) { display: flex; flex-direction: column; position: relative; height: 100vh; box-sizing: border-box; }"),
    ["#reader:not(.is-hidden) { height: 100vh }"]);
  assert.deepEqual(flagged("@supports (height: 100dvh) { #reader { height: 100dvh; } }"),
    ["@supports (height: 100dvh) #reader { height: 100dvh }"]);
  assert.deepEqual(flagged("@media (max-width: 599px) {\n  .x,\n  #reader.reader--stack { MIN-HEIGHT: 0 !important }\n}"),
    ["@media (max-width: 599px) #reader.reader--stack { min-height: 0 !important }"]);
  assert.deepEqual(flagged("#app:has(> #banner:not(.is-hidden)) > #reader:not(.is-hidden) { flex: 1 1 auto; height: auto; }"),
    ["#app:has(> #banner:not(.is-hidden)) > #reader:not(.is-hidden) { height: auto }"]);
  assert.deepEqual(flagged("section:is(.a #reader) { block-size: 50vh } #reader[data-x=\"a;b\"] { max-height: 1px; }"),
    ["section:is(.a #reader) { block-size: 50vh }", "#reader[data-x=\"a;b\"] { max-height: 1px }"]);
});

test("the checker ignores rules whose subject is not #reader, comments, strings and keyframes", () => {
  assert.deepEqual(flagged([
    "/* #reader { height: 1px } */",
    "#reader:focus { outline: none; }",
    ".reader--stack #scroller { overflow-x: hidden; height: 10px }",
    "#reader.reader--rail #margin { width: 44px; height: 10px }",
    "#reader:has(#snipOverlay:not(.is-hidden)) .textLayer { pointer-events: none; height: 0 }",
    "#reader > #toolbar { height: var(--toolbar-h) }",
    "#readerish, #reader-x, #reader_y { height: 1px }",
    "#app:has(> #reader:not(.is-hidden)) { height: 100vh }",
    ".x:not(#reader) { height: 1px }",
    ".a[data-x=\"#reader\"] { height: 1px }",
    ".b::after { content: \"#reader { height: 1px }\"; }",
    "@keyframes k { from { height: 0 } to { height: 1px } }",
    "@media (prefers-reduced-motion: reduce) { .page { height: 1px } }",
  ].join("\n")), []);
});

test("the walker rejects CSS it cannot read instead of passing vacuously", () => {
  assert.throws(() => styleRules("#reader { height: 1px"), /unterminated/);
  assert.throws(() => styleRules("@media (x) { #reader { height: 1px; }"), /unterminated/);
  assert.throws(() => styleRules("#reader { & .x { height: 1px } }"), /nested rule/);
  assert.throws(() => styleRules("/* open comment"), /unterminated comment/);
  assert.throws(() => styleRules("} #reader { height: 1px }"), /stray/);
});
