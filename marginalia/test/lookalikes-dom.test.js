"use strict";
// Marginalia — test/lookalikes-dom.test.js: FEATURES P2.4 c, d (look-alike prompts) on the small fake DOM of
// test/split-angles.test.js (a copy, as that file copies margin-dom's) with the real util, bus, settings, store (memory),
// scheduler, prompts, similar, context, keys, layout, markup, cache, app, editor, margin and list modules.
//  - the prompt list's third chip "Look-alikes n": its count, the grouping of pairs, the "≈" line, "Not alike" in the
//    row menu (only while the chip is on) and settings.notAlike; the pairs follow a restored notAlike (an import);
//  - the pairs are computed when the list opens and after a prompt's text changes, never on a search key stroke
//    (M.similar.pairs calls counted);
//  - the editor's "Similar prompt" line: shown for the nearest look-alike of the same book (with its page) or deck
//    (no page), never the prompt being edited, hidden for a pair in notAlike, absent for notes; it never blocks a save.
// Run: node --test test/lookalikes-dom.test.js
const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");


// ---- fake DOM: what margin.js and app.handleKeydown touch -----------------------------------------------
const VOID = /^(br|img|input|hr|meta|link|path|col|source|wbr)$/i;

function bag(target) { return target._listeners || (target._listeners = {}); }
function on(target, type, fn) { (bag(target)[type] = bag(target)[type] || []).push(fn); }
function off(target, type, fn) { const l = bag(target)[type]; const i = l ? l.indexOf(fn) : -1; if (i >= 0) l.splice(i, 1); }
function callListeners(target, ev) { (bag(target)[ev.type] || []).slice().forEach((fn) => fn.call(target, ev)); }
function decode(s) { return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&amp;/g, "&"); }

// Compound selectors ("tag.a.b#id[attr=\"v\"]") in comma lists, no combinators: all that is needed here.
function matchCompound(el, sel) {
  if (!el || el.nodeType !== 1) return false;
  const m = /^([a-zA-Z][\w-]*|\*)?((?:[.#][\w-]+|\[[^\]]+\])*)$/.exec(sel.trim());
  if (!m) return false;
  if (m[1] && m[1] !== "*" && el.tagName !== m[1].toUpperCase()) return false;
  return (m[2].match(/[.#][\w-]+|\[[^\]]+\]/g) || []).every((p) => {
    if (p[0] === ".") return el.classList.contains(p.slice(1));
    if (p[0] === "#") return el.id === p.slice(1);
    const a = /^\[\s*([\w:-]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]*)))?\s*\]$/.exec(p);
    if (!a) return false;
    const v = el.getAttribute(a[1]);
    const want = a[2] != null ? a[2] : a[3] != null ? a[3] : a[4];
    return v != null && (want == null || v === want);
  });
}
function matches(el, sel) { return String(sel).split(",").some((s) => matchCompound(el, s)); }

function makeText(s) { return { nodeType: 3, nodeName: "#text", textContent: s, parentNode: null }; }
function parseInto(doc, root, html) {
  const re = /<\/?([a-zA-Z][\w-]*)([^>]*)>|([^<]+)/g, stack = [root];
  let t;
  while ((t = re.exec(html))) {
    const parent = stack[stack.length - 1];
    if (t[3] !== undefined) { parent.appendChild(makeText(decode(t[3]))); continue; }
    if (t[0][1] === "/") { if (stack.length > 1) stack.pop(); continue; }
    const child = makeElement(doc, t[1]);
    const ar = /([^\s=/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
    let a;
    while ((a = ar.exec(t[2]))) child.setAttribute(a[1], decode(a[2] != null ? a[2] : a[3] != null ? a[3] : a[4] != null ? a[4] : ""));
    parent.appendChild(child);
    if (!/\/\s*$/.test(t[2]) && !VOID.test(t[1])) stack.push(child);
  }
}

function makeElement(doc, tag) {
  const el = {
    nodeType: 1, tagName: String(tag).toUpperCase(), nodeName: String(tag).toUpperCase(), ownerDocument: doc,
    parentNode: null, childNodes: [], attributes: {}, style: {}, dataset: {}, id: "", tabIndex: -1,
    scrollTop: 0, clientHeight: 0, offsetHeight: 0, _html: "", _text: null
  };
  const classes = new Set();
  el.classList = {
    add(...c) { c.forEach((x) => classes.add(String(x))); },
    remove(...c) { c.forEach((x) => classes.delete(String(x))); },
    toggle(c, force) { const want = force === undefined ? !classes.has(c) : !!force; if (want) classes.add(c); else classes.delete(c); return want; },
    contains(c) { return classes.has(c); }
  };
  Object.defineProperty(el, "className", {
    get() { return Array.from(classes).join(" "); },
    set(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); }
  });
  Object.defineProperty(el, "children", { get() { return el.childNodes.filter((n) => n.nodeType === 1); } });
  Object.defineProperty(el, "firstChild", { get() { return el.childNodes[0] || null; } });
  Object.defineProperty(el, "innerHTML", {
    get() { return el._html; },
    set(v) { el.childNodes.slice().forEach((c) => el.removeChild(c)); el._html = String(v); el._text = null; parseInto(doc, el, el._html); }
  });
  Object.defineProperty(el, "textContent", {
    get() { return el._text != null ? el._text : el.childNodes.map((c) => c.textContent).join(""); },
    set(v) { el.childNodes.slice().forEach((c) => el.removeChild(c)); el._html = ""; el._text = String(v); }
  });
  el.setAttribute = (k, v) => {
    k = String(k); v = String(v);
    el.attributes[k] = v;
    if (k === "class") el.className = v;
    else if (k === "id") el.id = v;
    else if (k === "tabindex") el.tabIndex = Number(v);
  };
  el.getAttribute = (k) => (k === "id" && el.id ? el.id : Object.prototype.hasOwnProperty.call(el.attributes, k) ? el.attributes[k] : null);
  el.hasAttribute = (k) => Object.prototype.hasOwnProperty.call(el.attributes, k);
  el.removeAttribute = (k) => { delete el.attributes[k]; };
  el.insertBefore = (c, ref) => {
    if (c.nodeType === 11) { c.childNodes.slice().forEach((k) => el.insertBefore(k, ref)); return c; }
    if (c.parentNode) c.parentNode.removeChild(c);
    const i = ref ? el.childNodes.indexOf(ref) : -1;
    if (i < 0) el.childNodes.push(c); else el.childNodes.splice(i, 0, c);
    c.parentNode = el;
    return c;
  };
  el.appendChild = (c) => el.insertBefore(c, null);
  el.removeChild = (c) => {
    const i = el.childNodes.indexOf(c);
    if (i >= 0) el.childNodes.splice(i, 1);
    c.parentNode = null;
    if (c.nodeType === 1 && c.contains(doc.activeElement)) doc.activeElement = doc.body;   // as a browser does
    return c;
  };
  el.contains = (n) => { for (; n; n = n.parentNode) if (n === el) return true; return false; };
  el.querySelectorAll = (sel) => {
    const out = [];
    (function walk(n) { n.childNodes.forEach((c) => { if (c.nodeType === 1) { if (matches(c, sel)) out.push(c); walk(c); } }); })(el);
    return out;
  };
  el.querySelector = (sel) => el.querySelectorAll(sel)[0] || null;
  el.closest = (sel) => { for (let n = el; n && n.nodeType === 1; n = n.parentNode) if (matches(n, sel)) return n; return null; };
  el.matches = (sel) => matches(el, sel);
  el.addEventListener = (type, fn) => on(el, type, fn);
  el.removeEventListener = (type, fn) => off(el, type, fn);
  el.dispatchEvent = (ev) => { callListeners(el, ev); return !ev.defaultPrevented; };
  el.focus = () => { doc.activeElement = el; callListeners(el, { type: "focus", target: el }); };
  el.blur = () => { if (doc.activeElement === el) doc.activeElement = doc.body; };
  el.getBoundingClientRect = () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
  el.scrollTo = (o) => { if (o && typeof o.top === "number") el.scrollTop = o.top; };
  // a textarea's value and selection (what M.editor touches)
  el.value = ""; el.selectionStart = 0; el.selectionEnd = 0; el.scrollHeight = 0; el.placeholder = ""; el.disabled = false; el.title = "";
  el.setSelectionRange = (a, b) => { el.selectionStart = a; el.selectionEnd = b; };
  el.setRangeText = (text, start, end, mode) => {
    const v = el.value;
    el.value = v.slice(0, start) + text + v.slice(end);
    if (mode === "select") { el.selectionStart = start; el.selectionEnd = start + text.length; }
    else { el.selectionStart = el.selectionEnd = start + text.length; }
  };
  return el;
}

function makeDocument() {
  const doc = { nodeType: 9, parentNode: null };
  doc.createElement = (tag) => makeElement(doc, tag);
  doc.createElementNS = (ns, tag) => makeElement(doc, tag);
  doc.createTextNode = (s) => makeText(String(s));
  doc.createDocumentFragment = () => { const f = makeElement(doc, "#fragment"); f.nodeType = 11; return f; };
  doc.documentElement = makeElement(doc, "html");
  doc.body = makeElement(doc, "body");
  doc.documentElement.appendChild(doc.body);
  doc.documentElement.parentNode = doc;
  doc.activeElement = doc.body;
  doc.contains = (n) => doc.documentElement.contains(n);
  doc.getElementById = (id) => doc.documentElement.querySelector("#" + id);
  doc.querySelector = (sel) => doc.documentElement.querySelector(sel);
  doc.querySelectorAll = (sel) => doc.documentElement.querySelectorAll(sel);
  doc.addEventListener = (type, fn) => on(doc, type, fn);
  doc.removeEventListener = (type, fn) => off(doc, type, fn);
  // the BUILD-NOTES hosts this test needs: #reader > #toolbar, #scroller > (#pages, #margin), #sheet
  doc.body.innerHTML = '<div id="app"><section id="reader" tabindex="-1"><div id="toolbar" role="toolbar"></div>' +
    '<div id="scroller"><div class="gutter"></div><div id="pages"></div><div id="margin"></div></div>' +
    '<div id="sheet" class="is-hidden"></div></section></div>';
  doc.getElementById("scroller").clientHeight = 800;
  return doc;
}

// ---- events -------------------------------------------------------------------------------------------
function makeEvent(type, target, key) {
  const ev = { type, key, code: "", ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, repeat: false,
    isComposing: false, keyCode: 0, target, defaultPrevented: false, stopped: false };
  ev.preventDefault = () => { ev.defaultPrevented = true; };
  ev.stopPropagation = () => { ev.stopped = true; };
  return ev;
}
function bubble(ev) { for (let n = ev.target; n && n.nodeType === 1 && !ev.stopped; n = n.parentNode) callListeners(n, ev); }
// A keydown as a browser delivers it: element listeners from the target up, then app's one document listener.
function press(key, target) {
  const ev = makeEvent("keydown", target, key);
  bubble(ev);
  const handled = ev.stopped ? false : M.app.handleKeydown(ev);
  return { ev, handled };
}
function click(target) { const ev = makeEvent("click", target); bubble(ev); return ev; }
// Enter on a focused button: when the keydown is not cancelled the browser fires the button's click.
function enterOnButton(button) {
  const r = press("Enter", button);
  if (!r.ev.defaultPrevented) click(button);
  return r;
}
const tick = (n) => new Promise((resolve) => { (function loop(i) { if (i <= 0) return resolve(); setTimeout(() => loop(i - 1), 2); })(n || 6); });


// ---- setup --------------------------------------------------------------------------------------------
let M, doc;
const store = new Map();
const fakeStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); }, removeItem: (k) => { store.delete(k); } };
const DEBOUNCE = 200;                                     // the search's and the editor's debounces are 120 ms
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  doc = makeDocument();
  doc.getElementById("app").appendChild(makeElement(doc, "div")).id = "deckHost";
  globalThis.document = doc;
  globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
  Object.defineProperty(globalThis, "localStorage", { value: fakeStorage, configurable: true, writable: true });
  const JS = path.join(__dirname, "..", "js");
  for (const name of ["util", "bus", "settings", "store", "scheduler", "prompts", "similar", "context", "keys", "layout", "markup", "cache", "app", "editor", "margin", "list"]) {
    require(path.join(JS, name + ".js"));
  }
  M = globalThis.Marginalia;
  await M.cache.load();
  await M.cache.saveCollection({ id: "book_1", kind: "book", name: "Book" });
  M.app.setFocusOwner("reader");
  M.margin.mount(doc.getElementById("scroller"), doc.getElementById("margin"));
  M.bus.emit("doc:opened", { collectionId: "book_1" });
  M.bus.emit("pages:measured", { pageTops: [0], pageHeights: [1200] });
  await tick();
});

const qa = (q) => "Q. " + q + "\nA. answer";
const FERMI_ZERO = qa("What is the Fermi energy of a metal at zero temperature?");
const FERMI_ROOM = qa("What is the Fermi energy of a metal at room temperature?");
const AARE_1 = "The {Aare} flows through Bern in Switzerland.";
// FIXES-1 FIX-7 b: the same sentence with other blanks is no look-alike any more, so the second cloze is another sentence
const AARE_2 = "The Aare river flows through {Bern} in Switzerland.";
const STARS = qa("Why do stars shine?");

// Prompts of a collection, one page each in the given order (a deck: no anchor, a section context).
async function seedIn(collectionId, kind, texts) {
  await M.cache.saveCollection(kind === "deck" ? { id: collectionId, kind: "deck", name: "Deck " + collectionId } : { id: collectionId, kind: "book", name: "Book " + collectionId });
  const ids = [];
  for (let i = 0; i < texts.length; i++) {
    const parsed = M.prompts.parse(texts[i]);
    const id = collectionId + "_p" + i;
    await M.cache.savePrompt({
      id, collectionId, kind: parsed.kind, text: texts[i], tags: parsed.tags.slice(), flagged: false, createdAt: 1000 + i,
      cards: M.prompts.reconcileCards(null, parsed, 1000).cards,
      anchor: kind === "deck" ? null : { pageIndex: i, y: 500, quote: "passage " + i, prefix: "", suffix: "", pages: [], lost: false },
      context: kind === "deck" ? { docName: "Deck", sectionLabel: null, pageIndex: null, pageLabel: null } : { pageIndex: i, pageLabel: null }
    }, { content: true });
    ids.push(id);
  }
  return ids;
}
const host = () => doc.getElementById("deckHost");
const rowEls = () => host().querySelectorAll(".list__row");
const rowIds = () => rowEls().map((r) => r.getAttribute("data-id"));
const chipEl = (id) => host().querySelector('button[data-chip="' + id + '"]');
const chipText = (id) => chipEl(id).textContent;
const chipShown = (id) => !chipEl(id).classList.contains("is-hidden");
const alikeLine = (id) => { const r = host().querySelector('.list__row[data-id="' + id + '"]'); const l = r && r.querySelector(".list__alike"); return l ? l.textContent : null; };
function menuLabels(id) {
  click(host().querySelector('.list__row[data-id="' + id + '"]').querySelector(".list__more"));
  const menu = host().querySelector(".list__menu");
  assert.ok(menu, "the row menu opened");
  return menu.querySelectorAll(".list__menu-item").map((b) => b.textContent);
}
function menuPick(id, label) {
  menuLabels(id);
  const b = host().querySelector(".list__menu").querySelectorAll(".list__menu-item").find((x) => x.textContent === label);
  assert.ok(b, label);
  click(b);
}
function closeMenu() { const m = host().querySelector(".list__menu"); if (m) press("Escape", doc.activeElement); }
function type(ed, text) { ed.textarea.value = text; ed.textarea.dispatchEvent(new Event("input")); }
const similarEl = (ed) => ed.el.querySelector(".editor__similar");
const similarText = (ed) => { const e = similarEl(ed); return e && !e.classList.contains("is-hidden") ? e.textContent : null; };
// counts M.similar.pairs calls while fn runs
async function countPairs(fn) {
  const real = M.similar.pairs;
  let n = 0;
  M.similar.pairs = function () { n++; return real.apply(this, arguments); };
  try { await fn(); } finally { M.similar.pairs = real; }
  return n;
}

// ---- P2.4 c: the list ----------------------------------------------------------------------------------

test("the Look-alikes chip counts the prompts in a pair (live Q./A. and cloze only) and shows only while it counts some", async () => {
  const ids = await seedIn("b_la1", "book", [FERMI_ZERO, STARS, AARE_1, FERMI_ROOM, AARE_2, "Fermi energy of a metal at zero temperature, a note"]);
  try {
    assert.equal(M.list.open("b_la1", { host: host() }), true);
    assert.equal(chipText("alike"), "Look-alikes 4");
    assert.equal(chipShown("alike"), true);
    assert.deepEqual(M.list.CHIPS.map((c) => c.id), ["flagged", "struggling", "alike"], "the third chip, after P1's");
    assert.deepEqual(M.list.alikePairs().map((x) => M.similar.key(x.a, x.b)).sort(), [ids[0] + "|" + ids[3], ids[2] + "|" + ids[4]]);
    assert.equal(alikeLine(ids[0]), null, "no ≈ line while the chip is off");
    M.list.close();
    await seedIn("b_la0", "book", [FERMI_ZERO, STARS]);
    assert.equal(M.list.open("b_la0", { host: host() }), true);
    assert.equal(chipShown("alike"), false, "no pair: no chip");
    assert.equal(chipText("alike"), "Look-alikes 0");
  } finally { M.list.close(); }
});

test("chip on: only the prompts in a pair, each pair together, a quiet ≈ line naming the other prompt; AND with the search", async () => {
  const ids = await seedIn("b_la2", "book", [FERMI_ZERO, STARS, AARE_1, FERMI_ROOM, AARE_2]);
  try {
    M.list.open("b_la2", { host: host() });
    click(chipEl("alike"));
    assert.equal(chipEl("alike").getAttribute("aria-pressed"), "true");
    assert.deepEqual(M.list.activeChips(), ["alike"]);
    assert.deepEqual(rowIds(), [ids[0], ids[3], ids[2], ids[4]], "grouped: the pairs stand next to each other");
    assert.equal(alikeLine(ids[0]), "≈ What is the Fermi energy of a metal at room temperature?");
    assert.equal(alikeLine(ids[3]), "≈ What is the Fermi energy of a metal at zero temperature?");
    assert.equal(alikeLine(ids[2]), "≈ The Aare river flows through Bern in Switzerland.", "a cloze without its braces");
    assert.equal(host().querySelector(".list__count").textContent, "5 prompts · 4 shown");
    M.list.search("aare");
    assert.deepEqual(rowIds(), [ids[2], ids[4]]);
    M.list.search("");
    click(chipEl("alike"));
    assert.deepEqual(rowIds(), ids, "chip off: every row, in reading order");
    assert.equal(alikeLine(ids[0]), null);
  } finally { M.list.close(); }
});

test("connected groups stay together, and a row with several partners says how many more", async () => {
  // three prompts that are all alike with each other, and one pair, interleaved by page
  const T = (w) => qa("What sets the Fermi energy of a metal " + w + "?");
  const ids = await seedIn("b_la3", "book", [T("here"), AARE_1, T("there"), AARE_2, T("anywhere")]);
  try {
    M.list.open("b_la3", { host: host() });
    assert.equal(chipText("alike"), "Look-alikes 5");
    click(chipEl("alike"));
    assert.deepEqual(rowIds(), [ids[0], ids[2], ids[4], ids[1], ids[3]]);
    assert.match(alikeLine(ids[0]), /^≈ What sets the Fermi energy of a metal (there|anywhere)\? \(\+1 more\)$/);
  } finally { M.list.close(); }
});

test("“Not alike” (only while the chip is on) adds the row's pairs to settings.notAlike; the rows leave the filter", async () => {
  M.settings.set("notAlike", []);
  const ids = await seedIn("b_la4", "book", [FERMI_ZERO, STARS, AARE_1, FERMI_ROOM, AARE_2]);
  try {
    M.list.open("b_la4", { host: host() });
    let labels = menuLabels(ids[2]);
    assert.equal(labels.includes("Not alike"), false, "chip off: no Not alike");
    closeMenu();
    click(chipEl("alike"));
    labels = menuLabels(ids[2]);
    assert.deepEqual(labels.slice(0, 3), ["Edit", "Split", "Not alike"]);
    closeMenu();
    menuPick(ids[2], "Not alike");
    assert.deepEqual(M.settings.get("notAlike"), [M.similar.key(ids[2], ids[4])]);
    assert.deepEqual(rowIds(), [ids[0], ids[3]], "both rows of that pair leave the filter");
    assert.equal(chipText("alike"), "Look-alikes 2");
    assert.ok(host().contains(doc.activeElement), "focus stays in the list");
    assert.equal(doc.activeElement.getAttribute("data-id"), ids[3], "on the neighbouring row (the one before it, none is left after it)");
    menuPick(ids[0], "Not alike");
    assert.deepEqual(M.settings.get("notAlike").length, 2);
    assert.deepEqual(rowIds(), []);
    assert.equal(chipText("alike"), "Look-alikes 0");
    assert.equal(chipShown("alike"), true, "on: still shown at 0");
    // an import that restores settings (M.settings.set, as importJSON does) brings the pairs back
    M.settings.set("notAlike", []);
    assert.deepEqual(rowIds(), [ids[0], ids[3], ids[2], ids[4]]);
    assert.equal(chipText("alike"), "Look-alikes 4");
  } finally { M.list.close(); M.settings.set("notAlike", []); }
});

test("the pairs are computed when the list opens and after a prompt's text changes, never on a search key stroke", async () => {
  const ids = await seedIn("b_la5", "book", [FERMI_ZERO, STARS, AARE_1, FERMI_ROOM, AARE_2]);
  try {
    assert.equal(await countPairs(() => M.list.open("b_la5", { host: host() })), 1, "once at open");
    const input = host().querySelector("input");
    const typed = await countPairs(async () => {
      for (const v of ["a", "aa", "aar", "aare", "aar", "a", "", "f", "fe", "fermi"]) { input.value = v; input.dispatchEvent(new Event("input")); await sleep(5); }
      await sleep(DEBOUNCE);
      for (const v of ["x", "xy", ""]) M.list.search(v);    // and three renders without the debounce
    });
    assert.equal(typed, 0, "no computation for the search");
    assert.deepEqual(rowIds(), ids);
    const flag = await countPairs(() => M.cache.savePrompt(Object.assign({}, M.cache.prompt(ids[1]), { flagged: true }), { content: true }));
    assert.equal(flag, 0, "a flag does not change the words");
    const edit = await countPairs(() => M.cache.savePrompt(Object.assign({}, M.cache.prompt(ids[1]), { text: FERMI_ROOM }), { content: true }));
    assert.equal(edit, 1, "a new text: computed again");
    assert.equal(chipText("alike"), "Look-alikes 5");
    const del = await countPairs(() => M.cache.removePrompt(ids[4]));
    assert.equal(del, 1, "a deleted prompt: computed again");
    assert.equal(chipText("alike"), "Look-alikes 3");
    const mark = await countPairs(() => { M.settings.set("notAlike", [M.similar.key(ids[0], ids[3])]); });
    assert.equal(mark, 1, "notAlike changed: computed again");
    assert.equal(await countPairs(() => { M.settings.set("notAlike", [M.similar.key(ids[0], ids[3])]); }), 0, "the same list: not again");
  } finally { M.list.close(); M.settings.set("notAlike", []); }
});

test("a deck works the same way (look-alikes are per collection: a pair across two books never counts)", async () => {
  const deck = await seedIn("d_la", "deck", [FERMI_ZERO, STARS]);
  await seedIn("b_la6", "book", [FERMI_ROOM]);
  try {
    M.list.open("d_la", { host: host() });
    assert.equal(chipShown("alike"), false, "its look-alike sits in another book");
    await M.cache.savePrompt(Object.assign({}, M.cache.prompt(deck[1]), { text: FERMI_ROOM }), { content: true });
    assert.equal(chipText("alike"), "Look-alikes 2");
  } finally { M.list.close(); }
});

// ---- P2.4 d: the editor ----------------------------------------------------------------------------------

test("the editor's Similar prompt line: the nearest look-alike of the same book with its page, never itself, hidden for notAlike and for notes", async () => {
  M.settings.set("notAlike", []);
  const ids = await seedIn("book_1", "book", [FERMI_ZERO, STARS, FERMI_ROOM]);
  // a new prompt in the margin of the open book
  let ed = M.margin.openEditor({ promptId: null, anchor: { pageIndex: 0, y: 20, quote: "q", prefix: "", suffix: "", pages: [], lost: false }, initialText: "" });
  assert.ok(ed, "the margin's editor");
  assert.equal(similarText(ed), null, "empty: no line");
  type(ed, qa("What is the Fermi energy of a metal at zero temperature, exactly?"));
  await sleep(DEBOUNCE);
  assert.equal(similarText(ed), "Similar prompt: “What is the Fermi energy of a metal at zero temperature?” (p. 1)");
  assert.ok(ed.el.querySelector(".editor__lint").nextSibling === similarEl(ed) || ed.el.children.indexOf(similarEl(ed)) === ed.el.children.indexOf(ed.el.querySelector(".editor__lint")) + 1, "right under the lint line");
  type(ed, "Fermi energy of a metal at zero temperature");   // a note
  await sleep(DEBOUNCE);
  assert.equal(similarText(ed), null, "a note: no line");
  type(ed, qa("Why do stars shine at night?"));
  await sleep(DEBOUNCE);
  assert.equal(similarText(ed), null, "nothing alike enough (two shared words)");
  M.margin.closeEditor({ save: false });
  await tick();

  // an existing prompt: never compared with itself; its pair in notAlike hides the line
  ed = M.margin.openEditor({ promptId: ids[0] });
  await sleep(DEBOUNCE);
  assert.equal(similarText(ed), "Similar prompt: “What is the Fermi energy of a metal at room temperature?” (p. 3)");
  M.settings.set("notAlike", [M.similar.key(ids[0], ids[2])]);
  type(ed, FERMI_ZERO + " ");
  await sleep(DEBOUNCE);
  assert.equal(similarText(ed), null, "marked Not alike");
  // it never blocks a save
  type(ed, FERMI_ROOM);
  ed.run("save");
  await tick();
  assert.equal(M.cache.prompt(ids[0]).text, FERMI_ROOM);
  M.settings.set("notAlike", []);
});

test("the editor's line in a deck has no page; the deck's batch box has none", async () => {
  const ids = await seedIn("d_la2", "deck", [FERMI_ZERO, STARS]);
  try {
    M.list.open("d_la2", { host: host() });
    menuPick(ids[1], "Edit");
    const ed = M.list.activeEditor();
    type(ed, FERMI_ROOM);
    await sleep(DEBOUNCE);
    assert.equal(similarText(ed), "Similar prompt: “What is the Fermi energy of a metal at zero temperature?”");
    ed.run("cancel");
  } finally { M.list.close(); }
  const box = doc.createElement("div");
  doc.body.appendChild(box);
  const batch = M.editor.create({ host: box, prompt: null, initialText: FERMI_ROOM, batch: true, collectionId: "d_la2" });
  assert.equal(similarEl(batch), null);
  batch.destroy();
});

// FIXES-1 FIX-8 b: "Not alike" on a row with several partners marks every pair of that row
test("FIX-8 b: “Not alike” on a row with two partners puts both pair keys in settings.notAlike; the row leaves the filter", async () => {
  M.settings.set("notAlike", []);
  const T = (w) => qa("What sets the Fermi energy of a metal " + w + "?");
  const ids = await seedIn("b_la8", "book", [T("here"), STARS, T("there"), T("anywhere")]);
  try {
    M.list.open("b_la8", { host: host() });
    click(chipEl("alike"));
    assert.deepEqual(rowIds(), [ids[0], ids[2], ids[3]]);
    assert.match(alikeLine(ids[0]), /\(\+1 more\)$/, "two partners");
    menuPick(ids[0], "Not alike");
    assert.deepEqual(M.settings.get("notAlike").slice().sort(), [M.similar.key(ids[0], ids[2]), M.similar.key(ids[0], ids[3])].sort());
    assert.deepEqual(rowIds(), [ids[2], ids[3]], "the row leaves the filter; its partners stay (they are still a pair)");
    assert.equal(chipText("alike"), "Look-alikes 2");
  } finally { M.list.close(); M.settings.set("notAlike", []); }
});
