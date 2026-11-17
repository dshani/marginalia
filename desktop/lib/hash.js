"use strict";
// marginalia://open?hash=<hash> → the hash the main window goes to (pure).
//
// Only the routes js/app.js knows are passed on, read as its parseHash reads them: a leading "#" and then "/" are
// dropped, the rest is split at "/" and each part percent-decoded; "#deck/<collectionId>" and "#reader/<collectionId>"
// or "#reader/<collectionId>/<promptId>" are routes (parts after those are ignored, as parseHash ignores them, and so is
// a trailing "/"); "#stats" is the statistics page (it has no ids; parts after it are ignored); "#library" and "" are
// the library. Anything else, including a malformed or unknown link, opens the
// library. "#review" is not a route of js/app.js (a review is an overlay started from the library or a deck), so it
// opens the library, which is what the web app itself does with it.
// Ids are taken as the web app makes them, whatever their characters: a book's PDF fingerprint (hex, of any length)
// or SHA-256, a book added "as a separate book" (fingerprint + ":" + 8 hex digits, js/library.js), "deck_<uuid>",
// "p_<uuid>". An id is refused only when it cannot be one: empty, "." or "..", a "/" or a control character once
// decoded, or percent-encoding that does not decode. The hash is then written again with each id percent-encoded
// (encodeURIComponent), so nothing in an id can leave the hash.
const LIBRARY = "#library";
const STATS = "#stats";
const MAX_URL = 4096;
const BAD_ID_RE = /[\u0000-\u001f\u007f-\u009f/]/;

function decodePart(p) {
  try { return decodeURIComponent(p); } catch (e) { return null; }
}

function goodId(id) {
  return typeof id === "string" && id.length > 0 && id !== "." && id !== ".." && !BAD_ID_RE.test(id);
}

// validHash("#reader/abc/p_1") → "#reader/abc/p_1"; null when it is not a route the web app knows.
function validHash(raw) {
  if (typeof raw !== "string" || raw.length > MAX_URL) return null;
  let s = raw;
  if (s.charAt(0) === "#") s = s.slice(1);
  if (s.charAt(0) === "/") s = s.slice(1);
  if (s === "" || s === "library") return LIBRARY;
  const parts = s.split("/").map(decodePart);
  const screen = parts[0];
  if (screen === "stats") return STATS;                            // the statistics page: no ids, as parseHash reads it
  if (screen !== "deck" && screen !== "reader") return null;
  const ids = screen === "deck" ? parts.slice(1, 2) : parts.slice(1, 3);
  if (ids.length > 1 && ids[1] === "") ids.pop();                 // "#reader/<id>/": no prompt, as in parseHash
  if (!ids.length || !ids.every(goodId)) return null;
  try {
    return "#" + screen + "/" + ids.map((id) => encodeURIComponent(id)).join("/");
  } catch (e) { return null; }                                    // a lone surrogate cannot be encoded
}

// hashFromOpenUrl("marginalia://open?hash=%23reader%2Fabc") → "#reader/abc"; "#library" for anything else.
function hashFromOpenUrl(url) {
  if (typeof url !== "string" || url.length > MAX_URL) return LIBRARY;
  let u;
  try { u = new URL(url); } catch (e) { return LIBRARY; }
  if (u.protocol !== "marginalia:") return LIBRARY;
  const target = u.host ? u.host + u.pathname : u.pathname;
  if (target !== "open" && target !== "open/") return LIBRARY;
  let h = u.searchParams.get("hash");
  if (!h && u.hash) h = u.hash;                // marginalia://open?hash=#reader/… (the "#" was not encoded)
  if (!h) return LIBRARY;
  return validHash(h) || LIBRARY;
}

module.exports = { validHash, hashFromOpenUrl, LIBRARY, MAX_URL };
