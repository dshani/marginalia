# Decisions settled with the user (grilling session, 2026-11-03)

These are final. Design and implementation must follow them; do not reopen them.

D1  Platform: browser app, no install (plain HTML/CSS/JS). Code must stay wrappable in Tauri/Electron later
    (keep storage behind one module so a file-system backend can replace IndexedDB).
D2  Data: local only, in the browser's IndexedDB, INCLUDING the PDF bytes so a book reopens from the library
    without picking the file again. JSON backup export/import (no PDF bytes in the backup). No sync, no account.
D3  One app: the home screen is the library (every PDF ever read) plus review. Per book: nickname, page count,
    prompt count, due count, "Continue reading" (last position). Top: total due + "Review all".
D4  Scheduling: Orbit-style. Two buttons, Forgot / Remembered. New prompt first due in 5 days. Remembered
    roughly doubles the interval. Forgot re-asks at the end of the session and drops to a short interval.
    "Review today's prompts" lets the reader review what they just wrote, in-session.
    Changed by D27 (2026-11-14): a new prompt is due at once until its first answer; the 5 days follow a right
    first answer on its first day.
    Changed by D28 (2026-11-14): Forgot brings the prompt back the next day, and a forgotten prompt grows more
    slowly.
D5  Prompt syntax: one text box. Two-sided prompt = a line starting "Q." and a line starting "A.". Cloze =
    a sentence with {hidden text} in braces; several braces = several cards. No hint syntax in v1.
D6  Creating prompts: ONLY (a) select text -> highlight + card beside it, or (b) double-click in the margin ->
    free note. Selected text may also be a plain highlight with no prompt, convertible to a prompt later.
    SNIPS NEVER CREATE PROMPTS OR ANCHORS: the snip tool is a copy device only.
D7  Margin: cards show the question with the answer under it in lighter text, aligned with the passage, on wide
    screens; collapse to small markers (expand on hover/focus) when the window is narrow.
D8  Context line on review cards: "Nickname · Ch. 1 · The Wave Function". Nickname editable in the library
    (default PDF title or file name). Chapter from PDF bookmarks; else chapter starts the user marks in the
    reader; else "p. 12".
D9  Global review: all due prompts from all books interleaved by due date; forgotten ones return at the end of
    the session; no cap; stop any time.
D10 Vision model for "To LaTeX": Claude. Local build: the user's own Anthropic API key pasted once in Settings,
    stored in this browser only (localStorage), "Forget key" button. Artifact build: the `sample` capability
    with images (no key). Mathpix is NOT integrated (the Mathpix Snip desktop app can still be used: its
    clipboard output pastes into the editor like any text).
D11 Exports: JSON backup (prompts, review history, images, documents; no PDF bytes), Markdown in Q./A. syntax,
    Anki TSV (MathJax delimiters, images as data: URIs). Import merges by prompt id.
D12 Browsers: Chrome and Safari on macOS, plus the artifact viewer in the Claude desktop app.
D13 Scale: full textbooks (500+ pages, 50 MB) must scroll and search smoothly -> lazy page rendering, cancel
    off-screen renders, cap concurrent renders.
D14 No "explain this passage" assistant in v1.
D15 Name: Marginalia.
D16 (= D2) PDF bytes are stored.
D17 (= D3) home screen contents.
D18 No notifications or emails. Due counts only when the app is open.
D19 Dark mode: app chrome follows the system theme (and a manual toggle); PDF pages stay paper-white with an
    optional "dim pages" toggle (a translucent overlay, not a canvas filter).
D20 Keyboard: N = write a prompt for the selection (or a free note when nothing is selected), Cmd/Ctrl+Enter =
    save, Esc = cancel, S = snip, Shift+S = toggle snip mode Image/LaTeX. Review: Space = show answer,
    1 = Forgot, 2 = Remembered, G = go to source, ? = shortcut list. Cmd/Ctrl+V pastes at the caret (text
    natively; images become inline attachments); with no editor open, Cmd+V creates a free margin note at the
    middle of the visible page (same as a double-click there) with the pasted content as its question.
D21 Snips go only to the clipboard; no snip history is kept. The snip toast offers "Switch to Image/LaTeX"
    and, when the write fails, "Copy" and "Insert at cursor" buttons; there is no "create prompt from snip".
D22 The Mac app (2026-11-11). Brave's "Clear browsing data" can delete the library, so the user asked for
    a self-contained app and gave four answers: (1) an Electron app, Marginalia.app, instead of Brave; (2) keep
    the Python server: the app starts its own copy of tools/serve.py; (3) the app carries its own copy of the
    code, rebuilt, tested and installed in one step after each change (marginalia app); (4) Brave sends the
    user to the app ("Marginalia is now an app"). This supersedes D1's "browser app, no install" for daily use.
    The web app stays plain HTML/CSS/JS with no build step (npm only in desktop/); the browser copy and the
    claude.ai artifact remain.
D23 Three picks the user confirmed (2026-11-11): (1) closing the app's window hides it; the app and its server
    keep running until Cmd+Q, so Obsidian's "Open in Marginalia" links keep working; (2) the app is signed
    ad hoc: macOS may ask again for the Documents folder after each update (no self-made certificate for
    now; desktop/sign-identity stays optional); (3) a deleted book's saved PDF stays in the backup folder's
    PDFs for 30 days after the deletion, and longer while an older kept backup still lists the book; then
    the next backup removes it. Time Machine keeps older copies.
    Changed by D30 (2026-11-15): part (1) holds, but Cmd+W now closes a tab first. It hides the window only
    with one tab left; Window › Close Window is Shift+Cmd+W.
    Changed by D31 (2026-11-15): part (1) holds for the last window. With more than one window open, a
    window that is closed really closes, and its tabs go.
D24 Only the local version (2026-11-11). The user needs only the Mac app. At the user's request the
    published claude.ai copy was deleted, and `marginalia web`, which opened it, was removed. The artifact
    build (`marginalia build`, dist/marginalia-artifact.html) stays in the code, unpublished.
D25 Prompt craft (2026-11-11). After reading Andy Matuschak's guide "How to write good prompts" the user chose
    four features (FEATURES-P1; rules in BUILD-NOTES "Prompt craft"). This replaces D5's "No hint syntax in v1":
    (1) cues in cloze blanks: {hidden::cue} shows "(cue)" beside the blank;
    (2) more writing hints: yes/no answers, a question that offers the answer as a choice, a list as the answer,
        a long cloze;
    (3) flag (F) and delete (Backspace) during review, a "Flagged for revision" list at the end of a session and
        a "Flagged" filter in the prompt list;
    (4) struggling prompts: a card forgotten on 3 or more days since the prompt's text last changed says so after the
        answer shows, and the prompt list marks and filters such prompts.
D26 Prompt craft, second set (2026-11-11). From an analysis of Matuschak's guide and its further reading the user
    chose four more features (FEATURES-P2; rules in BUILD-NOTES "Prompt craft"):
    (1) three more writing hints: a question that asks for examples, wording that points into the book, and words
        that will age without a year;
    (2) Split: a prompt's menu splits it into two prompts at the same passage, each written in its own editor;
    (3) "Another angle…": the editor offers starter questions (an "Angles" button for a new, empty prompt).
        Changed the same day: the first list had eight starters; the user said it did not cover the angles that
        Matuschak and the others discuss, and approved a list of 28 starters in 10 groups (Matuschak's five
        lenses, his explanation, procedure and use prompts, Nielsen's depth questions, Wozniak's memory aids);
    (4) look-alike prompts: the prompt list's "Look-alikes" filter and the editor's "Similar prompt" line, per book
        or deck; "Not alike" marks are kept in the settings.
D27 Scheduling closer to the sources, and a statistics page (2026-11-14). The user asked Claude to make sure the
    scheduler follows the eight articles (Matuschak's guide and its further reading) and works correctly. It
    equals Orbit's rule for rule and worked on the user's whole review history; two differences from the
    articles and one missing view were found, and the user chose all three changes (FEATURES-P3; rules in
    BUILD-NOTES "Scheduling and statistics"):
    (1) a session asks ONE card of a prompt: a sentence with several blanks gives one blank, and the others stay
        due for later sessions (the guide: one blank per session; Orbit: one component per task);
    (2) a prompt never asked is due at once, until its first answer (every source asks a new card on its first
        day; Orbit: due at creation). This changes D4's "first due in 5 days";
    (3) a statistics page: per prompt the day last asked, the day due next, the wait, the answers and the wrong
        answers; the cards coming due per day; and, after the user asked how to reach flagged prompts, a list of
        the flagged prompts of every book.
    Kept as they are: no cap on a session (D9; Orbit caps at 50), a skip is not graded (Orbit grades it as
    remembered), no card retires, and the grading rule itself.
    Changed by D28 (2026-11-14): the grading rule after a wrong answer. Changed by D29 (2026-11-14): part (1),
    the other blanks wait until the next day, not only until the next session.
D28 After a wrong answer (2026-11-14). The user asked what the research says about the wait after a wrong answer
    (BUILD-NOTES "Research note: after a wrong answer"), got three options (keep one step back; the next day and
    then the usual growth; Matuschak's sketch) and chose "Option 2", the sketch (FEATURES-P4; rules in BUILD-NOTES
    "Wrong answers and the next day"):
    (1) a prompt answered wrong is asked again in the session (as before, up to 3 asks) and is due the next day,
        whatever its wait was (before: one step back, at least 5 days, and due again after 10 minutes);
    (2) a prompt that was forgotten grows more slowly: each wrong answer leaves three quarters of its growth
        factor (2.3 at first, never below 1), wrong answers less than 16 hours apart count once, and each right
        answer on a day the prompt is due wins back a fifth of what is missing. Waits after one wrong answer: 1, 1.7, 3.2, 6, 12
        and 25 days;
    (3) the wrong answers given before this change count too: a card's growth factor comes from its answer
        history. Stored waits and due dates stay as they are until the card's next answer.
    A prompt never answered wrong is scheduled exactly as before.
D29 "The next day" (2026-11-14). The user: "I will review all cards and it will immediately say that some are
    due, shouldn't they only be due the next day?" Since D27 the other blanks of a sentence were due again at
    once, and so was a prompt answered wrong three times. Now (FEATURES-P4; BUILD-NOTES "Wrong answers and the
    next day"):
    (1) no prompt is due again within 16 hours of an answer to it ("the next day"; after a session before 8 in
        the morning that is late the same evening);
    (2) an answer to one blank of a sentence holds its other blanks back for 16 hours, also in "Review today's";
        then they come one a day. A session takes the blank that is most overdue for its own wait, so a blank
        that was forgotten comes back first and no blank is left out;
    (3) every count of "due", and every text that says when a prompt comes, shows what a session can ask, so a
        full review leaves nothing due.
D30 Tabs (2026-11-15). The user: "also add tab functionality so I can open something in a new tab with
    command+click and can open a new tab with command t etc." Claude showed three designs. The user chose
    design A, tabs inside the one window ("Yes, build A"), with the defaults Claude listed, and then added:
    "I want the ability of both A and the possibility of separate pages". This decision is the first step,
    the tabs inside the window (FEATURES-T1; rules in BUILD-NOTES "Tabs"). A tab in a window of its own is
    the next step: not built yet, it needs the user's go-ahead.
    (1) a tab is a place of the app: the library, a book, a deck or the statistics page. Cmd+T opens a new
        tab. Cmd+click on a book's "Continue reading", a deck's "Open", "Statistics" or a prompt of the
        statistics page opens it in a new tab behind the one on screen; with Shift the new tab comes to the
        front. Cmd+W closes the tab. Cmd+Shift+T brings the last closed tab back. Ctrl+Tab and
        Ctrl+Shift+Tab, Cmd+Shift+] and [, and Cmd+1 to Cmd+9 change tabs;
    (2) with one tab left, Cmd+W hides the window as before (D23 (1)); Window › Close Window is Shift+Cmd+W;
    (3) the tab strip shows only with two or more tabs, so with one tab the app looks as before. Two tabs
        can show two places of one book. A tab that comes back shows its place again, and a prompt editor
        that was open in it. The open tabs come back after a restart (kept on this Mac only, in no backup);
    (4) a link from outside ("Open in Marginalia") goes to the tab that shows that book already, else to a
        library tab, else to a new tab.
    The page still holds one open book and saves as before ("One writing tab per origin" is unchanged).
    Step 2 is D31: the windows of the Mac app. Since D31 a tab can be dragged to another place in its strip.
D31 Windows (2026-11-15). After D30 Claude asked whether to build step 2, a tab in a window of its own, and
    said how the library stays safe: one window saves at a time, and the window that is used takes over.
    The user: "I want it the way preview works. So that you can drag a tab to a new window and command N
    opens a new window". Built for the Mac app (FEATURES-T2; rules in BUILD-NOTES "Windows").
    (1) Cmd+N opens a new window with a library tab. A tab that is dragged out of the strip and dropped
        outside its window gets a window of its own at that place. Dropped on another window's strip, it
        moves into that window. Dragged along its own strip, it changes its place. Window › Move Tab to
        New Window and Window › Merge All Windows do the same from the menu;
    (2) each window has its own tabs (D30). The windows use the app's own tab strip, not the tab bar of
        macOS. That is Claude's choice, told to the user: a window then holds one open book, and the
        gestures are the same;
    (3) one window saves at a time: the window that is used. A window that gets the focus, a key or a click
        takes over, and it first reads what the other window saved. There is no notice and no button:
        every window stays usable. Among the windows of the Mac app this replaces "One writing tab per
        origin"; a browser page keeps that rule and its notice;
    (4) a window that is not the last one closes for good, and its tabs go. The last window hides as before
        (D23 (1)). After a restart the app opens one window; the book and deck tabs of every window that
        was open at the quit come back in it (a window holds 20 tabs; tabs beyond that come back at a
        later start);
    (5) limits that Claude chose: at most 8 windows; one review at a time among the windows.
    Changed on 2026-11-15, after the user tried 1.5.0 ("it all works but … dragging a tab down doesn't seem
    to auto move it to a new window" and "preview's interface is more seamless where it \"previews\" as you
    drag it down with a mini thing"): a tab that is let go anywhere but on a tab strip (or just beside
    one) gets a window of its own at that point, also inside a Marginalia window (not only outside it,
    as (1) said); while a tab is dragged, a small picture of it follows the pointer; a new window is on
    screen at once (1.5.1).
D32 The Obsidian connection is an option, and the project is ready for other people (2026-11-17). The user:
    "Can you make the current app usable so that I can put it on github and people can use it? and for that
    reason, can the obsidian connection be an option in settings?" Asked three things, the user chose: the
    MIT licence; the name "dshani" on its copyright line; other people get the Mac app from the source (no
    ready-made download). Built (rules in BUILD-NOTES "Obsidian", "The switch"):
    (1) Settings › Obsidian has the switch "Connect Marginalia to Obsidian". Off: the reader shows no
        "Note → Obsidian", O does nothing, no menu has "Send to Obsidian" or "Send all to Obsidian", and
        Marginalia asks its server nothing about Obsidian. On: everything works as before;
    (2) a new library starts with the switch off. A library that already sent a card to Obsidian keeps the
        connection on until its reader turns the switch off. That is Claude's choice, told to the user:
        nothing changes for a library that uses Obsidian already;
    (3) the switch travels in the JSON backup with the other settings. An import restores it only when the
        backup holds a choice;
    (4) no file of the project holds private data of its author: no real name (the licence carries the
        public name that the user chose), no e-mail address, no folder of one person's Mac. The Mac app's
        welcome card names no browser: it reads "Welcome to Marginalia" and tells a new reader to start
        with an empty library. The project has a README, the licence and a .gitignore at its top. The
        app is 1.6.0.

D33 Undo and redo for cards (2026-11-18). The user: "Is there a way to add undo/re-do commands?" Claude showed
    what was there (Cmd+Z for the text in the editor; Z after a delete and the library's "Undo" notices, 8
    seconds; U in a review, one step) and three ways: A, one undo and redo for cards; B, more notices of the
    old kind; C, a history that stays in the library. The user: "Yes, build A". Built (rules in BUILD-NOTES
    "Undo and redo"):
    (1) Cmd+Z takes back the last change that a person made to a card (a prompt, a note or a highlight), and
        Shift+Cmd+Z makes it again: a new card, a saved edit, a delete, a flag, "Move to…", "Anchor to
        selection", each half of a Split, and the deck page's "Add" (all its prompts are one step). A notice
        names what was taken back and has a button for the way back;
    (2) up to 100 steps, with no time limit. The steps live in the window: a reload or a quit empties them,
        and each window of the Mac app has its own (D31);
    (3) in a text field the two keys stay the undo and redo of the text, and a card that is open in an
        editor of that window is not changed under it (also when the editor waits in another tab). The
        deck page's notice "Added n prompts" has its own Undo, because the focus stays in the add box
        there; it takes back that Add only while the Add is the newest step. In a review Cmd+Z is U.
        Z, U and the "Undo" notices work as before; Z right after a delete counts as the undo of that
        step;
    (4) a card that changed in another way since the step (a review answer, another window, an import) is
        not taken back, and a notice says so. A card never goes back into a book or deck that is deleted;
    (5) an undo keeps what is not the person's own change: the record that a card was sent to Obsidian (so
        "Send all" never adds it twice, and the card counts as edited since its send) and a newer found
        position of its passage. A picture that an edit took out stays in the store while a step can bring
        its text back;
    (6) Claude's proposals, which the user took with A: the first version covers cards only. The library
        keeps its own "Undo" notices (a book, a deck, a folder, a move), and Settings, imports, exports and
        review answers have no undo here. Claude's choice, told to the user: the Edit menu of the Mac app is
        unchanged, so its Undo and Redo, clicked with the pointer, act on text only; the keys do both. The
        app is 1.7.0.

D34 Open a PDF from Zotero (2026-11-23). The user: "would there be an easy way to link this app with zotero?",
    and then: "ideally im able to have a right click option in zotero to open the pdf in marginalia, and then
    theres some kind of link from zotero to the note cards i create or some kind of record of marginalia note
    cards in zotero". Claude proposed two steps: (1) "Open in Marginalia" in Zotero's right-click menu, (2) a
    record in Zotero that a book has cards (the user: "i dont need a link to each card, i just want some kind
    of evidence that cards exist"; Claude proposed a tag). The user: "maybe we do this first?" for step 1, and
    "Yes, build it" to its one channel. Built (rules in BUILD-NOTES "Zotero"):
    (1) the Mac app opens a PDF that macOS hands it: Finder's Open With lists it as an alternative (it never
        becomes the Mac's default app for PDFs), and `open -b local.marginalia.desktop <file>` works. The
        window in front adds it as a dropped PDF and opens it in the reader; a PDF that is already in the
        library opens its book, so nothing is added twice. A file that is no PDF is refused with a notice;
    (2) the app's preload gets its first ipc channel, from the app to the page only: it carries the name and
        the bytes of such a PDF, never its place on the disk. The page cannot send anything through it;
    (3) Marginalia for Zotero, a Zotero plugin in desktop/zotero/ (Zotero 8 to 10; `npm run zotero` packs it
        into desktop/out/Marginalia-for-Zotero.xpi, which the user installs in Zotero): "Open in Marginalia"
        on an item with a PDF, or on a PDF, opens it through `open -b`. A regular item gives its best PDF
        attachment, as a double-click in Zotero does. At most 20 at once;
    (4) Claude's choices, told to the user: the plugin lives in desktop/ with the Mac app it needs, its tests
        run with the desktop tests, and the Zotero key is not stored yet: step 2 needs it, and step 2 is not
        built. Step 2 waits for the user's word. The app is 1.8.0;
    (5) `marginalia app` deletes the build copy in desktop/out/ once it has installed the app. Claude found that
        macOS registers that copy again (Spotlight finds it in the project folder), so `open -b` could start it
        instead of the installed app; Claude asked, the user: "Yes, change it".
