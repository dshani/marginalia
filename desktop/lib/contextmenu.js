"use strict";
// The right-click menu (pure: a template for Menu.buildFromTemplate, made from the params of webContents'
// "context-menu" event). Electron shows no menu of its own, so without this a right-click does nothing while the card
// editor still underlines misspelled words. It offers what Brave offers for the same click, minus everything that
// navigates, saves or opens tools:
//   - on a misspelled word: up to five suggestions (replaceMisspelling), or "No Guesses Found", and "Add to Dictionary"
//   - in a text field: Cut, Copy, Paste, Paste and Match Style, Select All (each enabled as params.editFlags says;
//     Paste sends the page its paste event, as Cmd+V does)
//   - on selected text elsewhere: Copy
//   - on selected text: Look Up "<text>" (the macOS dictionary panel)
//   - on an image or a canvas (a PDF page, a snip): Copy Image
// No item for anything else (then no menu at all), and never Back, Reload, Save As, Print, Inspect or a link's items.
// buildTemplate(params, actions): actions = {replaceMisspelling(word), addToDictionary(word), lookUp(), copyImage(x, y)}.
const MAX_SUGGESTIONS = 5;
const LOOK_UP_CHARS = 24;

function short(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  return t.length > LOOK_UP_CHARS ? t.slice(0, LOOK_UP_CHARS - 1) + "…" : t;
}

function buildTemplate(params, actions) {
  const p = params || {};
  const a = actions || {};
  const call = (name, ...rest) => () => { if (typeof a[name] === "function") a[name](...rest); };
  const flags = p.editFlags || {};
  const selection = typeof p.selectionText === "string" ? p.selectionText.trim() : "";
  const groups = [];
  if (p.isEditable && p.misspelledWord) {
    const suggestions = (Array.isArray(p.dictionarySuggestions) ? p.dictionarySuggestions : []).slice(0, MAX_SUGGESTIONS);
    const spelling = suggestions.length
      ? suggestions.map((s) => ({ label: String(s), click: call("replaceMisspelling", String(s)) }))
      : [{ label: "No Guesses Found", enabled: false }];
    spelling.push({ label: "Add to Dictionary", click: call("addToDictionary", String(p.misspelledWord)) });
    groups.push(spelling);
  }
  if (p.isEditable) {
    groups.push([
      { role: "cut", label: "Cut", enabled: !!flags.canCut },
      { role: "copy", label: "Copy", enabled: !!flags.canCopy },
      { role: "paste", label: "Paste", enabled: !!flags.canPaste },
      { role: "pasteAndMatchStyle", label: "Paste and Match Style", enabled: !!flags.canPaste },
      { role: "selectAll", label: "Select All", enabled: !!flags.canSelectAll }
    ]);
  } else if (selection) {
    groups.push([{ role: "copy", label: "Copy", enabled: flags.canCopy !== false }]);
  }
  if (selection) groups.push([{ label: "Look Up “" + short(selection) + "”", click: call("lookUp") }]);
  if (p.mediaType === "canvas" || (p.mediaType === "image" && p.hasImageContents !== false)) {
    groups.push([{ label: "Copy Image", click: call("copyImage", Math.round(Number(p.x) || 0), Math.round(Number(p.y) || 0)) }]);
  }
  const out = [];
  for (const g of groups) {
    if (out.length) out.push({ type: "separator" });
    out.push(...g);
  }
  return out;
}

// The labels of a template, for the log and the self-test ("-" for a separator).
function labels(template) {
  return (template || []).map((i) => (i.type === "separator" ? "-" : String(i.label || i.role || "")));
}

module.exports = { buildTemplate, labels, MAX_SUGGESTIONS };
