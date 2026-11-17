# Marginalia — Design A: Fidelity First

Angle A reproduces Andy Matuschak's prototype reader from the 2023 Griffiths video as closely as the research allows and fills every gap with Orbit's documented behaviour (scheduler, review buttons, starburst). The decisions file (D1–D21) and the requirements addendum (R1–R7) are binding; where a choice remains, this design picks what the prototype did.

## 1. Product summary

1. Open Marginalia: the home screen lists every book ever read and every hand-made deck, with "Review 23 due" at the top.
2. "Continue reading" on *Griffiths* loads the PDF from IndexedDB and scrolls to page 36 at 125%, with a wide right margin.
3. Drag over "a potential energy function", press N: the passage turns yellow and an editor card opens in the margin, level with it.
4. Type `Q. What does V stand for?` / `A. The potential energy function.`; Cmd+Enter saves; the card settles in: star glyph, question, answer in lighter type.
5. For an equation press S and drag a rectangle; the LaTeX (or PNG, per the mode chosen once) lands on the clipboard; Cmd+V pastes it into the next card.
6. Cloze: select a sentence, N, wrap the hidden span in braces; each brace becomes its own card.
7. Press T at a stopping point: warm paper covers the viewer; "Griffiths · Ch. 1 · The Wave Function" sits quietly above a large question; Space shows the answer, 1/2 grades it; the star glyph's ray lengthens to "5d".
8. Forgotten prompts return at the end of the same session; "All caught up" closes it.
9. Five days later the home screen says "Review 23 due": a global session interleaves prompts from every book and deck; G jumps back to the highlighted passage.
10. Everything lives in this browser's IndexedDB; JSON, Anki and Markdown exports leave by file or clipboard.

## 2. Screens & layout

Three screens (Library, Reader, Deck) and one overlay (Review) in one `index.html`, switched by `app.route()`. Widths are CSS px at 1280.

**Library (home)**

```
┌──────────────────────────────── 1280 ─────────────────────────────────┐
│ Marginalia                 [ Review 23 due ]  [Add PDF] [New deck] [⚙] │ 56
│ BOOKS (column max 880, centred)                                       │
│ │ Griffiths ✎  322 pages · 41 prompts · 7 due · p. 36  [Continue reading] ⋯ │ 64
│ DECKS                                                                 │
│ │ Thermo formulas  18 prompts · 3 due                  [Open] [Review] ⋯ │
└───────────────────────────────────────────────────────────────────────┘
```

**Reader** — toolbar 44 px; below it one scroll container (`#scroller`) with a flex row: left gutter (flex 1, min 24), page column (= rendered page width), margin column (288 = 16 + 256 card + 16). The margin is one absolutely positioned layer as tall as the document, so a card is just a `top` value.

```
┌ [‹ Library]  Griffiths ✎   12 / 322   [−] 125% [+] [⊡]   [✂ Snip] [Image│LaTeX]   [Review ▾] [?] ┐ 44
├──────────┬──────────────────────────────────────────────┬────────────────────┤
│ gutter   │ page column 816 (Letter at PDF.js 100%)       │ margin 288         │
│ ≥ 24     │ ┌──────────────────────────────────────────┐ │   ┌──────256─────┐ │
│          │ │ …where V(x,t) is ███a potential energy███ │ │   │✦ What does V │ │
│          │ │ ███function███. As in classical mech…     │ │   │  stand for…? │ │
│          │ │        $$ i\hbar\frac{\partial\Psi}…$$    │ │   │  The potent… │ │
│          │ │ ███Planck's constant███ …                 │ │   └──────────────┘ │
│          │ └──────────────────────────────────────────┘ │   ┌──────────────┐ │
│          │                                               │   │{} Planck's…  │ │
```

Default zoom is fit-width of the page column, clamped to PDF.js scale 0.5–4; the readout shows PDF.js percent (scale ÷ 1.3333), about 125% for Letter at 1280 px, as in the video.

**Review overlay** — `position: fixed; inset: 0`, warm paper, 640-px column centred.

```
┌──────────────────────────── warm paper (--review-bg) ──────────────────────┐
│ ✺━━━━━━━━●━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━              Exit review ✕    │ 56
│     5d    2wk     1mo      2mo       4mo        1yr          (12 px labels) │
│                                                                              │
│            GRIFFITHS · CH. 1 · THE WAVE FUNCTION                 12 px caps  │
│            What is the Schrödinger equation?                     36/42       │
│                                                                              │
│            [answer fades in after Space; source passage below it, muted]     │
│                                                                              │
│            ┌────────────────────── 640 ──────────────────────┐              │
│            │ [ Show answer   ␣ ]                   [ Skip  S ] │ 56          │
│            └─────────────────────────────────────────────────┘              │
└──────────────────────────────────────────────────────────────────────────────┘
```

After reveal the bar becomes `[ Forgot  1 ]  [ Remembered  2 ]`, two equal halves.

**Below 900 px (rail)** — the margin becomes a 40-px rail of 24-px markers, one per bucket (anchors within 60 px merge; a badge counts them); hover, focus or tap opens one card as a popover (`max-width: min(320px, 100vw − 32px)`); the page fits `W − 64`; zoom and review move into `⋯`.

**At 400 px (stack)** — no rail; a 16-px badge at the end of each highlighted span marks its card; tap or Enter opens a bottom sheet (`position: fixed; bottom: 0; max-height: 60vh`) with the card or editor; the page fits `W − 32` with zoom clamped to fit, so nothing scrolls horizontally. Toolbar: `[‹] [title] [12/322] [✂] [⋯]`. The overlay keeps a `100vw − 32px` column.

## 3. Interactions & keyboard

**Open PDF**: "Add PDF", Cmd/Ctrl+O or a dropped file; bytes are hashed (SHA-256) and stored in 8 MiB chunks before PDF.js gets (and detaches) them; the reader opens at the saved position. **Select → create**: a drag on the text layer shows the adder `Prompt N` · `Highlight H` and computes the anchor at once; N pins an editor card at the anchor's y (no selection or a margin double-click: a free note at that y); H makes a plain highlight with a margin tick, convertible later with N. **Edit**: Enter on a focused card edits in place; Cmd/Ctrl+Enter saves, Esc cancels (a new card is discarded, an existing one reverts), blur saves a non-empty draft. **Delete**: Backspace tombstones the record (`deletedAt`) and shows "Prompt deleted — Undo (Z)" for 8 s; Z or the button clears `deletedAt`; tombstones stay 30 days for import merges. **Navigate**: J/K move focus through cards in document order, G scrolls the passage to one third of the viewport, clicking a highlight focuses its card. Zoom keeps the scroll fraction.

| Action | Key | UI |
|---|---|---|
| Open PDF | Cmd/Ctrl+O | Add PDF, drop file |
| Prompt for selection / free note | N | adder, double-click margin |
| Plain highlight | H | adder |
| Save / cancel editor | Cmd/Ctrl+Enter / Esc | Save, ✕ |
| Wrap selection as cloze | Cmd/Ctrl+Shift+C | editor `{}` button |
| Edit / delete focused card | Enter / Backspace | card menu |
| Undo delete | Z (toast visible) | toast |
| Next / previous card | J / K | — |
| Go to passage | G | card icon |
| Flag ("sigh") | F | card menu |
| Toggle answers in margin | A | ⋯ menu |
| Snip / toggle snip mode | S / Shift+S | ✂, segmented control |
| Zoom in / out / fit | Cmd/Ctrl+= / − / 0 | − 125% + ⊡ |
| Go to page / find | P / Cmd/Ctrl+F (Enter, Shift+Enter) | page box, find bar |
| Mark chapter start here | C | ⋯ menu |
| Review book / today / all | R / T / Shift+R | Review ▾ |
| Shortcut sheet | ? | [?] |

**Focus**: `#reader` has `tabindex=-1` and takes focus on open and after every editor close, so Cmd+V and single keys reach it. `keys.handle` ignores bindings when `event.target` is a text field, except those marked `inField` (Cmd/Ctrl+Enter, Esc, Cmd/Ctrl+Shift+C, Cmd/Ctrl+P). Cards use roving `tabindex`; popovers trap Tab and return focus on Esc. Confirmations go through the in-page `app.confirm()`, never `alert/confirm/prompt`.

## 4. Prompt model & syntax

One text box per card (D5). `prompts.parse(text)` decides the kind:

- **Q/A**: a line starting `Q.` and a later line starting `A.`; question = lines up to `A.`, answer = the rest (multi-line allowed).
- **Cloze**: no `Q./A.` and at least one `{…}` outside a math run. Body = whole text; deletions = brace spans in order; `\{` is a literal brace. Each deletion is a component with its own schedule. The question side shows the body with that deletion as a blank (`______`, width ≈ the hidden text) and the other deletions as plain text; the answer side shows the hidden span on yellow. No hints in v1.
- **Note**: neither pattern → a margin note, shown, never reviewed.
- **Highlight**: empty text, kind `highlight`: a yellow mark and a margin tick, convertible later.

Cloze entry: type braces, or select text in the textarea and press Cmd/Ctrl+Shift+C; the preview renders the first component masked and says "3 cards". Math runs are tokenised first (§16), so `\frac{a}{b}` never becomes a deletion and a `{…}` containing `$` is masked as a whole.

Tags: `#word` tokens on the last line go into `tags`, shown as chips and searchable in the prompt list; `flagged` (F in reader and review) feeds a "Flagged" filter. Non-blocking lints: question over 25 words, answer over 15, yes/no question, multi-sentence cloze, empty answer.

## 5. Anchoring & highlight rendering

Stored per prompt (`anchor`, `null` for deck prompts):

```json
{ "rects": [[11, 72.0, 640.2, 300.5, 652.1], [11, 72.0, 626.0, 180.4, 638.3]],
  "quote": "a potential energy function", "prefix": "where V(x,t) is ", "suffix": ". As in classical",
  "items": { "start": { "item": 12, "offset": 17 }, "end": { "item": 13, "offset": 8 } },
  "pageIndex": 11, "y": 652.1, "lost": false }
```

Each rect is `[pageIndex, x1, y1, x2, y2]` in PDF user space (y up), built by `anchors.fromSelection`: `range.getClientRects()` → clip per page → merge fragments on one line (vertical overlap > 50%) → `viewport.convertToPdfPoint` on both corners → `Util.normalizeRect`. A cross-page selection stores rects for every page; `pageIndex` is the first rect's page. `quote` (≤ 300 chars) is the normalised selection text, `prefix`/`suffix` 32 chars of surrounding text, `items` PDF.js text-item indices. A free margin note has `rects: []`, `quote: ""` and `y` = the PDF y of the double-click.

**Drawing**: each page gets `<div class="highlightLayer">` between canvas and text layer (`z-index: 1; pointer-events: none; mix-blend-mode: multiply`); each rect becomes `<div class="hl" data-id>` positioned in percent of the page box from `Util.normalizeRect(viewport.convertToViewportRectangle(rect))`. `--hl` (#ffe66d) multiplied over the white page gives the video's yellow; `.is-active` uses `--hl-active`. Text-layer clicks are hit-tested against the rects to focus the card; hovering a card marks its rects active and vice versa.

**Re-finding**: a prompt with empty rects but a quote is relocated when its page's text arrives: find the normalised quote in the page text index (prefix/suffix disambiguate; pages ±1 are tried) and rebuild rects from item boxes (`x = e`, `y1 = f + descent·h`, `y2 = f + ascent·h`, proportional x inside partial items). On failure `lost: true`: the card sits at the page top with a dashed left rule and the tooltip "Passage not found in this file".

## 6. Margin layout algorithm

Cards are 256 px wide, absolutely positioned in the margin layer, sorted by `(anchorY, createdAt)`. Heights come from a `ResizeObserver` per card (estimated until measured). `GAP = 8`, `MAX_DRIFT = 320`, `MARKER_H = 24`.

```
anchorY(c):  r = viewport[c.pageIndex].convertToViewportRectangle(c.rects[0] or [0,c.y,0,c.y])
             return pageTop[c.pageIndex] + min(r[1], r[3])

layout(cards, activeId):
  // A: forward cascade — every card at or below its anchor
  prev = -Inf
  for c in cards: c.top = max(c.anchorY, prev + GAP); prev = c.top + c.height
  // B: the active (edited/focused) card is pinned; push the minimal chain above it UP
  if active = cards[activeId]:
    active.top = active.anchorY; limit = active.top - GAP
    for c in cards before active, reversed:
      if c.top + c.height <= limit: break
      c.top = limit - c.height; limit = c.top - GAP
    if cards[0].top < 0: shift = -cards[0].top; for c in cards[0..active]: c.top += shift   // no room above
    prev = active.top + active.height
    for c in cards after active: c.top = max(c.anchorY, prev + GAP); prev = c.top + c.height
  // C: degrade instead of drifting
  for c in cards: c.collapsed = (c !== active && c.top - c.anchorY > MAX_DRIFT); if collapsed: c.height = MARKER_H
  if any collapsed changed: rerun A/B once (heights only shrink, so it converges)
```

Relayout is O(n) and runs on page-size arrival, zoom, card resize, add/delete and focus change; `top` animates over 120 ms except while typing. A collapsed card is a one-line marker (glyph + first 40 characters) that expands in place on hover or focus. A 1-px connector from highlight to card appears only while the card is hovered, focused or edited and `top ≠ anchorY`. While editing, the card is `active`: pinned to its anchor, growing with the textarea, neighbours moving aside. Card anatomy: 16-px glyph column (✦ Q/A, `{}` cloze, ▭ note), question 14/20 `--ink` Outfit 500, answer 13/18 `--ink-2`, no border; hover/focus adds a 3-px yellow left rule; "Hide answers in margin" (A) drops the answer line.

## 7. Review mode & scheduler

**Queue** (`review.start({scope, collectionId, now})`): every live `qa`/`cloze` prompt in scope contributes one item per component `k` with `isDue(component, now)` (scope `today`: `createdAt ≥ local midnight` instead). Book, deck and today scopes keep reading order `(pageIndex, anchor.y)` (decks: `createdAt`); scope `all` sorts by local due day and shuffles inside each day with a mulberry32 PRNG seeded by `startedAt`, so books interleave. No cap (D9).

**Scheduler** (`Marginalia.scheduler`, a verbatim port of Orbit's, Apache-2.0, attributed in the file header):

```
DAY = 86_400_000; GROWTH = 2.3; FIRST = 5*DAY; RETRY = 10*60_000; LOOKAHEAD = 16*3_600_000
LEGEND = FIRST·2.3^k, k=0..5 → "5d" "2wk" "1mo" "2mo" "4mo" "1yr"
newSchedule(now) = {createdAt: now, lastReviewedAt: null, intervalMs: 0, dueAt: now, log: []}
jitter(now) = (now % 1000) * 600                      // deterministic, < 10 min
isDue(s, now) = s.dueAt <= now + LOOKAHEAD
grade(s, now, outcome):                                // outcome ∈ {"remembered","forgot"}
  elapsed = max(0, now - (s.lastReviewedAt ?? s.createdAt))
  if remembered: grown = floor(elapsed*GROWTH)
                 interval = elapsed < s.intervalMs ? max(s.intervalMs, FIRST, grown) : max(FIRST, grown)
                 due = now + jitter(now) + interval
  else:          interval = s.intervalMs < FIRST ? s.intervalMs : max(FIRST, floor(s.intervalMs/GROWTH))
                 due = now + jitter(now) + RETRY
  return {...s, lastReviewedAt: now, intervalMs: interval, dueAt: due, log: s.log ++ [{at: now, outcome}]}
replay(createdAt, log) = fold grade over log from newSchedule(createdAt)
```

A new prompt is due immediately (Orbit's "in-text" stop), so T works in the same session; Forgot steps back one rung and re-asks in ten minutes.

```
mark(outcome, now):
  it = queue[index]; undo = {it, prev: it.component}
  it.component = grade(prev, now, outcome); prompt.nextDueAt = min(components.dueAt); store.prompts.put(prompt)
  index++
  if index == queue.length: queue.push(...items.filter(i => isDue(i.component, now) && i not in queue[index..]))
  if index == queue.length: finish()
skip(): queue.push(queue.splice(index, 1)[0])            // no grade, no log entry
undo(): restore prev into the prompt, store it, index--, drop the retry copy if one was appended
```

**Grading UI**: Orbit's flow: `Show answer` (flex 1) + small `Skip`; after reveal `Forgot` | `Remembered`, half width each, with a `<kbd>` cap showing its binding; holding a grading button previews the next interval in the legend (`scheduler.preview`). Q/A cards: context line, question at 36/42 (smaller above 140 and 300 characters), the answer springing in below, then the source quote, muted, with `Go to source  G` (hidden for deck prompts) and `Copy question LaTeX`. Cloze cards show the masked body; reveal cross-fades to the highlighted span.

**Interval indicator**: an inline SVG starburst as in Orbit: one 3-px tapered ray per session item around a centre pushed off-screen left (`cx = −r + 18`, `cy = 30`), rotated so the current ray points right; ray length = `lerp(log2(interval), log2(5d), log2(322d), 0.1, 1) × r` (0 for new); pending rays `--review-line`, graded `--review-accent-2`, current `--review-accent`. Legend ticks sit on the horizontal ray at the ladder, future labels muted; the present stop is the last with interval ≤ 1.1 × current.

**Keyboard (R7)**: actions `showAnswer, forgot, remembered, undo, skip, goToSource, exit`. Presets: Default `Space 1 2 U S G Esc`, Arrows `Space ← → U S G Esc`, Vim `Space j k u s g q`, Anki-like `Space 1 3 Z S G Esc`. Settings › Review shortcuts is a seven-row table: click a key cap ("Press a key…"), the next `keydown` is captured as `{key, meta, ctrl, shift, alt}` (letters lower-cased, repeats ignored), Esc cancels; a binding used twice turns both caps red ("also used by Forgot"); a preset menu and "Reset to default" sit above the table. Bindings live in `settings.reviewKeys` (localStorage) and in the backup; reader bindings share the descriptor shape under `keys.scopes.reader`, so they can become editable later. The `?` sheet lists both scopes; nothing fires inside text fields.

**End of session**: "All caught up! 12 reviewed · 10 remembered · 2 forgot (re-asked) · next due in 5 days" with `Back to reading` / `Back to library`; Esc exits any time. **Go to source** suspends the session in memory, opens the reader on the prompt's book, scrolls the passage to one third of the viewport, pulses the highlight 1.2 s and focuses the card; a toolbar pill `Resume review · 7 left` restores the overlay.

## 8. Persistence & data model

All persistence sits behind `Marginalia.store` (D1); nothing else touches `indexedDB` or `localStorage`. Database `marginalia`, `DB_VERSION = 1`:

| Store | Key | Indexes |
|---|---|---|
| `collections` | `id` | `byKind` |
| `chunks` | `[docId, i]` | — |
| `prompts` | `id` | `byCollection` (`collectionId`), `byDue` (`nextDueAt`) |
| `attachments` | `id` | — |
| `meta` | `key` | — |

Book ids are `pdf.fingerprints[0]`; deck ids `"deck-" + randomUUID()`; prompt and attachment ids `randomUUID()`. PDF bytes are 8 MiB `ArrayBuffer` slices (never Blobs or subarray views), clear of Chromium's 127 MiB per-value cap and WebKit's Blob bugs.

```json
{ "id": "92b1cb8763aadc6ce1ffa7f4e9ff1171", "kind": "book", "name": "Griffiths",
  "title": "Introduction to Quantum Mechanics", "fileName": "griffiths.pdf", "sha256": "9f…", "byteLength": 52428800,
  "chunkCount": 7, "chunkSize": 8388608, "hasBytes": true, "pageCount": 322, "pageLabels": null,
  "sections": [{ "title": "Ch. 1 · The Wave Function", "pageIndex": 10, "level": 1, "manual": false }],
  "lastPosition": { "pageIndex": 35, "fraction": 0.4 }, "zoom": "fit",
  "addedAt": 1762150000000, "lastOpenedAt": 1762160000000, "updatedAt": 1762160000000, "deletedAt": null }
{ "id": "6f1c…", "collectionId": "92b1…", "kind": "cloze",
  "text": "The {wave function} $\\Psi(x,t)$ solves the {Schrödinger equation}. #qm",
  "front": "The ______ Ψ(x,t) solves…", "back": "wave function", "tags": ["qm"], "flagged": false,
  "anchor": { "rects": [[11, 72.0, 640.2, 300.5, 652.1]], "quote": "…", "prefix": "…", "suffix": "…",
              "items": { "start": { "item": 12, "offset": 3 }, "end": { "item": 14, "offset": 9 } }, "pageIndex": 11, "y": 652.1, "lost": false },
  "context": { "docName": "Griffiths", "sectionLabel": "Ch. 1 · The Wave Function", "pageIndex": 11, "pageLabel": "12" },
  "components": [ { "createdAt": 1762150000000, "lastReviewedAt": 1762150900000, "intervalMs": 432000000, "dueAt": 1762583100000,
                    "log": [{ "at": 1762150900000, "outcome": "remembered" }] } ],
  "nextDueAt": 1762150000000, "createdAt": 1762150000000, "updatedAt": 1762150900000, "deletedAt": null }
{ "id": "a7d2…", "mime": "image/png", "data": "<ArrayBuffer>", "width": 2400, "height": 480, "bytes": 183002, "createdAt": 1762150000000 }
{ "docId": "92b1…", "i": 0, "bytes": "<ArrayBuffer 8388608>" }      { "key": "dataVersion", "value": 1 }
```

`front`/`back` are derived at save; `context` is a snapshot (§14); `components` holds one schedule per cloze deletion. Settings live in localStorage under `marginalia.settings` (`theme, dimPages, marginAnswers, marginMode, snipMode, reviewKeys, visionModel`), the API key apart under `marginalia.apiKey` so backups exclude it; every access is in `try/catch` with defaults.

**Autosave**: card text on Cmd+Enter or blur; grades inside `mark()`; `lastPosition` 1 s after scrolling stops; nothing on `unload`. **Fallback**: if `indexedDB.open` throws (`SecurityError` in a sandboxed frame) or fails, `store` swaps in a `Map`-backed implementation with the same API and shows "Storage unavailable in this view — export often"; `db.onclose` drops the cached connection so the next call reopens (Safari).

**Migration**: `MIGRATIONS[v](db, tx, oldVersion)` keyed by target version, run in order inside `upgradeneeded`; `meta.dataVersion` drives lazy data migrations after open. `onversionchange` closes the connection behind a reload banner; `onblocked` asks to close other tabs. `navigator.storage.persist()` is called from the "Add PDF" click; the library footer shows persistence and usage and, on Safari, a 7-day-eviction warning.

## 9. Export/import

`exporter` builds every export as a string synchronously from in-memory records, so `navigator.clipboard.writeText` can run inside the click handler. `deliver(filename, text)` tries the Artifact `downloads` capability (`claude.use("downloads")` → `save({filename, data})`), then `<a download>` with a Blob URL; the dialog always also offers `Copy to clipboard` and a pre-selected read-only `<textarea>`. Scopes: everything, one book, one deck.

**JSON backup** (`marginalia-backup.json`):

```json
{ "format": "marginalia", "version": 1, "exportedAt": "2026-11-03T19:04:00Z", "scope": "all",
  "settings": { "reviewKeys": {}, "snipMode": "latex", "marginAnswers": true },
  "collections": [ { "id": "92b1…", "kind": "book", "name": "Griffiths", "sha256": "9f…", "byteLength": 52428800, "pageCount": 322, "sections": [] } ],
  "prompts": [ "…full records including components and logs…" ],
  "attachments": [ { "id": "a7d2…", "mime": "image/png", "width": 2400, "height": 480, "dataUrl": "data:image/png;base64,…" } ] }
```

No PDF bytes, no API key. **Anki TSV**: `marginalia-basic.txt` (Front, Back, Tags) and `marginalia-cloze.txt` (Text, Back Extra, Tags), each starting `#separator:tab`, `#html:true`, `#tags column:3`; `$$…$$` → `\[…\]`, `$…$` → `\(…\)`, `{x}` → `{{c1::x}}` numbered per deletion, newlines → `<br>`, tabs removed, `![snip](att:id)` → `<img src="data:…">`; tags = `marginalia`, nickname and section slugs, the prompt's own. **Markdown**: `# Nickname`, `## Ch. 1 · The Wave Function`, one paragraph per prompt in Andy's syntax (`Q.`/`A.` lines or the cloze paragraph), images as `![snip](data:…)`, each prompt followed by `*(p. 12)*`.

**Import** (file input or paste box): validate `format`/`version`; unknown collections are created (books with `hasBytes: false`, matched by id then sha256 when the PDF is added later); prompts merge by id: missing → added; present → text, anchor, tags, flagged and context from the newer `updatedAt`; schedules = union of each component's log entries by `at`, replayed through `scheduler.replay`; a tombstone wins when its `deletedAt` is newer than the other side's `updatedAt`. Result: "41 added · 3 updated · 2 skipped" in-page.

## 10. Architecture & files

Classic scripts, loaded in this order; `js/x.js` defines `window.Marginalia.x`, and pure modules also do `if (typeof module === "object") module.exports = api` for node tests.

```
index.html  css/tokens.css  css/app.css  tools/bundle.py  test/*.test.js
js/util.js        uuid, sha256, debounce, escapeHtml, mulberry32, localDay
js/bus.js         on/emit;                     js/settings.js   get/set/onChange, apiKey get/set/forget
js/store.js       IndexedDB behind one API
js/scheduler.js   Orbit port (pure);           js/prompts.js    parser, cloze masking, tokeniser (pure)
js/context.js     outline → sections, labels (pure);   js/math.js   KaTeX + tokens → safe HTML
js/keys.js        key map, presets;            js/reader.js     PDF.js pages, text layers, zoom, find, region render
js/anchors.js     selection → anchor, highlights, re-find;   js/margin.js   layout, cards, editor, adder
js/attachments.js paste/drop → stored image, GC;            js/vision.js   transcription backends
js/snip.js        snip mode, capture, clipboard, toast;      js/review.js   session, overlay, starburst
js/library.js     home, deck page, settings;   js/exporter.js   JSON/TSV/Markdown, import;   js/app.js   boot, routing, toast, confirm
```

Public signatures (async where they touch storage, PDF.js or the network):

```js
store.open() → {persistent, memory}; store.estimate() → {usage, quota}
store.collections.{put(c), get(id), all(), remove(id)}
store.docs.{saveBytes(docId, u8), loadBytes(docId) → Uint8Array|null, deleteBytes(docId)}
store.prompts.{put(p), get(id), byCollection(id), due(now), all(), remove(id)}      // remove = hard delete
store.attachments.{put(a), get(id), allIds(), remove(id)};  store.meta.{get(key), set(key, value)}

scheduler.{DAY, GROWTH, FIRST, RETRY, LOOKAHEAD, LEGEND, newSchedule(now), grade(s, now, outcome),
           preview(s, now, outcome) → intervalMs, isDue(s, now), rayValue(ms), legendIndex(ms), replay(createdAt, log)}

prompts.parse(text) → {kind, question, answer, body, deletions:[{start,end,text}], tags, lints}
prompts.tokenize(text) → runs; prompts.mask(parsed, k, reveal); prompts.derive(parsed) → {front, back}
prompts.imageIds(text) → string[]; prompts.splitMany(text) → [{section, text}]

context.sectionsFromOutline(pdfDoc) → Section[]; context.normalizeTitle(title) → string
context.labelFor(sections, pageIndex, pageLabel) → string; context.line(collection, prompt) → string

math.render(text, {cloze:{k, reveal}, images:"thumb"|"full"}) → html; math.available(); math.toAnkiDelims(text)

keys.define(scope, {action: {binding, inField, run}}); keys.setBindings(scope, map); keys.handle(event)
keys.matches(binding, event); keys.format(binding); keys.PRESETS; keys.conflicts(map) → [[a, b]]

reader.open({collection, bytes}) → DocInfo; reader.close(); reader.goToPage(i); reader.scrollToAnchor(anchor, {flash})
reader.setZoom(scale|"fit"); reader.getZoom(); reader.pageView(i) → {el, viewport, textDivs, textContent}|null
reader.pageTop(i); reader.visiblePages(); reader.find(query) → hits; reader.renderRegion(i, pdfRect, scale) → canvas; reader.selection()

anchors.fromSelection(sel, pageViews) → anchor|null; anchors.fromPoint(i, x, y) → anchor; anchors.anchorY(anchor)
anchors.draw(pageView, prompts); anchors.setActive(id, on); anchors.relocate(prompt, pageView) → bool
anchors.hitTest(i, x, y) → id|null

margin.setItems(prompts); margin.layout({activeId}); margin.openEditor({promptId|null, anchor, initialText})
margin.closeEditor({save}); margin.focus(id); margin.next(); margin.prev(); margin.setMode(mode)

attachments.fromBlob(blob) → attachment; attachments.url(id) → objectURL; attachments.gc(oldText, newText)
attachments.handlePaste(event, textarea) → bool; attachments.handleDrop(event, textarea) → bool

vision.backend() → {name, transcribe(blob)}|null; vision.postprocess(raw) → {latex, display}; vision.test(key, model)
snip.enter(); snip.exit(); snip.toggleMode(); snip.capture(i, pdfRect) → Blob; snip.copyImage(blobP); snip.copyLatex(textP)

review.start({scope:"all"|"collection"|"today", collectionId, now}); review.reveal(); review.grade(outcome)
review.undo(); review.skip(); review.goToSource(); review.exit(); review.resume(); review.state()

library.render(); library.renderDeck(id); library.renderSettings(); library.addPdf(file)
exporter.toJSON(scope) → string; exporter.toAnkiTSV(scope) → {basic, cloze}; exporter.toMarkdown(scope) → string
exporter.importJSON(text) → {added, updated, skipped}; exporter.deliver(filename, text)
app.boot(); app.route(name, params); app.toast(msg, {actions, ttl}); app.confirm(msg, {ok, cancel}) → bool; app.setTheme(t)
```

**Event flow** (`bus`): `reader` emits `doc:opened`, `page:rendered {i, pageView}`, `page:evicted {i}`, `zoom:changed`, `scroll:settled`; `anchors` draws and relocates on `page:rendered`; `margin` relayouts on `page:rendered`/`zoom:changed` and emits `prompt:created/updated/deleted`; `library` and `review` refresh due counts on `prompt:*` and `review:graded`; `review` emits `session:suspended/ended`. Modules call `store` directly and never touch each other's DOM.

**Bundle**: `python3 -I tools/bundle.py` inlines every local stylesheet and `<script src=js/…>` into `index.html` and writes `dist/marginalia.html` (cdnjs tags untouched). `--artifact` also downloads `katex.min.css` and its 20 woff2 fonts, rewrites each `url(fonts/X.woff2)` to a `data:font/woff2;base64` URI, drops the woff/ttf `src` entries, replaces the cdnjs `<link>` with that `<style>` (≈372 KB) and sets `<meta name="marginalia-build" content="artifact">`.

## 11. Edge cases

- **Scanned PDFs**: no text items on the first three pages → one-time banner "This PDF has no text layer: use free margin notes (double-click) and the snip tool"; the adder never appears.
- **Huge PDFs** (500+ pages, 50 MB): chunked storage; placeholders sized from page 1 and corrected as `getPage(i)` sizes arrive; an `IntersectionObserver` (`rootMargin: 100% 0px`) feeds a serial render queue and a second at `300% 0px` evicts (cancel tasks, `canvas.width = 0`, remove layers, `page.cleanup()`); DPR capped so no canvas exceeds 16,777,216 px.
- **Rotated pages**: viewports use `page.rotate`; anchors are PDF-space, so highlights and `renderRegion` stay correct.
- **Selection across pages**: rects on every page, all highlighted; the card anchors to the first rect.
- **Duplicate opens**: same fingerprint and sha256 → open the existing book; same fingerprint, different sha256 → in-page choice "Replace file, keep prompts" (default) or "Add as a separate book" (id = fingerprint + ":" + sha256[0..8]); new fingerprint → new book.
- **Storage quota**: `estimate()` before saving warns when `quota − usage < 1.2 × bytes`; a transaction aborted with `QuotaExceededError` shows "Storage is full — delete a book or export"; metadata is saved before bytes, so a failed byte save leaves a book with `hasBytes: false` and "Choose file again".
- **Worker failing**: PDF.js wraps the cdnjs worker in a blob worker and falls back to the main-thread fake worker (which the Artifact CSP may force); "Preparing document…" with `onProgress` keeps a main-thread parse from looking hung. If cdnjs is unreachable, library and review still work and "Add PDF" says "PDF engine not loaded — reload when online". Password PDFs get an in-page field via `onPassword`.
- **Dark mode for the canvas**: pages stay paper-white (no filter); "Dim pages" adds `rgba(0,0,0,.35)` via `.page::after` under the text layer, so highlights stay yellow and selection works.

## 12. Test plan

**Unit tests** (`node --test test/`; pure modules are `require`d directly):

- `scheduler.test.js`: Orbit's vectors (new prompt remembered at t=2000 → interval 432 000 000, due 432 002 000; 10-day forgotten → 5 d, due +10 min), jitter bounds, 16-h lookahead, `replay` = sequential grading, `legendIndex`/`rayValue`.
- `prompts.test.js`: Q/A multi-line answer; cloze count; `\{` escape; brace inside `$\frac{a}{b}$` ignored; cloze containing `$` masked whole; `splitMany` with `# Section`; lints.
- `context.test.js`: `normalizeTitle` ("1 The Wave Function" → "Ch. 1 · The Wave Function", "Chapter 3: Formalism" → "Ch. 3 · Formalism"); `labelFor` deepest item, chapter + section, "p. N" fallback; `line()` for books and decks.
- `margin-layout.test.js` (`margin.computeLayout`, pure): no overlaps; pinned card pushes the minimal chain up; no room above → slides down; drift > 320 collapses; idempotent.
- `exporter.test.js`: delimiter conversion, cloze numbering, `<br>`/tab handling, Markdown round-trip, merge rules (newer text wins, log union + replay, tombstones).
- `keys.test.js`: `event.key` + modifier matching, case-insensitive letters, presets, conflicts, in-field suppression.

**Manual checklist** (Chrome and Safari; http, `file://`, Artifact):

1. Add a 50 MB textbook; reload; it reopens at the last page.
2. Highlight → N → save: card level with the passage after zoom and reload; three-brace cloze → three review cards.
3. T reviews today's prompts; Forgot returns the card at the end; the ray grows on Remembered.
4. Global review mixes two books; context line "Nickname · Ch. N · Title"; G lands on the pulsing highlight; "Resume review" works.
5. Rebind Forgot to ArrowLeft; key caps update; conflict flagged; bindings survive reload and appear in the backup.
6. Image snip → Cmd+V in the editor inserts a thumbnail token and in Preview.app pastes the PNG; LaTeX snip → Cmd+V pastes `$$…$$`; with no key the LaTeX option is disabled; token deleted → attachment gone after save.
7. JSON export by download and clipboard; import into a fresh profile keeps counts and review state; Anki imports both TSV files with math and images.
8. 900 px → rail; 400 px → bottom sheet, `scrollWidth` equals the viewport; dark mode with "Dim pages"; Z restores a deleted card within 8 s.
9. Deck "Add prompts" with `# Section` lines; move a book prompt in (anchor dropped after confirm); scanned PDF banner; password field; modified copy → "Replace file, keep prompts"; Artifact: fake worker tolerated, `downloads`/`sample` used when present.

## 13. Visual design tokens

```css
:root {
  --bg: #efece4;        --surface: #faf8f3;   --ink: #1f1d1a;       --ink-2: #6b665d;     --line: #ddd7ca;
  --accent: #e04a2f;    --focus: #2f6fe0;     --hl: #ffe66d;        --hl-active: #ffd21f; --find: #9cc4ff;
  --page-bg: #fff;      --dim: rgba(0,0,0,.35);
  --review-bg: #f3e9d2; --review-ink: #2a2318; --review-ink-2: #8a7a5c; --review-line: #e4d7b8;
  --review-accent: #e04a2f; --review-accent-2: #e8a33a;
  --font-ui: system-ui, -apple-system, "Segoe UI", sans-serif;
  --font-display: "Outfit", var(--font-ui);     /* Google Fonts 400/500/700; a Dr look-alike */
  --font-mono: ui-monospace, "SF Mono", Menlo, monospace;
  --s1: 4px; --s2: 8px; --s3: 12px; --s4: 16px; --s5: 24px; --s6: 32px; --s7: 48px;
  --r1: 6px; --r2: 8px; --r3: 12px;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme=light]) { /* dark values */ } }
:root[data-theme=dark] { /* same dark values */ }
body { background: var(--bg); color: var(--ink); font: 15px/1.45 var(--font-ui); }
```

Dark values: `--bg #1b1a18`, `--surface #24221f`, `--ink #ece7dc`, `--ink-2 #a39d91`, `--line #3a3732`, `--accent #ff6a4d`, `--hl`/`--hl-active` unchanged (they multiply over the white page), `--review-bg #2a2419`, `--review-ink #f1e8d6`, `--review-ink-2 #a8977a`, `--review-line #3e3425`, `--review-accent-2 #f0b24a`; `data-theme` is set by the Settings toggle.

Type: UI 14/20 `--font-ui`; library headings 22/28 Outfit 500; card question 14/20 Outfit 500, answer 13/18 `--ink-2`; context line 12/16 Outfit 500 uppercase, 0.08em tracking; review question Outfit 400 36/42 (tracking −0.01em), answer 24/32; review buttons Outfit 500 18/24, 1-px `--review-line` border, transparent fill, key caps 11-px mono in `--review-ink-2`; "Exit review ✕" a 14-px link in `--review-accent` at the top right, as in the video. Cards have no border or shadow; pages `0 1px 4px rgba(0,0,0,.25)`.

## 14. Library, decks, cross-document review & context line

**Home screen**: as wireframed in §2; "Review N due" sums due components over live prompts and is recomputed on `prompt:*` and `review:graded`. Book rows: nickname (✎ edits inline), counts, `Continue reading` (opens at `lastPosition`), ⋯ (Rename, Export, Replace file, Delete — the confirm says how many prompts go with it); deck rows: name, counts, `Open`, `Review`, ⋯.

**Collection model**: one `collections` store with `kind: "book" | "deck"`; `prompt.collectionId` points to exactly one. Deck prompts have `anchor: null` and `context: {docName: deckName, sectionLabel: section|null, pageIndex: null}`. Moving a prompt (Move to…) rewrites `collectionId`, drops the anchor after `app.confirm("Moving to a deck removes the highlight on p. 12. Move?")`, recomputes context and keeps schedules.

**Deck page**: name ✎, description, counts, `Review this deck`, the "Add prompts" textarea (`prompts.splitMany`: prompts separated by blank lines; a line starting `# ` sets the section for the prompts that follow; images paste as tokens; live preview; `Add 3 prompts` on Cmd/Ctrl+Enter), then the prompt list (search; rows show front, section, due-in, flag; Edit, Delete with Undo, Move to…).

**Context line**: `context.line(collection, prompt)` = `docName · sectionLabel`, falling back to `pageLabel`: "Griffiths · Ch. 1 · The Wave Function", "Griffiths · p. 12" when no section covers the page, "Thermo formulas · Carnot" or just "Thermo formulas" for decks. Over 64 characters the section title is dropped, then the line is middle-ellipsised.

**Outline parsing at import** (`context.sectionsFromOutline`): `doc.getOutline()` → depth-first flatten with `level`; string `dest`s resolve via `getDestination`, `dest[0]` via `getPageIndex`; titles normalised: `^(\d+)\s+(.+)` → "Ch. 1 · The Wave Function", `^(\d+(\.\d+)+)\s+(.+)` → "§1.2 Normalization", `^(chapter|ch\.?)\s*(\d+)[:.\s]+(.+)` → "Ch. 3 · Formalism". `labelFor(sections, page)` takes the deepest item with `pageIndex ≤ page`; when level-1 and level-2 items both apply the label is "Ch. 1 · The Wave Function · §1.2 Normalization".

**Manual chapter marks**: C or ⋯ › "Mark chapter start here" opens a one-line field at the top of the current page; Enter stores `{title, pageIndex, level: 1, manual: true}` in `sections` (replacing a manual mark on that page) and recomputes `context` on the book's prompts. Manual marks win over the outline on their page.

**Nickname**: default = PDF `info.Title` when 3–80 characters and not a file name or "untitled", else the file name without extension, trimmed to 24 characters; editing it (library row or reader toolbar title) recomputes `context.docName` on its prompts.

**Snapshot**: at save, `prompt.context = {docName, sectionLabel, pageIndex, pageLabel}` plus `anchor.quote`, so review reads only the prompt record and global review never touches PDF bytes. **Go to source** is the §7 flow (for a book with `hasBytes: false` the button reads "PDF not in library").

## 15. Snip tool, image attachments & LaTeX transcription

**Interaction**: S or ✂ enters snip mode: an overlay over the page column with `cursor: crosshair` and a hint "Drag over an equation · Esc to cancel". Dragging draws a dashed rectangle; pointer up with a rect ≥ 8 × 8 CSS px captures and leaves snip mode (one-shot); Esc leaves it. The `Image | LaTeX` control beside ✂ and Shift+S set `settings.snipMode`; LaTeX is disabled with the hint "Add an API key in Settings" when no backend exists. Snips never create prompts or anchors (D6).

**Capture** (`snip.capture(i, pdfRect)`): the drag corners go through `viewport.convertToPdfPoint`; with `z` the current scale, `dpr = devicePixelRatio || 1` and oversampling `k = 3`: `s = z·dpr·k`, clamped so `w·h·s² ≤ 16 777 216` and the long edge ≤ 8000 px; `page.getViewport({scale: s, offsetX: −sx, offsetY: −sy})` renders only the region into an `sw × sh` canvas (`alpha: false`, white background) and `canvas.toBlob(cb, "image/png")` makes the PNG.

**Clipboard inside the gesture**: `toBlob` and transcription are async, so both modes write a `ClipboardItem` whose value is a `Promise<Blob>` (Chrome ≥ 98, Safari ≥ 13.1, Firefox ≥ 127), created synchronously in the `pointerup` handler:

```js
const blobP = capture(i, rect);                                   // Promise<Blob>
if (mode === "image") navigator.clipboard.write([new ClipboardItem({ "image/png": blobP })]);
else { const textP = blobP.then(vision.transcribe).then(wrap);
       navigator.clipboard.write([new ClipboardItem({ "text/plain": textP.then(t => new Blob([t], { type: "text/plain" })) })]); }
```

Toasts: Image → "Image copied — press Cmd+V where you want it"; LaTeX → "Transcribing…" with a spinner, then "LaTeX copied — press Cmd+V where you want it". If the write rejects (unsupported browser, permission, Safari's newer-write-replaces-pending rule, a transcription error) the toast shows the LaTeX with `Copy` and `Insert at cursor` buttons (fresh gestures), or the PNG with `Copy image`. Every snip toast also offers `Switch to LaTeX/Image` and `Add to prompt` (insert at the editor caret).

**Cmd+V in the editor**: text pastes natively. `attachments.handlePaste` checks `clipboardData.items` for `kind === "file"` with an `image/*` type before any text; on an image it calls `preventDefault()`, stores the attachment and inserts `![snip](att:<id>)` at the caret with `setRangeText(…, "end")`. Dropped image files behave the same. **Cmd+V in the reader** (no editor open) creates a free margin note at the middle of the visible page (D20) and opens its editor with the pasted text, or the image token, as the question.

**Attachment storage**: `attachments.fromBlob` decodes with `createImageBitmap` for width/height, re-encodes non-PNG as PNG, downscales by 0.7 steps until ≤ 4 MB, and stores `{id, mime, data: ArrayBuffer, width, height, bytes}`. Cards show `<img>` at `max-height: 120px`, review the full column, via cached object URLs. GC: on each save `attachments.gc(oldText, newText)` deletes ids that left the text and are referenced by no other live prompt; a startup sweep removes attachments older than 24 h that nothing references.

**Vision backends** (`vision.backend()`): if `window.claude?.use` exists, `const sample = await claude.use("sample")`; when `sample` is non-null and `(await sample.limits().catch(() => null))?.images` is truthy, `transcribe` is `sample(INSTRUCTION, {images: [blob], modelTier: "default", cache: false})` → `{text}`; its rejections `{code, message}` hide the LaTeX option for `not_granted`/`images_unavailable` and show the message otherwise, never looping. Otherwise, with a stored key, the API backend POSTs to `https://api.anthropic.com/v1/messages` with headers `x-api-key`, `anthropic-version: 2026-10-21`, `content-type: application/json`, `anthropic-dangerous-direct-browser-access: true`, `anthropic-beta: server-side-fallback-2026-07-01` and body `{model, max_tokens: 1024, output_config: {effort: "low"}, fallbacks: "default", messages: [{role: "user", content: [image block, text block (INSTRUCTION)]}]}`, no `temperature`. `content` blocks with `type === "text"` are joined; `stop_reason === "refusal"` → "The model declined this image". Errors become toast text: 401 "API key rejected — check Settings", 429 "Rate limited — try again in N s" (`retry-after`), 5xx/529 "Claude is overloaded", fetch `TypeError` "The browser blocked the request"; one request per snip, never retried. `vision.postprocess` strips fences and stray delimiters, maps `NO_MATH` to a rejection `{code: "no_math"}` (toast "No equation found"), picks display mode for `\begin{`, multi-line or relation-plus-tall-operator results (multi-line wrapped in `aligned`), pre-validates with KaTeX (`throwOnError: true`; a failure still inserts with "May not render: …") and wraps in `$$…$$` or `$…$`.

**Settings › LaTeX from snips**: password field for the key, model field (default `claude-opus-5-5`), `Test` (a one-token text request), `Forget key`, and the note "Stored only in this browser (localStorage); never included in backups".

## 16. Math rendering

KaTeX 0.16.47 from cdnjs: `katex.min.js` then `contrib/auto-render.min.js` as classic scripts after PDF.js (our tokeniser handles delimiters); `katex.min.css` is a cdnjs `<link>` in the local build and an inlined `<style>` with woff2 data URIs in the Artifact bundle (§10). Without `katex`, math runs render as `<code>` source.

**Where**: `math.render(text, opts)` is the single HTML producer for margin cards, the editor preview (debounced 150 ms), prompt lists, the deck editor and the review overlay. Plain runs go through `escapeHtml`; KaTeX output is trusted; image tokens become `<img>`.

**Pipeline**: `prompts.tokenize` splits text into runs in this precedence: image tokens `![snip](att:id)`; display math `$$…$$` (may span lines) and `\[…\]`; inline math `\(…\)` and `$…$` (opening `$` not followed by whitespace, closing `$` not preceded by whitespace, same line, `\$` escaped); cloze braces `{…}` outside math (a brace enclosing a whole math run is one deletion); plain text. Masking replaces deletion `k` with the blank (on reveal, `<mark>` around the rendered content) before any rendering, so a cloze containing `$` is masked as a whole. Each math run goes through `katex.renderToString(src, {throwOnError: false, displayMode, output: "html", strict: "ignore"})` in `try/catch`; a `ParseError` yields KaTeX's `katex-error` span, styled as the raw source in `--font-mono` with a red dotted underline and the message as `title`; other exceptions fall back to the same `<code>` rendering. Display math gets `overflow-x: auto` inside the card only, so the page never scrolls.

**Exports**: Anki TSV converts `$$…$$` → `\[…\]` and `$…$` → `\(…\)` (`\(…\)`/`\[…\]` pass through); Markdown keeps `$` delimiters; "Copy question LaTeX" and the card menu's copy actions put the raw text on the clipboard via `writeText` in the click handler, with the select-the-text fallback when it rejects.
