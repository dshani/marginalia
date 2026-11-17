#!/usr/bin/env python3
"""Serve the Marginalia app folder on 127.0.0.1 (started by bin/marginalia, or by the Marginalia desktop app as its
child with --app; .claude/launch.json only attaches to it).

Every file response carries Cache-Control: no-cache, so the browser re-checks each file and an edited script or
stylesheet shows up on the next reload (plain `python3 -m http.server` sends no cache header, and browsers
then keep stale copies).

  python3 -I tools/serve.py [--port 8765] [--bind 127.0.0.1] [--dir <app folder>]
                            [--obsidian-config <obsidian.json> | --obsidian-sandbox <folder>]
                            [--backup-dir <absolute folder>] [--app <version>]

At start it prints the address (the real port, also with --port 0), the obsidian.json it reads with the vaults it
found there, and the backup folder (and, with --app, a fourth line naming the app). SIGTERM (`marginalia stop`,
`marginalia restart`, the desktop app quitting) first lets a note, image or
backup write in progress finish (at most STOP_WAIT seconds in all) and removes the temp file of a PDF upload it cuts
off, so a stop never leaves a partial temp file in the vault, the backup folder or its PDFs folder.

Obsidian (BUILD-NOTES "Obsidian"): three JSON endpoints let the page write notes straight into an Obsidian vault.

  GET  /api/obsidian/vaults  -> {"vaults": [{"id", "name", "open", "attachmentFolder"}], "replaceOnly": true}
       The vaults Obsidian lists in obsidian.json (--obsidian-config, else MARGINALIA_OBSIDIAN_CONFIG, else
       ~/Library/Application Support/obsidian/obsidian.json); a vault whose folder is missing is left out, one entry
       per name, and no absolute path is ever sent. "replaceOnly": true says that this server's /notes honours a
       block's "replaceOnly" (below): a serve.py from before it ignores that field and adds such a block when the note
       no longer holds it, so a page must not send one there. --obsidian-sandbox <folder> is for test servers: it
       creates (when missing) a throwaway vault <folder>/Sandbox Vault and <folder>/obsidian.json naming only that
       vault, and uses it.
       Fail-closed options: a blank --obsidian-config, --obsidian-sandbox or MARGINALIA_OBSIDIAN_CONFIG stops the
       server (a request never falls back to Obsidian's own list from a blank value); so does a file one of them names
       that lists no vault whose folder exists (else the page would fall back to obsidian:// links, which reach the
       real Obsidian). The sandbox refuses a folder inside a vault, Obsidian's own settings folder (or one inside it),
       a symlinked Sandbox Vault, and a folder whose obsidian.json it did not write (only its own one-vault listing is
       ever rewritten).
  POST /api/obsidian/note    {vault, file, title, blockId, markdown, images: [{name, data}]}
       Upserts one block (<!-- marginalia:<blockId> --> ... <!-- /marginalia -->) in <vault>/<file>: the block is
       replaced only where the note provably holds that one block (find_block: its exact start-marker line, then
       its exact end-marker line before any other marker-like line, with exactly one date line, the line right
       before the end marker, and that date line the block's own: the link to this blockId when the new block has its
       "Open in Marginalia" link, as every block the app sends here does, else the date alone; markers inside code
       fences are not markers, and a fence that is never closed is not a fence), else appended after one blank line,
       so a block whose markers were edited or deleted by hand, or two different blocks merged by hand, never take the
       user's text or the next blocks with them (two copies of the SAME block merged into one span read as that one
       block, so text between them is replaced, like text typed inside a block's own markers); a new file starts with
       "# <title>". Images are written to the vault's
       attachment folder (attachmentFolderPath in <vault>/.obsidian/app.json) only when no file of that name exists.
       Every write is atomic (a temp file in the same folder, then os.replace; the note's mode, and on macOS its
       extended attributes such as Finder tags, carried over; not its ACL or creation date); nothing else in
       the note is removed or changed. A note that is read-only (or locked), or hard-linked, is not rewritten (409),
       and neither is a vault name that two vaults share (409). The note is replaced only while it is still exactly
       what was read (note_unchanged, right before the replace): a save that lands while the new text is made (an
       edit in Obsidian, a sync) is read in and the text made again, NOTE_TRIES times in all, then 409 (the note is
       left as it is), so such a save is never overwritten.
       -> {"ok": true, "file", "created", "replaced"}; errors {"ok": false, "error"} (4xx/5xx, also for text that is
       not valid Unicode and for anything unexpected).
  POST /api/obsidian/notes   {vault, file, title, blocks: [{blockId, markdown, replaceOnly?}], images: [{name, data}]}
       "Send all to Obsidian": many blocks into one note in one request, at most MAX_BLOCKS blocks and MAX_NOTES_BODY
       bytes. The request gets the checks of /note (vault, file, images: a failure refuses it all), and so does every
       block (blockId, valid Unicode, check_block, and "replaceOnly", when present, true or false): a block that fails
       them is reported and skipped. Two blocks with one blockId, or no valid block at all, refuse the request (400,
       nothing written). The note is read once (again only when another app saves it meanwhile, as /note), the blocks
       are upserted in their order in memory with exactly the result of one /note request after another
       (upsert_blocks, in time linear in the note and the blocks), and the note is written once: atomic, CRLF, byte
       order mark, mode and extended attributes kept, a read-only or hard-linked note refused (409), as /note. A new
       note starts with "# <title>". Images as /note, except those of a block left out (below).
       "replaceOnly": true (an edited card sent before, BUILD-NOTES "Send all"): the block only ever replaces its own
       earlier copy, the span find_block claims in the note as the blocks before it left it. When there is none (the
       copy was deleted, or its markers or date line were edited by hand, or it was sent through an obsidian:// link,
       whose date line a linked block cannot claim), the block is neither added nor written: its result is
       {"blockId", "ok": false, "notFound": true, "error": EARLIER_COPY_GONE}, and the note never holds a second copy
       of it. Its images are not written either, also when other blocks of the request go in: an image that left-out
       blocks embed (its name, as IMAGE_NAME_RE finds it in their Markdown: ![[name]]) is written only when a block
       that goes in embeds it too; one that no block embeds is written, as /note writes it. When no block of the
       request changes the note (every valid one such a block), nothing at all is written: no note (none is created),
       no folder, no image -> 200 with "created": false.
       -> {"ok": true, "file", "created", "results": [{"blockId", "ok": true, "replaced"} |
           {"blockId", "ok": false, "error"} | {"blockId", "ok": false, "notFound": true, "error"}, one per block in
           the request's order]}; with no valid block the 400 answer carries the same "results". The single /note
           never reads "replaceOnly": it adds a block it does not find, as it always has.

Backups (BUILD-NOTES "Automatic backup"): the page's JSON backup, once a day, into a folder on this Mac.
  The folder: --backup-dir <absolute folder>, else MARGINALIA_BACKUP_DIR, else, for a test server started with
  --obsidian-sandbox <folder>, <folder>/Backups (beside its throwaway vault: a test page never backs up into the
  user's folder), else, for a server that reads a vault list other than Obsidian's own (--obsidian-config, else
  MARGINALIA_OBSIDIAN_CONFIG, naming another file than ~/Library/Application Support/obsidian/obsidian.json), a
  "Backups" folder beside that obsidian.json (a test library's backup in the user's folder could take the day's file
  name, and the user's own automatic backup would then skip that day), else ~/Documents/Marginalia Backups: the
  user's own server (no Obsidian option, or one that names Obsidian's own list) keeps that folder. A blank or relative
  value stops the server at start, and so does the served app folder (--dir) or a folder inside it (the static server
  must never serve a backup), and a folder beside a vault list inside Obsidian's own settings folder (Marginalia never
  writes there). The third start line names the folder. Nothing is created at start: the folder is made (0700) by the
  first backup. make_server(backup_dir=None), as the tests and other embedders call it, has no backup folder:
  /api/backup then answers 404, like a serve.py from before backups, so no test server can reach the real folder by
  accident.
  GET  /api/backup -> {"ok": true, "dir": "<the folder, ~ for the home folder>", "today": "YYYY-MM-DD" (this Mac's
       local date), "files": [{"name", "date", "bytes"}]}, newest first: only regular files (not symlinks, not
       folders) whose whole name is marginalia-backup-YYYY-MM-DD.json (BACKUP_NAME_RE, ASCII digits); nothing else in
       the folder is ever listed. A folder that cannot be read: 500 {"ok": false, "error"}.
  POST /api/backup {"mode": "auto"|"manual", "backup": <the exporter's JSON backup>}, at most MAX_BACKUP_BODY bytes.
       "backup" must look like one: format "marginalia", an integer version, "collections" and "prompts" lists,
       "attachments" a list when present (else 400). The server names the file, marginalia-backup-<today>.json, and
       writes the backup's own JSON text exactly as the request carries it (the page sends the text Export saves, so
       the file is that very file). "auto" never replaces a file that exists for today (-> "skipped": true, nothing
       written); "manual" replaces it. The write is atomic: a temp file in the folder, then a link that cannot replace
       anything for "auto" (os.replace where the disk has no hard links) or os.replace for "manual"; mode 0600. A
       folder or symlink that has today's name is never replaced (409), and neither is a file whose name is today's in
       other letters, such as Marginalia-Backup-<today>.json, which a disk that ignores letter case (macOS's default)
       reaches through today's name (check_todays_name: 409 for both modes). Then the BACKUP_KEEP (30) newest backups
       by the date in their names are kept and older ones deleted: only regular files whose names match
       BACKUP_NAME_RE, never the file just written, never any other file. Then the PDFs that no kept backup lists go
       (prune_pdfs, "PDFs" below); that prune never changes the answer.
       -> {"ok": true, "file", "bytes", "skipped", "pruned": [names]} (a skip: the size of today's file, pruned []).

PDFs (FEATURES B9): the library's PDFs, each saved once as a normal PDF file in the backup folder's "PDFs" folder; the
  daily JSON backup lists each book's sha256 among its collections, and a PDF stays while a kept backup lists it for a
  live book, or for a book deleted less than DELETED_PDF_DAYS (30) days ago (D23; Prune below). The routes answer
  404 without a backup folder (make_server(backup_dir=None)). A saved PDF is a regular file (never a symlink or a
  folder) in PDFs/ whose whole name is "<book name> [<sha12>].pdf" (PDF_FILE_RE: sha12 is the first 12
  hex digits of the SHA-256 of its content, in lower case, then ".pdf" in lower case; never a name that starts with a
  dot); nothing else in PDFs/ is ever listed, sent, replaced or deleted. A "PDFs" that is a symlink or not a folder is
  never used: 500 for every route, and the prune deletes nothing.
  A saved PDF changed after it was saved (opened and saved in another app: Preview saving highlights into it, say)
  keeps its name but no longer holds what its name says (repair B9-R2). The listing goes by name and still lists it;
  the bytes are never sent from it; an upload of that PDF and the prune hash it and rename it aside (set_aside_pdf) to
  "<book name> [<sha12>] (changed).pdf" ("(changed 2)" and so on while a name is taken; aside_name), a name that never
  matches PDF_FILE_RE, so from then on that file is the user's: never listed, sent, replaced or deleted. The rename
  never replaces anything (a hard link, then the old name removed; os.rename while the name is free on a disk without
  hard links), and the server log names both names.
  GET  /api/backup/pdfs -> {"ok": true, "dir": "<the backup folder, as GET /api/backup shows it; the PDFs are in its
       PDFs folder>", "files": [{"sha12", "name", "bytes"}]}, by name. A missing folder lists none; one that cannot be
       read: 500 {"ok": false, "error"}.
  POST /api/backup/pdf, the body = a PDF's bytes, Content-Type application/pdf, X-Marginalia-Sha256: <its SHA-256, 64
       hex digits, either case> (else 400, before the body is read), X-Marginalia-Name: <the book's name,
       percent-encoded UTF-8>, at most MAX_PDF_BODY (300 MB, the app's own limit; 413 before the body is read). The
       backup folder and PDFs/ are made when missing (0700); the body is read in PDF_CHUNK pieces, never whole, into
       a temp file in PDFs/ while it is hashed; it must hash to the header's SHA-256 and hold "%PDF-" within its first
       1 KB (as js/library.js checks a PDF it adds), else 400. Then, one at a time (BACKUP_LOCK), every saved PDF
       whose name ends in " [<its sha12>].pdf" (whatever the book name: a renamed book) is hashed (verified_pdf): when
       one holds exactly that content, nothing is written -> "skipped": true with that file's name and size; one whose
       content no longer has its own name's sha12 is set aside first (above; 500, nothing written, when it cannot be
       renamed). Else the temp file (fsync'd, 0600) gets the name "<book name> [<sha12>].pdf" through a hard link,
       which never replaces anything (os.replace, while the name is free, on a disk without hard links); a file that
       took that name meanwhile is hashed in turn (that content: skipped; another: set aside, and the link tried once
       more). The book name is pdf_book_name(): the rule js/obsidian.js applies to a note's name (no path separator, no
       control character, no leading dot), at most 120 characters and 150 bytes, one trailing ".pdf" left out,
       "Untitled" when empty. A folder, a symlink or a file in other letters that holds that name: 409, nothing
       written. The temp file never stays behind (a failure removes it; so does a SIGTERM).
       -> {"ok": true, "file", "bytes", "skipped"}, plus "setAside": [{"name", "as"}] (the old and the new name of each
       saved PDF set aside on the way) when there are some.
  GET  /api/backup/pdf/<SHA-256, 64 hex digits> -> the saved PDF's bytes (application/pdf). The server hashes a saved
       PDF with that sha12 before it answers and sends it only when its content has that very SHA-256 (one that does
       not is logged and never sent; the next one with that sha12 is tried), else 404 {"ok": false, "error"}, plus
       "changed": [the names of the saved PDFs with that sha12 whose content is not that PDF] when there are some (a
       GET renames nothing); never through a symlink. It hashes the bytes again as they stream and holds the last piece back until they prove the
       same, so a file that changes meanwhile never reaches the client whole (the connection is closed). A browser
       request that another site made (Sec-Fetch-Site other than same-origin, or none for an address typed in) gets
       403: no other site can even tell a saved PDF from a missing one.
  Prune (prune_pdfs), after each backup POST /api/backup writes (never after a skip), still under BACKUP_LOCK: the
  sha256s that every kept backup lists (each backup file the JSON prune leaves, the one just written included) for a
  live collection or for a tombstone deleted less than DELETED_PDF_DAYS (30) days ago (collection_sha12s; an older
  tombstone lists nothing, so a deleted book's PDF goes with the first backup written 30 days after the deletion,
  or later while an older kept backup lists the book alive: D23) are gathered, and each saved PDF whose sha12 none
  lists is hashed, then deleted when its content still has that sha12 (checked again with lstat right before: never
  a symlink); one changed after it was saved is set aside instead (above), one that cannot be read stays. When any
  kept backup cannot be read or parsed as a Marginalia backup, or PDFs is not a folder, nothing at all is deleted
  and the server log says why; the log also names the PDFs deleted and set aside.

The desktop app (FEATURES E2.1; BUILD-NOTES "Desktop app"): only the Marginalia app passes --app <version>, its own
  version, digits.digits.digits in ASCII (APP_VERSION_RE; anything else, a blank value too, stops the server at start
  with exit 2, as argparse refuses any bad option). The server then belongs to the app's page:
  GET  /api/app -> {"ok": true, "app": true, "version": "<version>"} (no-store, nosniff) with --app; without it 404
       {"ok": false, "error": "not found"}, exactly as an unknown route (and as a serve.py from before the app). A
       browser page on 127.0.0.1 or localhost that gets "app": true covers itself ("Marginalia is now an app").
  With --app every POST route needs the header X-Marginalia-Client: app (CLIENT_HEADER, APP_CLIENT: the app's page
       sends it); POST /api/backup and POST /api/backup/pdf also take X-Marginalia-Client: browser-move (MOVE_CLIENT:
       a covered browser page's "Back up this browser's library", the move into the app). Any other value, or none,
       gets 409 {"ok": false, "error": "app_only", "message": APP_ONLY_MESSAGE}: checked after the guards below (the
       route, Origin, X-Marginalia, Content-Type, Content-Length and its limit) and before the body is read or any
       other header is looked at, so nothing is written and no folder is made. So a browser tab still running older
       code never writes a backup or sends a card next to the app's library (Obsidian's never-twice rule depends on
       one library sending). Without --app the header is ignored. GET routes take no such header.
  GET  /api/backup/latest (with or without --app) -> the newest kept backup file, the one GET /api/backup lists first
       (the page's "last"), byte for byte as it is on disk: Content-Type application/json; charset=utf-8,
       Content-Length, nosniff, no-store and X-Marginalia-Backup-Name: <its file name>; 404 {"ok": false, "error":
       "no_backup"} when there is none: an empty or missing folder, or a server without a backup folder
       (make_server(backup_dir=None)). The file is opened without following a symlink and must be a regular file
       (open_regular; else 500, nothing sent), and is streamed in PDF_CHUNK pieces (never read whole; a file that gets
       shorter meanwhile is cut off, the connection closed). Guards: loopback client, Host, and the Sec-Fetch-Site rule
       of GET /api/backup/pdf/<sha256> (another site: 403, before the folder is read). The app's welcome card imports
       it ("Import the newest backup").

Security: the API answers loopback clients only (started with --bind 0.0.0.0 the app is reachable from the network,
the vault and the backups are not); only GET and POST, only on those paths (anything else under /api/ is 404; no
OPTIONS, no CORS headers, so no other site can make the browser send these requests); the Host header must be
127.0.0.1:<port> or localhost:<port> (DNS rebinding); a POST also needs Origin http://127.0.0.1:<port> or
http://localhost:<port>, X-Marginalia: 1 and Content-Type application/json (application/pdf for /api/backup/pdf), and
at most 25 MB of body (/note; 100 MB for /notes, 512 MB for /api/backup, 300 MB for /api/backup/pdf, refused before
the body is read), and, with --app, X-Marginalia-Client (above); GET /api/backup/pdf/<sha256> and GET
/api/backup/latest also refuse a request another site made (Sec-Fetch-Site); the vault must be one obsidian.json
names; the
file must be a relative .md path without "..", backslashes, control characters or a leading "/" whose real path
(symlinks resolved) stays inside the vault; image names must be exactly marginalia-<id>.<png|jpg|jpeg|gif|webp> and
land inside the vault too. The marker pattern takes linear time, also on a long run of spaces after "<!--" (it once
took seconds and held up the whole server). API responses carry Cache-Control: no-store.
"""
import argparse
import base64
import binascii
import bisect
import errno
import functools
import hashlib
import http.server
import ipaddress
import json
import os
import re
import signal
import stat
import sys
import tempfile
import threading
import time
import traceback
import urllib.parse

API_PREFIX = "/api/"
VAULTS_PATH = "/api/obsidian/vaults"
NOTE_PATH = "/api/obsidian/note"
NOTES_PATH = "/api/obsidian/notes"
BACKUP_PATH = "/api/backup"
LATEST_PATH = "/api/backup/latest"      # GET: the newest kept backup file, as it is on disk
APP_PATH = "/api/app"                   # GET: the desktop app's server says so (--app); 404 without it
APP_VERSION_RE = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+")   # --app VERSION, fullmatch(): ASCII digits only
CLIENT_HEADER = "X-Marginalia-Client"   # with --app, every POST says which page sends it:
APP_CLIENT = "app"                      # the desktop app's own page (every POST route)
MOVE_CLIENT = "browser-move"            # a covered browser page backing up its library for the move (backup routes)
APP_ONLY = "app_only"                   # the 409's "error" for any other POST while the server belongs to the app
APP_ONLY_MESSAGE = "Marginalia is now an app. Open the Marginalia app to do this."
NO_BACKUP = "no_backup"                 # GET /api/backup/latest's 404 "error"
CONFIG_ENV = "MARGINALIA_OBSIDIAN_CONFIG"
BACKUP_ENV = "MARGINALIA_BACKUP_DIR"
MAX_BODY = 25 * 1024 * 1024             # POST /api/obsidian/note
MAX_NOTES_BODY = 100 * 1024 * 1024      # POST /api/obsidian/notes
MAX_BLOCKS = 2000                       # blocks in one POST /api/obsidian/notes
MAX_BACKUP_BODY = 512 * 1024 * 1024     # POST /api/backup (the exporter imports at most this much)
BACKUP_KEEP = 30                        # the newest backups kept
DELETED_PDF_DAYS = 30                   # a deleted book's saved PDF stays at least this long after the deletion (D23)
DAY_MS = 24 * 60 * 60 * 1000            # one day in milliseconds, as a page's Date.now() counts
BACKUP_FORMAT = "marginalia"            # the "format" of the exporter's JSON backup
BACKUP_NAME_RE = re.compile(r"marginalia-backup-\d{4}-\d{2}-\d{2}\.json", re.A)   # fullmatch(), ASCII digits only
# The library's PDFs, each saved once beside the backups (FEATURES B9; "PDFs" in the docstring above).
PDFS_PATH = "/api/backup/pdfs"          # GET: the saved PDFs
PDF_PATH = "/api/backup/pdf"            # POST: save one PDF; GET PDF_PATH + "/<sha256>": a saved PDF's bytes
PDF_FOLDER = "PDFs"                     # <backup folder>/PDFs
MAX_PDF_BODY = 300 * 1024 * 1024        # POST /api/backup/pdf: the app's MAX_DOC_BYTES (js/library.js, js/store.js)
PDF_NAME_MAX = 120                      # characters of the book name in a saved PDF's name (js/obsidian.js NAME_MAX)
PDF_NAME_BYTES = 150                    # and its UTF-8 bytes: a whole name stays well below a disk's 255
PDF_SNIFF = 1024                        # "%PDF-" within the first 1 KB, as js/library.js looksLikePdf checks a PDF
PDF_CHUNK = 1 << 20                     # bytes read, hashed and written at a time: a PDF is never held whole
SHA256_RE = re.compile(r"[0-9a-fA-F]{64}")                             # fullmatch()
# A saved PDF's whole name (fullmatch): "<book name> [<the first 12 hex digits of its SHA-256>].pdf", lower-case hex
# and ".pdf", never a name that starts with a dot (ours never do; macOS's "._" companion files on other disks do).
PDF_FILE_RE = re.compile(r"(?!\.).* \[([0-9a-f]{12})\]\.pdf", re.S)
# A saved PDF whose content was changed after it was saved (Preview saving highlights into it, say) is renamed
# "<book name> [<sha12>] (changed).pdf" ("(changed 2)" and so on while a name is taken; aside_name): a name that never
# matches PDF_FILE_RE, so that file is the user's from then on, never listed, sent or deleted (repair B9-R2).
PDF_ASIDE = "changed"
PDF_ASIDE_TRIES = 100                   # "(changed)" … "(changed 100)": then the rename is given up
FILE_NAME_BYTES = 255                   # the longest file name a macOS disk takes, in bytes of UTF-8
# A book name in a saved PDF's name follows js/obsidian.js cleanSegment, the rule for Obsidian note names:
# JavaScript's \s (NAME_SPACE: Python's \s differs) made one space, the characters it drops (path separators,
# Obsidian and link syntax, control characters), spaces and dots trimmed at both ends (str.strip: once whitespace is
# one space, its trim is exactly that, in linear time), and a run of dots inside made one "…".
NAME_SPACE = r"\t\n\x0b\x0c\r \xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
NAME_SPACE_RE = re.compile(r"[%s]+" % NAME_SPACE)
NAME_FORBIDDEN_RE = re.compile(r'[\\/:*?"<>|#^\[\]\x00-\x1f\x7f-\x9f]')
NAME_DOTS_RE = re.compile(r"\.{2,}")
MAX_TITLE = 200
SANDBOX_VAULT = "Sandbox Vault"
SANDBOX_BACKUPS = "Backups"             # --obsidian-sandbox <folder>: the test server's backups go to <folder>/Backups;
                                        # a vault list of a test's own: to this folder beside it (startup_backup)
NOTE_TRIES = 3                          # a note saved by another app during an update is read again, at most so often
NOTE_CHANGED = ("the note kept changing while Marginalia was updating it (an edit in Obsidian, or a sync), so it was "
                "left as it is; send again")
EARLIER_COPY_GONE = "its earlier copy is no longer in the note"   # /notes: a replaceOnly block the note does not hold
# Whole-string rules, always checked with fullmatch() ("$" alone would also take a name that ends in a newline).
# IMAGE_NAME_RE.findall() also lists the image names a block embeds (write_notes: the images of a block left out).
IMAGE_NAME_RE = re.compile(r"marginalia-[A-Za-z0-9_-]{1,80}\.(?:png|jpe?g|gif|webp)")
BLOCK_ID_RE = re.compile(r"[A-Za-z0-9_-]{1,128}")
CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")
END_MARKER = "<!-- /marginalia -->"
END_LINE_RE = re.compile(r"<!-- /marginalia -->[ \t]*")
# Every place a block's start-marker text "<!-- marginalia:<blockId> -->" occurs, as str.find() finds it for one id
# (such texts cannot overlap): upsert_blocks finds them for all the ids of a request in one pass.
START_ANY_RE = re.compile(r"<!-- marginalia:([A-Za-z0-9_-]+) -->")
# Anything on a line that reads like a block marker, in any case or spacing, indented or with text around it: a span
# with one of these between a block's start and its end is never replaced (the client writes them as "&lt;!--").
# ASCII rules (re.A) here and in DATE_LINE_RE: JavaScript's \s and /i match at least as much, and its \d is [0-9], so
# js/obsidian.js always guards at least what the server checks. The same lines as <!--\s*/?\s*marginalia, written so
# that a long run of spaces after "<!--" costs linear time (two \s* around an optional "/" split a run every way).
LOOSE_MARKER_RE = re.compile(r"<!--\s*(?:/\s*)?marginalia", re.I | re.A)
# A block's last line before its end marker: "[Open in Marginalia](<link>) · 2026-11-06", or the date alone.
DATE_LINE_RE = re.compile(r"(?:\[Open in Marginalia\]\([^)\r\n]*\) \u00b7 )?\d{4}-\d{2}-\d{2}[ \t]*", re.A)
LINK_LABEL = "[Open in Marginalia]("
# CommonMark code fences: up to three spaces, then ``` or ~~~ (a backtick fence's info string has no backtick); the
# fence closes at a line of the same character, at least as long, with nothing after it, or never.
FENCE_OPEN_RE = re.compile(r" {0,3}(`{3,}|~{3,})([^\n]*)")
FENCE_CLOSE_RE = re.compile(r" {0,3}(`{3,}|~{3,})[ \t]*")
# A line that can open or close a code fence starts with this (fenced() then reads it with FENCE_OPEN_RE and
# FENCE_CLOSE_RE): FenceIndex finds those lines without reading every line of the note.
FENCE_HEAD_RE = re.compile(r" {0,3}(?:`{3}|~{3})")
FENCE_AFTER_NL_RE = re.compile(r"\n {0,3}(?:`{3}|~{3})")
JSON_SPACE_RE = re.compile(r"[ \t\n\r]*")
NOTE_LOCK = threading.Lock()   # one upsert at a time: two sends to one note must not interleave; every vault write
                               # runs under it, so holding it means no write is half-done (stop_after_writes)
BACKUP_LOCK = threading.Lock() # the same for the backup folder: one backup (and its prune) at a time, and one PDF put
                               # in place at a time (a PDF upload streams its body without it)
STOP_WAIT = 2.0                # seconds a SIGTERM waits for both (bin/marginalia waits 3 s for the server to end)
PDF_TEMPS = set()              # the temp files of PDF uploads under way: a SIGTERM removes them (stop_after_writes)
PDF_TEMPS_LOCK = threading.Lock()


def default_config_path():
    return os.path.join(os.path.expanduser("~"), "Library", "Application Support", "obsidian", "obsidian.json")


def default_backup_dir():
    return os.path.join(os.path.expanduser("~"), "Documents", "Marginalia Backups")


class ApiError(Exception):
    """An API request that is answered with {"ok": false, "error": message} and `status` (plus the fields of `extra`,
    such as the per-block "results" of a /notes request that had no valid block)."""

    def __init__(self, status, message, extra=None):
        super().__init__(message)
        self.status = status
        self.message = message
        self.extra = extra


# --- vaults ---------------------------------------------------------------------------------------------------------

def read_json(path):
    try:
        with open(path, "rb") as f:
            return json.loads(f.read().decode("utf-8"))
    except (OSError, ValueError, UnicodeDecodeError):
        return None


def attachment_setting(vault_path):
    """attachmentFolderPath of <vault>/.obsidian/app.json, or "/" (the vault root, Obsidian's default)."""
    app = read_json(os.path.join(vault_path, ".obsidian", "app.json"))
    value = app.get("attachmentFolderPath") if isinstance(app, dict) else None
    return value if isinstance(value, str) and value.strip() else "/"


def all_vaults(config_path):
    """Every vault of obsidian.json whose folder exists, the open ones first, then the most recently used:
    [{"id", "name", "path", "open", "ts"}], two with one folder name included. A missing or broken config gives []."""
    data = read_json(config_path) if config_path else None
    vaults = data.get("vaults") if isinstance(data, dict) else None
    if not isinstance(vaults, dict):
        return []
    found = []
    for vid, v in vaults.items():
        if not isinstance(v, dict):
            continue
        path = v.get("path")
        if not isinstance(path, str) or not os.path.isabs(path) or not os.path.isdir(path):
            continue
        name = os.path.basename(os.path.normpath(path))
        if not name:
            continue
        ts = v.get("ts")
        found.append({"id": str(vid), "name": name, "path": path, "open": v.get("open") is True,
                      "ts": ts if isinstance(ts, (int, float)) and not isinstance(ts, bool) else 0})
    found.sort(key=lambda x: (not x["open"], -x["ts"], x["id"]))
    return found


def load_vaults(config_path):
    """Vaults of obsidian.json whose folder exists, one per name (the open one, else the most recently used),
    sorted by name: [{"id", "name", "path", "open", "ts"}]. A missing or broken config gives []. (A note is never
    written into a name that two vaults share: see write_note.)"""
    seen, out = set(), []
    for v in all_vaults(config_path):
        if v["name"] in seen:
            continue
        seen.add(v["name"])
        out.append(v)
    out.sort(key=lambda x: (x["name"].lower(), x["name"]))
    return out


def public_vaults(config_path):
    return [{"id": v["id"], "name": v["name"], "open": v["open"], "attachmentFolder": attachment_setting(v["path"])}
            for v in load_vaults(config_path)]


SANDBOX_ID = "marginalia-sandbox"


def is_or_inside(path, folder):
    """True when the absolute real path `path` is `folder` or lies inside it (either may be missing; the same folder
    in another letter case counts, as on macOS's case-insensitive disks)."""
    target = os.path.realpath(folder)
    up = path
    while True:
        try:
            if os.path.samefile(up, target):
                return True
        except OSError:
            if up.lower() == target.lower():
                return True
        parent = os.path.dirname(up)
        if parent == up:
            return False
        up = parent


def is_sandbox_listing(config, vault):
    """True when the file `config` is exactly what make_sandbox writes for `vault`: only "vaults", holding only the
    entry SANDBOX_ID whose path is `vault`. Anything else (Obsidian's own list, a hand-made test list, an edited
    sandbox list, a symlink, a folder, broken JSON) is a file the sandbox did not write."""
    if os.path.islink(config):
        return False
    data = read_json(config)
    if not isinstance(data, dict) or set(data) != {"vaults"} or not isinstance(data["vaults"], dict):
        return False
    entry = data["vaults"].get(SANDBOX_ID)
    return (set(data["vaults"]) == {SANDBOX_ID} and isinstance(entry, dict) and isinstance(entry.get("path"), str)
            and os.path.realpath(entry["path"]) == os.path.realpath(vault))


def make_sandbox(folder):
    """A throwaway vault for test servers (--obsidian-sandbox): <folder>/Sandbox Vault with its .obsidian/app.json
    (created when missing) and <folder>/obsidian.json naming only that vault (written at every start). -> the
    obsidian.json path. A test page stays in server mode only while this server answers and that vault folder exists:
    once the server stops, the page falls back to obsidian:// links like any other page (so does a page that checks
    again after the folder was removed, which empties the vault list), and those links reach the real Obsidian, which
    writes into the vault it has open. So a test always replaces the opener (M.obsidian._setOpener).
    Refuses (ValueError), before writing anything: a folder inside an existing vault; Obsidian's own settings folder
    (the folder of default_config_path()) or a folder inside it; a "Sandbox Vault" that is a symlink; and a folder
    whose obsidian.json is not the sandbox's own listing (is_sandbox_listing), so it never replaces a vault list it
    did not write."""
    root = os.path.realpath(os.path.abspath(folder))
    up = root
    while True:
        if os.path.isdir(os.path.join(up, ".obsidian")):
            raise ValueError("%s is inside the Obsidian vault %s; choose a folder outside every vault" % (root, up))
        parent = os.path.dirname(up)
        if parent == up:
            break
        up = parent
    obsidian_folder = os.path.dirname(default_config_path())
    if is_or_inside(root, obsidian_folder):
        raise ValueError("%s is Obsidian's own settings folder (%s); choose an empty folder of your own"
                         % (root, obsidian_folder))
    vault = os.path.join(root, SANDBOX_VAULT)
    if os.path.islink(vault):
        raise ValueError("%s is a symlink; the sandbox vault must be a real folder" % vault)
    config = os.path.join(root, "obsidian.json")
    if os.path.lexists(config) and not is_sandbox_listing(config, vault):
        raise ValueError("%s already exists and is not a sandbox's own vault list, so it is left as it is; "
                         "choose an empty folder" % config)
    os.makedirs(os.path.join(vault, ".obsidian"), exist_ok=True)
    app = os.path.join(vault, ".obsidian", "app.json")
    if not os.path.exists(app):
        settings = {"attachmentFolderPath": "Attachments", "newFileFolderPath": "Notes"}
        atomic_write(app, (json.dumps(settings, indent=2) + "\n").encode("utf-8"))
    listing = {"vaults": {SANDBOX_ID: {"path": vault, "ts": int(time.time() * 1000), "open": True}}}
    atomic_write(config, (json.dumps(listing, indent=2) + "\n").encode("utf-8"))
    return config


# --- paths ------------------------------------------------------------------------------------------------------------

def inside(root_real, path_real):
    try:
        return os.path.commonpath([root_real, path_real]) == root_real and path_real != root_real
    except ValueError:
        return False


def note_target(vault_real, rel):
    """The real path of the note `rel` inside the vault, or ApiError."""
    if not isinstance(rel, str) or not rel:
        raise ApiError(400, "file is required")
    if CONTROL_RE.search(rel) or "\\" in rel or ".." in rel or rel.startswith("/"):
        raise ApiError(400, "file must be a relative path inside the vault")
    if not rel.endswith(".md") or rel == ".md":
        raise ApiError(400, "file must end in .md")
    parts = rel.split("/")
    if any(p in ("", ".") for p in parts):
        raise ApiError(400, "file must be a relative path inside the vault")
    target = os.path.realpath(os.path.join(vault_real, *parts))
    if not inside(vault_real, target):
        raise ApiError(403, "file resolves outside the vault")
    return target


def attachment_dir(vault_real, note_real, setting):
    """Obsidian's attachment folder for a note: "/" or empty = the vault root, "./x" = x next to the note,
    anything else = a folder relative to the vault root. A setting with ".." segments means the vault root."""
    s = (setting or "").strip()
    if s in ("", "/"):
        return vault_real
    if s == "." or s.startswith("./"):
        base, rest = os.path.dirname(note_real), s[2:]
    else:
        base, rest = vault_real, s.strip("/")
    segs = [p for p in rest.split("/") if p and p != "."]
    if any(p == ".." or "\x00" in p or "\\" in p for p in segs):
        return vault_real
    return os.path.realpath(os.path.join(base, *segs)) if segs else base


# --- writes -----------------------------------------------------------------------------------------------------------

COPYFILE_ACL, COPYFILE_XATTR = 1 << 0, 1 << 2      # <copyfile.h>
_copyfile = []                                      # [libSystem's copyfile], or [None] where it is not available


def keep_attributes(src, dst):
    """Best effort, macOS only: copy the extended attributes (Finder tags and colour labels among them, other apps'
    data too) of the note `src` onto `dst`, the file about to replace it, with libSystem's copyfile(3)
    (COPYFILE_XATTR: the data and the mode of `dst` are left alone). -> True when copied. Elsewhere, or when anything
    fails, False and the write goes on without them. The ACL is deliberately not copied: a note whose ACL denies
    delete cannot be replaced, and the temp file would then carry that entry too and could not be removed (an
    undeletable hidden file in the vault). The creation date and file flags (such as Finder's hidden flag) are not
    carried over either: the replaced note is a new file."""
    if not _copyfile:
        fn = None
        if sys.platform == "darwin":
            try:
                import ctypes
                fn = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True).copyfile
                fn.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_void_p, ctypes.c_uint32]
                fn.restype = ctypes.c_int
            except (ImportError, OSError, AttributeError):
                fn = None
        _copyfile.append(fn)
    if _copyfile[0] is None:
        return False
    try:
        return _copyfile[0](os.fsencode(src), os.fsencode(dst), None, COPYFILE_XATTR) == 0
    except Exception:
        return False


class NoteChanged(Exception):
    """atomic_write()'s `unchanged` check failed: the file changed on disk after it was read, and is left as it is."""


def atomic_write(path, data, mode=None, keep_from=None, unchanged=None):
    """Write bytes to `path` through a temp file in the same folder and os.replace (never a half-written file), with
    `mode` (default 0644) and, when `keep_from` names the file being replaced, its extended attributes (not its ACL:
    see keep_attributes). `unchanged`, when given, is asked right before the replace; when it answers False, `path` is
    left as it is (NoteChanged). If the replace fails, or does not happen, the temp file is removed."""
    folder = os.path.dirname(path)
    fd, tmp = tempfile.mkstemp(prefix=".marginalia-", suffix=".tmp", dir=folder)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, mode if mode is not None else 0o644)
        if keep_from is not None:
            keep_attributes(keep_from, tmp)
        if unchanged is not None and not unchanged():
            raise NoteChanged(path)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def make_dirs_inside(vault_real, folder):
    os.makedirs(folder, exist_ok=True)
    real = os.path.realpath(folder)
    if real != vault_real and not inside(vault_real, real):
        raise ApiError(403, "folder resolves outside the vault")
    return real


def note_lines(text):
    """[(start, end, line)] for every line of `text` ("\n" ends a line): the offsets and the text of its content,
    without the "\n" and without a "\r" before it."""
    out, pos, n = [], 0, len(text)
    while True:
        nl = text.find("\n", pos)
        stop = n if nl < 0 else nl
        end = stop - 1 if stop > pos and text[stop - 1] == "\r" else stop
        out.append((pos, end, text[pos:end]))
        if nl < 0:
            return out
        pos = nl + 1


def fenced(lines, relaxed=False):
    """For each line, True when it belongs to a fenced code block (its fence lines included).

    relaxed (find_block, on a note as it is now): an opening fence with no closing fence anywhere below it is not a
    fence, and the lines after it are read on their own. Obsidian ends such a fence with its list item, or never reads
    it as one (``` inside an HTML comment, an HTML block or $$ math), so the strict reading would take every block
    below it for code and append a fresh copy on every update. check_block keeps the strict reading: a block the app
    sends never leaves a fence open."""
    closers = []
    for line in lines:
        m = FENCE_CLOSE_RE.fullmatch(line)
        closers.append((m.group(1)[0], len(m.group(1))) if m else None)
    longest = None                       # relaxed: per fence character, the longest closer at or below each line
    if relaxed:
        longest = {"`": [0] * (len(lines) + 1), "~": [0] * (len(lines) + 1)}
        for k in range(len(lines) - 1, -1, -1):
            for ch in longest:
                longest[ch][k] = longest[ch][k + 1]
            if closers[k]:
                ch, n = closers[k]
                longest[ch][k] = max(longest[ch][k], n)
    flags, fence = [], None
    for k, line in enumerate(lines):
        if fence:
            flags.append(True)
            c = closers[k]
            if c and c[0] == fence[0] and c[1] >= len(fence):
                fence = None
            continue
        m = FENCE_OPEN_RE.fullmatch(line)
        if (m and not (m.group(1)[0] == "`" and "`" in m.group(2))
                and not (relaxed and longest[m.group(1)[0]][k + 1] < len(m.group(1)))):
            fence = m.group(1)
            flags.append(True)
        else:
            flags.append(False)
    return flags


def own_link_re(block_id):
    """A line that starts (after spaces) with block_id's own link and a date,
    "[Open in Marginalia](…#reader/<collection>/<block_id>) · YYYY-MM-DD", whatever follows: the block's date
    line, or what a hand edit left of it. Use with match()."""
    return re.compile(r"\s*\[Open in Marginalia\]\([^)\r\n]*#reader/[^/)\r\n]*/" + re.escape(block_id)
                      + r"\) \u00b7 \d{4}-\d{2}-\d{2}", re.A)


def date_kind(line, block_id):
    """Whose date line this is: "own" (block_id's own link and the date), "date" (the date alone, as a block written
    through an obsidian:// link away from 127.0.0.1 has it), "other" (any other link), or None (not a date line)."""
    if not DATE_LINE_RE.fullmatch(line):
        return None
    if not line.startswith(LINK_LABEL):
        return "date"
    return "own" if own_link_re(block_id).match(line) else "other"


def find_block(text, block_id, linked=False):
    """(start, end) offsets of the block for block_id that a send may replace, or None (the block is then appended).

    Only a span that is provably that one block qualifies: an exact start-marker line for block_id outside code
    fences; then, before any other line that reads like a marker (fenced or not, in any spacing or case, indented or
    with text after it), an exact end-marker line outside fences; between them exactly one date line outside fences,
    the line right before the end marker; and that date line is the block's own. With `linked` (the new block carries
    its "Open in Marginalia" link, as every block the app sends here does) it must be the line that links to block_id,
    and no other line of the span may start with that link (an edited copy of the date line); without, it must be the
    date alone, and no line of the span may start with block_id's link.

    So a block whose end marker, or the next block's start marker, was deleted or edited by hand is never replaced
    together with the user's text and the blocks after it: the span then holds two date lines, a marker line, or a
    date line that is another block's (the next block's link, or a bare date that a linked block cannot claim). A copy
    of a block inside a code fence is never the one replaced. The first span that qualifies wins."""
    start_line = "<!-- marginalia:" + block_id + " -->"
    rows = note_lines(text)
    if rows[0][2].startswith("\ufeff"):            # a byte order mark before the first line stays where it is
        rows[0] = (rows[0][0] + 1, rows[0][1], rows[0][2][1:])
    lines = [r[2] for r in rows]
    flags = fenced(lines, relaxed=True)
    own = own_link_re(block_id)
    want = "own" if linked else "date"
    for i, line in enumerate(lines):
        if flags[i] or line.rstrip(" \t") != start_line:
            continue
        end, dates, links = None, [], []
        for k in range(i + 1, len(lines)):
            if LOOSE_MARKER_RE.search(lines[k]):
                if not flags[k] and END_LINE_RE.fullmatch(lines[k]):
                    end = k
                break
            if not flags[k] and DATE_LINE_RE.fullmatch(lines[k]):
                dates.append(k)
            if own.match(lines[k]):                 # fenced or not, edited or not
                links.append(k)
        if end is None or dates != [end - 1] or date_kind(lines[end - 1], block_id) != want:
            continue
        if links != ([end - 1] if linked else []):
            continue
        return rows[i][0], rows[end][1]
    return None


def ends_with_blank_line(t):
    return t.endswith("\n\n") or t.endswith("\n\r\n")


def upsert_text(existing, block, block_id):
    """(new text, replaced) for a note that holds `existing` (str); `block` as check_block() returns it."""
    nl = "\r\n" if "\r\n" in existing else "\n"
    block = block.replace("\r\n", "\n")
    linked = date_kind(block.split("\n")[-2] if block.count("\n") else "", block_id) == "own"
    block = block.replace("\n", nl)
    span = find_block(existing, block_id, linked)
    if span:
        out = existing[:span[0]] + block + existing[span[1]:]
        replaced = True
    else:
        out = existing
        if out:
            if not out.endswith("\n"):
                out += nl
            if not ends_with_blank_line(out):
                out += nl
        out += block + nl
        replaced = False
    if not out.endswith("\n"):
        out += nl
    return out, replaced


def clean_title(title, rel):
    t = title if isinstance(title, str) else ""
    t = re.sub(r"[\x00-\x1f\x7f]+", " ", t)
    t = re.sub(r"\s+", " ", t).strip()[:MAX_TITLE].strip()
    if not t:
        t = os.path.basename(rel)[:-3] or "Untitled"
    return t


def check_block(markdown, block_id):
    """The block as it is written (LF line ends, no blank lines around it), or ApiError: exactly one block for
    block_id, in the shape find_block() recognises on the next send (so an update can always replace it)."""
    if not isinstance(markdown, str) or not markdown.strip():
        raise ApiError(400, "markdown is required")
    md = markdown.replace("\r\n", "\n").strip("\n")
    lines = md.split("\n")
    if (len(lines) < 3 or lines[0].rstrip(" \t") != "<!-- marginalia:" + block_id + " -->"
            or not END_LINE_RE.fullmatch(lines[-1])):
        raise ApiError(400, "markdown must be one block between its marginalia markers")
    if any(LOOSE_MARKER_RE.search(ln) for ln in lines[1:-1]):
        raise ApiError(400, "markdown must hold exactly one marginalia block")
    flags = fenced(lines)
    if flags[-1]:
        raise ApiError(400, "markdown leaves a code fence open")
    dates = [k for k, ln in enumerate(lines) if not flags[k] and DATE_LINE_RE.fullmatch(ln)]
    if dates != [len(lines) - 2]:
        raise ApiError(400, "markdown must end with its date line, right before the end marker")
    kind = date_kind(lines[-2], block_id)
    if kind not in ("own", "date"):
        raise ApiError(400, "markdown's Open in Marginalia link must point to its own blockId")
    own = own_link_re(block_id)
    if [k for k in range(1, len(lines) - 1) if own.match(lines[k])] != ([len(lines) - 2] if kind == "own" else []):
        raise ApiError(400, "markdown must link to its own blockId on its date line only")
    return md


def check_unicode(*values):
    """ApiError unless every string can be written as UTF-8 (JSON may carry lone surrogates such as \\ud835)."""
    for v in values:
        if isinstance(v, str):
            try:
                v.encode("utf-8")
            except UnicodeEncodeError:
                raise ApiError(400, "the note holds text that is not valid Unicode")


def decode_images(items):
    if items is None:
        return []
    if not isinstance(items, list):
        raise ApiError(400, "images must be a list")
    out, seen = [], set()
    for it in items:
        if not isinstance(it, dict):
            raise ApiError(400, "every image needs a name and data")
        name, data = it.get("name"), it.get("data")
        if not isinstance(name, str) or not IMAGE_NAME_RE.fullmatch(name):
            raise ApiError(400, "bad image name")
        if not isinstance(data, str) or not data:
            raise ApiError(400, "image data must be base64")
        try:
            raw = base64.b64decode(data, validate=True)
        except (binascii.Error, ValueError):
            raise ApiError(400, "image data must be base64")
        if not raw:
            raise ApiError(400, "image data is empty")
        if name in seen:
            continue
        seen.add(name)
        out.append((name, raw))
    return out


def pick_vault(config_path, vault_name):
    """The vault of obsidian.json named `vault_name` (its folder name, all the page knows), or ApiError: 400 when
    none is, 409 when two vault folders share that name."""
    named = [v for v in all_vaults(config_path) if v["name"] == vault_name] if isinstance(vault_name, str) else []
    if not named:
        raise ApiError(400, "unknown vault")
    if len({os.path.realpath(v["path"]) for v in named}) > 1:
        # the page names a vault by its folder name only: which one Obsidian lists as open could change between two
        # sends of one prompt, and an update would then land in the other vault
        raise ApiError(409, "two Obsidian vaults are named “%s”, so it is not clear which one to write into; "
                            "rename one of their folders" % vault_name)
    return named[0]


def image_plan(vault, vault_real, target, images):
    """(attachment folder or None, [(path, real path, bytes)]) for the decoded images of a note at `target`, or
    ApiError 403 when one would land outside the vault."""
    img_dir = attachment_dir(vault_real, target, attachment_setting(vault["path"])) if images else None
    img_targets = []
    for name, raw in images:
        dest = os.path.join(img_dir, name)
        real = os.path.realpath(dest)
        if not inside(vault_real, real):
            raise ApiError(403, "image resolves outside the vault")
        img_targets.append((dest, real, raw))
    return img_dir, img_targets


def file_state(st):
    """What note_unchanged() compares of a stat result: which file it is (device, inode), its size and time, and its
    mode and file flags (a note locked or made read-only meanwhile is then read again, and refused as such)."""
    return st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_mode, getattr(st, "st_flags", 0)


def read_for_update(target):
    """(text, mode, seen) of the existing note `target`, which the new text is about to replace (atomic_write), or
    ApiError 409 for what that would get wrong: a note the user locked or made read-only (Obsidian could not save it
    either), a hard-linked note (the other name would keep the old text), a note that is not UTF-8. `seen` (the
    file's state, taken before its bytes are read, and those bytes) is what note_unchanged() compares later."""
    st = os.stat(target)
    if not os.access(target, os.W_OK):
        raise ApiError(409, "the note is read-only (locked, or without write permission); nothing was written")
    if st.st_nlink > 1:
        raise ApiError(409, "the note is hard-linked to another file, which a rewrite would leave behind; "
                            "nothing was written")
    with open(target, "rb") as f:
        state = file_state(os.fstat(f.fileno()))       # before the read: a save during it shows as a change
        raw = f.read()
    try:
        existing = raw.decode("utf-8")
    except UnicodeDecodeError:
        raise ApiError(409, "the note is not UTF-8 text; nothing was written")
    return existing, st.st_mode & 0o7777, (state, raw)


def note_unchanged(target, seen):
    """True when the note at `target` is still exactly what read_for_update() read (`seen`; None: there was no note,
    and there still is none): the same file, size and time, and the same bytes (a disk with coarse file times, such as
    HFS+ or FAT, could hide a save of the same size). The last look is a stat, right before the caller's replace."""
    if seen is None:
        return not os.path.exists(target)
    state, raw = seen
    try:
        with open(target, "rb") as f:
            if file_state(os.fstat(f.fileno())) != state or f.read() != raw:
                return False
        return file_state(os.stat(target)) == state
    except OSError:
        return False


def write_images(vault_real, img_dir, img_targets):
    """Write the images of image_plan(): each only when no file of its name exists (written once, never replaced)."""
    if img_targets:
        make_dirs_inside(vault_real, img_dir)
    for dest, real, raw in img_targets:
        if os.path.lexists(dest) or os.path.lexists(real):
            continue
        atomic_write(real, raw)


def rewrite_note(vault_real, target, make, img_dir, img_targets, images_for=None):
    """Write the note `target` (the real path note_target() gave) under NOTE_LOCK: read it (None when there is none),
    make its new text with make(existing) -> (text, result), write the images of image_plan() (those
    images_for(result) picks from img_targets, when given: /notes leaves out the images of its blocks left out), then
    replace the note atomically -> (created, result). A text of None means there is nothing to write (a /notes request
    whose every block is a replaceOnly one the note does not hold): nothing at all is made then, no note, folder or
    image -> (False, result). The note's folder is checked (make_dirs_inside) before the note is read when it exists,
    and made only once there is something to write. The replace happens only while the note is still exactly what was
    read (note_unchanged, asked right before it): a save that lands meanwhile, an edit in Obsidian or a sync, would
    otherwise be overwritten with text made from the old copy (a send-all of a large book takes a second or more). The
    note is then read again and its text made again, NOTE_TRIES times in all, then ApiError 409 and the note is left as
    it is. The images are picked again for each text made. Images are written only when missing, so a second try
    writes none of them again (and never removes one: an image a first try wrote stays, also when a save meanwhile
    leaves its block out of the second)."""
    with NOTE_LOCK:
        folder, name = os.path.split(target)
        ready = False                                  # the folder made (when missing) and checked by make_dirs_inside
        for _ in range(NOTE_TRIES):
            if not ready and os.path.isdir(folder):
                target, ready = os.path.join(make_dirs_inside(vault_real, folder), name), True
            if os.path.isdir(target):
                raise ApiError(409, "a folder has the note's name")
            created = not os.path.exists(target)
            existing, mode, seen = (None, None, None) if created else read_for_update(target)
            text, result = make(existing)
            if text is None:
                return False, result
            try:
                data = text.encode("utf-8")                # the whole note is ready before any image is written
            except UnicodeEncodeError:
                raise ApiError(400, "the note holds text that is not valid Unicode")
            if not ready:
                target, ready = os.path.join(make_dirs_inside(vault_real, folder), name), True
            write_images(vault_real, img_dir, img_targets if images_for is None else images_for(result))
            try:
                atomic_write(target, data, mode, keep_from=None if created else target,
                             unchanged=functools.partial(note_unchanged, target, seen))
            except NoteChanged:
                continue
            return created, result
    raise ApiError(409, NOTE_CHANGED)


def write_note(config_path, req):
    """Validate the whole request, then write the images and the note. -> response dict."""
    if not isinstance(req, dict):
        raise ApiError(400, "expected a JSON object")
    images_in = req.get("images")
    names = [it.get("name") for it in images_in if isinstance(it, dict)] if isinstance(images_in, list) else []
    # before anything touches the disk: a lone surrogate would fail in os.path or in the final encode
    check_unicode(req.get("vault"), req.get("file"), req.get("title"), req.get("blockId"), req.get("markdown"), *names)
    vault = pick_vault(config_path, req.get("vault"))
    block_id = req.get("blockId")
    if not isinstance(block_id, str) or not BLOCK_ID_RE.fullmatch(block_id):
        raise ApiError(400, "bad blockId")
    block = check_block(req.get("markdown"), block_id)
    images = decode_images(images_in)
    rel = req.get("file")
    vault_real = os.path.realpath(vault["path"])
    target = note_target(vault_real, rel)
    title = clean_title(req.get("title"), rel)
    img_dir, img_targets = image_plan(vault, vault_real, target, images)

    def make(existing):
        if existing is None:
            return "# " + title + "\n\n" + block + "\n", False
        return upsert_text(existing, block, block_id)
    created, replaced = rewrite_note(vault_real, target, make, img_dir, img_targets)
    return {"ok": True, "file": rel, "created": created, "replaced": replaced}


# --- send all: many blocks into one note ----------------------------------------------------------------------------

def line_at(text, s):
    """(content start, content end, stop) of the line of `text` that starts at offset `s` (0, or just after a "\n"),
    by note_lines()' rules: the line ends at `stop` (its "\n", or the end of the text), a "\r" right before that is not
    content, and neither is a byte order mark that starts the note (find_block's rule for the first line)."""
    nl = text.find("\n", s)
    stop = len(text) if nl < 0 else nl
    end = stop - 1 if stop > s and text[stop - 1] == "\r" else stop
    return (s + 1 if s == 0 and text.startswith("\ufeff") else s), end, stop


class FenceIndex:
    """Where the code fences of a note are, read as fenced(lines, relaxed=True) reads them, kept by the offset at which
    each line starts: los[k] .. his[k] are the first and last line of the k-th fence (its fence lines included), and
    `dangling` holds the opening fences that are no fence because no closing fence follows them anywhere below
    (offset, fence character, length). `closers` lists every closing fence line's (character, length); only the
    index of one block (FenceIndex.of(block)) needs it, so the index replaced() and appended() return leaves it empty.

    Only lines that start with up to three spaces and ``` or ~~~ can open or close a fence, so the index is built from
    those lines alone (found by a regular expression, not by reading every line). upsert_blocks keeps it up to date
    across its edits (replaced, appended) instead of building it again: an edit swaps one span whose first and last
    lines are outside every fence (a block's marker lines) for a block in which every fence closes (check_block), so
    the fences after the span are the same ones, moved, and those before it stay as they are; except when the new
    block has a closing fence that a dangling opening fence above it can pair with (it then becomes a fence), and then
    the index is built again. Those two return None to say so."""

    def __init__(self, los, his, dangling, closers):
        self.los, self.his, self.dangling, self.closers = los, his, dangling, closers

    @classmethod
    def of(cls, text):
        starts = [m.start() + 1 for m in FENCE_AFTER_NL_RE.finditer(text)]
        if FENCE_HEAD_RE.match(text, 1 if text.startswith("\ufeff") else 0):
            starts.insert(0, 0)
        records = []                                    # (line start, closing (char, length)|None, opening|None)
        for s in starts:
            cs, end, _ = line_at(text, s)
            line = text[cs:end]
            c = FENCE_CLOSE_RE.fullmatch(line)
            o = FENCE_OPEN_RE.fullmatch(line)
            closer = (c.group(1)[0], len(c.group(1))) if c else None
            opener = None
            if o and not (o.group(1)[0] == "`" and "`" in o.group(2)):
                opener = (o.group(1)[0], len(o.group(1)))
            records.append((s, closer, opener))
        n = len(records)
        longest = {"`": [0] * (n + 1), "~": [0] * (n + 1)}    # per character, the longest closer at or below k
        for k in range(n - 1, -1, -1):
            for ch in longest:
                longest[ch][k] = longest[ch][k + 1]
            c = records[k][1]
            if c and c[1] > longest[c[0]][k]:
                longest[c[0]][k] = c[1]
        los, his, dangling, fence = [], [], [], None
        for k, (s, closer, opener) in enumerate(records):
            if fence:
                if closer and closer[0] == fence[0] and closer[1] >= fence[1]:
                    his.append(s)
                    fence = None
                continue
            if opener:
                if longest[opener[0]][k + 1] >= opener[1]:
                    fence = opener
                    los.append(s)
                else:
                    dangling.append((s, opener[0], opener[1]))
        if fence:                                       # never, read this way: a fence opens only before its closer
            his.append(len(text))
        return cls(los, his, dangling, [r[1] for r in records if r[1]])

    def fenced(self, s):
        """True when the line that starts at offset `s` belongs to a fence (fenced(..., relaxed=True))."""
        k = bisect.bisect_right(self.los, s) - 1
        return k >= 0 and s <= self.his[k]

    def _pairs_with(self, inner, above):
        """True when a closing fence of `inner` can close a dangling opening fence that starts before `above`."""
        return any(d[0] < above and c[0] == d[1] and c[1] >= d[2] for d in self.dangling for c in inner.closers)

    def replaced(self, text, a, b, block):
        """The index after text[a:b] (from a block's start-marker line to its end-marker line, as find_span() gives
        them) became `block`, or None when it must be built again."""
        first = text.rfind("\n", 0, a) + 1                      # where the span's first and last lines start
        last = text.rfind("\n", 0, b) + 1
        inner = FenceIndex.of(block)
        if inner.dangling or self._pairs_with(inner, first):
            return None
        delta = len(block) - (b - a)
        i0, i1 = bisect.bisect_left(self.los, first), bisect.bisect_right(self.los, last)
        los = self.los[:i0] + [a + x for x in inner.los] + [x + delta for x in self.los[i1:]]
        his = self.his[:i0] + [a + x for x in inner.his] + [x + delta for x in self.his[i1:]]
        dangling = ([d for d in self.dangling if d[0] < first]
                    + [(d[0] + delta, d[1], d[2]) for d in self.dangling if d[0] > last])
        return FenceIndex(los, his, dangling, [])

    def appended(self, text, at, block):
        """The index after `block` was added at offset `at` of the note (after the blank line upsert_text puts before
        it) that was `text`, or None when it must be built again."""
        if text.endswith("\r"):            # the old last line gets its "\n" now, and a "\r" before it is not content
            return None
        inner = FenceIndex.of(block)
        if inner.dangling or self._pairs_with(inner, len(text) + 1):
            return None
        return FenceIndex(self.los + [at + x for x in inner.los], self.his + [at + x for x in inner.his],
                          list(self.dangling), [])


def find_span(text, block_id, linked, fences, places=None):
    """find_block(text, block_id, linked), found without reading every line: str.find() looks for the block's start
    line (or `places` lists every offset at which it occurs in `text`, in order, as upsert_blocks finds them for all
    its ids in one pass), only the lines from there to the next marker-like line are read, and `fences()` (called only
    when the start line is in the note at all) is a FenceIndex of `text`. test_serve.py checks that both always give
    the same."""
    start_line = "<!-- marginalia:" + block_id + " -->"
    if places is None:
        places = _occurrences(text, start_line)
    index = own = None
    want = "own" if linked else "date"
    n = len(text)
    stop = -1
    for p in places:
        if p <= stop:
            continue                                # on a line read already: only its first occurrence counts
        if index is None:
            index, own = fences(), own_link_re(block_id)
        s = text.rfind("\n", 0, p) + 1
        cs, end, stop = line_at(text, s)
        if p != cs or text[cs:end].rstrip(" \t") != start_line or index.fenced(s):
            continue
        prev, last, dates, links = (s, cs, end), None, [], []
        k_stop = stop
        while k_stop < n:
            k = k_stop + 1
            kcs, kend, k_stop = line_at(text, k)
            line = text[kcs:kend]
            if LOOSE_MARKER_RE.search(line):
                if not index.fenced(k) and END_LINE_RE.fullmatch(line):
                    last = (k, kcs, kend)
                break
            if not index.fenced(k) and DATE_LINE_RE.fullmatch(line):
                dates.append(k)
            if own.match(line):                     # fenced or not, edited or not
                links.append(k)
            prev = (k, kcs, kend)
        if (last is not None and dates == [prev[0]] and date_kind(text[prev[1]:prev[2]], block_id) == want
                and links == ([prev[0]] if linked else [])):
            return cs, last[2]
    return None


def _occurrences(text, sub):
    """Every offset at which `sub` occurs in `text`, in order."""
    p = text.find(sub)
    while p >= 0:
        yield p
        p = text.find(sub, p + 1)


_check_index = False   # tests: compare every FenceIndex upsert_blocks keeps up to date with one built afresh, and
                       # every span a batch finds in its base with find_span on the note as it is at that moment


def upsert_blocks(existing, items):
    """upsert_text() applied to `existing` for each item of `items` in order -> (text, [replaced, ...]): the same text
    as one /note request after another would leave, in time linear in the note and the blocks. (One upsert_text call
    per block reads every line of the note, so N blocks into a note of N blocks took O(N²) line reads, half a minute
    for 2000; copying the whole note for every block still took seconds, up to tens of seconds for long blocks, all of
    it under NOTE_LOCK.)

    An item is (block, block_id) or (block, block_id, replace_only). A replace_only block (/notes' "replaceOnly")
    only replaces: when the note, as the blocks before it left it, holds no span that find_block would claim for it,
    the block is left out (nothing is added, the note stays as it is: as if that /note request were never sent) and
    its flag is None; otherwise True (replaced) or False (added). So a replace_only block never adds a block of its id.

    The first block that goes in goes in as upsert_text would put it (_upsert_in_order), which leaves the note ending
    in a line end; the replace_only blocks left out before it are all looked up in the note as it was (_left_out).
    From then on a block that is replaced or added for one id never moves where another id's block is found: a span
    runs from its start line to the first marker-like line after it, every new block holds exactly one start line
    (its own), an added block goes below everything, and fences away from the edit stay as they are unless a new
    block's closing fence pairs with an opening fence that had no closer (what makes FenceIndex.replaced or appended
    answer None). So the later blocks go in batches (_upsert_batch): each block's span is looked up in the note as the
    batch found it (the base; the start lines of all its ids found in one pass), and the edits are spliced in once at
    the end of the batch. A block whose fences could pair that way ends its batch, and the next batch starts from the
    note as it is then (a block left out changes nothing, so it never ends one). Two blocks with one id, or an id that
    is not a blockId, go one at a time (_upsert_in_order)."""
    items = [(it[0], it[1], len(it) > 2 and it[2] is True) for it in items]
    ids = [it[1] for it in items]
    if (len(items) < 2 or len(set(ids)) < len(ids)
            or not all(isinstance(bid, str) and BLOCK_ID_RE.fullmatch(bid) for bid in ids)):
        return _upsert_in_order(existing, items)
    out = []
    k = _left_out(existing, items, out)
    if k == len(items):
        return existing, out
    text, first = _upsert_in_order(existing, items[k:k + 1])
    out += first
    crlf, k = text.count("\r\n"), k + 1
    while k < len(items):
        text, crlf, k = _upsert_batch(text, crlf, items, k, out)
    return text, out


def is_linked(block, block_id):
    """True when `block` (LF or CRLF line ends) carries block_id's own "Open in Marginalia" link on its date line, as
    every block the app sends to this server does (find_block's `linked`)."""
    block = block.replace("\r\n", "\n")
    return date_kind(block.split("\n")[-2] if block.count("\n") else "", block_id) == "own"


def _left_out(text, items, out):
    """upsert_blocks: the replace_only items at the head of `items` that `text` holds no block for are left out (None
    appended to `out` for each) -> the index of the first item that goes in (len(items) when none does). None of them
    changes the note, so each is looked up in `text` itself: the start lines of all their ids found in one pass, a
    FenceIndex built at most once."""
    index, places = None, None

    def fences():
        nonlocal index
        if index is None:
            index = FenceIndex.of(text)
        return index

    for k, (block, bid, only) in enumerate(items):
        if not only:
            return k
        if places is None:
            wanted, places = {it[1] for it in items}, {}
            for m in START_ANY_RE.finditer(text):
                if m.group(1) in wanted:
                    places.setdefault(m.group(1), []).append(m.start())
        if find_span(text, bid, is_linked(block, bid), fences, places.get(bid, ())):
            return k
        out.append(None)
    return len(items)


def _upsert_batch(base, crlf, items, k, out):
    """upsert_blocks from items[k] on, in `base`, a note that ends in a line end and holds `crlf` "\r\n"s, until a
    block's fences could pair with a dangling opening fence above it (the note's fences then change away from that
    block's span) or the items end -> (the note as it is then, its "\r\n" count, the next k); appends each block's
    `replaced` to `out` (None for a replace_only block the base holds no span for: left out, it changes nothing, so
    the batch goes on)."""
    index = FenceIndex.of(base)
    wanted = {it[1] for it in items[k:]}
    places = {}
    for m in START_ANY_RE.finditer(base):
        if m.group(1) in wanted:
            places.setdefault(m.group(1), []).append(m.start())
    shortest = {"`": ([], []), "~": ([], [])}     # per fence character: the dangling openers' offsets, in order, and
    for at, ch, size in index.dangling:           # the shortest of them up to each one
        offsets, sizes = shortest[ch]
        offsets.append(at)
        sizes.append(min(size, sizes[-1]) if sizes else size)

    def pairs(closers, above):
        """FenceIndex._pairs_with: a closing fence can close a dangling opener that starts before `above` (None: any).
        Openers in spans replaced in this batch still count, which can only end a batch early."""
        for ch, size in closers:
            offsets, sizes = shortest[ch]
            i = len(offsets) if above is None else bisect.bisect_left(offsets, above)
            if i and sizes[i - 1] <= size:
                return True
        return False

    blank = ends_with_blank_line(base)          # a replacement keeps that; an added block ends it
    edits, tail = [], []
    while k < len(items):
        block, bid, only = items[k]
        k += 1
        nl = "\r\n" if crlf else "\n"
        block = block.replace("\r\n", "\n")
        linked = date_kind(block.split("\n")[-2] if block.count("\n") else "", bid) == "own"
        block = block.replace("\n", nl)
        span = find_span(base, bid, linked, lambda: index, places.get(bid, ()))
        if _check_index:
            _check_batch(base, edits, tail, crlf, bid, linked, span)
        if span is None and only:
            out.append(None)
            continue
        if span:
            a, b = span
            # neither seam can make a "\r\n" (see _upsert_in_order), and nothing after the span changes, so the note
            # still ends in its line end
            crlf += block.count("\r\n") - base.count("\r\n", a, b)
            edits.append((a, b, block))
            above = base.rfind("\n", 0, a) + 1          # where the span's first line starts (FenceIndex.replaced)
        else:
            add = ("" if blank else nl) + block + nl    # upsert_text's padding for a note that ends in a line end
            crlf += add.count("\r\n")
            tail.append(add)
            blank, above = False, None
        out.append(span is not None)
        inner = FenceIndex.of(block)
        if inner.dangling or pairs(inner.closers, above):
            break
    return _spliced(base, edits, tail), crlf, k


def _spliced(base, edits, tail):
    """`base` with each (a, b, block) of `edits` (spans that do not overlap, in any order) replaced by its block, then
    the texts of `tail` added at the end."""
    pieces, pos = [], 0
    for a, b, block in sorted(edits, key=lambda e: e[0]):
        pieces += (base[pos:a], block)
        pos = b
    pieces.append(base[pos:])
    return "".join(pieces + tail)


def _check_batch(base, edits, tail, crlf, block_id, linked, span):
    """_check_index, in _upsert_batch: the note as it is now holds `crlf` "\r\n"s, and find_span finds in it, with a
    FenceIndex built afresh, the span the batch found in its base (moved by the edits before it)."""
    now = _spliced(base, edits, tail)
    assert crlf == now.count("\r\n"), "crlf count"
    if span:
        shift = sum(len(block) - (b - a) for a, b, block in edits if a < span[0])
        span = (span[0] + shift, span[1] + shift)
    assert find_span(now, block_id, linked, lambda: FenceIndex.of(now)) == span, "upsert_blocks batch"


def _upsert_in_order(existing, items):
    """upsert_blocks one block after another: each block's span is looked up in the note as the blocks before it left
    it (find_span, with a FenceIndex kept up to date per edit) and the note is put together again after every block.
    Line ends follow upsert_text: the note's "\r\n" count is kept up to date, so every block is written with the line
    end the note has at that moment. `items` are (block, block_id, replace_only); a replace_only block the note does
    not hold then is left out (None)."""
    text, out, index = existing, [], None
    crlf = existing.count("\r\n")

    def fences():
        nonlocal index
        if index is None:
            index = FenceIndex.of(text)
        return index

    for block, block_id, only in items:
        nl = "\r\n" if crlf else "\n"
        block = block.replace("\r\n", "\n")
        linked = date_kind(block.split("\n")[-2] if block.count("\n") else "", block_id) == "own"
        block = block.replace("\n", nl)
        span = find_span(text, block_id, linked, fences)
        if span is None and only:
            out.append(None)                            # left out: the note stays as it is
            continue
        if span:
            a, b = span
            # neither seam can make a "\r\n": the span starts a line's content and the block starts with "<"; the
            # block ends with ">", a space or a tab
            crlf += block.count("\r\n") - text.count("\r\n", a, b)
            if index is not None:
                index = index.replaced(text, a, b, block)
            new = text[:a] + block + text[b:]
            replaced = True
        else:
            pad = ""
            if text:
                if not text.endswith("\n"):
                    pad += nl
                if not ends_with_blank_line(text + pad):
                    pad += nl
            add = pad + block + nl
            crlf += (text[-1:] + add).count("\r\n")
            if index is not None:
                index = index.appended(text, len(text) + len(pad), block)
            new = text + add
            replaced = False
        if not new.endswith("\n"):
            if new.endswith("\r"):
                index = None
            crlf += (new[-1:] + nl).count("\r\n")
            new += nl
        text = new
        out.append(replaced)
        if _check_index and index is not None:
            fresh = FenceIndex.of(text)
            assert (index.los, index.his, index.dangling) == (fresh.los, fresh.his, fresh.dangling), "FenceIndex"
            assert crlf == text.count("\r\n"), "crlf count"
    return text, out


def write_notes(config_path, req):
    """POST /api/obsidian/notes: validate the request and every block, then write the images and the note once.
    -> response dict (the module docstring has the contract)."""
    if not isinstance(req, dict):
        raise ApiError(400, "expected a JSON object")
    images_in = req.get("images")
    names = [it.get("name") for it in images_in if isinstance(it, dict)] if isinstance(images_in, list) else []
    check_unicode(req.get("vault"), req.get("file"), req.get("title"), *names)
    vault = pick_vault(config_path, req.get("vault"))
    rel = req.get("file")
    vault_real = os.path.realpath(vault["path"])
    target = note_target(vault_real, rel)
    blocks_in = req.get("blocks")
    if not isinstance(blocks_in, list) or not blocks_in:
        raise ApiError(400, "blocks must be a list of {blockId, markdown}")
    if len(blocks_in) > MAX_BLOCKS:
        raise ApiError(400, "at most %d blocks in one request" % MAX_BLOCKS)
    ids = [b.get("blockId") if isinstance(b, dict) else None for b in blocks_in]
    seen = set()
    for bid in ids:
        if isinstance(bid, str):
            if bid in seen:
                # two copies in one request: which one the note should keep is not clear, so neither is written
                raise ApiError(400, "blockId %s is in the request twice; nothing was written"
                               % (bid if BLOCK_ID_RE.fullmatch(bid) else "(not a valid id)"))
            seen.add(bid)
    results, todo = [], []
    for b, bid in zip(blocks_in, ids):
        try:
            if not isinstance(b, dict):
                raise ApiError(400, "every block needs a blockId and markdown")
            check_unicode(bid, b.get("markdown"))
            if not isinstance(bid, str) or not BLOCK_ID_RE.fullmatch(bid):
                raise ApiError(400, "bad blockId")
            only = b.get("replaceOnly", False)
            if not isinstance(only, bool):              # never read as "add it": a second copy is what it prevents
                raise ApiError(400, "replaceOnly must be true or false")
            block = check_block(b.get("markdown"), bid)
        except ApiError as e:
            results.append({"blockId": bid if isinstance(bid, str) else None, "ok": False, "error": e.message})
            continue
        todo.append((len(results), block, bid, only))
        results.append({"blockId": bid, "ok": True, "replaced": False})
    if not todo:
        raise ApiError(400, "no block could be written: " + results[0]["error"], {"results": results})
    images = decode_images(images_in)
    title = clean_title(req.get("title"), rel)
    img_dir, img_targets = image_plan(vault, vault_real, target, images)
    items = [(block, bid, only) for _, block, bid, only in todo]

    def make(existing):
        # a new note: what a first /note writes before its block
        text, flags = upsert_blocks("# " + title + "\n\n" if existing is None else existing, items)
        # every block a replaceOnly one the note does not hold: the note stays as it is, so nothing is written
        return (None if all(f is None for f in flags) else text), flags

    def images_for(flags):
        # a block left out (flag None) is not written, and neither are the images it embeds (the image names
        # IMAGE_NAME_RE finds in its Markdown: ![[name]]) unless a block that goes in embeds them too; every other
        # image of the request is written as /note writes it
        if all(f is not None for f in flags):
            return img_targets
        went, gone = set(), set()
        for (block, _, _), f in zip(items, flags):
            (gone if f is None else went).update(IMAGE_NAME_RE.findall(block))
        held = gone - went
        return [t for (name, _), t in zip(images, img_targets) if name not in held]
    created, flags = rewrite_note(vault_real, target, make, img_dir, img_targets, images_for)
    for (k, _, bid, _), r in zip(todo, flags):
        if r is None:
            results[k] = {"blockId": bid, "ok": False, "notFound": True, "error": EARLIER_COPY_GONE}
        else:
            results[k]["replaced"] = r
    return {"ok": True, "file": rel, "created": created, "results": results}


# --- backups ----------------------------------------------------------------------------------------------------------

def today():
    """This Mac's local date, YYYY-MM-DD (tests replace it)."""
    return time.strftime("%Y-%m-%d", time.localtime())


def now_ms():
    """This Mac's clock in milliseconds since 1970, as a page's Date.now() counts, which is what a tombstone's
    deletedAt holds (tests replace it)."""
    return time.time() * 1000.0


def tombstone_cutoff():
    """The oldest deletedAt (ms) of a tombstone that still keeps its saved PDF: DELETED_PDF_DAYS before now (D23).
    It trusts the Mac's clock: one 30 or more days wrong shortens the 30 days (BUILD-NOTES "PDFs, the server")."""
    return now_ms() - DELETED_PDF_DAYS * DAY_MS


def display_path(path):
    """`path` for people to read: "~" for the home folder at its start."""
    home = os.path.normpath(os.path.expanduser("~"))
    p = os.path.normpath(path)
    if os.path.isabs(home) and home != os.sep:
        if p == home:
            return "~"
        if p.startswith(home + os.sep):
            return "~" + p[len(home):]
    return p


def check_backup_dir(folder, app_dir):
    """`folder` as the server keeps backups in it (absolute, normalised), or ValueError: blank, relative, or the
    served app folder or a folder inside it (symlinks resolved, either letter case), which the static server would
    hand to any page that asks."""
    if not isinstance(folder, str) or not folder.strip():
        raise ValueError("the backup folder is blank")
    if not os.path.isabs(folder):
        raise ValueError("%s is not an absolute path; give the whole path of a folder" % folder)
    path = os.path.normpath(folder)
    app = os.path.realpath(os.path.abspath(app_dir))
    if is_or_inside(os.path.realpath(path), app):
        raise ValueError("%s is inside the app folder %s, which the server shows to the browser; choose a folder "
                         "outside it" % (path, app))
    return path


def backup_files(folder):
    """[(name, bytes)] of the backups in `folder`, newest first: regular files (not symlinks, not folders) whose whole
    name matches BACKUP_NAME_RE. A missing folder has none; OSError when the folder cannot be read."""
    out = []
    try:
        with os.scandir(folder) as entries:
            for e in entries:
                if not BACKUP_NAME_RE.fullmatch(e.name) or not e.is_file(follow_symlinks=False):
                    continue
                try:
                    out.append((e.name, e.stat(follow_symlinks=False).st_size))
                except OSError:
                    continue                            # gone since the listing
    except FileNotFoundError:
        return []
    out.sort(reverse=True)
    return out


def backup_listing(folder):
    """GET /api/backup's answer."""
    return {"ok": True, "dir": display_path(folder), "today": today(),
            "files": [{"name": n, "date": n[len("marginalia-backup-"):-len(".json")], "bytes": size}
                      for n, size in backup_files(folder)]}


def prune_backups(folder, keep):
    """Delete the backups past the BACKUP_KEEP newest (backup_files(): only regular files whose names match
    BACKUP_NAME_RE), never the backup named `keep`. -> the names deleted, oldest first."""
    pruned = []
    for name, _ in backup_files(folder)[BACKUP_KEEP:]:
        if name == keep:
            continue                    # newer-dated names (a clock that was wrong) never push today's file out
        try:
            os.unlink(os.path.join(folder, name))
            pruned.append(name)
        except OSError:
            continue
    return sorted(pruned)


def _no_constant(name):
    raise ValueError("%s is not JSON" % name)


def json_object_spans(text):
    """Parse `text`, a JSON object, as json.loads() would (but NaN and Infinity, which no JSON.stringify writes, are
    refused) -> (dict, {key: (start, end)}): where each member's value lies in `text`; for a key given twice, the last
    value, as json.loads() and JSON.parse() keep it. ValueError (or RecursionError) when it is not a JSON object."""
    decoder = json.JSONDecoder(parse_constant=_no_constant)
    i = JSON_SPACE_RE.match(text).end()
    if text[i:i + 1] != "{":
        raise ValueError("expected a JSON object")
    i = JSON_SPACE_RE.match(text, i + 1).end()
    obj, spans = {}, {}
    if text[i:i + 1] == "}":
        i += 1
    else:
        while True:
            if text[i:i + 1] != '"':
                raise ValueError("expected a key")
            key, i = json.decoder.scanstring(text, i + 1, True)
            i = JSON_SPACE_RE.match(text, i).end()
            if text[i:i + 1] != ":":
                raise ValueError("expected ':'")
            i = JSON_SPACE_RE.match(text, i + 1).end()
            value, end = decoder.raw_decode(text, i)
            obj[key], spans[key] = value, (i, end)
            i = JSON_SPACE_RE.match(text, end).end()
            if text[i:i + 1] == ",":
                i = JSON_SPACE_RE.match(text, i + 1).end()
                continue
            if text[i:i + 1] == "}":
                i += 1
                break
            raise ValueError("expected ',' or '}'")
    if JSON_SPACE_RE.match(text, i).end() != len(text):
        raise ValueError("extra data after the JSON object")
    return obj, spans


def looks_like_backup(b):
    """True for what M.exporter writes as a JSON backup (its top-level keys, not every record)."""
    version = b.get("version") if isinstance(b, dict) else None
    return (isinstance(b, dict) and b.get("format") == BACKUP_FORMAT
            and isinstance(version, int) and not isinstance(version, bool) and version >= 1
            and isinstance(b.get("collections"), list) and isinstance(b.get("prompts"), list)
            and isinstance(b.get("attachments", []), list))


def place_backup(folder, name, text, start, end, replace):
    """Write text[start:end] (UTF-8) as `folder`/`name` atomically: a temp file in the folder, written in pieces,
    synced, mode 0600, then os.replace (replace=True) or a hard link, which never replaces a file that exists by now
    (on a disk without hard links: os.replace when no such file exists). -> (bytes, placed); placed is False when
    `name` existed and replace was False. The temp file never stays behind."""
    final = os.path.join(folder, name)
    fd, tmp = tempfile.mkstemp(prefix=".marginalia-", suffix=".tmp", dir=folder)
    size = 0
    try:
        with os.fdopen(fd, "wb") as f:
            for k in range(start, end, 1 << 20):
                chunk = text[k:min(k + (1 << 20), end)].encode("utf-8")
                f.write(chunk)
                size += len(chunk)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, 0o600)
        if replace:
            os.replace(tmp, final)
            return size, True
        try:
            os.link(tmp, final)
        except FileExistsError:
            return size, False
        except OSError:                                 # no hard links here (FAT, exFAT, some network disks)
            if os.path.lexists(final):
                return size, False
            os.replace(tmp, final)
        return size, True
    finally:
        try:
            os.unlink(tmp)                              # after a link, the temp name; after a failure, the temp file
        except OSError:
            pass


def check_todays_name(folder, name):
    """ApiError 409 unless the entry that `name` reaches in `folder` is stored under that very name. A disk that
    ignores letter case (macOS's default) also reaches "Marginalia-Backup-<today>.json" through today's name: a file
    that GET never lists and the prune never counts, so an "auto" backup must not take it for today's backup (the
    page would then post the whole backup again at every check, and none would be made that day) and a "manual" one
    must not replace it (the user's file would be gone, and the backup would keep the other name, never listed or
    pruned)."""
    names = os.listdir(folder)
    if name in names:
        return
    stored = None
    try:
        st = os.lstat(os.path.join(folder, name))
        stored = next((n for n in names if os.path.samestat(os.lstat(os.path.join(folder, n)), st)), None)
    except OSError:
        pass
    raise ApiError(409, "%s in the backup folder has today's backup name in other letters, so it is left as it is; "
                        "nothing was written" % (stored or "A file"))


def write_backup(folder, app_dir, text, log=None):
    """POST /api/backup with the request body `text` -> response dict (the module docstring has the contract).
    `log(message)` gets what the PDF prune after the write has to say (prune_pdfs)."""
    try:
        req, spans = json_object_spans(text)
    except (ValueError, RecursionError):
        raise ApiError(400, "the body is not a JSON object")
    mode = req.get("mode")
    if mode not in ("auto", "manual"):
        raise ApiError(400, 'mode must be "auto" or "manual"')
    if not looks_like_backup(req.get("backup")):
        raise ApiError(400, "backup must be a Marginalia JSON backup (format, version, collections, prompts)")
    start, end = spans["backup"]
    try:
        listed = collection_sha12s(req["backup"]["collections"], tombstone_cutoff())   # the PDFs it keeps (prune_pdfs)
    except ValueError:
        listed = None
    del req                                             # the parsed records are not needed any more
    if is_or_inside(os.path.realpath(folder), os.path.realpath(app_dir)):
        raise ApiError(500, "the backup folder is inside the app folder, which the server shows to the browser")
    name = "marginalia-backup-%s.json" % today()
    final = os.path.join(folder, name)
    with BACKUP_LOCK:
        if os.path.lexists(folder) and not os.path.isdir(folder):
            raise ApiError(500, "the backup folder %s is not a folder" % display_path(folder))
        os.makedirs(folder, mode=0o700, exist_ok=True)
        if os.path.lexists(final):
            check_todays_name(folder, name)
            if os.path.islink(final) or not os.path.isfile(final):
                raise ApiError(409, "%s in the backup folder is not a backup file, so it is left as it is; nothing "
                                    "was written" % name)
            if mode == "auto":
                return {"ok": True, "file": name, "bytes": os.stat(final).st_size, "skipped": True, "pruned": []}
        size, placed = place_backup(folder, name, text, start, end, replace=(mode == "manual"))
        if not placed:
            check_todays_name(folder, name)
            return {"ok": True, "file": name, "bytes": os.stat(final).st_size, "skipped": True, "pruned": []}
        pruned = prune_backups(folder, name)
        prune_pdfs(folder, name, listed, log)
    return {"ok": True, "file": name, "bytes": size, "skipped": False, "pruned": pruned}


# --- PDFs (FEATURES B9) -----------------------------------------------------------------------------------------------

def pdf_book_name(header):
    """The book name a saved PDF's file name starts with, made of the X-Marginalia-Name header (percent-encoded UTF-8;
    bytes that are not UTF-8 become U+FFFD; no header: "Untitled"): js/obsidian.js cleanSegment's rule for Obsidian
    note names (a run of whitespace becomes one space; path separators, : * ? " < > | # ^ [ ] and control characters
    are dropped; spaces and dots are trimmed at both ends; a run of dots inside becomes "…"), cut to PDF_NAME_MAX
    characters and PDF_NAME_BYTES bytes of UTF-8 (a long title in Chinese or Korean stays far below the 255 bytes a
    file name may take), one ".pdf" at its end left out, and "Untitled" when nothing is left. So it never holds a path
    separator or a NUL, and never starts with a dot or a space."""
    raw = header or ""
    try:
        data = raw.encode("latin-1")                    # http.client reads a header's bytes as Latin-1
    except UnicodeEncodeError:
        data = raw.encode("utf-8", "replace")
    t = urllib.parse.unquote_to_bytes(data).decode("utf-8", "replace")
    t = NAME_SPACE_RE.sub(" ", t)
    t = NAME_SPACE_RE.sub(" ", NAME_FORBIDDEN_RE.sub("", t))
    t = NAME_DOTS_RE.sub("\u2026", t.strip(" ."))
    t = t[:PDF_NAME_MAX]
    while len(t.encode("utf-8")) > PDF_NAME_BYTES:
        t = t[:-1]
    t = t.strip(" .")
    if t[-4:].lower() == ".pdf":
        t = t[:-4].strip(" .")
    return t or "Untitled"


def pdf_file_name(book, sha256):
    """A saved PDF's file name: "<book> [<the first 12 hex digits of sha256>].pdf" (PDF_FILE_RE)."""
    return "%s [%s].pdf" % (book, sha256[:12])


def pdf_folder(folder):
    """<folder>/PDFs, or ApiError 500 when that name holds a symlink or anything else than a folder: PDFs are never
    listed, read, written or deleted through a link. It may be missing (no PDF saved yet)."""
    path = os.path.join(folder, PDF_FOLDER)
    if os.path.islink(path) or (os.path.lexists(path) and not os.path.isdir(path)):
        raise ApiError(500, "%s in the backup folder %s is not a folder (a link or a file), so Marginalia leaves it "
                            "alone" % (PDF_FOLDER, display_path(folder)))
    return path


def pdf_files(pdfs):
    """[(name, sha12, bytes)] of the PDFs saved in the folder `pdfs`, by name: regular files (not symlinks, not
    folders) whose whole name matches PDF_FILE_RE; nothing else is ever listed. A missing folder has none; OSError when
    it cannot be read."""
    out = []
    try:
        with os.scandir(pdfs) as entries:
            for e in entries:
                m = PDF_FILE_RE.fullmatch(e.name)
                if not m or not e.is_file(follow_symlinks=False):
                    continue
                try:
                    out.append((e.name, m.group(1), e.stat(follow_symlinks=False).st_size))
                except OSError:
                    continue                            # gone since the listing
    except FileNotFoundError:
        return []
    out.sort()
    return out


def pdf_listing(folder):
    """GET /api/backup/pdfs's answer ("dir" is the backup folder, as GET /api/backup shows it; the PDFs are in its
    PDFs folder)."""
    return {"ok": True, "dir": display_path(folder),
            "files": [{"sha12": s, "name": n, "bytes": b} for n, s, b in pdf_files(pdf_folder(folder))]}


def pdf_digest(pdfs, name):
    """(the SHA-256 of its content in hex, its size) of the saved PDF `name` in `pdfs`, read whole in PDF_CHUNK pieces
    (open_pdf: never through a symlink, a regular file only), or None when it cannot be opened or read."""
    f = open_pdf(pdfs, name)
    if f is None:
        return None
    with f:
        try:
            return file_digest(f)
        except OSError:
            return None


def aside_name(name, n):
    """The n-th name (1, 2, …) set_aside_pdf tries for the saved PDF `name`: "<book name> [<sha12>] (changed).pdf",
    then "(changed 2)" and so on, the book name cut until the whole name fits in FILE_NAME_BYTES (only a name the user
    made longer by hand can need that). It ends in ").pdf", so it never matches PDF_FILE_RE and never starts with a
    dot."""
    sha12 = PDF_FILE_RE.fullmatch(name).group(1)
    tail = " [%s] (%s).pdf" % (sha12, PDF_ASIDE if n == 1 else "%s %d" % (PDF_ASIDE, n))
    book = name[:-len(" [%s].pdf" % sha12)]
    while book and len(os.fsencode(book + tail)) > FILE_NAME_BYTES:
        book = book[:-1]
    return book + tail


def set_aside_pdf(pdfs, name):
    """Rename the saved PDF `name` in `pdfs`, whose content no longer has the sha12 its name says (it was changed
    after it was saved), to the first free aside_name(): its content stays as it is, under a name that is never
    listed, sent or deleted. Nothing is ever replaced: a hard link, then the old name removed (os.rename while the new
    name is free on a disk without hard links). -> the new name; OSError when it cannot be renamed (no free name among
    PDF_ASIDE_TRIES: EEXIST)."""
    src = os.path.join(pdfs, name)
    if not stat.S_ISREG(os.lstat(src).st_mode):          # checked again right before: never a link or a folder
        raise OSError(errno.EINVAL, "not a regular file")
    for n in range(1, PDF_ASIDE_TRIES + 1):
        new = aside_name(name, n)
        dst = os.path.join(pdfs, new)
        try:
            os.link(src, dst)
        except FileExistsError:
            continue
        except OSError:                                 # no hard links here (FAT, exFAT, some network disks)
            if os.path.lexists(dst):
                continue
            os.rename(src, dst)
            return new
        try:
            os.unlink(src)
        except OSError:
            try:
                os.unlink(dst)                          # back as it was: one name, the old one
            except OSError:
                pass
            raise
        return new
    raise OSError(errno.EEXIST, "every name from %s to %s is taken" % (aside_name(name, 1),
                                                                         aside_name(name, PDF_ASIDE_TRIES)))


def changed_note(name, new):
    """The server log's line for a saved PDF set aside (set_aside_pdf)."""
    return ("PDFs: %s was changed after it was saved (its content is not that PDF any more), so it was renamed %s "
            "and is left alone from now on" % (name, new))


def verified_pdf(pdfs, sha256, aside, log):
    """POST /api/backup/pdf, under BACKUP_LOCK: hash every saved PDF whose name carries the sha12 of `sha256` (by
    name) -> (name, bytes) of the first whose content has exactly that SHA-256, or None. One whose content no longer
    has its own name's sha12 (changed after it was saved: Preview saving highlights into it, say) is set aside
    (set_aside_pdf; {"name", "as"} appended to `aside`, and a log line), so it is never taken for that PDF again; one
    that cannot be read, or another PDF whose SHA-256 merely starts the same, is left as it is. ApiError 500 when one
    cannot be set aside (nothing is written then)."""
    found = None
    for name, sha12, _ in pdf_files(pdfs):
        if sha12 != sha256[:12]:
            continue
        got = pdf_digest(pdfs, name)
        if got is None:
            continue
        digest, size = got
        if digest == sha256:
            found = found or (name, size)
        elif digest[:12] != sha12:
            try:
                new = set_aside_pdf(pdfs, name)
            except OSError as e:
                raise ApiError(500, "%s in the backup folder's %s folder was changed after it was saved (it is not "
                                    "that PDF any more), and it could not be renamed (%s); nothing was written"
                               % (name, PDF_FOLDER, e.strerror or "I/O error"))
            aside.append({"name": name, "as": new})
            log(changed_note(name, new))
    return found


def pdf_temp(pdfs):
    """A new temp file in `pdfs` for an upload -> (fd, path), noted in PDF_TEMPS until drop_pdf_temp()."""
    with PDF_TEMPS_LOCK:
        fd, tmp = tempfile.mkstemp(prefix=".marginalia-", suffix=".tmp", dir=pdfs)
        PDF_TEMPS.add(tmp)
    return fd, tmp


def drop_pdf_temp(tmp):
    """Remove an upload's temp file: after a hard link its second name, after a failure the partial file."""
    with PDF_TEMPS_LOCK:
        PDF_TEMPS.discard(tmp)
        try:
            os.unlink(tmp)
        except OSError:
            pass


def drop_all_pdf_temps(timeout=1.0):
    """For stop_after_writes: remove the temp files of the uploads under way, which the stop ends (PDF_TEMPS_LOCK is
    only ever held for a moment; `timeout` bounds the wait for it all the same)."""
    if not PDF_TEMPS_LOCK.acquire(timeout=timeout):
        return
    try:
        for tmp in list(PDF_TEMPS):
            PDF_TEMPS.discard(tmp)
            try:
                os.unlink(tmp)
            except OSError:
                pass
    finally:
        PDF_TEMPS_LOCK.release()


def place_pdf(tmp, final):
    """Give the temp file `tmp` the name `final` without ever replacing anything: a hard link (on a disk without hard
    links, os.replace while nothing has that name). -> False when something has that name (a file, a folder or a link,
    also one whose name differs only in letter case on a disk that ignores case)."""
    try:
        os.link(tmp, final)
    except FileExistsError:
        return False
    except OSError:                                     # no hard links here (FAT, exFAT, some network disks)
        if os.path.lexists(final):
            return False
        os.replace(tmp, final)
    return True


def save_pdf(folder, app_dir, rfile, length, sha256, book, log=None):
    """POST /api/backup/pdf: read `length` bytes of body from `rfile` in PDF_CHUNK pieces into a temp file in
    <folder>/PDFs while hashing them, check them, and save them as pdf_file_name(book, sha256) unless a saved PDF holds
    that very content already (verified_pdf, which also sets aside a saved PDF with that sha12 whose content was
    changed after it was saved) -> response dict (the module docstring has the contract). `sha256`: 64 lower-case hex
    digits; `log(message)` gets the set-asides. The temp file never stays behind."""
    log = log or (lambda message: None)
    if is_or_inside(os.path.realpath(folder), os.path.realpath(app_dir)):
        raise ApiError(500, "the backup folder is inside the app folder, which the server shows to the browser")
    if os.path.lexists(folder) and not os.path.isdir(folder):
        raise ApiError(500, "the backup folder %s is not a folder" % display_path(folder))
    os.makedirs(folder, mode=0o700, exist_ok=True)
    pdfs = pdf_folder(folder)
    try:
        os.mkdir(pdfs, 0o700)
        os.chmod(pdfs, 0o700)                           # whatever the umask took off
    except FileExistsError:
        pdfs = pdf_folder(folder)                       # there already, or made meanwhile: still a folder?
    fd, tmp = pdf_temp(pdfs)
    try:
        digest, head, size = hashlib.sha256(), b"", 0
        with os.fdopen(fd, "wb") as f:
            while size < length:
                chunk = rfile.read(min(PDF_CHUNK, length - size))
                if not chunk:
                    raise ApiError(400, "incomplete body")
                digest.update(chunk)
                if len(head) < PDF_SNIFF:
                    head += chunk[:PDF_SNIFF - len(head)]
                f.write(chunk)
                size += len(chunk)
            f.flush()
            os.fsync(f.fileno())
        if b"%PDF-" not in head:
            raise ApiError(400, "the body is not a PDF (no %PDF- within its first 1 KB)")
        if digest.hexdigest() != sha256:
            raise ApiError(400, "the body's SHA-256 is not the one X-Marginalia-Sha256 names")
        os.chmod(tmp, 0o600)
        aside = []
        with BACKUP_LOCK:                               # one save (or prune) at a time: the checks and the link
            pdf_folder(folder)
            name = pdf_file_name(book, sha256)
            for _ in range(2):                          # once more when something took the name meanwhile
                found = verified_pdf(pdfs, sha256, aside, log)
                if found is not None:
                    return pdf_saved_answer(found[0], found[1], True, aside)
                if place_pdf(tmp, os.path.join(pdfs, name)):
                    return pdf_saved_answer(name, size, False, aside)
            raise ApiError(409, "%s in the backup folder's %s folder is not a saved PDF (a folder, a link, or a file "
                                "whose name differs only in letter case), so it is left as it is; nothing was written"
                           % (name, PDF_FOLDER))
    finally:
        drop_pdf_temp(tmp)


def pdf_saved_answer(name, size, skipped, aside):
    """POST /api/backup/pdf's answer: the saved PDF that holds the content now, and the saved PDFs set aside on the
    way ("setAside", only when there are some)."""
    out = {"ok": True, "file": name, "bytes": size, "skipped": skipped}
    if aside:
        out["setAside"] = aside
    return out


def open_regular(folder, name):
    """The file `name` in `folder`, opened for reading, or None when it cannot be: never through a symlink
    (O_NOFOLLOW) and never anything but a regular file (checked on the open file, so a FIFO put there never blocks)."""
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    try:
        fd = os.open(os.path.join(folder, name), flags)
    except OSError:
        return None
    try:
        if stat.S_ISREG(os.fstat(fd).st_mode):
            return os.fdopen(fd, "rb")
    except OSError:
        pass
    os.close(fd)
    return None


def open_pdf(pdfs, name):
    """The saved PDF `name` in `pdfs`, opened for reading (open_regular: never through a symlink, a regular file only),
    or None when it cannot be."""
    return open_regular(pdfs, name)


def file_digest(f):
    """Read the open file `f` to its end in PDF_CHUNK pieces -> (the SHA-256 of what was read in hex, its size)."""
    digest, size = hashlib.sha256(), 0
    while True:
        chunk = f.read(PDF_CHUNK)
        if not chunk:
            break
        digest.update(chunk)
        size += len(chunk)
    return digest.hexdigest(), size


def hashed_size(f, sha256):
    """Read the open file `f` to its end: its size when its content's SHA-256 is `sha256`, else None."""
    hexdigest, size = file_digest(f)
    return size if hexdigest == sha256 else None


class PruneSkipped(Exception):
    """prune_pdfs deletes nothing, for the reason given (a kept backup that cannot be read or parsed, say)."""


def is_tombstone(stamp):
    """True when a collection's "deletedAt" marks it deleted, exactly as js/exporter.js stampOf reads it: a number
    (never a bool), finite and above 0. Anything else (null, missing, 0, text, a number too large for a float) is a
    live collection, so its PDF stays: when in doubt, a PDF is kept. Never raises."""
    if isinstance(stamp, bool) or not isinstance(stamp, (int, float)):
        return False
    try:
        value = float(stamp)
    except (OverflowError, ValueError):
        return False
    return 0.0 < value < float("inf")                   # NaN compares false: not a tombstone


def collection_sha12s(collections, cutoff):
    """{sha12} of the saved PDFs that a backup's "collections" keep: each collection's "sha256" of 64 hex digits, cut
    to 12 and in lower case (books), for a live collection and for a recent tombstone, a deleted book (is_tombstone)
    whose deletedAt is at or after `cutoff` (ms since 1970: tombstone_cutoff(), DELETED_PDF_DAYS before now). An older
    tombstone lists nothing. So a deleted book's PDF stays 30 days after the deletion, and longer while an older kept
    backup still lists the book alive (the user's choice of 2026-11-11, DECISIONS D23; before, every tombstone
    counted, so such a PDF stayed for good). ValueError when it is not what the exporter writes (a list of objects)."""
    if not isinstance(collections, list):
        raise ValueError("collections is not a list")
    out = set()
    for c in collections:
        if not isinstance(c, dict):
            raise ValueError("a collection is not an object")
        stamp = c.get("deletedAt")
        if is_tombstone(stamp) and float(stamp) < cutoff:
            continue                                    # deleted more than DELETED_PDF_DAYS ago
        sha = c.get("sha256")
        if isinstance(sha, str) and SHA256_RE.fullmatch(sha):
            out.add(sha[:12].lower())
    return out


def backup_sha12s(folder, name, cutoff):
    """collection_sha12s(…, cutoff) of the backup `name` in `folder`, read from the disk (never through a symlink), or
    PruneSkipped when it cannot be read or parsed as a Marginalia backup (looks_like_backup; NaN and Infinity, which
    no exporter writes, are not JSON)."""
    try:
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
        with os.fdopen(os.open(os.path.join(folder, name), flags), "rb") as f:
            if not stat.S_ISREG(os.fstat(f.fileno()).st_mode):
                raise PruneSkipped("%s is not a file" % name)
            data = f.read()
        backup = json.loads(data.decode("utf-8"), parse_constant=_no_constant)
        del data
        if not looks_like_backup(backup):
            raise PruneSkipped("%s is not a Marginalia backup" % name)
        return collection_sha12s(backup["collections"], cutoff)
    except OSError as e:
        raise PruneSkipped("%s cannot be read (%s)" % (name, e.strerror or "I/O error"))
    except (ValueError, RecursionError, MemoryError):
        raise PruneSkipped("%s cannot be parsed" % name)


def prune_pdfs(folder, written, listed, log=None):
    """FEATURES B9.3, right after the backup `written` was written and prune_backups() ran (under BACKUP_LOCK, so no
    PDF is put in place meanwhile): delete each saved PDF (pdf_files(): regular files whose names match PDF_FILE_RE,
    checked again with lstat right before) whose sha12 no kept backup lists: every backup prune_backups() left
    (backup_files(), so more than BACKUP_KEEP only when one could not be deleted), `written` among them, whose
    collections list `listed` (None: they could not be read). Each such PDF is hashed first, and only one whose content
    still has its name's sha12 is deleted: one changed after it was saved is the user's work, so it is set aside
    instead (set_aside_pdf, repair B9-R2), and one that cannot be read stays. Nothing at all is deleted when any kept
    backup cannot be read or parsed, when `written` is not among them, or when PDFs is not a folder; `log(message)`
    says why, and names the PDFs deleted and set aside. It never raises: the backup is written already. -> the names
    deleted."""
    log = log or (lambda message: None)
    try:
        if not os.path.lexists(os.path.join(folder, PDF_FOLDER)):
            return []
        pdfs = pdf_folder(folder)
        files = pdf_files(pdfs)
        if not files:
            return []
        if listed is None:
            raise PruneSkipped("%s lists its collections in a form Marginalia does not read" % written)
        names = [n for n, _ in backup_files(folder)]
        if written not in names:
            raise PruneSkipped("the backup just written, %s, is not among the backups" % written)
        keep = set(listed)
        cutoff = tombstone_cutoff()
        for name in names:
            if name != written:
                keep |= backup_sha12s(folder, name, cutoff)
        deleted = []
        for name, sha12, _ in files:
            if sha12 in keep:
                continue
            path = os.path.join(pdfs, name)
            got = pdf_digest(pdfs, name)                # only a PDF that still holds what was saved goes (B9-R2)
            if got is None:
                if os.path.lexists(path):
                    log("PDFs: %s cannot be read, so it was not deleted" % name)
                continue
            if got[0][:12] != sha12:                    # changed after it was saved: the user's own work now
                try:
                    log(changed_note(name, set_aside_pdf(pdfs, name)))
                except OSError as e:
                    log("PDFs: %s was changed after it was saved (its content is not that PDF any more), so it was "
                        "not deleted; it could not be renamed (%s)" % (name, e.strerror or "I/O error"))
                continue
            try:
                if not stat.S_ISREG(os.lstat(path).st_mode):
                    continue                            # no longer a regular file: never a link
                os.unlink(path)
            except OSError:
                continue
            deleted.append(name)
        if deleted:
            log("PDFs: deleted %d that no kept backup lists: %s" % (len(deleted), ", ".join(deleted)))
        return deleted
    except PruneSkipped as e:
        log("PDFs: nothing deleted, because %s" % e)
    except ApiError as e:
        log("PDFs: nothing deleted, because %s" % e.message)
    except Exception:
        log("PDFs: nothing deleted, because of an unexpected error\n%s" % traceback.format_exc())
    return []


# --- HTTP ------------------------------------------------------------------------------------------------------------

def client_is_loopback(address):
    """True when the request came from this machine (127.0.0.0/8, ::1, or ::ffff:127.x.y.z)."""
    host = address[0] if isinstance(address, (tuple, list)) and address else address
    if not isinstance(host, str) or not host:
        return False
    try:
        ip = ipaddress.ip_address(host.split("%", 1)[0])
    except ValueError:
        return False
    mapped = getattr(ip, "ipv4_mapped", None)
    return (mapped or ip).is_loopback


def config_from_environment():
    """The obsidian.json a request reads when no option names one: MARGINALIA_OBSIDIAN_CONFIG, else Obsidian's own
    list. The variable set but blank gives None (no vault at all): never Obsidian's own list, so a test script whose
    variable came out empty cannot write into the real vault."""
    env = os.environ.get(CONFIG_ENV)
    if env is not None:
        return env if env.strip() else None
    return default_config_path()


class Handler(http.server.SimpleHTTPRequestHandler):
    obsidian_config = None      # None: config_from_environment(); "" (blank): no vault
    backup_dir = None           # the backup folder (check_backup_dir), or None: no backups, /api/backup* is 404
    app_version = None          # --app: the desktop app's version (GET /api/app, the X-Marginalia-Client guard), or None
    api_response = False
    responded = False

    def config_path(self):
        return self.obsidian_config if self.obsidian_config is not None else config_from_environment()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store" if self.api_response else "no-cache")
        super().end_headers()

    def url_path(self):
        try:
            path = urllib.parse.urlsplit(self.path).path
        except ValueError:                                  # e.g. "//[x": not a path the API knows
            path = self.path.split("?", 1)[0].split("#", 1)[0]
        return urllib.parse.unquote(path)

    def port(self):
        return self.server.server_address[1]

    def send_json(self, status, obj):
        body = json.dumps(obj).encode("utf-8")
        self.api_response = True
        self.responded = True
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_error_json(self, status, message, extra=None):
        self.close_connection = True
        payload = {"ok": False, "error": message}
        for k, v in (extra or {}).items():
            payload.setdefault(k, v)
        self.send_json(status, payload)

    def host_ok(self):
        host = (self.headers.get("Host") or "").strip().lower()
        return host in ("127.0.0.1:%d" % self.port(), "localhost:%d" % self.port())

    def origin_ok(self):
        origin = (self.headers.get("Origin") or "").strip()
        return origin in ("http://127.0.0.1:%d" % self.port(), "http://localhost:%d" % self.port())

    def other_site(self):
        """True when the browser says another site made this request (Sec-Fetch-Site other than same-origin, or none
        for an address typed in). No such header (an older browser, a script) is not another site."""
        site = (self.headers.get("Sec-Fetch-Site") or "").strip().lower()
        return site not in ("", "same-origin", "none")

    def client_may_write(self, path):
        """With --app: True when the POST to `path` says it comes from a page that may write there (CLIENT_HEADER):
        the app's own page on every route, a covered browser page moving its library only on the backup routes.
        Without --app every client may (the header is ignored)."""
        if self.app_version is None:
            return True
        client = (self.headers.get(CLIENT_HEADER) or "").strip()
        return client == APP_CLIENT or (client == MOVE_CLIENT and path in (BACKUP_PATH, PDF_PATH))

    def log_note(self, message):
        """One line in the server log (none from a quiet server)."""
        self.log_error("%s", message)

    def api(self, answer, path):
        """Run answer(path) for an /api/ request: loopback clients with the right Host only, and a JSON answer even
        when something unexpected fails (the traceback goes to the log, never to the client)."""
        self.responded = False
        try:
            if not client_is_loopback(self.client_address):
                return self.send_error_json(403, "forbidden client")
            if not self.host_ok():
                return self.send_error_json(403, "forbidden host")
            return answer(path)
        except Exception:
            self.log_error("unexpected error in %s %s\n%s", self.command, path, traceback.format_exc())
            if not self.responded:
                self.send_error_json(500, "unexpected error")
            else:
                self.close_connection = True

    def do_GET(self):
        self.api_response = False
        path = self.url_path()
        if not path.startswith(API_PREFIX):
            return super().do_GET()
        return self.api(self.answer_get, path)

    def answer_get(self, path):
        if path == VAULTS_PATH:
            # replaceOnly: /notes honours a block's "replaceOnly" (a serve.py from before it would add such a block)
            return self.send_json(200, {"vaults": public_vaults(self.config_path()), "replaceOnly": True})
        if path == APP_PATH and self.app_version is not None:
            return self.send_json(200, {"ok": True, "app": True, "version": self.app_version})
        if path == LATEST_PATH:
            return self.answer_latest_backup()
        if path == BACKUP_PATH and self.backup_dir is not None:
            try:
                listing = backup_listing(self.backup_dir)
            except OSError as e:
                return self.send_error_json(500, "could not read the backup folder %s: %s"
                                            % (display_path(self.backup_dir), e.strerror or "I/O error"))
            return self.send_json(200, listing)
        if path == PDFS_PATH and self.backup_dir is not None:
            try:
                listing = pdf_listing(self.backup_dir)
            except ApiError as e:
                return self.send_error_json(e.status, e.message, e.extra)
            except OSError as e:
                return self.send_error_json(500, "could not read the backup folder %s: %s"
                                            % (display_path(self.backup_dir), e.strerror or "I/O error"))
            return self.send_json(200, listing)
        sha = path[len(PDF_PATH) + 1:] if path.startswith(PDF_PATH + "/") else ""
        if SHA256_RE.fullmatch(sha) and self.backup_dir is not None:
            return self.answer_pdf_bytes(sha.lower())
        return self.send_error_json(404, "not found")

    def answer_pdf_bytes(self, sha256):
        """GET /api/backup/pdf/<sha256>: the saved PDF whose content has that SHA-256, hashed before it is sent and
        again while it streams; 404 when none has it (a file whose content does not match is logged, never sent, and
        named in the 404's "changed": it was changed after it was saved; a GET never renames anything)."""
        if self.other_site():
            return self.send_error_json(403, "forbidden site")
        try:
            pdfs = pdf_folder(self.backup_dir)
            names = [n for n, s, _ in pdf_files(pdfs) if s == sha256[:12]]
        except ApiError as e:
            return self.send_error_json(e.status, e.message, e.extra)
        except OSError as e:
            return self.send_error_json(500, "could not read the backup folder %s: %s"
                                        % (display_path(self.backup_dir), e.strerror or "I/O error"))
        changed = []
        for name in names:
            f = open_pdf(pdfs, name)
            if f is None:
                self.log_note("PDFs: %s cannot be opened as a file, so it was not sent" % name)
                continue
            with f:
                try:
                    size = hashed_size(f, sha256)
                except OSError as e:
                    self.log_note("PDFs: %s cannot be read (%s), so it was not sent"
                                  % (name, e.strerror or "I/O error"))
                    continue
                if size is None:
                    self.log_note("PDFs: the content of %s does not have the SHA-256 %s, so it was not sent"
                                  % (name, sha256))
                    changed.append(name)
                    continue
                return self.send_pdf(f, size, sha256, name)
        # "changed": the saved PDFs with that sha12 whose content is not that PDF any more (B9-R2: the page names them)
        return self.send_error_json(404, "no saved PDF has that SHA-256", {"changed": changed} if changed else None)

    def send_pdf(self, f, size, sha256, name):
        """Stream the first `size` bytes of the open file `f`, whose SHA-256 was just found to be `sha256`, hashing
        them again as they go: the last piece is held back until they prove the same, so a file that changed meanwhile
        never reaches the client whole (its last piece is not sent and the connection is closed)."""
        self.api_response = True
        self.responded = True
        self.send_response(200)
        self.send_header("Content-Type", "application/pdf")
        self.send_header("Content-Length", str(size))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        f.seek(0)
        digest, left, held = hashlib.sha256(), size, b""
        try:
            while left > 0:
                chunk = f.read(min(PDF_CHUNK, left))
                if not chunk:
                    break
                digest.update(chunk)
                left -= len(chunk)
                if held:
                    self.wfile.write(held)
                held = chunk
            if left or digest.hexdigest() != sha256:
                self.close_connection = True
                self.log_note("PDFs: %s changed while it was being sent, so its last part was held back" % name)
                return
            if held:
                self.wfile.write(held)
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True                # the page went away

    def answer_latest_backup(self):
        """GET /api/backup/latest: the newest kept backup (backup_files()[0], the "last" of GET /api/backup's listing)
        as it is on disk, or 404 "no_backup" when there is none (no backup folder on this server, a missing or an
        empty one). Another site's request is refused before the folder is read, as GET /api/backup/pdf/<sha256>."""
        if self.other_site():
            return self.send_error_json(403, "forbidden site")
        if self.backup_dir is None:
            return self.send_error_json(404, NO_BACKUP)
        try:
            files = backup_files(self.backup_dir)
        except OSError as e:
            return self.send_error_json(500, "could not read the backup folder %s: %s"
                                        % (display_path(self.backup_dir), e.strerror or "I/O error"))
        if not files:
            return self.send_error_json(404, NO_BACKUP)
        name = files[0][0]
        f = open_regular(self.backup_dir, name)
        if f is None:                                   # gone, or a symlink or something else put there meanwhile
            return self.send_error_json(500, "%s in the backup folder %s cannot be opened as a file"
                                        % (name, display_path(self.backup_dir)))
        with f:
            try:
                size = os.fstat(f.fileno()).st_size
            except OSError as e:
                return self.send_error_json(500, "could not read %s: %s" % (name, e.strerror or "I/O error"))
            return self.send_backup_file(f, size, name)

    def send_backup_file(self, f, size, name):
        """Stream the first `size` bytes of the open backup file `f` (named `name`) in PDF_CHUNK pieces, never read
        whole; a file that got shorter meanwhile is cut off and the connection closed (the page sees a cut body)."""
        self.api_response = True
        self.responded = True
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(size))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Marginalia-Backup-Name", name)
        self.end_headers()
        left = size
        try:
            while left > 0:
                chunk = f.read(min(PDF_CHUNK, left))
                if not chunk:
                    break
                self.wfile.write(chunk)
                left -= len(chunk)
            if left:
                self.close_connection = True
                self.log_note("Backups: %s got shorter while it was being sent, so it was cut off" % name)
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True                # the page went away

    def do_HEAD(self):
        self.api_response = False
        if self.url_path().startswith(API_PREFIX):
            return self.send_error_json(404, "not found")
        return super().do_HEAD()

    def do_POST(self):
        self.api_response = False
        path = self.url_path()
        if not path.startswith(API_PREFIX):
            return self.send_error(501, "Unsupported method ('POST')")
        return self.api(self.answer_post, path)

    def answer_post(self, path):
        wanted = "application/json"
        if path == NOTE_PATH:
            limit, too_large = MAX_BODY, "the note is larger than 25 MB"
        elif path == NOTES_PATH:
            limit, too_large = MAX_NOTES_BODY, "the notes are larger than 100 MB"
        elif path == BACKUP_PATH and self.backup_dir is not None:
            limit, too_large = MAX_BACKUP_BODY, "the backup is larger than 512 MB"
        elif path == PDF_PATH and self.backup_dir is not None:
            limit, too_large, wanted = MAX_PDF_BODY, "the PDF is larger than 300 MB", "application/pdf"
        else:
            return self.send_error_json(404, "not found")
        if not self.origin_ok():
            return self.send_error_json(403, "forbidden origin")
        if (self.headers.get("X-Marginalia") or "").strip() != "1":
            return self.send_error_json(403, "missing X-Marginalia header")
        ctype = (self.headers.get("Content-Type") or "").split(";", 1)[0].strip().lower()
        if ctype != wanted:
            return self.send_error_json(415, "Content-Type must be " + wanted)
        length = self.headers.get("Content-Length")
        if length is None:
            return self.send_error_json(411, "Content-Length is required")
        try:
            n = int(length)
        except ValueError:
            return self.send_error_json(400, "bad Content-Length")
        if n < 0:
            return self.send_error_json(400, "bad Content-Length")
        if n > limit:
            return self.send_error_json(413, too_large)
        if not self.client_may_write(path):             # --app: only the app's page (and the move) writes
            return self.send_error_json(409, APP_ONLY, {"message": APP_ONLY_MESSAGE})
        if path == PDF_PATH:
            return self.answer_pdf_upload(n)            # streamed: never read whole
        body = self.rfile.read(n) if n else b""
        if len(body) != n:
            return self.send_error_json(400, "incomplete body")
        if path == BACKUP_PATH:
            try:
                text = body.decode("utf-8")
            except UnicodeDecodeError:
                return self.send_error_json(400, "the body is not a JSON object")
            del body                                    # up to 512 MB: one copy is enough
            return self.answer_backup(text)
        try:
            req = json.loads(body.decode("utf-8"))
        except (ValueError, UnicodeDecodeError, RecursionError):
            return self.send_error_json(400, "the body is not JSON")
        try:
            res = (write_note if path == NOTE_PATH else write_notes)(self.config_path(), req)
        except ApiError as e:
            return self.send_error_json(e.status, e.message, e.extra)
        except OSError as e:
            return self.send_error_json(500, "could not write the note: " + (e.strerror or "I/O error"))
        return self.send_json(200, res)

    def answer_backup(self, text):
        try:
            res = write_backup(self.backup_dir, self.directory, text, log=self.log_note)
        except ApiError as e:
            return self.send_error_json(e.status, e.message, e.extra)
        except OSError as e:
            return self.send_error_json(500, "could not write the backup: " + (e.strerror or "I/O error"))
        return self.send_json(200, res)

    def answer_pdf_upload(self, length):
        """POST /api/backup/pdf once the guards of answer_post passed: the SHA-256 header, then save_pdf()."""
        sha = (self.headers.get("X-Marginalia-Sha256") or "").strip()
        if not SHA256_RE.fullmatch(sha):
            return self.send_error_json(400, "X-Marginalia-Sha256 must be the PDF's SHA-256 in 64 hex digits")
        book = pdf_book_name(self.headers.get("X-Marginalia-Name"))
        try:
            res = save_pdf(self.backup_dir, self.directory, self.rfile, length, sha.lower(), book, log=self.log_note)
        except ApiError as e:
            return self.send_error_json(e.status, e.message, e.extra)
        except OSError as e:
            return self.send_error_json(500, "could not save the PDF: " + (e.strerror or "I/O error"))
        return self.send_json(200, res)


def end_process(signum):
    """End this process the way `signum` does by default (a separate step so tests can replace it)."""
    signal.signal(signum, signal.SIG_DFL)
    os.kill(os.getpid(), signum)


def stop_after_writes(signum, frame):
    """The SIGTERM handler (`marginalia stop` and `restart` send SIGTERM): wait, at most STOP_WAIT seconds in all, until
    a note, image or backup write in progress has finished, its temp file renamed into place or removed, then remove
    the temp files of the PDF uploads under way (drop_all_pdf_temps: the stop cuts them off, and the page sends them
    again later) and end as SIGTERM would. Without it, a stop in the middle of a send left a partial hidden
    .marginalia-*.tmp file in the vault (a kill -9 or a power cut still can, there or in the backup folder and its
    PDFs folder; nothing sweeps them)."""
    deadline = time.monotonic() + STOP_WAIT
    NOTE_LOCK.acquire(timeout=STOP_WAIT)
    BACKUP_LOCK.acquire(timeout=max(0.0, deadline - time.monotonic()))
    drop_all_pdf_temps(max(0.1, deadline - time.monotonic()))     # an upload under way is cut off: its temp goes
    end_process(signum)


def check_app_version(value):
    """`value` when it is a desktop app version, digits.digits.digits in ASCII (APP_VERSION_RE), else ValueError."""
    if not isinstance(value, str) or not APP_VERSION_RE.fullmatch(value):
        raise ValueError("%r is not an app version (digits.digits.digits, such as 1.0.0)" % (value,))
    return value


def app_version_option(value):
    """argparse's type for --app: a bad VERSION stops the server at start with exit 2, as any refused option does."""
    try:
        return check_app_version(value)
    except ValueError as e:
        raise argparse.ArgumentTypeError(str(e))


def make_server(directory, bind="127.0.0.1", port=8765, obsidian_config=None, quiet=False, backup_dir=None,
                app_version=None):
    """A ThreadingHTTPServer for the app folder (port 0 picks a free one; obsidian_config overrides the environment;
    quiet drops the request log). backup_dir is the folder /api/backup keeps the backups in, and /api/backup/pdf the
    PDFs, in its PDFs folder (check_backup_dir: ValueError when it is blank, relative or inside `directory`); None, the
    default, means no backups at all (every /api/backup route answers 404), so a server made here never reaches
    ~/Documents/Marginalia Backups unless it is told to (main() resolves the default). app_version (--app, only the
    desktop app passes it; check_app_version: ValueError unless digits.digits.digits) makes it the app's server: GET
    /api/app answers, and every POST needs X-Marginalia-Client (client_may_write); None, the default, changes nothing."""
    root = os.path.abspath(directory)
    attrs = {"obsidian_config": obsidian_config,
             "backup_dir": None if backup_dir is None else check_backup_dir(backup_dir, root),
             "app_version": None if app_version is None else check_app_version(app_version)}
    if quiet:
        attrs["log_message"] = lambda self, *args: None
    handler_cls = type("MarginaliaHandler", (Handler,), attrs)
    handler = functools.partial(handler_cls, directory=root)
    return http.server.ThreadingHTTPServer((bind, port), handler)


def parse_args(argv=None):
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    ap = argparse.ArgumentParser(description="Serve Marginalia locally.")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--bind", default="127.0.0.1")
    ap.add_argument("--dir", default=here)
    vault = ap.add_mutually_exclusive_group()
    vault.add_argument("--obsidian-config", metavar="OBSIDIAN_JSON",
                       help="read the vault list from this obsidian.json (wins over %s; it must list a vault "
                            "whose folder exists); unless it is Obsidian's own list, the page's backups go to %s "
                            "beside it unless --backup-dir or %s names a folder, as with %s"
                            % (CONFIG_ENV, SANDBOX_BACKUPS, BACKUP_ENV, CONFIG_ENV))
    vault.add_argument("--obsidian-sandbox", metavar="FOLDER",
                       help="for test servers: write only into a throwaway vault, FOLDER/%s, listed in "
                            "FOLDER/obsidian.json (both made when missing; an obsidian.json the sandbox did not write "
                            "is never replaced); the page's backups go to FOLDER/%s unless --backup-dir or %s names "
                            "a folder" % (SANDBOX_VAULT, SANDBOX_BACKUPS, BACKUP_ENV))
    ap.add_argument("--backup-dir", metavar="FOLDER",
                    help="keep the daily backups in FOLDER, an absolute path outside the app folder (wins over %s; "
                         "default: ~/Documents/Marginalia Backups, or SANDBOX/%s with --obsidian-sandbox SANDBOX, "
                         "or %s beside the obsidian.json that --obsidian-config or %s names when it is not "
                         "Obsidian's own list; made by the first backup)"
                         % (BACKUP_ENV, SANDBOX_BACKUPS, SANDBOX_BACKUPS, CONFIG_ENV))
    ap.add_argument("--app", metavar="VERSION", type=app_version_option,
                    help="only the Marginalia desktop app passes this, with its version (digits.digits.digits): GET "
                         "%s then says so, and every POST needs %s: %s (the backup routes also take %s)"
                         % (APP_PATH, CLIENT_HEADER, APP_CLIENT, MOVE_CLIENT))
    return ap.parse_args(argv)


def is_obsidians_own_list(path):
    """True when `path` names Obsidian's own vault list, default_config_path(): the same file (symlinks resolved), or,
    while either of them is missing, the same path in either letter case (macOS's disks ignore case)."""
    own = default_config_path()
    try:
        return os.path.samefile(path, own)
    except OSError:
        return os.path.realpath(path).lower() == os.path.realpath(own).lower()


def own_vault_list(args):
    """(obsidian.json, source) for startup_backup(): the vault list the server will read when --obsidian-config, else
    MARGINALIA_OBSIDIAN_CONFIG, names one other than Obsidian's own (is_obsidians_own_list), as startup_config() picks
    it (the option wins, and --obsidian-sandbox wins over the variable); else (None, None). Nothing is read or made
    here; a blank value is left to startup_config(), which refuses it."""
    if args.obsidian_config is not None:
        if not args.obsidian_config.strip():
            return None, None
        path, source = os.path.abspath(args.obsidian_config), "--obsidian-config"
    elif args.obsidian_sandbox is None and (os.environ.get(CONFIG_ENV) or "").strip():
        path, source = os.path.abspath(os.environ[CONFIG_ENV]), CONFIG_ENV
    else:
        return None, None
    return (None, None) if is_obsidians_own_list(path) else (path, source)


def startup_backup(args, app_dir):
    """(folder, line) for main(): the backup folder, --backup-dir, else MARGINALIA_BACKUP_DIR, else, for a test server
    started with --obsidian-sandbox <folder>, <folder>/Backups, else, for a server that reads a vault list of its own
    (own_vault_list: --obsidian-config or MARGINALIA_OBSIDIAN_CONFIG naming another file than Obsidian's own list), a
    Backups folder beside that obsidian.json, else ~/Documents/Marginalia Backups (nothing is created here), and the
    line the server prints about it. ValueError, so the server does not start, for a blank or relative value, for the
    app folder or a folder inside it (a sandbox or a vault list inside the app folder included), and for a folder
    inside Obsidian's own settings folder (a vault list kept there). A blank --obsidian-sandbox or --obsidian-config is
    left to startup_config(), which refuses it."""
    if args.backup_dir is not None:
        value, source = args.backup_dir, "--backup-dir"
        if not value.strip():
            raise ValueError("--backup-dir needs a folder")
    elif os.environ.get(BACKUP_ENV) is not None:
        value, source = os.environ[BACKUP_ENV], BACKUP_ENV
        if not value.strip():
            raise ValueError("%s is set but empty; unset it, or set it to the whole path of a folder" % BACKUP_ENV)
    elif args.obsidian_sandbox is not None and args.obsidian_sandbox.strip():
        # a test server keeps its page's backups beside its throwaway vault: in ~/Documents/Marginalia Backups a test
        # page that holds a library took the day's file name (so the user's own backup of the day was skipped), its
        # "Back up now" replaced the user's file of the day, and its backups counted toward the 30 kept
        value = os.path.join(os.path.realpath(os.path.abspath(args.obsidian_sandbox)), SANDBOX_BACKUPS)
        source = "--obsidian-sandbox's backup folder"
    else:
        config, option = own_vault_list(args)
        if config is None:                              # the user's own server: Obsidian's own list, or no option
            value, source = default_backup_dir(), "the default backup folder"
        else:
            # a server started with a vault list of its own is a test server too (the user's own reads Obsidian's
            # list): its page's backups go beside that list, for the reasons above
            value = os.path.join(os.path.realpath(os.path.dirname(config)), SANDBOX_BACKUPS)
            source = "%s's backup folder" % option
            settings = os.path.dirname(default_config_path())
            if is_or_inside(os.path.realpath(value), settings):     # a Backups symlink into it included
                raise ValueError("%s: %s is inside Obsidian's own settings folder %s, which Marginalia never writes "
                                 "into; give --backup-dir" % (source, value, settings))
    try:
        folder = check_backup_dir(value, app_dir)
    except ValueError as e:
        raise ValueError("%s: %s" % (source, e))
    return folder, "Backups: once a day into %s (the newest %d are kept)" % (folder, BACKUP_KEEP)


def obsidian_config_of(args):
    """The obsidian.json an option names: --obsidian-sandbox's own (make_sandbox), --obsidian-config's, or None when
    neither is given (then config_from_environment()). A blank option is an error (ValueError), never "not given": a
    script whose folder variable came out empty stops instead of falling back to Obsidian's own list."""
    if args.obsidian_sandbox is not None:
        if not args.obsidian_sandbox.strip():
            raise ValueError("--obsidian-sandbox needs a folder")
        try:
            return make_sandbox(args.obsidian_sandbox)
        except (OSError, ValueError) as e:
            raise ValueError("--obsidian-sandbox: %s" % e)
    if args.obsidian_config is not None:
        if not args.obsidian_config.strip():
            raise ValueError("--obsidian-config needs an obsidian.json file")
        return os.path.abspath(args.obsidian_config)
    return None


def config_problem(path):
    """Why the obsidian.json `path` gives no vault, in a few words."""
    if os.path.isdir(path):
        return "it is a folder"
    if not os.path.exists(path):
        return "there is no such file"
    try:
        with open(path, "rb") as f:
            f.read(1)
    except OSError as e:
        return "it cannot be read (%s)" % (e.strerror or "I/O error")
    data = read_json(path)
    if data is None:
        return "it is not JSON text"
    if not isinstance(data, dict) or not isinstance(data.get("vaults"), dict):
        return 'it has no "vaults" list'
    return "none of the vault folders it names exists"


def startup_config(args):
    """(config, line) for main(): the obsidian.json the server reads (None: config_from_environment() at every
    request, which is Obsidian's own list) and the line it prints about it, naming the vaults found. ValueError, so
    the server does not start, when an option or MARGINALIA_OBSIDIAN_CONFIG is given but blank, or when the file one
    of them names lists no vault whose folder exists (a typo would otherwise leave the page with no vault, and it would
    send through obsidian:// links, which reach the real Obsidian). Obsidian's own list may be empty: the page then
    sends through obsidian:// links, as documented."""
    env = os.environ.get(CONFIG_ENV)
    if env is not None and not env.strip():
        raise ValueError("%s is set but empty; unset it, or set it to a throwaway obsidian.json" % CONFIG_ENV)
    config = obsidian_config_of(args)
    source = "--obsidian-sandbox" if args.obsidian_sandbox is not None else "--obsidian-config"
    if config is None and env is not None:
        config, source = os.path.abspath(env), CONFIG_ENV
    path = config if config is not None else default_config_path()
    names = [v["name"] for v in load_vaults(path)]
    if not names and config is not None:
        raise ValueError("%s names %s, which lists no vault to write into: %s" % (source, path, config_problem(path)))
    if not names:
        return config, "Obsidian: no vault listed in %s, so the page sends through obsidian:// links" % path
    folders = {}
    for v in all_vaults(path):
        folders.setdefault(v["name"], set()).add(os.path.realpath(v["path"]))
    shared = sorted(n for n, f in folders.items() if len(f) > 1)
    line = "Obsidian: vaults from %s: %s" % (path, ", ".join(names))
    if shared:
        line += (" (two vaults share the name %s: sends to it are refused until one folder is renamed)"
                 % ", ".join(shared))
    return config, line


def main():
    args = parse_args()
    root = os.path.abspath(args.dir)
    if not os.path.isfile(os.path.join(root, "index.html")):
        sys.exit("No index.html in %s" % root)
    try:
        backup_dir, backups = startup_backup(args, root)    # first: it writes nothing (a sandbox would be made)
    except ValueError as e:
        sys.exit("Backups: %s" % e)
    try:
        config, about = startup_config(args)
    except ValueError as e:
        sys.exit("Obsidian: %s" % e)
    with make_server(root, args.bind, args.port, obsidian_config=config, backup_dir=backup_dir,
                     app_version=args.app) as httpd:
        print("Marginalia: http://%s:%d/ (serving %s)" % (args.bind, httpd.server_address[1], root), flush=True)
        print(about, flush=True)
        print(backups, flush=True)
        if args.app is not None:
            print("App: the server of the Marginalia app %s; only the app's page writes (%s)"
                  % (args.app, CLIENT_HEADER), flush=True)
        signal.signal(signal.SIGTERM, stop_after_writes)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
