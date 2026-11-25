# Marginalia

Marginalia runs as a Mac app (see "Desktop app") or in a browser. Books, prompts, images and review history stay on this Mac: in the app's own folder, or in the browser's IndexedDB. Nothing is uploaded anywhere, except snips you send to Claude for LaTeX transcription.

## Run it

Open Terminal and type:

```bash
marginalia
```

Once the Mac app is installed (see "Desktop app"), this opens the app. Without the app, it starts Marginalia in the background and opens http://127.0.0.1:8765/ in Google Chrome. Without Chrome it opens in Brave, then in your default browser; set `MARGINALIA_BROWSER` (for example `Safari`) to choose another one. Use the same address every time: the browser keeps a separate library for every address.

| Command | What it does |
|---|---|
| `marginalia` | open the Mac app; without it, start the server if needed and open the page in Chrome |
| `marginalia stop` | quit the Mac app; without it, stop the server |
| `marginalia restart` | quit the Mac app and open it again; without it, restart the server and open the page |
| `marginalia status` | show whether the app is running, and what uses port 8765 |
| `marginalia app` | build the Mac app, test it, then install it in `/Applications` |
| `marginalia test` | run the unit tests and code checks (the Mac app's too) |
| `marginalia build` | rebuild the bundles in `dist/` |

The command is `bin/marginalia` in the project folder. To type just `marginalia`, link it once into a folder on your PATH (the README at the top of the project says how); else type its path. Without the command, `python3 -I tools/serve.py` (run in this folder) serves the same app.

In a browser, Marginalia saves from one tab at a time. When it opens in another tab (an **Open in Marginalia** link from Obsidian, or running `marginalia` again), the older tab stops saving and shows "Marginalia is open in another tab". **Use this tab** reloads it with the latest library, and the other tab steps aside. Text that was still unsaved in an editor there is shown with **Copy text**. After updating Marginalia, reload any tab that was already open: a tab still running the old code does not step aside. With the Mac app installed, `marginalia` opens the app instead, and an **Open in Marginalia** link goes to the app's one window (see "Desktop app", "Use it").

## Reading and writing prompts

- **Add PDF** on the home screen (or drop a file on it). The book reopens from the library at the last page.
- **Select text, press N.** The passage turns yellow and an editor card opens beside it. Write `Q.` and `A.` lines, or a sentence with `{hidden text}` in braces; several braces make several cards. Tab inserts the `A.` line. `Cmd+Enter` saves, `Esc` cancels.
- **A cue in a blank**: `{hidden::cue}` shows "(cue)" beside the blank while you review, for example `The {Aare::river} flows through Bern.` asks "The ____ (river) flows through Bern." The last `::` in the braces splits them, and both sides must hold text. Write `\::` for a `::` that is not a cue. The cards and their schedules stay when you add, change or remove a cue. In the margin, the prompt list and the preview the cue shows beside the marked text; the Anki export writes Anki's own hint (`{{c1::Aare::river}}`), and Obsidian gets the hidden text only.
- **C** makes a cloze prompt from the selection: the surrounding sentence, with the selection in braces. C and Alt+Shift+C write a `::` in the selected text as `\::`, so a selection never makes a cue by accident.
- **H** keeps the selection as a plain highlight. "Write prompt" turns it into a prompt later.
- **Split** (in a card's ⋯ menu, and in a row's ⋯ menu in the prompt list, for Q./A. and cloze prompts) turns one prompt into two. It opens the prompt in the editor; once you save it, a second editor opens for a new prompt at the same passage (in a deck: the same deck and section), filled with the text the prompt had before your edit. Trim each one to its half. Cancel in the first editor and nothing changes; Cancel in the second and only your first edit stays. The first prompt keeps its review schedule; the second starts fresh. The second half is never lost: if something else closes its editor (another editor, leaving the book, closing the list, a reload), the menu shows **Finish split** in the place of Split until you save or cancel it, and Finish split opens that second editor again with your text.
- **Another angle…** (in a card's ⋯ menu) opens a new prompt at the same passage with a list of 28 starter questions, such as "How is … similar to …?". The list has 10 headings, one for each angle that Matuschak, Nielsen and Wozniak describe: Attributes and tendencies, Similarities and differences, Parts and wholes, Causes and effects, Significance and implications, Explanation, Procedure, Use, Depth, Memory. Pick a question with the arrow keys and Enter, or click it (Esc closes the list; the list scrolls, and its heading stays in view); its first "…" is selected, so typing replaces it. The same list is behind the quiet **Angles** button of a new prompt's editor while it is empty or holds just "Q. ".
- **Double-click the margin** for a free note at that height.
- **Undo and redo**: `Cmd+Z` takes back the last change to a card (a new prompt, note or highlight, a saved edit, a delete, a flag, each half of a Split, "Move to…", "Anchor to selection"), and `Shift+Cmd+Z` makes it again. A notice says what was taken back and has a button for the way back. Marginalia keeps up to 100 steps, with no time limit, also in the prompt list and on a deck page, where one **Add** of several prompts is one step. Things to know:
  - In the editor the two keys work on the text that you type, as before. A card that is open in an editor is not changed under it, also when that editor waits in another tab: save or cancel the editor first.
  - On a deck page the focus stays in the add box after **Add**, so the notice "Added 2 prompts" has its own **Undo** button. It takes back that Add only while the Add is your newest change.
  - The steps live in the window: a reload or a quit empties them, and each window of the Mac app has its own.
  - A card that changed in another way since the step (you answered it in a review, another window changed it, an import brought a newer version) is not taken back. The notice says so.
  - A copy in Obsidian stays as it is until you choose **Update in Obsidian**. A card never goes back into a book or deck that you deleted.
  - A deleted book, deck or folder and a move to a folder keep their own **Undo** notice (8 seconds). Settings, imports and exports have no undo.
- Math renders with KaTeX: `$x$`, `$$…$$`, `\(…\)`, `\[…\]`.
- **Writing hints** show under the editor and on the card (they never block a save): besides a long question or answer, a yes/no question and several sentences or many blanks in one cloze, they now flag an answer that is just yes, no, true or false, a question that offers the answer as a choice ("… A or B?"), an answer that is a list of 3 or more items, and a cloze of more than 30 words. They also flag a question that asks for examples ("Name an example of …"), wording that points into the book ("this chapter", "the author", "Eq. (1.5)", "Example 2.6", "the figure above", "in the figure") and words that will age ("currently", "the latest measurement", "so far", …) when the prompt holds no year. When a yes/no question offers the answer as a choice ("Are electrons bosons or fermions?"), the hint is the choice one.
- **The prompt list** (L in a book, and on a deck page) has filter chips under its search box: **Flagged n** and **Struggling n** show while they count something; a click turns one on or off (Space or Enter on a focused chip too; Backspace, F and E there do nothing to the rows). Chips that are on combine with each other and with the search. A struggling row says "struggling" (hover it: "Forgotten on 3 days"). A third chip, **Look-alikes n**, counts the prompts whose question shares most of its words with another prompt of the same book or deck (such prompts get mixed up in review). Two cloze prompts of the same sentence with different blanks (such as the two halves of a split cloze) do not count. Turned on, it shows only those prompts, each pair side by side, and each row has a quiet line "≈ " with the other prompt's question. If two prompts are fine as they are, choose **Not alike** in the row's ⋯ menu: that pair is not shown again (the marks are kept in the settings and travel in JSON backups). Look-alikes are found within one book or deck only, never across two.
- **Similar prompt**: while you write or edit a Q./A. or cloze prompt, a quiet line under the hints names the most alike prompt of the same book or deck, "Similar prompt: “…” (p. 12)" (the page only for a book). It never blocks a save; a pair marked Not alike is not named.
- Paste a screenshot with `Cmd+V` into the editor; it becomes an inline image. With no editor open, `Cmd+V` creates a free note from the clipboard.
- The notes margin stays beside the page down to a 680-px window (narrower cards below 1000 px), then becomes a rail of markers, and below 600 px notes open in a bottom sheet. A page zoomed wider than the window scrolls sideways under the margin, so the notes stay in view; ⊡ in the toolbar (or `Cmd+0`) goes back to fit width.

## Snips (copy only)

Press **S** and drag a box over a diagram or an equation. The region is rendered at three times the screen resolution and copied to the clipboard:

- **Image** mode copies a PNG. `Cmd+V` pastes it into a prompt, or anywhere else.
- **LaTeX** mode sends the image to Claude and copies the transcription wrapped in `$…$` or `$$…$$`. `Shift+S` toggles the mode.

LaTeX mode needs an Anthropic API key (Settings › LaTeX from snips). The key stays in this browser's localStorage, is never exported, and "Forget key" removes it. The claude.ai artifact build uses the viewer's own Claude account instead and needs no key. Snips never create prompts on their own.

## Review

- **T** reviews the prompts written today, **R** this book, **Shift+R** every due prompt from every book and deck, interleaved by due day.
- Each card shows a context line such as `Griffiths · Ch. 1 · The Wave Function` (chapters come from the PDF outline; `Shift+C` marks a chapter start by hand; the nickname is editable in the library).
- `Space` shows the answer, `1` Forgot, `2` Remembered, `G` opens the source passage, `U` undoes the last grade (`Cmd+Z` does the same there), `S` skips, `Esc` exits. All review keys can be changed in Settings › Review shortcuts (presets: Default, Arrows, Vim, Anki-like).
- `F` flags the prompt for revision ("⚑ Flagged" on the card; F again unflags). `Backspace` deletes the prompt at once, with all its cards (no question asked); `U`, or Undo in the "Prompt deleted" notice (8 seconds), brings it back where it was in the session. After a later grade or skip, the notice's Undo only restores the prompt, which then waits for its next session. Both work before and after the answer shows, and the card has quiet Flag and Delete buttons too. If you had changed your review keys before, F and Backspace are added only where no other review key already uses them (check Settings › Review shortcuts).
- A card you forgot on 3 or more different days since the prompt's text last changed says "Forgotten on N days — split it or add a cue" once the answer shows. Only an edit of the text starts the count again: flagging it, its tags, a move to a deck, or deleting it and undoing keep the line.
- The end of a session counts deleted prompts apart ("1 deleted") and lists, under the still-shaky prompts, the prompts of the session that are "Flagged for revision", each with Edit. A prompt that is both shows once, in the still-shaky list, with ⚑.
- A new prompt is due at once, and stays due until you answer it for the first time (a skip is no answer). A right first answer on the day you wrote it brings it back in 5 days. After that, Remembered roughly doubles the wait (5 days, 2 weeks, 1 month, 2 months, 4 months, 1 year).
- Forgot asks the prompt again at the end of the session, up to 3 times, and brings it back the next day, whatever its wait was. From there the wait grows again, more slowly than before: 1, 1.7, 3.2, 6, 12 and 25 days when every answer is right and on time (a prompt never forgotten: 5, 11.5 and 26 days). With one session a day you see a forgotten prompt on days 1, 3, 7, 15 and 31. Each wrong answer slows the growth more (wrong answers less than 16 hours apart count once); each right answer on a day the prompt is due wins back a fifth of the lost speed. A prompt that you keep forgetting therefore comes almost every day, until you know it or rewrite it.
- "The next day" means 16 hours later at the earliest. No prompt is due again within 16 hours of your answer, so a full review leaves nothing due. After a session in the afternoon or evening the prompts come back the next day; after a session before 8 in the morning they come back late that evening. Only **T** asks a prompt again sooner, because it asks due or not.
- A session asks one blank of a sentence. Its other blanks wait until the next day and then come one a day, so one blank never gives another away. Of the blanks that can be asked, the session takes the one that is most overdue for its own wait: a blank you forgot comes back first, and no blank is left out. The end of the session says how many wait ("2 more blanks wait until tomorrow"). The counts on the home screen count the cards that can be asked now, so "Review all · 30 due" may start a session of 17 and shows 0 after it.

## Statistics

**Statistics** on the home screen (beside ⚙) shows when each prompt was asked and when it comes back. The page changes nothing.

- **The totals line**: prompts, cards, cards due now, cards never asked, answers, and wrong answers.
- **Coming due**: the cards that come due on each of the next 30 days, one column per day; today holds everything that is due now. Each card is in the column of the day from which a session can ask it (16 hours before its due time, as the due counts say), so a blank that waits for its sentence, and a prompt you just answered wrong, are in the column 16 hours ahead. Point at a column to read its number, or open **Show as a list**.
- **The table**: one row per prompt with its book, its cards, the day it was last asked, the day it is due next ("now" while a card of it is due), its current wait, its answers and its wrong answers. A wait such as "1 d · ×1.7" belongs to a prompt you answered wrong: after a right answer its wait grows 1.7 times, not 2.3 times. Click a column header to sort, and again to turn the order round: **Last asked** puts the prompts never asked first, then the ones asked longest ago. Click a prompt to open it in its book.
- **Two filters** narrow the totals, the chart and the table: one book or deck, and **Show**: All prompts, Due now, Never asked, **Flagged** or Struggling. Flagged is the list of the flagged prompts of every book and deck: click one to open it at its passage, edit it there, and press F on its card to take the flag off (a deck's prompt opens its deck page, whose list has the Flagged chip). A filter chooses prompts; the totals and the chart then count all cards of those prompts.
- **‹ Library** or Esc goes back. While a review runs over the page, the page waits and shows the new figures when the review ends.

## Decks

**New deck** on the home screen makes a deck without a PDF. On the deck page, paste prompts in batches: blank lines separate prompts, and a line `# Section` labels the prompts after it (the section appears in the context line).

## Folders

Group books and decks into folders on the home screen, with folders inside folders as deep as you like.

- **New folder** (beside New deck) makes one; a folder's ⋯ menu has **Rename**, **New folder inside**, **Move to folder…** and **Delete**. Folders sit above Books and Decks, sorted by name ("Ch 2" before "Ch 10"); books and decks in no folder stay in Books and Decks as before.
- Click a folder's name (or its ▸) to open or close it. An open folder shows its folders, then its books, then its decks, indented. This browser remembers which folders are open.
- **To move** a book, deck or folder: **Move to folder…** in its ⋯ menu (also on the deck page) lists every folder, plus **No folder (top level)**; or drag its row onto a folder, or onto Books or Decks to take it out of its folder (Esc cancels a drag). A folder never goes inside itself. The notice that confirms a move has **Undo**.
- A folder's row counts the books, decks and due cards in it, sub-folders included. Its **Review** button reviews the due cards of every book and deck in it, sub-folders included, mixed together as Review all does (one blank of a sentence per session); the end of the review names the folder.
- **Delete** asks first. The folder goes, and its books, decks and folders move up one level; nothing else is deleted (no book, prompt or review history). **Undo** (or Z) brings it back.
- Obsidian notes do not change with folders: a book's notes stay in `Notes/Marginalia/<book>.md` (the folder set in Settings › Obsidian). The JSON backup, daily backups included, carries the folders; importing one merges them (the later change of a name or place wins).

## Tabs

Open several places at once, each in a tab: the library, a book, a deck or the statistics page. The tab strip shows at the top when two or more tabs are open; with one tab the app looks as before.

| Do this | With |
|---|---|
| open a new tab (the library) | Cmd+T, or **+** at the end of the strip |
| open a book, a deck, the statistics page or one of its prompts in a new tab | Cmd+click on **Continue reading**, **Open**, **Statistics** or the prompt; the tab opens behind the one on screen. With Shift held too, it comes to the front |
| close a tab | Cmd+W, the **×** on the tab, or a middle click on the tab (with the keyboard focus on a tab: Delete) |
| bring the last closed tab back | Cmd+Shift+T (the last 10 closed tabs) |
| change tabs | a click on the tab; Ctrl+Tab and Ctrl+Shift+Tab; Cmd+Shift+] and Cmd+Shift+[; Cmd+1 to Cmd+8 for tab 1 to 8, Cmd+9 for the last tab |

- **A tab keeps its place.** A book tab opens again on the page where you left it, with its zoom. Two tabs can show two places of the same book.
- **A tab keeps its open editor.** If you change tabs while you write a prompt, the editor closes with its book. When you come back to the tab, the editor opens again with your text.
- **With one tab left, Cmd+W hides the window**, as before. Window › Close Window (Shift+Cmd+W) hides it at once. Marginalia keeps running; Cmd+Q quits it. With more than one window open, a window closes instead: see "Windows".
- **Drag a tab** along the strip to give it another place.
- **A name you are typing is kept.** If you change tabs while you rename a book or a folder, the new name is saved.
- **The tabs come back** when you open Marginalia again. They are kept on this Mac only, not in a backup. A tab whose book or deck was deleted does not come back.
- **An "Open in Marginalia" link** goes to the tab that shows that book already. Without one it uses a library tab, or opens a new tab.
- During a review, and while a dialog is open, the tab commands and the tab strip do nothing, and a review covers the strip. With more than one tab open, Cmd+W also does nothing then; with one tab it hides the window as always. An "Open in Marginalia" link then opens in the tab on screen, as before.
- You can open up to 20 tabs. With 20 tabs open, an "Open in Marginalia" link uses the tab on screen and says so.
- **In a browser** (without the Mac app) the browser keeps Cmd+T, Cmd+W, Cmd+Shift+T and Ctrl+Tab for its own tabs. Use the strip's buttons and Cmd+click there. The browser's Back and Forward buttons move the tab that is on screen.

## Windows

In the Mac app you can have several windows, each with its own tabs. For example, read a book in one window and work on a deck in the other.

| Do this | With |
|---|---|
| open a new window (the library) | Cmd+N, or Window › New Window |
| give a tab a window of its own | drag the tab down out of the strip and let it go, inside or outside the window; or Window › Move Tab to New Window |
| move a tab into another window | drag it onto the tab strip of that window (or just below the strip). A window with one tab shows its strip while you drag a tab over it |
| bring all tabs into one window | Window › Merge All Windows (the window in front gets them) |
| close a window | the red button, or Shift+Cmd+W; Cmd+W with one tab left |

- **One window saves at a time: the window that you use.** When you click another window or type in it, that window takes over. It first reads what the other window saved, so it shows the library as it is now. You do not have to do anything.
- **A window that you do not use can show old data.** It shows what the other window changed when you click it. You can scroll it without a click (the pointer over it); it remembers that place.
- **A window that is busy keeps saving until its work has ended** (it adds a PDF, or imports a backup). Another window then says "Waiting for another Marginalia window to finish its work…" and continues by itself.
- **One review at a time.** While a review is open in one window, another window says "A review is open in another window".
- **Closing.** A window that is not the last one closes, and its tabs go. The last window hides, as before, and Marginalia keeps running. Cmd+Q quits.
- **After a restart** Marginalia opens one window. The book and deck tabs of every window that was open when you quit come back in it. A window holds 20 tabs; tabs beyond that come back at a later start.
- You can open up to 8 windows. A window with 20 tabs takes no more tabs: a tab that you drop on it gets a window of its own. The same holds for a window with a dialog or a review open.
- **A book that you added a moment ago**: when you drag its tab onto another window, that window may not know the book yet. The tab then stays where it is, and the window says "Drag the tab once more". The second drag works.
- **While you drag a tab**, a small picture of it follows the pointer, and the tab in the strip looks lifted. The new window opens where you let the tab go.
- **Where you let the tab go.** On a Marginalia window (its own or another one, but not on a tab strip): the new window opens at once. Outside every Marginalia window (on the desktop): the new window opens a moment later.
- **To stop a drag**, let the tab go on its own strip (or just below it), or press Escape while the pointer is over the tab's own window.
- A new window is on screen at once. Its page and its book follow after about half a second.
- **In a browser** (without the Mac app) there are no such windows. A second browser tab still takes over for good, with the notice "Marginalia is open in another tab".

## Keyboard map (reader)

| Key | Action |
|---|---|
| N / C / H | prompt, cloze, highlight for the selection |
| O | a note for Obsidian (the selection, or a free note), while the Obsidian connection is on (Settings › Obsidian) |
| J / K | next / previous card · E edit · Enter show answer · G go to passage · F flag |
| Backspace | delete card (Z undoes) |
| Cmd+Z / Shift+Cmd+Z | undo / redo the last change to a card (in the editor: to the text) |
| A / M / D | hide answers · markers mode · dim pages |
| L / Cmd+F / P | prompt list · find · page box |
| S / Shift+S / Esc | snip · toggle Image/LaTeX · cancel |
| R / Shift+R / T | review this book · review all · review today's |
| Cmd+= Cmd+− Cmd+0 | zoom in · out · fit width (Cmd+0 again at fit width resets the browser's own zoom); a trackpad pinch zooms the page too |
| Cmd+O / ? / , | add PDF · shortcut sheet · settings |

Tabs (in the reader and everywhere else; see "Tabs"):

| Key | Action |
|---|---|
| Cmd+T / Cmd+W / Cmd+Shift+T | new tab · close tab · reopen the last closed tab |
| Ctrl+Tab / Ctrl+Shift+Tab | next tab · previous tab (also Cmd+Shift+] and Cmd+Shift+[) |
| Cmd+1 … Cmd+8 / Cmd+9 | tab 1 to 8 · the last tab |
| Cmd+click | open in a new tab |
| Cmd+N | new window (Mac app; see "Windows") |

In review (the Default keys; Settings › Review shortcuts changes them):

| Key | Action |
|---|---|
| Space / 1 / 2 | show answer · forgot · remembered |
| U / S / G / Esc | undo · skip · go to source · exit review |
| F / Backspace | flag for revision · delete prompt (U undoes) |
| ? | shortcut sheet |

Cmd is Ctrl outside macOS.

## Obsidian

Every note or prompt can also go to your Obsidian vault, one Obsidian note per book (or deck), for example `Notes/Marginalia/Griffiths.md`. The card stays in the margin; Obsidian gets a copy.

- **Turn it on first**: Settings › Obsidian › **Connect Marginalia to Obsidian**. In a new library it is off. While it is off, Marginalia shows no Obsidian command (no "Note → Obsidian", no O key, no "Send to Obsidian" in any menu), sends nothing, and asks nothing about Obsidian. Turn it off again there at any time; the notes that are in Obsidian stay. A library that already sent a card to Obsidian (before this switch existed, or in a backup that you import) has it on until you turn it off.
- **Select text, press O** (or "Note → Obsidian" in the popup). Write the note and press `Cmd+Enter` ("Save + Obsidian"): it is saved in the margin, then added to Obsidian under its chapter and page, with the passage as a quote and a link back to it. The passage is shown exactly as in the PDF: `#`, `%%`, `[[ ]]`, `==` and the like are escaped, so they never turn into tags, comments, links or highlights. With nothing selected, O makes a free note at the middle of the page.
- **Any card's ⋯ menu** (and every row of the prompt list, for deck prompts) has **Send to Obsidian**. Once sent it reads **Update in Obsidian**, which replaces that note's block in place, in the note it was sent to, also after you rename the book, change the folder or move the prompt to a deck (new prompts go to the new name).
- **Send all to Obsidian**, in a book's or deck's ⋯ menu (its row in the library, or the deck page), sends the highlights, notes and prompts of it at once, in reading order (page by page, top to bottom; a deck section by section), to its Obsidian note. It never sends a card twice. Started with the `marginalia` command, cards never sent are added, cards you edited since their last send are updated in place (in the note that holds them), and cards already in Obsidian and not edited since are skipped, unless their last send did not finish: those go again, and the server updates them in place (or adds them once); the confirm first says how many of each and where they go. If an edited card's block is no longer in the note (you deleted it, or changed its comment lines or date line by hand), it is not added again, and its images are not copied into the vault either: the notice lists it and **Copy notes** copies it. With nothing new or edited, nothing is sent and a notice says everything is already in Obsidian. Through `obsidian://` links (the claude.ai copy, a saved file) only the cards never sent go, all in one link, and not those whose send to the `marginalia` server did not finish (they wait for it, see below); when they are too many for one link, they are copied for you to paste into the note. A link cannot update an edited card, and the notice says how many it left as they were, also when the cards are copied instead. After updating Marginalia, run `marginalia restart`: until then a server still running the old code takes only the new cards (one at a time if it is older than Send all) and leaves the edited ones as they are, and the notice asks you to restart.
- Each block sits between two comment lines, `<!-- marginalia:… -->` and `<!-- /marginalia -->` (hidden in Obsidian's reading view); the line just above the closing one is the block's date (with its **Open in Marginalia** link). Text you write outside them is never touched. If you edit the note in Obsidian while Marginalia writes to it (or a sync changes it), your edit is kept: Marginalia reads the note again and puts its blocks in on top of it; if the note keeps changing, the send stops and says so, and you send again. If you delete or change those lines, the date line included, or merge two different blocks into one, the next update cannot be sure where the block ends, so it adds a fresh copy at the end of the note instead of replacing anything (the card's own **Update in Obsidian** does; **Send all** leaves the card out instead and lists it). One exception: two copies of the same block merged into one, with your text between them, look like that one block, so an update replaces them together, your text included (like text typed between a block's own two comment lines).
- **Open in Marginalia** in a block opens the passage in a new browser tab, and the tab that was already open stops saving (see "Run it"). With the Mac app, that browser tab passes the link on to the app, whose window opens the passage (see "Desktop app", "Use it").
- Settings › Obsidian chooses the vault and the folder inside it (default `Notes/Marginalia`). If two of your vault folders have the same name, rename one: Marginalia will not guess which of them to write into.

Started with the `marginalia` command, the app writes straight into the vault, images included, without opening Obsidian (after updating Marginalia, run `marginalia restart` once so the running server has this; while an older server still runs, Settings › Obsidian and the toasts say to run `marginalia restart`, and a page that is already open finds the restarted server on its next send). A note you locked in Finder, made read-only or hard-linked is not rewritten: the send fails and says why, and **Copy note** still copies the block. If the server stops or restarts in the middle of a send, or the connection drops, the page cannot tell whether the note was written: the notice says the card may already be in Obsidian, and offers nothing to copy (pasting it could make a second copy). The next send of those cards goes to that same note, also after you rename the book, change the folder or move a card to a deck, and updates the copy there instead of adding another (or adds it there once, if the lost send never arrived). Marginalia notes this before the send leaves, so it holds even when the tab is closed or reloaded in the middle of it (if the browser cannot save that note, for example on a full disk, nothing is sent). After such an interrupted send, `obsidian://` links (this page while the server is down, or a claude.ai copy or plain file that imported a backup made since, also when that copy had those cards already) leave those cards alone and say so: they wait for the `marginalia` server, which checks the note and never adds a second copy. A backup made after the server settled them clears that in the copy too. While an Import is still saving, nothing is sent to Obsidian (a card it brings may carry such a note of its own): the notice says "Wait until the import finishes, then send again." Opened any other way (the claude.ai copy, a plain file, an older server) it falls back to `obsidian://` links: Obsidian opens and appends the note (a note's first block starts with its title), images become `[image]`, and sending again adds a second copy to the note that holds the first. A block sent from the claude.ai copy or a plain file has only a date, no **Open in Marginalia** link, so the `marginalia` server never replaces it: there, the card's first **Update in Obsidian** (for a prompt that came over in a JSON backup) adds a fresh copy, and later updates, **Send all** too, replace that copy. **Send all** itself never adds that copy: it leaves such an edited card out and lists it among the cards not updated. Cloze braces become `==highlights==`; math keeps `$…$` / `$$…$$`, which Obsidian renders. If the browser blocks the clipboard, the toast offers **Copy note** again.

## Zotero

In the Mac app you can open a PDF from Zotero: right-click an item (or its PDF) in Zotero's item list and choose
**Open in Marginalia**. A new PDF becomes a book; a PDF that is already in your library opens its book. This needs the
small plugin Marginalia for Zotero; `desktop/README.md`, "Zotero", says how to install it. The app also
shows up in Finder's Open With for every PDF.

Zotero then shows which of those items have prompts: while the app runs, such an item gets the tag **Marginalia** (in
Marginalia's red, unless you give it another colour)
and a child link such as "12 prompts in Marginalia". Double-click to open the book in the app. The count includes
Q./A., cloze and notes. The tag and link go when the book has no prompts any more.

## Export and import

Settings › Data, the library footer, or any book or deck menu:

- **JSON backup** of prompts, review history, images and settings (no PDF bytes, no API key; the settings include the "Not alike" marks); a backup of the whole library also carries the folders (see "Folders"). Importing merges by prompt id and keeps review history from both sides. Started with the `marginalia` command, Marginalia also saves one every day by itself (see "Backups").
- **Anki TSV** with Basic and Cloze notes, MathJax delimiters and images.
- **Markdown** in the `Q.` / `A.` syntax.

Book and deck menus also have **Send all to Obsidian** (see "Obsidian").

## Backups

Started with the `marginalia` command, Marginalia saves a **JSON backup** by itself once a day: the same file Export saves (prompts, review history, images, folders and settings; no PDF bytes, no API key). It also keeps a copy of **every PDF**, once each.

- **Where**: `~/Documents/Marginalia Backups`, one file a day named `marginalia-backup-YYYY-MM-DD.json`. Time Machine copies it with the rest of Documents.
- **The PDFs**: in the `PDFs` folder inside it, each PDF once, as a normal PDF file you can open: `<book name> [<the first 12 characters of its SHA-256>].pdf`. The bracket identifies the file's exact content (a SHA-256 hash is a fingerprint of a file's bytes), so renaming a book makes no second copy. After each backup, Marginalia sends the PDFs the folder does not hold yet, one at a time in the background; the daily backup only lists them, so it stays small. A PDF stays as long as any of the 30 kept backups lists it for a book you still have. When you delete a book, its PDF stays for 30 days after the deletion, and longer while an older kept backup still lists the book. After that, only Time Machine has a copy. These 30 days go by the Mac's clock: a clock that is wrong by a month or more can make them shorter. A PDF that could not be saved is mentioned once (a notice, and a red line in Settings › Data); it is tried again with the next backup. Open these files to read them, but keep highlights and notes in a copy elsewhere: a saved PDF that was changed (for example highlights saved into it in Preview) is no longer that book's backup. While this browser still has the book's PDF, the next backup renames the changed file `<book name> [<…>] (changed).pdf` (your changes stay in it, and Marginalia never deletes or uses it again) and saves the book's own PDF once more. A change that keeps the file's size exactly is not noticed until a restore needs that PDF, which then says so.
- **How often**: when Marginalia opens, then every hour while it stays open (and when you come back to its tab), if today has no backup yet and the library is not empty.
- **How many**: the newest 30. Older ones are deleted, and so is a saved PDF that none of the 30 lists for a book you still have or deleted less than 30 days ago (unless it was changed after it was saved: that one is renamed `… (changed).pdf` and kept); nothing else in the folder is touched (and nothing at all is deleted from `PDFs` while one of the 30 cannot be read). A file of your own named like today's backup in other letters (such as `Marginalia-Backup-<date>.json`) is left alone too: that day's backup fails, and the notice names the file.
- **Settings › Data › Automatic backup** shows the folder and the last backup, how many PDFs are saved (`PDFs: 12 saved in ~/Documents/Marginalia Backups/PDFs (340 MB)`), the switch **Back up automatically every day**, and **Back up now**, which saves at once, replaces today's file and sends the missing PDFs. If an automatic backup fails, one notice a day says why, with **Try again**.
- **To restore**: Settings › Data › **Import…**, choose a file from that folder (importing merges by prompt id and keeps review history from both sides). Marginalia then takes each book's PDF from the `PDFs` folder by itself and says "Restored 3 PDFs from your backup folder"; it checks that each one is exactly that book's file (the same SHA-256 hash). It does the same each time it starts, for any book whose PDF is missing. A book whose PDF is not in the folder still says **Choose file again** (Add PDF with the same file works too); so does a book whose saved PDF was changed after it was saved, and the notice names that file.
- **It needs the `marginalia` command**: the claude.ai copy and a saved file cannot save backups by themselves (Settings › Data says so); use **JSON backup** there. After updating Marginalia, run `marginalia restart` once so the running server can save backups (and, since this version, the PDFs); until then Settings › Data asks you to.
- The API key is never in a backup. If a prompt contains the key, no backup is made until you remove it from the prompt.
- There is one file per day: if two browsers (or browser profiles), each with its own library, open Marginalia on the same day, the first backup of the day wins, and **Back up now** replaces it. They share the `PDFs` folder too, so a PDF that only the other library's backups list goes once none of the 30 lists it. A server you start yourself (`python3 -I tools/serve.py`) takes `--backup-dir <absolute folder>` or the `MARGINALIA_BACKUP_DIR` variable. Without either, a test server keeps its backups beside its throwaway vault list: started with `--obsidian-sandbox <folder>`, in `<folder>/Backups`; started with `--obsidian-config <file>` or `MARGINALIA_OBSIDIAN_CONFIG` naming a vault list other than Obsidian's own, in a `Backups` folder beside that file. A server that reads Obsidian's own list (no option, or one that names that list), such as the one the `marginalia` command starts, uses `~/Documents/Marginalia Backups`. A folder inside the app folder is refused.

## Desktop app

Marginalia is a Mac app, `Marginalia.app`. It shows the same Marginalia in its own window and runs its own copy of the server. You need no browser for it.

Why: in a browser, the library is that browser's data for http://127.0.0.1:8765, so the browser's "Clear browsing data" (cookies and site data) deletes it. The app keeps the library in its own folder, which no browser touches.

### Install it

1. Once, install the build tools. In Terminal, in the project folder: `cd desktop && npm ci`
2. Run `marginalia app`. It builds the app, tests it, and installs it as `/Applications/Marginalia.app`. It ends with "Installed Marginalia 1.7.0. Open it with: marginalia".
3. Run `marginalia` to open it. Finder, Spotlight and the Dock open it too.

At its first start, macOS may ask once: "Marginalia would like to access files in your Documents folder". Click **Allow**: your backup folder is in Documents (and so is your Obsidian vault, if you keep one there), and the move below goes through the backup folder. If you clicked Don't Allow, the app's backups, the move and sends to Obsidian fail until you turn it on in System Settings › Privacy & Security › Files and Folders.

The app runs its server on port 8765, the address Obsidian's links use. If the `marginalia` command's own server still runs there, `marginalia` stops it first.

### Move your library from a browser

Do this once, and only if you used Marginalia in a browser before. The app starts with an empty library and shows "Welcome to Marginalia". If you are new, click **Start with an empty library** there and skip this part.

1. Open the app (`marginalia`). If macOS asks whether Marginalia may access files in your Documents folder, click **Allow** (see "Install it").
2. In that browser, open Marginalia (http://127.0.0.1:8765/), or reload its tab. It now shows "Marginalia is now an app". Click **Back up this browser's library**. This saves the library and its PDFs into your backup folder. If there is a backup from today already, it asks first: click **Replace it**. (The app's own library does not change.)
3. In the app, click **Import the newest backup**. The button shows when that backup was made, for example "(today, 09:12)". The app imports it and takes each book's PDF from the backup folder.

Then paste your Anthropic API key again in Settings › LaTeX from snips. Backups never contain the key.

The card has two more buttons. **Import a backup file…** imports any other backup file. **Start with an empty library** hides the card for good. A book whose PDF was not in the backup folder says **Choose file again**.

If your Mac's clock was ever set ahead, the backup folder may hold a backup dated after today. Then **Import the newest backup** would take that file, not the one the browser just saved, so the card does not offer it and says why. The browser's page names the file it saved: click **Import a backup file…** and choose that file (today's) in the backup folder.

Do the move once. Afterwards the browser's page says when its library was backed up for the move, and **Back up this browser's library** asks first ("Back up this browser's library again?"). Click **Cancel**: the app keeps your library now, and a backup from the browser would put the browser's older library in the place of the app's daily backup. Click **Back up again** only if the move did not work.

### Use it

- **Closing the window** keeps Marginalia running in the background. Cmd+Q quits it. Click its Dock icon, or choose Window › Marginalia, to bring the window back.
- **Cmd+W closes a tab.** With one tab left it closes the window (Marginalia keeps running). Window › Close Window is Shift+Cmd+W. See "Tabs".
- **Cmd+N opens a new window.** You can also drag a tab out of its window. One window saves at a time, the one that you use. See "Windows".
- **Open in Marginalia** links in Obsidian notes open in your browser first. The page there passes them on to the app and says "Opening this page in the Marginalia app…". If the browser asks whether to open Marginalia, allow it. If nothing happens, click **Open the app**. The links need the app to be running: after Cmd+Q, open the app first.
- **The commands**: `marginalia stop` quits the app. `marginalia restart` quits it and opens it again. `marginalia status` shows whether it runs and what uses port 8765.
- **Backups and Obsidian** work as with the `marginalia` command: what this README says about Marginalia started with that command holds for the app too (the daily backup, the PDFs, writing straight into your vault).
- **Offline**: the app works without a network, except LaTeX from snips (Claude).
- **Storage**: the app marks its library as persistent storage, so it is not cleared when the disk is nearly full.

### Update it

After a change to Marginalia's code, quit the app (Cmd+Q) and run `marginalia app`. It installs the new version only when the build and the packaged app's self-test pass; otherwise the installed app stays as it was. It does not run the unit tests: run `marginalia test` first for those. Stopping it with Ctrl+C or closing the Terminal window also leaves the installed app and the version before as they were. The version before stays in `desktop/out/previous/Marginalia.app`. To go back to it, quit the app and move that copy back to `/Applications`.

After an update, macOS may ask again, once: "Marginalia would like to access files in your Documents folder" (to macOS, each update is a new app). Click **Allow**: your backups and your Obsidian vault are in Documents. If you clicked Don't Allow, turn it on in System Settings › Privacy & Security › Files and Folders.

**To stop that question**, sign the app with a certificate of your own. You make the certificate once in Keychain Access (steps in `desktop/README.md`, "Signing with your own certificate"), write its name into `desktop/sign-identity`, and run `marginalia app`. macOS then sees each update as the same app: it asks once more, after the first signed update, and then no more. This is not verified yet.

### Where things are

| What | Where |
|---|---|
| the app | `/Applications/Marginalia.app` |
| the app's library, settings and API key | `~/Library/Application Support/Marginalia` (Time Machine copies it) |
| daily backups and the PDFs | `~/Documents/Marginalia Backups` |
| the version before the last update | `desktop/out/previous/Marginalia.app` |
| the browser's library | still in that browser, unchanged |

### What the browser shows now

While the app runs, Marginalia in a browser shows "Marginalia is now an app" over the whole page. Your library in that browser stays as it was. The browser page no longer makes a daily backup and never sends to Obsidian. The page has two buttons: **Open the app**, and **Back up this browser's library** (for the move).

A browser tab that was already open shows this only after a reload. Until then, while the app runs, it cannot save backups or send to Obsidian, and its notices say so. But after you quit the app, such a tab can send to Obsidian again, through `obsidian://` links, and that can add a second copy of a card the app already sent. So once the app is installed, reload or close every browser tab of Marginalia. A tab that shows "Marginalia is now an app" keeps refusing, also while the app is not running.

The browser version still works on a Mac without the app: there `marginalia` starts the server and opens the page as before.

### Differences from a browser

- **Right-click** offers only what Marginalia needs (spelling suggestions, Cut, Copy, Paste, Look Up, Copy Image).
- **A link to another site** opens in your browser, and only from your own click or key press.
- **Cmd+0** only fits the PDF to the width. A browser resets its page zoom at a second Cmd+0; in the app, use View › Actual Size.
- **Chinese, Japanese and Korean PDFs**: some show no text in those languages, in the app and in a browser alike. PDF.js needs its character maps for them, and cdnjs, where Marginalia asks for them, refuses to serve those files. The app skips that request, so such a PDF shows its other text at once. Fixing it means shipping the maps with Marginalia, a decision still to make.

## Development

`marginalia test` runs the unit tests (`node --test`), the cross-reference checks, a headless boot, the server tests (`python3 -I -m unittest discover -s test -p 'test_*.py'`, which use a throwaway vault and a throwaway backup folder in a temp folder; `test/test_command.py` runs a copy of the `marginalia` command in a temp folder with stand-ins for `open`, `osascript`, `lsregister`, `npm` and `pgrep` and free ports, so it never touches the real app or port 8765), then the Mac app's own tests (`node --test` in `desktop/`; see `desktop/README.md`). `test/tabs.test.js` drives two or more tabs of one origin in Node (a shared fake IndexedDB, a BroadcastChannel hub and storage events). `marginalia build` writes `dist/marginalia.html` and the claude.ai artifact build `dist/marginalia-artifact.html`.

`tools/serve.py` serves the app, the Obsidian endpoints (`docs/BUILD-NOTES.md`, "Obsidian"; **Send all** uses `/api/obsidian/notes`) and the backup endpoints ("Automatic backup"): `/api/backup` for the daily JSON backups, `/api/backup/latest` for the newest one, and `/api/backup/pdfs`, `/api/backup/pdf` and `/api/backup/pdf/<sha256>` to list, save and fetch the PDFs of its `PDFs` folder, to this Mac only. The Mac app starts its copy with `--app <version>`: then `/api/app` tells a browser page that the app owns this address, and the server takes writes only from the app's own page (the header `X-Marginalia-Client`; "Desktop app (binding)" in `docs/BUILD-NOTES.md`). It reads Obsidian's vault list from `~/Library/Application Support/obsidian/obsidian.json`, and at start it prints the list it reads, the vaults it found and the backup folder. To try sends without touching your vault, run a second server on another port with a throwaway vault and a throwaway backup folder: `python3 -I tools/serve.py --port 8791 --obsidian-sandbox /tmp/marginalia-sandbox --backup-dir /tmp/marginalia-sandbox/backups` creates `Sandbox Vault` there and writes only into it; it refuses a folder that already holds another `obsidian.json`, and Obsidian's own settings folder. Without `--backup-dir`, a sandbox server keeps its page's backups in the sandbox folder too (`/tmp/marginalia-sandbox/Backups` here), and a test server started with `--obsidian-config` (or `MARGINALIA_OBSIDIAN_CONFIG`) naming a test `obsidian.json` (any list other than Obsidian's own) keeps them in a `Backups` folder beside that file, never in your real `~/Documents/Marginalia Backups`. Naming Obsidian's own list is the same as naming none: your real vault and your real backup folder. `--obsidian-config <obsidian.json>` or the `MARGINALIA_OBSIDIAN_CONFIG` variable point it at any other test `obsidian.json`; a blank value, or a file that lists no vault folder that exists, stops the server instead of falling back to your real list. A test page still falls back to `obsidian://` links, which reach your real Obsidian, once its test server stops answering (or its `Sandbox Vault` folder is gone), so tests replace the opener (`M.obsidian._setOpener`). The `marginalia` server on 8765 always writes into your real vault and your real backup folder. `marginalia stop` and `marginalia restart` let a write in progress finish first (at most 2 seconds), so no half-written temp file is left in the vault or the backup folder.

Pure modules (`scheduler`, `prompts`, `context`, `keys`, `layout`, `anchors`, `markup`, `exporter`) load in Node without a DOM. `docs/SPEC.md` is the specification, `docs/BUILD-NOTES.md` the binding overrides, `docs/DECISIONS.md` the design decisions. The scheduler is a port of Orbit's (Andy Matuschak, Apache-2.0).
