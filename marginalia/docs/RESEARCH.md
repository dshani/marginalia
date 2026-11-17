# Research notes: Andy Matuschak's margin-prompt PDF reader

Source video: "Studying with Dwarkesh Patel - 'Introduction to Quantum Mechanics' by Griffiths"
(https://www.youtube.com/watch?v=OFuu4pesKf0, Andy Matuschak's channel, 12 Jul 2023, 2h10m).
Description (in short): he recorded himself while he studied the textbook, talked aloud about his
thinking, and used a prototype of his memory system.

## What the video shows (observed from frames)

1. The reader is a locally served, customised PDF.js default viewer
   (URL bar shows `localhost:3000/pdfjs/web/viewer.html?file=/mk/griffiths/1.pdf`, toolbar: "1 of 22", zoom 125%).
   Continuous vertical scrolling of pages, standard PDF.js toolbar (sidebar toggle, search, page number, zoom).
2. The page is rendered with WIDE margins on both sides. Passages that have prompts attached are
   highlighted in YELLOW on the page text (e.g. "a potential energy function", "Planck's constant",
   and longer phrases of about a line).
3. In the RIGHT margin, next to each highlighted passage, there are compact prompt cards:
   - each card has a small icon at its left (a card/orbit glyph), then the QUESTION text,
     then the ANSWER text in a lighter/smaller style underneath;
   - cards are narrow (roughly 220-260 px), left-aligned text, no heavy borders;
   - the card's top edge lines up with the vertical position of its highlighted passage;
   - the text can contain LaTeX source (e.g. "Simplify: $\left\langle j \right\rangle^2$ ...") - he writes
     math as TeX inside prompts.
4. A REVIEW mode takes over the whole viewer: warm beige background, the question set in a large
   geometric sans-serif (e.g. "What is the Schrödinger equation?", "Express F in terms of V (for
   conservative systems)."), top-right a red/orange "Exit Review ✕" link, and a small progress/interval
   indicator (a star-like glyph with a scale of interval labels like "6d 2wk 1mo 2mo 4mo 1yr").
   Flow: question -> "Show Answer" -> answer shown -> two grading buttons (Orbit's "Forgot" / "Remembered").
   He reviews the prompts he just wrote, in context, during the same reading session.
5. He studies alongside ChatGPT (separate window) and a handwriting notes app on an iPad; those are NOT
   part of the reader and are out of scope.

## Andy's documented design principles (from notes.andymatuschak.org)

- Margin prompts "signal particularly important passages and hint at what to focus on" and make
  readers slow down; the front side of a prompt is visible in the margin on large screens, collapsed
  to a marker on small screens (hover reveals). Collapsed mode produced "healthier reading".
- Prompts are tied to narrative context: they sit beside the passage they belong to; readers finish a
  passage, then "scan sideways into the margin".
- Writing prompts inline while reading feels lighter-weight than switching to a notes file; highlight
  markers give a sense of which passages already have prompts.
- Readers want a lighter way to mark interest than writing a full prompt (a highlight/bookmark).
- Orbit re-asks forgotten prompts; the first scheduled review of a new prompt is a few days out.

## Orbit / note-sync prompt syntax (Andy's personal mnemonic medium)

Two-sided prompts, one paragraph each:

    Q. How many dimensions are in a qubit's vector space?
    A. Two.

Cloze prompts: wrap the hidden span in curly braces inside a paragraph, e.g.
"a service worker {performs one-time startup computation}, then transitions to {idle}."
One paragraph with several braced spans produces one card per deletion; the question side shows the
whole paragraph with the deletion masked; the answer side reveals it.
Prompt identity = hash of question+answer text (edits create a new prompt in Orbit; in our app we keep a
stable id instead, so edits keep review history).

## PDF.js facts (verified today)

- cdnjs serves pdf.js 3.11.174 UMD (`pdf.min.js`, `pdf.worker.min.js`, global `pdfjsLib`) and 4.10.38 ESM
  (`pdf.min.mjs`, `pdf.worker.min.mjs`). Both returned HTTP 200 from
  https://cdnjs.cloudflare.com/ajax/libs/pdf.js/<version>/<file>.
- Cross-origin worker URL: pdf.js wraps it in a blob worker automatically (createCDNWrapper), and falls
  back to a main-thread "fake worker" if worker creation fails.
- `getDocument({data})` TRANSFERS the ArrayBuffer to the worker (detaches it). Copy bytes before
  handing them to pdf.js if they must be stored.
- Text layer (3.x): `pdfjsLib.renderTextLayer({textContentSource, container, viewport, textDivs})`;
  the container needs CSS `--scale-factor: <viewport.scale>` and the usual `.textLayer` styles
  (absolute spans, transparent text, `white-space: pre`, `transform-origin: 0 0`).
- Convert DOM/viewport coords to PDF user space with `viewport.convertToPdfPoint(x, y)` and back with
  `viewport.convertToViewportRectangle([x1,y1,x2,y2])`, so anchors survive zoom changes.
- Document fingerprint: `pdf.fingerprints[0]` (3.x) - use as the stable document id, with a SHA-256
  of the bytes as fallback.

## Environment / delivery constraints

- Runs with no build step: plain HTML/CSS/JS; libraries only from cdnjs (pinned versions).
- Must work when served over http (python3 -m http.server) and when opened as a single file;
  also publishable as a claude.ai Artifact (CSP: scripts only from cdnjs/jsdelivr/unpkg; no external
  CSS except Google Fonts; IndexedDB and file inputs work; `<a download>` is inert for viewers, so
  exports must also offer copy-to-clipboard; no alert/confirm/prompt dialogs; theme tokens for light/dark).
- Available locally: node v23.7.0, python 3.14.
