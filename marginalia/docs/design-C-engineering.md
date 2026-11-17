# Marginalia — Design C: engineering robustness first

Four engineers, two days, one afternoon of integration. Every module is a global namespace under `window.Marginalia` (written `M.` below) with explicit signatures; modules talk only through `M.bus`. Pure modules (scheduler, prompts, layout, anchors, keys, markup, export conversions) also load in node for `node --test`. Every default below is a decision, not an option.

## 1. Product summary

One reading session, start to finish:

1. Open `index.html` (python3 -m http.server, file://, or the Artifact). The library lists Books and Decks with prompt and due counts, and "Review all · 37 due".
2. Click "Griffiths · Continue reading". The 48 MB PDF is reassembled from IndexedDB chunks, PDF.js opens it, and the reader lands on page 44 at the saved offset.
3. Pages render lazily around the viewport; yellow passages mark earlier prompts, and each prompt's question (answer in lighter type) sits in the right margin at its passage's height.
4. Drag-select "the Schrödinger equation", press N: a card opens beside the passage with `Q. ` and `A. ` lines; `$…$` previews as rendered math under the textarea while typing.
5. Press S, drag a box over equation 1.1: the region is re-rendered from the PDF at 3× device pixels; in "LaTeX" mode it lands on the clipboard as `$$…$$`, in "Image" mode as a PNG; Cmd+V pastes it into the answer.
6. Cmd+Enter saves: the highlight is drawn, the card is laid out, the prompt is stored with its context "Griffiths · Ch. 1 · The Wave Function"; focus returns to the page.
7. A dense paragraph gets a plain highlight (H) to return to later; a stray thought becomes a free note by double-clicking the margin.
8. At the end of the chapter, press T: "today's prompts" are reviewed Orbit-style (warm paper, large question, Show answer, Forgot / Remembered); forgotten ones come back at the end of the session.
9. Five days later the library shows "23 due"; "Review all" interleaves Griffiths with the German deck; G opens the source passage when context is needed.
10. Nothing leaves the browser: JSON backup, Anki TSV and Markdown exports are one click, or one clipboard copy in the Artifact.

## 2. Screens & layout

One `index.html`; three `<section data-screen="library|reader|deck">` elements of which `M.app.route()` shows one; the review overlay and the settings `<dialog>` are fixed layers above any screen. All widths derive from the container (a ResizeObserver on `#app`), never from `window.innerWidth`.

**Library** (content column `max-width: 880px`, 24 px gutters):

```
┌──────────────────────────────────────────────────────────────┐
│ Marginalia                        [▶ Review all · 37 due]  ⚙  │ header 64
│ 6 prompts written today           [Review today's prompts]   │ (only when > 0)
│ BOOKS                                           [+ Open PDF] │
│ ┌──────────────────────────────────────────────────────────┐ │
│ │ Griffiths                  412 pp · 128 prompts · 23 due │ │ row 72
│ │ [Continue reading · p. 44]  [Review this book]       [⋯] │ │
│ └──────────────────────────────────────────────────────────┘ │
│ DECKS                                           [+ New deck] │
│ ┌──────────────────────────────────────────────────────────┐ │
│ │ German vocab                       300 prompts · 14 due  │ │
│ │ [Open deck]  [Review this deck]                      [⋯] │ │
│ └──────────────────────────────────────────────────────────┘ │
│ 61 MB used · storage persistent        Export all · Import   │ footer
└──────────────────────────────────────────────────────────────┘
```

**Reader, wide mode (container ≥ 900 px)**:

```
┌───────────────────────────────────────────────────────────────────────────┐ 1440
│ ‹ Library  Griffiths ▾  ‹ [44] ▸ /412  −  125% ▾  +  ⌕  ✂ Snip [Image|LaTeX]  Review ▾  ⚙ │ toolbar 48
├───────────────────────────────────────────────────────────────────────────┤
│ #scroller (overflow-y: auto; padding 24px)                                 │
│   ┌ page column = W − 304 − 48 ──────────────────┐ ┌ margin column 304 ┐  │
│   │ ┌ .page (relative; width = pt × scale) ─────┐ │ │  ┌ card 272 ────┐ │  │
│   │ │ canvas / .highlightLayer / .textLayer     │ │ │  │ ◦ What is…   │ │  │
│   │ │   ▒▒▒ the Schrödinger equation ▒▒▒ ───────┼─┼─┼──│   $i\hbar…$  │ │  │
│   │ └───────────────────────────────────────────┘ │ │  └──────────────┘ │  │
│   │  gap 16                                        │ │   ▪ (collapsed)   │  │
│   │ ┌ .page ──────────────────────────────────────┐│ │                   │  │
│   └────────────────────────────────────────────────┘ └───────────────────┘  │
└───────────────────────────────────────────────────────────────────────────┘
```

Pages and the margin are siblings inside one `#scroller`, so one scrollbar moves both. `.margin` is `position: absolute` with `height` = total document height; cards are absolutely positioned inside it (§6). The margin column is 16 px gap + 272 px card + 16 px padding. "Fit width" (default) sets `scale = pageColumnWidth / pageWidthPt`, capped at 2.0; pages are centred with a 16 px gap between them.

**Rail mode (600–899 px)**: the margin becomes a 44 px rail; one marker per bucket (anchors within 60 px merge; a badge shows the count); click, focus or Enter opens the card as a popover (`max-width: min(320px, 100vw − 32px)`) anchored to the marker; Esc closes; editing happens in the popover. Page column = `W − 44 − 32`.

**Stack mode (< 600 px, so at 400 px)**: no rail; a 16 px round badge at the end of each highlight; tap or Enter opens a bottom sheet (`position: fixed; bottom: 0; max-height: 60vh`) holding the card or editor; the toolbar keeps `‹ 44 ▸`, zoom and a `⋯` overflow menu; page column = `W − 32`. Nothing scrolls horizontally: page scale derives from the container, popovers and sheets use `max-width: calc(100vw − 32px)`, cards use `overflow-wrap: anywhere`, display math scrolls inside its own box, the toolbar wraps.

**Review overlay** (fixed, full viewport, column `max-width: 720px`, padding 24):

```
┌───────────────────────────────────────────────────────────────┐
│ 12 / 40   ●━━●━━●━━○──○──○  5d 2wk 1mo 2mo 4mo 1yr   Exit review ✕ │ 56
│                                                               │
│          GRIFFITHS · CH. 1 · THE WAVE FUNCTION                │ 12 px, tracked
│          What is the Schrödinger equation?                    │ 36–44 px
│          ─ after Show answer ─                                │
│          $i\hbar\,\partial_t\Psi = \hat H \Psi$               │ 24 px
│          "…the Schrödinger equation: iℏ ∂Ψ/∂t = …"  (source)  │ 14 px muted
│                                                               │
│ [ Forgot  ⌨1 ]  [ Remembered  ⌨2 ]    Undo ⌨U · Skip ⌨S · Go to source ⌨G │ 56
└───────────────────────────────────────────────────────────────┘
```

Before reveal the bar holds one wide "Show answer ⌨Space" button plus "Skip". The deck page and Settings are specified in §14 and §15.

## 3. Interactions & keyboard

- **Open PDF**: "+ Open PDF" (`<input type=file accept="application/pdf,.pdf">`) or drop a file on the library. `M.library.importFile(file)`: bytes → `sha256` (`crypto.subtle`, FNV-1a fallback) → `M.pdfview.open(bytes.slice())` for `fingerprints[0]`, `numPages`, title, outline → duplicate check (§11) → `M.store.saveDocument(doc, bytes)` → reader. A "Preparing document…" bar covers the parse.
- **Select text**: drag on the text layer (official `endOfContent` helper). `selectionchange` (debounced 50 ms) stores `reader.selection = {pages:[{pageIndex, rects}], quote, items}` in PDF space, so it survives focus moving to the editor. A pill appears at the selection end: "N Prompt · ⇧N Cloze · H Highlight".
- **Create prompt**: N (selection → highlight + card at the passage; no selection → free note at the middle of the visible page), Shift+N (card pre-filled with the selected sentence, for cloze editing), H (plain highlight), double-click in the margin column (free note at that y). The editor opens inside the card, caret after `Q. `.
- **Edit**: E on the focused card or click its text. The card `⋯` menu: Edit, Delete, Copy question, Copy answer, Copy as Q./A. text (all `navigator.clipboard.writeText` inside the click, with a select-the-text fallback), Move to…, Go to passage; a plain highlight shows "Write prompt" instead of Edit. **Save** Cmd/Ctrl+Enter; **Cancel** Esc (an empty new card is discarded silently).
- **Delete**: Backspace/Delete on a focused card, or the menu. The prompt gets a tombstone (`deletedAt`), leaves the DOM, and a toast "Prompt deleted · Undo (Z)" stays 8 s; Z or the button clears the tombstone. Tombstones are purged after 30 days at boot.
- **Navigate prompts**: J/K next/previous card in document order (scrolling so card and passage are visible), G scrolls to the focused card's passage, Enter toggles its answer; clicking a highlight focuses its card; hovering either side lights both.
- **Zoom**: Cmd/Ctrl+= and Cmd/Ctrl+− step the ladder `[0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3, 4]`, Cmd/Ctrl+0 = fit width, Ctrl+wheel/pinch steps the same ladder; the scroll offset stays proportional.
- **Page navigation**: `‹ ▸`, the page input (Cmd/Ctrl+G focuses it), PageUp/PageDown/Home/End native in the scroller; Alt+← returns to the position before the last jump (go-to-page, find, G, "Go to source").
- **Rotate**: "Rotate 90°" in the toolbar `⋯` (stored per document). **Find**: Cmd/Ctrl+F; Enter/Shift+Enter cycle hits; Esc closes. **Chapter mark**: "Mark chapter start here" in the page menu (§14).
- **Start review**: R (this document), Shift+R (all), T (today's prompts), the "Review ▾" menu with counts, library buttons. **Snip**: S enters, Shift+S toggles Image/LaTeX, Esc leaves (§15). **Paste**: Cmd/Ctrl+V (§15).

**Shortcut table** (the reader map is the constant `M.keys.READER_MAP`, in the same binding format as the configurable review map, so it can become a setting later):

| Context | Keys | Action |
|---|---|---|
| Reader | N / Shift+N / H | New prompt / cloze prefill / plain highlight |
| Reader | J / K / E / Enter / G | Next, previous card / edit / toggle answer / go to passage |
| Reader | Backspace, Delete / Z | Delete focused card / undo delete |
| Reader | S / Shift+S / Esc | Snip mode / toggle Image–LaTeX / leave snip |
| Reader | R / Shift+R / T | Review this document / all / today's prompts |
| Reader | Cmd+= Cmd+− Cmd+0 / Cmd+G / Cmd+F / Alt+← | Zoom / go to page / find / back |
| Reader | Cmd+V | Paste → free note |
| Reader, Library | ? / Cmd+, | Shortcut sheet / settings |
| Editor | Cmd+Enter / Esc / Cmd+Shift+C / Cmd+P / Cmd+V | Save / cancel / wrap selection in `{}` / toggle preview / paste |
| Review | Space / 1 / 2 / U / S / G / Esc (configurable, §7) | Show answer / Forgot / Remembered / Undo / Skip / Go to source / Exit |
| Library | ↑ ↓ Enter / Shift+R | Move / open / Review all |

Cmd is Ctrl outside macOS. **Focus management**: one `keydown` listener on `document` calls `M.keys.dispatch(ev, activeMaps)`; when `ev.target` matches `input, textarea, select, [contenteditable]` only the Editor map is consulted; `ev.repeat` and `ev.isComposing` are ignored. `#reader` has `tabindex="-1"` and regains focus after every editor, toast or popover closes, so paste and shortcuts keep working. The focused card is `reader.focusedPromptId` (`aria-current="true"`, `.card--focused`); popovers, the bottom sheet and the review overlay trap Tab and return focus to their invoker on Esc. No `alert`/`confirm`: `M.app.confirm()` is a `<dialog>`; destructive actions get an Undo toast.

## 4. Prompt model & syntax

One textarea per prompt; `M.prompts.parse(text)` is the single source of truth:

```
parse(text) → { kind: "qa"|"cloze"|"note"|"highlight", q, a, body, deletions: [{start, end}], tags: [], errors: [] }
```

- `qa`: a line starting `Q.` and a later line starting `A.`; `q` is the text between, `a` everything after (multi-line). `Q.` without `A.` is an error ("add an A. line").
- `cloze`: no `Q.`/`A.` and at least one `{…}` outside math runs and image tokens (`M.markup.tokenize` runs first, so braces inside `$…$` are LaTeX). Each top-level brace span is a deletion in document order; card *i* masks deletion *i* with a blank and shows the others as plain text; the answer side shows the paragraph with deletion *i* as `<mark>`. Nested braces are not supported (the outer span wins).
- `note`: non-empty text with neither; italic in the margin, no cards, never reviewed. Free notes start as notes and become prompts the moment the text parses as `qa` or `cloze`.
- `highlight`: empty text plus an anchor (H); drawn as a dot marker; "Write prompt" opens the editor.
- Tags: a final line consisting only of `#tokens` (`#ch1 #definitions`) → `tags`, stripped from rendering, filterable in prompt lists; nothing else in v1.
- Images: `![snip](att:<id>)` tokens anywhere (§15).

Cloze entry: type the braces, or select text in the textarea and press Cmd/Ctrl+Shift+C to wrap it. Cards are keyed by deletion index: `M.prompts.reconcileCards(prompt, parsed, now)` keeps card *i* for deletion *i*, appends `newSchedule(now)` for new deletions and drops cards beyond the new count (in-page confirmation when a dropped card has history). A `qa` prompt has exactly one card; `note`/`highlight` have none. The margin card renders a cloze with all deletions underlined; review masks one deletion per card as `<span class="cloze-blank">` (6ch, baseline rule).

## 5. Anchoring & highlight rendering

Stored anchor (PDF user space, points, y up; invariant under zoom, DPR and rotation):

```json
{ "pageIndex": 12,
  "pages": [{ "pageIndex": 12, "rects": [[72.0, 612.4, 318.2, 624.1], [72.0, 598.1, 140.5, 609.8]] }],
  "quote": "the Schrödinger equation:", "prefix": "is governed by ", "suffix": " which we now",
  "items": { "start": { "item": 41, "offset": 0 }, "end": { "item": 42, "offset": 9 } },
  "y": 612.4, "lost": false }
```

`M.anchors.fromSelection(range, renderedPages)` applies the per-page line merge from the research (`getClientRects()` → page-local px → `viewport.convertToPdfPoint` → `Util.normalizeRect`), stores `quote = pdfjsLib.normalizeUnicode(sel.toString())` trimmed to 500 chars, 32-char `prefix`/`suffix` from the page text index, and item anchors from `textDivs.indexOf(span)`. `pageIndex` and `y` (top of the first rect) come from the first page touched. A free note stores `pages: []`, `quote: ""` and the margin `y` converted to PDF space.

Drawing: each rendered `.page` holds `<div class="highlightLayer">` (absolute, inset 0, `z-index: 1`, `pointer-events: none`) under the text layer; `M.reader.drawHighlights(pageIndex)` emits one `<div class="hl">` per rect positioned from `Util.normalizeRect(viewport.convertToViewportRectangle(rect))`, `background: var(--highlight)`, `mix-blend-mode: multiply`, `border-radius: 2px`. The layer is rebuilt on `page:rendered`, on `prompt:saved/deleted/restored` for that page and on `scale:changed`. Hit-testing needs no extra DOM: `click` and rAF-throttled `mousemove` on a page convert the pointer to PDF space and scan that page's rects (a few hundred at most); a hit focuses or hovers the card and adds `.hl--active` to its rects. Find hits reuse the layer with `.hl--find`.

Re-finding: when `pages` is empty or `lost` is true (imported prompt, replaced PDF), `page:textready` triggers `M.anchors.refind(anchor, textIndex, pageIndex)` on pages `pageIndex, ±1, ±2`, trying exact `quote` → whitespace/ligature-normalised quote → `prefix + quote.slice(0, 40)` → `quote.slice(0, 40)`. A hit rebuilds rects from item boxes (`x1 = e`, `x2 = e + width`, `y1 = f + descent·h`, `y2 = f + ascent·h`, fallback 0.8/−0.2, proportional x-trimming inside items), writes them back and clears `lost`; a miss keeps `lost: true`: the card sits at its page's top with a "passage not found" chip and an "Anchor to selection" action. Free notes draw no highlight: a small triangle at the page's right edge marks `y`.

## 6. Margin layout algorithm

Inputs: cards sorted by `(anchorY, createdAt)` where `anchorY = pageTop[pageIndex] + viewport.convertToViewportPoint(0, y)[1]`; `height` from one ResizeObserver per card (estimate `28 + 20·ceil(chars/38)` until measured); `GAP = 8`, `MAX_DRIFT = 320`, `COLLAPSED_H = 28`, card width 272. `M.layout.compute(cards, opts)` is pure and returns `[{id, top, collapsed}]`:

```
compute(cards, {activeId, gap, maxDrift, collapsedH}):
  // A — forward cascade: no card above its anchor
  prevBottom = -Infinity
  for c in cards: c.top = max(c.anchorY, prevBottom + gap); prevBottom = c.top + c.height
  // B — pin the active card, push the minimal chain above it up, re-cascade below
  if activeId:
    a = cards[k]; a.top = a.anchorY; limit = a.top - gap
    for i = k-1 downto 0:
      if cards[i].top + cards[i].height <= limit: break
      cards[i].top = limit - cards[i].height; limit = cards[i].top - gap
    if cards[0].top < 0: shift = -cards[0].top; for i in 0..k: cards[i].top += shift   // no room above: slide down
    prevBottom = a.top + a.height
    for i = k+1..n-1: cards[i].top = max(cards[i].anchorY, prevBottom + gap); prevBottom = cards[i].top + cards[i].height
  // C — degrade instead of drifting
  for c in cards: if c.id != activeId and c.top - c.anchorY > maxDrift and !c.collapsed:
    c.collapsed = true; c.height = collapsedH; changed = true
  if changed: rerun A and B once        // heights only shrink, so one extra pass converges
```

O(n) per run, executed in one rAF after `pages:measured`, `scale:changed`, `prompt:saved/deleted`, card resize and focus change. `top` animates (`transition: top 120ms`) except under `.margin--editing`. A collapsed card is a 28 px pill with the first 40 characters of the question; it expands on hover, focus or J/K and counts as active for pass B so it never overlaps neighbours. In "markers" mode every card starts collapsed. A 1 px connector from the highlight's right edge to the card's top-left is drawn only for the hovered or focused card when `top ≠ anchorY`. While editing, the textarea auto-grows (`height = scrollHeight`), the ResizeObserver reports it, and the cascade pushes neighbours down synchronously; neighbours above move up only as far as needed. Rail and Stack modes skip the cascade and bucket anchors (60 px) into markers.

## 7. Review mode & scheduler

**Scheduler** (`js/scheduler.js`, pure; `now` is always a parameter; milliseconds):

```
DAY_MS = 86_400_000; GROWTH_FACTOR = 2.3; INITIAL_INTERVAL_MS = 5·DAY_MS
RETRY_DELAY_MS = 600_000; JITTER_STEP_MS = 600; DUE_LOOKAHEAD_MS = 16·3_600_000; MAX_RETRIES_PER_SESSION = 3
LADDER = [5, 11.5, 26.45, 60.835, 139.9205, 321.81715]·DAY_MS        // labels 5d 2wk 1mo 2mo 4mo 1yr

newSchedule(now) = { createdAt: now, lastReviewedAt: null, intervalMs: INITIAL_INTERVAL_MS,
                     dueAt: now + INITIAL_INTERVAL_MS + jitter(now), log: [] }      // first due in 5 days (D4)
jitter(now)   = (now % 1000) · JITTER_STEP_MS                                       // 0 … 599 400
isDue(s, now) = s.dueAt <= now + DUE_LOOKAHEAD_MS
grade(s, now, outcome):                                                             // "remembered" | "forgot"
  elapsed = max(0, now − (s.lastReviewedAt ?? s.createdAt))
  if remembered:
    grown    = floor(elapsed · GROWTH_FACTOR)
    interval = elapsed < s.intervalMs ? max(s.intervalMs, INITIAL_INTERVAL_MS, grown)   // early/retry: never shrinks
                                      : max(INITIAL_INTERVAL_MS, grown)                 // on time or late: grows from actual elapsed
    due = now + jitter(now) + interval
  else:
    interval = INITIAL_INTERVAL_MS            // lapse resets to the first rung (Orbit steps back one rung; D4 asks for "short")
    due = now + jitter(now) + RETRY_DELAY_MS  // ~10 min: re-asked at the end of this session
  return { ...s, lastReviewedAt: now, intervalMs: interval, dueAt: due, log: s.log.concat([[now, outcome]]) }
preview(s, now, outcome) = grade(s, now, outcome).intervalMs
rung(ms) = (first i with LADDER[i] > ms · 1.1) − 1                                 // −1 = below the ladder
```

Vectors (tests, §12): new at t=1000 → interval 432 000 000, due 432 001 000; remembered at t=2000 → interval unchanged, due 432 002 000; forgot at t=10 000 → interval 432 000 000, due 610 000; interval 10 d reviewed on time → 23 d; reviewed at 20 d (10 d late) → 46 d; interval 1 yr forgotten → 5 d, remembered 10 min later → 5 d; `jitter(1 234 567) = 340 200`.

**Queue** (`M.scheduler.buildQueue({prompts, scope, collectionId, now, seed})`): items are *cards* `{promptId, cardIndex}` of prompts without tombstone and with ≥ 1 card.

- `"book"`/`"deck"`: due cards of that collection; books in reading order `(pageIndex, −anchor.y, createdAt, cardIndex)`, decks `(createdAt, cardIndex)`.
- `"all"`: every due card, ordered by `(floor(dueAt / DAY_MS), hash32(seed + promptId + cardIndex))`: due day first, then a deterministic shuffle so documents interleave; `seed = now` at session start.
- `"today"`: cards whose prompt `createdAt ≥ local midnight`, in the current collection (or everywhere, from the library), **ignoring dueness**, reading order. This is "review the prompts I wrote today" (T, library banner, Review menu).
- No cap (D9). Library badges count prompts with any `isDue` card.

**Session** (`M.review`): `{queue, index, retries, log, undo, startedAt}`. Show answer → Forgot / Remembered → `grade()` → `M.store.putPrompt` at once → `review:graded` → next card. At the end of the queue, cards still `isDue` (the forgotten ones) are appended in original order unless `retries ≥ 3`; the session ends when nothing is appended. Skip moves the current card to the end ungraded. Undo is single-level: it restores the previous schedule object, drops the log entry, steps back and removes any retry tail that mark created. Space after reveal is inert (no accidental grades).

**Interval indicator**: the six-stop ladder in the top bar; stops up to `rung(intervalMs)` are filled, later ones hollow; hovering or holding a grading button previews `rung(preview(…))` as a pulsing stop and the buttons carry captions "→ 2wk" / "→ 5d · again in 10 min". One ladder instead of a starburst: readable, deterministic, 40 lines.

**Configurable shortcuts (R7)**: actions `showAnswer, forgot, remembered, undo, skip, goToSource, exit`. Bindings are strings `"[Ctrl+][Alt+][Shift+][Meta+]Key"`, `Key` = `event.key` with `" "` → `Space` and single letters lower-cased; `M.keys.match(ev, binding)` normalises the event the same way, ignores `repeat`, and never fires with a text field focused.

| Preset | showAnswer | forgot | remembered | undo | skip | goToSource | exit |
|---|---|---|---|---|---|---|---|
| Default | Space | 1 | 2 | u | s | g | Escape |
| Arrows | Space | ArrowLeft | ArrowRight | u | s | g | Escape |
| Vim | Space | j | k | u | s | g | q |
| Anki-like | Space | 1 | 3 | z | s | g | Escape |

Settings → "Review shortcuts": a table (action, `<kbd>`, Rebind); clicking a binding shows "Press a key…", a capture-phase `keydown` records the next chord, Esc cancels; the preset selector (shows "Custom" after an edit) and "Reset to default" fill the whole map. Duplicate bindings are flagged red on both rows and fire nothing until resolved. Stored as `settings.reviewKeys` (localStorage), included in the JSON backup. Every review button renders `<kbd>` via `M.keys.label()` (`Space` → "␣", `ArrowLeft` → "←", `Escape` → "esc"); the `?` sheet lists both maps.

**End of session**: "Session complete · 40 reviewed · 34 remembered · 6 forgotten · 2 skipped · next due: tomorrow (3 prompts)" with "Back" (to where the review started) and "Library". **Go to source** (G): the overlay hides (session parked in `M.review`), `review:gotoSource` routes to the reader at `{docId, promptId}`, which scrolls the anchor to 30 % of the viewport, focuses the card and pulses the highlight twice; a "Resume review" pill in the toolbar restores the overlay at the same card. Disabled for deck prompts; a lost anchor opens the page only. The review card `⋯` menu offers "Copy question LaTeX" (raw text of the question).

## 8. Persistence & data model

IndexedDB database `marginalia`, `DB_VERSION = 1`, behind `M.store`, which sits on one backend interface with two implementations (`idb`, `memory`); a Tauri file-system backend later implements the same seven calls: `open(version, migrations)`, `get(store, key)`, `put(store, value)`, `del(store, keyOrRange)`, `getAll(store, {index, range, count})`, `tx(stores, mode, fn)`, `estimate()`.

| Store | keyPath | Indexes | Value |
|---|---|---|---|
| `docs` | `id` | — | book record |
| `chunks` | `[docId, i]` | — | `{docId, i, bytes: ArrayBuffer}` 8 MiB slices (`bytes.slice()`, never a subarray; no Blob values, for Safari) |
| `decks` | `id` | — | `{id, name, description, createdAt, updatedAt}` |
| `prompts` | `id` | `byCollection (collectionId)`, `byDue (dueAt)` | prompt record, tombstones included |
| `attachments` | `id` | `byPrompt (promptId)` | `{id, promptId, mime, bytes: ArrayBuffer, byteLength, width, height, createdAt}` |
| `meta` | `key` | — | `dataVersion`, `draft:<promptId>`, `pausedSession` |

```json
{ "id": "92b1cb8763aadc6ce1ffa7f4e9ff1171", "sha256": "9f2a…", "hashAlgo": "sha-256", "byteLength": 48211234,
  "fileName": "griffiths-qm.pdf", "title": "Introduction to Quantum Mechanics", "nickname": "Griffiths",
  "pageCount": 412, "chunkCount": 6, "chunkSize": 8388608, "hasBytes": true, "rotation": 0,
  "sections": [{ "title": "Ch. 1 · The Wave Function", "pageIndex": 12, "level": 1, "source": "outline" },
               { "title": "1.2 Normalization", "pageIndex": 16, "level": 2, "source": "outline" }],
  "lastPosition": { "pageIndex": 44, "offset": 0.31, "scale": "fit" },
  "addedAt": 1793750400000, "lastOpenedAt": 1793836800000, "v": 1 }
```

```json
{ "id": "p_8c1f3e2a-…", "collectionType": "book", "collectionId": "92b1cb8763aadc6ce1ffa7f4e9ff1171",
  "kind": "qa", "text": "Q. What is the Schrödinger equation?\nA. $i\\hbar\\,\\partial_t\\Psi = \\hat H\\Psi$\n#ch1",
  "tags": ["ch1"], "attachments": [],
  "anchor": { "pageIndex": 12, "pages": [{ "pageIndex": 12, "rects": [[72.0, 612.4, 318.2, 624.1]] }],
              "quote": "the Schrödinger equation:", "prefix": "is governed by ", "suffix": " which we",
              "items": { "start": { "item": 41, "offset": 0 }, "end": { "item": 41, "offset": 25 } }, "y": 612.4, "lost": false },
  "context": { "docName": "Griffiths", "sectionLabel": "Ch. 1 · The Wave Function", "pageIndex": 12 },
  "cards": [{ "i": 0, "createdAt": 1793836800000, "lastReviewedAt": null, "intervalMs": 432000000, "dueAt": 1794268800000, "log": [] }],
  "dueAt": 1794268800000, "createdAt": 1793836800000, "updatedAt": 1793836800000, "deletedAt": null, "v": 1 }
```

A deck prompt carries `collectionType: "deck"`, `anchor: null` and `context: {docName: "German vocab", sectionLabel: "Verbs", pageIndex: null}`. Ids: `p_`, `deck_`, `a_` + `crypto.randomUUID()` (`getRandomValues` hex fallback on insecure LAN origins); book id = `fingerprints[0]`, with `sha256` for exact identity. `prompt.dueAt` is the minimum over cards, maintained by `M.store.putPrompt` so `byDue` stays valid. All docs, decks and prompts are loaded into memory at boot (`M.data` maps; ~1 ms per 100 prompts) — IndexedDB is the durable copy and exports are built from memory synchronously.

Autosave: the prompt record on Save and on every grade (one `readwrite` transaction); editor drafts to `meta` `draft:<id>` debounced 300 ms (restored when the editor reopens, removed on save/cancel); reading position 1 s after scrolling stops and on `visibilitychange`; settings synchronously to localStorage; nothing on `unload`. Migrations: `MIGRATIONS[v](db, tx)` for `v = oldVersion+1 … DB_VERSION` inside `upgradeneeded` (schema only, IDB requests only); data migrations run after open while `meta.dataVersion < DATA_VERSION`, in batches of 200 prompts. `onversionchange` closes the connection and shows "Marginalia was updated in another tab — reload"; `onblocked` shows "Close other Marginalia tabs"; `onclose` (Safari) drops the cached connection and the next call reopens and retries once. `indexedDB.open` throwing `SecurityError`, or failing with `UnknownError`, switches to the memory backend with a persistent banner "Storage unavailable — export often". `navigator.storage.persist()` is called inside the first "Open PDF" click; usage, quota and persisted state show in the library footer.

## 9. Export/import

`M.exporter` builds strings synchronously from memory, then `deliver(filename, text, mime)`: in the Artifact build → `const d = await claude.use("downloads"); await d.save({filename, data: text})` (a `{code}` rejection falls through); otherwise `<a download>`; in every case the export dialog shows "Copy to clipboard" (`writeText` inside the click, with a pre-selected `<textarea readonly>` fallback). Scopes: everything, one book, one deck.

- **JSON backup** `marginalia-backup-2026-11-03.json`: `{format: "marginalia-backup", version: 1, exportedAt, settings (minus the API key), documents: [doc records, no bytes], decks, prompts (cards, logs, tombstones), attachments: [{id, promptId, mime, width, height, data: base64}]}`.
- **Anki TSV**: two files, since Anki imports one note type per file: `…-basic.tsv` (`Front\tBack\tTags`, one row per `qa` card) and `…-cloze.tsv` (`Text\tBack Extra\tTags`, one row per cloze prompt with `{…}` → `{{cN::…}}`), headers `#separator:tab`, `#html:true`, `#tags column:3`. `M.markup.toAnki` converts `$$…$$` → `\[…\]`, `$…$` → `\(…\)`, newlines → `<br>`, image tokens → `<img src="data:image/png;base64,…">`; the context line becomes tags (`Griffiths Ch-1`).
- **Markdown (Q./A.)**: `# Griffiths`, `## Ch. 1 · The Wave Function`, blank-line-separated prompts in Andy's syntax, clozes as `{…}` paragraphs, images `![snip](data:…)`, `$` delimiters kept, notes as `> note`; no ids (JSON is the round-trip format).

**Import** (`<input type=file accept=.json>` or a paste box): validate `format`/`version`; prompts merge by `id` — newer `updatedAt` wins, a tombstone newer than the local `updatedAt` wins; unknown books are created with `hasBytes: false` (their prompts attach when the PDF is opened later: match by id, then `sha256`); unknown decks are created; existing docs take incoming `nickname`/`sections` only when the local ones are defaults; attachments by id (existing kept); settings only via "Also restore settings". A report lists added/updated/skipped; an import never deletes.

## 10. Architecture & files

```
index.html         shell: 3 screens, review overlay, settings <dialog>, toasts; scripts in dependency order
css/tokens.css     colour/type/spacing tokens, light + dark (§13)      css/app.css   layout, components, text-layer CSS
js/ns.js           namespace bootstrap, uuid(), debounce(), clamp(), hash32()
js/bus.js          M.bus                 js/settings.js  M.settings (localStorage)
js/store.js        M.store + idb/memory backends + MIGRATIONS
js/scheduler.js    M.scheduler (pure)    js/prompts.js   M.prompts (pure)     js/keys.js    M.keys (pure)
js/layout.js       M.layout (pure)       js/anchors.js   M.anchors (pure)     js/markup.js  M.markup (pure, katex injected)
js/attachments.js  M.attachments         js/pdfview.js   M.pdfview (PDF.js: load, lazy render, text, capture)
js/reader.js       M.reader              js/snip.js      M.snip               js/vision.js  M.vision
js/review.js       M.review              js/library.js   M.library (home, deck page, settings)
js/exporter.js     M.exporter            js/app.js       M.app (boot, route, key dispatch, toast, confirm, theme)
tools/bundle.py    single-file bundler   tests/*.test.js node --test
```

Each JS file starts with `var M = typeof window !== "undefined" ? (window.Marginalia = window.Marginalia || {}) : (global.Marginalia = global.Marginalia || {});` and ends with `if (typeof module !== "undefined") module.exports = M.<name>;`, so one file serves classic scripts and node. Public signatures:

```
M.bus.on(type, fn) → off; emit(type, payload)
M.settings.get(key); set(key, v); all(); DEFAULTS                       // "marginalia.settings.v1"; key under "marginalia.apiKey"
M.store.open() → Promise<{mode}>; listDocs(); getDoc(id); putDoc(d); saveDocument(d, bytes); loadDocumentBytes(id); deleteDocument(id);
   listDecks(); putDeck(d); deleteDeck(id); listPrompts(); putPrompt(p); putPrompts(ps); purgePrompt(id); putAttachment(a); getAttachment(id);
   deleteAttachments(ids); getMeta(k); setMeta(k, v); estimate(); persist(); wipe()
M.scheduler.newSchedule(now); grade(s, now, outcome); isDue(s, now); preview(s, now, outcome); rung(ms); buildQueue(opts); LADDER
M.prompts.parse(text); reconcileCards(p, parsed, now); parseBatch(text); sectionFor(sections, pageIndex); contextFor(collection, p);
   normalizeOutlineTitle(title, level); sectionsFromOutline(outline, resolvePageIndex) → Promise<sections>; recontext(collection)
M.keys.normalize(ev) → binding; match(ev, binding); label(binding); dispatch(ev, maps) → action|null; PRESETS; READER_MAP; EDITOR_MAP
M.layout.compute(cards, opts) → [{id, top, collapsed}]
M.anchors.fromSelection(range, pages); viewportRects(anchor, pageIndex, viewport); anchorY(anchor, pageTops, viewports);
   refind(anchor, index, pageIndex); fromMarginY(pageIndex, yPdf)
M.markup.tokenize(text); render(text, {mask, mode, imageUrl}) → html; toAnki(text, images); toMarkdown(text, images)
M.attachments.storeFile(file, promptId) → Promise<att>; url(id); preload(ids); collectGarbage(prompt)
M.pdfview.open(bytes, {container, scale, rotation}) → Promise<Doc>
   Doc: numPages, fingerprint, title, outline(), pageTops(), viewport(i), scrollTo(i, yPdf), setScale(s), setRotation(r),
        textIndex(i) → Promise<index>, capture(i, rectCss, {k}) → Promise<Blob>, renderedPages(), close()
M.reader.open(docId, {promptId, pageIndex}); close(); createFromSelection(kind); createFreeNote(pageIndex, yPdf, text); openEditor(id); focusCard(id); drawHighlights(pageIndex)
M.snip.enter(); exit(); getMode(); setMode(m); handleRegion(pageIndex, rectCss)
M.vision.detect() → Promise<"artifact"|"apikey"|null>; transcribe(blob) → Promise<{latex, display, wrapped}>; test(); postprocess(text)
M.review.start({scope, collectionId, now}); stop(); resume(); reveal(); mark(outcome); skip(); undo(); current()
M.library.render(); openDeck(id); importFile(file); openSettings(tab)
M.exporter.backupJSON(scope); ankiTSV(scope); markdownQA(scope); deliver(filename, text, mime); importJSON(text) → report
M.app.boot(); route(screen, params); toast({text, actions, timeout}); confirm({title, body, confirmLabel, danger}) → Promise<boolean>
```

**Event flow** (`M.bus`): `doc:opened {docId, doc}` → reader, library; `pages:measured {tops}` and `scale:changed {scale}` → reader → layout and highlights; `page:rendered {pageIndex, viewport, pageEl, textDivs}` → `drawHighlights`; `page:textready {pageIndex, index}` → `anchors.refind`, find; `page:evicted` → reader drops layer refs; `selection:changed` → adder pill; `prompt:saved|deleted|restored {prompt}` → reader, library counts, review; `prompts:recontexted {collectionId}` → review, library; `review:graded` → library badges; `review:gotoSource {promptId}` → `M.app.route`; `review:ended {summary}` → library; `settings:changed {key, value}` → theme, margin mode, dim, review keys, snip mode; `store:mode` → banner. Modules never call across screens: `M.app` owns the three review triggers and the reader never imports `M.review`. Script order: `pdf.min.js`, `katex.min.js` (cdnjs), then ns, bus, settings, store, scheduler, prompts, keys, layout, anchors, markup, attachments, pdfview, reader, snip, vision, review, library, exporter, app. Tracks: A = pdfview + anchors + capture; B = reader + layout + markup + attachments + snip; C = review + scheduler + keys + library + settings; D = store + exporter + vision + prompts + bundle + tests.

**Bundle**: `python3 tools/bundle.py` (stdlib only, ~90 lines) inlines every local `<link rel=stylesheet>` and `<script src="js/…">` of `index.html` in place, keeps cdnjs and Google Fonts tags, and writes `dist/marginalia.html`. `--artifact` additionally downloads `katex.min.css` and its 20 woff2 fonts into `tools/.cache/`, inlines the CSS as `<style>` with `data:font/woff2;base64` URIs (woff/ttf `src` entries dropped; ≈ 372 KB), and sets `<meta name="marginalia-build" content="artifact">`, which `M.app` reads to prefer the `sample`/`downloads` capabilities (the publish declares `capabilities: {sample: {images: true}, downloads: true}`). Result: one file under 1.5 MB.

## 11. Edge cases

- **Scanned PDFs**: no text items → the page gets `data-notext`, selection is impossible, the adder never appears, a one-time chip says "No text layer — use free notes and snips"; notes, snips and review work unchanged. No OCR.
- **Huge PDFs (500+ pages, 50 MB)**: bytes stored as 8 MiB chunks, reassembled once; placeholders sized from page 1 until `getViewport` measurements arrive in idle batches of 25 (`pages:measured` re-runs layout); an `IntersectionObserver` at `rootMargin: 100% 0px` enqueues renders, a serial queue renders one page (canvas + text layer) at a time, a second observer at `300% 0px` evicts (cancel tasks, `canvas.width = canvas.height = 0`, drop layers, `page.cleanup()` after the cancelled promise settles); DPR is capped so `width·height·dpr² ≤ 16 777 216`; the text index (`text`, `Uint32Array` item starts, `Float32Array` boxes, ≈ 40 KB/page) is built eagerly for rendered pages and in the background for find; `doc.cleanup()` on zoom jumps ≥ 2×.
- **Rotated pages**: `getViewport({rotation: page.rotate + doc.rotation})`; anchors are PDF-space, so only `convertToViewportRectangle` changes; snips map through the same viewport pair.
- **Selection across pages**: rects per page in `anchor.pages`, highlights on each, the card at the first page's first rect; three or more pages are truncated to two with a "selection shortened" chip.
- **Duplicate opens**: same fingerprint and `sha256` → open the existing book; same fingerprint, different `sha256` → in-page choice "Replace file, keep prompts" (anchors marked `lost` for lazy re-finding) or "Add as a separate book" (`id = fingerprint + ":" + sha256.slice(0, 8)`); a `hasBytes: false` book from an import is matched by id, then `sha256`.
- **Storage quota**: `estimate()` before saving; `quota − usage < 1.2 × bytes` shows the numbers but allows the attempt; doc record and chunks share one transaction, so a `QuotaExceededError` abort leaves no half-book; the error toast offers "Delete a book" and "Export"; Safari users see one note about the 7-day eviction rule.
- **Worker failing**: PDF.js falls back to the fake worker on its own; the "Preparing document…" state covers the main-thread parse. If `pdf.min.js` never loads (offline, CDN blocked) `M.pdfview.open` rejects `{code: "no_pdfjs"}`, the reader shows "PDF engine not available — retry", and library, decks and review still work because they never touch PDF.js; a missing `katex` renders math as monospace source.
- **Dark mode for the canvas**: pages stay paper-white (no filters, `pageColors` unused); "Dim pages" adds `<div class="dimmer">` (`background: var(--dim)`, `pointer-events: none`) above each page's layers; highlights multiply on white and dim with the page.
- Also: `getDocument` detaches its buffer, so bytes are stored from an independent copy; a prompt whose page exceeds `pageCount` after a replacement is marked `lost`; without `crypto.subtle` (LAN `http://`) FNV-1a is used and recorded in `hashAlgo`.

## 12. Test plan

`node --test tests/` (node 23, no dependencies; pure modules are `require`d directly):

- `scheduler.test.js`: the seven vectors of §7; `isDue` exactly at `now + 16 h`; jitter range; `rung()` at ladder edges (5 d → 0, 5.6 d → 0, 11.5 d → 1, 0 → −1); `buildQueue` order for every scope with a fixed seed, exclusion of tombstones and cardless prompts, "today" ignoring dueness; retry append and the 3-retry cap; undo restores the exact previous object.
- `prompts.test.js`: multi-line answers, `Q.` without `A.`, 1 and 3 deletions, braces inside `$\frac{a}{b}$` ignored, a deletion containing math masked whole, tags line, `note`/`highlight`; `reconcileCards` keeps schedules by index; `parseBatch` with `# Section` and blank lines; `normalizeOutlineTitle("1 The Wave Function", 1) === "Ch. 1 · The Wave Function"`, "Chapter 3:" and roman numerals; `sectionFor` deepest-item rule with manual winning ties; `contextFor` and the `p. N` fallback.
- `layout.test.js`: no overlaps and `top ≥ anchorY` for 200 random cards; active card pinned with a minimal upward chain; out-of-room slide-down; collapse beyond 320 px; idempotence.
- `anchors.test.js`: fake viewport (`transform = [s, 0, 0, −s, 0, H·s]`) round-trips, line merging, multi-page split, all four `refind` strategies and the miss path.
- `keys.test.js`: normalisation of `" "`, shifted letters, arrows; `match` ignores repeat; `dispatch` skips text fields; presets; conflicts; labels.
- `markup.test.js` (katex stubbed): all four delimiter pairs, `\$`, no newline inside `$…$`, image tokens, masking before rendering, error fallback when the stub throws; `toAnki`/`toMarkdown`.
- `exporter.test.js`: backup round-trip into an empty state is deep-equal; merge rules; TSV escaping; cloze → `{{c1::}}`.

Manual checklist (Chrome and Safari on macOS; `python3 -m http.server`, `file://`, the Artifact): 400-page PDF scrolled end to end with no frame over 50 ms; zoom ladder keeps the passage in view; Q/A, cloze, plain highlight, double-click note and Cmd+V notes (text, OS screenshot) created; highlights survive zoom and rotate; today's prompts reviewed, one forgotten and returned, a grade undone; Forgot rebound to ArrowLeft, key cap updated; Image snip pasted into Preview.app, LaTeX snip pasted into the editor; three exports plus copy-to-clipboard in the Artifact; backup imported into a fresh profile, anchors re-found once the PDF is added; draft restored after a reload mid-edit; delete and undo; same PDF opened twice; quota exceeded; worker URL blocked (fake-worker path); dark mode and dim pages; 800 px (rail) and 400 px (stack) with no horizontal scrollbar.

## 13. Visual design tokens

```css
:root {
  --bg: #f3f1ec; --surface: #fff; --surface-2: #ebe8e1; --line: #d9d5cc;
  --text: #1f1d1a; --text-2: #6b665e; --text-3: #9a948a;
  --accent: #d2452f; --accent-ink: #fff; --accent-2: #e9a53a; --focus: #2d6cdf; --ok: #2e7d32; --danger: #b3261e;
  --paper: #fff; --page-shadow: 0 1px 4px rgba(0,0,0,.25); --dim: rgba(0,0,0,.35);
  --highlight: rgba(255,214,0,.45); --highlight-active: rgba(255,170,0,.65); --find: rgba(90,160,255,.45);
  --review-bg: #f4e9d8; --review-ink: #2a241c; --review-muted: #8a7b66; --review-accent: #d2452f;
  --review-btn: #fbf5ea; --review-btn-hover: #f1e4cf; --card-focus: #fff8e1;
  --font-ui: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --font-display: "Outfit", var(--font-ui);      /* Google Fonts: Outfit 400/500/700 */
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --fs-12: 12px; --fs-13: 13px; --fs-14: 14px; --fs-16: 16px; --fs-20: 20px; --fs-24: 24px; --fs-28: 28px; --fs-36: 36px; --fs-44: 44px;
  --sp-1: 4px; --sp-2: 8px; --sp-3: 12px; --sp-4: 16px; --sp-6: 24px; --sp-8: 32px; --sp-12: 48px;
  --radius: 6px; --radius-lg: 10px; --toolbar-h: 48px; --card-w: 272px; --margin-w: 304px;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme=light]) { /* dark values below */ } }
:root[data-theme=dark] { /* the same dark values */ }
body { background: var(--bg); color: var(--text); font: var(--fs-14)/1.45 var(--font-ui); }
```

Dark values: `--bg #1c1b19`, `--surface #262522`, `--surface-2 #2f2d29`, `--line #3a3833`, `--text #ece8e0`, `--text-2 #a39d92`, `--text-3 #726c62`, `--accent #ff6b57`, `--accent-2 #f5c451`, `--focus #7aa7ff`, `--ok #6abf73`, `--danger #ff7b72`, `--page-shadow 0 1px 6px rgba(0,0,0,.6)`, `--review-bg #2b2419`, `--review-ink #f1e9dc`, `--review-muted #a08f78`, `--review-accent #ff6b57`, `--review-btn #3a3023`, `--review-btn-hover #46392a`, `--card-focus #2f2a1e`. `--paper`, `--highlight`, `--find` and `--dim` are identical in both themes because pages stay white. The theme setting writes `data-theme` on `<html>` (`system` removes it).

Type: margin cards 14/13 px UI font (question `--text`, answer `--text-2`); context line 12 px uppercase, `letter-spacing: .08em`, `--review-muted`; review question Outfit 500 at 44 px (≤ 60 chars), 36 px (≤ 140), else 28 px, `letter-spacing: −.01em`; answer Outfit 400 at 24 px; buttons 16 px/500 with a 12 px `<kbd>` (1 px `--line` border). The review overlay is `--review-bg` edge to edge, no borders, buttons as quiet filled pills (`--review-btn`), the ladder in `--review-muted` with `--review-accent` on the current stop: warm paper, big question, quiet controls. Spacing uses the 4 px scale only; shadows only on pages, popovers and the bottom sheet.

## 14. Library, decks, cross-document review & context line

**Home screen**: "Review all · N due" (due cards over books and decks, recomputed on `review:graded`, `prompt:saved|deleted` and every 60 s), the "written today" banner, Books (nickname, pages, prompts, due, "Continue reading · p. N", "Review this book", `⋯` → Rename, Export, Delete) and Decks ("Open deck", "Review this deck", `⋯` → Rename, Export, Delete) plus "+ New deck" (in-page name field). Rows sort by `lastOpenedAt` desc.

**Deck page**: name (click to rename), description, counts, "Review this deck", a prompt list (search over question/answer/tags; row = section, rendered question, muted answer, due-in, `⋯` → Edit, Delete, Move to…) and the **Add prompts** textarea parsed by `M.prompts.parseBatch`:

```
# Verbs
Q. to run
A. laufen

Der Hund {bellt} laut.
```

Blank lines separate prompts; `# Section` lines set `context.sectionLabel` for what follows; each block goes through `parse`; a live preview lists the parsed cards with KaTeX and per-block errors; "Add N prompts" (Cmd+Enter) stores them with `createdAt` spaced 1 ms apart so deck order is stable. Images paste exactly as in the margin editor.

**Collection model**: `collectionType ∈ {book, deck}` + `collectionId`; one collection per prompt. "Move to…" lists decks (and books only for prompts without an anchor); moving a book prompt to a deck runs `M.app.confirm("Move to deck? The highlight is dropped.")`, sets `anchor: null`, recomputes `context`, emits `prompt:saved`. Deleting a deck confirms in-page and tombstones its prompts (Undo toast 8 s, then purge).

**Global queue**: §7 `scope: "all"`: every due card from every collection, by due day then deterministic shuffle, so one session mixes Griffiths with German vocab. The card needs no PDF: question, answer, context, `anchor.quote` and attachments come from the prompt and attachment stores.

**Context line**: `contextFor(collection, prompt)`: books → `nickname · sectionLabel`, else `nickname · p. N`; decks → `name · sectionLabel`, else `name`. `sectionLabel` = `sectionFor(sections, pageIndex)`: the deepest item with `pageIndex ≤` the prompt's page (ties: `source: "manual"` wins); a level-2 item is prefixed by its nearest level-1 ancestor, `Ch. 1 · The Wave Function · 1.2 Normalization`, capped at 72 characters.

**Outline at import** (`sectionsFromOutline(outline, resolve)`): `doc.getOutline()` walked depth-first to level 2; each `dest` resolved (string → `getDestination`, then `getPageIndex(dest[0])`; URL-only items skipped); items with a page sorted by page; `normalizeOutlineTitle`: `^(Chapter|Ch\.?)\s*(\d+|[IVXLC]+)[.:]?\s+(.*)` and `^(\d+)\s+(.*)` at level 1 → `Ch. N · Title`, level 2 keeps `1.2 Title`; whitespace collapsed, 60-char cut. Resolution runs once in the "Preparing document" phase.

**Manual chapter marks**: page menu → "Mark chapter start here" → in-page input prefilled `Ch. N · ` → `sections.push({title, pageIndex, level: 1, source: "manual"})`; edited or removed in Settings → "Chapters". **Nickname** edits (library `⋯` → Rename, or the toolbar title) and any sections change call `M.prompts.recontext(collection)`: every prompt of the collection gets a fresh `context` snapshot, written in one batch (`prompts:recontexted`). Default nickname: metadata `Title` if 3–80 printable characters and not a file name, else the file name without extension, cut to 24 characters.

**Snapshotted on the prompt**: `context {docName, sectionLabel, pageIndex}`, `anchor.quote`, `kind`, `text`, attachment ids — everything review displays. **Go to source**: §7; the reader loads bytes, waits for `pages:measured`, scrolls, focuses, pulses, and shows "Resume review".

## 15. Snip tool, image attachments & LaTeX transcription

**Interaction**: S or ✂ enters snip mode: `#reader[data-snip]`, cursor `crosshair`, text layer `pointer-events: none`, toolbar hint "Drag over the page · Esc to leave". `pointerdown` on a page starts a page-local drag, `pointermove` draws `.snip-rect` (1 px `--accent`, outside dimmed), `pointerup` finishes; drags under 4 × 4 px are ignored; the mode stays for further snips until Esc or a click outside a page. The segmented control "Snip copies: Image | LaTeX" sits beside the button; Shift+S toggles it; `settings.snipMode` remembers it; without a vision backend the LaTeX option is disabled ("needs an API key or the Artifact").

**High-DPI capture** (`M.pdfview.capture(pageIndex, rectCss, {k: 3})`): `s = z·dpr·k` (z = current scale); if `rect.w·rect.h·(dpr·k)² > 16 777 216` scale `s` down by the square root of the excess (canvas budget, iPad-safe); if the long edge would exceed 8000 px scale down again; `f = s/z`; `vp = page.getViewport({scale: s, rotation, offsetX: −rect.x·f, offsetY: −rect.y·f})`; canvas `round(rect.w·f) × round(rect.h·f)`, `getContext("2d", {alpha: false})`; `await page.render({canvasContext, viewport: vp}).promise` draws only the region (offsets apply after scale and rotation, so the on-screen rectangle maps exactly); `canvas.toBlob(…, "image/png")`. A still-running capture is cancelled by the next one.

**Clipboard inside the gesture** (`M.snip.handleRegion`, synchronous in `pointerup`):

```js
var png = M.pdfview.capture(pageIndex, rect, {k: 3});                       // Promise<Blob>, starts now
var write = (mode === "image")
  ? navigator.clipboard.write([new ClipboardItem({"image/png": png})])
  : navigator.clipboard.write([new ClipboardItem({"text/plain":
      png.then(function (b) { return M.vision.transcribe(b); })
         .then(function (r) { return new Blob([r.wrapped], {type: "text/plain"}); })})]);
```

Both values are `Promise<Blob>` (Chrome ≥ 98, Safari ≥ 13.1), so `write()` is issued inside the user gesture and resolves later. The toast shows "Copying image…" / "Transcribing…" with a spinner, then "Image copied — press Cmd+V where you want it" or "LaTeX copied — press Cmd+V where you want it" with the LaTeX in monospace (3 lines) and a KaTeX preview, plus "Switch to LaTeX/Image" and, only while an editor is open, "Add to prompt" (inserts at the caret). If `ClipboardItem` is undefined or `write` rejects (`NotAllowedError`, a second snip pre-empting the first in Safari, a vision error), the toast switches to the fallback: the image to right-click, or the LaTeX with "Copy" (fresh gesture: `write` with the resolved Blob / `writeText`) and "Insert at cursor". Vision errors show their message there ("No equation found" offers "Copy image" and "Switch to Image"). Snips never create prompts, anchors or history (D6, D21).

**Cmd+V**: the editor textarea's `paste` handler scans `clipboardData.items` for `kind === "file"` with an `image/*` type first; if found: `preventDefault()`, `M.attachments.storeFile(file, promptId)`, `textarea.setRangeText("![snip](att:" + id + ")", start, end, "end")`, dispatch `input`; otherwise the browser pastes text natively (LaTeX arrives already wrapped). With `#reader` focused and no editor open, its `paste` handler creates a free note at the middle of the visible page: an image gives `Q. ![snip](att:<id>)\nA. `, text gives `Q. <text>\nA. `, and the editor opens with the caret after `A. `. Dropped image files on the editor behave like paste; dropped PDFs on the library open.

**Attachments**: `storeFile` decodes via `createImageBitmap`, downsizes long edges above 2000 px (PNG stays PNG, JPEG stays JPEG, others → PNG), rejects results over 4 MB with a toast, stores `{id, promptId, mime, bytes: ArrayBuffer, width, height}`; `url(id)` returns a cached `URL.createObjectURL(new Blob([bytes], {type: mime}))`, revoked on `page:evicted` and review close. Rendering: `<img class="att">`, `max-height: 120px` in cards, `max-width: 100%` in review and preview. GC: on save, the prompt's attachments whose token is absent are deleted; on cancel, those created in that editing session; at boot, attachments older than a day with no owner or no token. Every paste is a new attachment, so GC is a per-prompt question.

**Vision backend** (`M.vision`): `detect()` → `"artifact"` when `window.claude?.use` exists and `sample.limits()` reports images, else `"apikey"` when `localStorage["marginalia.apiKey"]` is set, else `null`. `transcribe(blob)` → `{latex, display, wrapped}` or rejects `{code, message}`, codes `no_backend, not_granted, images_unavailable, no_math, refusal, auth, rate_limit, server, network, cutoff`.

- *API key*: `POST https://api.anthropic.com/v1/messages` with headers `x-api-key`, `anthropic-version: 2026-10-21`, `content-type: application/json`, `anthropic-dangerous-direct-browser-access: true`, `anthropic-beta: server-side-fallback-2026-07-01` and body `{model, max_tokens: 1024, output_config: {effort: "low"}, fallbacks: "default", messages: [{role: "user", content: [{type: "image", source: {type: "base64", media_type: "image/png", data: b64}}, {type: "text", text: INSTRUCTION}]}]}` (no `temperature`). 401 → `auth` ("Invalid API key — check Settings"), 429 → `rate_limit` (shows `retry-after`), 5xx/529 → `server`, `TypeError` → `network` ("the browser blocked the request"); `stop_reason === "refusal"` → `refusal` ("The model declined this image"); `max_tokens` → `cutoff` (text still used); text = joined `content[].type === "text"` blocks.
- *Artifact*: `const sample = await claude.use("sample")` (null → `not_granted`); `const caps = await sample.limits().catch(() => null)` (`!caps?.images` → `images_unavailable`); `const {text} = await sample(INSTRUCTION, {images: [blob], modelTier: "default", cache: false})`; rejections `{code, message}` pass through; never retried.
- `INSTRUCTION` is the research text ("Transcribe every piece of mathematics … return exactly the single token NO_MATH"). `postprocess`: trim; strip fences and a `latex:` label; `NO_MATH` → `no_math`; strip stray `$$`, `$`, `\[ \]`, `\( \)`; `display = \begin{ present || >1 line || \\ || (relation && (tall operator || length > 24))`; multi-line without an environment → `\begin{aligned}…\end{aligned}`; `wrapped = display ? "\n$$\n" + t + "\n$$\n" : "$" + t + "$"`; a failing `katex.renderToString(t, {throwOnError: true})` only adds "May not render" to the toast.

**Settings → "LaTeX from snips"**: API key (`type=password`, "stored in this browser only, never exported"), model (default `claude-opus-5-5`), "Test" (renders `x^2` to a 120 × 60 canvas and transcribes it), "Forget key". The key lives in `localStorage["marginalia.apiKey"]`, outside the settings object, so no export path can include it; the Artifact build hides the section when the `sample` backend is active.

## 16. Math rendering

**Loading**: local build — `<script src="https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.47/katex.min.js">` plus `<link rel="stylesheet" href="…/KaTeX/0.16.47/katex.min.css">`; Artifact build — the same script, the CSS inlined by `tools/bundle.py --artifact` with the 20 woff2 fonts as data URIs (cdnjs has no ttf; woff/ttf `src` entries dropped). KaTeX earns its place because R4 requires math in four surfaces and a monospace fallback would make a physics textbook's prompts unreadable. `contrib/auto-render` is not loaded: it walks live DOM, whereas Marginalia renders from tokens after cloze masking, so `M.markup` owns the delimiter scan. `M.markup` checks `typeof katex` at call time.

**Where**: `M.markup.render(text, {mask, mode, imageUrl})` is the only HTML producer for prompt text — margin cards (`card`), the editor's live preview under the textarea (`preview`, on `input` debounced 120 ms; always visible in wide mode, Cmd/Ctrl+P toggles it in rail/stack), prompt lists, and the review overlay (`review`: question, answer, cloze paragraph). Pipeline: (1) `tokenize` splits `text`, `math` (`$$…$$`, `\[…\]` display; `\(…\)` and single-line `$…$` inline; `\$` literal; no newline inside `$…$`) and `image` tokens; (2) cloze scanning runs over `text` tokens only, so `\frac{a}{b}` is never a deletion, while a `{…}` that opens in text and closes after a math token masks the math with it — one blank (R4); (3) text → escaped with `\n` → `<br>`; math → `katex.renderToString(src, {displayMode, throwOnError: false, output: "html", strict: "ignore"})` in `try/catch` (a thrown error or missing `katex` → `<code class="tex tex--error" title="…">src</code>` with a red underline); image → `<img>` or a "missing image" chip; masked deletion → `<span class="cloze-blank">`; revealed → `<mark class="cloze-reveal">`; (4) display math sits in `<div class="math-display">` with `overflow-x: auto`, so a long equation scrolls inside its card, never the page.

**Exports**: `toAnki` converts `$$…$$` → `\[…\]` and `$…$` → `\(…\)` (MathJax delimiters) and leaves `\(`/`\[` alone; `toMarkdown` keeps `$` delimiters verbatim; both replace image tokens with data: URIs (`<img src="data:…">` for Anki, `![snip](data:…)` for Markdown); the JSON backup stores the raw text untouched.
