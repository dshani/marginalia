# Marginalia — Final specification (v1)

Base: Design A (fidelity, highest score). Grafted: every "mustGraft" item of all three judges; every open question is resolved below as a decision. DECISIONS.md (D1–D21) and the addendum (R1–R7) are binding. Four engineers implement this in parallel (tracks in §18); nothing here is optional unless marked "cut from v1".

**v1 cut line.** Ships: library + decks, reader with lazy rendering, find (simple string search), margin prompts (Q/A, cloze, note, highlight), tags (last-line `#tags` only), flags, markers mode, three breakpoints, drafts, review (book / deck / today / all) with starburst, configurable review keys, snip tool (Image / LaTeX), KaTeX, JSON / Anki / Markdown export, JSON import, prompt-list drawer (search, edit, move, delete). **Cut from v1:** `/` templates, Alt+← history, page rotation, bulk list operations, a "Chapters" settings editor, library arrow-key navigation, the "wide-narrow" breakpoint, auto-render.

## 1. Product summary

1. Open Marginalia: the home screen lists Books and Decks with prompt and due counts, "Review all · 23 due" at the top and, after a writing session, "6 written today · Review".
2. "Continue reading" on *Griffiths* reassembles the PDF from IndexedDB and opens page 36 at 125% with a 288-px right margin.
3. Drag over "a potential energy function", press N: the passage turns yellow and an editor card opens in the margin at the passage's height.
4. Type `Q. What does V stand for?`, Tab (inserts `A. `), the answer; Cmd+Enter saves. The card settles: glyph, question, answer in lighter type; focus returns to the page.
5. Select a sentence and press C: the editor opens with the sentence and the selection in `{braces}`; each brace is its own review card.
6. For an equation press S and drag a box: the region is re-rendered at 3× device pixels and lands on the clipboard as PNG or (via Claude) as `$$…$$`; Cmd+V pastes it into the next card.
7. At a stopping point press T: warm paper covers the viewer; "GRIFFITHS · CH. 1 · THE WAVE FUNCTION" sits above a large question; Space shows the answer, 1/2 grades it; the starburst's ray grows to "5d".
8. Forgotten prompts return at the end of the same session (at most three asks); "All caught up" ends it.
9. Five days later "Review all · 23 due" interleaves every book and deck by due day; G opens the source passage; "Resume review" brings the session back.
10. Everything stays in this browser (IndexedDB); JSON, Anki and Markdown exports leave by download or clipboard.

## 2. Screens & layout

Three screens (`#library`, `#reader`, `#deck`), a fourth since D27 (`#stats`, the statistics page; BUILD-NOTES "Scheduling and statistics"), and two layers (`#review` overlay, `#settings` panel) in one `index.html`; `M.app.route()` shows one screen. Widths are CSS px.

**Library (1280 wide; content column max 880, centred)**

```
┌───────────────────────────────────────────────────────────────┐
│ Marginalia            [▶ Review all · 23 due]  [Add PDF] [New deck] [⚙] │ 56
│ 6 prompts written today                     [Review today's]  │ 40 (only when > 0)
│ BOOKS                                                         │
│ │ Griffiths ✎   322 pp · 41 prompts · 7 due · p. 36  [Continue reading] [Review] ⋯ │ 64
│ DECKS                                                         │
│ │ Thermo formulas   18 prompts · 3 due               [Open] [Review] ⋯ │ 64
│ 61 MB used · persistent                 Export all · Import   │ footer
└───────────────────────────────────────────────────────────────┘
```

**Reader, wide mode (container ≥ 1000)** — toolbar 44 px; below it one scroll container `#scroller` holding a flex row: left gutter (flex 1, min 24), `#pages` (width = rendered page width), `#margin` (288 = 16 + 256 card + 16). `#margin` is `position: relative` with height = total document height; cards are `position: absolute` with a `top` (§6).

```
┌ [‹ Library] Griffiths ✎  [36]/322  [−] 125% [+] [⊡]  [✂ Snip] [Image│LaTeX]  [Review ▾] [?] ┐ 44
├────────┬───────────────────────────────────────────┬────────────────────┤
│ gutter │ page column (Letter = 816 at 100%)        │ margin 288         │
│ ≥ 24   │ ┌───────────────────────────────────────┐ │  ┌─────256──────┐  │
│        │ │ …where V(x,t) is ███a potential ███   │ │  │✦ What does V │  │
│        │ │ ███energy function███. As in…         │ │  │  stand for?  │  │
│        │ │     $$ i\hbar\,\partial_t\Psi = … $$  │ │  │  The potent… │  │
│        │ └───────────────────────────────────────┘ │  └──────────────┘  │
```

Zoom: "fit width" (default) = `pageColumnWidth / pageWidthPt`, capped at scale 1.6667; readout = `round(scale / 1.3333 × 100) + "%"` (PDF.js convention: Letter is 816 px at 100%), so a wide screen reads 125% as in the video. Manual zoom steps the ladder `[0.5, 0.67, 0.8, 1, 1.25, 1.5, 1.6667, 2, 3, 4]`; beyond fit width the page column scrolls horizontally inside `#scroller`, never the window. Breakpoints are measured on `#reader` with a `ResizeObserver`, never `window.innerWidth`.

| Mode | Container | Page column | Prompts |
|---|---|---|---|
| Wide | ≥ 1000 | fit in `W − 288 − 48` | 256-px cards, expanded; M toggles markers |
| Rail | 600–999 | fit in `W − 44 − 32` | 44-px rail; one 24-px marker per bucket (anchors within 60 px merge, count badge); click/focus/Enter opens the card as `.popover` (`max-width: min(320px, 100vw − 32px)`); Esc closes; ↑↓ move between markers; editing happens in the popover |
| Stack | < 600 (so 400) | fit in `W − 32`, zoom clamped to fit | no rail; a 16-px badge after each highlight's last rect; tap/Enter opens `#sheet` (`position: fixed; bottom: 0; max-height: 60vh`) with the card or editor; L lists all prompts |

At 400 px nothing scrolls horizontally: `#app { overflow-x: hidden }`, popovers/sheets/toasts `max-width: calc(100vw − 32px)`, card text `overflow-wrap: anywhere`, display math scrolls inside `.math-display`, the toolbar collapses to `[‹] [title] [36/322] [✂] [⋯]`.

**Review overlay** — `position: fixed; inset: 0; background: var(--review-bg)`, column `max-width: 640px` centred, padding 24.

```
┌──────────────────────────────── warm paper ───────────────────────────────┐
│ ✺━━━━━━━●━━━━━━━━━━━━━━━━━━━━━━━━━━━━━                 Exit review ✕      │ 56
│    5d    2wk    1mo    2mo    4mo    1yr        (legend, 12 px)           │
│            GRIFFITHS · CH. 1 · THE WAVE FUNCTION          12/16 caps      │
│            What is the Schrödinger equation?              Outfit 36/42    │
│            [answer springs in after Space; source quote below, muted]     │
│            ┌──────────────────── 640 ───────────────────┐                 │
│            │ [ Show answer   ␣ ]                [Skip  S] │ 56            │
│            └───────────────────────────────────────────┘                 │
└───────────────────────────────────────────────────────────────────────────┘
```

After reveal the bar is `[ Forgot  1 · again this session ]  [ Remembered  2 · next in 5 d ]`, two equal halves; "12 of 40" sits top-left under the starburst in `--review-ink-2`.

## 3. Interactions & keyboard

**Open PDF**: "Add PDF" (`#fileInput`, `accept="application/pdf,.pdf"`), a file dropped on the library, or Cmd/Ctrl+O. `M.library.addPdf(file)`: `bytes = new Uint8Array(await file.arrayBuffer())` → `sha256` (FNV-1a fallback, `hashAlgo` recorded) → `M.pdfview.open(bytes.slice())` for `fingerprints[0]`, `numPages`, metadata, outline → duplicate check (§11) → `M.store.docs.saveDocument(record, bytes)` (metadata and chunks in one transaction) → `M.app.route("reader", {collectionId})`. A "Preparing document…" bar covers the parse.

**Select → create**: a drag on the text layer (official `endOfContent` helper). `selectionchange` (debounced 50 ms) snapshots the selection as an anchor in PDF space (`M.reader.selection`), so it survives focus moving to the editor. The adder `#adder` (`N Prompt · C Cloze · H Highlight`) floats at the selection's end. N opens an editor card at the anchor with `Q. ` and the caret after it; C opens it with `M.anchors.sentenceAround(anchor, textIndex)` — the sentence containing the selection with the selection wrapped in `{}`; H stores a `highlight` record (no card). With no selection, N or a margin double-click creates a free note at that y (double-click) or the middle of the visible page (N). A highlight or note becomes a prompt by editing its text (same id and anchor).

**Editor** (one component, `M.editor`, reused by margin card, rail popover, bottom sheet and the deck "Add prompts" box): raw textarea, live preview below (debounced 120 ms), one quiet lint line, `[{}]`, `[Save ⌘↩]`, `[Cancel esc]`. Keys inside the textarea: Cmd/Ctrl+Enter save; Cmd/Ctrl+Shift+Enter save and open another new card on the same anchor; Esc cancel (a new card is discarded; an existing one reverts; the draft is cleared); Tab inserts `\nA. ` when no `A.` line exists, else moves the caret to after `A. `; Shift+Tab moves back to after `Q. ` (Tab is only captured while the parse kind is `qa` or the text is empty; otherwise it is left to the browser); Alt/Option+Shift+C wraps the textarea selection in `{}` (not Cmd+Shift+C: Chrome's inspect shortcut); Cmd/Ctrl+V per §15. Blur does not save (a stray click on a toast button must not close the editor); drafts persist (§8).

**Delete**: Backspace/Delete on a focused card or the menu → tombstone (`deletedAt`), card and highlight vanish, toast "Prompt deleted · Undo (Z)" for 8 s; Z or the button clears `deletedAt`. After delete, focus goes to the next card, else `#reader`.

**Navigate**: J/K next/previous card in document order (scrolling the passage into view), Enter toggles the focused card's answer, E edits, G scrolls the passage to one third of the viewport and pulses the highlight, F flags, clicking a highlight focuses its card; hovering either side sets `.card--hot` and `.hl--active` on both.

| Key (reader) | Action |
|---|---|
| N / C / H | prompt / cloze / highlight for the selection (N without selection: free note) |
| J / K / E / Enter / G / F | next / previous card, edit, toggle answer, go to passage, flag |
| Backspace, Delete / Z | delete focused card / undo delete (toast visible) |
| A / M / D | hide answers in margin / markers mode / dim pages (persisted toggles) |
| L / Cmd+F / P | prompt list drawer / find (Enter, Shift+Enter cycle, Esc closes) / page box |
| S / Shift+S / Esc | snip mode / toggle Image–LaTeX / leave snip |
| R / Shift+R / T | review this book / all / today's prompts |
| Shift+C | mark chapter start here (§14) |
| Cmd+= Cmd+− Cmd+0 | zoom in / out / fit width |
| Cmd+O / Cmd+V / ? / , | open PDF / paste (§15) / shortcut sheet / settings |

Cmd is Ctrl outside macOS. **Focus owner**: one of `reader | card | editor | list | review | library | settings`, set by `M.app.setFocusOwner`; one `keydown` listener on `document` calls `M.keys.dispatch(ev, maps)` with the maps for the owner; inside `input, textarea, select, [contenteditable]` only `EDITOR_MAP` is consulted; `ev.repeat` and `ev.isComposing` are ignored. `#reader` has `tabindex="-1"` and regains focus after every editor, toast, popover or sheet closes; after save the DOM selection is cleared and the adder hides. Cards use roving `tabindex` (`.card--focused`, `aria-current="true"`). Popovers, the sheet and the overlay trap Tab and return focus to their invoker on Esc. No `alert/confirm/prompt`: `M.app.confirm()` renders `#confirm` in-page.

## 4. Prompt model & syntax

One textarea per prompt; `M.prompts.parse(text)` is the single source of truth:

```
parse(text) → { kind: "qa"|"cloze"|"note"|"highlight", question, answer, body,
                deletions: [{start, end, text, cue?}], tags: string[], display: string, lints: [{code, msg}] }
```

- **qa**: a line starting `Q.` and a later line starting `A.`; `question` = text between (multi-line), `answer` = everything after `A.` (multi-line). `Q.` without `A.` parses as `note` with lint `no_answer` ("Add an A. line to make this reviewable"); never blocked.
- **cloze**: no `Q./A.` line and ≥ 1 `{…}` outside math runs and image tokens (`M.prompts.tokenize` runs first, so `\frac{a}{b}` never clozes; a `{…}` that opens in text and contains a math run is one deletion). `\{` is a literal brace; nested braces: the outer span wins. Deletion *i* = card *i*. Question side: body with deletion *i* as `<span class="cloze-blank">` (width ≈ hidden text, min 4em) and the other deletions as plain text; answer side: deletion *i* as `<mark class="cloze-reveal">`. **Cues** (D25, replacing D5's "no hints"; exact rules in BUILD-NOTES "Prompt craft"): in `{hidden::cue}` the last unescaped `::` at the top level of the deletion splits it when both sides are non-blank; `text` is then the hidden part only and `cue` the trimmed cue; the blank shows `<span class="cloze-cue">(cue)</span>` beside it while hidden, no cue once revealed; `\::` is a literal `::`; card identity uses the hidden part only.
- **note**: non-empty text with neither; shown in the margin (▭ glyph), never reviewed.
- **highlight**: empty text plus an anchor (H); a yellow mark and a margin tick; "Write prompt" opens the editor.
- **tags**: a final line consisting only of `#tokens` (`#[\w-]{2,}`, space-separated) → `tags`, stripped from `display`; shown as chips, searchable in the list. `# Section` (hash + space) is a deck-batch section line, never a tag.
- **images**: `![snip](att:<id>)` tokens anywhere (§15).

Cloze entry: type braces, press C on a selection, or select text in the textarea and press Alt+Shift+C or the `{}` button; the preview renders card 0 masked and says "3 cards". Lints (worst one shown, never blocking), worst first: `no_answer`, `empty_answer`, `yes_no` (question starts with is/are/do/does/can/did/was/were/has/have/had/will/would/should/could/must, or the answer is just yes/no/true/false or starts with "yes"/"no" and a comma or a period; only when either_or does not hold), `either_or` (the answer, ≤ 6 words and no yes/no answer, stands in a question that holds "or"; it comes before yes_no, also after a yes/no start word: "Are electrons bosons or fermions?" / "Fermions"), `example_prompt` (D26: the question asks for an example: "Name an example of …", "Give the standard example of …"), `list_answer` (the answer lists ≥ 3 items: item lines, formula lines beside them when there is no sentence, or one line split at and / or, semicolons, or commas between short parts), `long_answer` (> 15 words), `long_question` (> 25 words), `book_bound` (D26: wording that points into the book: "this chapter", "the author", "Eq. (1.5)", "Example 2.6", "Sec. 4.3", "Figure 3a", "the figure above", "in the figure", "the last chapter"), `undated` (D26: "currently", "the latest measurement", "so far" … and no year from 1500 to 2199 in the prompt), `multi_sentence_cloze` (the period of e.g., i.e., Eq., Fig., Sec. … ends no sentence), `long_cloze` (> 30 words, cues not counted), `many_deletions` (≥ 3: "makes N cards"). `lint(parsed, now)`: `now` (ms or Date, default the clock) gives the year that undated's message suggests. Exact rules, word lists and messages (with the repairs of 2026-11-11, FIXES-1): BUILD-NOTES "Prompt craft".

**Cards under edits** — `M.prompts.reconcileCards(prompt, parsed, now) → {cards, dropped}`: cards persist on the record through kind changes (reviewability is decided by `kind` alone). For `cloze`, existing cards are matched to new deletions first by hidden-text equality (trimmed, whitespace-collapsed), then by index for the unmatched remainder; new deletions get `newSchedule(now)`; cards left over are `dropped`. For `qa`, card 0 is kept (a cloze rewritten as Q/A keeps its first card's schedule). When any dropped card has `log.length > 0`, the editor asks in-page "This edit removes a card with 4 reviews. Save anyway?" before saving.

## 5. Anchoring & highlight rendering

Stored anchor (PDF user space, points, y up; `null` for deck prompts):

```json
{ "pageIndex": 11,
  "pages": [{ "pageIndex": 11, "rects": [[72.0, 640.2, 300.5, 652.1], [72.0, 626.0, 180.4, 638.3]] }],
  "quote": "a potential energy function", "prefix": "where V(x,t) is ", "suffix": ". As in classical",
  "items": { "start": { "item": 12, "offset": 17 }, "end": { "item": 13, "offset": 8 } },
  "y": 652.1, "lost": false }
```

`M.anchors.fromSelection(range, pageViews)`: `range.getClientRects()` → drop rects under 1×1 → clip per page → merge fragments on one line (vertical overlap > 50 % of the shorter) → `viewport.convertToPdfPoint` on both corners → `Util.normalizeRect`. `quote` = `pdfjsLib.normalizeUnicode(sel.toString())`, whitespace-collapsed, ≤ 500 chars; `prefix`/`suffix` = 32 chars from the page text index; `items` from `textDivs.indexOf(span)`. `pageIndex`/`y` = first rect's page / top. Selections over more than two pages are truncated to two with a "selection shortened" chip. A free note stores `pages: []`, `quote: ""`, `y` = the double-click's PDF y; it draws no highlight, only a small triangle at the page's right edge.

**Drawing**: each rendered `.page` holds `canvas` → `.hlLayer` (`position: absolute; inset: 0; z-index: 1; pointer-events: none; mix-blend-mode: multiply`) → `.textLayer` (`z-index: 2`, `--scale-factor` set) → optional `.dimLayer` (`z-index: 3; pointer-events: none`). `M.reader.drawHighlights(pageIndex)` emits one `<div class="hl" data-id>` per rect, positioned in percent of the page box from `Util.normalizeRect(viewport.convertToViewportRectangle(rect))`, padded 1 px vertically; solid `--hl` (#ffe66d) multiplied over the white page gives the video's yellow; modifiers `.hl--plain` (highlight-only, `--hl-soft`), `.hl--flag`, `.hl--active`, `.hl--find`. The layer is rebuilt on `page:rendered`, `prompt:saved|deleted|restored` for that page and `scale:changed`. **Hit-testing needs no DOM**: `click` and rAF-throttled `mousemove` on a page convert the pointer to PDF space and scan that page's rects (`M.anchors.hitTest(rectsByPrompt, x, y) → promptId|null`); a hit focuses/hovers the card.

**Re-finding** (`page:textready` → `M.anchors.refind(anchor, textIndex)`), when `pages` is empty or `lost` is true (import before the PDF was added, "Replace file, keep prompts"): on `pageIndex`, then ±1, ±2: exact `quote` → whitespace/ligature-normalised quote → `prefix + quote.slice(0, 40)` → `quote.slice(0, 40)`. A hit rebuilds `items` and rects from item boxes (`x1 = e`, `x2 = e + width`, `y1 = f + descent·h`, `y2 = f + ascent·h`, defaults 0.8/−0.2, proportional x inside partial items) and clears `lost`. A miss keeps `lost: true`: the card sits at the page top with a dashed left rule, the chip "Passage not found" and the menu item "Anchor to selection". A `pageIndex ≥ pageCount` after a replacement is `lost`. A book prompt with `anchor: null` (imported) behaves as lost at `context.pageIndex ?? 0`.

## 6. Margin layout algorithm

`M.layout.compute(cards, {activeId, gap: 8, maxDrift: 320, collapsedH: 24}) → [{id, top, collapsed}]` is pure. Inputs: cards sorted by `(anchorY, createdAt)` with `anchorY = pageTop[pageIndex] + viewport.convertToViewportPoint(0, y)[1]` and `height` from one `ResizeObserver` per card (estimate `ceil(chars/38)·18 + 20` until measured; off-screen cards are placeholders until within 100 % of the viewport).

```
compute(cards, o):
  // A — forward cascade: no card above its anchor
  prev = -Inf
  for c in cards: c.top = max(c.anchorY, prev + o.gap); prev = c.top + c.height
  // B — the active (hovered, focused, editing) card is pinned; push the minimal chain above it up
  if a = cards[k] with a.id == o.activeId:
    a.top = a.anchorY; limit = a.top - o.gap
    for i = k-1 downto 0:
      if cards[i].top + cards[i].height <= limit: break
      cards[i].top = limit - cards[i].height; limit = cards[i].top - o.gap
    if cards[0].top < 0: shift = -cards[0].top; for i in 0..k: cards[i].top += shift   // no room above: slide down
    prev = a.top + a.height
    for i = k+1..n-1: cards[i].top = max(cards[i].anchorY, prev + o.gap); prev = cards[i].top + cards[i].height
  // C — degrade instead of drifting
  for c in cards: if c.id != o.activeId and c.top - c.anchorY > o.maxDrift and !c.collapsed:
    c.collapsed = true; c.height = o.collapsedH; changed = true
  if changed: rerun A and B once (heights only shrink, so one extra pass converges)
```

O(n) per run, executed in one rAF after `pages:measured`, `scale:changed`, `prompt:*`, card resize and focus change; `top` animates 120 ms except under `.margin--editing`. A collapsed card is a 24-px pill (glyph + first 40 characters) that expands on hover, focus or J/K and counts as active for pass B. In markers mode (M) every card starts collapsed. A hairline SVG `.connector` from the highlight's right edge to the card's top-left is drawn only when `top ≠ anchorY` and the card is hot (hovered, focused or edited). While editing, the card is active, grows with its textarea (`height = scrollHeight`), and neighbours move aside. Rail and Stack modes skip the cascade and bucket anchors (60 px) into markers.

**Card anatomy** (256 px, no border, no shadow): 16-px glyph column (✦ qa, `{}` cloze, ▭ note, · highlight), question 14/20 Outfit 500 `--ink`, answer 13/18 `--ink-2`, attachments as `<img class="att">` (`max-height: 120px`), tag chips, a `.card__chip` for lints/lost; hover/focus adds a 3-px `--hl-active` left rule; A ("Hide answers in margin") drops the answer line. Card `⋯` menu: Edit, Split (Q./A. and cloze cards; "Finish split" in its place while the second half of an earlier split waits as a draft), Another angle…, Delete, Flag, Copy question, Copy answer, Copy as Q./A. text, Send to Obsidian, Move to…, Go to passage (a highlight shows "Write prompt" instead of Edit; D26 and FIXES-1, BUILD-NOTES "Prompt craft").

## 7. Review mode & scheduler

**Scheduler** (`M.scheduler`, pure, milliseconds, `now` always passed; a port of Orbit's Apache-2.0 scheduler, attributed in the file header; a card never asked is due at once, D4 as changed by D27; after a wrong answer the wait is 1 day and the card's growth factor drops, D28 (Matuschak's sketch; Orbit: one rung back); no card is due again within 16 hours of an answer to it or to another card of its prompt, D29; BUILD-NOTES "Wrong answers and the next day"):

```
DAY = 86_400_000; GROWTH = 2.3; FIRST = 5·DAY; LAPSE = DAY; LOOKAHEAD = 16·3_600_000; NEXT_DAY = 16·3_600_000
GROWTH_FULL = 2300; GROWTH_LEAST = 1000                 // D28: the growth factor in thousandths (2300 = GROWTH)
LEGEND = [5, 11.5, 26.45, 60.835, 139.9205, 321.81715]·DAY  // labels "5d" "2wk" "1mo" "2mo" "4mo" "1yr"
SCHEDULER_VERSION = 1; MAX_ASKS = 3
newSchedule(now) = {createdAt: now, lastReviewedAt: null, intervalMs: FIRST, dueAt: now, growth: GROWTH_FULL, log: []}   // D27: due at once (before: now + FIRST)
neverAsked(s) = s.lastReviewedAt == null                // a skip is no answer
dueTime(s) = neverAsked(s) && s.createdAt is a number ? s.createdAt : s.dueAt    // the time from which the card is due (null without the number)
jitter(now) = (now % 1000) · 600                       // 0 … 599 400
isDue(s, now) = (neverAsked(s) && s.createdAt is a number)                                 // D27: also cards stored before it (dueAt = createdAt + FIRST)
             || (s.dueAt <= now + LOOKAHEAD && now >= s.lastReviewedAt + NEXT_DAY)         // D29: not again on the day of its answer
heldUntil(p, i) = max over the OTHER answered cards c of prompt p of (c.lastReviewedAt + NEXT_DAY), else 0   // D29: a sentence's other blanks
isReady(p, i, now) = isDue(card, now) && now >= heldUntil(p, i)                           // every count of "due" uses this
readyTime(p, i, now?) = the time from which isReady holds:                                // every text that says WHEN uses this
     max(neverAsked(card) ? min(card.createdAt, now) : max(card.dueAt − LOOKAHEAD, card.lastReviewedAt + NEXT_DAY), heldUntil(p, i))   // null without those numbers
growthOf(s) = s.growth when it is an integer in [GROWTH_LEAST, GROWTH_FULL], else replay(s.createdAt, the log's answers).growth
waitOf(s) = s.intervalMs (FIRST when it is no number), at most LAPSE when the latest log entry is "forgot"   // a card that 1.2.0 stored after a wrong answer
grade(s, now, outcome):                                 // "remembered" | "forgot" (D28)
  elapsed = max(0, now − (s.lastReviewedAt ?? s.createdAt)); g = growthOf(s); wasDue = isDue(s, now); iv = waitOf(s)
  if remembered: least = (iv < FIRST && g < GROWTH_FULL) ? LAPSE : FIRST; grown = floor(elapsed·g/1000)   // exact; g = 2300: floor(elapsed·2.3)
     interval = elapsed < iv ? max(iv, least, grown) : max(least, grown)
     growth = wasDue ? min(GROWTH_FULL, g + ceil((GROWTH_FULL − g)/5)) : g
  else: interval = LAPSE
     growth = (the log has a "forgot" entry less than NEXT_DAY before now) ? g : max(GROWTH_LEAST, round(g·3/4))   // one lapse per 16 hours
  due = now + jitter(now) + interval
  return {…s, lastReviewedAt: now, intervalMs: interval, dueAt: due, growth,
          log: s.log ++ [{at: now, outcome, intervalMs: interval, dueAt: due}]}
preview(s, now, outcome) = grade(s, now, outcome).intervalMs
replay(createdAt, log) = fold grade over log sorted by `at`, starting from newSchedule(createdAt)
rung(ms) = (first i with LEGEND[i] > ms·1.1) − 1        // −1 = below the ladder
rayValue(ms) = ms <= 0 ? 0 : clamp(lerp(log2 ms, log2 FIRST, log2 LEGEND[5], 0.1, 1), 0, 1)
STRUGGLE_DAYS = 3                                       // D25: struggling prompts (BUILD-NOTES "Prompt craft")
missDays(card, since = 0) = number of different local days (dayKey) with a log entry {outcome: "forgot", at >= since}
struggling(card, since) = missDays(card, since) >= STRUGGLE_DAYS
promptMissDays(p) = max over p.cards of missDays(card, p.revisedAt ?? 0); 0 unless p is a live qa or cloze prompt  // FIXES-1: since the text last changed
```

Test vectors: new at t=1000 → interval 432 000 000, due 1000, growth 2300 (D27); remembered at t=2000 → interval unchanged, due 432 002 000; forgot at t=10 000 → interval 86 400 000, due 86 410 000, growth 1725 (D28); interval 10 d reviewed exactly on time → 23 d; reviewed 10 d late → 46 d; interval 10 d forgotten → 1 d, due the next day (+ jitter), growth 1725; interval 365 d forgotten → 1 d, remembered 10 min later → unchanged (1 d from the retry, growth 1725); after one wrong answer and right answers exactly on time the waits are 1.725, 3.17, 6.13, 12.3, 25.4 d with growth 1840, 1932, 2006, 2065, 2112; `jitter(1 234 567) = 340 200`; `rung(5 d) = 0`, `rung(5.6 d) = 0`, `rung(11.5 d) = 1`, `rung(0) = −1`. Stored state is authoritative; `replay` runs only during import merges (§9) with the current scheduler.

**Queue** (`M.scheduler.buildQueue({prompts, scope, collectionId, now, seed}) → [{promptId, cardIndex}]`): items are cards of prompts with `deletedAt: null` and `kind ∈ {qa, cloze}`.

- `book` / `deck`: the cards of that collection that can be asked (`isReady`); books in reading order `(pageIndex, −anchor.y, createdAt, cardIndex)`, decks `(createdAt, cardIndex)`.
- `today`: cards whose prompt `createdAt ≥ localMidnight(now)`, in the collection (or everywhere from the library), **ignoring dueness** (but not the hold of D29: a card that an answer to another card of its prompt holds back is left out), reading order.
- `all`: the cards that can be asked, ordered by `(dayKey(dueTime(card)), hash32(seed + promptId + cardIndex))` — the local day from which the card is due, then a deterministic shuffle so books interleave; `seed = now` at session start.
- One card per prompt (D27; before: every due card, siblings spread 5 apart): each prompt gives at most one card to a queue: of its candidates the one that is most overdue for its wait, (now − its last answer, or − createdAt when it was never asked) / `waitOf(card)`; a tie goes to the shorter wait, then the smallest `dueTime`, then the lowest card index (D28: a forgotten blank comes back first, and a blank that is passed over rises, so none is left out; before: the smallest `dueTime`). Candidates are the prompt's cards with `isReady`; in scope `today` its cards with `now >= heldUntil`. The other cards wait until the next day (D29). `spread()` stays exported (it defers a card whose prompt had a sibling within the previous 5 positions) but `buildQueue` no longer calls it. No cap on session length (D9).

**Session** (`M.review`): `{scope, collectionId, items, queue, index, asks: Map, skips: Map, undo, startedAt, seed, log}`. `reveal()` shows the answer; `grade(outcome)`: `card = grade(card, now, outcome)`, `prompt.dueAt = min(cards.dueAt)`, `M.cache.savePrompt` (persisted at once), `asks[item]++`, emit `review:graded`, advance. At the end of a pass, the items whose latest answer in this session was "forgot" are appended in original order unless `asks[item] ≥ MAX_ASKS` (D28: the session retries by itself; the scheduler calls such a card due the next day), and so is an item that was never answered in the session (its prompt was away when its turn came) while its card `isReady`; the session ends when nothing is appended. The summary's `held` counts the cards of the session's prompts that were not its items, are due by their schedule and are held back by an answer (a sentence's other blanks: D27, D29); `heldUntil` is the earliest time one of them can be asked, `shakyDueAt` the earliest time a still-shaky card can be asked, `dueNow` counts the cards of the scope that can be asked when the session ends, and `nextDueAt` is the earliest `readyTime` in the scope without the held cards. `skip()` moves the item to the end once; a second skip drops it from the session ungraded. `undo()` is single-level: restores the previous card object (dropping the log entry), persists, steps back, and removes any retry tail that the undone grade appended. Space after reveal is inert. `flag()` toggles the current prompt's `flagged` (a content save, as the reader's F); `remove()` deletes the current prompt at once (`M.cache.removePrompt`), takes every queued card of it out of the session and is one undo step (`undo()` restores the prompt and the session exactly), with a toast "Prompt deleted" · Undo (8 s); once the answer shows, a card with `missDays(card, contentUpdatedAt) ≥ STRUGGLE_DAYS` shows "Forgotten on N days — split it or add a cue" (BUILD-NOTES "Prompt craft"). After every action focus moves to `#review` (tabindex −1), never to a button, so Space/Enter cannot re-fire a grade.

**Grading UI**: before reveal `Show answer` (flex 1) + small `Skip`; after reveal `Forgot | Remembered`, half width each, `<kbd>` cap with the current binding and a sub-label (Forgot: "again this session" while the item has an ask left after this one, else "again in 1 d"; Remembered: "next in 12 d" from `preview()`); holding or hovering a grading button previews the next interval on the starburst. Q/A: context line (§14), question Outfit 36/42 (≤ 140 chars; 28/34 ≤ 300; 22/28 beyond), answer 24/32 springing in below, then the source quote in `--review-ink-2` 14/20 with `Go to source  G` (hidden for deck prompts and lost anchors) and `Copy question LaTeX`. Cloze: the masked body; reveal cross-fades to `.cloze-reveal`. "Exit review ✕" is a 14-px link in `--review-accent` top-right.

**Starburst** (inline SVG, top-left, as in Orbit): radius `r = min(220, (columnWidth − 40) / 2)`; centre `(cx = −r + 18, cy = 30)` so only the right half shows; one tapered 3-px ray per session item, evenly spaced, rotated so the current item's ray points right; ray length `rayValue(card.intervalMs) × r`; pending rays `--review-line`, graded `--review-accent-2`, current `--review-accent`. Legend ticks sit on the horizontal ray at `LEGEND`: past/present ticks are 2-px notches in `--review-ink`, future ones 3-px dots in `--review-ink-2`; labels 12-px Outfit 500; the present stop is the last with `interval ≤ 1.1 × current`. On completion the starburst springs to the centre with "40 prompts reviewed".

**Configurable shortcuts (R7)**: actions `showAnswer, forgot, remembered, undo, skip, goToSource, flag, delete, exit` (flag and delete: D25). A binding is the canonical string `[Ctrl+][Alt+][Shift+][Meta+]Key`, `Key` = `event.key` with `" "` → `Space` and single letters lower-cased. Presets: Default `Space 1 2 u s g f Backspace Escape`; Arrows `Space ArrowLeft ArrowRight u s g f Backspace Escape`; Vim `Space j k u s g f Backspace q`; Anki-like `Space 1 3 z s g f Backspace Escape`. A stored map from before flag and delete existed gets each of them with its Default key only where no other action of that map uses the key (else unbound). Settings › Review shortcuts: a nine-row table (action, `<kbd>`, Rebind); clicking a cap shows "Press a key… (Esc cancels · [Use Esc])", a capture-phase `keydown` records the chord; the preset selector shows "Custom" after an edit; "Reset to default". A duplicate binding marks both rows red; the most recently edited action keeps the key and the other shows "unbound" until changed (its button still works by click). Bindings live in `settings.reviewKeys` and in the JSON backup; buttons and the `?` sheet render `M.keys.label(binding)` (`Space` → ␣, `ArrowLeft` → ←, `Escape` → esc). Nothing fires inside text fields. `READER_MAP` and `EDITOR_MAP` use the same format with an `inField` flag, read-only in v1.

**End of session**: "All caught up · 40 reviewed · 34 remembered · 6 forgot · 2 skipped · 1 deleted · 3 still shaky (due again tomorrow) · nothing due until tomorrow"; with held blanks (D27, D29) the line reads "… · 2 more blanks wait until tomorrow · nothing else due until Thursday" (each day word comes from its own time, `shakyDueAt`, `heldUntil` and the earliest `readyTime` in scope without the held cards: a time later on the same day reads "later today", as all three do after a session before 8 in the morning); the title is "Done for now", and the line ends "more due now", only while a card of the scope can be asked now (a card skipped away, a prompt written meanwhile); "N deleted" only when N > 0, the still-shaky list with Edit links (a flagged one marked ⚑), then "Flagged for revision": the session's other prompts that are flagged at the end, with Edit links, `Back to reading` / `Library`. **Go to source**: the overlay hides, the session stays in memory (`review:suspended`), `M.app.route("reader", {collectionId, promptId})` scrolls the passage to one third of the viewport, pulses the highlight 1.2 s and focuses the card; a toolbar pill "Resume review · 7 left" restores the overlay at the same card. For `hasBytes: false` books the button reads "PDF not in library".

## 8. Persistence & data model

Everything durable goes through `M.store` (D1). It sits on a seven-call backend interface with two implementations, `idb` and `memory` (a Tauri file-system backend later implements the same calls):

```
open(version, migrations) → Promise<{mode}>;  get(store, key);  put(store, value);  del(store, keyOrRange)
getAll(store, {index, range, count});  tx(stores, mode, fn(stores…) → Promise);  estimate() → {usage, quota}
```

Database `marginalia`, `DB_VERSION = 1`:

| Store | keyPath | Indexes | Value |
|---|---|---|---|
| `collections` | `id` | `byKind` | books (`kind: "book"`) and decks (`kind: "deck"`), tombstones included |
| `chunks` | `[docId, i]` | — | `{docId, i, bytes: ArrayBuffer}` 8 MiB slices (`bytes.slice()`, never a subarray, never a Blob) |
| `prompts` | `id` | `byCollection (collectionId)`, `byDue (dueAt)`, `byCreated (createdAt)` | prompts, notes, highlights, tombstones |
| `attachments` | `id` | — | `{id, mime, bytes: ArrayBuffer, width, height, byteLength, createdAt}` |
| `meta` | `key` | — | `dataVersion`, `schedulerVersion`, `lastSweepAt`, `pausedSession` |

```json
{ "id": "92b1cb8763aadc6ce1ffa7f4e9ff1171", "kind": "book", "name": "Griffiths",
  "title": "Introduction to Quantum Mechanics", "fileName": "griffiths.pdf", "sha256": "9f2a…", "hashAlgo": "sha-256",
  "byteLength": 52428800, "chunkCount": 7, "chunkSize": 8388608, "hasBytes": true, "pageCount": 322, "pageLabels": null,
  "sections": [{ "title": "1 The Wave Function", "label": "Ch. 1 · The Wave Function", "pageIndex": 10, "level": 1, "source": "outline" }],
  "lastPosition": { "pageIndex": 35, "fraction": 0.4, "zoom": "fit" },
  "addedAt": 1762150000000, "lastOpenedAt": 1762160000000, "updatedAt": 1762160000000, "deletedAt": null, "v": 1 }

{ "id": "deck_7c1f2a9e-…", "kind": "deck", "name": "Thermo formulas", "description": "", "sections": [],
  "addedAt": 1762128000000, "lastOpenedAt": 1762128000000, "updatedAt": 1762128000000, "deletedAt": null, "v": 1 }

{ "id": "p_3f9a0c1e-…", "collectionId": "92b1cb87…", "kind": "cloze",
  "text": "The {wave function} $\\Psi(x,t)$ solves the {Schrödinger equation}.\n#qm",
  "tags": ["qm"], "flagged": false, "anchor": { "…": "§5" },
  "context": { "docName": "Griffiths", "sectionLabel": "Ch. 1 · The Wave Function", "pageIndex": 11, "pageLabel": "12" },
  "cards": [{ "i": 0, "createdAt": 1762150000000, "lastReviewedAt": 1762150900000, "intervalMs": 432000000, "dueAt": 1762583100000,
              "log": [{ "at": 1762150900000, "outcome": "remembered", "intervalMs": 432000000, "dueAt": 1762583100000 }] },
            { "i": 1, "createdAt": 1762150000000, "lastReviewedAt": null, "intervalMs": 432000000, "dueAt": 1762582000000, "log": [] }],
  "dueAt": 1762582000000, "createdAt": 1762150000000, "contentUpdatedAt": 1762150000000, "revisedAt": 1762150000000, "updatedAt": 1762150900000, "deletedAt": null, "v": 1 }
```

Rules: `dueAt` = min over `cards` and is **absent** (property deleted) on notes, highlights and tombstones, so `byDue` never returns them. `contentUpdatedAt` changes on text/anchor/tags/flag/context/collection edits only; `revisedAt` (FIXES-1, optional; absent on new and older prompts) is set by a content save whose text differs from the text last stored, and is the start of the struggling count (D25); it is a content field of the §9 merge; `updatedAt` on every write (grades included). Ids: book = `fingerprints[0]` (+ `":" + sha256.slice(0, 8)` for "Add as a separate book"); `deck_`, `p_`, `a_` + `crypto.randomUUID()` (`getRandomValues` hex fallback). Tombstones are kept forever (collections too; deleting a collection tombstones it and its prompts and deletes its chunks). Settings live in `localStorage["marginalia.settings"]` (`theme, dimPages, marginAnswers, marginMode, snipMode, reviewKeys, visionModel`), the API key apart in `localStorage["marginalia.apiKey"]`; every access is in `try/catch`.

**Cache**: `M.cache` loads all collections and prompts into Maps at boot, so counts, queues and export strings are synchronous; writes go cache → store (`savePrompt` awaits the store; failures toast "Could not save"). **Autosave**: prompt records on Save and on every grade; editor drafts to `localStorage["marginalia.draft.<promptId|new:<anchorHash>>"]` every 300 ms (cleared on save/cancel, restored when the editor reopens; a draft holding an image token protects that attachment from GC); `lastPosition` 1 s after scrolling stops and on `visibilitychange`; nothing on `unload`. **Migrations**: `MIGRATIONS[v](db, tx)` for `v = oldVersion+1 … DB_VERSION` inside `upgradeneeded` (schema and IDB requests only; a throw aborts atomically); data migrations after open while `meta.dataVersion < DATA_VERSION`, in batches of 200. `onversionchange` closes and banners "Marginalia was updated in another tab — reload"; `onblocked` banners; `onclose` (Safari) drops the cached connection and the next call reopens and retries once. `indexedDB.open` throwing `SecurityError` or failing with `UnknownError` switches to the `memory` backend with the permanent banner "Storage unavailable in this view — export often" (`store:mode`). `navigator.storage.persist()` is called inside the "Add PDF" click; the library footer shows usage, quota, persisted state and, on Safari, the 7-day eviction note.

## 9. Export/import

The export dialog (library ⋯, deck page, list drawer, "Export all") has scope (everything / one collection), format (JSON backup / Anki TSV / Markdown) and "Include images" (default on). It **prepares the text asynchronously** ("Preparing 1.2 MB…": attachment bytes are read from the store and base64-encoded), then enables `Copy to clipboard` and `Download`, whose click handlers never await before `navigator.clipboard.writeText` / `d.save` / `<a download>`; a rejection selects the always-present `<textarea readonly>` ("Select all" button). Copy is disabled above 50 MB ("too large for the clipboard — download or exclude images"). `deliver(filename, text, mime)`: artifact build → `const d = await claude.use("downloads"); await d.save({filename, data: text})` (a `{code}` rejection toasts and leaves the textarea); otherwise `<a download>` with a Blob URL.

- **JSON backup** `marginalia-backup-2026-11-03.json`: `{format: "marginalia", version: 1, schedulerVersion: 1, exportedAt, scope, settings: {reviewKeys, snipMode, marginMode, marginAnswers, visionModel}, collections: [records without chunk fields], prompts: [full records incl. tombstones], attachments: [{id, mime, width, height, data: base64}]}`. No PDF bytes, no API key.
- **Anki TSV** `marginalia-anki.txt`, one file: directives `#separator:tab`, `#html:true`, `#notetype column:1`, `#deck column:2`, `#tags column:5`; columns `Basic|Cloze`, `Marginalia::<nickname or deck>`, front/text, back/extra, tags. A cloze prompt is one Cloze note with `{x}` → `{{cN::x}}` numbered by deletion; Back Extra = context line + source quote. `M.markup.toAnki`: `{x::cue}` → `{{cN::x::cue}}` (Anki's hint; a colon that would read as Anki's separator inside the hidden part is written `&#58;`: BUILD-NOTES "Prompt craft"); `$$…$$` → `\[…\]`, `$…$` → `\(…\)` applied to math tokens only (`\$` and prose dollars survive), newlines → `<br>`, tabs removed, HTML-escaped, `![snip](att:id)` → `<img src="data:image/png;base64,…">`; tags = `marginalia`, the nickname slug, the prompt's own.
- **Markdown** `marginalia.md`: `# Griffiths`, `## Ch. 1 · The Wave Function`, one paragraph per prompt exactly as typed (`Q.`/`A.` lines or the cloze paragraph, `$` delimiters kept, `#tags` on the last line), notes as `> note`, images `![snip](data:image/png;base64,…)`, each prompt followed by `*(p. 12)*`. One-way.

**Import** (`<input type=file accept=.json>` or a paste box, `M.exporter.importJSON(text, {restoreSettings}) → {added, updated, unchanged, skipped}`): validate `format`/`version`. Collections match by id, else books by `sha256`, else are created (`hasBytes: false`; prompts attach when the PDF is added later and are re-found by quote); a local collection tombstone newer than the incoming `updatedAt` wins. Prompts merge by id: unknown → added; known → content fields (text, anchor, tags, flagged, context, collectionId) from the side with the newer `contentUpdatedAt`; **cards: per index, union both logs by `at`, sort, `scheduler.replay(createdAt, log)`** (never field-wise "newer wins"); a tombstone wins when its `deletedAt` is newer than the other side's `contentUpdatedAt`. Attachments by id (existing kept); a token whose attachment is missing renders the `.att--missing` chip. Toast: "Imported 61 prompts (12 new, 3 updated, 46 unchanged)". An import never deletes.

## 10. Architecture & files

Classic scripts, global `window.Marginalia` (`M.`), one file per namespace; full contracts in §17, load order and tracks in §18.

```
index.html   styles.css   tools/bundle.py   dist/marginalia.html   test/*.test.js
js/util.js        M.util       ids, hashes, debounce, escapeHtml, mulberry32, hash32, localMidnight, dayKey, formatters
js/bus.js         M.bus        on/off/emit
js/settings.js    M.settings   localStorage settings + apiKey
js/store.js       M.store      backend interface, idb + memory implementations, migrations
js/scheduler.js   M.scheduler  pure: Orbit port, queue builder
js/prompts.js     M.prompts    pure: tokenize, parse, parseBatch, lint, reconcileCards
js/context.js     M.context    pure: outline → sections, labels, context line
js/keys.js        M.keys       pure: bindings, presets, dispatch
js/layout.js      M.layout     pure: margin cascade
js/anchors.js     M.anchors    pure core (rect maths, refind, hitTest, sentenceAround) + DOM helpers
js/markup.js      M.markup     pure (katex injected): tokens → HTML, Anki/Markdown conversions
js/exporter.js    M.exporter   pure formats + merge; deliver() and dialogs
js/cache.js       M.cache      in-memory collections/prompts, counts, save/remove/restore
js/attachments.js M.attachments paste/drop → stored image, object URLs, GC
js/pdfview.js     M.pdfview    PDF.js: open, lazy render, text layers, text index, capture
js/reader.js      M.reader     reader screen: toolbar, selection, highlights, adder, find, focus
js/editor.js      M.editor     the one prompt editor component
js/margin.js      M.margin     cards, rail, sheet, layout driver
js/list.js        M.list       prompt-list drawer / deck list
js/snip.js        M.snip       snip mode, clipboard, toasts
js/vision.js      M.vision     backends, postprocess, test
js/review.js      M.review     session, overlay, starburst
js/library.js     M.library    home, deck page, settings panel, add PDF
js/app.js         M.app        boot, routing, focus owner, toast, confirm, theme
```

Modules never touch each other's DOM; they call pure modules and `M.cache`/`M.store` directly and talk otherwise through `M.bus` (§17.3). `M.app` owns the three review triggers; the reader never calls `M.review`.

## 11. Edge cases

- **Scanned PDFs**: `getTextContent` yields no items → the page gets `data-notext`; the adder never appears; a one-time chip "No text layer — use free notes (double-click the margin) and snips"; find skips the page.
- **Huge PDFs** (500+ pages, 50 MB): 8 MiB chunks reassembled once; placeholders sized from page 1 and corrected in idle batches of 25 `getViewport` calls (`pages:measured`); an `IntersectionObserver` at `rootMargin: 100% 0px` enqueues renders (serial queue, nearest to the viewport first, at most 2 in flight); a second at `300% 0px` evicts (cancel tasks, `canvas.width = canvas.height = 0`, drop layers, `page.cleanup()` after the cancelled promise settles); DPR capped so `width·height·dpr² ≤ 16 777 216`; files over 300 MB refused in-page; `estimate()` warns when `quota − usage < 1.2 × bytes`.
- **Rotated pages**: viewports use `page.rotate`; anchors are PDF-space, so highlights and captures follow (no user rotation in v1).
- **Selection across pages**: one entry per page in `anchor.pages`, highlights on each, the card at the first; > 2 pages truncated with a chip; quote joined with `\n`.
- **Duplicate opens**: same fingerprint and `sha256` → reopen; same fingerprint, different `sha256` → in-page choice "Replace file, keep prompts" (default; anchors marked `lost`, re-found lazily) or "Add as a separate book"; new fingerprint → new book; an imported `hasBytes: false` book is matched by id, then `sha256`.
- **Storage**: record and chunks in one transaction, so a `QuotaExceededError` abort leaves no half-book; the toast offers "Delete a book" / "Export"; metadata is written first inside that transaction so a later byte failure (Safari reopen) leaves `hasBytes: false` + "Choose file again".
- **Worker**: the cdnjs worker is blob-wrapped; where a CSP forbids `blob:` workers PDF.js falls back to the main-thread fake worker by itself; "Preparing document…" with `onProgress` covers the parse. If `pdf.min.js` never loads, `M.pdfview.open` rejects `{code: "no_pdfjs"}`, "Add PDF" says "PDF engine not loaded — reload when online", and library, decks and review keep working. Password PDFs get an in-page field via `onPassword`. Missing `katex` renders math as monospace source.
- **Dark mode**: chrome tokens switch; pages stay white; "Dim pages" (D, default off in both themes) adds `.dimLayer` (`background: var(--dim)`) above the text layer, so selection works and highlights dim with the page.
- **Clipboard / storage throwing** (private windows, sandbox): every access is wrapped; the app renders without them.

## 12. Test plan

`node --test test/` (node 23, no dependencies; pure modules are `require`d directly):

- `scheduler.test.js`: the §7 vectors; `isDue` at exactly `now + 16 h`; jitter range; `rung` edges; `replay` equals sequential grading; `buildQueue` order per scope with a fixed seed, exclusion of tombstones/notes/highlights, `today` ignoring dueness, one card per prompt (D27; `spread` itself is still tested), a card never asked due at once, retry append and the 3-ask cap, undo restoring the exact previous object.
- `d28.test.js` (D28, D29): a card never answered wrong graded as before (1,500 random histories against the old function); the waits and growth factors after a wrong answer; one lapse per 16 hours; recovery only for a due card; never stuck for seven session rhythms; `isDue` with the 16-hour rule; `heldUntil`, `readyTime`, `isReady` and their agreement; the queue's candidates and order; no blank of a sentence left out over 60 days; `growthOf`; `replay` equals sequential grading; cards stored by 1.2.0.
- `prompts.test.js`: multi-line answers; `Q.` without `A.` → note + lint; 1 and 3 deletions; braces inside `$\frac{a}{b}$` ignored; a deletion containing math masked whole; `\{`; tags line vs `# Section`; `parseBatch`; `reconcileCards` (text match, index fallback, dropped with history); lints.
- `context.test.js`: `normalizeTitle` ("1 The Wave Function" → "Ch. 1 · The Wave Function", "Chapter 3: Formalism" → "Ch. 3 · Formalism", "1.2 Normalization" → "§1.2 Normalization", "IV Spin" → "Ch. 4 · Spin"); `labelFor` deepest item, manual wins on its page, chapter + section composition; `line()` overflow rule; `p. xii` fallback.
- `layout.test.js`: 200 random cards → no overlaps, `top ≥ anchorY` unless in the pinned chain; minimal upward chain; slide-down when out of room; collapse beyond 320; idempotence.
- `anchors.test.js`: fake viewport `transform = [s, 0, 0, −s, 0, H·s]` round-trips; line merging; multi-page split; all four `refind` strategies and the miss; `hitTest`; `sentenceAround`.
- `keys.test.js`: normalisation (`" "`, shifted letters, arrows), modifiers, `match` ignores repeat, `dispatch` skips text fields, presets, conflicts, labels.
- `markup.test.js` (katex stubbed on `globalThis`): four delimiter pairs, `\$`, no newline inside `$…$`, image tokens, masking before rendering, thrown-error fallback, `toAnki`/`toMarkdown`.
- `exporter.test.js`: backup round-trip into an empty state is deep-equal; merge rules (content by `contentUpdatedAt`, log union + replay, tombstones, collection tombstones); TSV directives and escaping; cloze numbering.

Manual browser checklist: §19.

## 13. Visual design tokens

```css
:root {
  --bg: #efece4; --surface: #faf8f3; --surface-2: #e9e4d8; --line: #ddd7ca;
  --ink: #1f1d1a; --ink-2: #6b665d; --ink-3: #8f8a7f;
  --accent: #e04a2f; --focus: #2f6fe0; --danger: #b3261e;
  --hl: #ffe66d; --hl-soft: #fff3b0; --hl-active: #ffd21f; --hl-flag: #ffb347; --find: #9cc4ff;
  --page-bg: #fff; --page-shadow: 0 1px 4px rgba(0,0,0,.25); --dim: rgba(0,0,0,.35);
  --review-bg: #f3e9d2; --review-ink: #2a2318; --review-ink-2: #8a7a5c; --review-line: #e4d7b8;
  --review-accent: #e04a2f; --review-accent-2: #e8a33a; --review-btn: #fbf5ea;
  --font-ui: system-ui, -apple-system, "Segoe UI", sans-serif;
  --font-display: "Outfit", var(--font-ui);          /* Google Fonts: Outfit 400/500/700 */
  --font-mono: ui-monospace, "SF Mono", Menlo, monospace;
  --s1: 4px; --s2: 8px; --s3: 12px; --s4: 16px; --s5: 24px; --s6: 32px; --s7: 48px;
  --r1: 6px; --r2: 8px; --r3: 12px; --toolbar-h: 44px; --card-w: 256px; --margin-w: 288px;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme=light]) { /* dark block */ } }
:root[data-theme=dark] { /* the same dark block */ }
body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.45 var(--font-ui); }
```

Dark block: `--bg #1b1a18; --surface #24221f; --surface-2 #2e2b27; --line #3a3732; --ink #ece7dc; --ink-2 #a39d91; --ink-3 #7f7a70; --accent #ff6a4d; --focus #7aa7ff; --danger #ff7b72; --page-shadow 0 1px 6px rgba(0,0,0,.6); --review-bg #2a2419; --review-ink #f1e8d6; --review-ink-2 #a8977a; --review-line #3e3425; --review-accent #ff6a4d; --review-accent-2 #f0b24a; --review-btn #3a3023`. `--hl*`, `--find`, `--page-bg`, `--dim` are identical in both themes (they sit on the white page). Settings › Appearance: Theme `System | Light | Dark` writes `data-theme` on `<html>` (`system` removes it) and `settings.theme`; "Dim pages" checkbox.

Type: UI 14/20; library headings 22/28 Outfit 500; card question 14/20 Outfit 500, answer 13/18 `--ink-2`; context line 12/16 Outfit 500 uppercase, `letter-spacing: .08em`, `--review-ink-2`; review question Outfit 400 36/42 (`letter-spacing: −.01em`), answer 24/32; review buttons Outfit 500 18/24 on `--review-btn` with a 1-px `--review-line` border, `<kbd>` 11-px mono in `--review-ink-2`. Cards have no border or shadow; shadows only on pages, popovers and the sheet; focus ring 2 px `--focus`; radius 8.

## 14. Library, decks, cross-document review & context line

**Home screen** (§2): "Review all · N due" counts **cards** that can be asked now (`M.scheduler.isReady`: due with the 16-h lookahead, and not within 16 hours of an answer to the card or to another card of its prompt, D29) over live prompts of all collections; the "N written today · Review today's" banner appears when `counts().writtenToday > 0`. Both recompute on `prompt:*`, `review:graded`, `review:ended` and every 60 s. Book rows: nickname (✎ inline rename), pages, prompts, due, `Continue reading` (at `lastPosition`), `Review`, ⋯ (Rename, Export…, Replace file, Delete — the confirm names the prompt count). Deck rows: name, counts, `Open`, `Review`, ⋯ (Rename, Export…, Delete). `New deck` asks for a name inline. Rows sort by `lastOpenedAt` desc.

**Collection model**: one `collections` store, `kind: "book" | "deck"`; `prompt.collectionId` points to exactly one. "Move to…" lists decks only (deck → book moves are not offered: anchors come only from selecting text); moving a book prompt asks `M.app.confirm("Move to deck? The highlight on p. 12 is removed.")`, then sets `anchor: null`, recomputes `context`, keeps `cards`, bumps `contentUpdatedAt`. Deleting a deck or book confirms in-page, tombstones the collection and its prompts and shows "Deleted · Undo (Z)" for 8 s.

**Deck page** (`#deck`): name (click to rename), description, counts, `Review this deck`, the prompt list (`M.list`: search over text/tags, the filter chips Flagged and Struggling (D25) and Look-alikes (D26), rows = section · rendered question · muted answer · due-in · flag; ⋯ → Edit in place, Split (D26), Delete, Move to…) and **Add prompts**: one `M.editor` instance in batch mode. `M.prompts.parseBatch(text)`: blank lines separate prompts; a line `# Section` sets `context.sectionLabel` for what follows; each block goes through `parse`; the live preview lists the parsed cards with per-block lints; `Add 3 prompts` (Cmd/Ctrl+Enter) stores them with `createdAt` spaced 1 ms apart and clears the box. Example block:

```
# Verbs
Q. to run
A. laufen

Der Hund {bellt} laut.
```

**Context line** `M.context.line(collection, prompt) → string`: books → `docName · sectionLabel`, else `docName · p. <pageLabel>`; decks → `name · sectionLabel`, else `name`. `sectionLabel = labelFor(sections, pageIndex)`: the deepest section with `pageIndex ≤` the prompt's page; a level-2 item is composed under its nearest level-1 ancestor as `Ch. 1 · The Wave Function · §1.1 The Schrödinger Equation`; a manual mark wins over outline items on its page. **Overflow**: when the full line exceeds 64 characters, drop the level-2 part; if still over 64, middle-ellipsise to 64 (Griffiths: "Griffiths · Ch. 1 · The Wave Function · §1.1 The Schrödinger Equation" → "Griffiths · Ch. 1 · The Wave Function"). The overlay renders it on one line (`white-space: nowrap; text-overflow: ellipsis`).

**Outline at import** `M.context.sectionsFromOutline(outline, resolvePageIndex) → Promise<Section[]>`: `doc.getOutline()` walked depth-first to level 2; `dest` resolved (string → `getDestination`, then `getPageIndex(dest[0])`; URL-only items skipped); stable-sorted by `pageIndex`; `Section = {title, label, pageIndex, level, source: "outline" | "manual"}`. `normalizeTitle(title, level)`: `^(chapter|ch\.?)\s*(\d+|[ivxlc]+)[:.\s]+(.+)` and `^(\d+)\s+(.+)` at level 1 → `Ch. N · Title` (roman → arabic); `^(\d+(\.\d+)+)\s+(.+)` → `§1.2 Title`; whitespace collapsed; 60-char cut. **Manual marks**: Shift+C in the reader (or ⋯ › "Mark chapter start here") opens a one-line field at the top of the current page (prefilled `Ch. N · `); Enter stores `{title, label: title, pageIndex, level: 1, source: "manual"}`, replacing a manual mark on that page; the book ⋯ menu lists marks with Remove. **Nickname**: default `info.Title` when 3–80 printable characters and not a file name or "untitled", else the file name without extension, cut to 24 characters. Any nickname or sections change runs `M.cache.recontext(collectionId)` (fresh `context` on every prompt, one batch, `prompts:recontexted`).

**Snapshot**: at save, `prompt.context = {docName, sectionLabel, pageIndex, pageLabel}` (`pageLabel` = PDF page label when present, else `pageIndex + 1`) plus `anchor.quote`, so review reads only prompt and attachment records and global review never touches PDF bytes.

## 15. Snip tool, image attachments & LaTeX transcription

**Interaction**: S or ✂ enters snip mode: `#snipOverlay` covers the page column (`cursor: crosshair`), text layers get `pointer-events: none`, the toolbar hint reads "Drag over an equation · Esc to cancel". `pointerdown` on a page starts a page-local drag, `pointermove` draws `.snip-rect` (1-px `--accent`, outside dimmed 25 %), `pointerup` with a rect ≥ 8 × 8 CSS px captures and **leaves snip mode (one-shot)**; Esc or a click without drag leaves it; Cmd+V while armed leaves it first. The segmented control `Image | LaTeX` beside ✂ and Shift+S set `settings.snipMode` (default `image`); LaTeX is disabled with the hint "Add an API key in Settings" when `M.vision.detect()` is `null`. Snips never create prompts, anchors or history (D6, D21).

**Capture** `M.pdfview.capture(pageIndex, rectCss, {k: 3}) → Promise<Blob>`, `rectCss` in page-local CSS px: `z` = current scale, `dpr = devicePixelRatio || 1`, `s = z·dpr·k`; if `rect.w·rect.h·(dpr·k)² > 16 777 216` scale `s` down by the square root of the excess; if the long edge would exceed 8000 px scale down again; `f = s / z`; `vp = page.getViewport({scale: s, rotation: page.rotate, offsetX: −rect.x·f, offsetY: −rect.y·f})` (offsets apply after scale and rotation, so viewBox origin and rotation are handled by the on-screen viewport they derive from); canvas `round(rect.w·f) × round(rect.h·f)`, `getContext("2d", {alpha: false})`; `await page.render({canvasContext, viewport: vp}).promise`; `canvas.toBlob(cb, "image/png")`. A new capture cancels the pending one (`RenderingCancelledException` swallowed).

**Clipboard inside the gesture** (`M.snip.handleRegion`, synchronous in `pointerup`):

```js
var seq = ++snip.seq, png = M.pdfview.capture(pageIndex, rect, {k: 3});           // Promise<Blob>
var item = mode === "image" ? { "image/png": png }
  : { "text/plain": png.then(function (b) { return M.vision.transcribe(b, {signal}); })
                       .then(function (r) { return new Blob([r.wrapped], { type: "text/plain" }); }) };
navigator.clipboard.write([new ClipboardItem(item)]).then(ok, fail);              // fail ignored when seq is stale
```

`Promise<Blob>` values work in Chrome ≥ 98, Safari ≥ 13.1, Firefox ≥ 127. A second snip aborts the earlier transcription (`AbortController`; its promise rejects `{code: "superseded"}`), replaces its toast, and Safari's pending write is dropped silently. Transcription times out after 45 s (`network`). Toasts: Image → "Image copied — press Cmd+V where you want it" with a 64-px thumbnail; LaTeX → "Transcribing… (the clipboard updates when done)" → "LaTeX copied — press Cmd+V where you want it" showing the LaTeX in mono and a KaTeX preview. If `ClipboardItem` is undefined or the write rejects (permission, a vision error), the toast keeps the result with `Copy` (fresh gesture: `write` with the resolved Blob / `writeText`) and `Insert at cursor` (enabled while an editor is open). Every snip toast also offers `Switch to LaTeX/Image` and `Add to prompt` (inserts at the editor caret: LaTeX text, or an attachment token for images). `no_math` → "No equation found" + `Copy image` + `Switch to Image`; `refusal` → "The model declined this image"; `cutoff` → text still copied + "Transcription was cut off — try a smaller region".

**Cmd+V**: the editor's `paste` handler scans `clipboardData.items` for `kind === "file"` with an `image/*` type before any text; if found: `preventDefault()`, `M.attachments.fromBlob(file)`, `textarea.setRangeText("![snip](att:" + id + ")", start, end, "end")`, dispatch `input`; otherwise text pastes natively (LaTeX arrives already wrapped). Dropped image files on the editor behave like paste. With `#reader` focused and no editor open, a document-level `paste` creates a free note at the middle of the visible page (D20): an image gives `Q. ![snip](att:<id>)\nA. `, text gives `Q. <text>\nA. `, and the editor opens with the caret after `A. `. Card menu copy actions (§6) and the review "Copy question LaTeX" use `writeText` inside the click with the select-the-text fallback.

**Attachments**: `M.attachments.fromBlob(blob) → Promise<att>` decodes with `createImageBitmap`, downscales by 0.7 steps while the long edge exceeds 2400 px or the encoded PNG exceeds 4 MB, re-encodes to PNG and stores `{id, mime: "image/png", bytes, width, height, byteLength}`. `url(id)` caches one object URL per id, revoked by `release(id)` when no card, preview or overlay shows it. **GC is reference-counted across live prompts**: on save, `gc(oldText, newText)` deletes an id that left the text only if no other live prompt (`deletedAt: null`) and no draft references it; on cancel, ids created in that editing session that nothing references; at boot, attachments older than 24 h referenced by no live prompt or draft (`meta.lastSweepAt`).

**Vision** (`M.vision`): `detect() → Promise<"artifact" | "apikey" | null>`: `"artifact"` when `window.claude?.use` exists, `await claude.use("sample")` is non-null and `(await sample.limits().catch(() => null))?.images` is truthy; else `"apikey"` when a key is stored; else `null`. `transcribe(blob, {signal}) → Promise<{latex, display, wrapped, cutOff}>` or rejects `{code, message}`, `code ∈ no_backend, not_granted, images_unavailable, no_math, refusal, auth, rate_limit, server, network, cutoff, superseded`.
- *apikey*: `POST https://api.anthropic.com/v1/messages`, headers `x-api-key`, `anthropic-version: 2026-10-21`, `content-type: application/json`, `anthropic-dangerous-direct-browser-access: true`, `anthropic-beta: server-side-fallback-2026-07-01`; body `{model, max_tokens: 1024, output_config: {effort: "low"}, fallbacks: "default", messages: [{role: "user", content: [{type: "image", source: {type: "base64", media_type: "image/png", data: b64}}, {type: "text", text: INSTRUCTION}]}]}` — no `temperature`. 401 → `auth` ("API key rejected — check Settings"), 429 → `rate_limit` ("Rate limited — try again in N s", `retry-after`), 5xx/529 → `server` ("Claude is overloaded"), fetch `TypeError` → `network` ("The browser blocked the request or you are offline"); `stop_reason === "refusal"` → `refusal`; `stop_reason === "max_tokens"` → `cutoff` (text still used; empty text → message "try a smaller region"); text = joined `content[].type === "text"` blocks. One request per snip, never retried.
- *artifact*: `const {text} = await sample(INSTRUCTION, {images: [blob], modelTier: "default", cache: false})`; rejections `{code, message}` pass through; `not_granted` / `images_unavailable` hide the LaTeX option; others show `message` once.
- `INSTRUCTION` is the research text verbatim ("Transcribe every piece of mathematics … return exactly the single token NO_MATH"). `postprocess(raw) → {latex, display}`: trim; strip fences and a `latex:` label; `/^\W*NO_MATH\W*$/i` → `no_math`; strip stray `$$`, `$`, `\[ \]`, `\( \)`; `display = /\\begin\{/.test(t) || lines > 1 || /\\\\/.test(t) || (relation && (tallOperator || t.length > 24))`; multi-line without an environment → `\begin{aligned}…\end{aligned}`; `wrapped = display ? "\n$$\n" + t + "\n$$\n" : "$" + t + "$"`; `katex.renderToString(t, {throwOnError: true, displayMode})` failing only adds "May not render: <message>" to the toast.

**Settings › LaTeX from snips**: API key (`type=password`, "stored in this browser only, never exported"), model (default `claude-opus-5-5`), `Test` (renders `x^2` to a 120 × 60 canvas and transcribes it end to end; success = HTTP 200 with a text block), `Forget key`. The artifact build shows "Using Claude via the artifact runtime" instead of the key field when `detect()` is `"artifact"`.

## 16. Math rendering

**Loading**: local build — `<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.47/katex.min.css">` and `<script src="…/KaTeX/0.16.47/katex.min.js">` (global `katex`); artifact build — the same script, the CSS inlined by `tools/bundle.py --artifact` with the 20 woff2 fonts as `data:font/woff2;base64` URIs (cdnjs has no ttf; woff/ttf `src` entries dropped; ≈ 372 KB). `contrib/auto-render` is not loaded: Marginalia renders from tokens after cloze masking, so `M.markup` owns the delimiter scan. KaTeX earns its place: R4 names four surfaces where monospace source would make a physics textbook's prompts unreadable. `M.markup` checks `typeof katex` at call time; without it math renders as `<code class="tex">`.

**Where**: `M.markup.render(text, {mask, mode, imageUrl}) → html` is the only HTML producer for prompt text: margin cards (`card`), the editor preview (`preview`), prompt lists (`list`), the review overlay (`review`: question, answer, cloze paragraph). Pipeline: (1) `M.prompts.tokenize(text)` → runs of `text`, `math` (`$$…$$` and `\[…\]` display, may span lines; `\(…\)` and `$…$` inline, same line, opening `$` not followed by whitespace, closing `$` not preceded by whitespace; `\$` literal) and `image`; (2) cloze and tag scanning over `text` runs only, except that a `{` opened in text and closed after a math run masks the math with it — one blank (R4); (3) masking replaces deletion *k* with `<span class="cloze-blank">` followed by ` <span class="cloze-cue">(cue)</span>` when it has a cue (or `<mark class="cloze-reveal">` with the hidden part only on reveal) **before** rendering; without a mask the list, card and preview modes show each deletion as `<mark class="cloze-mark">` (plus its `.cloze-cue`), the review mode as typed; (4) text → `escapeHtml`, `\n` → `<br>`; math → `katex.renderToString(src, {displayMode, throwOnError: false, output: "html", strict: "ignore"})` in `try/catch`; a `.katex-error` result or a thrown error becomes `<code class="tex tex--error" title="<message>">src</code>` (mono, red dotted underline); image → `<img class="att">` or the `.att--missing` chip; display math in `<div class="math-display">` with `overflow-x: auto`, so a long equation scrolls inside its card, never the page.

**Exports**: `toAnki` converts delimiters on math tokens only and leaves `\(`/`\[` alone; `toMarkdown` keeps `$`; both replace image tokens with data: URIs; the JSON backup stores raw text.

## 17. Module contracts

**17.1 File skeleton.** Every `js/*.js` file is wrapped as below; pure modules (`util, scheduler, prompts, similar, context, keys, layout, anchors, markup, exporter, undo`) must load in node with no DOM and resolve their dependencies through `dep()`. Module order (index.html, tools/smoke.js `ORDER`, the bundles; it replaces §18's list): util, bus, settings, store, scheduler, prompts, similar, context, keys, layout, anchors, markup, exporter, obsidian, backup, cache, undo, attachments, pdfview, reader, editor, margin, list, snip, vision, review, stats, library, tabs, desktop, app (31 namespaces; js/undo.js since D33, right after js/cache.js, whose writers hand it the steps; js/similar.js since D26, right after its one dependency js/prompts.js; js/stats.js since D27, after js/review.js and before js/library.js, whose button opens it; js/tabs.js since D30, after js/library.js, whose buttons open tabs, and before js/desktop.js):

```js
(function (root) {
  var M = root.Marginalia = root.Marginalia || {};
  function dep(name) { return M[name] || (typeof require === "function" ? require("./" + name + ".js") : undefined); }
  var api = { /* … */ };
  M.scheduler = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
```

Functions touching storage, PDF.js or the network return Promises; everything else is synchronous. Errors are thrown (sync) or rejected (async) as `Error` objects with a `code` property; the codes are listed per module. `Prompt`, `Collection`, `Card`, `Anchor`, `Section` are the record shapes of §5, §8 and §14.

**17.2 Signatures.**

```
M.util     uuid(prefix) → string; sha256(u8) → Promise<hex>; fnv1a(u8) → hex; hash32(str) → uint32; mulberry32(seed) → () → float
           debounce(fn, ms); clamp(x, lo, hi); escapeHtml(s); localMidnight(now) → ms; dayKey(ms) → "YYYY-MM-DD" (local)
           fmtInterval(ms) → "10 min" | "5 d" | "2 wk"; fmtBytes(n); nextDayLabel(ms, now) → "tomorrow" | "Thursday" | "12 Nov"
M.bus      on(type, fn) → off(); off(type, fn); emit(type, payload)                     // sync, listeners isolated by try/catch
M.settings get(key) → value; set(key, value) (emits settings:changed); all(); DEFAULTS; apiKey.get()|set(k)|forget()
           key notAlike: [pair key] (≤ NOT_ALIKE_MAX 5000 keys of ≤ NOT_ALIKE_KEY_MAX 200 characters; invalid entries dropped)  // D26
           reload() → the keys that differ   // D31: reads localStorage again (another window stored), settings:changed for each
M.store    open() → Promise<{mode: "idb"|"memory"}>; backend (the seven calls of §8); MIGRATIONS
           collections.{put(c), get(id), all()}; prompts.{put(p), putMany(ps), get(id), byCollection(id), due(now), all()}
           docs.{saveDocument(record, u8) (one tx; rejects code "quota"|"too_large"), loadBytes(docId) → Promise<Uint8Array|null>, deleteBytes(docId)}
           attachments.{put(a), get(id), allIds(), remove(id)}; meta.{get(k), set(k, v)}; estimate(); persist() → Promise<boolean>
           handover(on?) → boolean; acquire(sync) → Promise<boolean>; writer() → boolean; idle() → Promise; during(work) → Promise   // D31: the windows of the Mac app
           exclusive(name, fn) → Promise; hold(name) → boolean; held() → Promise<string[]|null>; WRITER_LOCK; LOCK_PREFIX   // hand the writer role to each other: BUILD-NOTES "Windows"
M.cache    load() → Promise; collections() → Collection[]; collection(id); prompts() → Prompt[]; promptsOf(collectionId); prompt(id)
           reload() → Promise<{prompts, collections, folders}>   // D31: the maps as the store is now (another window wrote); the bus events of a local change
           savePrompt(p, {content: boolean}) → Promise<Prompt>  // sets updatedAt (+contentUpdatedAt; +revisedAt when a content save changes the text), derives dueAt, writes store
           removePrompt(id) → Promise (tombstone); restorePrompt(id) → Promise; saveCollection(c); removeCollection(id) (cascades)
           // D33 (BUILD-NOTES "Undo and redo"): savePrompt, removePrompt and restorePrompt take opts.step (true | a token of M.undo.group())
           revertPrompts([{id, from, to}], {now}) → Promise<Array<Prompt|null>> (all or none, ONE store write; rejects code "changed" | "gone" (err.ids) | "bad_revert" | "locked" | "store"); stateKey(p) → string|null
           counts(collectionId|null, now) → {prompts, cards, due, nextDueAt, writtenToday}; recontext(collectionId) → Promise
M.undo     note({id, before, after}, step) → {retract()}|null; group() → token; undo({group}?) / redo() → Promise<{ok, action, reason?, label?, ids?}>   // D33
           run("undo"|"redo") → boolean; canUndo(); canRedo(); size() → {undo, redo}; peek("undo"|"redo") → {label, excerpt, where}|null; texts() → string[]; clear(); idle() → Promise; LIMIT
M.scheduler DAY, GROWTH, FIRST, LAPSE, LOOKAHEAD, NEXT_DAY, GROWTH_FULL, GROWTH_LEAST, LEGEND, MAX_ASKS, SCHEDULER_VERSION; newSchedule(now); jitter(now); isDue(s, now)
           neverAsked(s) → boolean; dueTime(s) → ms|null                                                                // D27
           growthOf(s) → thousandths; waitOf(s) → ms; heldUntil(p, i) → ms (0: not held); readyTime(p, i, now?) → ms|null; isReady(p, i, now) → boolean   // D28, D29 (p: a prompt, i: a card index)
           grade(s, now, outcome) (throws code "bad_outcome"); preview(s, now, outcome); replay(createdAt, log); rung(ms); rayValue(ms)
           buildQueue({prompts, scope, collectionId, now, seed}) → Item[]; spread(items) → Item[]        // Item = {promptId, cardIndex}
           STRUGGLE_DAYS 3; missDays(card, since) → number; struggling(card, since) → boolean; promptMissDays(p) → number  // D25
M.prompts  tokenize(text) → [{type: "text"|"math"|"image", value, display?, id?, start, end}]
           parse(text) → Parsed (§4); parseBatch(text) → [{text, section, parsed}]; lint(parsed, now) → Lint[]
           reconcileCards(prompt, parsed, now) → {cards, dropped}; imageIds(text) → string[]; stripTags(text) → string
           escapeCues(text, from, to) → string; CUE_SEP "::", LONG_ANSWER_WORDS 15, LONG_QUESTION_WORDS 25, MANY_DELETIONS 3,
           EITHER_OR_WORDS 6, LIST_MIN_ITEMS 3, LIST_ITEM_WORDS 5, LONG_CLOZE_WORDS 30          // D25
           EXAMPLE_GAP 3, YEAR_MIN 1500, YEAR_MAX 2199, UNDATED_WORDS (a copy)                    // D26
           UNDATED_NOUNS, LIST_SHORT_PART_WORDS 2, LIST_MANY_PARTS 4, LIST_SEMICOLONS 2, LIST_FORMULA_LINES 2, EXAMPLE_TRIGGERS (phrases)  // FIXES-1
M.similar  words(text) → string[]; score(a, b) → number; alike(a, b) → boolean (a, b: prompt texts or word lists)
           pairs(prompts, ignored) → [{a, b, score}]; nearest(text, prompts, exceptId, ignored) → Prompt|null
           key(idA, idB) → "idA|idB" (sorted); oneLine(text, max) → string; MIN_SCORE 0.6, MIN_SHARED 3, MAX_PAIRS 5000, ONE_LINE_CHARS 90, STOP_WORDS  // D26
           (FIXES-1: pairs and nearest skip two clozes of one sentence with different blanks; oneLine adds no blank around a hidden part)
M.context  normalizeTitle(title, level) → string; sectionsFromOutline(outline, resolvePageIndex) → Promise<Section[]>
           labelFor(sections, pageIndex) → string|null; line(collection, prompt) → string; fit(line, max = 64) → string
M.keys     normalize(ev) → binding; match(ev, binding) → boolean; parse(binding) → {key, ctrl, alt, shift, meta}; label(binding)
           dispatch(ev, maps) → actionId|null (maps = [{actionId: {binding, inField, run}}]); conflicts(map) → [[a, b]]
           PRESETS {Default, Arrows, Vim, "Anki-like"}; READER_MAP; EDITOR_MAP; REVIEW_ACTIONS; LATE_REVIEW_ACTIONS ["flag", "delete"]
           TABS_MAP   // D30: newTab, closeTab, reopenTab, nextTab, prevTab, tab1 … tab8, lastTab (BUILD-NOTES "Key routing", "Tabs")
           UNDO_MAP   // D33: undo "Mod+z", redo "Mod+Shift+z", never inside a text field (BUILD-NOTES "Undo and redo")
M.layout   compute(cards, {activeId, gap, maxDrift, collapsedH}) → [{id, top, collapsed}]   // cards: [{id, anchorY, height, collapsed}]
M.anchors  rectsFromClientRects(rects, pageBox, viewport) → pdfRects; fromSelection(range, pageViews) → Anchor|null
           fromMarginY(pageIndex, yPdf) → Anchor; anchorY(anchor, pageTops, viewports) → px; viewportRects(anchor, pageIndex, viewport)
           hitTest(rectsByPrompt, x, y) → promptId|null; refind(anchor, textIndex) → Anchor|null; sentenceAround(anchor, textIndex) → string
M.markup   render(text, {mask: {index, reveal}|null, mode, imageUrl: id → url|null}) → html; plain(text) → string
           toAnki(text, images: id → dataUrl) → html; toMarkdown(text, images) → string
M.exporter toJSON({scope, collectionId, includeImages, attachments}) → string; toAnkiTSV({...}) → string; toMarkdown({...}) → string
           merge(localState, backup) → {state, report}  (pure); importJSON(text, {restoreSettings}) → Promise<report>
           prepare(format, opts) → Promise<{text, bytes, filename, mime}>; deliver(filename, text, mime) → Promise<"saved"|"fallback">; openDialog(opts)
M.attachments fromBlob(blob) → Promise<att> (rejects code "decode"|"too_large"); url(id) → objectURL|null; release(id)
           gc(oldText, newText, {draftIds}) → Promise<deletedIds>; sweep(now) → Promise; handlePaste(ev, editor) → boolean; handleDrop(ev, editor) → boolean
M.pdfview  open(u8, {container}) → Promise<Doc> (rejects code "no_pdfjs"|"invalid"|"password"); Doc: numPages, fingerprint, info, pageLabels
           outline() → Promise<node[]|null>; resolvePageIndex(dest) → Promise<number|null>; pageTops() → number[]; pageHeights()
           viewport(i) → PageViewport|null; pageView(i) → {el, viewport, textDivs, textContent}|null; renderedPages() → number[]
           setScale(scale|"fit"); getScale(); scrollTo({pageIndex, yPdf|fraction}); textIndex(i) → Promise<{text, map, items}>
           find(query) → Promise<[{pageIndex, start, end}]>; capture(i, rectCss, {k}) → Promise<Blob>; close() → Promise
M.reader   open(collectionId, {promptId, pageIndex, position}) → Promise; close(); selection → Anchor|null (snapshot); mode() → "wide"|"rail"|"stack"
           unsaved() → boolean   // D31: a place that a window that is not the writer holds back (stored on store:writer {writer: true})
           snapshot(w, h) → canvas|null   // D31: the pages in view as a small picture (a tab that is dragged shows it)
           position() → {pageIndex, fraction, zoom}|null; isOpen(collectionId?) → boolean   // D30: the place on screen; is the book open with its document loaded; open's `position` is a tab's own place (it goes before lastPosition)
           createFromSelection(kind: "qa"|"cloze"|"highlight"); createFreeNote(pageIndex, yPdf, text); focusCard(id); drawHighlights(i)
           goToAnchor(anchor, {flash}); setFind(query); pulse(promptId)
M.editor   create({host, prompt|null, initialText, anchor, batch, onSave(text, {another}), onCancel, note, collectionId, draftKey, keepDraft}) → Editor
           Editor: el, textarea, insertAtCaret(text), insertAttachment(blob) → Promise, getText(), setText(t), focus(), destroy()
           Editor.openAngles() → boolean; closeAngles(); anglesOpen(); ANGLE_GROUPS [{id, label}] (10); ANGLES [{id, group, label, text}] (28)
           ANGLE_ANSWER "\nA. "; anglesShown(text, isNew, batch) → boolean; angleStarter(id) → {text, start, end}|null
           anglesPlace(editorRect, popSize, bounds) → {up, right, maxHeight|null}                                        // the picker's side and height
           anglesArea(editorRect, clips, win, stay) → {bounds, escape}                                                   // inside the clipping boxes, or fixed outside the low ones
           anglesOut(editorRect, bounds) → boolean                                                                       // the editor left the area: a fixed picker closes
           similarLine(text, candidates, exceptId, ignored) → string; SIMILAR_LABEL "Similar prompt: "                  // D26
           draftText(override) → string|null; dropDraft(override) → boolean; SPLIT_DRAFT_PREFIX "split:"; Editor.keepDraft  // FIXES-1
M.margin   mount(scrollEl, marginEl); setItems(prompts); layout({activeId}); focus(id); next(); prev(); setMode("cards"|"markers")
           openEditor({promptId|null, anchor, initialText, split, angles, note, draftKey, keepDraft}); closeEditor({save}); activeEditor() → Editor|null
           editing() → the options that open the open editor once more, or null   // D30: a tab that comes back gets its editor back
           setAnswersHidden(b)
M.list     open(collectionId, {host}); close(); search(q); refresh(); CHIPS (filter chips: Flagged, Struggling, Look-alikes); activeChips() → [id]
           alikePairs() → [{a, b, score}] (the open list's look-alike pairs, D26)
M.snip     enter(); exit(); isArmed(); mode(); setMode(m); toggleMode(); handleRegion(pageIndex, rectCss); copyText(text); copyBlob(blob)
M.vision   detect() → Promise<"artifact"|"apikey"|null>; transcribe(blob, {signal}) → Promise<{latex, display, wrapped, cutOff}>
           postprocess(raw) → {latex, display}; wrap(latex, display) → string; test() → Promise<{ok, message}>; INSTRUCTION
M.review   start({scope, collectionId, now}) → Promise; stop(); suspend(); resume(); reveal(); grade(outcome); skip(); undo(); flag(); remove()
           goToSource(); current() → {item, prompt, card, revealed, position, total}|null; isActive(); isSuspended()
           review:ended's summary: {scope, collectionId, startedAt, endedAt, completed, total, reviewed, grades, remembered, forgot, skipped, deleted, stillShaky, shakyDueAt, flagged, held, heldUntil, dueNow, nextDueAt, log, folderName?}   // held: D27; shakyDueAt, heldUntil, dueNow: D28, D29
M.stats    open() → boolean; close() → boolean; isOpen(); render(); sort() → {key, dir}; filters() → {book, show}; show(id); reset()   // D27: the statistics page (#stats)
           rows(prompts, collections, now) → Row[]; totals(rows); forecast(prompts, collections, now, days = 30) → {days: [{at, dayKey, count}], later, max, total}
           sortRows(rows, key, dir); filterRows(rows, show); COLUMNS; SHOWS; FORECAST_DAYS 30; dayLabel(ms, now); fullTime(ms); lastAskedText(row, now)
           nextDueText(row, now); waitText(row); growthText(row); waitTitle(row); totalsText(totals); slotLabel(day, now); forecastSummary(forecast, now); labelled(forecast)   // growthText, waitTitle: D28
M.library  render(); openDeck(id); createDeck(name); renameCollection(id, name); deleteCollection(id); addPdf(file) → Promise; openSettings(tab)
M.tabs     start(route, explicit) → {screen, collectionId, promptId, position}; run(id) → boolean; handleKey(ev) → boolean; wantsTab(ev) → boolean   // D30: tabs inside the page (#tabs)
           go(ev, screen, params) → boolean; link(route) → boolean; open(place, {background}) → id|null; close(id) → boolean; select(id) → boolean; reopen() → boolean
           list() → [{id, screen, collectionId, title, active}]; active() → id; started(); render(); save() → boolean; COMMANDS; MENU_KEYS; TABS_MAX 20; CLOSED_MAX 10; STORE_KEY
           _pure {place, samePlace, validPosition, title, after, without, step, nth, clean, serialize}   // rules: BUILD-NOTES "Tabs"
           windowId() → id|null; moveToWindow(tabId?, {x, y}?) → Promise<boolean>; dump() → [{screen, collectionId, position, editing}]   // D31: a window's own tabs
           adopt(list, index?, {active}?) → count; take(list) → indexes that came in; drop(indexes) → tabs left; forget() → boolean; move(id, index) → boolean
           WINDOWS_MAX 8; TAB_TYPE; DRAG_TYPE   // rules: BUILD-NOTES "Windows"
M.app      boot() → Promise; route(screen, params) ("library" | "deck" | "reader" | "stats"); setFocusOwner(owner); focusOwner(); toast({text, actions, ttl, id}) → {close}
           confirm({title, body, ok, cancel, danger}) → Promise<boolean>; setTheme("system"|"light"|"dark"); isArtifact() → boolean
           modal() → boolean   // D30: a dialog that takes every key is up (nothing changes tabs then); route(…, {position}) for a tab's own place
           takeRole() → Promise<boolean>; leave() → Promise<boolean>   // D31: this window takes the writer role; this window closes for good
```

**17.3 Events** (`M.bus`; emitter → consumers):

| Event | Payload | Emitter → consumers |
|---|---|---|
| `doc:opened` / `doc:closed` | `{collectionId}` | reader → margin, library |
| `pages:measured` | `{pageTops: number[], pageHeights: number[]}` | pdfview → margin, reader |
| `scale:changed` | `{scale}` | pdfview → margin, reader |
| `page:rendered` / `page:evicted` | `{pageIndex}` | pdfview → reader (highlights), margin (placeholders), attachments |
| `page:textready` | `{pageIndex}` | pdfview → reader (refind, find) |
| `scroll:settled` | `{pageIndex, fraction}` | pdfview → reader (lastPosition) |
| `selection:changed` | `{anchor: Anchor|null}` | reader → margin (adder) |
| `prompt:saved` | `{prompt, isNew}` | cache → reader, margin, list, library, review |
| `prompt:deleted` / `prompt:restored` | `{promptId, collectionId}` | cache → same |
| `prompts:recontexted` | `{collectionId}` | cache → review, library, list |
| `collection:changed` / `collection:deleted` | `{collectionId}` | cache → library, reader |
| `review:graded` | `{promptId, cardIndex, outcome}` | review → library |
| `review:ended` | `{summary}` (with `deleted` and `flagged`, D25) | review → library |
| `review:suspended` / `review:resumed` | `{remaining}` | review → reader (pill) |
| `review:gotoSource` | `{promptId}` | review → app (routes) |
| `editor:opened` / `editor:closed` | `{promptId|null, saved}` | margin → snip (toast buttons), app (focus owner) |
| `settings:changed` | `{key, value}` | settings → app (theme), margin, snip, review, reader, list (`notAlike`, D26) |
| `store:mode` | `{mode}` | store → app (banner) |
| `store:writer` | `{writer}` (D31: this window got or lost the writer role; only in the Mac app) | store → reader (a place held back), backup (the daily check) |
| `app:routed` | `{screen, collectionId, promptId}` (D30: each time `route()` settles on a screen) | app → tabs (the active tab follows) |

## 18. Build order & integration

**Script order in `index.html`** (classic scripts, all `defer`-free, in the body end): Google Fonts `<link>` (Outfit 400/500/700), `katex.min.css` `<link>`, `styles.css`; then `pdf.min.js` (cdnjs 3.11.174) + an inline `pdfjsLib.GlobalWorkerOptions.workerSrc = "…/3.11.174/pdf.worker.min.js"`; `katex.min.js` (cdnjs 0.16.47); then `js/util, bus, settings, store, scheduler, prompts, context, keys, layout, anchors, markup, exporter, cache, attachments, pdfview, reader, editor, margin, list, snip, vision, review, library, app`; last an inline `Marginalia.app.boot()`. A `<meta name="marginalia-build" content="local|artifact">` tells `M.app.isArtifact()`.

**DOM ids and owners**: `#app` (app), `#library`, `#deck`, `#settings`, `#fileInput`, `#shortcuts` (library), `#stats` (stats), `#reader`, `#toolbar`, `#scroller`, `#pages`, `#adder`, `#find`, `#snipOverlay` (reader/pdfview/snip), `#margin`, `#sheet`, `#list` (margin/list), `#review` (review), `#toasts`, `#confirm`, `#banner` (app), `#tabs` (tabs, D30). **Shared class names**: `.page`, `.hlLayer`, `.hl`, `.hl--plain`, `.hl--flag`, `.hl--active`, `.hl--find`, `.textLayer`, `.endOfContent`, `.dimLayer`, `.card`, `.card--focused`, `.card--hot`, `.card--collapsed`, `.card--editing`, `.card--lost`, `.card__glyph`, `.card__q`, `.card__a`, `.card__chip`, `.connector`, `.marker`, `.rail`, `.popover`, `.editor`, `.editor__textarea`, `.editor__preview`, `.editor__lint`, `.math-display`, `.tex`, `.tex--error`, `.cloze-blank`, `.cloze-reveal`, `.cloze-mark`, `.cloze-cue`, `.att`, `.att--missing`, `.toast`, `.kbd`, `.snip-rect`, `.btn`, `.btn--primary`, `.is-hidden`, `.margin--editing`.

**Bundler** `python3 -I tools/bundle.py [--artifact]` (stdlib only): reads `index.html`; replaces `<link rel="stylesheet" href="styles.css">` with `<style>` and every `<script src="js/…">` with an inline `<script>` in order (`</script` inside code escaped as `<\/script`); keeps cdnjs and Google Fonts tags; writes `dist/marginalia.html` and prints its byte size (fails above 15 MB). `--artifact` also downloads `katex.min.css` and the 20 woff2 fonts it references into `tools/.cache/` (reused when present), rewrites each `@font-face` to a single `data:font/woff2;base64` source (woff/ttf dropped), inlines it as `<style>` in place of the cdnjs `<link>`, and sets the build meta to `artifact`. The artifact is published with capabilities `{sample: {images: true}, downloads: true}`. Expected size: ≈ 0.7 MB.

**Integrator smoke test** (after merging the four tracks): 1 `node --test test/` green. 2 `python3 -m http.server` → open `index.html`: console free of errors; `Marginalia` has all 24 namespaces. 3 Add a text PDF → reader opens, pages render, "Preparing document…" disappears. 4 Select, N, type `Q. a` Tab `b`, Cmd+Enter → highlight + card; reload → still there. 5 T → overlay, Space, 2 → "All caught up". 6 Library shows 1 book · 1 prompt · 0 due · "1 written today". 7 Export JSON → copy works. 8 `python3 -I tools/bundle.py --artifact` → open `dist/marginalia.html` from `file://` → steps 3–7 pass; `$x^2$` in a card renders with KaTeX fonts. 9 Resize to 400 px → no horizontal scrollbar (`document.documentElement.scrollWidth === innerWidth`).

## 19. Acceptance checklist

Tester: Chrome and Safari on macOS over `http://localhost`, plus `file://` and the Artifact where noted.

1. A 50 MB, 500-page PDF opens, scrolls end to end without a frame over 50 ms, and reopens from the library at the last page after a reload (D2, D13).
2. The home screen shows per-book nickname, pages, prompts, due, "Continue reading", and "Review all · N due" at the top (D3).
3. Selecting text and pressing N opens an editor card level with the passage; Cmd+Enter saves; focus returns to the page with the selection cleared.
4. After zoom in, zoom out and a reload, highlights still cover the same words and the card's top equals the highlight's top.
5. C on a selection opens the editor with the surrounding sentence and the selection in `{}`; the preview says "1 card".
6. A paragraph with three braces reviews as three separate cards; editing it to two braces asks before dropping a card with history.
7. `Q.` without `A.` saves as a note with the "Add an A. line" chip and never appears in review.
8. Tab in a Q-only editor inserts `A. `; Cmd+Shift+Enter saves and opens a second card on the same passage.
9. Alt+Shift+C wraps the textarea selection in braces; Cmd+Shift+C is left to the browser.
10. H makes a plain highlight with no card; "Write prompt" on it opens the editor with the same id and anchor.
11. Double-clicking the margin creates a free note at that height with no highlight.
12. Backspace deletes a card with an 8-s Undo toast; Z restores it with its review history.
13. A reload mid-edit restores the draft text in the reopened editor.
14. J/K move focus through cards in document order; G scrolls to the passage and pulses the highlight; hovering a highlight lights its card and vice versa.
15. A (hide answers), M (markers) and D (dim pages) toggle and survive a reload.
16. T reviews the prompts written today, due or not; a new prompt is due at once until its first answer, and a right first answer on its first day brings it back in 5 days (D4 as changed by D27).
17. Forgot returns the card at the end of the session; after three asks it is listed as "still shaky" instead. The card is due again the next day (16 hours later at the earliest), and right after a session in which every due card was answered nothing is due (D28, D29).
18. Remembered on a 5-d card five days later schedules ≈ 11.5 d; the starburst's current ray lengthens and the legend's present stop moves to "2wk".
19. The review overlay shows "Exit review ✕" top-right, the context line "Griffiths · Ch. 1 · The Wave Function" in small caps above the question, and the source quote under the answer (R1, R2).
20. Global review ("Review all") mixes due cards from two books and a deck; no PDF is loaded (network tab shows no chunk reads); the context line is right on each card (R1).
21. G in review opens the book at the highlight; "Resume review · N left" restores the session at the same card.
22. A book with no outline: Shift+C marks a chapter start; the context line of prompts on later pages changes to that label; renaming the nickname changes their context too.
23. Rebinding Forgot to ArrowLeft in Settings updates the button key cap and the `?` sheet; the binding survives a reload and appears in the JSON backup; binding it to a key already used flags both rows (R7).
24. No review binding fires while the editor textarea has focus; a mouse-clicked grade button does not re-fire on Space.
25. S then a drag in Image mode: Cmd+V in Preview.app pastes a PNG whose pixel width ≥ 2 × the dragged CSS width × devicePixelRatio (R3).
26. S in LaTeX mode: the toast shows "Transcribing…", then the LaTeX; Cmd+V in the editor pastes `$$…$$`; a snip of a diagram shows "No equation found" with "Copy image" (R3, R5).
27. Shift+S toggles the segmented control; with no API key the LaTeX option is disabled with a hint.
28. An OS screenshot pasted into the editor inserts `![snip](att:…)`; the card shows a thumbnail, review the full-width image; deleting the token and saving removes the attachment unless another prompt uses it (R5).
29. Cmd+V with the reader focused and no editor creates a free note at the middle of the visible page with the pasted content as the question (D20).
30. `$\hbar$`, `$$…$$`, `\(…\)` and `\[…\]` render in the card, the preview, the list and the overlay; `{… $x$ …}` masks as one blank; a bad formula shows mono source with a red underline (R4).
31. In the artifact build, KaTeX fonts render from the inlined data URIs (no font requests to cdnjs).
32. Card menu "Copy question / answer / as Q./A. text" and review "Copy question LaTeX" put the raw text on the clipboard.
33. A deck created from "New deck" accepts a batch with `# Verbs` and three blocks; "Add 3 prompts" lists them with sections; "Review this deck" works; the context line reads "Deck · Verbs" (R6).
34. Moving a book prompt to a deck asks in-page, removes the highlight, keeps the schedule; deleting the deck asks and tombstones its prompts with Undo (R6).
35. JSON export by download and by clipboard; importing it into a fresh profile reproduces counts, review logs and tombstones; a prompt graded on both sides merges with both grades in its log.
36. Anki imports `marginalia-anki.txt` as Basic and Cloze notes with rendered math and images (R4).
37. Markdown export has `Q.`/`A.` paragraphs under `#`/`##` headings with `*(p. N)*` lines.
38. Opening the same PDF again reopens the book; a modified copy offers "Replace file, keep prompts" and the prompts are re-found by quote.
39. A scanned PDF shows the "No text layer" chip; snips and free notes still work.
40. A password-protected PDF asks in-page; a 400 MB file is refused with a message.
41. Dark mode follows the system and the Settings toggle; pages stay white; dim pages overlays them and highlights stay visible.
42. At 400 px width: no horizontal scroll, the bottom sheet opens cards and the editor; at 800 px the rail shows markers with popovers.
43. The artifact build tolerates the fake worker (document opens), exports fall back to copy, and `window.alert` is never called (grep the bundle).
44. `node --test test/` passes with every pure module required without a DOM.
