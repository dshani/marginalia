"use strict";
// test/list-dom.test.js — M.list driven through a small fake DOM that bubbles events and moves focus like a
// browser (SPEC §3 "L" drawer, §5 delete / Undo (Z), §14 deck page, §17.2 M.list). Covers:
//   - typing in the search box filters the rows once the debounce fires (the input handler reaches search(q));
//   - a held key (ev.repeat) runs a single-shot list action once — Backspace deletes one prompt, F flags once —
//     while ↑/↓ keep repeating and focus moves to the neighbouring row after a delete;
//   - after a delete from the ⋯ menu or of the last visible row, keyboard focus stays inside the list, so Z undoes it.
// Real util / bus / keys / prompts / store (memory backend) / cache modules; M.app and M.editor are small stubs.
// Run from the project root: node --test
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// ------------------------------------------------------------------ fake DOM

class FakeEvent {
  constructor(type, init) {
    Object.assign(this, { bubbles: true }, init || {});
    this.type = type;
    this.target = null;
    this.currentTarget = null;
    this.defaultPrevented = false;
    this.propagationStopped = false;
  }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this.propagationStopped = true; }
  stopImmediatePropagation() { this.propagationStopped = true; }
}

function captureFlag(opt) { return opt === true || !!(opt && opt.capture); }

// Back-references are non-enumerable: a failing assert inspects its operands to depth 1000, and walking
// ownerDocument / parentNode from every node would expand the page without end (out of memory, not a failure).
function hidden(obj, name, value) { Object.defineProperty(obj, name, { value, writable: true, enumerable: false, configurable: true }); }

class FakeNode {
  constructor(doc, nodeType) {
    hidden(this, "ownerDocument", doc);
    hidden(this, "parentNode", null);
    hidden(this, "listeners", []);
    this.nodeType = nodeType;
    this.childNodes = [];
  }
  get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; }
  get firstChild() { return this.childNodes[0] || null; }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  appendChild(c) { return this.insertBefore(c, null); }
  insertBefore(c, ref) {
    if (c.parentNode) c.parentNode.removeChild(c);
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i < 0) this.childNodes.push(c); else this.childNodes.splice(i, 0, c);
    c.parentNode = this;
    return c;
  }
  removeChild(c) {
    const i = this.childNodes.indexOf(c);
    if (i < 0) throw new Error("removeChild: not a child");
    this.childNodes.splice(i, 1);
    c.parentNode = null;
    return c;
  }
  contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
  addEventListener(type, fn, opt) { this.listeners.push({ type, fn, capture: captureFlag(opt) }); }
  removeEventListener(type, fn, opt) {
    const capture = captureFlag(opt);
    const i = this.listeners.findIndex((l) => l.type === type && l.fn === fn && l.capture === capture);
    if (i >= 0) this.listeners.splice(i, 1);
  }
  // capture (top → parent), target (every listener), bubble (parent → top) — stopPropagation() ends it
  dispatchEvent(ev) {
    ev.target = this;
    const chain = [];
    for (let x = this.parentNode; x; x = x.parentNode) chain.push(x);
    const fire = (node, pick) => {                       // every listener of a node runs, even after stopPropagation()
      ev.currentTarget = node;
      node.listeners.filter((l) => l.type === ev.type && pick(l)).forEach((l) => l.fn.call(node, ev));
    };
    for (let i = chain.length - 1; i >= 0 && !ev.propagationStopped; i--) fire(chain[i], (l) => l.capture);
    if (!ev.propagationStopped) fire(this, () => true);
    if (ev.bubbles) for (let i = 0; i < chain.length && !ev.propagationStopped; i++) fire(chain[i], (l) => !l.capture);
    return !ev.defaultPrevented;
  }
}

class FakeText extends FakeNode {
  constructor(doc, text) { super(doc, 3); this.data = String(text); }
  get textContent() { return this.data; }
}

const FOCUSABLE_TAGS = { BUTTON: 1, INPUT: 1, SELECT: 1, TEXTAREA: 1 };

class FakeElement extends FakeNode {
  constructor(doc, tag) {
    super(doc, 1);
    this.tagName = String(tag).toUpperCase();
    this.attrs = {};
    this.className = "";
    this.style = {};
    this.value = "";
    this.disabled = false;
    this.scrollTop = 0;
    this.html = "";
    this.text = "";
  }
  get nodeName() { return this.tagName; }
  get id() { return this.attrs.id || ""; }
  set id(v) { this.attrs.id = String(v); }
  get type() { return this.attrs.type || (this.tagName === "INPUT" ? "text" : ""); }
  set type(v) { this.attrs.type = String(v); }
  get classList() {
    const el = this;
    const names = () => el.className.split(/\s+/).filter(Boolean);
    return {
      add(...cs) { const s = new Set(names()); cs.forEach((c) => s.add(c)); el.className = Array.from(s).join(" "); },
      remove(...cs) { el.className = names().filter((c) => cs.indexOf(c) < 0).join(" "); },
      toggle(c, force) {
        const has = names().indexOf(c) >= 0, want = force === undefined ? !has : !!force;
        if (want && !has) this.add(c);
        if (!want && has) this.remove(c);
        return want;
      },
      contains(c) { return names().indexOf(c) >= 0; }
    };
  }
  get textContent() { return this.childNodes.length ? this.childNodes.map((n) => n.textContent).join("") : this.text; }
  set textContent(v) { this.childNodes.slice().forEach((c) => this.removeChild(c)); this.text = String(v); this.html = ""; }
  get innerHTML() { return this.html; }
  set innerHTML(v) { this.childNodes.slice().forEach((c) => this.removeChild(c)); this.html = String(v); this.text = String(v).replace(/<[^>]*>/g, ""); }
  get isConnected() { return this.ownerDocument.contains(this); }
  setAttribute(k, v) { if (k === "class") this.className = String(v); else this.attrs[k] = String(v); }
  getAttribute(k) { if (k === "class") return this.className || null; return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
  hasAttribute(k) { return this.getAttribute(k) !== null; }
  removeAttribute(k) { delete this.attrs[k]; }
  isFocusable() {
    if (!this.isConnected || this.disabled) return false;
    return !!FOCUSABLE_TAGS[this.tagName] || this.hasAttribute("tabindex");
  }
  focus() { if (this.isFocusable()) this.ownerDocument.setFocus(this); }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.setFocus(null); }
  click() { this.dispatchEvent(new FakeEvent("click")); }
  getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  scrollIntoView() {}
  querySelectorAll(sel) {
    const m = /^([a-z]*)((?:\.[\w-]+)*)(:not\(\[disabled\]\))?$/i.exec(String(sel).trim());
    if (!m) throw new Error("fake DOM: unsupported selector " + sel);
    const tag = m[1].toUpperCase(), classes = m[2] ? m[2].split(".").filter(Boolean) : [], enabledOnly = !!m[3];
    const out = [];
    (function walk(n) {
      n.children.forEach((c) => {
        if ((!tag || c.tagName === tag) && classes.every((k) => c.classList.contains(k)) && !(enabledOnly && (c.disabled || c.hasAttribute("disabled")))) out.push(c);
        walk(c);
      });
    })(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}

class FakeDocument extends FakeNode {
  constructor() {
    super(null, 9);
    this.ownerDocument = this;
    this.documentElement = this.appendChild(new FakeElement(this, "html"));
    hidden(this, "body", this.documentElement.appendChild(new FakeElement(this, "body")));
    hidden(this, "focused", null);
  }
  createElement(tag) { return new FakeElement(this, tag); }
  createTextNode(text) { return new FakeText(this, text); }
  getElementById(id) {
    let hit = null;
    (function walk(n) { n.children.forEach((c) => { if (!hit && c.id === id) hit = c; if (!hit) walk(c); }); })(this);
    return hit;
  }
  // focus fixup: a focused element that left the document hands focus back to <body>, with no events
  get activeElement() {
    if (this.focused && !this.contains(this.focused)) this.focused = null;
    return this.focused || this.body;
  }
  setFocus(el) {
    const prev = this.activeElement, next = el && el !== this.body ? el : null;
    if ((next || this.body) === prev) return;
    this.focused = next;
    if (prev !== this.body) {
      prev.dispatchEvent(new FakeEvent("blur", { bubbles: false, relatedTarget: next }));
      prev.dispatchEvent(new FakeEvent("focusout", { relatedTarget: next }));
    }
    if (next) {
      next.dispatchEvent(new FakeEvent("focus", { bubbles: false, relatedTarget: prev === this.body ? null : prev }));
      next.dispatchEvent(new FakeEvent("focusin", { relatedTarget: prev === this.body ? null : prev }));
    }
  }
}

// ------------------------------------------------------------------ the page and the modules

const doc = new FakeDocument();
function el(tag, id, parent, attrs) {
  const e = doc.createElement(tag);
  if (id) e.id = id;
  Object.keys(attrs || {}).forEach((k) => e.setAttribute(k, attrs[k]));
  (parent || doc.body).appendChild(e);
  return e;
}
const readerEl = el("section", "reader", null, { tabindex: "-1" });
const drawer = el("div", "list", readerEl, { class: "is-hidden" });
const deckEl = el("section", "deck");

const M = globalThis.Marginalia = globalThis.Marginalia || {};
const js = (name) => path.join(__dirname, "..", "js", name + ".js");
["util", "bus", "keys", "scheduler", "prompts", "context", "store", "cache"].forEach((n) => require(js(n)));
const list = require(js("list"));
const cache = M.cache;

const app = {
  owner: "reader",
  toasts: [],
  setFocusOwner(o) { app.owner = o; return o; },
  focusOwner() { return app.owner; },
  toast(opts) { const t = { opts, closed: false, close() { t.closed = true; } }; app.toasts.push(t); return t; },
  confirm() { return Promise.resolve(true); }
};
M.app = app;

// M.editor.create → a textarea in the host (the list only needs focus / destroy and the onSave / onCancel hooks)
const editors = [];
M.editor = {
  create(opts) {
    const ta = doc.createElement("textarea");
    ta.value = opts.initialText || "";
    opts.host.appendChild(ta);
    const ed = { opts, ta, destroyed: false, sets: [], focus() { ta.focus(); }, destroy() { ed.destroyed = true; }, run() { return false; },
      setText(t) { ta.value = String(t); ed.sets.push(String(t)); } };   // sets: the texts that the host gave back
    editors.push(ed);
    return ed;
  }
};

const saved = [];
M.bus.on("prompt:saved", (e) => saved.push(e.prompt.id));

let docKeydowns = 0;                                      // keydowns that reach the document (M.app's dispatcher)
doc.addEventListener("keydown", () => { docKeydowns++; });

globalThis.document = doc;
test.after(() => { delete globalThis.document; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DEBOUNCE_WAIT = 200;                                // SEARCH_DEBOUNCE_MS is 120

function find(root, pred) {
  let hit = null;
  (function walk(n) { n.children.forEach((c) => { if (!hit && pred(c)) hit = c; if (!hit) walk(c); }); })(root);
  return hit;
}
const hasClass = (name) => (n) => n.classList.contains(name);
const rowEls = (host) => find(host, hasClass("list__rows")).children.filter(hasClass("list__row"));
const rowIds = (host) => rowEls(host).map((r) => r.getAttribute("data-id"));
const rowsBox = (host) => find(host, hasClass("list__rows"));
const searchBox = (host) => find(host, (n) => n.tagName === "INPUT");
const countText = (host) => find(host, hasClass("list__count")).textContent;
const listRoot = (host) => find(host, hasClass("list"));
const focusedId = () => doc.activeElement.getAttribute("data-id");

function press(key, opts) {
  const ev = new FakeEvent("keydown", Object.assign({ key, repeat: false, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false }, opts));
  doc.activeElement.dispatchEvent(ev);                    // a key goes to the focused element, as in a browser
  return ev;
}
// a mouse click: mousedown, focus moves to the clicked control (Chrome; Safari keeps it where it was), click
function mouseClick(node) {
  node.dispatchEvent(new FakeEvent("mousedown"));
  let f = node;
  while (f && f.nodeType === 1 && !f.isFocusable()) f = f.parentNode;
  if (f && f.nodeType === 1) f.focus();
  node.dispatchEvent(new FakeEvent("click"));
}
function typeInto(input, value) {
  input.value = value;
  input.dispatchEvent(new FakeEvent("input"));
}

let loaded = null;
async function seedBook(id, texts) {
  if (!loaded) loaded = cache.load();
  await loaded;
  await cache.saveCollection({ id, kind: "book", name: "Book " + id, pageCount: 50 });
  const ids = [];
  for (let i = 0; i < texts.length; i++) {
    const parsed = M.prompts.parse(texts[i]);
    const p = await cache.savePrompt({
      id: id + "_p" + i, collectionId: id, kind: parsed.kind, text: texts[i], tags: parsed.tags.slice(), cards: [], createdAt: 1000 + i,
      anchor: { pageIndex: i, y: 500, quote: "passage " + i, pages: [], lost: false }
    }, { content: true });
    ids.push(p.id);
  }
  return ids;
}
const isLive = (pid) => { const p = cache.prompt(pid); return !!p && (p.deletedAt === null || p.deletedAt === undefined); };

function openDrawer(collectionId) {
  readerEl.focus();
  app.owner = "reader";
  assert.equal(list.open(collectionId, { host: drawer }), true);
  assert.equal(app.owner, "list");
}

test.afterEach(() => { list.close(); });

// ------------------------------------------------------------------ search

test("typing in the search box filters the rows once the debounce fires", async () => {
  const ids = await seedBook("b_search", ["Q. What is alpha?\nA. one", "Q. What is beta?\nA. two", "Q. What is gamma?\nA. three\n#greek"]);
  openDrawer("b_search");
  const input = searchBox(drawer);
  assert.ok(doc.activeElement === input, "the drawer opens with focus in its search box");
  assert.deepEqual(rowIds(drawer), ids);

  typeInto(input, "be");
  typeInto(input, "beta");                                // a burst of keystrokes → one search after the debounce
  await sleep(DEBOUNCE_WAIT);
  assert.deepEqual(rowIds(drawer), [ids[1]]);
  assert.equal(countText(drawer), "3 prompts · 1 shown");
  assert.equal(input.value, "beta", "the typed text is kept");
  assert.ok(doc.activeElement === input, "filtering never moves focus out of the search box");

  typeInto(input, "#greek");
  await sleep(DEBOUNCE_WAIT);
  assert.deepEqual(rowIds(drawer), [ids[2]]);

  typeInto(input, "");
  await sleep(DEBOUNCE_WAIT);
  assert.deepEqual(rowIds(drawer), ids);
  assert.equal(countText(drawer), "3 prompts");
});

test("a search typed just before the list closes does not leak into the next list", async () => {
  const ids = await seedBook("b_search2", ["Q. alpha?\nA. 1", "Q. beta?\nA. 2"]);
  openDrawer("b_search2");
  typeInto(searchBox(drawer), "alpha");
  list.close();                                           // Esc / L before the debounce fires
  openDrawer("b_search2");
  await sleep(DEBOUNCE_WAIT);
  assert.equal(searchBox(drawer).value, "");
  assert.deepEqual(rowIds(drawer), ids);
});

// ------------------------------------------------------------------ held keys

test("a held Backspace deletes one prompt: repeats are swallowed and focus goes to the next row", async () => {
  const ids = await seedBook("b_hold", ["Q. a?\nA. 1", "Q. b?\nA. 2", "Q. c?\nA. 3", "Q. d?\nA. 4", "Q. e?\nA. 5"]);
  openDrawer("b_hold");
  rowEls(drawer)[1].focus();
  assert.equal(focusedId(), ids[1]);

  const before = docKeydowns;
  const first = press("Backspace");
  assert.equal(first.defaultPrevented, true);
  for (let i = 0; i < 8; i++) {
    const r = press("Backspace", { repeat: true });
    assert.equal(r.defaultPrevented, true, "a swallowed repeat keeps its default prevented");
  }
  assert.equal(docKeydowns, before, "the list keeps its keys (and their repeats) away from the document dispatcher");
  assert.deepEqual(ids.filter(isLive), [ids[0], ids[2], ids[3], ids[4]], "exactly one prompt is deleted");
  assert.deepEqual(rowIds(drawer), [ids[0], ids[2], ids[3], ids[4]]);
  assert.equal(focusedId(), ids[2], "focus goes to the row after the deleted one");
  assert.equal(rowEls(drawer)[1].getAttribute("aria-selected"), "true");

  saved.length = 0;
  press("f");
  for (let i = 0; i < 6; i++) press("f", { repeat: true });
  assert.equal(cache.prompt(ids[2]).flagged, true, "a held F flags once");
  assert.deepEqual(saved, [ids[2]], "one save for one press");
  assert.equal(focusedId(), ids[2]);

  press("ArrowDown");
  press("ArrowDown", { repeat: true });                   // ↑/↓ keep repeating
  assert.equal(focusedId(), ids[4]);
  press("ArrowUp", { repeat: true });
  assert.equal(focusedId(), ids[3]);

  rowEls(drawer)[3].focus();                              // the last row: the neighbour is the previous one
  press("Delete");
  assert.equal(isLive(ids[4]), false);
  assert.equal(focusedId(), ids[3]);
  await sleep(20);
});

test("in the search box a held Backspace still edits the text", async () => {
  const ids = await seedBook("b_hold2", ["Q. a?\nA. 1", "Q. b?\nA. 2"]);
  openDrawer("b_hold2");
  const input = searchBox(drawer);
  const r = press("Backspace", { repeat: true });
  assert.equal(r.defaultPrevented, false, "native text editing is left alone");
  assert.ok(doc.activeElement === input, "focus stays in the search box");
  assert.deepEqual(ids.filter(isLive), ids);
});

// ------------------------------------------------------------------ undo after delete

test("delete from the ⋯ menu keeps focus in the list, and Z undoes it", async () => {
  const ids = await seedBook("b_menu", ["Q. a?\nA. 1", "Q. b?\nA. 2", "Q. c?\nA. 3"]);
  openDrawer("b_menu");
  const more = find(rowEls(drawer)[1], hasClass("list__more"));
  mouseClick(more);
  const menu = find(drawer, hasClass("list__menu"));
  assert.ok(menu && menu.contains(doc.activeElement), "the menu takes focus");
  mouseClick(find(menu, (n) => n.textContent === "Delete"));
  assert.equal(isLive(ids[1]), false);
  assert.ok(find(drawer, hasClass("list__menu")) === null, "the menu is gone");
  assert.ok(listRoot(drawer).contains(doc.activeElement), "focus did not fall back to <body>");
  assert.equal(focusedId(), ids[2], "the next row has focus");
  assert.equal(app.owner, "list");

  await sleep(20);                                         // the toast and the undo id follow the store write
  assert.equal(app.toasts[app.toasts.length - 1].opts.text, "Prompt deleted · Undo (Z)");
  const z = press("z");
  assert.equal(z.defaultPrevented, true);
  assert.equal(isLive(ids[1]), true, "Z restored the prompt");
  await sleep(20);
  assert.deepEqual(rowIds(drawer), ids);
  assert.equal(focusedId(), ids[1], "the restored row has focus");
});

test("the menu's Flag returns focus to the row instead of dropping it", async () => {
  const ids = await seedBook("b_flag", ["Q. a?\nA. 1", "Q. b?\nA. 2"]);
  openDrawer("b_flag");
  mouseClick(find(rowEls(drawer)[0], hasClass("list__more")));
  const menu = find(drawer, hasClass("list__menu"));
  mouseClick(find(menu, (n) => n.textContent === "Flag"));
  assert.equal(cache.prompt(ids[0]).flagged, true);
  assert.equal(focusedId(), ids[0]);
  press("f");                                             // the list's keys work again at once
  assert.equal(cache.prompt(ids[0]).flagged, false);
  await sleep(20);
});

test("deleting the last visible row keeps focus in the list (not the search box), and Z restores it", async () => {
  const ids = await seedBook("b_last", ["Q. alpha?\nA. 1", "Q. beta?\nA. 2"]);
  openDrawer("b_last");
  const input = searchBox(drawer);
  typeInto(input, "beta");
  await sleep(DEBOUNCE_WAIT);
  assert.deepEqual(rowIds(drawer), [ids[1]]);
  press("ArrowDown");
  assert.equal(focusedId(), ids[1]);

  press("Backspace");
  assert.equal(isLive(ids[1]), false);
  assert.deepEqual(rowIds(drawer), []);
  assert.ok(find(drawer, hasClass("list__empty")), "the empty state shows");
  assert.ok(doc.activeElement !== doc.body, "focus did not fall back to <body>");
  assert.ok(doc.activeElement !== input, "…nor into the search box, where Z would type a letter");
  assert.ok(doc.activeElement === rowsBox(drawer), "the rows container holds focus while no row can");
  assert.equal(app.owner, "list");

  await sleep(20);
  press("z");
  assert.equal(isLive(ids[1]), true);
  await sleep(20);
  assert.deepEqual(rowIds(drawer), [ids[1]]);
  assert.equal(focusedId(), ids[1]);
  assert.equal(rowsBox(drawer).hasAttribute("tabindex"), false, "the container is focusable only while it holds focus");

  // the same through the ⋯ menu on the only row
  mouseClick(find(rowEls(drawer)[0], hasClass("list__more")));
  mouseClick(find(find(drawer, hasClass("list__menu")), (n) => n.textContent === "Delete"));
  assert.equal(isLive(ids[1]), false);
  assert.ok(listRoot(drawer).contains(doc.activeElement) && doc.activeElement !== input);
  await sleep(20);
  press("z");
  assert.equal(isLive(ids[1]), true);
  await sleep(20);
  assert.equal(focusedId(), ids[1]);
  press("ArrowUp");                                        // from the first row ↑ goes back to the search box
  assert.ok(doc.activeElement === input, "↑ from the first row focuses the search box");
});

test("a refresh from elsewhere leaves focus on the ✕ and in an open menu; that menu still hands focus to its row", async () => {
  const ids = await seedBook("b_refresh", ["Q. a?\nA. 1", "Q. b?\nA. 2", "Q. c?\nA. 3"]);
  openDrawer("b_refresh");
  const closeBtn = find(drawer, hasClass("list__close"));
  closeBtn.focus();
  await cache.savePrompt(cache.prompt(ids[0]), { content: true });   // e.g. the margin saved an edit: prompt:saved
  assert.ok(doc.activeElement === closeBtn, "the ✕ keeps focus through the re-render");

  mouseClick(find(rowEls(drawer)[1], hasClass("list__more")));
  const menu = find(drawer, hasClass("list__menu"));
  await cache.savePrompt(cache.prompt(ids[2]), { content: true });   // the rows re-render under the open menu
  assert.ok(menu.contains(doc.activeElement), "the open menu keeps focus");
  mouseClick(find(menu, (n) => n.textContent === "Delete"));        // its ⋯ is gone: focus goes to the new row
  assert.equal(isLive(ids[1]), false);
  assert.equal(focusedId(), ids[2]);
  await sleep(20);
  press("z");
  assert.equal(isLive(ids[1]), true);
  await sleep(20);
  assert.equal(focusedId(), ids[1]);
});

test("E edits in place once (a held E types into the editor); closing an editor whose prompt was deleted keeps focus", async () => {
  const ids = await seedBook("b_edit", ["Q. a?\nA. 1", "Q. b?\nA. 2", "Q. c?\nA. 3"]);
  openDrawer("b_edit");
  rowEls(drawer)[1].focus();
  const before = editors.length;
  press("e");
  assert.equal(editors.length, before + 1);
  const ed = editors[editors.length - 1];
  assert.ok(doc.activeElement === ed.ta, "the in-place editor has focus");
  assert.equal(app.owner, "editor");
  const r = press("e", { repeat: true });                // lands in the textarea: the editor's, not a second editor
  assert.equal(r.defaultPrevented, false);
  assert.equal(editors.length, before + 1);

  await cache.removePrompt(ids[1]);                       // deleted elsewhere (the margin) while being edited
  ed.opts.onCancel();                                     // Esc in the editor
  assert.equal(ed.destroyed, true);
  assert.deepEqual(rowIds(drawer), [ids[0], ids[2]]);
  assert.equal(focusedId(), ids[2], "focus goes to the neighbouring row, not <body>");
  assert.equal(app.owner, "list");
});

test("deck page (inline list): deleting the only prompt keeps focus and the list owner, Z restores it", async () => {
  const ids = await seedBook("b_inline", ["Q. only?\nA. 1"]);
  const host = el("div", null, deckEl, { class: "deck__list" });
  app.owner = "library";
  assert.equal(list.open("b_inline", { host }), true);
  assert.equal(app.owner, "library", "the inline list claims the owner only while it has focus");
  rowEls(host)[0].focus();
  assert.equal(app.owner, "list");
  press("Backspace");
  assert.equal(isLive(ids[0]), false);
  assert.ok(listRoot(host).contains(doc.activeElement));
  assert.equal(app.owner, "list");
  await sleep(20);
  press("z");
  assert.equal(isLive(ids[0]), true);
  await sleep(20);
  assert.equal(focusedId(), ids[0]);

  press("Backspace");                                     // again: from the emptied list ↑ still reaches the search box
  assert.equal(isLive(ids[0]), false);
  press("ArrowUp");
  assert.ok(doc.activeElement === searchBox(host), "↑ from the empty list focuses the search box");
  await sleep(20);
});

test("a deck prompt's ⋯ menu sends it to Obsidian, and reads “Update in Obsidian” once sent (BUILD-NOTES \"Obsidian\")", async () => {
  if (!loaded) loaded = cache.load();
  await loaded;
  await cache.saveCollection({ id: "d_obs", kind: "deck", name: "Deck for Obsidian" });
  const p = await cache.savePrompt({ id: "d_obs_p0", collectionId: "d_obs", kind: "qa", text: "Q. to run\nA. laufen", tags: [], cards: [], createdAt: 5, anchor: null,
    context: { docName: "Deck for Obsidian", sectionLabel: "Verbs", pageIndex: null, pageLabel: null } }, { content: true });
  const sent = [];
  const had = Object.prototype.hasOwnProperty.call(M, "obsidian"), old = M.obsidian;
  M.obsidian = { send: (id, opts) => { sent.push([id, opts]); return Promise.resolve({ ok: true }); } };
  try {
    const host = el("div", null, deckEl, { class: "deck__list" });
    assert.equal(list.open("d_obs", { host }), true);
    mouseClick(find(rowEls(host)[0], hasClass("list__more")));
    let menu = find(host, hasClass("list__menu"));
    const labels = menu.children.map((b) => b.textContent);
    assert.deepEqual(labels, ["Edit", "Split", "Flag", "Move to…", "Send to Obsidian", "Delete"]);   // Split: FEATURES P2.2
    mouseClick(find(menu, (n) => n.textContent === "Send to Obsidian"));
    assert.deepEqual(sent, [[p.id, { fromGesture: true }]]);
    assert.equal(find(host, hasClass("list__menu")), null, "the menu closed");

    await cache.savePrompt(Object.assign({}, cache.prompt(p.id), { obsidianSentAt: Date.now() }), { content: false });
    mouseClick(find(rowEls(host)[0], hasClass("list__more")));
    menu = find(host, hasClass("list__menu"));
    mouseClick(find(menu, (n) => n.textContent === "Update in Obsidian"));
    assert.deepEqual(sent[1], [p.id, { fromGesture: true }]);
  } finally {
    if (had) M.obsidian = old; else delete M.obsidian;
  }
  await sleep(20);
});

test("with the Obsidian connection off (DECISIONS D32) a row's ⋯ menu has no Obsidian item; switched on, it is back", async () => {
  if (!loaded) loaded = cache.load();
  await loaded;
  await cache.saveCollection({ id: "d_off", kind: "deck", name: "Deck without Obsidian" });
  await cache.savePrompt({ id: "d_off_p0", collectionId: "d_off", kind: "qa", text: "Q. to swim\nA. schwimmen", tags: [], cards: [], createdAt: 5, anchor: null,
    obsidianSentAt: 7, obsidianFile: "Notes/Marginalia/Deck without Obsidian.md",
    context: { docName: "Deck without Obsidian", sectionLabel: "Verbs", pageIndex: null, pageLabel: null } }, { content: true });
  const sent = [];
  let on = false;
  const had = Object.prototype.hasOwnProperty.call(M, "obsidian"), old = M.obsidian;
  M.obsidian = { enabled: () => on, send: (id, opts) => { sent.push([id, opts]); return Promise.resolve({ ok: true }); } };
  try {
    const host = el("div", null, deckEl, { class: "deck__list" });
    assert.equal(list.open("d_off", { host }), true);
    const labels = () => {
      mouseClick(find(rowEls(host)[0], hasClass("list__more")));
      const menu = find(host, hasClass("list__menu"));
      const out = menu.children.map((b) => b.textContent);
      mouseClick(find(rowEls(host)[0], hasClass("list__more")));   // close it again
      return out;
    };
    assert.deepEqual(labels(), ["Edit", "Split", "Flag", "Move to…", "Delete"], "no Send to Obsidian, no Update in Obsidian");
    on = true;
    assert.deepEqual(labels(), ["Edit", "Split", "Flag", "Move to…", "Update in Obsidian", "Delete"]);
    on = false;
    assert.deepEqual(labels(), ["Edit", "Split", "Flag", "Move to…", "Delete"]);
    assert.deepEqual(sent, []);
    // a page without M.obsidian: no item either
    delete M.obsidian;
    assert.deepEqual(labels(), ["Edit", "Split", "Flag", "Move to…", "Delete"]);
  } finally {
    if (had) M.obsidian = old; else delete M.obsidian;
  }
  await sleep(20);
});

// ------------------------------------------------------------------ one saved prompt: its own row only
// Send all to Obsidian saves every card of a book or deck, one prompt:saved each (BUILD-NOTES "Obsidian"); a whole
// re-render per save made that N·N rows. A save that keeps the prompt's place now replaces just its row.

test("a save that keeps the prompt's place replaces only its row; focus and the selection stay on it", async () => {
  const ids = await seedBook("b_row", ["Q. a?\nA. 1", "Q. b?\nA. 2", "Q. c?\nA. 3", "Q. d?\nA. 4"]);
  openDrawer("b_row");
  rowEls(drawer)[1].focus();
  assert.equal(focusedId(), ids[1]);
  const before = rowEls(drawer);
  await cache.savePrompt(Object.assign({}, cache.prompt(ids[1]), { text: "Q. b, edited?\nA. 2" }), { content: true });
  const after = rowEls(drawer);
  assert.deepEqual(rowIds(drawer), ids);
  assert.notEqual(after[1], before[1], "its row is new");
  [0, 2, 3].forEach((i) => assert.equal(after[i], before[i], "row " + i + " is left alone"));
  assert.match(find(after[1], hasClass("list__row-main")).innerHTML, /b, edited/);
  assert.equal(focusedId(), ids[1], "focus goes to its new row");
  assert.equal(after[1].getAttribute("aria-selected"), "true");
  assert.equal(after[1].getAttribute("tabindex"), "0");
  assert.equal(countText(drawer), "4 prompts");

  await cache.savePrompt(Object.assign({}, cache.prompt(ids[3]), { flagged: true }), { content: true });
  assert.equal(rowEls(drawer)[1], after[1], "a save of another row leaves the selected one alone");
  assert.equal(focusedId(), ids[1]);
  assert.ok(rowEls(drawer)[3].classList.contains("list__row--flagged"));
  assert.equal(rowEls(drawer)[3].getAttribute("aria-selected"), "false");
});

test("a save that moves the prompt to another page re-renders the rows in reading order", async () => {
  const ids = await seedBook("b_move", ["Q. a?\nA. 1", "Q. b?\nA. 2", "Q. c?\nA. 3"]);
  openDrawer("b_move");
  const p = cache.prompt(ids[0]);
  await cache.savePrompt(Object.assign({}, p, { anchor: Object.assign({}, p.anchor, { pageIndex: 9 }) }), { content: true });
  assert.deepEqual(rowIds(drawer), [ids[1], ids[2], ids[0]]);
});

test("a save the search no longer matches takes its row out, and the count says so", async () => {
  const ids = await seedBook("b_hide", ["Q. alpha?\nA. 1", "Q. beta?\nA. 2"]);
  openDrawer("b_hide");
  list.search("alpha");
  assert.deepEqual(rowIds(drawer), [ids[0]]);
  await cache.savePrompt(Object.assign({}, cache.prompt(ids[0]), { text: "Q. gamma?\nA. 1" }), { content: true });
  assert.deepEqual(rowIds(drawer), []);
  assert.equal(countText(drawer), "2 prompts · 0 shown");
});

test("a save while a row is open in the editor changes no row until the editor closes", async () => {
  const ids = await seedBook("b_edit", ["Q. a?\nA. 1", "Q. b?\nA. 2"]);
  openDrawer("b_edit");
  rowEls(drawer)[0].focus();
  press("e");
  const ed = editors[editors.length - 1];
  assert.equal(ed.opts.prompt.id, ids[0], "E opened the first row in the editor");
  const before = rowEls(drawer);
  await cache.savePrompt(Object.assign({}, cache.prompt(ids[1]), { text: "Q. b, saved meanwhile?\nA. 2" }), { content: true });
  assert.equal(rowEls(drawer)[1], before[1], "no row changes under an open editor");
  ed.opts.onCancel();
  assert.match(find(rowEls(drawer)[1], hasClass("list__row-main")).innerHTML, /saved meanwhile/, "closing the editor shows the save");
  await sleep(20);
});

// ------------------------------------------------------------------ cues (FEATURES P1.1)

test("a cloze row shows a blank's cue beside its mark, and the search finds a cue's words", async () => {
  const ids = await seedBook("b_cue", ["The {wave function::two words} is {complex}.", "Der Hund {bellt} laut."]);
  openDrawer("b_cue");
  const html = (i) => find(rowEls(drawer)[i], hasClass("list__row-main")).innerHTML;
  assert.ok(html(0).includes('</span>The <mark class="cloze-mark">wave function</mark> <span class="cloze-cue">(two words)</span> is <mark class="cloze-mark">complex</mark>.</div>'), html(0));
  assert.ok(html(1).includes('</span>Der Hund <mark class="cloze-mark">bellt</mark> laut.</div>'), "a row without a cue is as before: " + html(1));
  assert.ok(!html(1).includes("cloze-cue"));
  list.search("two words");
  assert.deepEqual(rowIds(drawer), [ids[0]]);
  list.search("");
  assert.deepEqual(rowIds(drawer), ids);
});

// ------------------------------------------------------------------ filter chips, struggling rows (FEATURES P1.3 e, P1.4 d)

const chipBar = (host) => find(host, hasClass("list__chips"));
const chip = (host, id) => find(host, (n) => n.getAttribute("data-chip") === id);
const chipText = (host, id) => chip(host, id).textContent;
const chipShown = (host, id) => !chip(host, id).classList.contains("is-hidden");
const DAY_MS = 86400000;
// A prompt last edited 10 days ago whose card was forgotten on each of `days` different days since (a schedule save:
// {content: false} keeps the contentUpdatedAt it is given).
async function missOn(pid, days) {
  const p = cache.prompt(pid), edited = Date.now() - 10 * DAY_MS, base = edited + 3600000;
  const log = [];
  for (let i = 0; i < days; i++) log.push({ at: base + i * DAY_MS, outcome: "forgot", intervalMs: 600000, dueAt: base + i * DAY_MS + 600000 });
  const card = { createdAt: p.createdAt, lastReviewedAt: base, intervalMs: 432000000, dueAt: base + 30 * DAY_MS, log };
  await cache.savePrompt(Object.assign({}, p, { contentUpdatedAt: edited, cards: [card] }), { content: false });
}
const struggleMark = (row) => { const m = /<span class="list__struggle" title="([^"]*)">struggling<\/span>/.exec(find(row, hasClass("list__row-main")).innerHTML); return m ? m[1] : null; };
async function setFlag(pid, on) { await cache.savePrompt(Object.assign({}, cache.prompt(pid), { flagged: on }), { content: true }); }

test("the chips count flagged and struggling prompts, show only while they count something, and a struggling row is marked", async () => {
  const ids = await seedBook("b_chips", ["Q. a?\nA. 1", "Q. b?\nA. 2", "Q. c?\nA. 3", "Q. d?\nA. 4", "A free note"]);
  await setFlag(ids[0], true);
  await setFlag(ids[2], true);
  await missOn(ids[1], 3);
  await missOn(ids[2], 2);                                 // two miss days: not struggling
  openDrawer("b_chips");
  assert.equal(chipBar(drawer).classList.contains("is-hidden"), false);
  assert.equal(chipText(drawer, "flagged"), "Flagged 2");
  assert.equal(chipText(drawer, "struggling"), "Struggling 1");
  assert.equal(chip(drawer, "flagged").tagName, "BUTTON");
  assert.equal(chip(drawer, "flagged").getAttribute("aria-pressed"), "false");
  const marks = rowEls(drawer).map(struggleMark);
  assert.deepEqual(marks, [null, "Forgotten on 3 days", null, null, null]);
  assert.equal(countText(drawer), "5 prompts");

  const plain = await seedBook("b_nochips", ["Q. a?\nA. 1"]);
  list.close();
  openDrawer("b_nochips");
  assert.equal(chipBar(drawer).classList.contains("is-hidden"), true, "nothing to count: no chips");
  assert.equal(chipShown(drawer, "flagged"), false);
  void plain;
});

test("a click toggles a chip; active chips combine with each other and with the search", async () => {
  const ids = await seedBook("b_and", ["Q. alpha?\nA. 1", "Q. beta?\nA. 2", "Q. alpha two?\nA. 3", "Q. gamma?\nA. 4"]);
  await setFlag(ids[0], true);
  await setFlag(ids[1], true);
  await missOn(ids[1], 3);
  await missOn(ids[2], 4);
  openDrawer("b_and");
  mouseClick(chip(drawer, "flagged"));
  assert.equal(chip(drawer, "flagged").getAttribute("aria-pressed"), "true");
  assert.ok(chip(drawer, "flagged").classList.contains("list__chip--on"));
  assert.deepEqual(list.activeChips(), ["flagged"]);
  assert.deepEqual(rowIds(drawer), [ids[0], ids[1]]);
  assert.equal(countText(drawer), "4 prompts · 2 shown");
  assert.equal(chipText(drawer, "struggling"), "Struggling 2", "a count does not depend on the other chips");
  mouseClick(chip(drawer, "struggling"));
  assert.deepEqual(rowIds(drawer), [ids[1]], "flagged AND struggling");
  mouseClick(chip(drawer, "flagged"));
  assert.deepEqual(rowIds(drawer), [ids[1], ids[2]], "struggling only");
  list.search("alpha");
  assert.deepEqual(rowIds(drawer), [ids[2]], "and the search");
  list.search("gamma");
  assert.deepEqual(rowIds(drawer), []);
  assert.equal(find(drawer, hasClass("list__empty")).textContent, "No prompts match “gamma” with the filter");
  list.search("");
  mouseClick(chip(drawer, "struggling"));
  assert.deepEqual(rowIds(drawer), ids, "every chip off: all rows");
  assert.equal(doc.activeElement, chip(drawer, "struggling"), "the clicked chip keeps focus");
});

test("the counts and the filter follow live saves; an active chip at 0 stays until it is turned off", async () => {
  const ids = await seedBook("b_live", ["Q. a?\nA. 1", "Q. b?\nA. 2"]);
  await setFlag(ids[0], true);
  await missOn(ids[1], 3);
  openDrawer("b_live");
  mouseClick(chip(drawer, "flagged"));
  assert.deepEqual(rowIds(drawer), [ids[0]]);
  await setFlag(ids[1], true);                             // a save of a row the filter hides
  assert.equal(chipText(drawer, "flagged"), "Flagged 2");
  assert.deepEqual(rowIds(drawer), [ids[0], ids[1]]);
  // FIXES-1 FIX-5: only a change of the text restarts the count (revisedAt); a flag keeps the prompt struggling
  assert.equal(chipText(drawer, "struggling"), "Struggling 1", "a flag is no change of the text: still struggling");
  assert.equal(chipShown(drawer, "struggling"), true);
  await setFlag(ids[0], false);                            // a save of a shown row that leaves the filter
  assert.deepEqual(rowIds(drawer), [ids[1]]);
  await setFlag(ids[1], false);
  assert.deepEqual(rowIds(drawer), []);
  assert.equal(chipText(drawer, "flagged"), "Flagged 0");
  assert.equal(chipShown(drawer, "flagged"), true, "active: still shown at 0");
  assert.equal(find(drawer, hasClass("list__empty")).textContent, "No prompts match the filter");
  mouseClick(chip(drawer, "flagged"));
  assert.equal(chipShown(drawer, "flagged"), false, "off at 0: hidden");
  // FIXES-1 FIX-5: the second prompt still struggles after its flag came and went, so the bar keeps "Struggling 1"
  assert.equal(chipBar(drawer).classList.contains("is-hidden"), false);
  assert.equal(chipText(drawer, "struggling"), "Struggling 1");
  assert.equal(doc.activeElement, searchBox(drawer), "focus leaves the hidden chip for the search box");
  assert.deepEqual(rowIds(drawer), ids);
});

test("a struggling row's mark goes after an edit; a chip is a Tab stop and follows the list's keys (↓ goes to the rows)", async () => {
  const ids = await seedBook("b_keys", ["Q. a?\nA. 1", "Q. b?\nA. 2"]);
  await missOn(ids[0], 3);
  openDrawer("b_keys");
  assert.equal(struggleMark(rowEls(drawer)[0]), "Forgotten on 3 days");
  chip(drawer, "struggling").focus();
  assert.equal(app.owner, "list");
  assert.equal(chip(drawer, "struggling").getAttribute("tabindex"), null, "a plain button: a Tab stop");
  assert.equal(chip(drawer, "struggling").isFocusable(), true);
  press("ArrowDown");
  assert.equal(focusedId(), ids[1], "↓ moves the selection from the pre-selected first row, as from any button");
  await cache.savePrompt(Object.assign({}, cache.prompt(ids[0]), { text: "Q. a, split?\nA. 1" }), { content: true });
  assert.equal(struggleMark(rowEls(drawer)[0]), null);
  assert.equal(chipShown(drawer, "struggling"), false);
});

// FIXES-1 FIX-2: a filter chip with the focus is no row: Backspace, Delete, F and E act on nothing
test("FIX-2: with a chip focused, Backspace and Delete delete nothing, F flags nothing, E opens no editor; on a row all still work", async () => {
  const ids = await seedBook("b_chipkeys", ["Q. a?\nA. 1", "Q. b?\nA. 2"]);
  await setFlag(ids[0], true);
  await setFlag(ids[1], true);
  openDrawer("b_chipkeys");
  mouseClick(chip(drawer, "flagged"));                    // a click focuses the chip and turns it on
  assert.equal(doc.activeElement, chip(drawer, "flagged"));
  assert.deepEqual(rowIds(drawer), ids);
  const edBefore = editors.length, docBefore = docKeydowns;
  for (const key of ["Backspace", "Delete", "f", "F", "e", "E"]) {
    const ev = press(key);
    assert.equal(ev.defaultPrevented, false, key + ": no default is taken from the chip");
  }
  await sleep(20);
  assert.equal(cache.prompt(ids[0]).deletedAt, null, "nothing deleted");
  assert.equal(cache.prompt(ids[1]).deletedAt, null);
  assert.equal(cache.prompt(ids[0]).flagged, true, "nothing unflagged");
  assert.equal(cache.prompt(ids[1]).flagged, true);
  assert.equal(editors.length, edBefore, "no editor");
  assert.equal(docKeydowns, docBefore, "and M.app's dispatcher did not see them either");
  assert.equal(doc.activeElement, chip(drawer, "flagged"), "the chip keeps the focus");
  // Space and Enter press the chip as a button (the list does not take them); Esc and the arrows keep the list's keys
  assert.equal(press(" ").defaultPrevented, false);
  // (Enter on a focused button returns early through Element.closest, which this fake DOM lacks: not checked here)
  press("ArrowDown");
  assert.equal(focusedId(), ids[1], "↓ from the chip moves the selection as before");
  // on a row: F, E and Backspace still act
  rowEls(drawer)[0].focus();
  press("f");
  await sleep(20);
  assert.equal(cache.prompt(ids[0]).flagged, false, "F on a row flags");
  rowEls(drawer)[0].focus();
  press("e");
  assert.equal(editors.length, edBefore + 1, "E on a row edits");
  editors[editors.length - 1].opts.onCancel();
  rowEls(drawer)[0].focus();
  const delId = focusedId();
  press("Backspace");
  await sleep(20);
  assert.ok(cache.prompt(delId).deletedAt, "Backspace on a row deletes");
});

// ------------------------------------------------------------------ DECISIONS D33: undo and redo

test("D33: an edit, a flag, Move to… and a delete in the list are steps of M.undo; the rows follow undo and redo", async () => {
  require(js("undo"));
  const U = M.undo;
  U.clear();
  const ids = await seedBook("b_undo", ["Q. a?\nA. 1", "Q. b?\nA. 2", "Q. c?\nA. 3"]);
  await cache.saveCollection({ id: "d_undo", kind: "deck", name: "Deck for undo" });
  openDrawer("b_undo");
  const rowText = (i) => rowEls(drawer)[i].textContent;
  try {
    // E, then the editor's save
    rowEls(drawer)[0].focus();
    press("e");
    const ed = editors[editors.length - 1];
    ed.opts.onSave("Q. a, edited?\nA. 1");
    await sleep(20);
    assert.equal(cache.prompt(ids[0]).text, "Q. a, edited?\nA. 1");
    assert.deepEqual(U.size(), { undo: 1, redo: 0 });
    assert.equal(U.peek("undo").label, "Edit");
    assert.equal((await U.undo()).ok, true);
    await sleep(20);
    assert.equal(cache.prompt(ids[0]).text, "Q. a?\nA. 1");
    assert.match(rowText(0), /a\?/);
    assert.doesNotMatch(rowText(0), /edited/, "the row shows the text from before the edit");
    assert.equal((await U.redo()).ok, true);
    await sleep(20);
    assert.match(rowText(0), /a, edited\?/);

    // F
    rowEls(drawer)[0].focus();
    press("f");
    await sleep(20);
    assert.equal(cache.prompt(ids[0]).flagged, true);
    assert.equal(U.peek("undo").label, "Flag");
    assert.equal((await U.undo()).ok, true);
    assert.equal(cache.prompt(ids[0]).flagged, false);

    // ⋯ › Move to… › the deck: the list saves a copy, so the cache still has the record as it was for the step
    const cached = cache.prompt(ids[1]);
    mouseClick(find(rowEls(drawer)[1], hasClass("list__more")));
    let menu = find(drawer, hasClass("list__menu"));
    mouseClick(find(menu, (n) => n.textContent === "Move to…"));
    menu = find(drawer, hasClass("list__menu"));
    mouseClick(find(menu, (n) => n.textContent === "Deck for undo"));
    await sleep(20);
    assert.equal(cache.prompt(ids[1]).collectionId, "d_undo");
    assert.equal(cache.prompt(ids[1]).anchor, null);
    assert.equal(cached.collectionId, "b_undo", "the record the cache held was not changed in place");
    assert.equal(cached.anchor.quote, "passage 1");
    assert.deepEqual(rowIds(drawer), [ids[0], ids[2]]);
    assert.equal(U.peek("undo").label, "Move");
    assert.equal((await U.undo()).ok, true);
    await sleep(20);
    assert.equal(cache.prompt(ids[1]).collectionId, "b_undo");
    assert.equal(cache.prompt(ids[1]).anchor.quote, "passage 1", "back in its book, at its passage");
    assert.deepEqual(rowIds(drawer), ids);

    // Backspace, then Z: the list's own undo of a delete counts as the undo of that step
    const steps = U.size().undo;
    rowEls(drawer)[2].focus();
    press("Backspace");
    await sleep(20);
    assert.equal(isLive(ids[2]), false);
    assert.equal(U.size().undo, steps + 1);
    assert.equal(U.peek("undo").label, "Delete");
    const offerZ = app.toasts[app.toasts.length - 1];
    assert.equal(offerZ.opts.text, "Prompt deleted · Undo (Z)");
    press("z");
    await sleep(20);
    assert.equal(isLive(ids[2]), true);
    assert.deepEqual(U.size(), { undo: steps, redo: 1 });
    assert.equal(offerZ.closed, true, "the prompt is back: the notice is gone");
    assert.equal((await U.redo()).ok, true);
    await sleep(20);
    assert.equal(isLive(ids[2]), false);
    assert.deepEqual(rowIds(drawer), [ids[0], ids[1]]);
    assert.equal((await U.undo()).ok, true);
    await sleep(20);
    assert.deepEqual(rowIds(drawer), ids);

    // Backspace, then Cmd+Z's undo: the list's own offer and its notice go, so Z does nothing after it
    rowEls(drawer)[2].focus();
    press("Backspace");
    await sleep(20);
    const offer = app.toasts[app.toasts.length - 1];
    assert.equal(offer.opts.text, "Prompt deleted · Undo (Z)");
    assert.equal(offer.closed, false);
    assert.equal((await U.undo()).ok, true);
    await sleep(20);
    assert.equal(isLive(ids[2]), true);
    assert.equal(offer.closed, true, "“Prompt deleted · Undo (Z)” is gone with the delete");
    assert.equal(list.undoLast(), false, "no delete is on offer any more");
    assert.deepEqual(rowIds(drawer), ids);
  } finally { U.clear(); }
});

test("D33: the second half of a Split is a new prompt, a step of its own", async () => {
  require(js("undo"));
  const U = M.undo;
  U.clear();
  const ids = await seedBook("b_undo_split", ["Q. one and two?\nA. 1 and 2"]);
  openDrawer("b_undo_split");
  try {
    mouseClick(find(rowEls(drawer)[0], hasClass("list__more")));
    mouseClick(find(find(drawer, hasClass("list__menu")), (n) => n.textContent === "Split"));
    editors[editors.length - 1].opts.onSave("Q. one?\nA. 1");
    await sleep(20);
    assert.equal(cache.prompt(ids[0]).text, "Q. one?\nA. 1");
    editors[editors.length - 1].opts.onSave("Q. two?\nA. 2");       // the second editor: a new prompt
    await sleep(20);
    const second = cache.promptsOf("b_undo_split").find((p) => p.text === "Q. two?\nA. 2");
    assert.ok(second);
    assert.deepEqual(U.size(), { undo: 2, redo: 0 });
    assert.equal(U.peek("undo").label, "New prompt");
    assert.equal((await U.undo()).ok, true);
    assert.equal(isLive(second.id), false, "the new half is gone");
    assert.equal(cache.prompt(ids[0]).text, "Q. one?\nA. 1", "the first half keeps its edit");
    assert.equal(U.peek("undo").label, "Edit");
    assert.equal((await U.undo()).ok, true);
    assert.equal(cache.prompt(ids[0]).text, "Q. one and two?\nA. 1 and 2", "and a second undo brings the whole prompt back");
  } finally { U.clear(); }
});

test("D33: a prompt whose row editor is open is not changed under it, also when another row has the focus; the editor's save starts from the record as it is now", async () => {
  require(js("undo"));
  const U = M.undo;
  U.clear();
  const ids = await seedBook("b_undo_open", ["Q. a?\nA. 1", "Q. b?\nA. 2"]);
  openDrawer("b_undo_open");
  try {
    rowEls(drawer)[0].focus();
    press("f");                                             // the newest step: a flag on row 0
    await sleep(20);
    assert.equal(cache.prompt(ids[0]).flagged, true);
    press("e");                                             // its editor opens
    const ed = editors[editors.length - 1];
    assert.equal(list.editingId(), ids[0]);
    rowEls(drawer)[1].focus();                              // the person clicks the other row: the editor stays open
    assert.equal(list.editingId(), ids[0]);
    app.toasts.length = 0;
    const r = await U.undo();
    assert.deepEqual({ ok: r.ok, reason: r.reason }, { ok: false, reason: "editor" });
    assert.equal(cache.prompt(ids[0]).flagged, true, "nothing changed under the editor");
    assert.deepEqual(U.size(), { undo: 1, redo: 0 });
    assert.equal(app.toasts[app.toasts.length - 1].opts.text, "Save or cancel the editor of that card first.");

    // meanwhile the record changes by another way (a send record, in place; an answer in a review, as a new record)
    await cache.patchPrompts([{ id: ids[0], fields: { obsidianSentAt: 123 } }]);
    const answered = Object.assign({}, cache.prompt(ids[0]), { cards: [{ i: 0, createdAt: 1, lastReviewedAt: 5, intervalMs: 9, dueAt: 14, log: [{ at: 5, outcome: "remembered" }] }] });
    await cache.savePrompt(answered, { content: false });
    ed.opts.onSave("Q. a, edited?\nA. 1");
    await sleep(20);
    const saved = cache.prompt(ids[0]);
    assert.equal(saved.text, "Q. a, edited?\nA. 1");
    assert.equal(saved.flagged, true);
    assert.equal(saved.obsidianSentAt, 123);
    assert.equal(saved.cards.length, 1);
    assert.equal(saved.cards[0].lastReviewedAt, 5, "the answer that came while the editor was open is kept");
    assert.equal(list.editingId(), null);
  } finally { U.clear(); }
});

test("D33: a prompt that was deleted while its row editor was open comes back with the text that the person saves, as one step", async () => {
  require(js("undo"));
  const U = M.undo;
  U.clear();
  const ids = await seedBook("b_undo_gone", ["Q. a?\nA. 1", "Q. b?\nA. 2"]);
  openDrawer("b_undo_gone");
  const heard = [], off = [M.bus.on("prompt:restored", (e) => heard.push("restored " + e.promptId)), M.bus.on("prompt:saved", (e) => heard.push("saved " + e.prompt.id))];
  try {
    rowEls(drawer)[0].focus();
    press("e");
    const ed = editors[editors.length - 1];
    await cache.removePrompt(ids[0]);                       // another window deleted it (no step of this page)
    assert.equal(isLive(ids[0]), false);
    const stamp = cache.prompt(ids[0]).contentUpdatedAt;
    await sleep(5);
    heard.length = 0;
    ed.opts.onSave("Q. my new words?\nA. 1");
    await sleep(20);
    assert.equal(isLive(ids[0]), true, "the text is not written into a deleted record, where nobody sees it");
    assert.equal(cache.prompt(ids[0]).text, "Q. my new words?\nA. 1");
    assert.deepEqual(heard, ["restored " + ids[0], "saved " + ids[0]], "it comes back as a restore, then the save");
    assert.ok(cache.prompt(ids[0]).contentUpdatedAt > stamp, "and it outranks its deleted record in an import merge");
    assert.deepEqual(rowIds(drawer), ids);
    assert.equal(list.editingId(), null, "the editor closed");
    assert.deepEqual(ed.sets, [], "a save that worked gives no text back to the editor");
    assert.deepEqual(U.size(), { undo: 1, redo: 0 }, "the restore and the save are ONE step");
    assert.equal(U.peek("undo").label, "Restore");
    assert.equal((await U.undo()).ok, true);
    assert.equal(isLive(ids[0]), false, "undo: the prompt is as it was before the save, deleted");
    assert.equal(cache.prompt(ids[0]).text, "Q. a?\nA. 1");
    assert.equal((await U.redo()).ok, true);
    assert.equal(cache.prompt(ids[0]).text, "Q. my new words?\nA. 1");

    // saved with the text as it was: the prompt comes back all the same (a restore alone)
    U.clear();
    rowEls(drawer)[1].focus();
    press("e");
    const ed2 = editors[editors.length - 1];
    await cache.removePrompt(ids[1]);
    ed2.opts.onSave("Q. b?\nA. 2");
    await sleep(20);
    assert.equal(isLive(ids[1]), true);
    assert.deepEqual(U.size(), { undo: 1, redo: 0 });
  } finally { U.clear(); off.forEach((f) => f()); }
});

test("D33: a save never brings a prompt back into a book that is deleted: nothing is saved, and the editor keeps the text", async () => {
  require(js("undo"));
  const U = M.undo;
  U.clear();
  const ids = await seedBook("b_undo_nobook", ["Q. a?\nA. 1"]);
  openDrawer("b_undo_nobook");
  try {
    rowEls(drawer)[0].focus();
    press("e");
    const ed = editors[editors.length - 1];
    await cache.removeCollection("b_undo_nobook");          // another window deleted the whole book
    assert.equal(isLive(ids[0]), false);
    assert.equal(list.editingId(), ids[0], "the editor is still open");
    const before = JSON.stringify(cache.prompt(ids[0]));
    app.toasts.length = 0;
    ed.opts.onSave("Q. words that must not get lost?\nA. 1");
    await sleep(20);
    assert.equal(JSON.stringify(cache.prompt(ids[0])), before, "nothing was written");
    assert.equal(isLive(ids[0]), false);
    assert.equal(list.editingId(), ids[0], "the editor stays open with the text");
    assert.equal(ed.destroyed, false);
    // the editor dropped its draft for this save: it takes the text back, so it keeps a draft of it again
    assert.deepEqual(ed.sets, ["Q. words that must not get lost?\nA. 1"]);
    assert.equal(ed.ta.value, "Q. words that must not get lost?\nA. 1");
    assert.equal(app.toasts[app.toasts.length - 1].opts.text, "Not saved: the book or deck of this prompt is deleted. Copy your text before you close the editor.");
    assert.deepEqual(U.size(), { undo: 0, redo: 0 });
  } finally { U.clear(); }
});
