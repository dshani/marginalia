"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { validHash, hashFromOpenUrl } = require("../lib/hash");

const BOOK = "3f5c2a9e0b1d4c6e8f7a9b0c1d2e3f4a";             // a PDF fingerprint
const SEPARATE = BOOK + ":431747d0";                         // a book added "as a separate book" (js/library.js separateId)
const LONG = "ab".repeat(70);                                // a fingerprint from a long trailer /ID (140 hex digits)
const DECK = "deck_2b1c7e3a-5d4f-4e2a-9b8c-0d1e2f3a4b5c";
const PROMPT = "p_9a8b7c6d-1e2f-4a3b-8c9d-0e1f2a3b4c5d";
const APP_JS = path.join(__dirname, "..", "..", "marginalia", "js", "app.js");

// js/app.js's own parseHash, taken from its source (the desktop folder sits beside marginalia/).
function webParseHash() {
  if (!fs.existsSync(APP_JS)) return null;
  const src = fs.readFileSync(APP_JS, "utf8");
  const start = src.indexOf("function parseHash(hash) {");
  assert.ok(start >= 0, "js/app.js has no parseHash");
  let depth = 0, end = -1;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) { end = i + 1; break; }
  }
  return vm.runInNewContext("(" + src.slice(start, end) + ")");
}

test("validHash keeps exactly the routes of js/app.js", () => {
  assert.equal(validHash("#library"), "#library");
  assert.equal(validHash(""), "#library");
  assert.equal(validHash("#"), "#library");
  assert.equal(validHash("library"), "#library");
  assert.equal(validHash("#deck/" + DECK), "#deck/" + DECK);
  assert.equal(validHash("#reader/" + BOOK), "#reader/" + BOOK);
  assert.equal(validHash("#reader/" + BOOK + "/" + PROMPT), "#reader/" + BOOK + "/" + PROMPT);
  assert.equal(validHash("#/reader/" + BOOK), "#reader/" + BOOK);
  assert.equal(validHash("#reader%2F" + BOOK), null);                               // one part "reader/…" is no route
  // the statistics page (js/app.js route "stats"): no ids; what follows is ignored, as parseHash ignores it
  assert.equal(validHash("#stats"), "#stats");
  assert.equal(validHash("stats"), "#stats");
  assert.equal(validHash("#/stats"), "#stats");
  assert.equal(validHash("#stats/"), "#stats");
  assert.equal(validHash("#stats/" + BOOK + "/" + PROMPT), "#stats");
  assert.equal(validHash("#statistics"), null);
  assert.equal(validHash("#stats%2Fx"), null);                                       // one part "stats/x" is no route
  assert.equal(hashFromOpenUrl("marginalia://open?hash=%23stats"), "#stats");
  assert.equal(hashFromOpenUrl("marginalia://open?hash=%23statistics"), "#library");
  assert.equal(validHash("#reader/" + encodeURIComponent(BOOK)), "#reader/" + BOOK);
});

test("validHash refuses unknown routes, bad ids and extra parts", () => {
  for (const bad of ["#review", "#review/all", "#settings", "#deck", "#deck/", "#reader", "#reader/", "#reader//" + PROMPT,
    "#reader/%E0%A4%A", "#reader/a%2Fb", "#reader/a%00b", "#reader/a%0Ab", "#reader/a%7Fb", "#library/x", "##reader/" + BOOK,
    "#reader/" + "x".repeat(5000), "#deck/../x", "#reader/./" + PROMPT, "#reader/" + BOOK + "/..", null, 42]) {
    assert.equal(validHash(bad), null, String(bad).slice(0, 80));
  }
});

test("validHash takes every book id the web app makes: a separate book's fingerprint:sha8, long fingerprints (R1)", () => {
  assert.equal(validHash("#reader/" + encodeURIComponent(SEPARATE) + "/" + PROMPT), "#reader/" + encodeURIComponent(SEPARATE) + "/" + PROMPT);
  assert.equal(validHash("#reader/" + SEPARATE), "#reader/" + encodeURIComponent(SEPARATE));          // an unencoded ":"
  assert.equal(validHash("#deck/" + encodeURIComponent(SEPARATE)), "#deck/" + encodeURIComponent(SEPARATE));
  assert.equal(validHash("#reader/" + LONG), "#reader/" + LONG);
  assert.equal(hashFromOpenUrl("marginalia://open?hash=" + encodeURIComponent("#reader/" + encodeURIComponent(SEPARATE) + "/" + PROMPT)),
    "#reader/" + encodeURIComponent(SEPARATE) + "/" + PROMPT);
  // js/obsidian.js encId also writes "(" and ")" as %28 and %29; a link the web app wrote reads back as the same ids
  assert.equal(validHash("#reader/a%28b%29/" + PROMPT), "#reader/a(b)/" + PROMPT);
});

test("validHash reads a hash as js/app.js parseHash does: a trailing slash, extra parts, other characters (R1)", () => {
  assert.equal(validHash("#reader/" + BOOK + "/"), "#reader/" + BOOK);
  assert.equal(validHash("#reader/" + BOOK + "/" + PROMPT + "/"), "#reader/" + BOOK + "/" + PROMPT);
  assert.equal(validHash("#deck/" + DECK + "/"), "#deck/" + DECK);
  assert.equal(validHash("#reader/a/b/c"), "#reader/a/b");                    // parseHash ignores what follows the prompt id
  assert.equal(validHash("#deck/a/b"), "#deck/a");
  assert.equal(validHash("#reader/a?x=1"), "#reader/a%3Fx%3D1");             // no such book: the web app then shows the library
  assert.equal(validHash("#reader/a b"), "#reader/a%20b");
  assert.equal(validHash("#reader/<script>"), "#reader/%3Cscript%3E");       // re-encoded: it stays inside the hash
});

test("every hash validHash passes on routes in js/app.js exactly where the original hash does", () => {
  const parseHash = webParseHash();
  if (!parseHash) return;
  const ids = [BOOK, SEPARATE, encodeURIComponent(SEPARATE), LONG, DECK, PROMPT, "a(b)", "a%28b%29", "x y", "%3Cb%3E", "é", "%C3%A9"];
  const hashes = ["", "#", "#library", "#review", "#/reader/" + BOOK];
  for (const a of ids) {
    hashes.push("#reader/" + a, "#deck/" + a, "#reader/" + a + "/", "#deck/" + a + "/x");
    for (const b of ids) hashes.push("#reader/" + a + "/" + b, "#reader/" + a + "/" + b + "/", "#reader/" + a + "/" + b + "/c");
  }
  for (const h of hashes) {
    const want = parseHash(h);
    const got = validHash(h);
    if (got === null) { assert.equal(want.screen, "library", h); continue; }
    assert.deepEqual(JSON.parse(JSON.stringify(parseHash(got))), JSON.parse(JSON.stringify(want)), h + " → " + got);
  }
});

test("hashFromOpenUrl reads marginalia://open?hash=…", () => {
  assert.equal(hashFromOpenUrl("marginalia://open?hash=" + encodeURIComponent("#reader/" + BOOK + "/" + PROMPT)), "#reader/" + BOOK + "/" + PROMPT);
  assert.equal(hashFromOpenUrl("marginalia://open?hash=reader/" + BOOK), "#reader/" + BOOK);
  assert.equal(hashFromOpenUrl("marginalia://open/?hash=%23deck%2F" + DECK), "#deck/" + DECK);
  assert.equal(hashFromOpenUrl("marginalia://open?hash=#reader/" + BOOK), "#reader/" + BOOK);   // an unencoded "#"
  assert.equal(hashFromOpenUrl("marginalia:open?hash=library"), "#library");
});

test("hashFromOpenUrl opens the library for anything else", () => {
  for (const url of ["marginalia://open", "marginalia://open?hash=", "marginalia://open?hash=%23review", "marginalia://other?hash=library",
    "marginalia://open/x?hash=%23reader%2Fabc", "obsidian://open?hash=%23reader%2Fabc", "https://127.0.0.1:8765/#reader/abc",
    "marginalia://open?hash=%23reader%2F..%2F..", "marginalia://open?hash=javascript:alert(1)", "not a url", "",
    "marginalia://open?hash=" + "a".repeat(5000), undefined]) {
    assert.equal(hashFromOpenUrl(url), "#library", String(url).slice(0, 80));
  }
});

test("every hash the web app writes (M.app.hashFor) passes, read from js/app.js itself", () => {
  const appJs = path.join(__dirname, "..", "..", "marginalia", "js", "app.js");
  if (!fs.existsSync(appJs)) return;   // the desktop folder sits beside marginalia/
  const src = fs.readFileSync(appJs, "utf8");
  assert.match(src, /return "#deck\/" \+ encodeURIComponent\(cid\);/);
  assert.match(src, /return "#reader\/" \+ encodeURIComponent\(cid\);/);
  assert.match(src, /return "#library";/);
  assert.match(src, /if \(\(screen === "deck" \|\| screen === "reader"\) && parts\[1\]\)/);
});
