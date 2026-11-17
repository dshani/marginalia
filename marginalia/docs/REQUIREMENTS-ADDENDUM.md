# Requirements addendum (from the user, 2026-11-03)

User's words: "it should be part of a larger system that can test on prompts from all pdfs read. In that
mode when revising there should be context e.g. it says Griffiths Ch. 1 in small writing at the top"

## R1. Cross-document review ("the larger system")

- The app is a SYSTEM with a library of every PDF ever read, not a per-file viewer. Prompts from all PDFs
  live in one store and one scheduler.
- A global review mode drills the due prompts from ALL documents, interleaved (ordered by due time, then
  shuffled within the same day so documents mix). Entry points: the library/home screen ("Review N due"),
  a keyboard shortcut, and from inside the reader ("Review all" vs "Review this document").
- The home screen shows per-document counts (prompts, due today) and a total; "due" badges update after a
  session.
- Global review must NOT need to load every PDF: everything the review card shows (question, answer,
  context line, source snippet) is stored with the prompt / document records. Opening the source PDF is an
  explicit action ("Go to source"), which loads that document in the reader at the highlight.

## R2. Context line on every review card

- Small, quiet text at the TOP of the review card, above the question, e.g. "Griffiths · Ch. 1" or
  "Griffiths · Ch. 1 · The Wave Function" (small size, letter-spaced or muted colour; never competes
  with the question).
- Composition: <document short name> · <chapter/section label> [· p. N when no section is known].
- Document short name: user-editable "nickname" in the library (default: PDF metadata Title if present
  and sane, else file name without extension, trimmed to ~24 chars).
- Chapter/section label, derived when the document is imported and stored on the document record as an
  ordered list of {title, pageIndex, level}:
  1. PDF outline (bookmarks) when present: resolve each item's destination to a page index; label a prompt
     with the deepest outline item whose pageIndex <= prompt.pageIndex (prefer level-1 "chapter" plus the
     level-2 section when both exist); normalise titles like "1 The Wave Function" to "Ch. 1 · The Wave
     Function" when they start with a number.
  2. No outline: let the user define chapters manually from the reader ("Mark chapter start here" with a
     label), stored as the same list.
  3. Otherwise fall back to "p. N".
- The label is also snapshotted onto the prompt at creation time (prompt.context = {docName, sectionLabel,
  pageIndex}) so review works even if the document record is edited later; recomputed when the user edits
  chapters or the nickname.
- Also useful in the same spirit: the review card can reveal the source passage (the highlighted text)
  under the answer, in muted small type, and offers "Go to source".

# Addendum 2 (from the user, 2026-11-03, later message)

User's words: "there should also be that device that is shown in the video where one can 'screenshot' and be able
to copy a diagram into a prompt or be able to paste exact latex code from a 'screenshot' of the equation. as is
shown in the video. also latex should all render"

## R3. Snip tool ("screenshot" device) inside the reader

- A snip mode (toolbar button + keyboard shortcut, e.g. `S`): the reader drags a rectangle over a page; the
  app captures that region from the rendered page at high resolution (render the page region at >= 2x device
  pixels from PDF.js, never from a low-DPI screenshot) into a PNG Blob.
- A small popover appears on the snip with four actions:
  1. "Add to prompt" - attach the image to the prompt being written (or create a new prompt anchored to the
     snip rectangle). Images can go into the question or the answer side. They render in the margin card
     (thumbnail) and in review (full size, max width of the card).
  2. "To LaTeX" - send the PNG to a vision model and insert the returned LaTeX at the cursor of the prompt
     editor, wrapped in `$$ ... $$` (display) or `$ ... $` (inline) as returned. Show a spinner, an error
     message if it fails, and keep the image available as a fallback attachment.
  3. "Copy image" - navigator.clipboard.write with a ClipboardItem (PNG); fallback: show the image so the
     user can right-click/copy.
  4. "Copy LaTeX" - same as 2 but copies to the clipboard instead of inserting.
- The prompt editor also accepts images pasted from the clipboard (paste event with image/* items) and
  dropped image files, so an OS screenshot tool works too.
- Vision model for image -> LaTeX:
  - Local build: Claude API via raw HTTPS fetch from the browser (no SDK, no build step). The user pastes their
    own Anthropic API key in Settings; it is stored only in localStorage (never exported). Request shape:
    POST https://api.anthropic.com/v1/messages with headers x-api-key, anthropic-version: 2026-10-21,
    content-type: application/json, anthropic-dangerous-direct-browser-access: true (required for CORS from a
    browser); body {model: "claude-opus-5-5", max_tokens: 1024, output_config: {effort: "low"}, fallbacks:
    "default" (+ header anthropic-beta: server-side-fallback-2026-07-01), messages: [{role: "user", content:
    [{type: "image", source: {type: "base64", media_type: "image/png", data: <b64>}}, {type: "text", text:
    <instruction>}]}]}. Instruction: transcribe the equation(s) in the image to LaTeX exactly, return ONLY the
    LaTeX (no prose, no code fences); for a diagram or non-math image return the single token NO_MATH.
    Read the response's content blocks of type "text"; check stop_reason === "refusal" and surface it.
  - Artifact build: the page declares the `sample` capability with images ({sample: {images: true}}) and calls
    `sample(input, {images: [pngBlob], modelTier: "default"})`; if `(await sample.limits()).images` is false or
    `use("sample")` is null, hide the "To LaTeX" action and show "Copy image" only.
  - Settings UI: "LaTeX from snips" section with the API key field, a "Test" button, model name field
    (default claude-opus-5-5), and a note that the key stays in this browser.

## R4. LaTeX renders everywhere

- KaTeX (cdnjs, pinned 0.16.x) renders `$...$`, `$$...$$`, `\(...\)` and `\[...\]` in: margin cards, the
  editor's live preview, the prompt list, and the review overlay (question, answer, cloze paragraph).
  Cloze masking must not break inside a math run: a cloze {...} that contains `$` is masked as a whole, and
  rendering happens after masking.
- Render with `katex.renderToString(src, {throwOnError: false, displayMode})`; on error show the raw source in
  monospace with a red underline rather than nothing.
- The editor shows raw text (no WYSIWYG); a preview pane (toggle `Cmd/Ctrl+P` or always-on beneath the
  textarea) shows the rendered card.
- Artifact CSP: KaTeX JS loads from cdnjs; KaTeX CSS must be INLINED and its fonts embedded as data: URIs
  (tools/bundle.py --artifact downloads katex.min.css + the woff2 fonts it references from cdnjs and inlines
  them). The local build may link katex.min.css from cdnjs directly.
- Export: Anki TSV keeps `$...$` as-is but converts `$$...$$` to `\[...\]` and `$...$` to `\(...\)` (Anki's
  MathJax delimiters); Markdown export keeps `$` delimiters; images are embedded as data: URIs in HTML
  `<img>` tags for Anki and as Markdown images with data: URIs for Markdown.

# Addendum 3 (from the user, 2026-11-03, later message)

User's words: "make it so that we can just paste where we need it using command v once we have selected the
correct copy function"

## R5. Clipboard-first snips: choose the copy function once, then snip -> Cmd+V anywhere

- The snip tool has a MODE chosen once and remembered (settings): "Snip copies: Image" or "Snip copies: LaTeX"
  (a segmented control in the toolbar next to the snip button, and keyboard: `S` enters snip mode, `Shift+S`
  toggles Image/LaTeX). After the user drags a rectangle, the result goes straight to the system clipboard with
  no popover to confirm:
  - Image mode: PNG written with navigator.clipboard.write([new ClipboardItem({'image/png': blob})]) inside the
    mouseup/pointerup handler (user gesture). Toast: "Image copied - press Cmd+V (Ctrl+V) where you want it".
  - LaTeX mode: the transcription is async, so the clipboard write must START inside the gesture: call
    navigator.clipboard.write([new ClipboardItem({'text/plain': transcribePromise.then(t => new Blob([t],
    {type: 'text/plain'}))})]) in the pointerup handler (Safari and Chrome accept a Promise<Blob> in a
    ClipboardItem; this is the only way to satisfy Safari's user-gesture rule after an await). Toast:
    "Transcribing..." then "LaTeX copied - press Cmd+V where you want it" with the LaTeX shown in the toast.
    If the write rejects (unsupported browser, permission), the toast shows the LaTeX with a "Copy" button
    (a fresh gesture) and an "Insert at cursor" button.
  - The toast also has a small "Switch to Image / LaTeX" link, and "Add to prompt" (direct insert) remains as a
    secondary action for people who do not want the clipboard.
- Cmd+V / Ctrl+V pastes the clipboard where the cursor is:
  - In the prompt editor textarea: LaTeX text pastes natively (no custom code), already wrapped in the right
    delimiters by the transcription step ($...$ for inline, $$...$$ on its own lines for display math).
  - In the prompt editor, an IMAGE on the clipboard (paste event with clipboardData.items[].kind === 'file',
    type image/*) is stored as an attachment Blob and an inline token is inserted at the caret:
    `![snip](att:<attachmentId>)`. Question and answer text are therefore plain text with inline image tokens;
    rendering replaces each token with <img> (thumbnail in the margin card, full width in review). Deleting the
    token from the text orphans the attachment; orphans are garbage-collected on save.
  - Outside any editor (reader focused), Cmd+V with an image or text on the clipboard creates a NEW prompt in the
    margin at the position of the most recent snip (or the middle of the visible page if there was none) and
    opens its editor with the pasted content in the question field. Cmd+V with ordinary text while the reader
    is focused does the same with the text.
  - Because the clipboard holds a real PNG / real text, Cmd+V also works in other apps (Anki, notes, chat).
- Copy affordances elsewhere follow the same rule: a margin card's menu has "Copy question", "Copy answer",
  "Copy as Q./A. text"; the review card has "Copy LaTeX of question"; all use navigator.clipboard.writeText
  inside the click handler with the usual fallback (select the text) when it rejects.

# Addendum 4 (from the user, 2026-11-03, later message)

User's words: "It should also be a system where I can add decks in myself"

## R6. Manual decks

- Besides PDF-backed books, the user can create decks by hand: named collections of prompts with no source
  document. The home screen lists Books and Decks with the same counts, plus "New deck".
- Deck page: name, optional description, prompt count, due count, "Review this deck", prompt list (search,
  edit, delete, move to another deck), and an "Add prompts" editor that accepts one or many prompts in the
  same Q./A. and {cloze} syntax. Blank lines separate prompts. A line starting with "# " sets the section label
  for the prompts that follow, so the review context line reads "Deck name · Section". Images paste inline as
  in the margin editor; KaTeX preview.
- Deck prompts have no anchor. Scheduling, global review interleaving, context line, exports and import/merge
  are identical to book prompts. A prompt belongs to exactly one collection (book or deck); moving a prompt
  from a book to a deck drops its anchor after an in-page confirmation.
- Decks can be renamed and deleted (in-page confirmation; deleting a deck deletes its prompts).
- Export/import work per deck and for everything.

# Addendum 5 (from the user, 2026-11-03, later message)

User's words: "also there should be keyboard shortcut options for the reviewing"

## R7. Configurable review shortcuts

- Settings has a "Review shortcuts" section: a table of review actions, each with an editable key binding:
  Show answer, Forgot, Remembered, Undo last grade, Skip (ask later this session), Go to source, Exit review.
  Click a binding, press the key (or key combination) to rebind; Esc cancels. Conflicts are flagged in-page.
- Presets: "Default" (Space / 1 / 2 / U / S / G / Esc), "Arrows" (Space / ArrowLeft / ArrowRight / U / S / G /
  Esc), "Vim" (Space / j / k / u / s / g / q), "Anki-like" (Space / 1 / 3 / Z / S / G / Esc). "Reset to default".
- Bindings persist in settings (localStorage) and are included in the JSON backup. The `?` overlay and the review
  card's buttons show the current bindings (e.g. a small key cap on each button).
- A keybinding never fires while a text field has focus; bindings are matched on event.key (case-insensitive for
  letters) plus modifiers.
- Keep the reader's shortcuts fixed in v1 (only review shortcuts are configurable), but structure the key map so
  reader shortcuts can be made configurable later.
