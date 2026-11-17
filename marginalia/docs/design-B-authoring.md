# Marginalia — Design B: authoring flow first

Angle: optimise the loop *read passage → select → write a good prompt → keep reading*. Everything below honours DECISIONS.md (D1–D21) and the addendum (R1–R7); where this angle pulls against the "calm reader" (Angle B) and D7 (full cards on wide screens), the resolution is: cards show question + answer on wide screens but *dimmed* (70 % / 45 % ink) until hovered or focused, and one key (`M`) collapses all of them to markers.

## 1. Product summary

1. The home screen is the library: every book opened and every hand-made deck, with page/prompt/due counts and "Review 23 due" at the top.
2. Open a book (a new PDF is stored in IndexedDB); the reader resumes at the last position with every prompt in the right margin beside its passage.
3. Read; drag over a passage; press `N`. A card opens in the margin at that passage with the caret in one textarea.
4. Type `Q. …`/`A. …` or a sentence with `{braces}`; `/` offers five templates; the preview renders KaTeX live; one quiet lint line nags ("yes/no question — ask for the thing").
5. `Cmd+Enter` saves, the passage turns yellow, focus returns to the page. `Cmd+Shift+Enter` saves and starts another prompt on the same passage.
6. `S` snips a region; it lands on the clipboard as a high-DPI PNG or as LaTeX (Claude transcription), so `Cmd+V` drops it into the next card, or into Anki.
7. `H` makes a plain highlight to convert later; `L` opens the prompt list with search, flags and bulk move/delete/export.
8. At a stopping point `T` reviews today's prompts in-session (two-button grading, forgotten ones return at the end); later the library's global review interleaves every book and deck, each card topped by "Griffiths · Ch. 1 · The Wave Function".
9. Decks hold prompts without a book: paste twenty `Q./A.` paragraphs at once under `# Section` lines.
10. Export JSON, Markdown (Q./A.) or Anki TSV; all local; runs from `file://`, `http://localhost` and as an Artifact.

## 2. Screens & layout

Three screens share one `index.html`: `#library`, `#reader`, `#review` (an overlay above whichever screen is open), plus `#settings` and `#deck` panels inside the library. The toolbar is 48 px tall; the library header 56 px.

**Library (1440 px window)**

```
┌ header 56 ─────────────────────────────────────────────────┐
│ Marginalia      [▶ Review 23 due]   [Open PDF] [New deck] [⚙]│
├────────────────────────────────────────────────────────────┤
│ BOOKS — grid, cards 440×128                                │
│ ┌ Griffiths ✎ ───────────────┐ ┌ Sakurai ─────────────────┐│
│ │ 420 pages · 61 prompts     │ │ 350 pages · 12 prompts   ││
│ │ 9 due · next Thu           │ │ nothing due              ││
│ │ [Continue reading p. 37] [Review 9] [⋯]                 ││
│ └────────────────────────────┘ └──────────────────────────┘│
│ DECKS — rows 56                                            │
│ Greek alphabet · 48 prompts · 14 due   [Open] [Review 14] [⋯]│
└────────────────────────────────────────────────────────────┘
```

**Reader (1440 × 900).** Page column = fit-width page (816 px for Letter at scale 1.333), gap 16, margin column 300 (cards 272 wide inside 14-px gutters); the page+margin pair is centred, leaving 154-px gutters. Zoom beyond fit-width makes the page column scroll horizontally inside its own container, never the window.

```
┌ toolbar 48 ─────────────────────────────────────────────────────────────┐
│[B] Griffiths ▾ ◂ p.37/420 ▸ − 125% + ⌕ │ ✂ Snip [Image|LaTeX] ▦M ≡L │ Review ▾ 9 ⚙│
├─────────────────────────────────────────────────────────────────────────┤
│ 154 │◄──────── page 816 ────────►│16│◄───── margin 300 ─────►│ 154      │
│     │ …the Schrödinger equation   │  │ ⟡ What role does the    card 272  │
│     │ ▓▓ plays a role logically ▓▓│──│   Schrödinger eq. play? top = hl y│
│     │ analogous to Newton's …     │  │   analogous to Newton's           │
│     │ $$ i\hbar\partial_t\Psi=H\Psi $$│ │ ┌ editor 300 ─────────┐          │
│     │                             │  │ │Q. Simplify: $\langle…│ textarea │
│     │                             │  │ │A. ▌                  │ grows    │
│     │                             │  │ │── preview ───────────│ 3–50vh   │
│     │                             │  │ │Focused: one detail…  │ lint line│
│     │                             │  │ │[⌘↩ Save]      [Esc]  │          │
│     │                             │  │ └──────────────────────┘          │
└─────────────────────────────────────────────────────────────────────────┘
```

**Review overlay** (full-screen, warm paper `--review-bg`, content column max 680 px, centred):

```
┌ starburst row 56 ──────────────────────────────────────────────┐
│ ╲│╱ 5d  2wk  1mo  2mo  4mo  1yr                Exit review ✕ Esc│
│ ─●──┼────┼────┼────┼────┼───                                   │
│            GRIFFITHS · CH. 1 · THE WAVE FUNCTION      12px caps │
│        What does Newton's second law relate?           36px    │
│        ┄┄┄┄┄┄┄┄┄ answer after Space ┄┄┄┄┄┄┄┄┄┄                 │
│        Force, mass and acceleration.                   24px    │
│        "…relates force to mass and…"            Go to source G │
│ ┌ ✕ Forgotten      [1] ┐ ┌ ✓ Remembered     [2] ┐  buttons 56 │
│ │   again in 10 min    │ │   next in 12 days    │  Skip [S]   │
│ └──────────────────────┘ └──────────────────────┘             │
└────────────────────────────────────────────────────────────────┘
```

**Breakpoints** are measured on the reader container with a `ResizeObserver`:

| Mode | Container width | Page column | Prompts |
|---|---|---|---|
| Wide | ≥ 1100 | fit in `w − 300 − 16 − 48` | 300-px margin, cards 272 (dimmed; `M` → markers) |
| Wide-narrow | 900–1099 | fit in `w − 260 − 16 − 32` | 260-px margin, cards 232 |
| Rail | 600–899 | fit in `w − 44 − 24` | 44-px rail, one 20-px dot per bucket (anchors within 60 px merge; count badge); hover/focus/tap opens the card as a popover (`max-width: min(320px, 100vw − 32px)`) over the page; arrows move between dots |
| Stack (400 px) | < 600 | fit in `w − 32` | no rail; a 16-px badge ends each highlight; tap/Enter opens a bottom sheet (`position: fixed; bottom: 0; max-height: 60vh`) with the card or editor; the prompt list (`L`) browses |

Nothing scrolls horizontally at 400 px: the canvas is sized to the container, zoom is clamped to fit-width below 600 px, sheets and toasts use `max-width: calc(100vw − 32px)`, and card text has `overflow-wrap: anywhere`. Toolbar items collapse into a "⋯" menu below 900 px.

## 3. Interactions & keyboard

Every action has a key; the mouse is optional after the selection. Single-key shortcuts never fire while `activeElement` is an input, textarea or contenteditable (modifier combos and `Esc` do).

| Action | How | Key |
|---|---|---|
| Open PDF | library button, drop anywhere, or picker | `Cmd/Ctrl+O` |
| Library | toolbar | `B` |
| Select text | drag on the text layer; an adder (`N` prompt · `C` cloze · `H` highlight) floats at the selection end | — |
| Prompt for selection | card opens at the passage, caret after `Q. ` | `N` |
| Cloze for selection | prefilled with the surrounding sentence, selection in `{}` | `C` |
| Plain highlight | no card; convert later with `N`/`C` while focused | `H` |
| Free note | double-click the margin at any y | `N` with nothing selected |
| Save / save & another / cancel | editor | `Cmd/Ctrl+Enter` / `Cmd/Ctrl+Shift+Enter` / `Esc` |
| Q.→A. in the textarea | inserts `\nA. ` if missing, else moves the caret | `Tab` (`Shift+Tab` back) |
| Wrap textarea selection in `{}` | | `Cmd/Ctrl+Shift+C` |
| Templates | `/` as first character opens the picker | `Cmd/Ctrl+Shift+1…5` |
| Preview pane | default on | `Cmd/Ctrl+P` |
| Next / previous card | roving focus in document order | `J` / `K` |
| Expand/collapse focused card | toggles the answer | `Enter` |
| Edit / delete / flag focused card | delete shows an Undo toast for 8 s | `E` / `Backspace` / `F` |
| Jump to the card's highlight | scrolls, flashes | `G` |
| Cards ↔ markers | persisted | `M` |
| Dim pages | translucent overlay (§11), persisted | `D` |
| Prompt list / search it | 360-px drawer over the margin | `L` / `/` |
| Find in PDF | toolbar box; Enter / Shift+Enter cycle | `Cmd/Ctrl+F` |
| Page nav | PageUp/PageDown, Home/End; page box | `Cmd/Ctrl+G` |
| Zoom in / out / fit width | steps ×1.1, clamp [0.5, 4] | `Cmd/Ctrl+=` / `−` / `0` |
| Snip / toggle snip mode | §15 | `S` / `Shift+S` |
| Review this book / all / today's | §7 | `R` / `Shift+R` / `T` |
| Paste | §15 | `Cmd/Ctrl+V` |
| Undo delete / undo grade | 8 s / in review | `Z` |
| Shortcut sheet / settings | | `?` / `Cmd/Ctrl+,` |

**Focus management.** One "focus owner" at a time: `reader` (the scroll container, `tabindex=-1`), `card` (roving `tabindex=0` on one card), `editor`, `list`, `review` (focus trap), `library`. `M.keys.dispatch` routes by owner. After save or cancel, focus returns to the reader, the DOM selection is cleared and the adder hides; after delete, focus moves to the next card (else the reader); opening a card whose anchor is off-screen first scrolls so the anchor sits 30 % from the top.

**Undo of delete** is a soft delete: `deletedAt` is set, the card and highlight vanish, a toast offers Undo (`Z`, 8 s). Tombstones stay for import merging and are purged 30 days later at startup.

## 4. Prompt model & syntax

One textarea, Andy's syntax, parsed by `M.model.parseBatch(text)`:

- Paragraphs (blank-line separated) are separate prompts; the margin editor usually holds one, the deck editor many.
- A paragraph whose first line starts with `Q.` is two-sided; everything from the first line starting with `A.` is the answer (multi-line). `Q.` without `A.` saves as a prompt with an empty answer and a lint, never blocked.
- A paragraph with `{…}` outside math is a cloze; *n* braces = *n* cards sharing one record and *n* schedules. `\{` is a literal brace; braces inside `$…$`/`$$…$$`/`\(…\)`/`\[…\]` never cloze; a `{…}` containing `$` is one deletion. No hint syntax (D5).
- A paragraph with neither is a **note**: shown in the margin, never scheduled.
- A record with no text and an anchor is a **highlight** (`H`). Converting a highlight or note to a prompt is editing its text; the id and anchor survive.
- `#tag` tokens (`#[\w-]{2,}` outside math, not followed by a space) anywhere are tags: stripped from display, shown as chips, exported to Anki tags. In the deck editor a line `# Section` (hash + space) sets the section label (§14).
- Template picker (`/`): 1 `Q. What is …?` 2 `Q. Why does …?` 3 `Q. How does … differ from …?` 4 `Q. What are the parts of …?` 5 cloze sentence from the selection.

Rendering a cloze: question side shows the paragraph with deletion *k* replaced by a 4-em underlined blank and the other deletions as plain text (Orbit behaviour); the answer side reveals deletion *k* in accent colour with an underline. Lints (worst one shown, never blocking): question > 25 words; answer > 15 words or contains " and " lists; yes/no question; cloze spanning more than one sentence; cloze with ≥ 3 deletions ("makes 3 cards"); empty answer; a `Q.` with no `A.`.

## 5. Anchoring & highlight rendering

Stored on `prompt.anchor` (null for deck prompts):

```json
{ "pageIndex": 11,
  "spans": [{ "pageIndex": 11, "rects": [[72.0, 612.4, 318.2, 624.1], [72.0, 598.1, 140.5, 610.0]] }],
  "quote": "relates force to mass and acceleration",
  "prefix": "second law ", "suffix": ". With the forces kno",
  "start": { "item": 41, "offset": 3 }, "end": { "item": 43, "offset": 17 },
  "marginY": 624.1 }
```

`rects` are per-line PDF user-space rectangles (points, y up) built from `range.getClientRects()` → page-local px → `viewport.convertToPdfPoint`, merged per line (vertical overlap > 50 %), normalised with `Util.normalizeRect`. `start`/`end` index the page's `textContent.items` (the `textDivs` array index) so the exact string is zoom-independent. `quote` is the selection text (≤ 500 chars, whitespace-normalised), `prefix`/`suffix` 32 chars of context. `marginY` is the PDF y of the card's alignment line (top of the first rect). A selection across pages stores one span per page; the card anchors to `spans[0]`. A free note stores `spans: []`, `quote: ""` and `marginY` = the double-clicked y converted with `convertToPdfPoint(0, yLocal)` on the page beside the click.

**Drawing.** Each page has three layers: `canvas` → `.hlLayer` (`z-index 1; pointer-events none; mix-blend-mode multiply`) → `.textLayer` (`z-index 2`, pdf.js spans, `--scale-factor` set) → optional `.dimLayer`. For every span on a rendered page, `M.anchors.drawHighlights` places one `div.hl` per rect at `Util.normalizeRect(viewport.convertToViewportRectangle(rect))`, padded 1 px vertically, colour `--hl` (plain highlights `--hl-soft`, flagged `--hl-flag`). Hover/focus of either side sets `.hot` on both.

**Re-finding** (`M.anchors.refind(anchor, textIndex)`) runs when `spans` is empty but `quote` is not (backup import before the PDF was re-added; "replace file, keep prompts"): exact `quote` search in the page's concatenated text, then whitespace-insensitive, then `prefix + quote[0..20]`, on `pageIndex`, then pages ±2; a hit rebuilds `start/end` and rects from item boxes (`x = e + width·from/len`, `y = f + descent·h … f + ascent·h`). No hit: the card stays at `marginY` with a dashed "unanchored" glyph and a menu item "Re-attach to selection".

## 6. Margin layout algorithm

The margin is one absolutely positioned column inside the same scroll container as the pages, height = total document height, so a page break is just a y. Cards are 272 px wide (232 in wide-narrow), markers 24 px tall, gap `G = 8`, `MAX_DRIFT = 320`. Heights come from a `ResizeObserver`; off-screen cards are rendered as placeholders with an estimated height (`ceil(chars / 38) · 18 + 20`) until they scroll within 100 %.

```
anchorY(c) = pageTop[c.anchor.pageIndex] + viewport.convertToViewportPoint(0, c.anchor.marginY)[1]
cards sorted by (anchorY, createdAt); insert by binary search; zoom → recompute all, re-sort

layout(cards, activeIdx):
  // A: forward cascade, every card at or below its anchor
  prevBottom = -∞
  for c in cards: c.top = max(c.anchorY, prevBottom + G); prevBottom = c.top + c.h
  // B: active (hovered, focused, editing) card is pinned; push the minimal chain above it up
  if activeIdx >= 0:
    a = cards[activeIdx]; a.top = a.anchorY; limit = a.top - G
    for i = activeIdx-1 downto 0:
      if cards[i].top + cards[i].h <= limit: break
      cards[i].top = limit - cards[i].h; limit = cards[i].top - G
    if cards[0].top < 0: shift the whole chain down by -cards[0].top, then rerun A below it
    re-cascade cards[activeIdx+1..] from a.top + a.h
  // C: degrade instead of drifting
  for c in cards (not active): if c.top - c.anchorY > MAX_DRIFT and not c.collapsed:
      c.collapsed = true; c.h = 24; changed = true
  if changed: run A/B once more (heights only shrink, so this converges)
```

Cost O(n) per pass; an edit relayouts from the edited index. `top` animates 120 ms except while typing. A hairline connector (SVG in the margin) from the highlight's right edge to the card's top-left is drawn only when `top ≠ anchorY` and the card is hot. In marker mode every card is a 24-px pill with the first 40 characters; hover/focus/`Enter` expands it in place as the active card (pass B pins it, neighbours move). While a card is being edited it is the active card, grows to 300 px (gutters collapsed), its textarea auto-grows, and layout animations are off; closing the editor runs a normal layout.

## 7. Review mode & scheduler

**Scheduler** (`M.scheduler`, pure, time in ms, `now` always passed in; ports Orbit exactly except that a new prompt is first due in 5 days, D4):

```
DAY = 86_400_000; GROWTH = 2.3; INITIAL = 5·DAY; RETRY = 600_000; LOOKAHEAD = 16·3_600_000
LEGEND = [5d "5d", 11.5d "2wk", 26.45d "1mo", 60.835d "2mo", 139.92d "4mo", 321.82d "1yr"]  // INITIAL·2.3^k
jitter(now) = (now % 1000) · 600                       // 0–599 400 ms
newSchedule(now) = {createdAt: now, lastReviewedAt: null, intervalMs: INITIAL, dueAt: now + INITIAL, log: []}
isDue(s, now)    = s.dueAt <= now + LOOKAHEAD
grade(s, now, outcome):                                  // "remembered" | "forgot"
  elapsed = max(0, now − (s.lastReviewedAt ?? s.createdAt))
  if remembered: grown = floor(elapsed·GROWTH)
     interval = elapsed < s.intervalMs ? max(s.intervalMs, INITIAL, grown) : max(INITIAL, grown)
     due = now + jitter(now) + interval
  else: interval = s.intervalMs < INITIAL ? s.intervalMs : max(INITIAL, floor(s.intervalMs / GROWTH))
     due = now + jitter(now) + RETRY
  return {…s, lastReviewedAt: now, intervalMs: interval, dueAt: due, log: s.log ++ [{at: now, outcome, intervalMs: interval}]}
```

Ladder 5d → 11.5d → 26d → 61d → 140d → 322d; late reviews grow more (elapsed-based), early ones never shrink; in-session re-review of a just-written prompt leaves it at 5 days. Orbit's test vectors (interval 10d forgotten → 5d, due +10 min; 10d reviewed 1.157d early → 11.5d) pass unchanged.

**Queue** (`buildQueue(prompts, {scope, collectionId, now, seed})`): one item per due `(promptId, deletionIndex)`; tombstones, highlights and notes excluded. Scopes: `book`/`deck` (reading order `(pageIndex, marginY)`; decks by `createdAt`), `all` (sorted by local day of `dueAt`, seeded shuffle within a day so books interleave; seed = session start), `today` (this collection's prompts created since local midnight, reading order, due or not — the in-session loop from the video). No cap (D9).

**Session.** `queue = items.slice(); index = 0`. `reveal()` shows the answer; `grade(outcome)` persists immediately, keeps a single-level undo (previous schedule + index) and advances. At the end of a pass, items still `isDue(now)` (just forgotten, due in ~10 min) are appended in order, until nothing is due or an item has been asked `MAX_ASKS = 3` times (survivors appear as "still shaky"). `skip()` moves the item to the end once; a second skip drops it. `undo()` restores the previous schedule, pops the log entry and steps back. `exit()` works any time; progress is already saved.

**Card.** Context line (12 px caps, `--ink-3`); question in Jost 36 px (28/22 for long text); after reveal it shrinks to 22 px and the answer (24 px) fades in — for clozes the masked paragraph, then the revealed span; the source quote (muted 14 px) sits under the answer with "Go to source". Buttons: "Show answer" (full width) + Skip before reveal; "Forgotten" / "Remembered" halves after, each with a key cap and a sub-label from `preview(s, now, outcome)` ("again in 10 min" / "next in 12 days").

**Interval indicator.** Orbit's starburst, top-left: one tapered 3-px ray per item, radius `min(220, (w − 40)/2)`, centre `(−radius + 18, 30)` so the right half shows, rotated so the current item's ray points right; ray length `clamp(lerp(log2(interval), log2(5d), log2(322d), 0.1, 1))`; pending rays `--review-ray`, done `--review-ray-done`, current `--accent`. Along the horizontal ray the legend "5d 2wk 1mo 2mo 4mo 1yr" (past/present ticks as notches, future as dots; "present" = last stop with `ms ≤ 1.1·interval`). Hovering or holding a grading button previews the move. On completion the starburst springs to centre with "N prompts reviewed".

**End-of-session summary**: reviewed / remembered / forgotten counts, accuracy, "nothing due until Thursday" (next `dueAt` in scope), the still-shaky list with Edit links, "Back to reading" and "Review all (14 more due)".

**Go to source** (`G`): hides the overlay (session kept; a "Resume review" chip appears top-right), opens the book in the reader if needed, scrolls to the anchor, flashes the highlight twice, focuses the card. Disabled (grey key cap) for deck prompts and unanchored notes.

**Configurable review shortcuts (R7).** `M.keys` holds actions `review.showAnswer, review.forgot, review.remembered, review.undo, review.skip, review.source, review.exit`. A binding is a canonical string `[Ctrl+][Alt+][Shift+][Meta+]<key>` where `key` is `event.key` with letters lower-cased (`"1"`, `"space"`, `"arrowleft"`, `"escape"`, `"j"`). Matching: same modifiers, same key (letters case-insensitive); never while a text field has focus; key repeat ignored. Presets:

| Action | Default | Arrows | Vim | Anki-like |
|---|---|---|---|---|
| Show answer | Space | Space | Space | Space |
| Forgot | 1 | ArrowLeft | j | 1 |
| Remembered | 2 | ArrowRight | k | 3 |
| Undo | U | U | u | Z |
| Skip | S | S | s | S |
| Go to source | G | G | g | G |
| Exit | Esc | Esc | q | Esc |

Settings → "Review shortcuts" is a table; clicking a binding cell shows "Press a key…", the next `keydown` (prevented) becomes the binding, `Esc` cancels; a conflict is refused in place ("used by Forgot": the cell shakes and both rows carry a red badge until changed). Buttons: the four presets and "Reset to default". Bindings persist in `settings.reviewKeys` (localStorage), travel in the JSON backup, and render as `<kbd>` caps on every review button and in the `?` sheet (`labelFor`: `space → Space`, `arrowleft → ←`, `escape → Esc`). Reader shortcuts sit in the same registry (`scope: "reader"`) but are not editable in v1.

## 8. Persistence & data model

All storage goes through `M.store` (IndexedDB today; the interface is small enough for a file-system backend in Tauri). Database `marginalia`, `DB_VERSION = 1`, stores:

| Store | keyPath | Indexes | Holds |
|---|---|---|---|
| `collections` | `id` | `byKind` | books and decks |
| `chunks` | `[docId, i]` | — | PDF bytes, 8 MiB `ArrayBuffer` slices |
| `prompts` | `id` | `byCollection`, `byDue` (`dueAt`), `byCreated` | prompts, notes, highlights, tombstones |
| `attachments` | `id` | — | pasted/snipped images as `ArrayBuffer` (never Blob: WebKit bugs) |
| `meta` | `key` | — | `dataVersion`, `lastSweepAt` |

```json
{ "id": "92b1cb8763aadc6ce1ffa7f4e9ff1171", "kind": "book", "nickname": "Griffiths",
  "title": "Introduction to Quantum Mechanics", "fileName": "griffiths.pdf", "sha256": "ab12…",
  "byteLength": 24117248, "chunkCount": 3, "chunkSize": 8388608, "hasBytes": true, "pageCount": 420,
  "sections": [{ "title": "1 The Wave Function", "label": "Ch. 1 · The Wave Function", "pageIndex": 10, "level": 1, "source": "outline" }],
  "lastPosition": { "pageIndex": 36, "yFrac": 0.42, "zoom": "fit" },
  "addedAt": 1762128000000, "lastOpenedAt": 1762170000000, "updatedAt": 1762170000000 }

{ "id": "deck_7c1f2a9e", "kind": "deck", "name": "Greek alphabet", "description": "", "addedAt": 1762128000000, "updatedAt": 1762128000000 }

{ "id": "p_3f9a0c1e", "collectionId": "92b1cb87…", "type": "cloze",
  "text": "Newton's second law relates force to {mass and acceleration}. #ch1",
  "tags": ["ch1"], "flagged": false, "anchor": { "…": "see §5" },
  "context": { "docName": "Griffiths", "sectionLabel": "Ch. 1 · The Wave Function", "pageIndex": 11 },
  "attachments": [],
  "schedules": [{ "createdAt": 1762170000000, "lastReviewedAt": null, "intervalMs": 432000000, "dueAt": 1762602000000, "log": [] }],
  "dueAt": 1762602000000, "createdAt": 1762170000000, "updatedAt": 1762170000000, "deletedAt": null }

{ "id": "att_9b2d", "mime": "image/png", "bytes": "<ArrayBuffer>", "w": 2400, "h": 480, "size": 183220, "createdAt": 1762170000000 }
```

`type` ∈ `qa | cloze | note | highlight`; `dueAt` is the minimum over `schedules` and is *absent* on notes, highlights and tombstones, so they drop out of `byDue`. Ids: book = `pdf.fingerprints[0]` (`+ ":" + sha256.slice(0,8)` when the same fingerprint arrives with different bytes and the user picks "add separately"); decks, prompts and attachments = `crypto.randomUUID()` with a `getRandomValues` fallback. `collections` and `prompts` are cached in memory at boot (10 000 prompts ≈ 8 MB), so counts, queues and exports are synchronous; writes go through the cache, then the store.

**Autosave.** Editor text → `localStorage["marginalia.draft.<id>"]` every 300 ms (cleared on save/cancel). Prompt records are written on `Cmd+Enter`, on blur with non-empty text and on every edit of an existing card; schedules right after grading; `lastPosition` 500 ms after scrolling stops; collections and settings on change. Never on `unload`.

**Versioning.** `MIGRATIONS[v](db, tx, oldVersion)`, keyed by target version, runs in `upgradeneeded` (synchronous schema work and IDB requests only; a throw aborts atomically); `meta.dataVersion` drives lazy data migrations after open. `onversionchange` closes and banners "A newer Marginalia is open in another tab"; `onblocked` banners; `onclose` drops the cached connection so the next call reopens and retries once (Safari). If `indexedDB.open` throws `SecurityError`, `M.store` switches to a `Map`-backed backend behind a permanent "storage unavailable — export often" banner. `navigator.storage.persist()` is called inside the "Add to library" click; Settings shows usage/quota, "Persistent: yes/no" and a Safari note about 7-day eviction.

## 9. Export/import

The export dialog (library ⋯ menu, deck page, prompt-list bulk action) prepares the text asynchronously ("Preparing 1.2 MB…"), then enables actions whose handlers never await before the clipboard call: **Copy to clipboard** (`navigator.clipboard.writeText`; on rejection the `<textarea readonly>` below is selected, with a "Select all" button), **Download** (`<a download>` locally; in the Artifact build `const d = await claude.use("downloads"); await d.save({filename, data})`, hidden when `use` returns null, a rejection's `{code}` toasted), and the always-present textarea.

- **JSON backup** `marginalia-backup-2026-11-03.json`: `{format: "marginalia", version: 1, exportedAt, scope: "all" | collectionId, collections: [records without chunk fields], prompts: [full records incl. anchor, context, schedules, log, tombstones], attachments: [{id, mime, w, h, data: base64}], settings: {reviewKeys, snipMode, marginMode, visionModel}}`. No PDF bytes, no API key.
- **Anki TSV** `marginalia-anki.tsv`, header directives then one row per prompt (a cloze is one Cloze note): `#separator:tab`, `#html:true`, `#notetype column:1`, `#deck column:2`, `#tags column:5`; columns `Basic|Cloze`, `Marginalia::<nickname or deck>`, front/text, back/extra (answer, or for clozes the context line + source quote), tags. Math `$…$` → `\(…\)`, `$$…$$` → `\[…\]`; `{x}` → `{{c1::x}}` numbered in order; `![snip](att:id)` → `<img src="data:image/png;base64,…">`; tabs/newlines → `<br>`; HTML-escaped.
- **Markdown** `marginalia.md`, one-way: `# Griffiths · Ch. 1 · The Wave Function` per section, then paragraphs exactly as typed (`Q.`/`A.` lines, `{braces}`, `$` delimiters kept, `#tags` appended to the first line), images as `![snip](data:image/png;base64,…)`.
- **Import** (`<input type=file accept=.json>` or a paste box): validate `format`/`version`; merge per prompt id — unknown id → insert; known → the record with the newer `updatedAt` wins field-wise except `schedules`, which keep the side with the later `lastReviewedAt` and union `log` entries by `at`; a tombstone beats any older update; collections match by id, else books by `sha256`, else are created with `hasBytes: false` (their prompts attach automatically when the PDF is added later, re-anchored by `quote`); attachments by id; `settings` only when "Also restore settings" is ticked. Result toast: "Imported 61 prompts (12 new, 3 updated, 46 unchanged)".

## 10. Architecture & files

Classic scripts in load order; each file does `(function (root) { var M = root.Marginalia = root.Marginalia || {}; … })(typeof window !== "undefined" ? window : globalThis)` and, for pure modules, `if (typeof module !== "undefined") module.exports = M.<name>` so `node --test` can load them.

| File | Owner namespace | Responsibilities |
|---|---|---|
| `index.html` | — | markup for library/reader/review/settings/deck, cdnjs `<script>` tags (pdf.min.js, katex.min.js, auto-render), Google Fonts link, local scripts |
| `css/tokens.css`, `css/app.css` | — | §13 tokens; layout, cards, review, library |
| `js/util.js` | `M.util`, `M.bus` | `uuid()`, `debounce(fn, ms)`, `escapeHtml(s)`, `sha256(bytes)→Promise<hex>`, `fnv1a(bytes)`, `seededRandom(seed)`, `shuffle(arr, rng)`, `dayKey(ms)`, `fmtInterval(ms)`, `clamp()`; `bus.on(evt, fn)→off`, `bus.emit(evt, payload)` |
| `js/settings.js` | `M.settings` | localStorage JSON, try/catch: `get()`, `set(patch)`, `reset()`, `apiKey.get/set/forget()` |
| `js/store.js` | `M.store` | `open()→{backend, persisted}`, `getCollections()`, `putCollection(c)`, `deleteCollection(id)` (cascades), `getPrompts()`, `putPrompt(p)`, `putPrompts(ps)`, `getDue(now)`, `saveDocumentBytes(docId, bytes)`, `loadDocumentBytes(docId)`, `putAttachment(a)`, `getAttachment(id)`, `deleteAttachments(ids)`, `listAttachmentIds()`, `getMeta(k)`, `setMeta(k, v)`, `estimate()`, `onblocked`, `onversionchange` |
| `js/model.js` | `M.model` | `parseBatch(text)→[{type, q, a, text, deletions, tags, section}]`, `serialize(p)`, `lint(parsed)→[{level, msg}]`, `newPrompt({collectionId, anchor, text, context, now})`, `contextFor(collection, pageIndex)`, `sectionsFromOutline(nodes, resolvePage)`, `normaliseTitle(title)`, `recomputeContext(collectionId)`; cache `collections()`, `prompts()`, `promptsOf(collectionId)`, `get(id)`, `save(p)`, `remove(id)`, `restore(id)`, `counts(collectionId, now)→{prompts, due, nextDueAt}` |
| `js/scheduler.js` | `M.scheduler` | constants, `newSchedule(now)`, `grade(s, now, outcome)`, `isDue(s, now)`, `preview(s, now, outcome)`, `buildQueue(prompts, opts)`, `LEGEND`, `rayValue(ms)`, `legendIndex(ms)` |
| `js/pdfview.js` | `M.pdfview` | `open(bytes, {container})→Promise<Doc>`; `Doc.numPages`, `fingerprint`, `getMetadata()`, `getOutline()`, `pageSize(i)`, `getViewport(i)`, `pageEl(i)`, `layout()→{pageTop[], scale}`, `setZoom("fit"|number)`, `scrollTo({pageIndex, yPdf|yFrac})`, `getTextIndex(i)→Promise<{text, map, items}>`, `captureRegion({pageIndex, rectPdf, scale})→Promise<Blob>`, `find(query)`, `destroy()`; lazy render queue, text layers, `--scale-factor` |
| `js/anchors.js` | `M.anchors` | `fromSelection(sel, doc)→anchor|null`, `freeNote(pageIndex, yPdf)`, `sentenceAround(anchor, textIndex)`, `anchorY(anchor, layout)`, `refind(anchor, textIndex)`, `drawHighlights(pageIndex, prompts, layerEl, viewport)`, `setHot(promptId, on)` |
| `js/render.js` | `M.render` | `toHtml(text, {mode, cloze: {index, reveal}})`, `splitMath(text)→tokens`, `maskCloze(tokens, index, reveal)`, `plain(text)`, `attachmentUrl(id)`, `releaseUrls(el)` |
| `js/editor.js` | `M.editor` | `create({host, prompt, onSave, onCancel})→{el, textarea, insertAtCaret(text), insertAttachment(blob), getText(), destroy()}`, `TEMPLATES`, `handlePaste(evt, ed)`, `handleDrop(evt, ed)` |
| `js/margin.js` | `M.margin` | `mount(scrollEl)`, `setCards(prompts)`, `layout({activeId})`, `focus(id)`, `next()`, `prev()`, `setMode("cards"|"markers")`, `openEditor(prompt)`, `closeEditor()`, `activeEditor()` |
| `js/list.js` | `M.list` | `open(collectionId)`, `close()`, `search(q)`, `select(ids)`, bulk `deleteSelected()`, `moveSelected(collectionId)`, `tagSelected(tag)`, `exportSelected(kind)` |
| `js/review.js` | `M.review` | `start({scope, collectionId})`, `current()`, `reveal()`, `grade(outcome)`, `undo()`, `skip()`, `goToSource()`, `resume()`, `exit()`, `renderStarburst(session, previewOutcome)` |
| `js/library.js` | `M.library` | `render()`, `openDeck(id)`, `createDeck(name)`, `renameCollection(id, name)`, `deleteCollection(id)`, `renderSettings()`, `addPdf(file)` |
| `js/snip.js` | `M.snip` | `enter()`, `exit()`, `mode()`, `toggleMode()`, `capture(pageIndex, rectCss)→Promise<Blob>` |
| `js/vision.js` | `M.vision` | `backend()→Promise<"sample"|"api"|null>`, `transcribe(blob)→Promise<{latex, display, cutOff}>`, `wrap(latex, display)`, `testKey()` |
| `js/exporter.js` | `M.exporter` | `toJson(scope)→Promise<string>`, `toAnkiTsv(scope)`, `toMarkdown(scope)`, `importJson(text, {restoreSettings})→{added, updated, unchanged}`, `deliver({filename, text, mime})` |
| `js/keys.js` | `M.keys` | `register(scope, actionId, defaultBinding, handler)`, `bind(actionId, binding)`, `bindingOf(actionId)`, `fromEvent(evt)→string`, `labelFor(binding)`, `PRESETS`, `applyPreset(name)`, `conflicts()`, `dispatch(evt, owner)` |
| `js/app.js` | `M.app` | `boot()`, `navigate(route)`, `toast({text, actions, ttl})`, `confirm({text, ok, cancel})→Promise<boolean>` (in-page), `setFocusOwner(name)` |
| `tools/bundle.py` | — | builds `dist/marginalia.html` (`--artifact` variant) |
| `test/*.test.js` | — | §12 |

**Event flow** (`M.bus`): `doc:opened {collectionId, doc}` → margin mounts; `page:rendered {pageIndex, viewport}` → anchors draw; `selection:changed {anchor, text}` → adder; `prompt:saved {prompt}` → cache, store, margin relayout, list, library counts; `prompt:deleted/restored`; `prompt:graded {prompt}` → store, library badge; `layout:changed {scale, pageTop}` → anchors redraw, margin relayout; `collection:changed {id}` → `recomputeContext`, library; `settings:changed {patch}` → keys, snip control, theme; `nav:goto {collectionId, promptId}` → reader opens and scrolls. Modules never touch each other's DOM; `app.js` wires them.

**Bundle.** `python3 tools/bundle.py` reads `index.html`, inlines each local stylesheet and `<script src="js/…">` in order, keeps the cdnjs/Google Fonts tags, writes `dist/marginalia.html`. `--artifact` also downloads `katex.min.css` and the 20 woff2 fonts it references, rewrites each `@font-face` to one `data:font/woff2;base64` source (dropping woff/ttf), inlines it as `<style>`, and sets `window.MARGINALIA_BUILD = "artifact"`; ≈ 0.6 MB, far under 16 MB.

## 11. Edge cases

- **Scanned PDFs**: `getTextContent` yields no items → a one-time hint "No text on this page — double-click the margin for a free note"; snips still work; search skips the page.
- **Huge PDFs** (500 pages, 50–300 MB): page sizes fetched in batches of 25 to size placeholders (page 1 as the interim guess); `IntersectionObserver` renders within 100 % of the viewport and evicts beyond 300 % (cancel tasks, zero the canvas, `page.cleanup()`); at most 2 concurrent renders, nearest-to-viewport first; canvas pixels capped at 16 777 216 (scale reduced, never failed); bytes chunked at 8 MiB; files over 300 MB refused in-page; `estimate()` warns when free quota < 1.2 × size.
- **Rotated pages**: viewports use `page.rotate`; anchors live in PDF user space, so rects, `marginY`, highlights and snips follow rotation.
- **Selection across pages**: one span per page, highlights on each, card at the first span, quote joined with `\n`.
- **Duplicate opens**: same fingerprint and sha256 → reopen; same fingerprint, different bytes → in-page choice "Replace file, keep prompts" (`spans` cleared, prompts re-anchored by quote) or "Add as separate book"; new fingerprint → new book.
- **Quota**: a write aborted with `QuotaExceededError` shows "Storage full — delete a book or export"; prompts (small) keep saving and the PDF stays open from memory for the session.
- **Worker**: the cdnjs worker is blob-wrapped; where a CSP forbids that, pdf.js falls back to the main-thread fake worker by itself — the opening spinner says "Preparing document…" so a slow parse is not mistaken for a hang. If `pdf.min.js` fails to load (offline) the reader shows "PDF engine unavailable"; library, decks and review keep working.
- **Dark mode**: chrome tokens switch; the canvas stays white; "Dim pages" (`D`, persisted) adds `.dimLayer` (`rgba(20,18,16,.38)`, `pointer-events: none`) above the text layer, so selection still works and multiply-blended highlights stay visible.
- **Storage/clipboard throwing** (private windows, artifact sandbox): every `localStorage`/IndexedDB access is wrapped; the app renders without them.

## 12. Test plan

Pure modules run under `node --test test/` (node 23):

- `scheduler.test.js`: Orbit vectors (10 d forgotten → 5 d & +10 min; 10 d reviewed early → 11.5 d; new prompt remembered in-session stays 5 d; late review grows from elapsed; jitter range), `isDue` lookahead, `buildQueue` ordering (reading order, day-bucket shuffle determinism with a seed, exclusion of notes/tombstones, per-deletion items).
- `model.test.js`: `parseBatch` on Q/A, multi-line answers, clozes with escaped braces and braces inside math, tags, `# Section` lines, notes; `lint` thresholds; `normaliseTitle("1 The Wave Function") === "Ch. 1 · The Wave Function"`, `contextFor` picks the deepest section ≤ page, fallback `p. N`.
- `render.test.js`: `splitMath` on all four delimiters, cloze masking never splits a math run, `{…$…}` masked whole, attachment tokens → `<img>`, HTML escaping, KaTeX stubbed via `globalThis.katex`.
- `exporter.test.js`: TSV escaping and header directives, `$`→`\(` conversions, cloze numbering, Markdown round-trip of `serialize`, merge rules (newer wins, tombstone wins, schedule log union).
- `margin.test.js`: layout invariants (no overlap, every card ≥ its anchor unless pinned chain, collapse after `MAX_DRIFT`, idempotence) with synthetic heights.
- `keys.test.js`: `fromEvent` canonicalisation, case-insensitive letters, modifiers, presets, conflict detection, never firing from text fields.
- `anchors.test.js`: rect merging per line and PDF conversion with a fake viewport; `refind` fallbacks.

Manual browser checklist (Chrome and Safari on macOS; `python3 -m http.server`, `file://` and the Artifact): a 400-page PDF scrolls end-to-end without jank; zoom keeps highlights aligned; selection across a page break; N/C/H flows end with focus on the page; `Cmd+Shift+Enter` makes a second card; a two-deletion cloze reviews as two items; T re-asks a forgotten prompt; the starburst rotates and previews; rebinding Forgot to ArrowLeft updates the key cap; reopening the tab restores counts, last position and the book; Image snip → `Cmd+V` into Notes; LaTeX snip → `Cmd+V` into the editor and another app; an OS screenshot pastes into the editor; `Cmd+V` with the reader focused makes a free note; each export copies via the textarea; a backup imported into a fresh profile re-anchors once the PDF is added; dark mode + dim pages; no horizontal scroll at 400 px and the bottom sheet works; deck deletion confirms in-page; the quota warning appears for a 400 MB file.

## 13. Visual design tokens

```css
:root {
  --bg:#f3efe6; --surface:#fbf9f4; --surface-2:#ece7dc; --line:#ddd6c8;
  --ink:#1f1c18; --ink-2:#5a554d; --ink-3:#8b857a;
  --accent:#d2452c; --accent-soft:#f6d9d1; --focus:#2d6cdf;
  --hl:rgba(255,214,0,.55); --hl-soft:rgba(255,214,0,.28); --hl-flag:rgba(255,140,0,.5); --hl-hot:rgba(255,196,0,.8);
  --page-bg:#ffffff; --page-shadow:0 1px 4px rgba(0,0,0,.25);
  --review-bg:#efe4cf; --review-ink:#231f1a; --review-ray:#e4d6bb; --review-ray-done:#d9a35c;
  --card-w:272px; --margin-w:300px; --toolbar-h:48px; --radius:8px;
  --s1:4px; --s2:8px; --s3:12px; --s4:16px; --s5:24px; --s6:32px; --s7:48px;
  --font-ui:system-ui,-apple-system,"Segoe UI",sans-serif; --font-display:"Jost",system-ui,sans-serif;
  --font-mono:ui-monospace,"SF Mono",Menlo,monospace;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme=light]) {
  --bg:#1b1917; --surface:#24211d; --surface-2:#2e2a25; --line:#3b362f;
  --ink:#ece6da; --ink-2:#b3aa9b; --ink-3:#7f786d; --accent:#ff7b5c; --accent-soft:#4a2a22; --focus:#7aa7ff;
  --hl:rgba(255,214,0,.5); --hl-hot:rgba(255,196,0,.75); --page-shadow:0 1px 6px rgba(0,0,0,.6);
  --review-bg:#2a241c; --review-ink:#f1e9da; --review-ray:#3d342a; --review-ray-done:#b88446; } }
:root[data-theme=dark] { /* identical block */ }
body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.45 var(--font-ui); }
```

Type: Jost 500 for the review question (36/40, letter-spacing −0.01em) and screen headings; system UI for everything else (cards 13.5/18 question, 13/17 answer in `--ink-2`; context line 12 px uppercase, letter-spacing 0.08em, `--ink-3`); mono for raw math and errors. Review controls are quiet: buttons are flat `--surface` panels with a 1-px `--line` border on the paper, the accent only on the ✕/✓ icons, key caps and the current ray; the overlay fades in 150 ms. Spacing scale 4/8/12/16/24/32/48; radius 8; focus ring 2 px `--focus`.

## 14. Library, decks, cross-document review & context line

**Collection model.** `collections` holds books (`kind: "book"`) and decks (`kind: "deck"`); a prompt has exactly one `collectionId`. Moving a prompt from a book to a deck (list panel → "Move to…") asks in-page "Its highlight on p. 12 will be removed" and then nulls `anchor` and rewrites `context`; deck→book moves are not offered (a prompt can only be anchored by selecting text).

**Home screen** (§2): header with total due (sum of `counts().due`, the 16-h lookahead) and "Review all"; Books grid (nickname with ✎ inline rename, pages, prompts, due, next due day, "Continue reading p. N", "Review N", ⋯ → Export…, Replace PDF, Delete book); Decks list with the same counts, "Open", "Review N", ⋯ → Rename, Export…, Delete deck (the in-page confirm names the prompt count); "New deck" asks for a name inline. Badges re-render on `prompt:graded`.

**Deck page**: editable name, description, counts, "Review this deck", the prompt list (the reader's `M.list`: search, flags, edit in place, delete, move) and "Add prompts": one large textarea with the KaTeX preview beside it, accepting many paragraphs; a line `# Electrodynamics` sets the section for the prompts below (stored as `context.sectionLabel`); images paste as attachments exactly as in the margin editor; `Cmd+Enter` saves everything parsed, clears the box and reports "Added 12 prompts (2 clozes → 5 cards)".

**Global queue**: `buildQueue(all prompts, {scope: "all"})` — every due `(prompt, deletion)` across collections, sorted by `dayKey(dueAt)` then shuffled within the day with the session seed; no PDF is loaded, the card draws only on `text`, `context`, `anchor.quote` and attachments.

**Context line.** Book: `nickname · sectionLabel`, from `contextFor(book, pageIndex)`: the deepest section with `pageIndex ≤ prompt.pageIndex`; a level-2 section gives `Ch. N · 1.1 The Schrödinger Equation` (chapter number + section title with its number); a level-1 chapter gives its normalised title (`1 The Wave Function` → `Ch. 1 · The Wave Function`, `Chapter 3: Formalism` → `Ch. 3 · Formalism`, roman numerals accepted, bare numbers → `Ch. N`); no section → `p. N` (the PDF's page label when present). Labels are cut at 60 characters. Deck: `deckName · section` or `deckName`. The nickname defaults to `info.Title` when it is 2–60 printable characters and not a file name or "untitled", else the file name without extension, trimmed to 24 characters.

**Outline at import**: `doc.getOutline()` flattened with `level`; `dest` resolved (`getDestination` for strings, then `getPageIndex(dest[0])`), unresolvable items dropped, stable-sorted by `pageIndex`, stored as `sections` with `source: "outline"`. **Manual marks**: the page context menu's "Mark chapter start here" opens an inline input (default `Ch. N`) and appends `{title, pageIndex, level: 1, source: "manual"}`; a manual mark overrides outline items from its page until the next item; marks are renamed/removed in the book's ⋯ menu. Editing the nickname or sections runs `recomputeContext(collectionId)` (batch `putPrompts`).

**Snapshotted on the prompt**: `context {docName, sectionLabel, pageIndex}`, `anchor.quote` and `attachments`, so review never touches the collection record or the PDF. **Go to source**: §7.

## 15. Snip tool, image attachments & LaTeX transcription

**Interaction.** `S` or the ✂ button enters snip mode: cursor `crosshair`, the text layers get `pointer-events: none`, a full-document overlay captures `pointerdown/move/up`, draws a rubber band (1-px accent border, outside dimmed 25 %), shows "Snip copies: LaTeX · Esc to cancel" in the toolbar. `Esc` or a click without drag exits. A drag < 8 × 8 px is ignored. The mode is a setting (`snipMode: "image" | "latex"`, default `image`) shown as a segmented control beside the button; `Shift+S` toggles it with a toast. Snips never create prompts or anchors (D6).

**Capture** (`M.snip.capture`): the drag rectangle (page-local CSS px) → PDF points via `viewport.convertToPdfPoint` on both corners; capture scale `s = zoom · DPR · k`, `k = 3`, clamped so `w·h·(DPR·k)² ≤ 16 777 216` and the long edge ≤ 8000; `captureViewport = page.getViewport({scale: s, offsetX: −x·s, offsetY: −y·s})` into a fresh `w·s × h·s` canvas (`alpha: false`, white background) so only the region is rendered; `canvas.toBlob(PNG)`. A new snip cancels a pending render.

**Clipboard inside the gesture.** Both modes write synchronously in the `pointerup` handler with promise values (Chrome ≥ 98, Safari ≥ 13.1 and Firefox ≥ 127 accept `Promise<Blob>`):

```js
const png = M.snip.capture(pageIndex, rect);                       // Promise<Blob>
if (mode === "image")
  navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
else
  navigator.clipboard.write([new ClipboardItem({ "text/plain":
    png.then(M.vision.transcribe).then(r => new Blob([M.vision.wrap(r.latex, r.display)], { type: "text/plain" })) })]);
```

Toasts: Image — "Image copied — press Cmd+V where you want it" with a 64-px thumbnail. LaTeX — "Transcribing…" (spinner) → "LaTeX copied — press Cmd+V where you want it" showing the LaTeX in mono and rendered. If the write rejects (no `ClipboardItem`, permission, Safari replacing a pending write, transcription error) the toast keeps the result with **Copy** (a fresh gesture) and, when an editor is open, **Insert at cursor** (LaTeX text or an attachment token). Every toast has "Switch to Image/LaTeX". `NO_MATH` → "No equation found" + Copy image + Switch to Image; refusal → "The model declined this image"; a cut-off result is still copied, with "Transcription was cut off".

**Cmd+V.** The editor's `paste` handler inspects `clipboardData.items`: an `image/*` file item becomes an attachment and `![snip](att:<id>)` is inserted with `setRangeText(…, "end")` plus an `input` event (`preventDefault` only then); text pastes natively (LaTeX arrives already wrapped). Dropped image files on the editor or margin do the same. With the reader as focus owner and no editor open, a document-level `paste` creates a free note at the middle of the visible page (as a double-click there would) and opens its editor with the pasted text or image token as the question (D20). Card menus offer "Copy question", "Copy answer", "Copy as Q./A. text"; the review card "Copy question LaTeX"; all `writeText` inside the click with a select-the-text fallback.

**Attachments.** `{id, mime, bytes: ArrayBuffer, w, h, size}`; images are decoded with `createImageBitmap`, downscaled to a 2400-px long edge, re-encoded to PNG, refused above 4 MB ("Image too large"). `M.render.attachmentUrl(id)` caches one object URL per id (revoked when the card DOM goes); cards show `<img>` at `max-height: 96px`, review at full card width, the list at 48 px. Orphan GC: each save diffs the ids referenced in the text against the record's previous `attachments` and deletes the dropped ones; a startup sweep deletes unreferenced attachments older than one hour.

**Vision backend** (`M.vision`): `backend()` returns `"sample"` when `window.claude?.use` exists, `await claude.use("sample")` is non-null and `(await sample.limits()).images` is truthy; else `"api"` when a key is set; else `null` (the LaTeX mode is greyed: "Set an API key in Settings"). The Artifact build declares `capabilities: {sample: {images: true}, downloads: true}` and calls `const {text} = await sample(INSTRUCTION, {images: [png], modelTier: "default", cache: false})`; rejections `{code, message}` with `not_granted`/`images_unavailable` hide the mode, anything else shows `message` once, never retrying. The API build POSTs `https://api.anthropic.com/v1/messages` with headers `x-api-key`, `anthropic-version: 2026-10-21`, `content-type: application/json`, `anthropic-dangerous-direct-browser-access: true`, `anthropic-beta: server-side-fallback-2026-07-01` and body `{model, max_tokens: 1024, output_config: {effort: "low"}, fallbacks: "default", messages: [{role: "user", content: [{type: "image", source: {type: "base64", media_type: "image/png", data: b64}}, {type: "text", text: INSTRUCTION}]}]}` — no `temperature` (rejected on this API version). Errors: 401 → "API key rejected — check Settings"; 429 → "Rate limited — retry in N s" (`retry-after`); 5xx/529 → "Claude is overloaded — try again"; `TypeError` → "Browser blocked the request or you are offline"; `stop_reason === "refusal"` → declined. Post-processing: join `text` blocks; strip code fences and a `latex:` label; detect `NO_MATH`; strip stray delimiters; display mode when `\begin{`, several lines/`\\`, a relation together with a tall operator, or length > 24; wrap bare multi-line output in `aligned`; pre-validate with `katex.renderToString(src, {throwOnError: true})` (failure still copies, toast "May not render"); `wrap()` → `$…$` or `\n$$\n…\n$$\n`. INSTRUCTION is the transcription text from the research notes, verbatim.

**Settings → "LaTeX from snips"**: API key (`type=password`, stored only at `localStorage["marginalia.apiKey"]`, never exported), "Test" (one text-only request, `max_tokens: 5`, shows ✓ or the error), model field (default `claude-opus-5-5`), "Forget key", and "The key stays in this browser". The Artifact build shows "Using Claude via the artifact runtime" instead of the key field.

## 16. Math rendering

**Loading.** Local build: `<link rel=stylesheet href="https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.47/katex.min.css">`, then `katex.min.js` and `contrib/auto-render.min.js` from the same path (globals `katex`, `renderMathInElement`). Artifact build: the CSS is inlined by `tools/bundle.py --artifact` with the 20 woff2 fonts as data URIs (≈ 372 KB) and the woff/ttf sources dropped (cdnjs has no ttf); the scripts stay on cdnjs. If `window.katex` is missing (offline), math is shown as mono source and a one-time banner says "Math rendering unavailable".

**Where.** All prompt HTML comes from `M.render.toHtml(text, opts)`: margin cards, the editor preview (debounced 60 ms on `input`), the prompt list, the deck page and the review overlay (question, answer, cloze paragraph). Pipeline: `splitMath` tokenises `$$…$$`, `\[…\]`, `\(…\)`, `$…$` (a `$` run must close within the paragraph, so prose dollars survive) → cloze and tag tokens are found only in text tokens, except that a `{…}` opening in text and containing a math run is one cloze token → `maskCloze` swaps the asked deletion for the blank (question) or the revealed span (answer) → attachment tokens → text is HTML-escaped → math tokens call `katex.renderToString(src, {throwOnError: false, displayMode, output: "htmlAndMathml"})`; a `.katex-error` result or an exception becomes `<code class="math-error">$src$</code>` (mono, red underline, title = KaTeX's message). `renderMathInElement` is never run on live DOM, so auto-render's delimiter defaults do not matter. `plain(text)` strips tokens for copy and search.

**Cloze + math.** Braces inside math never delete; `{… $x$ …}` masks the whole span; the answer side renders the span's math normally with the accent underline on the wrapper. The deck editor and margin editor share the preview, so the author sees exactly the review card.

**Export conversions.** Anki: `$…$` → `\(…\)`, `$$…$$` → `\[…\]` (applied on math tokens only, so `\$` and prose dollars are untouched), images → `<img src="data:…">`. Markdown keeps `$` delimiters and uses data-URI images. JSON stores the raw text.
