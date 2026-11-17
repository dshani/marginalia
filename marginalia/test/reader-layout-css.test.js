"use strict";
// test/reader-layout-css.test.js — the reader layout rules of BUILD-NOTES "Post-review decisions", read from the real
// stylesheets in index.html's link order through a small cascade: every flat rule, selector matching for the
// selector forms these files use (tag, #id, .class, [attr], :root, :not(), descendant and child combinators;
// any other pseudo-class, pseudo-element or sibling combinator does not match a static element), specificity,
// !important and source order. Checked:
//   - #margin is position: sticky; right: 0, with a z-index above the pages and below the list drawer, the snip
//     overlay, the sheet, the adder, the find bar and the toolbar menus, in wide, compact and rail (hidden in stack);
//   - .reader--compact gives --margin-w 224px / --card-w 192px (wide keeps 288 / 256) and cards use var(--card-w);
//   - the toolbar zoom group shows in wide, compact and rail at every fit level (hidden only in stack); the fit
//     levels shed Image|LaTeX first (⋯ appears), then the labels, then Review ▾ and ?;
//   - the margin is opaque over a page (.margin--pinned) and the fit control is lit while the zoom is manual.
// Run from the project root: node --test
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

// ------------------------------------------------------------------ CSS reader (flat rules, at-rule nesting)

function styleRules(css, file) {
  const rules = [];
  const n = css.length;
  let i = 0;
  function readUntil(stops) {
    let out = "", depth = 0;
    while (i < n) {
      const c = css[i];
      if (c === "/" && css[i + 1] === "*") {
        const end = css.indexOf("*/", i + 2);
        if (end < 0) throw new Error(file + ": unterminated comment");
        i = end + 2; out += " "; continue;
      }
      if (c === "\"" || c === "'") {
        let j = i + 1;
        while (j < n && css[j] !== c) j += css[j] === "\\" ? 2 : 1;
        out += css.slice(i, j + 1); i = j + 1; continue;
      }
      if (c === "(" || c === "[") depth++;
      else if (c === ")" || c === "]") depth--;
      else if (depth === 0 && stops.includes(c)) return out;
      out += c; i++;
    }
    return out;
  }
  function skipBlock() {
    for (;;) {
      readUntil("{}");
      if (i >= n) throw new Error(file + ": unterminated block");
      if (css[i++] === "}") return;
      skipBlock();
    }
  }
  function ruleList(at) {
    for (;;) {
      const prelude = readUntil("{};").trim();
      if (i >= n) return;
      const c = css[i++];
      if (c === "}") return;
      if (c === ";") continue;
      if (prelude[0] === "@") {
        if (/^@(media|supports)\b/i.test(prelude)) ruleList(at.concat(prelude.replace(/\s+/g, " ")));
        else skipBlock();
        continue;
      }
      const body = readUntil("{}");
      i++;
      rules.push({ selectors: splitTop(prelude, ","), decls: declarations(body), at, file, order: rules.length });
    }
  }
  ruleList([]);
  return rules;
}
function splitTop(text, sep) {
  const out = [];
  let cur = "", depth = 0, quote = null;
  for (let k = 0; k < text.length; k++) {
    const c = text[k];
    if (quote) { cur += c; if (c === "\\") cur += text[++k] || ""; else if (c === quote) quote = null; continue; }
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
    let value = part.slice(colon + 1).trim(), important = false;
    if (/!\s*important$/i.test(value)) { important = true; value = value.replace(/!\s*important$/i, "").trim(); }
    out.push({ prop: part.slice(0, colon).trim().toLowerCase(), value, important });
  }
  return out;
}

// ------------------------------------------------------------------ selectors

// "a > b.c d" → [{compound: "a"}, {comb: ">", compound: "b.c"}, {comb: " ", compound: "d"}]
function parseComplex(sel) {
  const parts = [];
  let cur = "", depth = 0, comb = null, k = 0;
  const s = sel.trim();
  function push() { if (cur.trim()) { parts.push({ comb, compound: cur.trim() }); comb = null; } cur = ""; }
  for (; k < s.length; k++) {
    const c = s[k];
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    if (depth === 0 && (c === ">" || c === "+" || c === "~")) { push(); comb = c; continue; }
    if (depth === 0 && /\s/.test(c)) { if (cur.trim()) { push(); comb = comb || " "; } continue; }
    cur += c;
  }
  push();
  return parts;
}
// simple selectors of a compound: [{kind, name, arg}]
function parseCompound(compound) {
  const out = [];
  const re = /\*|[a-zA-Z][\w-]*|#[\w-]+|\.[\w-]+|\[[^\]]*\]|::?[\w-]+(?:\((?:[^()]|\([^()]*\))*\))?/y;
  let pos = 0;
  while (pos < compound.length) {
    re.lastIndex = pos;
    const m = re.exec(compound);
    if (!m) throw new Error("cannot read selector " + JSON.stringify(compound));
    const t = m[0];
    if (t === "*") out.push({ kind: "any" });
    else if (t[0] === "#") out.push({ kind: "id", name: t.slice(1) });
    else if (t[0] === ".") out.push({ kind: "class", name: t.slice(1) });
    else if (t[0] === "[") {
      const a = /^\[\s*([\w-]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]*)))?\s*\]$/.exec(t);
      out.push({ kind: "attr", name: a[1], value: a[2] != null ? a[2] : a[3] != null ? a[3] : a[4] != null ? a[4] : null });
    } else if (t.startsWith("::")) out.push({ kind: "element", name: t.slice(2) });
    else if (t[0] === ":") {
      const pm = /^:([\w-]+)(?:\((.*)\))?$/.exec(t);
      out.push({ kind: "pseudo", name: pm[1].toLowerCase(), arg: pm[2] });
    } else out.push({ kind: "tag", name: t.toLowerCase() });
    pos = re.lastIndex;
  }
  return out;
}
function matchCompound(el, compound) {
  return parseCompound(compound).every((p) => {
    switch (p.kind) {
      case "any": return true;
      case "tag": return el.tag === p.name;
      case "id": return el.id === p.name;
      case "class": return el.classes.includes(p.name);
      case "attr": return Object.prototype.hasOwnProperty.call(el.attrs, p.name) && (p.value == null || el.attrs[p.name] === p.value);
      case "element": return false;                       // a pseudo-element is not the element itself
      case "pseudo":
        if (p.name === "root") return el.tag === "html";
        if (p.name === "not") return !splitTop(p.arg, ",").some((a) => matches(el, a));
        return false;                                    // :hover, :focus…, :has(), :disabled: not in this static state
      default: return false;
    }
  });
}
function matches(el, selector) {
  const parts = parseComplex(selector);
  function at(node, idx) {
    if (!node || !matchCompound(node, parts[idx].compound)) return false;
    if (idx === 0) return true;
    const comb = parts[idx].comb;
    if (comb === ">") return at(node.parent, idx - 1);
    if (comb === " ") { for (let a = node.parent; a; a = a.parent) if (at(a, idx - 1)) return true; return false; }
    return false;                                        // + and ~: no siblings in these chains
  }
  return at(el, parts.length - 1);
}
function specificity(selector) {
  let a = 0, b = 0, c = 0;
  for (const part of parseComplex(selector)) {
    for (const p of parseCompound(part.compound)) {
      if (p.kind === "id") a++;
      else if (p.kind === "class" || p.kind === "attr") b++;
      else if (p.kind === "tag" || p.kind === "element") c++;
      else if (p.kind === "pseudo") {
        if (p.name === "not" || p.name === "is" || p.name === "has") {
          const best = splitTop(p.arg, ",").map(specificity).sort((x, y) => (y[0] - x[0]) || (y[1] - x[1]) || (y[2] - x[2]))[0];
          a += best[0]; b += best[1]; c += best[2];
        } else if (p.name !== "where") b++;
      }
    }
  }
  return [a, b, c];
}

// ------------------------------------------------------------------ the stylesheets and the cascade

const LINKS = (() => {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  return Array.from(html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)).map((m) => m[1]).filter((h) => !/^https?:/.test(h));
})();
const RULES = (() => {
  const all = [];
  LINKS.forEach((href, f) => {
    styleRules(fs.readFileSync(path.join(ROOT, href), "utf8"), href).forEach((r) => all.push(Object.assign(r, { fileIndex: f })));
  });
  return all;
})();

// The cascaded value of `prop` on `el`, ignoring @media blocks (none of them touches these properties: checked below).
function cascade(el, prop) {
  let best = null;
  for (const r of RULES) {
    if (r.at.some((a) => /^@media/i.test(a))) continue;
    for (const sel of r.selectors) {
      if (!matches(el, sel)) continue;
      const spec = specificity(sel);
      for (const d of r.decls) {
        if (d.prop !== prop) continue;
        const key = [d.important ? 1 : 0, spec[0], spec[1], spec[2], r.fileIndex, r.order];
        if (!best || compareKeys(key, best.key) >= 0) best = { key, value: d.value, sel, file: r.file };
      }
    }
  }
  return best;
}
function compareKeys(x, y) { for (let k = 0; k < x.length; k++) if (x[k] !== y[k]) return x[k] - y[k]; return 0; }
function value(el, prop) { const b = cascade(el, prop); return b ? b.value : null; }

// element chains of the BUILD-NOTES skeleton
function node(tag, id, classes, attrs, parent) { return { tag, id: id || "", classes: classes || [], attrs: attrs || {}, parent: parent || null }; }
function readerChain(modeClasses) {
  const html = node("html"), body = node("body", "", [], {}, html), app = node("div", "app", [], {}, body);
  const reader = node("section", "reader", modeClasses, { tabindex: "-1" }, app);
  return { html, app, reader };
}
function marginEl(modeClasses, marginClasses) {
  const c = readerChain(modeClasses), scroller = node("div", "scroller", [], {}, c.reader);
  return Object.assign(node("div", "margin", ["margin"].concat(marginClasses || []), {}, scroller), { reader: c.reader, html: c.html });
}
function toolbarItem(modeClasses, fitLevel, tag, classes) {
  const c = readerChain(modeClasses);
  const tbClasses = [];
  for (let k = 1; k <= fitLevel; k++) tbClasses.push("tb--fit-" + k);
  const tb = node("div", "toolbar", tbClasses, { role: "toolbar" }, c.reader);
  return node(tag, "", classes, {}, tb);
}
// a custom property as #margin would see it (inherited from #reader, else :root)
function customProp(modeClasses, prop) {
  const m = marginEl(modeClasses);
  for (const el of [m, m.parent, m.reader, m.html]) { const v = value(el, prop); if (v != null) return v; }
  return null;
}

const MODES = {
  wide: ["reader--wide"],
  compact: ["reader--wide", "reader--compact"],
  rail: ["reader--rail"],
  stack: ["reader--stack"]
};

// ------------------------------------------------------------------ tests

test("the cascade reads the real stylesheets in index.html order", () => {
  assert.deepEqual(LINKS.slice(0, 4), ["styles.css", "css/app.css", "css/library.css", "css/reader.css"]);
  assert.ok(LINKS.includes("css/margin.css"));
  assert.ok(RULES.length > 200, "parsed " + RULES.length + " rules");
  // sanity of the matcher on known rules
  assert.equal(value(marginEl(MODES.rail), "width"), "44px");
  assert.equal(value(marginEl(MODES.stack), "display"), "none");
  assert.equal(value(toolbarItem(MODES.stack, 0, "span", ["tb-group", "tb-zoom-group"]), "display"), "none");
  assert.deepEqual(specificity("#reader.reader--wide.reader--compact"), [1, 2, 0]);
  assert.deepEqual(specificity(":root:not([data-theme=light])"), [0, 2, 0]);
  // no @media block touches the properties checked here
  const checked = new Set(["position", "right", "inset", "z-index", "display", "--margin-w", "--card-w", "background"]);
  for (const r of RULES) {
    if (!r.at.some((a) => /^@media/i.test(a))) continue;
    for (const sel of r.selectors) {
      if (!/#margin|\.margin|tb-zoom|tb-seg|tb-more|tb-review|tb-help|#reader\b/.test(sel)) continue;
      assert.ok(!r.decls.some((d) => checked.has(d.prop)), r.file + " @media " + sel);
    }
  }
});

test("#margin is sticky at the scroller's right edge in wide, compact and rail (hidden in stack)", () => {
  for (const mode of ["wide", "compact", "rail"]) {
    const m = marginEl(MODES[mode], ["margin--" + (mode === "compact" ? "wide" : mode)]);
    assert.equal(value(m, "position"), "sticky", mode + ": position");
    assert.equal(value(m, "right"), "0", mode + ": right");
    assert.equal(cascade(m, "inset"), null, mode + ": no inset shorthand overrides right");
    assert.notEqual(value(m, "display"), "none", mode + ": shown");
    const z = Number(value(m, "z-index"));
    assert.ok(Number.isInteger(z) && z > 0, mode + ": z-index above the pages (" + z + ")");
  }
  const stack = marginEl(MODES.stack, ["margin--stack"]);
  assert.equal(value(stack, "display"), "none");
});

test("the sticky margin stacks under the reader's overlays and popups", () => {
  const z = Number(value(marginEl(MODES.wide), "z-index"));
  const app = readerChain(MODES.wide);
  const zOf = (id, classes) => Number(value(node("div", id, classes || [], {}, app.reader), "z-index"));
  const above = { "#list drawer": zOf("list", ["list-host--drawer"]), "#snipOverlay": zOf("snipOverlay"), "#sheet": zOf("sheet"), "#adder": zOf("adder"), "#find": zOf("find") };
  above[".tb-menu"] = Number(value(node("div", "", ["tb-menu"], {}, app.reader), "z-index"));
  for (const [name, zz] of Object.entries(above)) assert.ok(zz > z, name + " (" + zz + ") above #margin (" + z + ")");
  // pages isolate their own layers, so the page's highlight / text / dim layers never climb over the margin
  const page = node("div", "", ["page"], {}, node("div", "pages", [], {}, node("div", "scroller", [], {}, app.reader)));
  assert.equal(value(page, "isolation"), "isolate");
});

test("compact wide mode: 224-px margin and 192-px cards; wide keeps 288 / 256; rail 44", () => {
  assert.equal(customProp(MODES.wide, "--margin-w"), "288px");
  assert.equal(customProp(MODES.wide, "--card-w"), "256px");
  assert.equal(customProp(MODES.compact, "--margin-w"), "224px");
  assert.equal(customProp(MODES.compact, "--card-w"), "192px");
  assert.equal(customProp(MODES.rail, "--margin-w"), "44px");
  assert.equal(value(marginEl(MODES.compact), "width"), "var(--margin-w)");
  const card = node("div", "", ["card"], {}, marginEl(MODES.compact));
  assert.match(value(card, "width"), /var\(--card-w\)/);
  assert.equal(value(card, "left"), "13px");                // 13 + 192 + 3 + 16 = 224
});

test("the zoom group shows in wide, compact and rail at every toolbar fit level; only stack hides it", () => {
  for (const mode of ["wide", "compact", "rail"]) {
    for (let level = 0; level <= 3; level++) {
      const zoom = toolbarItem(MODES[mode], level, "span", ["tb-group", "tb-zoom-group"]);
      assert.notEqual(value(zoom, "display"), "none", mode + " fit " + level);
      assert.equal(value(zoom, "display"), "inline-flex");
    }
  }
  assert.equal(value(toolbarItem(MODES.stack, 0, "span", ["tb-group", "tb-zoom-group"]), "display"), "none");
});

test("toolbar fit levels shed Image|LaTeX first (⋯ appears), then the labels, then Review ▾ and ?", () => {
  const shown = (level, tag, classes, mode) => value(toolbarItem(MODES[mode || "compact"], level, tag, classes), "display") !== "none";
  const seg = (l) => shown(l, "span", ["tb-seg"]), more = (l) => shown(l, "button", ["tb-btn", "tb-more"]);
  const label = (l) => shown(l, "span", ["tb-back__label"]), review = (l) => shown(l, "button", ["tb-btn", "tb-review"]);
  const help = (l) => shown(l, "button", ["tb-btn", "tb-help"]);
  assert.deepEqual([seg(0), more(0), label(0), review(0), help(0)], [true, false, true, true, true], "level 0: everything, no ⋯");
  assert.deepEqual([seg(1), more(1), label(1), review(1), help(1)], [false, true, true, true, true], "level 1: Image|LaTeX → ⋯");
  assert.deepEqual([seg(2), more(2), label(2), review(2), help(2)], [false, true, false, true, true], "level 2: labels");
  assert.deepEqual([seg(3), more(3), label(3), review(3), help(3)], [false, true, false, false, false], "level 3: Review ▾ and ?");
  assert.equal(shown(0, "button", ["tb-btn", "tb-more"], "rail"), true, "rail always offers ⋯");
  assert.equal(shown(0, "button", ["tb-btn", "tb-more"], "stack"), true, "stack too");
  // the measuring pass keeps the title from shrinking below 160 px
  const c = readerChain(MODES.compact);
  const name = node("button", "", ["tb-btn", "tb-name"], {}, node("div", "toolbar", ["tb--measure"], {}, c.reader));
  assert.equal(value(name, "flex-shrink"), "0");
  assert.equal(value(name, "max-width"), "160px");
});

test("over a page the margin is opaque (.margin--pinned) and the fit control is lit while the zoom is manual", () => {
  const m = marginEl(MODES.wide, ["margin--wide"]);
  assert.match(value(m, "background"), /var\(--bg\)/, "opaque past a 4-px strip even when not pinned");
  const pinned = marginEl(MODES.wide, ["margin--wide", "margin--pinned"]);
  assert.equal(value(pinned, "background"), "var(--bg)");
  assert.match(value(pinned, "box-shadow"), /inset 1px 0 0 var\(--line\)/, "the 1-px rule on its left");
  const fit = (classes) => value(toolbarItem(MODES.wide, 0, "button", ["tb-btn", "tb-zoom-fit"].concat(classes)), "color");
  assert.equal(fit(["is-manual"]), "var(--accent)");
  assert.notEqual(fit([]), "var(--accent)");
});
