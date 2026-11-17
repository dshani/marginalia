"use strict";
// test/obsidian.test.js — M.obsidian and M.markup.toObsidian (BUILD-NOTES "Obsidian"): file names and paths, the block
// layout (heading, quote, body, link and date), cloze → ==x==, math delimiters, both image modes, the obsidian:// URIs
// ("/" → %2F, " " → %20), the 60 000-character limit, the injectable opener, detect() and send() in both modes; and
// the fixes of 2026-11-07: a re-send goes to the note the prompt's copy lives in (after a rename, a folder change or a
// move), an older serve.py is told apart (detect's outdated, "marginalia restart"), a cached "link" is checked again
// on a 127.0.0.1 / localhost page, the link toast's word on earlier copies, "Copy note" with "[image]" after a failed
// server write and again after a refused copy, the quote escaped out of Obsidian syntax, vault names kept as listed.
// A send whose answer never came (no answer, or a 200 whose body never came) may have written the note: the prompt
// remembers that note (obsidianPendingFile), and its next send goes there, also after a rename, never a second copy.
// FEATURES A9: that marker is written ahead, before the request leaves (through M.cache.patchPrompts; e.patches lists
// every change), and its answer settles it (written: the send record; a 4xx JSON refusal: put back; a 5xx, no answer, a
// cut body: kept); a card with it never goes through an obsidian:// link (no link, no copy, the toast says why).
// Repairs of the A9 review (2026-11-10): a send that left no telling says "May already be in Obsidian" and offers
// nothing to copy, nor does any failure of a card with the marker (D2); a tab that steps aside while a link send checks
// the server opens no link (D6).
// Nothing here opens a URI or touches a vault: the opener and fetch are stubs. Run from the app folder: node --test
const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const M = globalThis.Marginalia = globalThis.Marginalia || {};
const JS = path.join(__dirname, "..", "js");
require(path.join(JS, "util.js"));
require(path.join(JS, "scheduler.js"));
require(path.join(JS, "prompts.js"));
const markup = require(path.join(JS, "markup.js"));
require(path.join(JS, "exporter.js"));
const O = require(path.join(JS, "obsidian.js"));

const NOW = new Date(2026, 10, 6, 15, 30).getTime();        // local 2026-11-06
const BOOK = { id: "92b1cb87", kind: "book", name: "Griffiths", sections: [], deletedAt: null };
const DECK = { id: "deck_1", kind: "deck", name: "Thermo formulas", sections: [], deletedAt: null };
const LOCAL = { now: NOW, origin: "http://127.0.0.1:8765", hostname: "127.0.0.1" };
function prompt(over) {
  return Object.assign({
    id: "p_1", collectionId: BOOK.id, kind: "qa", text: "Q. What does V stand for?\nA. The potential", tags: [], flagged: false,
    anchor: { pageIndex: 11, pages: [{ pageIndex: 11, rects: [[72, 640, 300, 652]] }], quote: "a potential energy function", y: 652, lost: false },
    context: { docName: "Griffiths", sectionLabel: "Ch. 1 · The Wave Function", pageIndex: 11, pageLabel: "12" },
    cards: [], createdAt: 1, contentUpdatedAt: 1, updatedAt: 1, deletedAt: null, v: 1
  }, over || {});
}

// ------------------------------------------------------------------ file names and paths

describe("fileName / notePath", () => {
  test("drops \\ / : * ? \" < > | # ^ [ ] and control characters, collapses whitespace, trims spaces and dots", () => {
    assert.equal(O.fileName("Griffiths: Quantum Mechanics"), "Griffiths Quantum Mechanics");
    assert.equal(O.fileName(" a/b\\c*d?e\"f<g>h|i#j^k[l]m "), "abcdefghijklm");
    assert.equal(O.fileName("Tab\tand\nnew   line"), "Tab and new line");
    assert.equal(O.fileName("\u0007bell\u007f"), "bell");
    assert.equal(O.fileName("  ...Leading and trailing...  "), "Leading and trailing");
    assert.equal(O.fileName("Wait... what"), "Wait… what", "a run of dots inside never reads as ..");
  });
  test("is at most 120 characters and Untitled when nothing is left", () => {
    assert.equal(O.fileName(""), "Untitled");
    assert.equal(O.fileName(" / : # "), "Untitled");
    assert.equal(O.fileName(null), "Untitled");
    const long = O.fileName("x".repeat(119) + " yyy");
    assert.equal(long, "x".repeat(119), "cut to 120, then the trailing space trimmed");
    assert.equal(Array.from(O.fileName("😀".repeat(130))).length, 120, "characters, not UTF-16 units");
  });
  test("notePath joins the cleaned folder and the name", () => {
    assert.equal(O.notePath("Notes/Marginalia", "Griffiths"), "Notes/Marginalia/Griffiths.md");
    assert.equal(O.notePath("", "Griffiths"), "Griffiths.md");
    assert.equal(O.notePath("/Notes//Deep/", "B"), "Notes/Deep/B.md");
    assert.equal(O.notePath("../x/./y", "B"), "x/y/B.md", "no .. or . segment survives");
    assert.equal(O.notePath("Notes\\Win", "B"), "Notes/Win/B.md");
    assert.equal(O.notePath("A:B/C", "b:c"), "AB/C/bc.md");
  });
});

// ------------------------------------------------------------------ M.markup.toObsidian

describe("markup.toObsidian", () => {
  test("Q./A. lines and the #tags line stay as typed; \\(…\\) → $…$", () => {
    assert.equal(markup.toObsidian("Q. What is $x$?\nA. \\( y \\)\n#qm #physics"), "Q. What is $x$?\nA. $y$\n#qm #physics");
  });
  test("cloze deletions {x} → ==x==, math inside a deletion stays math, \\{ stays literal", () => {
    assert.equal(markup.toObsidian("The {wave function} $\\Psi(x,t)$ solves {the $x^2$ term}."),
      "The ==wave function== $\\Psi(x,t)$ solves ==the $x^2$ term==.");
    assert.equal(markup.toObsidian("a \\{b\\} {c}"), "a \\{b\\} ==c==");
    assert.equal(markup.toObsidian("$\\frac{a}{b}$ is {half}"), "$\\frac{a}{b}$ is ==half==", "braces in math never cloze");
    assert.equal(markup.toObsidian("a { b } c"), "a  ==b==  c", "whitespace inside the braces moves outside the ==");
  });
  test("braces are literal outside a cloze prompt", () => {
    assert.equal(markup.toObsidian("Q. Why {x}?\nA. y"), "Q. Why {x}?\nA. y");
    assert.equal(markup.toObsidian("Q. only a question {x}"), "Q. only a question {x}");
  });
  test("\\[…\\] → $$…$$ (math tokens only); $ and $$ unchanged; \\$ kept", () => {
    assert.equal(markup.toObsidian("\\[ E = mc^2 \\] and \\(a\\)"), "$$ E = mc^2 $$ and $a$");
    assert.equal(markup.toObsidian("$$\\int f$$ costs \\$5 and $x$"), "$$\\int f$$ costs \\$5 and $x$");
    assert.equal(markup.toObsidian("not math: \\\\[x\\\\]"), "not math: \\\\[x\\\\]");
  });
  test("image tokens: ![[marginalia-<id>.png]] with images, else [image]", () => {
    const t = "Q. ![snip](att:a_1)\nA. see";
    assert.equal(markup.toObsidian(t, { images: true }), "Q. ![[marginalia-a_1.png]]\nA. see");
    assert.equal(markup.toObsidian(t, { images: false }), "Q. [image]\nA. see");
    assert.equal(markup.toObsidian(t), "Q. [image]\nA. see");
    assert.equal(markup.toObsidian(t, { images: (id) => (id === "a_1" ? "marginalia-a_1.jpg" : null) }), "Q. ![[marginalia-a_1.jpg]]\nA. see");
    assert.equal(markup.toObsidian(t, { images: () => null }), "Q. [image]\nA. see");
  });
  test("empty text is empty", () => {
    assert.equal(markup.toObsidian(""), "");
    assert.equal(markup.toObsidian(null), "");
  });
});

// ------------------------------------------------------------------ blocks

describe("blockFor", () => {
  test("book prompt: marker, heading with section and page, quote, body, link and date, end marker", () => {
    assert.equal(O.blockFor(prompt(), BOOK, LOCAL), [
      "<!-- marginalia:p_1 -->",
      "### Ch. 1 · The Wave Function · p. 12",
      "> a potential energy function",
      "",
      "Q. What does V stand for?\nA. The potential",
      "",
      "[Open in Marginalia](http://127.0.0.1:8765/#reader/92b1cb87/p_1) · 2026-11-06",
      "<!-- /marginalia -->"
    ].join("\n"));
  });
  test("no quote: the quote is left out; no section: the page alone", () => {
    const p = prompt({ anchor: { pageIndex: 3, pages: [], quote: "", y: 400 }, context: { docName: "Griffiths", sectionLabel: null, pageIndex: 3, pageLabel: "iv" }, text: "A free note" });
    assert.equal(O.blockFor(p, BOOK, LOCAL), [
      "<!-- marginalia:p_1 -->", "### p. iv", "", "A free note", "",
      "[Open in Marginalia](http://127.0.0.1:8765/#reader/92b1cb87/p_1) · 2026-11-06", "<!-- /marginalia -->"
    ].join("\n"));
  });
  test("every line of a multi-line quote is prefixed", () => {
    const p = prompt({ anchor: { pageIndex: 1, pages: [], quote: "end of page one\nstart of page two", y: 10 } });
    assert.match(O.blockFor(p, BOOK, LOCAL), /\n> end of page one\n> start of page two\n\n/);
  });
  test("away from localhost the link is left out: just the date", () => {
    const b = O.blockFor(prompt(), BOOK, { now: NOW, origin: "https://claude.ai", hostname: "claude.ai" });
    assert.ok(b.endsWith("\n\n2026-11-06\n<!-- /marginalia -->"), b);
    assert.ok(!b.includes("Open in Marginalia"));
    assert.ok(O.blockFor(prompt(), BOOK, { now: NOW, origin: "http://localhost:8791", hostname: "localhost" })
      .includes("[Open in Marginalia](http://localhost:8791/#reader/92b1cb87/p_1)"));
  });
  test("deck prompt: its section, else the deck name; no page", () => {
    const p = prompt({ collectionId: DECK.id, anchor: null, context: { docName: DECK.name, sectionLabel: "Verbs", pageIndex: null, pageLabel: null } });
    assert.match(O.blockFor(p, DECK, LOCAL), /^<!-- marginalia:p_1 -->\n### Verbs\n\nQ\./);
    const q = prompt({ collectionId: DECK.id, anchor: null, context: { docName: DECK.name, sectionLabel: null } });
    assert.match(O.blockFor(q, DECK, LOCAL), /^<!-- marginalia:p_1 -->\n### Thermo formulas\n\nQ\./);
  });
  test("a highlight (empty text) sends only its heading and quote (with the link line)", () => {
    const p = prompt({ kind: "highlight", text: "" });
    assert.equal(O.blockFor(p, BOOK, LOCAL), [
      "<!-- marginalia:p_1 -->", "### Ch. 1 · The Wave Function · p. 12", "> a potential energy function", "",
      "[Open in Marginalia](http://127.0.0.1:8765/#reader/92b1cb87/p_1) · 2026-11-06", "<!-- /marginalia -->"
    ].join("\n"));
  });
  test("cloze body, math and images through M.markup.toObsidian", () => {
    const p = prompt({ kind: "cloze", text: "The {wave function} \\(\\Psi\\) and ![snip](att:a_1)\n#qm" });
    assert.match(O.blockFor(p, BOOK, Object.assign({ images: true }, LOCAL)), /\n\nThe ==wave function== \$\\Psi\$ and !\[\[marginalia-a_1\.png\]\]\n#qm\n\n/);
    assert.match(O.blockFor(p, BOOK, Object.assign({ images: false }, LOCAL)), /\n\nThe ==wave function== \$\\Psi\$ and \[image\]\n#qm\n\n/);
  });
  test("typed text can never close or open a block", () => {
    const p = prompt({ text: "a\n<!-- /marginalia -->\n<!-- marginalia:p_2 -->" });
    const b = O.blockFor(p, BOOK, LOCAL);
    assert.equal(b.split("\n").filter((l) => l === "<!-- /marginalia -->").length, 1);
    assert.equal(b.split("\n").filter((l) => /^<!-- marginalia:/.test(l)).length, 1);
    assert.ok(b.includes("&lt;!-- /marginalia -->") && b.includes("&lt;!-- marginalia:p_2 -->"));
    assertFindable(b, "p_1");
  });
  test("a body line that reads as the date line is escaped (outside code fences only); an open fence is closed", () => {
    const p = prompt({ kind: "note", text: "Seen on\n2026-11-01\n[Open in Marginalia](x) · 2026-11-02\n```\n2026-01-01\n```\n~~~js\ncode" });
    const b = O.blockFor(p, BOOK, LOCAL);
    assert.ok(b.includes("\nSeen on\n2026\\-11-01\n[Open in Marginalia](x) · 2026\\-11-02\n"), b);
    assert.ok(b.includes("\n```\n2026-01-01\n```\n"), "inside a fence the line is code, left as typed");
    assert.ok(b.includes("\n~~~js\ncode\n~~~\n\n[Open in Marginalia]"), "the fence the text left open is closed: " + b);
    assertFindable(b, "p_1");
    assertFindable(O.blockFor(prompt({ text: "````\nfour ``` inside\n```" }), BOOK, LOCAL), "p_1");
  });
  test("a body line that starts with the block's own link and a date is escaped too, fenced or not (serve.py: 400)", () => {
    // what pasting the block's last line back from Obsidian gives; serve.py reads such a line as the block's date line
    const own = "[Open in Marginalia](http://127.0.0.1:8765/#reader/92b1cb87/p_1) · 2026-11-05";
    const esc = own.replace("2026-11-05", "2026\\-11-05");
    const other = "[Open in Marginalia](http://127.0.0.1:8765/#reader/92b1cb87/p_2) · 2026-11-05 see p_2";
    const p = prompt({ kind: "note", text: [own + " copied from Obsidian", "  " + own, "```", own, "```", other, "- " + own].join("\n") });
    const b = O.blockFor(p, BOOK, LOCAL);
    assert.ok(b.includes("\n" + esc + " copied from Obsidian\n  " + esc + "\n```\n" + esc + "\n```\n" + other + "\n- " + own + "\n"), b);
    assert.ok(b.endsWith("\n[Open in Marginalia](http://127.0.0.1:8765/#reader/92b1cb87/p_1) · 2026-11-06\n<!-- /marginalia -->"));
    assertFindable(b, "p_1");
    assertFindable(O.blockFor(prompt({ text: own }), BOOK, LOCAL), "p_1");
  });
  test("a long run of spaces after <!-- takes linear time (serve.py's marker pattern), with the same result", () => {
    const t = process.hrtime.bigint();
    const b = O.blockFor(prompt({ kind: "note", text: "Q. x <!--" + " ".repeat(40000) }), BOOK, LOCAL);
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    assert.ok(ms < 1000, "took " + ms + " ms (seconds with two \\s* around an optional /)");
    assert.ok(b.includes("\n\nQ. x <!--\n\n"), "no marker, so left as typed (trailing spaces trimmed)");
    assert.ok(O.blockFor(prompt({ text: "a <!--  /  MARGINALIA b <!--marginalia" }), BOOK, LOCAL).includes("\na &lt;!--  /  MARGINALIA b &lt;!--marginalia\n"));
  });
  test("a quote cut inside a surrogate pair (pdf.js keeps math letters such as 𝑥) becomes well-formed text", () => {
    const cut = ("a".repeat(499) + "\u{1D465} more").slice(0, 500);        // ends in a lone \ud835
    assert.ok(/[\ud800-\udbff]$/.test(cut));
    const p = prompt({ anchor: Object.assign({}, prompt().anchor, { quote: cut }), text: "x \udc00 y" });
    const check = () => {
      const b = O.blockFor(p, BOOK, LOCAL);
      assert.equal(lone(b), false, "no lone surrogate is left");
      assert.ok(b.includes("> " + "a".repeat(499) + "\ufffd\n"), "the cut half becomes U+FFFD");
      assert.ok(b.includes("\nx \ufffd y\n"));
      assert.ok(O.blockFor(prompt({ text: "😀 𝑥" }), BOOK, LOCAL).includes("\n😀 𝑥\n"), "pairs stay as they are");
      assert.doesNotThrow(() => encodeURIComponent(b));
    };
    check();
    const own = String.prototype.toWellFormed;                // the same without it (Safari before 16.4)
    delete String.prototype.toWellFormed;
    try { check(); } finally { if (own) String.prototype.toWellFormed = own; }
  });
});

// The rules tools/serve.py's find_block() and check_block() apply to a block, for the blocks blockFor writes: one start
// line, one end line, no other marker-like line, and exactly one date line outside code fences, right before the end;
// that date line is the block's own (its own "Open in Marginalia" link, or the date alone), and no other line, fenced
// or not, starts with the block's own link and a date (serve.py's own_link_re), else the POST is a 400.
function lone(s) { return /[\ud800-\udfff]/.test(String(s).replace(/[\ud800-\udbff][\udc00-\udfff]/g, "")); }
function ownLinkRe(id) { return new RegExp("^\\s*\\[Open in Marginalia\\]\\([^)\\r\\n]*#reader/[^/)\\r\\n]*/" + id + "\\) · \\d{4}-\\d{2}-\\d{2}"); }
function assertFindable(b, id) {
  const own = ownLinkRe(id), all = b.split("\n"), last = all[all.length - 2];
  assert.ok(!last.startsWith("[Open in Marginalia](") || own.test(last), "the date line links to its own block: " + b);
  assert.deepEqual(all.map((l, k) => (own.test(l) ? k : -1)).filter((k) => k >= 0), own.test(last) ? [all.length - 2] : [],
    "no line but the date line starts with the block's own link: " + b);
  const lines = b.split("\n");
  assert.equal(lines[0], "<!-- marginalia:" + id + " -->");
  assert.equal(lines[lines.length - 1], "<!-- /marginalia -->");
  assert.ok(lines.slice(1, -1).every((l) => !/<!--\s*\/?\s*marginalia/i.test(l)), "no marker-like line inside: " + b);
  let fence = null;
  const dates = [];
  lines.forEach((l, k) => {
    if (fence) {
      const c = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(l);
      if (c && c[1][0] === fence[0] && c[1].length >= fence.length) fence = null;
      return;
    }
    const o = /^ {0,3}(`{3,}|~{3,})([^\n]*)$/.exec(l);
    if (o && !(o[1][0] === "`" && o[2].includes("`"))) { fence = o[1]; return; }
    if (/^(\[Open in Marginalia\]\([^)\r\n]*\) · )?\d{4}-\d{2}-\d{2}[ \t]*$/.test(l)) dates.push(k);
  });
  assert.equal(fence, null, "no code fence is left open: " + b);
  assert.deepEqual(dates, [lines.length - 2], "one date line, right before the end marker: " + b);
}

// ------------------------------------------------------------------ URIs

describe("uriFor / openUriFor", () => {
  test("percent-encodes every value (/ → %2F, space → %20) and drops .md", () => {
    assert.equal(O.uriFor("Obsidian Vault", "Notes/Marginalia/My Book.md", "Line 1\nLine 2 & more"),
      "obsidian://new?vault=Obsidian%20Vault&file=Notes%2FMarginalia%2FMy%20Book&content=Line%201%0ALine%202%20%26%20more&append=true&silent");
    assert.equal(O.openUriFor("Obsidian Vault", "Notes/Marginalia/My Book.md"), "obsidian://open?vault=Obsidian%20Vault&file=Notes%2FMarginalia%2FMy%20Book");
  });
  test("no vault name: the parameter is left out (Obsidian uses the vault it has open)", () => {
    assert.equal(O.uriFor("", "B.md", "x"), "obsidian://new?file=B&content=x&append=true&silent");
    assert.equal(O.openUriFor("  ", "B.md"), "obsidian://open?file=B");
  });
  test("a lone surrogate anywhere never makes them throw (encodeURIComponent would): it is sent as U+FFFD", () => {
    assert.equal(O.uriFor("V\ud800", "N/a\udc00.md", "x\ud835"), "obsidian://new?vault=V%EF%BF%BD&file=N%2Fa%EF%BF%BD&content=x%EF%BF%BD&append=true&silent");
    assert.equal(O.openUriFor("V", "a\ud835.md"), "obsidian://open?vault=V&file=a%EF%BF%BD");
    assert.equal(O.fileName("Book \ud835"), "Book \ufffd");
  });
});

// ------------------------------------------------------------------ detect and send (stubbed app, cache, fetch, opener)

function env(opts) {
  opts = opts || {};
  // obsidian: true = the connection is switched on (DECISIONS D32); a test of the switch passes its own value
  const values = Object.assign({ obsidian: true, obsidianVault: "", obsidianFolder: "Notes/Marginalia" }, opts.settings || {});
  const prompts = new Map(), cols = new Map([[BOOK.id, BOOK], [DECK.id, DECK]]);
  // the cache's own records (patchPrompts changes them in place, as js/cache.js does)
  (opts.prompts || [prompt()]).forEach((p) => prompts.set(p.id, Object.assign({}, p)));
  const e = { toasts: [], opened: [], saves: [], patches: [], writes: 0, fetches: [], copied: [], values, prompts, cols };
  const host = opts.hostname || "127.0.0.1";
  globalThis.location = { protocol: opts.protocol || "http:", origin: "http://" + host + ":8765", hostname: host };
  // node 23 has a read-only global navigator: define our own over it (afterEach deletes it again); opts.refuse: the
  // clipboard refuses that many writes (no document here, so the execCommand fallback cannot copy either)
  let refusals = opts.refuse || 0;
  Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true,
    value: { clipboard: { writeText: (t) => {
      if (refusals > 0) { refusals--; return Promise.reject(new Error("NotAllowedError")); }
      e.copied.push(t); return Promise.resolve();
    } } } });
  M.app = { toast: (o) => { e.toasts.push(o); return { close() {} }; }, isArtifact: () => !!opts.artifact };
  M.settings = { get: (k) => values[k] };
  M.cache = {
    prompt: (id) => prompts.get(id) || null,
    prompts: () => Array.from(prompts.values()),
    collection: (id) => cols.get(id) || null,
    savePrompt: (p, o) => { e.saves.push({ p, o }); prompts.set(p.id, p); return Promise.resolve(p); },
    // as js/cache.js: the fields in place (undefined removes one), one store write per call, no event; e.patches lists
    // every change, e.writes counts the calls (opts.noPatch: a cache without it, so one savePrompt per record)
    patchPrompts: opts.noPatch ? undefined : (changes) => {
      e.writes++;
      changes.forEach((c) => {
        const p = prompts.get(c.id);
        if (!p) return;
        e.patches.push({ id: c.id, fields: Object.assign({}, c.fields) });
        Object.keys(c.fields).forEach((k) => { if (c.fields[k] === undefined) delete p[k]; else p[k] = c.fields[k]; });
      });
      return Promise.resolve(changes.length);
    }
  };
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  M.store = { attachments: { get: (id) => Promise.resolve(id === "a_1" ? { id, mime: "image/png", bytes: PNG.buffer } : null) } };
  O._reset();
  O._setOpener((uri) => { e.opened.push(uri); });
  O._setFetch((url, init) => {
    e.fetches.push({ url, init });
    const reply = opts.fetch ? opts.fetch(url, init, e) : { status: 404, body: {} };
    if (reply && typeof reply.then === "function") return reply;
    if (reply instanceof Error) return Promise.reject(reply);
    return Promise.resolve({ ok: reply.status >= 200 && reply.status < 300, status: reply.status, json: () => Promise.resolve(reply.body) });
  });
  return e;
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const ONE_VAULT = { status: 200, body: { vaults: [{ id: "v1", name: "Test Vault", open: true, attachmentFolder: "Attachments" }] } };
function server(noteReply) {
  return (url, init) => (url === "/api/obsidian/vaults" ? ONE_VAULT : (typeof noteReply === "function" ? noteReply(url, init) : noteReply));
}

describe("detect", () => {
  afterEach(() => { O._reset(); delete globalThis.location; delete globalThis.navigator; });
  test("server mode when GET /api/obsidian/vaults lists a vault; cached until forced", async () => {
    const e = env({ fetch: server({ status: 500, body: {} }) });
    const d = await O.detect();
    assert.equal(d.mode, "server");
    assert.deepEqual(d.vaults.map((v) => v.name), ["Test Vault"]);
    assert.equal(e.fetches[0].url, "/api/obsidian/vaults");
    assert.equal(e.fetches[0].init.headers["X-Marginalia"], "1");
    await O.detect();
    assert.equal(e.fetches.length, 1, "cached");
    await O.detect({ force: true });
    assert.equal(e.fetches.length, 2, "Settings re-checks");
    assert.equal(O.state().mode, "server");
  });
  test("replaceOnly: true only when GET /api/obsidian/vaults answers it as true (a serve.py from before FEATURES A8 has none)", async () => {
    env({ fetch: () => ({ status: 200, body: { vaults: ONE_VAULT.body.vaults, replaceOnly: true } }) });
    assert.deepEqual(await O.detect(), { mode: "server", vaults: [{ id: "v1", name: "Test Vault", open: true, attachmentFolder: "Attachments" }],
      server: true, outdated: false, replaceOnly: true });
    for (const flag of [undefined, false, "true", 1, null]) {
      env({ fetch: () => ({ status: 200, body: { vaults: ONE_VAULT.body.vaults, replaceOnly: flag } }) });
      const d = await O.detect();
      assert.deepEqual([d.mode, "replaceOnly" in d], ["server", false], String(flag));
    }
  });
  test("link mode on 404, on a network error, with no vault, in the artifact build and from file://", async () => {
    env();
    assert.equal((await O.detect()).mode, "link");
    env({ fetch: () => new Error("offline") });
    assert.equal((await O.detect()).mode, "link");
    env({ fetch: () => ({ status: 200, body: { vaults: [] } }) });
    const none = await O.detect();
    assert.deepEqual([none.mode, none.server], ["link", true]);
    let e = env({ artifact: true, fetch: server({}) });
    assert.equal((await O.detect()).mode, "link");
    assert.equal(e.fetches.length, 0, "the artifact build never asks");
    e = env({ protocol: "file:", fetch: server({}) });
    assert.equal((await O.detect()).mode, "link");
    assert.equal(e.fetches.length, 0);
  });
});

describe("send through obsidian:// links (no server)", () => {
  afterEach(() => { O._reset(); delete globalThis.location; delete globalThis.navigator; });
  const contentOf = (uri) => decodeURIComponent(/&content=([^&]*)/.exec(uri)[1]);
  test("opens obsidian://new with the block through the injectable opener, records obsidianSentAt, offers Open", async () => {
    const e = env({ settings: { obsidianVault: "Obsidian Vault" } });
    const res = await O.send("p_1", { fromGesture: true });
    assert.equal(res.ok, true);
    assert.equal(res.mode, "link");
    assert.equal(e.opened.length, 1);
    const uri = e.opened[0];
    assert.ok(uri.startsWith("obsidian://new?vault=Obsidian%20Vault&file=Notes%2FMarginalia%2FGriffiths&content="), uri);
    assert.ok(uri.endsWith("&append=true&silent"), uri);
    const content = contentOf(uri);
    assert.equal(content, "# Griffiths\n\n" + O.blockFor(prompt(), BOOK, { images: false }), "a new note starts with its title");
    assert.equal(uri, O.uriFor("Obsidian Vault", "Notes/Marginalia/Griffiths.md", content));
    await tick();
    assert.deepEqual(e.patches.map((c) => [c.id, Object.keys(c.fields).sort()]), [["p_1", ["obsidianFile", "obsidianPendingFile", "obsidianSentAt"]]],
      "one write, the record: a link writes nothing ahead");
    const rec = e.prompts.get("p_1");
    assert.equal(typeof rec.obsidianSentAt, "number");
    assert.equal(rec.obsidianFile, "Notes/Marginalia/Griffiths.md", "the note it went to");
    assert.equal(rec.contentUpdatedAt, 1, "not a content edit");
    const t = e.toasts[e.toasts.length - 1];
    assert.equal(t.text, "Added to Obsidian · Notes/Marginalia/Griffiths.md");
    assert.equal(t.actions[0].label, "Open in Obsidian");
    t.actions[0].run();
    assert.equal(e.opened[1], "obsidian://open?vault=Obsidian%20Vault&file=Notes%2FMarginalia%2FGriffiths");
  });
  test("the \"# <name>\" title goes only to a note Marginalia has not written: the next prompts are appended bare", async () => {
    const p2 = prompt({ id: "p_2", text: "Q. second\nA. one" }), p3 = prompt({ id: "p_3", text: "Q. third\nA. one" });
    const e = env({ prompts: [prompt(), p2, p3] });
    await O.send("p_1", { fromGesture: true });
    await tick();
    assert.ok(contentOf(e.opened[0]).startsWith("# Griffiths\n\n<!-- marginalia:p_1 -->\n"));
    await O.send("p_2", { fromGesture: true });
    await tick();
    assert.equal(contentOf(e.opened[1]), O.blockFor(p2, BOOK, { images: false }), "the note exists now: no second title");
    await O.send("p_1", { fromGesture: true });                       // a re-send of the first one, too
    assert.ok(contentOf(e.opened[2]).startsWith("<!-- marginalia:p_1 -->"));
    // another folder is another note: a prompt sent there first gets its title again
    e.values.obsidianFolder = "Reading";
    await O.send("p_3", { fromGesture: true });
    await tick();
    assert.match(e.opened[3], /^obsidian:\/\/new\?file=Reading%2FGriffiths&/);
    assert.ok(contentOf(e.opened[3]).startsWith("# Griffiths\n\n<!-- marginalia:p_3 -->\n"));
    assert.equal(e.prompts.get("p_3").obsidianFile, "Reading/Griffiths.md");
    // while a prompt sent before goes on to the note that holds its copy (sending again updates that copy)
    await O.send("p_2", { fromGesture: true });
    await tick();
    assert.match(e.opened[4], /^obsidian:\/\/new\?file=Notes%2FMarginalia%2FGriffiths&/);
    assert.ok(contentOf(e.opened[4]).startsWith("<!-- marginalia:p_2 -->"), "its note exists: no title");
    assert.equal(e.prompts.get("p_2").obsidianFile, "Notes/Marginalia/Griffiths.md");
  });
  test("a send recorded before obsidianFile existed counts for its book's note until the book has a recorded file", async () => {
    const e = env({ prompts: [prompt({ obsidianSentAt: 123 }), prompt({ id: "p_2" }), prompt({ id: "p_3" })] });
    await O.send("p_2", { fromGesture: true });                     // the old send made the note: no duplicate title
    await tick();
    assert.ok(contentOf(e.opened[0]).startsWith("<!-- marginalia:p_2 -->"));
    assert.equal(e.prompts.get("p_2").obsidianFile, "Notes/Marginalia/Griffiths.md");
    e.values.obsidianFolder = "Elsewhere";                           // now the recorded files tell: a new note, titled
    await O.send("p_3", { fromGesture: true });
    assert.ok(contentOf(e.opened[1]).startsWith("# Griffiths\n\n<!-- marginalia:p_3 -->"), contentOf(e.opened[1]).slice(0, 40));
  });
  test("a quote cut inside a surrogate pair still goes out (U+FFFD), and its toast is the usual one", async () => {
    const cut = ("a".repeat(499) + "\u{1D465}").slice(0, 500);
    const e = env({ prompts: [prompt({ anchor: Object.assign({}, prompt().anchor, { quote: cut }) })] });
    const res = await O.send("p_1", { fromGesture: true });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(e.opened.length, 1);
    assert.ok(contentOf(e.opened[0]).includes("> " + "a".repeat(499) + "�\n"));
    assert.match(e.toasts[e.toasts.length - 1].text, /^Added to Obsidian · /);
  });
  test("a re-send appends a second copy, and the toast says so", async () => {
    const e = env({ prompts: [prompt({ obsidianSentAt: 123 })] });
    await O.send("p_1", { fromGesture: true });
    const t = e.toasts[e.toasts.length - 1];
    assert.match(t.detail, /second copy/);
    assert.ok(e.opened[0].startsWith("obsidian://new?file=Notes%2FMarginalia%2FGriffiths&"), "no vault name: Obsidian's open vault");
  });
  test("images become [image] in link mode", async () => {
    const e = env({ prompts: [prompt({ text: "Q. ![snip](att:a_1)\nA. x" })] });
    await O.send("p_1", { fromGesture: true });
    assert.match(decodeURIComponent(e.opened[0]), /\nQ\. \[image\]\nA\. x\n/);
  });
  test("outside a gesture nothing opens: the toast's button does it", async () => {
    const e = env();
    const res = await O.send("p_1", { fromGesture: false });
    assert.equal(res.ok, false);
    assert.equal(e.opened.length, 0);
    const t = e.toasts[e.toasts.length - 1];
    assert.equal(t.text, "Ready for Obsidian · Notes/Marginalia/Griffiths.md");
    t.actions[0].run();
    assert.equal(e.opened.length, 1);
    assert.ok(e.opened[0].startsWith("obsidian://new?"));
  });
  test("60 000 characters: a URI of exactly the limit opens, one more is copied instead", async () => {
    const vault = "Obsidian Vault", file = "Notes/Marginalia/Griffiths.md";
    let e = env({ settings: { obsidianVault: vault } });     // location first: the block's link line counts too
    // a first send: the content is the new note's title and the block
    const content = (p) => "# Griffiths\n\n" + O.blockFor(p, BOOK, { images: false });
    const len0 = O.uriFor(vault, file, content(prompt({ text: "a" }))).length;
    const atLimit = prompt({ text: "a".repeat(1 + O.URI_LIMIT - len0) });
    assert.equal(O.uriFor(vault, file, content(atLimit)).length, O.URI_LIMIT);
    e.prompts.set("p_1", atLimit);
    let res = await O.send("p_1", { fromGesture: true });
    assert.equal(res.ok, true);
    assert.equal(e.opened.length, 1);
    assert.equal(e.opened[0].length, O.URI_LIMIT);

    const over = prompt({ text: "a".repeat(2 + O.URI_LIMIT - len0) });
    e = env({ settings: { obsidianVault: vault }, prompts: [over] });
    res = await O.send("p_1", { fromGesture: true });
    await tick();
    assert.equal(res.mode, "copy");
    assert.equal(e.opened.length, 0, "never opened");
    assert.deepEqual(e.copied, [O.blockFor(over, BOOK, { images: false })]);
    assert.equal(e.toasts[e.toasts.length - 1].text, "Note copied — paste it into Notes/Marginalia/Griffiths.md");
    assert.equal(e.patches.length, 0, "a copy is not a send");
  });
  test("the default opener is replaced by _setOpener and restored by _setOpener(null)", async () => {
    const e = env();
    const mine = [];
    O._setOpener((u) => mine.push(u));
    await O.send("p_1", { fromGesture: true });
    assert.equal(mine.length, 1);
    assert.equal(e.opened.length, 0);
    O._setOpener(null);                    // back to the <a href> opener, which needs a document: none here
    const res = await O.send("p_1", { fromGesture: true });
    assert.equal(res.ok, false, "without a document the default opener cannot open anything");
  });
});

describe("send through Marginalia's server", () => {
  afterEach(() => { O._reset(); delete globalThis.location; delete globalThis.navigator; });
  test("POSTs the block and its images to /api/obsidian/note; Added, then Updated", async () => {
    let reply = { status: 200, body: { ok: true, file: "Notes/Marginalia/Griffiths.md", created: true, replaced: false } };
    const e = env({ prompts: [prompt({ text: "Q. ![snip](att:a_1) and ![snip](att:a_gone)\nA. x" })], fetch: server(() => reply) });
    const res = await O.send("p_1", { fromGesture: true });
    assert.equal(res.ok, true);
    assert.equal(res.mode, "server");
    assert.equal(e.opened.length, 0, "a silent write opens nothing");
    const post = e.fetches.find((f) => f.url === "/api/obsidian/note");
    assert.equal(post.init.method, "POST");
    assert.equal(post.init.headers["Content-Type"], "application/json");
    assert.equal(post.init.headers["X-Marginalia"], "1");
    const body = JSON.parse(post.init.body);
    assert.equal(body.vault, "Test Vault", "the only vault found");
    assert.equal(body.file, "Notes/Marginalia/Griffiths.md");
    assert.equal(body.title, "Griffiths");
    assert.equal(body.blockId, "p_1");
    assert.deepEqual(body.images, [{ name: "marginalia-a_1.png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString("base64") }]);
    assert.match(body.markdown, /\nQ\. !\[\[marginalia-a_1\.png\]\] and \[image\]\nA\. x\n/, "a missing attachment is [image]");
    assert.ok(body.markdown.startsWith("<!-- marginalia:p_1 -->\n") && body.markdown.endsWith("\n<!-- /marginalia -->"));
    await tick();
    assert.equal(e.toasts[e.toasts.length - 1].text, "Added to Obsidian · Notes/Marginalia/Griffiths.md");
    assert.equal(typeof e.prompts.get("p_1").obsidianSentAt, "number");
    assert.equal(e.prompts.get("p_1").obsidianFile, "Notes/Marginalia/Griffiths.md");
    assert.ok(!body.markdown.startsWith("# "), "the server writes a new note's title itself");
    e.toasts[e.toasts.length - 1].actions[0].run();
    assert.equal(e.opened[0], "obsidian://open?vault=Test%20Vault&file=Notes%2FMarginalia%2FGriffiths");

    reply = { status: 200, body: { ok: true, file: "Notes/Marginalia/Griffiths.md", created: false, replaced: true } };
    await O.send("p_1", { fromGesture: true });
    assert.equal(e.toasts[e.toasts.length - 1].text, "Updated in Obsidian · Notes/Marginalia/Griffiths.md");
  });
  test("a refusal names the reason and offers Copy note", async () => {
    const e = env({ fetch: server({ status: 400, body: { ok: false, error: "unknown vault" } }) });
    const res = await O.send("p_1", { fromGesture: true });
    assert.equal(res.ok, false);
    const t = e.toasts[e.toasts.length - 1];
    assert.equal(t.text, "Could not add to Obsidian — unknown vault");
    assert.equal(t.actions[0].label, "Copy note");
    t.actions[0].run();
    await tick();
    assert.equal(e.copied.length, 1);
    assert.ok(e.copied[0].startsWith("<!-- marginalia:p_1 -->"));
    // written ahead, then put back: a 400 with a JSON answer wrote nothing
    assert.deepEqual(e.patches.map((c) => [c.id, c.fields]), [["p_1", { obsidianPendingFile: "Notes/Marginalia/Griffiths.md" }], ["p_1", { obsidianPendingFile: undefined }]]);
    assert.deepEqual(["obsidianPendingFile" in e.prompts.get("p_1"), e.prompts.get("p_1").obsidianSentAt], [false, undefined]);
  });
  test("several vaults and none chosen: no write, Settings is named", async () => {
    const two = { status: 200, body: { vaults: [{ id: "a", name: "A" }, { id: "b", name: "B" }] } };
    const e = env({ fetch: (url) => (url === "/api/obsidian/vaults" ? two : { status: 200, body: { ok: true } }) });
    await O.send("p_1", { fromGesture: true });
    assert.equal(e.fetches.filter((f) => f.url === "/api/obsidian/note").length, 0);
    assert.match(e.toasts[e.toasts.length - 1].text, /choose a vault in Settings › Obsidian/);
    e.values.obsidianVault = "B";
    await O.send("p_1", { fromGesture: true });
    assert.equal(JSON.parse(e.fetches.find((f) => f.url === "/api/obsidian/note").init.body).vault, "B");
  });
  test("deck prompts go to the deck's note", async () => {
    const p = prompt({ id: "p_d", collectionId: DECK.id, anchor: null, context: { docName: DECK.name, sectionLabel: "Verbs" } });
    const e = env({ prompts: [p], settings: { obsidianFolder: "" }, fetch: server({ status: 200, body: { ok: true, file: "Thermo formulas.md", created: true } }) });
    await O.send("p_d", { fromGesture: true });
    const body = JSON.parse(e.fetches.find((f) => f.url === "/api/obsidian/note").init.body);
    assert.equal(body.file, "Thermo formulas.md");
    assert.match(body.markdown, /^<!-- marginalia:p_d -->\n### Verbs\n/);
  });
  test("an empty free note is not sent", async () => {
    const e = env({ prompts: [prompt({ kind: "highlight", text: "", anchor: { pageIndex: 0, pages: [], quote: "", y: 1 } })], fetch: server({}) });
    const res = await O.send("p_1", { fromGesture: true });
    assert.equal(res.ok, false);
    assert.equal(e.fetches.length, 0);
    assert.match(e.toasts[0].text, /the note is empty/);
  });
  test("a quote cut inside a surrogate pair is POSTed as well-formed text (serve.py refuses lone surrogates)", async () => {
    const cut = ("a".repeat(499) + "\u{1D465}").slice(0, 500);
    const e = env({ prompts: [prompt({ anchor: Object.assign({}, prompt().anchor, { quote: cut }) })],
      fetch: server({ status: 200, body: { ok: true, file: "Notes/Marginalia/Griffiths.md", created: true } }) });
    const res = await O.send("p_1", { fromGesture: true });
    assert.equal(res.ok, true);
    const raw = e.fetches.find((f) => f.url === "/api/obsidian/note").init.body;
    assert.ok(!/\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])/i.test(raw), "no lone high surrogate escape in the JSON");
    assert.ok(JSON.parse(raw).markdown.includes("> " + "a".repeat(499) + "�\n"));
  });
  test("sending again updates the copy where it lives: the recorded note, after a rename, a folder change or a move", async () => {
    const posted = [];
    const echo = server((url, init) => { const b = JSON.parse(init.body); posted.push(b); return { status: 200, body: { ok: true, file: b.file, created: false, replaced: true } }; });
    const old = "Notes/Marginalia/Introduction to Quantum.md";
    const e = env({ prompts: [prompt({ obsidianSentAt: 100, obsidianFile: old }), prompt({ id: "p_2" })], fetch: echo });
    // the book is "Griffiths" now (renamed since the send)
    let res = await O.send("p_1", { fromGesture: true });
    assert.equal(res.file, old);
    assert.deepEqual([posted[0].file, posted[0].title], [old, "Introduction to Quantum"], "the note it lives in, with that note's title");
    assert.equal(e.toasts[e.toasts.length - 1].text, "Updated in Obsidian · " + old, "the toast names that note");
    await tick();
    assert.equal(e.prompts.get("p_1").obsidianFile, old);
    res = await O.send("p_2", { fromGesture: true });                  // a prompt never sent goes to the new name
    assert.equal(posted[1].file, "Notes/Marginalia/Griffiths.md");
    assert.equal(posted[1].title, "Griffiths");
    e.values.obsidianFolder = "Books";                                // a folder change does not move a sent copy either
    await O.send("p_1", { fromGesture: true });
    assert.equal(posted[2].file, old);
    e.prompts.set("p_1", Object.assign({}, e.prompts.get("p_1"), { collectionId: DECK.id, anchor: null, context: { docName: DECK.name, sectionLabel: null } }));
    await O.send("p_1", { fromGesture: true });                       // nor does a move to a deck
    assert.equal(posted[3].file, old);
    assert.match(posted[3].markdown, /^<!-- marginalia:p_1 -->\n### Thermo formulas\n/);
  });
  test("a recorded note path Marginalia could not have written is not reused: the send goes to <folder>/<nickname>.md", async () => {
    const posted = [];
    const echo = server((url, init) => { const b = JSON.parse(init.body); posted.push(b.file); return { status: 200, body: { ok: true, file: b.file, created: true } }; });
    const bad = ["../x.md", "/abs/Griffiths.md", "Notes//Griffiths.md", "Notes/a:b.md", "Notes/Griffiths.txt", "Notes/Griffiths", " Notes/Griffiths.md",
      "Notes/.md", "N/" + "x".repeat(121) + ".md", ("a/").repeat(600) + "b.md", "Notes/Griffiths.MD"];
    const e = env({ prompts: bad.map((f, i) => prompt({ id: "p_" + i, obsidianSentAt: 100, obsidianFile: f })).concat([prompt({ id: "p_old", obsidianFile: "Old/Griffiths.md" })]), fetch: echo });
    for (let i = 0; i < bad.length; i++) await O.send("p_" + i, { fromGesture: true });
    await O.send("p_old", { fromGesture: true });                   // a file without obsidianSentAt is no send
    assert.deepEqual(posted, bad.map(() => "Notes/Marginalia/Griffiths.md").concat(["Notes/Marginalia/Griffiths.md"]));
    assert.equal(e.fetches.filter((f) => f.url === "/api/obsidian/note").length, bad.length + 1);
  });
  test("whatever fails unexpectedly before the request, the toast still offers Copy note with the block", async () => {
    const e = env({ fetch: server({ status: 200, body: { ok: true } }) });
    const imageIds = M.prompts.imageIds;
    M.prompts.imageIds = () => { throw new TypeError("a broken prompt"); };
    let res;
    try { res = await O.send("p_1", { fromGesture: true }); } finally { M.prompts.imageIds = imageIds; }
    assert.equal(res.ok, false);
    assert.equal(e.fetches.filter((f) => f.url === "/api/obsidian/note").length, 0, "nothing went");
    const t = e.toasts[e.toasts.length - 1];
    assert.equal(t.text, "Could not add to Obsidian — unexpected error (a broken prompt)");
    assert.equal(t.actions[0].label, "Copy note");
    t.actions[0].run();
    await tick();
    assert.deepEqual(e.copied, [O.blockFor(prompt(), BOOK, { images: false })]);
  });
  test("whatever fails unexpectedly once the request went, the card may be in the note: no Copy note, the marker stays", async () => {
    const e = env({ fetch: (url) => (url === "/api/obsidian/vaults" ? ONE_VAULT : { status: 200, body: { ok: true } }) });
    O._setFetch((url) => (url === "/api/obsidian/vaults"
      ? Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(ONE_VAULT.body) })
      : Promise.resolve({ get ok() { throw new TypeError("a broken response"); }, status: 200, json: () => Promise.resolve({}) })));
    const res = await O.send("p_1", { fromGesture: true });
    assert.deepEqual([res.ok, res.mode, res.error], [false, "server", "unexpected error (a broken response)"]);
    const t = e.toasts[e.toasts.length - 1];
    assert.deepEqual([t.text, t.actions || []], ["May already be in Obsidian — unexpected error (a broken response)", []]);
    // the request went and its answer could not be read: no telling, so the marker stays and nothing is recorded
    assert.deepEqual([e.prompts.get("p_1").obsidianPendingFile, e.prompts.get("p_1").obsidianSentAt], ["Notes/Marginalia/Griffiths.md", undefined]);
  });
});

// ------------------------------------------------------------------ review fixes of 2026-11-07

describe("an older Marginalia server is told apart from no server at all", () => {
  afterEach(() => { O._reset(); delete globalThis.location; delete globalThis.navigator; });
  test("detect: 404, 405 or 501 from the page's own 127.0.0.1 / localhost server is outdated; the other link cases are not", async () => {
    for (const status of [404, 405, 501]) {
      env({ fetch: () => ({ status, body: {} }) });
      assert.deepEqual(await O.detect(), { mode: "link", vaults: [], server: false, outdated: true }, String(status));
      env({ hostname: "localhost", fetch: () => ({ status, body: {} }) });
      assert.equal((await O.detect()).outdated, true, "localhost " + status);
    }
    env({ fetch: () => new Error("offline") });
    assert.deepEqual(await O.detect(), { mode: "link", vaults: [], server: false, outdated: false }, "a network error is no server");
    env({ fetch: () => ({ status: 500, body: {} }) });
    assert.equal((await O.detect()).outdated, false, "a 500 is not an older server");
    env({ hostname: "192.168.1.5", fetch: () => ({ status: 404, body: {} }) });
    assert.equal((await O.detect()).outdated, false, "another host is not this Mac's marginalia");
    env({ protocol: "file:" });
    assert.equal((await O.detect()).outdated, false);
    env({ artifact: true });
    assert.equal((await O.detect()).outdated, false);
    env({ fetch: () => ({ status: 200, body: { vaults: [] } }) });
    assert.deepEqual(await O.detect(), { mode: "link", vaults: [], server: true, outdated: false });
    assert.equal(O.METHOD_RESTART, "Opens obsidian:// links — restart Marginalia (marginalia restart in Terminal) to write silently");
  });
  test("the link toast says to run marginalia restart with an older server, and keeps the O1 advice otherwise", async () => {
    let e = env();                                              // 404 on 127.0.0.1: the serve.py from before the endpoints
    await O.send("p_1", { fromGesture: true });
    let t = e.toasts[e.toasts.length - 1];
    assert.equal(t.text, "Added to Obsidian · Notes/Marginalia/Griffiths.md");
    assert.equal(t.detail, "Sent through an obsidian:// link. Restart Marginalia (marginalia restart in Terminal) to write silently and update in place.");
    e = env({ protocol: "file:" });
    await O.send("p_1", { fromGesture: true });
    assert.equal(e.toasts[e.toasts.length - 1].detail, "Sent through an obsidian:// link. Start Marginalia with the marginalia command to write silently and update in place.");
    e = env({ fetch: () => new Error("offline") });             // the server is not running: starting it is the advice
    await O.send("p_1", { fromGesture: true });
    assert.match(e.toasts[e.toasts.length - 1].detail, /Start Marginalia with the marginalia command/);
    e = env();
    O._setOpener(() => false);                                  // a browser that cannot open the link
    await O.send("p_1", { fromGesture: true });
    assert.equal(e.toasts[e.toasts.length - 1].text,
      "Could not add to Obsidian — this browser cannot open obsidian:// links — restart Marginalia (marginalia restart in Terminal) to write silently");
  });
  test("a server write refused with 404, 405 or 501 says to run marginalia restart", async () => {
    for (const status of [404, 405, 501]) {
      const e = env({ fetch: server({ status, body: null }) });
      await O.send("p_1", { fromGesture: true });
      assert.equal(e.toasts[e.toasts.length - 1].text, "Could not add to Obsidian — Marginalia's server has no Obsidian support — restart Marginalia (marginalia restart in Terminal)");
    }
  });
});

describe("a send checks a cached link-mode answer again on a 127.0.0.1 / localhost page", () => {
  afterEach(() => { O._reset(); delete globalThis.location; delete globalThis.navigator; });
  const vaultGets = (e) => e.fetches.filter((f) => f.url === "/api/obsidian/vaults").length;
  test("after marginalia restart, a page that sent through a link writes silently again", async () => {
    let up = false;
    const e = env({ fetch: (url, init) => (!up ? { status: 404, body: {} }
      : url === "/api/obsidian/vaults" ? ONE_VAULT : { status: 200, body: { ok: true, file: JSON.parse(init.body).file, created: false, replaced: true } }) });
    let res = await O.send("p_1", { fromGesture: true });
    assert.equal(res.mode, "link");
    await tick();
    up = true;                                                  // the new serve.py now answers at the same address
    res = await O.send("p_1", { fromGesture: true });
    assert.equal(res.mode, "server");
    assert.equal(e.opened.length, 1, "no second obsidian:// link");
    assert.equal(vaultGets(e), 2);
    assert.equal(e.toasts[e.toasts.length - 1].text, "Updated in Obsidian · Notes/Marginalia/Griffiths.md");
    assert.equal(O.state().mode, "server");
    await O.send("p_1", { fromGesture: true });                 // a cached server answer is not asked again
    assert.equal(vaultGets(e), 2);
  });
  test("a server that stays down: each send asks once and still goes out through a link", async () => {
    const e = env({ fetch: () => new Error("offline") });
    await O.send("p_1", { fromGesture: true });
    await O.send("p_1", { fromGesture: true });
    assert.equal(vaultGets(e), 2);
    assert.equal(e.opened.length, 2);
  });
  test("no second check away from this Mac, from file:// or in the artifact build", async () => {
    let e = env({ hostname: "example.org" });
    await O.send("p_1", { fromGesture: true });
    await O.send("p_1", { fromGesture: true });
    assert.equal(vaultGets(e), 1, "cached");
    assert.equal(e.opened.length, 2);
    e = env({ protocol: "file:" });
    await O.send("p_1", { fromGesture: true });
    await O.send("p_1", { fromGesture: true });
    assert.equal(e.fetches.length, 0);
    e = env({ artifact: true });
    await O.send("p_1", { fromGesture: true });
    assert.equal(e.fetches.length, 0);
  });
});

describe("link mode: what the toast says about an earlier copy", () => {
  afterEach(() => { O._reset(); delete globalThis.location; delete globalThis.navigator; });
  const contentOf = (uri) => decodeURIComponent(/&content=([^&]*)/.exec(uri)[1]);
  test("after a rename or a folder change the re-send goes to the note that holds the copy, which then holds a second one", async () => {
    const old = "Notes/Marginalia/Introduction to Quantum.md";
    const e = env({ prompts: [prompt({ obsidianSentAt: 100, obsidianFile: old })], settings: { obsidianFolder: "Reading" } });
    await O.send("p_1", { fromGesture: true });
    assert.match(e.opened[0], /^obsidian:\/\/new\?file=Notes%2FMarginalia%2FIntroduction%20to%20Quantum&/);
    assert.ok(contentOf(e.opened[0]).startsWith("<!-- marginalia:p_1 -->"), "that note exists: no title");
    const t = e.toasts[e.toasts.length - 1];
    assert.equal(t.text, "Added to Obsidian · " + old);
    assert.match(t.detail, /the note now holds a second copy/);
  });
  test("a send from before obsidianFile was recorded counts as this note's copy; a copy in another note is named, not doubled", async () => {
    let e = env({ prompts: [prompt({ obsidianSentAt: 100 })] });
    await O.send("p_1", { fromGesture: true });
    assert.match(e.toasts[e.toasts.length - 1].detail, /second copy/);
    e = env({ prompts: [prompt({ obsidianSentAt: 100, obsidianFile: "Old:Notes/Griffiths.md" })] });   // not a path Marginalia writes
    await O.send("p_1", { fromGesture: true });
    assert.match(e.opened[0], /^obsidian:\/\/new\?file=Notes%2FMarginalia%2FGriffiths&/);
    const t = e.toasts[e.toasts.length - 1];
    assert.equal(t.detail, "Sent through an obsidian:// link. The earlier copy stays in Old:Notes/Griffiths.md.");
    assert.doesNotMatch(t.detail, /second copy/);
  });
});

describe("Copy note and the clipboard", () => {
  afterEach(() => { O._reset(); delete globalThis.location; delete globalThis.navigator; });
  const TEXT = "Q. What is shown? ![snip](att:a_1)\nA. The wave packet";
  test("after a refused server write the copied block has [image]: no image reached the vault", async () => {
    const replies = [{ status: 409, body: { ok: false, error: "a folder has the note's name" } }, { status: 400, body: { ok: false, error: "unknown vault" } },
      { status: 413, body: { ok: false, error: "too large" } }];
    // no answer, a 5xx or an older server's 501 may have left the card in the note (it keeps the marker): nothing to copy
    for (const reply of [{ status: 501, body: null }, { status: 500, body: { ok: false, error: "could not write the note" } }, new Error("net")]) {
      const e = env({ prompts: [prompt({ text: TEXT })], fetch: server(reply) });
      await O.send("p_1", { fromGesture: true });
      assert.deepEqual(e.toasts[e.toasts.length - 1].actions || [], [], String(reply.status || reply.message));
    }
    for (const reply of replies) {
      const e = env({ prompts: [prompt({ text: TEXT })], fetch: server(reply) });
      await O.send("p_1", { fromGesture: true });
      const post = e.fetches.find((f) => f.url === "/api/obsidian/note");
      assert.match(JSON.parse(post.init.body).markdown, /!\[\[marginalia-a_1\.png\]\]/, "the POST itself embeds the image");
      e.toasts[e.toasts.length - 1].actions.find((a) => a.label === "Copy note").run();
      await tick();
      assert.deepEqual(e.copied, [O.blockFor(prompt({ text: TEXT }), BOOK, { images: false })], String(reply.status || reply.message));
      assert.match(e.copied[0], /\nQ\. What is shown\? \[image\]\n/);
    }
  });
  test("over 25 MB nothing is POSTed and the copied block has [image] too", async () => {
    const big = new Uint8Array(19 * 1024 * 1024);
    big.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const e = env({ prompts: [prompt({ text: TEXT })], fetch: server({ status: 200, body: { ok: true } }) });
    M.store = { attachments: { get: () => Promise.resolve({ id: "a_1", mime: "image/png", bytes: big }) } };
    const res = await O.send("p_1", { fromGesture: true });
    assert.equal(res.error, "the note and its images are larger than 25 MB");
    assert.equal(e.fetches.filter((f) => f.url === "/api/obsidian/note").length, 0);
    e.toasts[e.toasts.length - 1].actions[0].run();
    await tick();
    assert.match(e.copied[0], /\nQ\. What is shown\? \[image\]\n/);
  });
  test("a copy the clipboard refuses offers Copy note again, until one goes through", async () => {
    const e = env({ fetch: server({ status: 409, body: { ok: false, error: "a folder has the note's name" } }), refuse: 2 });
    await O.send("p_1", { fromGesture: true });
    e.toasts[e.toasts.length - 1].actions[0].run();             // refused
    await tick();
    let t = e.toasts[e.toasts.length - 1];
    assert.equal(t.text, "The browser blocked the clipboard — the note was not copied");
    assert.deepEqual(t.actions.map((a) => a.label), ["Copy note"]);
    t.actions[0].run();                                         // refused again: offered again
    await tick();
    t = e.toasts[e.toasts.length - 1];
    assert.deepEqual([t.text, t.actions.map((a) => a.label)], ["The browser blocked the clipboard — the note was not copied", ["Copy note"]]);
    t.actions[0].run();                                         // goes through
    await tick();
    assert.equal(e.toasts[e.toasts.length - 1].text, "Note copied — paste it into Notes/Marginalia/Griffiths.md");
    assert.deepEqual(e.copied, [O.blockFor(prompt(), BOOK, { images: false })]);
  });
  test("over 60 000 characters a refused copy also offers Copy note", async () => {
    const e = env({ prompts: [prompt({ text: "a".repeat(70000) })], refuse: 1 });
    const res = await O.send("p_1", { fromGesture: true });
    await tick();
    assert.equal(res.mode, "copy");
    assert.equal(e.opened.length, 0);
    const t = e.toasts[e.toasts.length - 1];
    assert.deepEqual([t.text, t.actions.map((a) => a.label)], ["The browser blocked the clipboard — the note was not copied", ["Copy note"]]);
    t.actions[0].run();
    await tick();
    assert.equal(e.copied.length, 1);
    assert.ok(e.copied[0].includes("a".repeat(70000)));
  });
});

describe("the anchor quote is the PDF's text, never Obsidian syntax", () => {
  const quoteOf = (quote) => O.blockFor(prompt({ kind: "highlight", text: "", anchor: Object.assign({}, prompt().anchor, { quote }) }), BOOK, LOCAL)
    .split("\n").filter((l) => l.startsWith(">"));
  test("tags, headings, comments, wiki links, embeds, highlights, block ids, math and HTML are escaped", () => {
    assert.deepEqual(quoteOf("#include <stdio.h> #define MAX 10 # Exercises > Note: printf(\"100%%\");"),
      ["> \\#include &lt;stdio.h> \\#define MAX 10 \\# Exercises > Note: printf(\"100\\%\\%\");"]);
    assert.deepEqual(quoteOf("# compute the mean\n%% Plot the result"), ["> \\# compute the mean", "> \\%\\% Plot the result"]);
    assert.deepEqual(quoteOf("see [[not a link]] and ![[nor an embed]] or [a](b) ==x== ^block-id"),
      ["> see \\[\\[not a link\\]\\] and !\\[\\[nor an embed\\]\\] or \\[a\\](b) \\=\\=x\\=\\= \\^block-id"]);
    assert.deepEqual(quoteOf("costs $5 and $10, x^2, C:\\Users\\#1"), ["> costs \\$5 and \\$10, x\\^2, C:\\\\Users\\\\\\#1"]);
    assert.deepEqual(quoteOf("> nested\n---"), ["> \\> nested", "> \\---"], "no nested quote, no heading underline");
    assert.deepEqual(quoteOf("   > indented\n="), [">    \\> indented", "> \\="]);
    assert.deepEqual(quoteOf("a <b>bold</b> <!-- comment --> <!-- marginalia:p_9 --> x < y, a <= b, 1<2"),
      ["> a &lt;b>bold&lt;/b> &lt;!-- comment --> &lt;!-- marginalia:p_9 --> x < y, a <= b, 1<2"]);
  });
  test("plain text, a single = or % and a lone - stay as they are", () => {
    assert.deepEqual(quoteOf("E = mc2 at 50% (not == or %%%)"), ["> E = mc2 at 50% (not \\=\\= or \\%\\%\\%)"]);
    assert.deepEqual(quoteOf("plain text, nothing (here) - ok"), ["> plain text, nothing (here) - ok"]);
    assert.deepEqual(quoteOf("a potential energy function"), ["> a potential energy function"]);
  });
  test("the escaped block stays findable by serve.py and is what both modes send", async () => {
    const quote = "#tag %% [[x]] ==y== ^id $z$ <!-- /marginalia --> \\\n2026-11-06";
    const p = prompt({ anchor: Object.assign({}, prompt().anchor, { quote }) });
    const b = O.blockFor(p, BOOK, LOCAL);
    assertFindable(b, "p_1");
    assert.ok(b.includes("\n> \\#tag \\%\\% \\[\\[x\\]\\] \\=\\=y\\=\\= \\^id \\$z\\$ &lt;!-- /marginalia --> \\\\\n> 2026-11-06\n"), b);
    try {
      let e = env({ prompts: [p], fetch: server({ status: 200, body: { ok: true, file: "Notes/Marginalia/Griffiths.md", created: true } }) });
      await O.send("p_1", { fromGesture: true });
      assert.ok(JSON.parse(e.fetches.find((f) => f.url === "/api/obsidian/note").init.body).markdown.includes("\n> \\#tag \\%\\% "));
      e = env({ prompts: [p], protocol: "file:" });
      await O.send("p_1", { fromGesture: true });
      assert.ok(decodeURIComponent(e.opened[0]).includes("\n> \\#tag \\%\\% "));
    } finally { O._reset(); delete globalThis.location; delete globalThis.navigator; }
  });
});

describe("a vault's name exactly as Obsidian lists it", () => {
  afterEach(() => { O._reset(); delete globalThis.location; delete globalThis.navigator; });
  const S = require(path.join(JS, "settings.js"));            // the real validator, as the Settings select stores the name
  const NAMES = ["My  Vault", " Lead Vault", "Trail Vault ", "NB\u00a0Vault", "Ideo\u3000Vault", "My Vault", "Other"];
  const LIST = { status: 200, body: { vaults: NAMES.map((name, i) => ({ id: "v" + i, name, open: i === 0 })) } };
  test("a name with doubled, leading, trailing or no-break spaces is chosen and written to, never another vault", async () => {
    const warn = console.warn;
    console.warn = () => {};
    try {
      for (const name of NAMES) {
        const e = env({ fetch: (url) => (url === "/api/obsidian/vaults" ? LIST : { status: 200, body: { ok: true, file: "Notes/Marginalia/Griffiths.md", created: true } }) });
        M.settings = S;
        S.set("obsidian", true);                          // DECISIONS D32: the connection is switched on
        S.set("obsidianVault", name);
        const res = await O.send("p_1", { fromGesture: true });
        assert.equal(res.ok, true, JSON.stringify(name) + " " + JSON.stringify(res));
        assert.equal(JSON.parse(e.fetches.find((f) => f.url === "/api/obsidian/note").init.body).vault, name);
      }
    } finally { console.warn = warn; S.reset(); }
  });
  test("links carry the name as it is (only a blank one is left out)", () => {
    assert.match(O.uriFor("My  Vault", "a.md", "x"), /^obsidian:\/\/new\?vault=My%20%20Vault&/);
    assert.match(O.uriFor(" Lead ", "a.md", "x"), /^obsidian:\/\/new\?vault=%20Lead%20&/);
    assert.equal(O.openUriFor("NB\u00a0Vault", "a.md"), "obsidian://open?vault=NB%C2%A0Vault&file=a");
    assert.equal(O.openUriFor(" \u00a0 ", "a.md"), "obsidian://open?file=a");
  });
});

describe("a tab that stepped aside for a newer Marginalia tab sends nothing (js/store.js: one writing tab per origin)", () => {
  afterEach(() => { O._reset(); delete globalThis.location; delete globalThis.navigator; });
  test("no POST, no obsidian:// link and no record while M.store.locked(); a tab that may write still sends", async () => {
    for (const fetch of [server({ status: 200, body: { ok: true, file: "Notes/Marginalia/Griffiths.md", created: true } }), undefined]) {
      const e = env({ fetch });                                  // server mode, then link mode (404)
      M.store.locked = () => ({ reason: "othertab", by: "tab_b", at: 1 });
      const res = await O.send("p_1", { fromGesture: true });
      assert.deepEqual([res.ok, res.error], [false, "Marginalia is open in another tab"]);
      assert.deepEqual([e.fetches.length, e.opened.length, e.patches.length, e.saves.length], [0, 0, 0, 0], "this tab's copy may be older");
      M.store.locked = () => null;
      assert.equal((await O.send("p_1", { fromGesture: true })).ok, true);
    }
  });
});

describe("a send is dated before an edit made while its block was on its way (FEATURES A8: Send all must still update it)", () => {
  afterEach(() => { O._reset(); delete globalThis.location; delete globalThis.navigator; });
  test("server: the edit made during the request stays newer than the recorded send; without an edit the send is dated now", async () => {
    const e = env({ fetch: server({ status: 200, body: { ok: true, file: "Notes/Marginalia/Griffiths.md", created: true } }) });
    let release;
    const gate = new Promise((r) => { release = r; });
    O._setFetch((url, init) => {
      e.fetches.push({ url, init });
      const reply = url === "/api/obsidian/vaults" ? ONE_VAULT : { status: 200, body: { ok: true, file: "Notes/Marginalia/Griffiths.md", created: true } };
      const answer = { ok: true, status: reply.status, json: () => Promise.resolve(reply.body) };
      return url === "/api/obsidian/note" ? gate.then(() => answer) : Promise.resolve(answer);
    });
    const sending = O.send("p_1", { fromGesture: true });
    for (let i = 0; i < 5 && !e.fetches.some((f) => f.url === "/api/obsidian/note"); i++) await tick();
    assert.ok(e.fetches.some((f) => f.url === "/api/obsidian/note"), "the request is under way");
    const editedAt = Date.now();                                    // the edit, as M.cache.savePrompt stamps it
    e.prompts.set("p_1", Object.assign({}, e.prompts.get("p_1"), { text: "Q. edited meanwhile?\nA. yes", contentUpdatedAt: editedAt }));
    await new Promise((r) => setTimeout(r, 5));
    release();
    assert.equal((await sending).ok, true);
    await tick();
    const rec = e.prompts.get("p_1");
    assert.equal(rec.obsidianFile, "Notes/Marginalia/Griffiths.md");
    assert.equal(rec.obsidianSentAt, editedAt - 1, "dated just before the edit");
    assert.equal(rec.text, "Q. edited meanwhile?\nA. yes", "the edit is kept");
    assert.equal(O.sendState(rec), "changed");
    // sent again with nothing edited meanwhile: dated now, and the card counts as sent
    const before = Date.now();
    await O.send("p_1", { fromGesture: true });
    await tick();
    assert.ok(e.prompts.get("p_1").obsidianSentAt >= before);
    assert.equal(O.sendState(e.prompts.get("p_1")), "unchanged");
  });
});

describe("a send whose answer never came is never added twice: the server may have written it (FEATURES A8)", () => {
  afterEach(() => { O._reset(); delete globalThis.location; delete globalThis.navigator; });
  const NOTE = "Notes/Marginalia/Griffiths.md";
  // POST /api/obsidian/note as tools/serve.py: the block replaced when the note holds it, else added. lose: "drop" (it
  // writes, then the page hears nothing), "cut" (it writes and answers 200, but the body never comes), "down" (nothing).
  function noteServer() {
    const notes = new Map(), s = { notes, lose: null };
    s.fetch = (url, init) => {
      if (url === "/api/obsidian/vaults") return ONE_VAULT;
      if (s.lose === "down") return new Error("Failed to fetch");
      const b = JSON.parse(init.body), ids = notes.get(b.file) || [], replaced = ids.includes(b.blockId);
      if (!replaced) ids.push(b.blockId);
      notes.set(b.file, ids);
      if (s.lose === "drop") return new Error("Failed to fetch");
      if (s.lose === "cut") return Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(new TypeError("network error")) });
      return { status: 200, body: { ok: true, file: b.file, created: !replaced, replaced } };
    };
    s.copies = (id) => { const out = {}; notes.forEach((ids, f) => { const k = ids.filter((x) => x === id).length; if (k) out[f] = k; }); return out; };
    return s;
  }

  test("the next send goes to the note that send was writing to, also after a rename, and updates the copy there", async () => {
    for (const how of ["drop", "cut"]) {
      const srv = noteServer();
      const e = env({ fetch: srv.fetch });
      srv.lose = how;
      let res = await O.send("p_1", { fromGesture: true });
      assert.equal(res.ok, false, how);
      assert.deepEqual([e.toasts[e.toasts.length - 1].text, e.toasts[e.toasts.length - 1].actions || []],
        ["May already be in Obsidian — " + (how === "drop" ? "Marginalia's server did not answer" : "the server's answer could not be read"), []], how + ": nothing to copy");
      assert.deepEqual(srv.copies("p_1"), { [NOTE]: 1 }, how + ": written all the same");
      // a reminder of that note, written before the request left, not a send: obsidianSentAt stays unset (still new),
      // and it is no content edit
      assert.deepEqual(e.patches.map((c) => [c.id, c.fields]), [["p_1", { obsidianPendingFile: NOTE }]], how);
      const was = e.prompts.get("p_1");
      assert.deepEqual([was.obsidianPendingFile, was.obsidianSentAt, was.obsidianFile, was.contentUpdatedAt], [NOTE, undefined, undefined, 1], how);
      assert.equal(O.sendState(e.prompts.get("p_1")), "fresh");
      e.cols.set(BOOK.id, Object.assign({}, BOOK, { name: "Introduction to Quantum" }));      // renamed since
      srv.lose = null;
      res = await O.send("p_1", { fromGesture: true });
      assert.deepEqual([res.ok, res.file, res.replaced], [true, NOTE, true], how);
      assert.equal(e.toasts[e.toasts.length - 1].text, "Updated in Obsidian · " + NOTE);
      assert.deepEqual(srv.copies("p_1"), { [NOTE]: 1 }, how + ": one copy");
      await tick();
      const rec = e.prompts.get("p_1");
      assert.deepEqual([typeof rec.obsidianSentAt, rec.obsidianFile, "obsidianPendingFile" in rec], ["number", NOTE, false], "the record replaces the reminder");
    }
  });

  test("a request that never reached the server: the next send adds the card to that note, once", async () => {
    const srv = noteServer();
    const e = env({ fetch: srv.fetch });
    srv.lose = "down";
    await O.send("p_1", { fromGesture: true });
    assert.equal(e.prompts.get("p_1").obsidianPendingFile, NOTE, "the page cannot tell it apart");
    e.cols.set(BOOK.id, Object.assign({}, BOOK, { name: "Introduction to Quantum" }));
    srv.lose = null;
    const res = await O.send("p_1", { fromGesture: true });
    assert.deepEqual([res.file, res.created, res.replaced], [NOTE, true, false]);
    assert.deepEqual(srv.copies("p_1"), { [NOTE]: 1 });
  });

  test("a refusal leaves nothing remembered; an update of a card recorded in that note whose answer never came is remembered too (A9.2)", async () => {
    let e = env({ fetch: server({ status: 409, body: { ok: false, error: "the note is read-only (locked in Finder or chmod)" } }) });
    await O.send("p_1", { fromGesture: true });
    assert.deepEqual(e.patches.map((c) => c.fields.obsidianPendingFile), [NOTE, undefined], "written ahead, then put back");
    assert.equal("obsidianPendingFile" in e.prompts.get("p_1"), false);
    e = env({ prompts: [prompt({ obsidianSentAt: 100, obsidianFile: NOTE, contentUpdatedAt: 200 })], fetch: server(new Error("offline")) });
    await O.send("p_1", { fromGesture: true });
    assert.equal(e.fetches.filter((f) => f.url === "/api/obsidian/note").length, 1);
    const rec = e.prompts.get("p_1");
    assert.deepEqual([rec.obsidianPendingFile, rec.obsidianSentAt, rec.obsidianFile], [NOTE, 100, NOTE],
      "every card of a request gets the marker: the update may have landed, so a link must not add it again");
  });

  test("a remembered path Marginalia could not have written is not used, and a recorded send wins over a reminder", async () => {
    const posted = [];
    const echo = server((url, init) => { const b = JSON.parse(init.body); posted.push(b.file); return { status: 200, body: { ok: true, file: b.file, created: true } }; });
    const bad = ["../x.md", "/abs/Griffiths.md", "Notes//Griffiths.md", "Notes/a:b.md", "Notes/Griffiths.txt", " Notes/x.md", 42, null];
    const e = env({ prompts: bad.map((f, i) => prompt({ id: "p_" + i, obsidianPendingFile: f }))
      .concat([prompt({ id: "p_both", obsidianSentAt: 100, obsidianFile: "Notes/Marginalia/Recorded.md", obsidianPendingFile: "Notes/Marginalia/Reminder.md" }),
        prompt({ id: "p_ok", obsidianPendingFile: "Books/Earlier name.md" })]), fetch: echo });
    for (let i = 0; i < bad.length; i++) await O.send("p_" + i, { fromGesture: true });
    await O.send("p_both", { fromGesture: true });
    await O.send("p_ok", { fromGesture: true });
    assert.deepEqual(posted, bad.map(() => NOTE).concat(["Notes/Marginalia/Recorded.md", "Books/Earlier name.md"]));
  });
});

// ------------------------------------------------------------------ FEATURES A9 (a single send)

describe("FEATURES A9: a single send and the marker of a server send that did not finish", () => {
  afterEach(() => { O._reset(); delete globalThis.location; delete globalThis.navigator; });
  const NOTE = "Notes/Marginalia/Griffiths.md";
  const held = (restart) => "1 card may already be in Obsidian: a send to Marginalia's server did not finish. " +
    (restart ? "Restart Marginalia (marginalia restart in Terminal)" : "Start Marginalia with the marginalia command") +
    " and send again: it checks the note and never adds a second copy.";
  const down = () => new Error("Failed to fetch");          // Marginalia's server stopped: obsidian:// links (not an older server)

  test("link (A9.1): a marked card is never sent — no link, no copy, the toast says why, with nothing to copy; the card keeps its marker", async () => {
    for (const over of [{ obsidianPendingFile: NOTE },                                                    // Send to Obsidian
      { obsidianPendingFile: NOTE, obsidianSentAt: 100, obsidianFile: NOTE, contentUpdatedAt: 200 }]) {   // Update in Obsidian
      const e = env({ prompts: [prompt(over)], fetch: down });
      const res = await O.send("p_1", { fromGesture: true });
      assert.deepEqual(res, { ok: false, mode: "link", file: NOTE, error: "a send to Marginalia's server did not finish" });
      assert.deepEqual([e.opened.length, e.copied.length, e.patches.length, e.saves.length], [0, 0, 0, 0]);
      const t = e.toasts[e.toasts.length - 1];
      assert.deepEqual([t.text, t.actions || [], t.ttl], [held(false), [], 12000]);
      assert.equal(e.prompts.get("p_1").obsidianPendingFile, NOTE);
      O._reset();
    }
  });

  test("link (A9.1): also above URI_LIMIT (nothing copied), without a gesture (no Add to Obsidian), and after an older server answered (restart)", async () => {
    let e = env({ prompts: [prompt({ obsidianPendingFile: NOTE, text: "Q. " + "w".repeat(70000) + "\nA. x" })], fetch: down });
    let res = await O.send("p_1", { fromGesture: true });
    await tick();
    assert.deepEqual([res.mode, res.error, e.copied.length, e.opened.length], ["link", "a send to Marginalia's server did not finish", 0, 0]);
    assert.equal(e.toasts[e.toasts.length - 1].text, held(false));
    O._reset();
    e = env({ prompts: [prompt({ obsidianPendingFile: NOTE })], fetch: down });
    res = await O.send("p_1", { fromGesture: false });
    assert.deepEqual([res.error, e.toasts.map((t) => t.text)], ["a send to Marginalia's server did not finish", [held(false)]], "no Ready for Obsidian toast");
    O._reset();
    e = env({ prompts: [prompt({ obsidianPendingFile: NOTE })] });          // GET /vaults 404 on 127.0.0.1: an older serve.py
    await O.send("p_1", { fromGesture: true });
    assert.equal(e.toasts[e.toasts.length - 1].text, held(true));
  });

  test("link: a card without the marker still goes, and so does one whose marker Marginalia could not have written", async () => {
    for (const over of [{}, { obsidianPendingFile: "../x.md" }, { obsidianPendingFile: 42 }]) {
      const e = env({ prompts: [prompt(over)], fetch: down });
      const res = await O.send("p_1", { fromGesture: true });
      assert.deepEqual([res.ok, res.mode, e.opened.length], [true, "link", 1], JSON.stringify(over));
      O._reset();
    }
  });

  test("server (A9.2): the marker is in place when the request leaves; the answer settles it", async () => {
    const cases = [
      [{ status: 200, body: { ok: true, file: NOTE, created: true } }, undefined, true],
      [{ status: 409, body: { ok: false, error: "the note is read-only (locked in Finder or chmod)" } }, undefined, false],
      [{ status: 413, body: { ok: false, error: "too large" } }, undefined, false],
      [{ status: 500, body: { ok: false, error: "unexpected error" } }, NOTE, false],
      [new Error("Failed to fetch"), NOTE, false]
    ];
    for (const [reply, marker, recorded] of cases) {
      let atRequest = null;
      const e = env({ fetch: server((url, init) => { atRequest = [e.prompts.get("p_1").obsidianPendingFile, e.writes]; return reply; }) });
      const res = await O.send("p_1", { fromGesture: true });
      await tick();
      const name = reply instanceof Error ? "no answer" : String(reply.status);
      assert.deepEqual(atRequest, [NOTE, 1], name + ": written ahead, before the request");
      assert.equal(res.ok, recorded, name);
      const p = e.prompts.get("p_1");
      assert.deepEqual([p.obsidianPendingFile, typeof p.obsidianSentAt, p.contentUpdatedAt], [marker, recorded ? "number" : "undefined", 1], name);
      O._reset();
    }
  });

  test("server (A9.2): a card that holds the marker already is not written ahead again, and a refusal leaves that earlier marker", async () => {
    const e = env({ prompts: [prompt({ obsidianPendingFile: NOTE })], fetch: server({ status: 409, body: { ok: false, error: "the note is read-only (locked in Finder or chmod)" } }) });
    await O.send("p_1", { fromGesture: true });
    assert.deepEqual([e.patches.length, e.prompts.get("p_1").obsidianPendingFile], [0, NOTE], "the earlier send's doubt stands");
  });

  test("server (A9.2): two sends of one card on their way at once — a refusal of one keeps the marker while the other may still write", async () => {
    const gates = [];
    const e = env({ fetch: server(() => null) });
    O._setFetch((url, init) => {
      e.fetches.push({ url, init });
      if (url === "/api/obsidian/vaults") return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(ONE_VAULT.body) });
      return new Promise((resolve, reject) => { gates.push({ resolve, reject }); });
    });
    const answer = (status, body) => ({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });
    const first = O.send("p_1", { fromGesture: true }), second = O.send("p_1", { fromGesture: true });
    for (let i = 0; i < 20 && gates.length < 2; i++) await tick();
    assert.equal(gates.length, 2, "both requests are on their way");
    assert.deepEqual([e.patches.length, e.prompts.get("p_1").obsidianPendingFile], [1, NOTE], "written ahead once");
    // (which request is whose does not matter: the gates open in the order the requests left)
    gates[0].resolve(answer(409, { ok: false, error: "the note is read-only (locked in Finder or chmod)" }));
    for (let i = 0; i < 5; i++) await tick();
    assert.equal(e.toasts.filter((t) => /^Could not add/.test(t.text)).length, 1, "one answered");
    assert.equal(e.prompts.get("p_1").obsidianPendingFile, NOTE, "the other request may still write: the marker stays");
    gates[1].resolve(answer(409, { ok: false, error: "the note is read-only (locked in Finder or chmod)" }));
    await Promise.all([first, second]);
    assert.equal("obsidianPendingFile" in e.prompts.get("p_1"), false, "both refused: back to no marker");
    // one with no answer, then a refusal of the other: the doubt of the first stands
    const third = O.send("p_1", { fromGesture: true }), fourth = O.send("p_1", { fromGesture: true });
    for (let i = 0; i < 20 && gates.length < 4; i++) await tick();
    assert.equal(gates.length, 4);
    gates[2].reject(new TypeError("Failed to fetch"));
    for (let i = 0; i < 5; i++) await tick();
    gates[3].resolve(answer(409, { ok: false, error: "the note is read-only (locked in Finder or chmod)" }));
    await Promise.all([third, fourth]);
    assert.equal(e.prompts.get("p_1").obsidianPendingFile, NOTE);
  });
});

// ------------------------------------------------------------------ repairs after the A9 review (2026-11-10)

describe("repairs: a send that left no telling, a tab that steps aside during a link send (the A9 review of 2026-11-10)", () => {
  afterEach(() => { O._reset(); delete globalThis.location; delete globalThis.navigator; });
  const NOTE = "Notes/Marginalia/Griffiths.md";
  const AGAIN = "Send it again once Marginalia's server answers: it checks " + NOTE + " and never adds a second copy.";

  test("D2: no answer, a 5xx or a 2xx that cannot be read — the card may be in the note: it says so and offers nothing to copy", async () => {
    const cases = [
      ["no answer", new Error("Failed to fetch"), "Marginalia's server did not answer"],
      ["500", { status: 500, body: { ok: false, error: "unexpected error" } }, "unexpected error"],
      ["502 not JSON", { status: 502, body: null }, "the server answered 502"],
      ["cut body", () => Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(new TypeError("network error")) }), "the server's answer could not be read"]
    ];
    for (const [name, reply, why] of cases) {
      const e = env({ fetch: server(typeof reply === "function" ? reply : () => reply) });
      const res = await O.send("p_1", { fromGesture: true });
      assert.deepEqual([res.ok, res.mode, res.file, res.error], [false, "server", NOTE, why], name);
      const t = e.toasts[e.toasts.length - 1];
      assert.deepEqual([t.text, t.detail, t.actions || [], t.ttl], ["May already be in Obsidian — " + why, AGAIN, [], 12000], name);
      assert.equal(e.prompts.get("p_1").obsidianPendingFile, NOTE, name + ": the marker stays");
      O._reset();
    }
  });

  test("D2: a definite refusal offers Copy note — unless an earlier send of the card did not finish (the note may hold it)", async () => {
    const refuse = server({ status: 409, body: { ok: false, error: "the note is read-only (locked in Finder or chmod)" } });
    let e = env({ fetch: refuse });
    await O.send("p_1", { fromGesture: true });
    let t = e.toasts[e.toasts.length - 1];
    assert.deepEqual([t.text, t.actions.map((a) => a.label)], ["Could not add to Obsidian — the note is read-only (locked in Finder or chmod)", ["Copy note"]]);
    O._reset();
    e = env({ prompts: [prompt({ obsidianPendingFile: NOTE })], fetch: refuse });
    await O.send("p_1", { fromGesture: true });
    t = e.toasts[e.toasts.length - 1];
    assert.deepEqual([t.text, t.actions || []], ["Could not add to Obsidian — the note is read-only (locked in Finder or chmod)", []]);
    assert.equal(e.prompts.get("p_1").obsidianPendingFile, NOTE);
  });

  test("D6: a tab that steps aside while a link send asks the server opens no link and records nothing", async () => {
    for (const cached of [false, true]) {
      let lock = null;
      const e = env({ fetch: (url) => { if (url === "/api/obsidian/vaults" && (!cached || e.fetches.length > 1)) lock = { reason: "othertab", by: "tab_b", at: 1 }; return { status: 404, body: {} }; } });
      M.store.locked = () => lock;
      if (cached) await O.detect();                      // a cached "link": the send checks the server again first
      const res = await O.send("p_1", { fromGesture: true });
      assert.deepEqual([res.ok, res.error, e.opened.length, e.patches.length], [false, "Marginalia is open in another tab", 0, 0], String(cached));
      O._reset();
    }
    // the toast's "Add to Obsidian" (no gesture at first) is refused the same way once the tab stepped aside
    let lock = null;
    const e = env();
    M.store.locked = () => lock;
    await O.send("p_1", { fromGesture: false });
    lock = { reason: "othertab", by: "tab_b", at: 1 };
    e.toasts[e.toasts.length - 1].actions[0].run();
    assert.deepEqual([e.opened.length, e.patches.length], [0, 0]);
  });
});

// ------------------------------------------------------------------ the switch (DECISIONS D32)

describe("the switch: the Obsidian connection is an option (DECISIONS D32)", () => {
  afterEach(() => { O._reset(); delete globalThis.location; delete globalThis.navigator; delete M.desktop; });
  const NOTE = "Notes/Marginalia/Griffiths.md";
  const written = () => server({ status: 200, body: { ok: true, file: NOTE, created: true } });
  const quiet = (e) => [e.fetches.length, e.opened.length, e.patches.length, e.saves.length, e.copied.length];
  const sent = (over) => prompt(Object.assign({ id: "p_2", obsidianSentAt: 50, obsidianFile: NOTE }, over || {}));

  test("enabled(): the stored choice; never chosen, on only while a record of the library holds a send record", () => {
    env({ settings: { obsidian: true } });
    assert.equal(O.enabled(), true, "chosen: on");
    env({ settings: { obsidian: false }, prompts: [prompt(), sent()] });
    assert.equal(O.enabled(), false, "chosen: off, whatever the library sent before");
    for (const never of [null, undefined]) {
      env({ settings: { obsidian: never } });
      assert.equal(O.enabled(), false, "never chosen, nothing sent before: off");
      env({ settings: { obsidian: never }, prompts: [prompt(), sent()] });
      assert.equal(O.enabled(), true, "a card was sent before: on");
      env({ settings: { obsidian: never }, prompts: [prompt(), sent({ deletedAt: 9 })] });
      assert.equal(O.enabled(), true, "also a card that was deleted since");
      env({ settings: { obsidian: never }, prompts: [prompt({ obsidianPendingFile: NOTE })] });
      assert.equal(O.enabled(), true, "a card whose send did not finish (the marker)");
      env({ settings: { obsidian: never }, prompts: [prompt({ obsidianSentAt: 0 }), prompt({ id: "p_3", obsidianPendingFile: "" }), prompt({ id: "p_4", obsidianSentAt: "yes" })] });
      assert.equal(O.enabled(), false, "no real send record");
    }
    env({ prompts: [prompt(), sent()] });
    delete M.settings;                                       // no settings module at all: the library decides
    assert.equal(O.enabled(), true);
    M.cache.prompts = () => { throw new Error("not loaded"); };
    assert.equal(O.enabled(), false, "a cache that cannot answer: off");
  });

  test("off: a send sends nothing (no request, no link, no marker, no record, nothing copied) and says where to turn it on", async () => {
    assert.equal(O.OFF, "The Obsidian connection is off — turn it on in Settings › Obsidian.");
    for (const fetch of [written(), undefined]) {            // server mode, then link mode (404)
      const e = env({ settings: { obsidian: false }, fetch });
      const res = await O.send("p_1", { fromGesture: true });
      assert.deepEqual(res, { ok: false, mode: null, file: null, error: O.OFF });
      assert.deepEqual(quiet(e), [0, 0, 0, 0, 0]);
      assert.equal(e.prompts.get("p_1").obsidianPendingFile, undefined, "no marker");
      assert.equal(e.toasts.length, 1);
      assert.equal(e.toasts[0].text, O.OFF);
      assert.deepEqual(e.toasts[0].actions || [], [], "nothing to copy or open");
      e.values.obsidian = true;                              // switched on in Settings
      assert.equal((await O.send("p_1", { fromGesture: true })).ok, true, "on: it goes");
      e.values.obsidian = false;
      const again = await O.send("p_1", { fromGesture: true });
      assert.equal(again.error, O.OFF, "off again: also for a card that was sent before");
    }
  });

  test("never chosen: a new library sends nothing; a library that sent a card before keeps sending", async () => {
    let e = env({ settings: { obsidian: null }, fetch: written() });
    assert.equal((await O.send("p_1", { fromGesture: true })).error, O.OFF);
    assert.deepEqual(quiet(e), [0, 0, 0, 0, 0]);
    e = env({ settings: { obsidian: null }, prompts: [prompt(), sent()], fetch: written() });
    const res = await O.send("p_1", { fromGesture: true });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(e.fetches.filter((f) => f.url === "/api/obsidian/note").length, 1);
  });

  test("a tab that stepped aside, and a browser page the app replaced, say so before the switch is looked at", async () => {
    let e = env({ settings: { obsidian: false }, fetch: written() });
    M.store.locked = () => ({ reason: "othertab", by: "tab_b", at: 1 });
    assert.equal((await O.send("p_1", { fromGesture: true })).error, "Marginalia is open in another tab", "its settings may be older");
    assert.deepEqual(quiet(e), [0, 0, 0, 0, 0]);
    M.store.locked = () => null;
    e = env({ settings: { obsidian: false }, fetch: written() });
    M.desktop = { mode: () => "cover" };
    assert.equal((await O.send("p_1", { fromGesture: true })).error, O.COVERED);
    assert.deepEqual(quiet(e), [0, 0, 0, 0, 0]);
    delete M.desktop;
    assert.equal((await O.send("p_1", { fromGesture: true })).error, O.OFF);
  });

  test("a toast's button that is clicked after the switch went off opens no link: Open in Obsidian, and Add to Obsidian of a send without a gesture", async () => {
    // server mode: the card is sent, the switch goes off, then "Open in Obsidian" is clicked
    let e = env({ fetch: written() });
    assert.equal((await O.send("p_1", { fromGesture: true })).ok, true);
    const openBtn = e.toasts[e.toasts.length - 1].actions.find((a) => a.label === "Open in Obsidian");
    e.values.obsidian = false;
    openBtn.run();
    assert.equal(e.opened.length, 0, "no obsidian://open link");
    assert.equal(e.toasts[e.toasts.length - 1].text, O.OFF);
    e.values.obsidian = true;
    openBtn.run();
    assert.equal(e.opened.length, 1, "on again: it opens the note");
    assert.match(e.opened[0], /^obsidian:\/\/open\?/);

    // link mode without a gesture: "Ready for Obsidian" waits for its button, and the switch goes off meanwhile
    e = env({});
    assert.equal((await O.send("p_1", {})).error, "needs_click");
    const add = e.toasts[e.toasts.length - 1].actions.find((a) => a.label === "Add to Obsidian");
    e.values.obsidian = false;
    add.run();
    await tick();
    assert.deepEqual([e.opened.length, e.patches.length, e.saves.length], [0, 0, 0], "no link, nothing recorded");
    assert.equal(e.prompts.get("p_1").obsidianSentAt, undefined);
    assert.equal(e.toasts[e.toasts.length - 1].text, O.OFF);
    e.values.obsidian = true;
    add.run();
    await tick();
    assert.equal(e.opened.length, 1, "on again: the link opens");
    assert.match(e.opened[0], /^obsidian:\/\/new\?/);
  });

  test("detect() still answers while the connection is off (Settings asks it when the switch goes on)", async () => {
    const e = env({ settings: { obsidian: false }, fetch: written() });
    const d = await O.detect({ force: true });
    assert.equal(d.mode, "server");
    assert.equal(e.fetches.length, 1);
  });
});
